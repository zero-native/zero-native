// React Native and React Navigation names over zero-native's own APIs (RN-compat sweep P1.14–P1.17, guide notes §56).
// Each is a thin wrapper, so RN code and LLM-written code work with only the import changed to "@zeronative/core".
// The zn names stay the main ones; the guide says where a wrapper differs from RN.
//
// Left out on purpose:
// - useMemo: a component body runs once in zn, so a useMemo would never compute again (stale with no error). Use
//   computed(() => ...).
// - React Navigation's navigate(): it jumps back to a screen already open, where push always opens a new one. Use
//   nav.push or goBack.
// - useState / useEffect / useContext: signals and effect are the zn way (docs/rn-compatibility.md §0).
import { colorScheme, onColorSchemeChange, type ColorScheme } from "./appearance"
import { addBackHandler, exitApp, nav, screenHere, topScreenId, useFocus } from "./nav"
import { createStorage } from "./storage"
export { clearImmediate, setImmediate } from "./timers"

// ---- React (P1.14) ------------------------------------------------------------------------------------------------

/** React Navigation's useFocusEffect: runs [fn] each time the screen gets focus; its returned function on blur. */
export function useFocusEffect(fn: () => void | (() => void)): void {
  useFocus(fn)
}

/** React's useCallback: the function itself. A component body runs once in zn, so there is nothing to keep. */
export function useCallback<T extends (...args: never[]) => unknown>(fn: T, _deps?: readonly unknown[]): T {
  return fn
}

/**
 * React's useRef: a box that keeps a value for the component's life. Changing `current` doesn't redraw anything
 * (use a signal for that). Works as a TextField `ref` too.
 */
export function useRef<T>(initial: T): { current: T } {
  return { current: initial }
}

// ---- React Navigation (P1.15) -------------------------------------------------------------------------------------

/** What useNavigation() gives: React Navigation's stack methods that zn has. */
export interface Navigation {
  /** Closes this screen (nothing on the last one). */
  goBack(): void
  /** True when there is a screen to go back to. */
  canGoBack(): boolean
  push: typeof nav.push
  replace: typeof nav.replace
  /** Closes [count] screens (default 1), never the last one. */
  pop(count?: number): void
  /** Closes every screen above the first one. */
  popToTop(): void
  /** True while this screen is on top. Reading it inside JSX follows changes. */
  isFocused(): boolean
}

/** React Navigation's useNavigation(). Call it in a component body. No navigate(): use push or goBack. */
export function useNavigation(): Navigation {
  const e = screenHere("useNavigation must be called inside a screen (in a component body)")
  const pop = (count = 1) => {
    for (let i = 0; i < count && nav.depth() > 1; i++) nav.back()
  }
  return {
    goBack: () => void nav.back(),
    canGoBack: () => nav.depth() > 1,
    push: nav.push,
    replace: nav.replace,
    pop,
    popToTop: () => pop(nav.depth() - 1),
    isFocused: () => topScreenId() === e.id,
  }
}

/** React Navigation's useRoute(): this screen's route name and params. Call it in a component body. */
export function useRoute<P extends Record<string, unknown> = Record<string, unknown>>(): { key: string; name: string; params: P } {
  const e = screenHere("useRoute must be called inside a screen (in a component body)")
  return { key: String(e.id), name: e.name, params: e.params as P }
}

// ---- AsyncStorage (P1.16) -----------------------------------------------------------------------------------------

/**
 * @react-native-async-storage/async-storage's API: strings only, a Promise for each call, `null` for a missing key.
 * Kept in its own store ("rn.async-storage"), apart from `storage` (typed values), so the two never mix up types.
 * Each call is done at once (zn storage is synchronous); the Promise only matches RN's shape.
 */
const asyncStore = createStorage("rn.async-storage")

function asString(key: string, value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`AsyncStorage: the value of "${key}" must be a string (use JSON.stringify)`)
  return value
}

/** JSON objects merged deeply, as AsyncStorage.mergeItem does. */
function mergeDeep(a: unknown, b: unknown): unknown {
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return b
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) }
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = mergeDeep(out[k], v)
  return out
}

const run = <T>(fn: () => T): Promise<T> => {
  try {
    return Promise.resolve(fn())
  } catch (e) {
    return Promise.reject(e)
  }
}

export const AsyncStorage = {
  getItem: (key: string): Promise<string | null> => run(() => asyncStore.getString(key) ?? null),
  setItem: (key: string, value: string): Promise<void> => run(() => asyncStore.set(key, asString(key, value))),
  removeItem: (key: string): Promise<void> => run(() => asyncStore.delete(key)),
  mergeItem: (key: string, value: string): Promise<void> =>
    run(() => {
      const old = asyncStore.getString(key)
      const merged = old == null ? JSON.parse(asString(key, value)) : mergeDeep(JSON.parse(old), JSON.parse(asString(key, value)))
      asyncStore.set(key, JSON.stringify(merged))
    }),
  clear: (): Promise<void> => run(() => asyncStore.clear()),
  getAllKeys: (): Promise<readonly string[]> => run(() => asyncStore.keys()),
  multiGet: (keys: readonly string[]): Promise<readonly [string, string | null][]> =>
    run(() => keys.map((k) => [k, asyncStore.getString(k) ?? null] as [string, string | null])),
  multiSet: (pairs: readonly (readonly [string, string])[]): Promise<void> =>
    run(() => {
      for (const [k, v] of pairs) asString(k, v)
      for (const [k, v] of pairs) asyncStore.set(k, v)
    }),
  multiRemove: (keys: readonly string[]): Promise<void> => run(() => keys.forEach((k) => asyncStore.delete(k))),
  multiMerge: async (pairs: readonly (readonly [string, string])[]): Promise<void> => {
    for (const [k, v] of pairs) await AsyncStorage.mergeItem(k, v)
  },
}

// ---- BackHandler, Appearance, useColorScheme (P1.17; setImmediate is in timers.ts)  -------------------------------------------------

/**
 * React Native's BackHandler. A handler belongs to a screen, as with useBack: the screen being built (or whose code is
 * running), else the top screen. It stops when that screen closes, or on remove(). Return true when handled.
 */
export const BackHandler = {
  addEventListener(event: "hardwareBackPress", handler: () => boolean | null | undefined): { remove(): void } {
    if (event !== "hardwareBackPress") throw new Error(`BackHandler: only "hardwareBackPress" (not "${String(event)}")`)
    return { remove: addBackHandler(() => handler() === true) }
  },
  /** Closes the app, as Back on the last screen does. */
  exitApp(): void {
    exitApp()
  },
}

/** React Native's Appearance. getColorScheme() reads the phone's setting now; inside JSX it follows changes. */
export const Appearance = {
  getColorScheme(): ColorScheme {
    return colorScheme()
  },
  /** Called on each change. Ends with the screen when added while a screen is built, as other zn listeners do. */
  addChangeListener(listener: (p: { colorScheme: ColorScheme }) => void): { remove(): void } {
    return { remove: onColorSchemeChange((s) => listener({ colorScheme: s })) }
  },
}

/**
 * React Native's useColorScheme(). A component body runs once in zn, so a value kept in a variable doesn't follow a
 * later change of the phone's setting: read it inside JSX (`useColorScheme() === "dark" ? a : b` in a prop that can
 * change at runtime), or use scheme(light, dark).
 */
export function useColorScheme(): ColorScheme {
  return colorScheme()
}

