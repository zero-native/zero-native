// Tabs inside one screen (docs/guide-notes.md §40). The route lists the names: `home: { path: "/", screen: Home,
// tabs: ["pay", "stores", "offers"] }`. The screen calls `useTabs("home")` and shows the tabs with the native <Tabs>
// container, which draws only the selected one:
//
//   const tabs = useTabs("home")
//   <Tabs selected={tabs.index()} style={{ flex: 1 }}>
//     <Column style={{ flex: 1 }}>{tabs.seen("pay") && <PayTab tabs={tabs} />}</Column>
//     <Column style={{ flex: 1 }}>{tabs.seen("stores") && <StoresTab tabs={tabs} />}</Column>
//     ...
//   </Tabs>
//   <MyTabBar tabs={tabs} />          // the app's own bar: tabs.selected(), tabs.select("stores")
//
// - Lazy: a tab is built the first time it is shown (`seen` turns true and stays true), unless `preload`. A tab you
//   leave keeps its JS state; native drops its drawing and keeps its scroll position (SaveableStateHolder).
// - Back on a tab other than the first goes to the first tab (React Navigation's default "firstRoute"). That works on
//   the only screen too: native asks JS then (NAV BACK_WANTED, host API 8).
// - The selected tab comes back after Android kills the app (a restorableSignal). Only that tab is built then.
// - A link to "<path>/<tab>" opens the screen on that tab, or goes back to it if it is in the stack (nav.ts onOpenLink).
import { restorableSignal, routeTabs, screenHere, setBackWanted, topScreenId, useBackUncounted, watchFocus, type Routes } from "./nav"
import { batch, computed, effect, onCleanup, signal, type Signal } from "./signals"
import type { TabName, TabRouteName } from "./routes"

/** What `useTabs` returns: the selected tab, and what the screen and its bar need. */
export interface TabsHandle<T extends string = string> {
  /** The tab names, in the route's order. */
  readonly names: readonly T[]
  /** The selected tab (reactive). */
  selected(): T
  /** Its position in `names` (reactive): pass it to `<Tabs selected={...}>`. */
  index(): number
  /** Shows tab [name]. Selecting the selected tab does nothing. */
  select(name: T): void
  /** True once tab [name] has been shown (or from the start with `preload`); it stays true. Guard the tab with it. */
  seen(name: T): boolean
  /**
   * Runs [fn] each time tab [name] gets focus: it is selected while its screen is on top, or its screen comes back on
   * top with it selected (back from checkout). A returned function runs when it loses focus. React Navigation's
   * `useFocusEffect` in a tab screen. Call it in a component body; it stops with that part.
   */
  onFocus(name: T, fn: () => void | (() => void)): void
}

export interface TabsOptions<T extends string> {
  /** The tab to show first. Default: the link's "tab" param if any, else the first tab. */
  initial?: T
  /** Build every tab at once, not on first show (React Navigation's `lazy: false`). Costs start time. */
  preload?: boolean
}

type TabRoute = string extends keyof Routes ? string : TabRouteName<Routes>

/**
 * The tabs of this screen. [route] is this screen's route name; it must have `tabs` in routes.ts. Call it once, in the
 * screen's body.
 */
export function useTabs<K extends TabRoute>(route: K, options: TabsOptions<TabName<Routes, K>> = {}): TabsHandle<TabName<Routes, K>> {
  type T = TabName<Routes, K>
  const e = screenHere("useTabs must be called in a screen's body")
  if (e.name !== route) throw new Error(`useTabs("${route}") is called in screen "${e.name}"`)
  const names = routeTabs(route) as readonly T[] | undefined
  if (!names || names.length === 0) throw new Error(`useTabs: route "${route}" has no tabs (add tabs: [...] in routes.ts)`)
  if (e.tabs) throw new Error(`useTabs: screen "${route}" already has its tabs`)

  const known = (name: unknown): name is T => typeof name === "string" && (names as readonly string[]).includes(name)
  const linked = e.params.tab
  const first = known(options.initial) ? options.initial : known(linked) ? linked : names[0]
  const kept = restorableSignal<string>("zn.tab", first)
  // An update may have renamed the tab that was saved before a kill.
  if (!known(kept.peek())) kept.set(first)
  const current = kept as unknown as Signal<T>
  const seenFlags = new Map<T, Signal<boolean>>(names.map((n) => [n, signal(options.preload === true || n === current.peek())]))
  const index = computed(() => names.indexOf(current()))

  const select = (name: T): void => {
    if (!known(name)) throw new Error(`tabs.select: "${name}" is not a tab of "${route}" (${names.join(", ")})`)
    // One batch: native gets the new tab's first build and the switch together and draws them in one frame. The
    // selection is written first, so the old tab loses focus before the new one gets it.
    batch(() => {
      current.set(name)
      seenFlags.get(name)!.set(true)
    })
  }

  const handle: TabsHandle<T> = {
    names,
    selected: () => current(),
    index,
    select,
    seen: (name) => {
      const flag = seenFlags.get(name)
      if (!flag) throw new Error(`tabs.seen: "${name}" is not a tab of "${route}"`)
      return flag()
    },
    onFocus: (name, fn) => {
      if (!known(name)) throw new Error(`tabs.onFocus: "${name}" is not a tab of "${route}"`)
      watchFocus(() => topScreenId() === e.id && current() === name, fn)
    },
  }

  e.tabs = {
    select: (name) => {
      if (!known(name)) return false
      select(name)
      return true
    },
  }
  onCleanup(() => {
    if (e.tabs) e.tabs = undefined
  })

  // Back: to the first tab first. Registered before the tabs' own handlers, so those are asked before this one. Not
  // counted for BACK_WANTED (it often answers false): the effect below says when tabs want Back.
  useBackUncounted(() => {
    if (index() <= 0) return false
    select(names[0])
    return true
  })
  // Native lets the system take Back (and animates back gestures ahead of JS) unless told otherwise: tell it while a
  // later tab is shown.
  let wanted = false // native's default
  effect(() => {
    const want = index() > 0
    if (want === wanted) return
    wanted = want
    setBackWanted(e, want)
  })
  onCleanup(() => {
    // "Try again" builds the screen again on the same entry: it must start from native's default.
    if (wanted) setBackWanted(e, false)
  })
  return handle
}
