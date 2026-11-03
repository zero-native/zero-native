import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { AppEvent, nav, onNavResult, resetNavForTests, startApp } from "../src/nav"
import { defineRoutes } from "../src/routes"
import { createStorage } from "../src/storage"
import { installTimers } from "../src/timers"
import { view } from "../src/view"

let host: FakeHost
const NATIVE_ROOT = 0x80000001
const PUSH = 1, REMOVE = 2, EXIT = 4

const Home = () => view(0, () => {})
const routes = defineRoutes({
  home: { path: "/", screen: Home },
  scan: { path: "/scan", native: "scanner.full" },
})

const send = (event: number, payload: string | number | null) => globalThis.__zn_onEvent(0, event, payload)
const later = () => Promise.resolve().then(() => {})
const navOps = () => host.ops.filter((o) => o[0] === "nav").map((o) => o.slice(1))
const pushed = () => navOps().filter((o) => o[0] === PUSH).at(-1)![1] as number

/** What native does when a screen answers: the record on disk first, then the event. */
function answer(entry: number, id: string, value: unknown, route = "scan") {
  const record = { key: `nav.${route}`, id, status: "result", resultCode: -1, data: null, extras: { value: JSON.stringify(value) } }
  createStorage("zn.launch").set(`launch.record.nav.${route}`, JSON.stringify(record))
  send(AppEvent.NavResult, JSON.stringify({ entry, route, id }))
}
const acks = () => host.calls.filter((c) => c.module === "Launches" && c.method === "ack").map((c) => c.args.id)

beforeEach(() => {
  resetNavForTests()
  host = installFakeHost()
  installEvents()
  installCalls()
  installTimers({ replaceGlobals: false })
  startApp(routes)
  send(AppEvent.Start, JSON.stringify([{ entry: NATIVE_ROOT, route: 0, params: {} }]))
  host.ops.length = 0
})

test("a native screen goes on the stack with its params, and renders nothing", () => {
  void nav.pushForResult("scan", { title: "Pay" })
  expect(navOps()).toEqual([[PUSH, pushed(), 1, '{"title":"Pay"}']])
  expect(host.ops.filter((o) => o[0] !== "nav")).toEqual([])
  expect(nav.current()?.name).toBe("scan")
  expect(nav.depth()).toBe(2)
})

test("pushForResult gets the answer, acks it, and the screen closes", async () => {
  const p = nav.pushForResult<{ code: string }>("scan")
  const entry = pushed()
  answer(entry, "a1", { code: "upi://pay" })
  expect(await p).toEqual({ code: "upi://pay" })
  expect(acks()).toEqual(["a1"])
  expect(navOps().at(-1)).toEqual([REMOVE, entry, 0, null])
  expect(nav.depth()).toBe(1)
})

test("Back gives null", async () => {
  const p = nav.pushForResult("scan")
  send(AppEvent.Back, null)
  expect(await p).toBeNull()
  expect(nav.depth()).toBe(1)
})

test("a Back press meant for a screen JS already closed is ignored: the scan goes on, the app doesn't exit", async () => {
  const p = nav.pushForResult<{ code: string }>("scan")
  const entry = pushed()
  answer(entry, "a1", { code: "upi://pay" }) // the answer closes the scanner in JS...
  expect(await p).toEqual({ code: "upi://pay" })
  host.ops.length = 0
  send(AppEvent.Back, entry) // ...while native, not yet told, sends Back for it
  expect(navOps()).toEqual([[5, 0, 0, null]]) // only "back answered": no screen removed, no exit
  expect(nav.depth()).toBe(1)
  send(AppEvent.Back, NATIVE_ROOT) // a Back for the screen on top still works
  expect(navOps().at(-1)?.[0]).toBe(EXIT) // the last screen: exit
})

test("a screen taken away by nav.back or nav.reset also gives null, so an await never hangs", async () => {
  const a = nav.pushForResult("scan")
  nav.back()
  expect(await a).toBeNull()
  const b = nav.pushForResult("scan")
  nav.reset([{ name: "home" }])
  expect(await b).toBeNull()
})

test("pushForResult refuses a screen that can't answer", () => {
  expect(() => nav.pushForResult("home")).toThrow('"home" is not a native screen')
})

test("an answer with nothing waiting goes to onNavResult, and stays until ack", async () => {
  const seen: unknown[] = []
  let ack = () => {}
  onNavResult<{ code: string }>("scan", (value, a) => {
    seen.push(value)
    ack = a
  })
  nav.push("scan")
  answer(pushed(), "a2", { code: "x" })
  expect(seen).toEqual([{ code: "x" }])
  expect(acks()).toEqual([])
  ack()
  expect(acks()).toEqual(["a2"])
})

test("onNavResult hears an answer saved before it subscribed: the app was killed", async () => {
  const record = { key: "nav.scan", id: "a3", status: "result", resultCode: -1, data: null, extras: { value: '{"code":"y"}' } }
  createStorage("zn.launch").set("launch.record.nav.scan", JSON.stringify(record))
  const seen: unknown[] = []
  onNavResult("scan", (value) => seen.push(value))
  await later()
  expect(seen).toEqual([{ code: "y" }])
})

test("with a promise waiting, onNavResult doesn't hear it: one answer, one handler", async () => {
  const seen: unknown[] = []
  onNavResult("scan", (value) => seen.push(value))
  const p = nav.pushForResult("scan")
  answer(pushed(), "a4", 1)
  await p
  await later()
  expect(seen).toEqual([])
})

test("a repeat of the same answer reaches a listener once", () => {
  const seen: unknown[] = []
  onNavResult("scan", (value) => seen.push(value))
  nav.push("scan")
  const entry = pushed()
  answer(entry, "a5", 1)
  answer(entry, "a5", 1)
  expect(seen).toEqual([1])
})

test("an answer with no saved record gives null to the promise, and closes the screen", async () => {
  const p = nav.pushForResult("scan")
  send(AppEvent.NavResult, JSON.stringify({ entry: pushed(), route: "scan", id: "nope" }))
  expect(await p).toBeNull()
  expect(nav.depth()).toBe(1)
})

test("a native screen restored at start has nothing to build", () => {
  resetNavForTests()
  host = installFakeHost()
  installEvents()
  installCalls()
  startApp(routes)
  send(AppEvent.Start, JSON.stringify([
    { entry: NATIVE_ROOT, route: 0, params: {} },
    { entry: NATIVE_ROOT + 1, route: 1, params: {} },
  ]))
  expect(nav.current()?.name).toBe("scan")
  expect(nav.depth()).toBe(2)
})

test("an answer on the last screen leaves the app, as Back does", () => {
  nav.reset([{ name: "scan" }])
  const entry = pushed()
  answer(entry, "a6", 1)
  expect(navOps().at(-1)).toEqual([EXIT, 0, 0, null])
})
