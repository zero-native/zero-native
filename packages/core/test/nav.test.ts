import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { insets } from "../src/insets"
import { AppEvent, nav, resetNavForTests, startApp, useBack, useImpressions } from "../src/nav"
import { defineRoutes } from "../src/routes"
import { signal } from "../src/signals"
import { activeTimerCount, installTimers, setInterval, setTimeout } from "../src/timers"
import { on, slot, view } from "../src/view"

let host: FakeHost
const NATIVE_ROOT = 0x80000001
const PUSH = 1, REMOVE = 2, CLEAR = 3, EXIT = 4, ANSWERED = 5, STARTED = 8

// Screens as the compiler would emit them: template id + setup binding slots / events.
let backHandled = false
const Home = () => view(0, (i) => slot(i, 0, () => "home"))
const Amount = (p: { merchantId: string }) => {
  useBack(() => backHandled)
  setInterval(() => {}, 500) // like the blinking cursor: must stop when the screen closes
  return view(1, (i) => {
    slot(i, 0, () => p.merchantId)
    on(i, 1, () => void setTimeout(() => {}, 10_000)) // a tap starting a timer: owned by the screen too
  })
}
const Receipt = (p: { ztc: string }) => view(2, (i) => slot(i, 0, () => p.ztc))
const routes = defineRoutes({
  home: { path: "/", screen: Home },
  amount: { path: "/pay/:merchantId", screen: Amount },
  receipt: { path: "/receipt/:ztc", screen: Receipt },
})

const send = (event: number, payload: string | number | null) => globalThis.__zn_onEvent(0, event, payload)
const navOps = () => host.ops.filter((o) => o[0] === "nav")
// JS answers every START with NAV STARTED once the screens are built (step 4.7). The first test checks it; this
// helper drops it so the other tests see only their own ops.
const start = (stack = [{ entry: NATIVE_ROOT, route: 0, params: {} }]) => {
  send(AppEvent.Start, JSON.stringify(stack))
  const last = host.ops.at(-1)
  if (last?.[0] === "nav" && last[1] === STARTED) host.ops.pop()
}

beforeEach(() => {
  resetNavForTests()
  host = installFakeHost()
  installEvents()
  installTimers({ replaceGlobals: false })
  backHandled = false
  startApp(routes)
})

test("start renders native-created entries, then sends only NAV STARTED", () => {
  send(AppEvent.Start, JSON.stringify([
    { entry: NATIVE_ROOT, route: 0, params: {} },
    { entry: NATIVE_ROOT + 1, route: 1, params: { merchantId: "m2" } },
  ]))
  expect(host.ops).toEqual([
    ["patch", NATIVE_ROOT, 0, "home"],
    ["patch", NATIVE_ROOT + 1, 0, "m2"],
    ["nav", STARTED, 0, 0, null], // after the screens: native counts them as up from here
  ])
  expect(nav.current()).toEqual({ name: "amount", params: { merchantId: "m2" } })
  send(AppEvent.Start, JSON.stringify([{ entry: NATIVE_ROOT, route: 0, params: {} }])) // a second start is ignored
  expect(nav.depth()).toBe(2)
  expect(navOps()).toEqual([["nav", STARTED, 0, 0, null]]) // no second STARTED
})

test("push sends NAV before the new screen's patches, in the same tick", () => {
  start()
  host.ops.length = 0
  nav.push("amount", { merchantId: "m1" })
  const [navOp, patch] = host.ops
  expect(navOp.slice(0, 2)).toEqual(["nav", PUSH])
  const id = navOp[2] as number
  expect(id).toBeLessThan(0x80000000) // JS-allocated
  expect(navOp.slice(3)).toEqual([1, JSON.stringify({ merchantId: "m1" })])
  expect(patch).toEqual(["patch", id, 0, "m1"])
})

test("back removes the top screen and stops its timers; the last screen stays", () => {
  start()
  const before = activeTimerCount()
  nav.push("amount", { merchantId: "m1" })
  const id = navOps()[0][2] as number
  globalThis.__zn_onEvent(id, 1, null) // tap → starts a 10 s timer
  expect(activeTimerCount()).toBe(before + 2)
  expect(nav.back()).toBe(true)
  expect(navOps().at(-1)).toEqual(["nav", REMOVE, id, 0, null])
  expect(activeTimerCount()).toBe(before)
  expect(nav.back()).toBe(false)
  expect(nav.depth()).toBe(1)
})

test("system back: useBack can keep the screen; JS always answers", () => {
  start()
  nav.push("amount", { merchantId: "m1" })
  host.ops.length = 0
  backHandled = true
  send(AppEvent.Back, null)
  expect(navOps()).toEqual([["nav", ANSWERED, 0, 0, null]])
  expect(nav.depth()).toBe(2)

  host.ops.length = 0
  backHandled = false
  send(AppEvent.Back, null)
  expect(navOps().map((o) => o[1])).toEqual([ANSWERED, REMOVE])
  expect(nav.depth()).toBe(1)

  host.ops.length = 0
  send(AppEvent.Back, null) // last screen: let the system handle it
  expect(navOps().map((o) => o[1])).toEqual([ANSWERED, EXIT])
})

test("reset clears natively and pushes the new stack bottom first", () => {
  start()
  nav.push("amount", { merchantId: "m1" })
  host.ops.length = 0
  nav.reset([{ name: "home" }, { name: "receipt", params: { ztc: "Z1" } }])
  expect(navOps().map((o) => [o[1], o[3]])).toEqual([[CLEAR, 0], [PUSH, 0], [PUSH, 2]])
  expect(nav.current()).toEqual({ name: "receipt", params: { ztc: "Z1" } })
  expect(nav.depth()).toBe(2)
})

test("replace removes the top and pushes, so there's no way back to it", () => {
  start()
  nav.push("amount", { merchantId: "m1" })
  const amountId = navOps()[0][2]
  host.ops.length = 0
  nav.replace("receipt", { ztc: "Z9" })
  expect(navOps().map((o) => [o[1], o[1] === REMOVE ? o[2] : o[3]])).toEqual([[REMOVE, amountId], [PUSH, 2]])
  expect(nav.depth()).toBe(2)
})

test("forced back (native timed out) forgets the entry without a NAV op", () => {
  start()
  nav.push("amount", { merchantId: "m1" })
  const id = navOps()[0][2] as number
  host.ops.length = 0
  send(AppEvent.ForcedBack, id)
  expect(navOps()).toEqual([])
  expect(nav.depth()).toBe(1)
})

test("a closed screen sends nothing more", () => {
  start()
  const label = signal("a")
  const Live = () => view(1, (i) => slot(i, 0, () => label()))
  resetNavForTests()
  startApp(defineRoutes({ home: { path: "/", screen: Home }, live: { path: "/live", screen: Live } }))
  start()
  nav.push("live")
  nav.back()
  host.ops.length = 0
  label.set("b")
  expect(host.ops).toEqual([])
})

test("a deep link while the app runs pushes its route", () => {
  start()
  host.ops.length = 0
  send(AppEvent.Open, JSON.stringify({ route: 1, params: { merchantId: "m4" } }))
  expect(navOps()[0].slice(0, 2)).toEqual(["nav", PUSH])
  expect(nav.current()).toEqual({ name: "amount", params: { merchantId: "m4" } })
})

test("insets() follows native's INSETS event; equal values send nothing", () => {
  const Full = () => view(1, (i) => slot(i, 0, () => insets().top + 16))
  resetNavForTests()
  startApp(defineRoutes({ home: { path: "/", screen: Full } }))
  start()
  expect(host.ops).toEqual([["patch", NATIVE_ROOT, 0, 16]])
  send(5, JSON.stringify({ top: 24, bottom: 48, start: 0, end: 0 }))
  expect(host.ops.at(-1)).toEqual(["patch", NATIVE_ROOT, 0, 40])
  host.ops.length = 0
  send(5, JSON.stringify({ top: 24, bottom: 48, start: 0, end: 0 }))
  expect(host.ops).toEqual([])
  expect(insets()).toEqual({ top: 24, bottom: 48, start: 0, end: 0 })
})

test("useImpressions sends the screen's settings; native batches reach its handler (once per session if asked)", () => {
  const got: string[][] = []
  const Feed = () => {
    useImpressions((keys) => got.push(keys), { threshold: 0.5, once: "session" })
    return view(1, () => {})
  }
  resetNavForTests()
  startApp(defineRoutes({ home: { path: "/", screen: Home }, feed: { path: "/feed", screen: Feed } }))
  start()
  host.ops.length = 0
  nav.push("feed")
  const entry = navOps()[0][2] as number
  expect(navOps()[1]).toEqual(["nav", 6, entry, 0, JSON.stringify({ threshold: 0.5, minMs: 0 })])
  send(AppEvent.Impressions, JSON.stringify({ entry, keys: ["a", "b"] }))
  send(AppEvent.Impressions, JSON.stringify({ entry, keys: ["b", "c"] })) // "b" already seen this session
  expect(got).toEqual([["a", "b"], ["c"]])
  expect(() => useImpressions(() => {}, { threshold: 2 })).toThrow(/while a screen renders/)
})

test("unknown routes and useBack outside a screen are errors", () => {
  start()
  expect(() => (nav.push as any)("nope")).toThrow(/unknown route "nope"/)
  expect(() => useBack(() => true)).toThrow(/while a screen renders/)
})

// ---- A screen that throws while being built (step 3.9) ------------------------------------------------------------

const FAILED = 7
let brokenOnce = false
const Broken = () => {
  useBack(() => true) // set up before the throw: must not survive the failed build
  setInterval(() => {}, 500) // started before the throw: must be stopped
  if (brokenOnce) throw new Error("no merchant data")
  return view(3, (i) => slot(i, 0, () => "fixed"))
}
const brokenRoutes = defineRoutes({ home: { path: "/", screen: Home }, broken: { path: "/broken", screen: Broken } })

test("a screen that throws stays on the stack, native shows its error screen, Back works", () => {
  resetNavForTests()
  startApp(brokenRoutes)
  start()
  const timers = activeTimerCount()
  brokenOnce = true
  nav.push("broken")
  const id = navOps()[0][2] as number
  expect(navOps().map((o) => o[1])).toEqual([PUSH, FAILED]) // both in the same tick: no broken frame
  expect(navOps()[1]).toEqual(["nav", FAILED, id, 0, JSON.stringify({ message: "no merchant data" })])
  expect(host.logs.some(([level, m]) => level === 3 && m.includes('screen "broken" threw') && m.includes("no merchant data"))).toBe(true)
  expect(activeTimerCount()).toBe(timers) // what it started is stopped
  expect(nav.depth()).toBe(2)
  // Back from the error screen: its useBack (from the failed build) doesn't block it.
  send(AppEvent.Back, id)
  expect(navOps().at(-1)).toEqual(["nav", REMOVE, id, 0, null])
  expect(nav.depth()).toBe(1)
})

test("Try again builds the failed screen again on the fresh root native made", () => {
  resetNavForTests()
  startApp(brokenRoutes)
  start()
  brokenOnce = true
  nav.push("broken")
  const id = navOps()[0][2] as number
  brokenOnce = false // the cause went away (data arrived, network back)
  host.ops.length = 0
  send(AppEvent.Retry, id)
  expect(host.ops).toEqual([["patch", id, 0, "fixed"]])
  // Native also sends RETRY for a screen that hung (JS didn't mark it failed): the old build is stopped first.
  send(AppEvent.Retry, id)
  expect(host.ops).toEqual([["patch", id, 0, "fixed"], ["patch", id, 0, "fixed"]])
})

test("a failed start screen shows the error screen too", () => {
  resetNavForTests()
  startApp(defineRoutes({ home: { path: "/", screen: Broken } }))
  brokenOnce = true
  start()
  expect(navOps()).toEqual([["nav", FAILED, NATIVE_ROOT, 0, JSON.stringify({ message: "no merchant data" })]])
  expect(nav.depth()).toBe(1)
})
