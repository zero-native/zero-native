// Navigation (ARCHITECTURE.md §8.3, §11): the back stack is owned by JS.
//
// - The stack is a list of entries { id, route, params }. An entry's id is its screen's root instance id.
// - JS changes the stack with nav.push / back / replace / reset and sends each change as a NAV op in the normal
//   batch (kinds in core/include/zn/batch.h). The screen is rendered in the same tick, so native gets the NAV op
//   and the screen's first values in one batch and draws them in one frame.
// - Screens opened before JS runs (cold start, deep link) are created by native, which then sends the start event
//   with their entries; JS renders them on the roots native made and sends no NAV for them.
// - A system back press is an event to JS. JS asks the top screen's useBack handler, else pops, else (last screen)
//   tells native to let the system handle it. JS always answers, so native's 300 ms fallback never fires normally.
//
// App-level events from native use instance 0 (no screen has id 0): START, BACK, FORCED_BACK, OPEN (a deep link
// while the app runs), INSETS (5, insets.ts). Native side: android/runtime/.../ZnNav.kt.
import { onEvent } from "./events"
import { installInsets } from "./insets"
import type { NativeValue } from "./native"
import type { RouteDef, RouteName, RouteParams } from "./routes"
import { allocInstanceId, renderRoot } from "./view"

/** Apps register their routes for typed navigation (in routes.ts):
 *    declare module "@zero-native/core" { interface Register { routes: typeof routes } } */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface Register {}
type Routes = Register extends { routes: infer R } ? R : Record<string, RouteDef>

const NavKind = { Push: 1, Remove: 2, Clear: 3, Exit: 4, BackAnswered: 5 } as const
export const AppEvent = { Start: 1, Back: 2, ForcedBack: 3, Open: 4 } as const
const APP = 0

interface Entry {
  id: number
  route: number
  name: string
  params: Record<string, unknown>
  dispose: () => void
  onBack: (() => boolean) | null
}

let table: Record<string, RouteDef> | null = null
let names: string[] = []
const stack: Entry[] = []
/** The entry whose screen is being rendered right now (for useBack). */
let rendering: Entry | null = null

type ParamsArg<K extends RouteName<Routes>> = {} extends RouteParams<Routes, K>
  ? [params?: RouteParams<Routes, K>]
  : [params: RouteParams<Routes, K>]

export const nav = {
  /** Opens a screen on top of the current one. */
  push<K extends RouteName<Routes>>(name: K, ...[params]: ParamsArg<K>): void {
    const e = open(name, (params ?? {}) as Record<string, unknown>)
    globalThis.__zn_nav(NavKind.Push, e.id, e.route, JSON.stringify(e.params))
    show(e)
  },

  /** Closes the top screen. Returns false (and does nothing) on the last screen. */
  back(): boolean {
    if (stack.length <= 1) return false
    close(stack.pop()!, true)
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
 * BackHandler. Call it while the screen renders (in the component body). Only the top screen is asked.
 */
export function useBack(handler: () => boolean): void {
  if (!rendering) throw new Error("useBack must be called while a screen renders (in a component body)")
  rendering.onBack = handler
}

/** Starts the app: registers the routes and waits for native's START event with the first stack. */
export function startApp(routes: Record<string, RouteDef>): void {
  table = routes
  names = Object.keys(routes)
  onEvent(APP, AppEvent.Start, (payload) => start(payload))
  onEvent(APP, AppEvent.Back, () => onSystemBack())
  onEvent(APP, AppEvent.ForcedBack, (payload) => onForcedBack(payload))
  onEvent(APP, AppEvent.Open, (payload) => onOpenLink(payload))
  installInsets()
}

/** A deep link while the app runs: native matched it to a route that allows links; JS opens it on top. */
function onOpenLink(payload: NativeValue): void {
  const { route, params } = JSON.parse(String(payload)) as { route: number; params: Record<string, string> }
  const name = names[route]
  if (name === undefined) return globalThis.__zn_log(3, `nav: link to unknown route ${route}`)
  ;(nav.push as (n: string, p: Record<string, unknown>) => void)(name, params)
}

/** Tests only: forgets the stack and the routes (screens are disposed, nothing is sent). */
export function resetNavForTests(): void {
  while (stack.length > 0) stack.pop()!.dispose()
  table = null
  names = []
  rendering = null
}

function open(name: string, params: Record<string, unknown>): Entry {
  if (!table) throw new Error("zero-native: startApp(routes) wasn't called")
  const route = names.indexOf(name)
  if (route < 0) throw new Error(`zero-native: unknown route "${name}"`)
  return { id: allocInstanceId(), route, name, params, dispose: () => {}, onBack: null }
}

/** Renders an entry's screen on its root instance and puts it on top of the stack. */
function show(e: Entry): void {
  const screen = table![e.name].screen
  const prev = rendering
  rendering = e
  try {
    e.dispose = renderRoot(e.id, screen, e.params)
  } finally {
    rendering = prev
  }
  stack.push(e)
}

/** Disposes an entry's screen (effects, events, timers). `send`: also tell native to take it out of the stack. */
function close(e: Entry, send: boolean): void {
  e.dispose()
  if (send) globalThis.__zn_nav(NavKind.Remove, e.id, 0, null)
}

function start(payload: NativeValue): void {
  if (stack.length > 0) {
    globalThis.__zn_log(2, "nav: start event ignored, the app has already started")
    return
  }
  const entries = JSON.parse(String(payload)) as Array<{ entry: number; route: number; params: Record<string, unknown> }>
  for (const { entry, route, params } of entries) {
    const name = names[route]
    if (name === undefined) {
      globalThis.__zn_log(3, `nav: start entry ${entry} has unknown route ${route}`)
      continue
    }
    show({ id: entry, route, name, params: params ?? {}, dispose: () => {}, onBack: null })
  }
}

function onSystemBack(): void {
  globalThis.__zn_nav(NavKind.BackAnswered, 0, 0, null)
  const top = stack[stack.length - 1]
  if (top?.onBack) {
    let handled = false
    try {
      handled = top.onBack() === true
    } catch (e) {
      globalThis.__zn_log(3, `useBack handler threw: ${e instanceof Error ? `${e.message}\n${e.stack}` : String(e)}`)
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
}
