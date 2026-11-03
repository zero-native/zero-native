import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { AppEvent, nav, resetNavForTests, startApp, useBack, useFocus } from "../src/nav"
import { defineRoutes } from "../src/routes"
import { signal } from "../src/signals"
import { useTabs, type TabsHandle } from "../src/tabs"
import { installTimers } from "../src/timers"
import { slot, view, when } from "../src/view"

let host: FakeHost
const ROOT = 0x80000001
const REMOVE = 2, EXIT = 4, ANSWERED = 5, RESTORE = 9, BACK_WANTED = 10

// A screen with three tabs, as the compiler would emit it: <Tabs selected={tabs.index()}> with one panel per tab,
// each `{tabs.seen(name) && <Tab/>}`. Each tab logs when it is built.
let tabs: TabsHandle<"pay" | "stores" | "offers">
let built: string[] = []
let log: string[] = []
let sheetOpen = signal(false)
let preload = false
const Tab = (name: "pay" | "stores" | "offers") => () => {
  built.push(name)
  if (name === "stores") useBack(() => {
    if (!sheetOpen()) return false
    sheetOpen.set(false)
    return true
  })
  tabs.onFocus(name, () => {
    log.push(`focus ${name}`)
    return () => log.push(`blur ${name}`)
  })
  return view(10, (i) => slot(i, 0, () => name))
}
const Home = (_p: { tab?: string }) => {
  tabs = useTabs("home", { preload })
  useFocus(() => {
    log.push("focus home")
    return () => log.push("blur home")
  })
  return view(0, (i) => {
    slot(i, 0, () => tabs.index())
    when(i, 1, () => tabs.seen("pay"), Tab("pay"))
    when(i, 2, () => tabs.seen("stores"), Tab("stores"))
    when(i, 3, () => tabs.seen("offers"), Tab("offers"))
  })
}
const Amount = (p: { merchantId: string }) => view(1, (i) => slot(i, 0, () => p.merchantId))
const routes = defineRoutes({
  home: { path: "/", screen: Home, tabs: ["pay", "stores", "offers"], deepLink: true },
  amount: { path: "/pay/:merchantId", screen: Amount, deepLink: true },
})

const send = (event: number, payload: string | number | null) => globalThis.__zn_onEvent(0, event, payload)
const navOps = () => host.ops.filter((o) => o[0] === "nav")
const kinds = () => navOps().map((o) => o[1])
const start = (stack: unknown[] = [{ entry: ROOT, route: 0, params: {} }]) => send(AppEvent.Start, JSON.stringify(stack))

beforeEach(() => {
  resetNavForTests()
  host = installFakeHost()
  installEvents()
  installTimers({ replaceGlobals: false })
  built = []
  log = []
  sheetOpen = signal(false)
  preload = false
  startApp(routes)
})

test("lazy: only the first tab is built; a tab is built when first shown and kept after", () => {
  start()
  expect(built).toEqual(["pay"])
  expect(tabs.selected()).toBe("pay")
  host.ops.length = 0
  tabs.select("stores")
  expect(built).toEqual(["pay", "stores"])
  // The new tab's mount and the new index reach native in the same tick.
  expect(host.ops.some((o) => o[0] === "mount")).toBe(true)
  expect(host.ops).toContainEqual(["patch", ROOT, 0, 1])
  tabs.select("pay")
  tabs.select("stores")
  expect(built).toEqual(["pay", "stores"]) // not built again: its state is kept
  expect(host.ops.filter((o) => o[0] === "remove")).toEqual([])
  expect(tabs.seen("offers")).toBe(false)
})

test("preload builds every tab at once", () => {
  preload = true
  start()
  expect(built).toEqual(["pay", "stores", "offers"])
  expect(tabs.selected()).toBe("pay")
})

test("the selected tab is kept as a restorable value and comes back after a kill; only it is built", () => {
  start()
  tabs.select("offers")
  expect(navOps()).toContainEqual(["nav", RESTORE, ROOT, 0, `{"key":"zn.tab","value":"offers"}`])

  resetNavForTests()
  host = installFakeHost()
  built = []
  startApp(routes)
  start([{ entry: ROOT, route: 0, params: {}, values: { "zn.tab": "offers" } }])
  expect(tabs.selected()).toBe("offers")
  expect(built).toEqual(["offers"])
})

test("a saved tab an update removed falls back to the first tab", () => {
  start([{ entry: ROOT, route: 0, params: {}, values: { "zn.tab": "gone" } }])
  expect(tabs.selected()).toBe("pay")
})

test("Back on a later tab goes to the first tab; native asks JS on the only screen only while that is so", () => {
  start()
  expect(kinds()).not.toContain(BACK_WANTED) // the first tab: native's default, nothing sent
  tabs.select("offers")
  expect(navOps()).toContainEqual(["nav", BACK_WANTED, ROOT, 1, null])
  host.ops.length = 0
  send(AppEvent.Back, ROOT)
  expect(tabs.selected()).toBe("pay")
  expect(kinds()).toEqual([ANSWERED, RESTORE, BACK_WANTED])
  expect(navOps().at(-1)).toEqual(["nav", BACK_WANTED, ROOT, 0, null])
  host.ops.length = 0
  send(AppEvent.Back, ROOT) // first tab, only screen: the system takes it
  expect(kinds()).toEqual([ANSWERED, EXIT])
})

test("a tab's own useBack is asked before the tabs' one, and stops with the screen", () => {
  start()
  tabs.select("stores")
  sheetOpen.set(true)
  send(AppEvent.Back, ROOT)
  expect(sheetOpen()).toBe(false) // the tab closed its sheet
  expect(tabs.selected()).toBe("stores")
  send(AppEvent.Back, ROOT)
  expect(tabs.selected()).toBe("pay")
})

test("useFocus and tabs.onFocus follow the top screen and the selected tab", () => {
  start()
  expect(log).toEqual(["focus home", "focus pay"])
  log = []
  tabs.select("stores")
  expect(log).toEqual(["blur pay", "focus stores"])
  log = []
  nav.push("amount", { merchantId: "m1" }) // the FAB opens a screen on top
  expect(log.sort()).toEqual(["blur home", "blur stores"])
  log = []
  nav.back() // back from it: the screen and its tab get focus again (refresh the balance here)
  expect(log.sort()).toEqual(["focus home", "focus stores"])
  log = []
  nav.reset([{ name: "amount", params: { merchantId: "m2" } }]) // the screen closes: its focus cleanups run
  expect(log.sort()).toEqual(["blur home", "blur stores"])
})

test("a cold link to a tab of the start screen opens that tab (its params reach the screen)", () => {
  start([{ entry: ROOT, route: 0, params: { tab: "offers" }, link: "zn://sample/offers" }])
  expect(tabs.selected()).toBe("offers")
  expect(built).toEqual(["offers"])
})

test("a cold link to the start screen that onLink refuses still opens the start screen, without the link's params", () => {
  resetNavForTests()
  startApp(routes, { onLink: () => false })
  start([{ entry: ROOT, route: 0, params: { tab: "offers" }, link: "zn://sample/offers" }])
  expect(nav.depth()).toBe(1)
  expect(tabs.selected()).toBe("pay")
  expect(kinds()).not.toContain(REMOVE)
})

test("a link to a tab while screens are above goes back to the tab screen and selects the tab", () => {
  start()
  nav.push("amount", { merchantId: "m1" })
  nav.push("amount", { merchantId: "m2" })
  host.ops.length = 0
  send(AppEvent.Open, JSON.stringify({ route: 0, params: { tab: "stores" }, url: "zn://sample/stores" }))
  expect(nav.depth()).toBe(1)
  expect(kinds().filter((k) => k === REMOVE).length).toBe(2)
  expect(tabs.selected()).toBe("stores")
  expect(log).toContain("focus stores")
})

test("onLink can refuse a tab link (a payment in flight): nothing closes", () => {
  resetNavForTests()
  startApp(routes, { onLink: (l) => l.route !== "home" })
  start()
  nav.push("amount", { merchantId: "m1" })
  send(AppEvent.Open, JSON.stringify({ route: 0, params: { tab: "stores" }, url: "zn://sample/stores" }))
  expect(nav.depth()).toBe(2)
  expect(tabs.selected()).toBe("pay")
})

test("errors: useTabs outside a screen, on the wrong screen, on a route without tabs, unknown tab names", () => {
  expect(() => useTabs("home")).toThrow("useTabs must be called in a screen's body")
  start()
  expect(() => tabs.select("nope" as never)).toThrow('"nope" is not a tab of "home"')
  expect(() => tabs.seen("nope" as never)).toThrow('"nope" is not a tab of "home"')
  const Bad = () => {
    useTabs("home")
    return view(1, () => {})
  }
  const NoTabs = () => {
    useTabs("other" as never)
    return view(1, () => {})
  }
  for (const [screen, message] of [
    [Bad, 'useTabs(\\"home\\") is called in screen \\"bad\\"'],
    [NoTabs, 'useTabs: route \\"other\\" has no tabs'],
  ] as const) {
    resetNavForTests()
    host = installFakeHost()
    startApp(defineRoutes({ home: { path: "/", screen: Home, tabs: ["pay", "stores", "offers"] }, bad: { path: "/bad", screen: Bad }, other: { path: "/o", screen: NoTabs } }))
    start([{ entry: ROOT, route: 0, params: {} }, { entry: ROOT + 1, route: screen === Bad ? 1 : 2, params: {} }])
    // A screen that throws shows native's error screen (NAV FAILED) with the message.
    expect(navOps().find((o) => o[1] === 7)?.[4]).toContain(message)
  }
})
