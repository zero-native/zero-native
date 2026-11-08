// React Native / React Navigation names over the zn APIs (RN-compat sweep P1.14–P1.17).
import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installAppearance } from "../src/appearance"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { AppEvent, nav, resetNavForTests, startApp } from "../src/nav"
import {
  Appearance,
  AsyncStorage,
  BackHandler,
  useCallback,
  useColorScheme,
  useFocusEffect,
  useNavigation,
  useRef,
  useRoute,
  type Navigation,
} from "../src/rn"
import { defineRoutes } from "../src/routes"
import { activeTimerCount, clearImmediate, installTimers, setImmediate } from "../src/timers"
import { view } from "../src/view"

let host: FakeHost
const NATIVE_ROOT = 0x80000001
const ANSWERED = 5, REMOVE = 2, EXIT = 4, STARTED = 8
const send = (event: number, payload: string | number | null) => globalThis.__zn_onEvent(0, event, payload)
const navOps = () => host.ops.filter((o) => o[0] === "nav").map((o) => o[1])

// What the screens saw, for the tests to check.
let seen: { navigation?: Navigation; route?: ReturnType<typeof useRoute>; focus: string[]; back?: () => boolean } = { focus: [] }
const Home = () => view(0, () => {})
const Detail = (_: { id: string }) => {
  seen.navigation = useNavigation()
  seen.route = useRoute()
  useFocusEffect(useCallback(() => {
    seen.focus.push("focus")
    return () => seen.focus.push("blur")
  }, []))
  if (seen.back) BackHandler.addEventListener("hardwareBackPress", seen.back)
  return view(1, () => {})
}
const routes = defineRoutes({
  home: { path: "/", screen: Home },
  detail: { path: "/detail/:id", screen: Detail },
})

beforeEach(() => {
  resetNavForTests()
  host = installFakeHost()
  installEvents()
  installCalls()
  installTimers({ replaceGlobals: false })
  seen = { focus: [] }
  startApp(routes)
  send(AppEvent.Start, JSON.stringify([{ entry: NATIVE_ROOT, route: 0, params: {} }]))
  if (host.ops.at(-1)?.[1] === STARTED) host.ops.pop()
})

test("useNavigation / useRoute / useFocusEffect / useCallback", () => {
  nav.push("detail", { id: "d1" })
  expect(seen.route).toMatchObject({ name: "detail", params: { id: "d1" } })
  const n = seen.navigation!
  expect(n.canGoBack()).toBe(true)
  expect(n.isFocused()).toBe(true)
  expect(seen.focus).toEqual(["focus"])
  n.push("detail", { id: "d2" }) // a second detail on top: the first loses focus
  expect(n.isFocused()).toBe(false)
  expect(seen.focus).toEqual(["focus", "blur", "focus"])
  n.popToTop()
  expect(nav.depth()).toBe(1)
  expect(nav.current()!.name).toBe("home")
  seen.navigation!.goBack() // on the last screen: nothing happens
  expect(nav.depth()).toBe(1)
})

test("pop(count) never closes the last screen", () => {
  nav.push("detail", { id: "a" })
  nav.push("detail", { id: "b" })
  seen.navigation!.pop(5)
  expect(nav.depth()).toBe(1)
})

test("useRef keeps a box; useCallback is the identity", () => {
  const r = useRef(1)
  r.current = 2
  expect(r.current).toBe(2)
  const f = () => 3
  expect(useCallback(f, [1, 2])).toBe(f)
})

test("BackHandler: a handler on the screen keeps it; remove() and closing the screen stop it", () => {
  let keep = true
  seen.back = () => keep
  nav.push("detail", { id: "d1" })
  host.ops.length = 0
  send(AppEvent.Back, null)
  expect(navOps()).toEqual([ANSWERED])
  expect(nav.depth()).toBe(2)
  keep = false
  send(AppEvent.Back, null)
  expect(nav.depth()).toBe(1)

  // Added outside a screen's code: on the top screen; remove() stops it.
  seen.back = undefined
  nav.push("detail", { id: "d2" })
  const sub = BackHandler.addEventListener("hardwareBackPress", () => true)
  host.ops.length = 0
  send(AppEvent.Back, null)
  expect(nav.depth()).toBe(2)
  sub.remove() // its last handler: native may animate back gestures again (NAV BACK_WANTED 0, A8)
  send(AppEvent.Back, null)
  expect(navOps()).toEqual([ANSWERED, 10, ANSWERED, REMOVE])
  expect(() => BackHandler.addEventListener("other" as "hardwareBackPress", () => true)).toThrow('only "hardwareBackPress"')

  host.ops.length = 0
  BackHandler.exitApp()
  expect(navOps()).toEqual([EXIT])
})

test("Appearance and useColorScheme", () => {
  installAppearance()
  send(AppEvent.ColorScheme, "light")
  const heard: string[] = []
  const sub = Appearance.addChangeListener(({ colorScheme }) => heard.push(colorScheme))
  expect(Appearance.getColorScheme()).toBe("light")
  send(AppEvent.ColorScheme, "dark")
  send(AppEvent.ColorScheme, "dark") // no change: no call
  expect(useColorScheme()).toBe("dark")
  sub.remove()
  send(AppEvent.ColorScheme, "light")
  expect(heard).toEqual(["dark"])
})

test("AsyncStorage: strings, null for missing, multi*, mergeItem; its own store", async () => {
  expect(await AsyncStorage.getItem("token")).toBeNull()
  await AsyncStorage.setItem("token", "abc")
  expect(await AsyncStorage.getItem("token")).toBe("abc")
  expect(host.kv.get("rn.async-storage")!.get("token")).toBe("abc")
  expect(host.kv.get("zn.default")?.has("token") ?? false).toBe(false)
  await expect(AsyncStorage.setItem("n", 3 as unknown as string)).rejects.toThrow("must be a string")
  await AsyncStorage.multiSet([["a", "1"], ["b", "2"]])
  expect(await AsyncStorage.multiGet(["a", "b", "c"])).toEqual([["a", "1"], ["b", "2"], ["c", null]])
  expect([...(await AsyncStorage.getAllKeys())].sort()).toEqual(["a", "b", "token"])
  await AsyncStorage.setItem("user", JSON.stringify({ name: "Ravi", prefs: { lang: "en", dark: false } }))
  await AsyncStorage.mergeItem("user", JSON.stringify({ prefs: { dark: true } }))
  expect(JSON.parse((await AsyncStorage.getItem("user"))!)).toEqual({ name: "Ravi", prefs: { lang: "en", dark: true } })
  await AsyncStorage.multiRemove(["a", "b"])
  await AsyncStorage.removeItem("token")
  expect([...(await AsyncStorage.getAllKeys())]).toEqual(["user"])
  await AsyncStorage.clear()
  expect([...(await AsyncStorage.getAllKeys())]).toEqual([])
})

test("setImmediate runs after the current work; clearImmediate stops it", () => {
  const ran: string[] = []
  const id = setImmediate((x: string) => ran.push(x), "a")
  const id2 = setImmediate(() => ran.push("b"))
  clearImmediate(id2)
  expect(ran).toEqual([])
  expect(activeTimerCount()).toBe(1)
  expect([...host.timers.values()]).toEqual([{ delay: 0, repeat: false }])
  host.fire(id)
  expect(ran).toEqual(["a"])
  expect(activeTimerCount()).toBe(0)
})
