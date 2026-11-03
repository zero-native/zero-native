import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { NetInfo, useNetInfo, type NetInfoState } from "../src/netinfo"
import { createRoot, effect } from "../src/signals"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const change = (payload: unknown) =>
  globalThis.__zn_onEvent(0, 8, JSON.stringify({ module: "NetInfo", event: "change", payload }))
// Lets the answer's Promise callbacks run (microtasks only: other test files replace setTimeout).
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const WIFI: NetInfoState = { type: "wifi", isConnected: true, isInternetReachable: true, details: { isConnectionExpensive: false } }
const CELL: NetInfoState = { type: "cellular", isConnected: true, isInternetReachable: false, details: { isConnectionExpensive: true } }
const NONE: NetInfoState = { type: "none", isConnected: false, isInternetReachable: false, details: null }

const fetches = () => host.calls.filter((c) => c.module === "NetInfo" && c.method === "fetch")
const listenerCounts = () => host.calls.filter((c) => c.method === "__listeners").map((c) => c.args.count)

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

// Answers what a test left open: pending calls are shared by every test file (calls.test.ts counts them).
afterEach(() => {
  for (const c of host.calls) if (c.id !== 0) reply({ id: c.id, ok: true, value: null })
})

test("fetch and refresh read the state now", async () => {
  const a = NetInfo.fetch()
  const b = NetInfo.refresh()
  const [fa, fb] = fetches()
  expect(fa.args).toEqual({ __v: 1 })
  reply({ id: fa.id, ok: true, value: WIFI })
  reply({ id: fb.id, ok: true, value: NONE })
  expect(await a).toEqual(WIFI)
  expect(await b).toEqual(NONE)
})

test("a listener hears the state now, then each change, without repeats; stop ends it", async () => {
  const got: NetInfoState[] = []
  const stop = NetInfo.addEventListener((s) => got.push(s))
  expect(listenerCounts()).toEqual([1])
  reply({ id: fetches()[0].id, ok: true, value: WIFI })
  await tick()
  expect(got).toEqual([WIFI])
  change(WIFI) // the same state again: not heard
  change(CELL)
  change(NONE)
  expect(got).toEqual([WIFI, CELL, NONE])
  stop()
  expect(listenerCounts()).toEqual([1, 0])
  change(WIFI)
  expect(got).toHaveLength(3)
})

test("a change that comes before the fetch answer wins over it", async () => {
  const got: NetInfoState[] = []
  const stop = NetInfo.addEventListener((s) => got.push(s))
  change(CELL)
  reply({ id: fetches()[0].id, ok: true, value: WIFI }) // older than the change
  await tick()
  expect(got).toEqual([CELL])
  stop()
})

test("stopped before the fetch answer: nothing is heard", async () => {
  const got: NetInfoState[] = []
  NetInfo.addEventListener((s) => got.push(s))()
  reply({ id: fetches()[0].id, ok: true, value: WIFI })
  await tick()
  expect(got).toEqual([])
})

test("a screen's listener stops when the screen closes", () => {
  const got: NetInfoState[] = []
  const dispose = createRoot((d) => {
    NetInfo.addEventListener((s) => got.push(s))
    return d
  })
  change(CELL)
  dispose()
  change(NONE)
  expect(got).toEqual([CELL])
  expect(listenerCounts()).toEqual([1, 0])
})

test("a throwing listener is reported; the others still hear", () => {
  const got: NetInfoState[] = []
  const a = NetInfo.addEventListener(() => {
    throw new Error("boom")
  })
  const b = NetInfo.addEventListener((s) => got.push(s))
  change(CELL)
  expect(got).toEqual([CELL])
  expect(host.logs.some(([level, msg]) => level === 3 && msg.includes("NetInfo listener") && msg.includes("boom"))).toBe(true)
  a()
  b()
})

test("useNetInfo starts unknown, then follows native while the screen lives", async () => {
  const seen: Array<boolean | null> = []
  let net!: NetInfoState
  const dispose = createRoot((d) => {
    net = useNetInfo()
    effect(() => {
      seen.push(net.isConnected)
    })
    return d
  })
  expect([net.type, net.isConnected, net.isInternetReachable, net.details]).toEqual(["unknown", null, null, null])
  reply({ id: fetches()[0].id, ok: true, value: WIFI })
  await tick()
  expect(net.type).toBe("wifi")
  expect(net.details).toEqual({ isConnectionExpensive: false })
  change(NONE)
  expect(net.type).toBe("none")
  expect(seen).toEqual([null, true, false])
  dispose()
  change(WIFI)
  expect(net.type).toBe("none")
  expect(listenerCounts()).toEqual([1, 0])
})

test("useNetInfo outside a screen logs a warning", () => {
  useNetInfo()
  expect(host.logs.some(([level, msg]) => level === 2 && msg.includes("useNetInfo() outside a screen"))).toBe(true)
  // Its listener stays (it has no stop function): keep this test last in the file.
})
