// Navigation (ARCHITECTURE.md §8.3, §11): the back stack is owned by JS.
//
// - The stack is a list of entries { id, route, params }. An entry's id is its screen's root instance id.
// - JS changes the stack with nav.push / back / replace / reset and sends each change as a NAV op in the normal
//   batch (kinds in core/include/zn/batch.h). The screen is rendered in the same tick, so native gets the NAV op
//   and the screen's first values in one batch and draws them in one frame.
// - Screens opened before JS runs (cold start, deep link) are created by native, which then sends the start event
//   with their entries; JS renders them on the roots native made and sends no NAV for them.
// - A system back press is an event to JS. JS asks the top screen's useBack handlers (the latest first), else pops,
//   else (last screen) tells native to let the system handle it. JS always answers, so native's 300 ms fallback never
//   fires normally. On the last screen native asks JS only while the screen said it wants Back there (NAV BACK_WANTED,
//   host API 8): tabs do, while a tab other than the first is shown (tabs.ts).
// - useFocus: the top screen has focus. It changes when a screen opens, closes or is uncovered (syncTop).
//
// App-level events from native use instance 0 (no screen has id 0): START, BACK, FORCED_BACK, OPEN (a deep link
// while the app runs), INSETS (5, insets.ts), RETRY (7). Native side: android/runtime/.../ZnNav.kt.
//
// A screen that throws while it is being built stays on the stack (so Back works as usual) and native shows its
// built-in error screen instead (NAV FAILED, step 3.9, docs/guide-notes.md §26). "Try again" there: native makes a
// fresh root and sends RETRY; JS builds the screen again.
//
// restorableSignal: each value change goes to native as NAV RESTORE; native saves the values with the back stack and,
// when Android restores the app after killing it, hands them back in START's "values" (host API 4).
//
// A native screen (a route with `native`, docs/plugins.md §5) is an entry with nothing to render. Its answer is on disk
// before JS hears NAV_RESULT, in the launches store under the key "nav.<route>": `pushForResult`'s promise takes it, or
// after a kill, when that promise is gone, `onNavResult`.
import { APP, AppEvent } from "./app-events"
import { appStarting, installAppState } from "./app-state"
import { installAppearance } from "./appearance"
import { reportError, setTopScreen } from "./errors"
import { onEvent } from "./events"
import { installInsets } from "./insets"
import { installTasks } from "./tasks"
import type { NativeValue } from "./native"
import type { AnyRouteDef, NativeRouteDef, RouteDef, RouteName, RouteParams } from "./routes"
import { launches, type LaunchRecord } from "./launches"
import { effect, getOwner, onCleanup, signal, untrack, type Owner, type Signal } from "./signals"
import { allocInstanceId, renderRoot, type View } from "./view"

/** Apps register their routes for typed navigation (in routes.ts):
 *    declare module "@zero-native/core" { interface Register { routes: typeof routes } } */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Register {}
export type Routes = Register extends { routes: infer R } ? R : Record<string, AnyRouteDef>

const NavKind = {
  Push: 1, Remove: 2, Clear: 3, Exit: 4, BackAnswered: 5, Impressions: 6, Failed: 7, Started: 8, Restore: 9, BackWanted: 10,
} as const
export { AppEvent } from "./app-events"

/** @internal A screen on the stack. Exported for tabs.ts only. */
export interface Entry {
  id: number
  route: number
  name: string
  params: Record<string, unknown>
  dispose: () => void
  /** useBack handlers, oldest first; the newest is asked first. */
  backs: Array<() => boolean>
  /** The screen's tabs (useTabs): a link to one of them selects it. */
  tabs?: { select(name: string): boolean }
  impressions?: { handler: (keys: string[]) => void; session: boolean }
  /** The screen threw while being built; native shows its error screen. */
  failed?: boolean
  /** restorableSignal values native handed back (Android restored the app); each is used once. */
  restored?: Record<string, unknown>
  /** restorableSignal keys in use on this screen now. */
  restoreKeys?: Set<string>
}

/** A screen's root owner → its entry: restorableSignal finds its screen through the owner it is created under. */
const screenOwners = new WeakMap<Owner, Entry>()

/** Keys already reported in this app session (for `once: "session"`). */
const seenThisSession = new Set<string>()

let table: Record<string, AnyRouteDef> | null = null
let names: string[] = []
let onLink: AppOptions["onLink"] | null = null
const stack: Entry[] = []
/** Entry id → the `pushForResult` promise that waits for its native screen. */
const waiting = new Map<number, (value: unknown) => void>()
/** Route name → who hears a native screen's answer with no promise waiting (`onNavResult`). */
const resultListeners = new Map<string, Set<(record: LaunchRecord) => void>>()
/** The entry whose screen is being rendered right now (for useBack). */
let rendering: Entry | null = null
/** The id of the top screen's entry (0 before the start): useFocus watches it. Set by syncTop after a stack change. */
const topId = signal(0)

function syncTop(): void {
  topId.set(stack[stack.length - 1]?.id ?? 0)
}

type ParamsArg<K extends RouteName<Routes>> = {} extends RouteParams<Routes, K>
  ? [params?: RouteParams<Routes, K>]
  : [params: RouteParams<Routes, K>]

/** Only the routes with `native`, so `pushForResult<T>` can name its answer's type and still check the route. */
type NativeRouteName = string extends RouteName<Routes>
  ? string
  : { [K in RouteName<Routes>]: Routes[K] extends NativeRouteDef ? K : never }[RouteName<Routes>]

export const nav = {
  /** Opens a screen on top of the current one. */
  push<K extends RouteName<Routes>>(name: K, ...[params]: ParamsArg<K>): void {
    const e = open(name, (params ?? {}) as Record<string, unknown>)
    globalThis.__zn_nav(NavKind.Push, e.id, e.route, JSON.stringify(e.params))
    show(e)
    syncTop()
  },

  /**
   * Opens a native screen and waits for its answer; null if the user went back. If the app is killed while it is open, this
   * promise is gone: use `onNavResult` too when the answer matters after a kill.
   */
  pushForResult<T = unknown>(name: NativeRouteName, params?: Record<string, unknown>): Promise<T | null> {
    if (!isNative(table?.[name])) throw new Error(`nav.pushForResult: "${name}" is not a native screen`)
    const e = open(name, params ?? {})
    globalThis.__zn_nav(NavKind.Push, e.id, e.route, JSON.stringify(e.params))
    show(e)
    syncTop()
    return new Promise((resolve) => waiting.set(e.id, resolve as (value: unknown) => void))
  },

  /** Closes the top screen. Returns false (and does nothing) on the last screen. */
  back(): boolean {
    if (stack.length <= 1) return false
    close(stack.pop()!, true)
    syncTop()
    return true
  },

  /** Replaces the top screen (no way back to it). */
  replace<K extends RouteName<Routes>>(name: K, ...[params]: ParamsArg<K>): void {
    const top = stack.pop()
    if (top) close(top, true)
    nav.push(name, ...([params] as ParamsArg<K>))
  },

  /** Replaces the whole stack, bottom first. */
  reset(entries: Array<{ name: RouteName<Routes>; params?: Record<string, unknown> }>): void {
    if (entries.length === 0) throw new Error("nav.reset needs at least one screen")
    while (stack.length > 0) close(stack.pop()!, false)
    globalThis.__zn_nav(NavKind.Clear, 0, 0, null)
    for (const { name, params } of entries) {
      const e = open(name, params ?? {})
      globalThis.__zn_nav(NavKind.Push, e.id, e.route, JSON.stringify(e.params))
      show(e)
    }
    syncTop()
  },

  /** The top screen's route name and params (null before the app has started). */
  current(): { name: string; params: Record<string, unknown> } | null {
    const top = stack[stack.length - 1]
    return top ? { name: top.name, params: top.params } : null
  },

  /** Number of screens in the stack. */
  depth(): number {
    return stack.length
  },
}

/**
 * Lets the current screen handle the system back press (button or gesture). Return true when handled (for example
 * a "Discard amount?" bar was shown) and the screen stays; false to go back as usual. Same meaning as React Native's
 * BackHandler. Call it in a component body: the screen's, or a part shown later (a tab, a `cond && <X/>` branch); it
 * stops when that part goes. Only the top screen is asked; its newest handler first, then the older ones.
 */
export function useBack(handler: () => boolean): void {
  const e = screenHere("useBack must be called while a screen renders (in a component body)")
  e.backs.push(handler)
  if (getOwner()) onCleanup(() => {
    const i = e.backs.lastIndexOf(handler)
    if (i >= 0) e.backs.splice(i, 1)
  })
}

/**
 * Runs [fn] each time this screen gets focus: when it opens on top, and when the screen above it closes (back from
 * checkout, say). If [fn] returns a function, that runs when the screen loses focus (another screen opens on top, or it
 * closes). Like React Navigation's `useFocusEffect`. In a tab, use `tabs.onFocus(name, fn)`: it also follows the tab.
 * Call it in a component body. Focus is about the stack only: for the app coming to the front, use `onAppState`.
 */
export function useFocus(fn: () => void | (() => void)): void {
  const e = screenHere("useFocus must be called inside a screen (in a component body)")
  watchFocus(() => topId() === e.id, fn)
}

/** @internal Calls [fn] each time [focused] turns true, and its cleanup when it turns false or the owner goes. */
export function watchFocus(focused: () => boolean, fn: () => void | (() => void)): void {
  let on = false
  let blur: (() => void) | void = undefined
  const leave = () => {
    const b = blur
    blur = undefined
    if (typeof b !== "function") return
    try {
      b()
    } catch (err) {
      reportError("focus cleanup", err)
    }
  }
  effect(() => {
    const now = focused()
    if (now === on) return
    on = now
    untrack(() => {
      if (!now) return leave()
      try {
        blur = fn()
      } catch (err) {
        reportError("focus handler", err)
      }
    })
  })
  if (getOwner()) onCleanup(() => {
    if (on) leave()
    on = false
  })
}

/** @internal The entry of the screen being built, or of the screen that owns the current code; throws [message] if none. */
export function screenHere(message: string): Entry {
  const e = rendering ?? screenOf(getOwner())
  if (!e) throw new Error(message)
  return e
}

/** @internal The id of the top screen's entry (reactive). */
export function topScreenId(): number {
  return topId()
}

/** @internal The tab names of route [name], or undefined if it has none. */
export function routeTabs(name: string): readonly string[] | undefined {
  const r = table?.[name]
  return r && !isNative(r) ? r.tabs : undefined
}

/**
 * @internal Whether native must ask JS when Back is pressed while [e] is the only screen (NAV BACK_WANTED). Native
 * otherwise lets the system handle that press at once (the app goes to the background).
 */
export function setBackWanted(e: Entry, wanted: boolean): void {
  globalThis.__zn_nav(NavKind.BackWanted, e.id, wanted ? 1 : 0, null)
}

/**
 * Hears a native screen's answer when no `pushForResult` waits for it: after a kill, or when the screen was opened with
 * `nav.push`. It also hears an answer already saved, and hears it again at each start until you call `ack`, after you
 * acted on it. Called while a screen is built, it stops with the screen.
 */
export function onNavResult<T = unknown>(route: string, handler: (value: T, ack: () => void) => void): () => void {
  const key = navKey(route)
  const seen = new Set<string>()
  const deliver = (r: LaunchRecord) => {
    if (r.status !== "result" || seen.has(r.id)) return
    seen.add(r.id)
    try {
      handler(valueOf(r) as T, () => void launches.ack(key, r.id))
    } catch (err) {
      reportError("onNavResult handler", err)
    }
  }
  const set = resultListeners.get(route) ?? new Set()
  resultListeners.set(route, set)
  set.add(deliver)
  const off = () => void set.delete(deliver)
  if (getOwner()) onCleanup(off)
  const saved = launches.pending(key)
  if (saved) void Promise.resolve().then(() => deliver(saved))
  return off
}

const navKey = (route: string) => `nav.${route}`

function valueOf(record: LaunchRecord): unknown {
  const text = record.extras?.value
  return typeof text === "string" ? JSON.parse(text) : null
}

function isNative(route: AnyRouteDef | undefined): route is NativeRouteDef {
  return route !== undefined && "native" in route
}

/** A native screen answered. Its answer is on disk; the top of the stack closes here, as JS owns the stack. */
function onNavResultEvent(payload: NativeValue): void {
  const { entry, route, id } = JSON.parse(String(payload)) as { entry: number; route: string; id: string }
  const key = navKey(route)
  const record = launches.pending(key)
  const resolve = waiting.get(entry)
  waiting.delete(entry)
  if (record?.id === id) {
    if (resolve) {
      void launches.ack(key, id)
      resolve(valueOf(record))
    } else {
      resultListeners.get(route)?.forEach((deliver) => deliver(record))
    }
  } else {
    globalThis.__zn_log(3, `nav: no saved answer for screen ${route}`)
    resolve?.(null)
  }
  if (stack[stack.length - 1]?.id === entry && !nav.back()) globalThis.__zn_nav(NavKind.Exit, 0, 0, null)
}

export interface ImpressionOptions {
  /** How much of a card must be visible to count, 0–1. Default 0.35 (the web IntersectionObserver rule). */
  threshold?: number
  /** It must stay that visible this long (ms). Default 0: counts at once. */
  minMs?: number
  /** "screen" (default): each key once per visit of this screen. "session": once per app session. */
  once?: "screen" | "session"
}

/**
 * Turns on impressions for the current screen: nodes with an `impressionKey` are measured natively, and `handler`
 * gets the keys that became visible (≥ threshold, while the screen is on top and the app is in front), in batches.
 * JS does nothing while the user scrolls. Call it in the screen body, once.
 */
export function useImpressions(handler: (keys: string[]) => void, options: ImpressionOptions = {}): void {
  if (!rendering) throw new Error("useImpressions must be called while a screen renders (in a component body)")
  const threshold = options.threshold ?? 0.35
  if (!(threshold > 0 && threshold <= 1)) throw new Error("useImpressions: threshold must be more than 0 and at most 1")
  rendering.impressions = { handler, session: options.once === "session" }
  globalThis.__zn_nav(NavKind.Impressions, rendering.id, 0, JSON.stringify({ threshold, minMs: options.minMs ?? 0 }))
}

/** Longest JSON a restorableSignal value may have (saved state is small: Android limits it to ~1 MB in all). */
const MAX_RESTORABLE_CHARS = 4_000

/**
 * Like `signal`, but its value comes back when Android restores the screen after killing the app in the background
 * (the amount typed on a keypad, a half-filled form, the selected tab). Call it inside a screen (a component body,
 * also in a part shown later); `key` names the value on this screen. The value must be JSON-able and small (≤4,000
 * chars as JSON); it comes back as JSON gives it (a Date as a string). Nothing is kept across normal launches: use
 * `persistedSignal` (storage) for that. Values come back only into the same bundle that saved them (an update
 * installed meanwhile starts the screen fresh). Guide notes: "Values that survive Android killing the app".
 */
export function restorableSignal<T>(key: string, initial: T, options?: { equals?: (a: T, b: T) => boolean }): Signal<T> {
  const e = screenOf(getOwner())
  if (!e) throw new Error("restorableSignal must be called inside a screen (in a component body)")
  const keys = (e.restoreKeys ??= new Set())
  if (keys.has(key)) throw new Error(`restorableSignal: the key "${key}" is already used on screen "${e.name}"`)
  keys.add(key)
  onCleanup(() => keys.delete(key))

  let first = initial
  if (e.restored && key in e.restored) {
    first = e.restored[key] as T
    delete e.restored[key]
  }
  let warned = false
  const keep = (value: T) => {
    let json: string | undefined
    try {
      json = JSON.stringify(value)
    } catch {
      json = undefined
    }
    if (json !== undefined && json.length <= MAX_RESTORABLE_CHARS) {
      globalThis.__zn_nav(NavKind.Restore, e.id, 0, `{"key":${JSON.stringify(key)},"value":${json}}`)
      return
    }
    if (!warned) {
      warned = true
      const why = json === undefined ? "isn't JSON" : `is ${json.length} chars as JSON (at most ${MAX_RESTORABLE_CHARS})`
      globalThis.__zn_log(2, `restorableSignal "${key}" on screen "${e.name}": the value ${why}; it won't come back`)
    }
    globalThis.__zn_nav(NavKind.Restore, e.id, 0, JSON.stringify({ key })) // an older value mustn't come back instead
  }

  const s = signal(first, options)
  keep(first)
  const set = s.set
  s.set = (next) => {
    const before = s.peek()
    set(next)
    const now = s.peek()
    if (!Object.is(before, now)) keep(now)
  }
  return s
}

function screenOf(o: Owner | null): Entry | undefined {
  for (; o; o = o.parent) {
    const e = screenOwners.get(o)
    if (e) return e
  }
  return undefined
}

/** Native's batch of counted keys for one screen. */
function onImpressions(payload: NativeValue): void {
  const { entry, keys } = JSON.parse(String(payload)) as { entry: number; keys: string[] }
  const e = stack.find((s) => s.id === entry)
  if (!e?.impressions) return
  let out = keys
  if (e.impressions.session) {
    out = keys.filter((k) => !seenThisSession.has(k))
    out.forEach((k) => seenThisSession.add(k))
  }
  if (out.length === 0) return
  try {
    e.impressions.handler(out)
  } catch (err) {
    reportError("impressions handler", err)
  }
}

/**
 * A deep link. `params`: path and query values, as text; `url`: the whole link; `atStart`: it is the link that started
 * the app, so no screen but the start screen exists yet.
 */
export interface OpenedLink {
  route: string
  params: Record<string, string>
  url: string
  atStart: boolean
}

export interface AppOptions {
  /**
   * Called before a deep link opens its route, while the app runs or for the link that started it; return false to
   * refuse it (a link must not take the user away from a payment in flight, say). Links are outside input: check their
   * values. A link refused at start leaves the user on the start screen.
   */
  onLink?: (link: OpenedLink) => boolean
}

/** Starts the app: registers the routes and waits for native's START event with the first stack. */
export function startApp(routes: Record<string, AnyRouteDef>, options: AppOptions = {}): void {
  table = routes
  names = Object.keys(routes)
  onLink = options.onLink ?? null
  onEvent(APP, AppEvent.Start, (payload) => start(payload))
  onEvent(APP, AppEvent.Back, (payload) => onSystemBack(payload))
  onEvent(APP, AppEvent.ForcedBack, (payload) => onForcedBack(payload))
  onEvent(APP, AppEvent.Open, (payload) => onOpenLink(payload))
  onEvent(APP, AppEvent.Impressions, (payload) => onImpressions(payload))
  onEvent(APP, AppEvent.Retry, (payload) => onRetry(payload))
  onEvent(APP, AppEvent.NavResult, (payload) => onNavResultEvent(payload))
  setTopScreen(() => stack[stack.length - 1]?.name ?? null)
  installInsets()
  installAppState()
  installAppearance()
  installTasks()
}

/**
 * A deep link while the app runs: native matched it to a route that allows links; JS opens it on top. A link to a
 * screen with tabs that is already in the stack (with the same params) goes back to that screen instead, closing the
 * screens above it, and selects the link's tab ("tab" param), like React Navigation's `navigate`. `onLink` decides
 * first, so an app refuses links while a payment is open.
 */
function onOpenLink(payload: NativeValue): void {
  const { route, params, url } = JSON.parse(String(payload)) as { route: number; params: Record<string, string>; url?: string }
  const name = names[route]
  if (name === undefined) return globalThis.__zn_log(3, `nav: link to unknown route ${route}`)
  if (!linkAllowed({ route: name, params, url: url ?? "", atStart: false })) return
  const host = routeTabs(name) ? tabHostFor(name, params) : undefined
  if (host) {
    while (stack[stack.length - 1] !== host) close(stack.pop()!, true)
    const tab = params.tab
    if (tab !== undefined && !host.tabs?.select(tab)) globalThis.__zn_log(2, `nav: link to tab "${tab}" of "${name}": no such tab shown`)
    syncTop()
  } else {
    ;(nav.push as (n: string, p: Record<string, unknown>) => void)(name, params)
  }
  if (url) {
    for (const listener of [...linkListeners]) {
      try {
        listener(url)
      } catch (err) {
        reportError("Linking url listener", err)
      }
    }
  }
}

/** The highest screen of route [name] whose own params all equal the link's ("tab" aside), or undefined. */
function tabHostFor(name: string, params: Record<string, string>): Entry | undefined {
  for (let i = stack.length - 1; i >= 0; i--) {
    const e = stack[i]
    if (e.name !== name) continue
    if (Object.entries(e.params).every(([k, v]) => k === "tab" || params[k] === v)) return e
  }
  return undefined
}

// Linking.getInitialURL and Linking.addEventListener("url") (linking.ts): read-only copies of the links that got past
// onLink and opened their route. Links that match no route never reach JS (on purpose).
let started = false
let startLink: string | null = null
const startWaiters: ((url: string | null) => void)[] = []
const linkListeners = new Set<(url: string) => void>()

/** The link that started the app and opened its screen, or null. Waits for the first screens. */
export function initialLink(): Promise<string | null> {
  if (started) return Promise.resolve(startLink)
  return new Promise((resolve) => startWaiters.push(resolve))
}

/** Calls [listener] with each link that opens its screen while the app runs. Returns the function that stops it. */
export function onOpenedLink(listener: (url: string) => void): () => void {
  linkListeners.add(listener)
  return () => void linkListeners.delete(listener)
}

function linkAllowed(link: OpenedLink): boolean {
  if (!onLink) return true
  try {
    return onLink(link) !== false
  } catch (err) {
    reportError("onLink handler", err)
    return false // a guard that throws refuses: a link must not get past a broken check
  }
}

/** Tests only: forgets the stack and the routes (screens are disposed, nothing is sent). */
export function resetNavForTests(): void {
  while (stack.length > 0) stack.pop()!.dispose()
  table = null
  names = []
  rendering = null
  topId.set(0)
  waiting.clear()
  resultListeners.clear()
  started = false
  startLink = null
  startWaiters.length = 0
  linkListeners.clear()
}

function open(name: string, params: Record<string, unknown>): Entry {
  if (!table) throw new Error("zero-native: startApp(routes) wasn't called")
  const route = names.indexOf(name)
  if (route < 0) throw new Error(`zero-native: unknown route "${name}"`)
  return { id: allocInstanceId(), route, name, params, dispose: () => {}, backs: [] }
}

/** Renders an entry's screen on its root instance and puts it on top of the stack. */
function show(e: Entry): void {
  render(e)
  stack.push(e)
}

/**
 * Builds an entry's screen. If it throws, the entry stays (so the stack JS and native see stays the same and Back
 * works), the error is reported, and native shows its error screen for it (NAV FAILED).
 */
function render(e: Entry): void {
  const route = table![e.name]!
  if (isNative(route)) return // drawn by native
  const screen = route.screen
  const prev = rendering
  rendering = e
  try {
    // Screens return JSX, which the compiler turned into a View.
    const build = screen as (props: Record<string, unknown>) => View
    e.dispose = renderRoot(e.id, (props: Record<string, unknown>) => {
      const root = getOwner()
      if (root) screenOwners.set(root, e)
      return build(props)
    }, e.params)
    e.failed = false
  } catch (err) {
    // renderRoot has already stopped whatever the screen started. Handlers it set up belong to the failed build.
    e.dispose = () => {}
    e.backs = []
    e.tabs = undefined
    e.impressions = undefined
    e.failed = true
    reportError(`screen "${e.name}"`, err, "screen", e.name)
    const message = err instanceof Error ? err.message : String(err)
    globalThis.__zn_nav(NavKind.Failed, e.id, 0, JSON.stringify({ message }))
  } finally {
    rendering = prev
  }
}

/**
 * "Try again" on a screen native shows as failed (it threw while being built, or JS hung on it): native has made a
 * fresh root for it; stop what is left of the old build and build the screen again.
 */
function onRetry(payload: NativeValue): void {
  const e = stack.find((s) => s.id === Number(payload))
  if (!e) return
  e.dispose()
  render(e)
}

/** Disposes an entry's screen (effects, events, timers). `send`: also tell native to take it out of the stack. */
function close(e: Entry, send: boolean): void {
  e.dispose()
  const resolve = waiting.get(e.id)
  if (resolve) {
    waiting.delete(e.id)
    resolve(null) // the user went back
  }
  if (send) globalThis.__zn_nav(NavKind.Remove, e.id, 0, null)
}

function start(payload: NativeValue): void {
  if (stack.length > 0) {
    globalThis.__zn_log(2, "nav: start event ignored, the app has already started")
    return
  }
  appStarting()
  const entries = JSON.parse(String(payload)) as Array<{
    entry: number
    route: number
    params: Record<string, unknown>
    /** restorableSignal values, when Android restored the app (host API 4). */
    values?: Record<string, unknown>
    /** The whole link that started the app, on the screen it opens. Older bundles ignore it and open the screen. */
    link?: string
  }>
  for (const { entry, route, params, values, link } of entries) {
    const name = names[route]
    if (name === undefined) {
      globalThis.__zn_log(3, `nav: start entry ${entry} has unknown route ${route}`)
      continue
    }
    if (link !== undefined && !linkAllowed({ route: name, params: (params ?? {}) as Record<string, string>, url: link, atStart: true })) {
      // A link to the start screen itself (host API 8: say, one of its tabs) can't remove it: it opens as usual.
      if (stack.length === 0) {
        show({ id: entry, route, name, params: {}, dispose: () => {}, backs: [], restored: values })
        continue
      }
      globalThis.__zn_nav(NavKind.Remove, entry, 0, null)
      continue
    }
    if (link !== undefined) startLink ??= link
    show({ id: entry, route, name, params: params ?? {}, dispose: () => {}, backs: [], restored: values })
  }
  syncTop()
  started = true
  for (const resolve of startWaiters.splice(0)) resolve(startLink)
  // The first screens are built (a screen that threw has already sent FAILED): the OTA safety nets count the bundle
  // as on screen from here (docs/ota.md §3.6).
  globalThis.__zn_nav(NavKind.Started, 0, 0, null)
}

/** [payload]: the screen native had on top when Back was pressed. */
function onSystemBack(payload: NativeValue): void {
  globalThis.__zn_nav(NavKind.BackAnswered, 0, 0, null)
  const top = stack[stack.length - 1]
  // JS already left that screen (a scan's answer closed the scanner in the same moment): this press was for it, so it
  // must not close the next screen too, or exit the app from the last one.
  if (payload != null && top != null && Number(payload) !== top.id) return
  // The newest handler first: a tab's own handler (a sheet open in it) before the tabs' "back to the first tab".
  const handlers = top ? [...top.backs] : []
  for (let i = handlers.length - 1; i >= 0; i--) {
    let handled = false
    try {
      handled = handlers[i]() === true
    } catch (e) {
      reportError("useBack handler", e)
    }
    if (handled) return
  }
  if (!nav.back()) globalThis.__zn_nav(NavKind.Exit, 0, 0, null)
}

/** Native popped an entry by itself (JS didn't answer a back press in time): forget it without a NAV op. */
function onForcedBack(payload: NativeValue): void {
  const i = stack.findIndex((e) => e.id === Number(payload))
  if (i < 0) return
  const [e] = stack.splice(i, 1)
  close(e, false)
  syncTop()
}
