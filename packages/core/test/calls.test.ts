import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { callNative, installCalls, nativeModule, NativeError, pendingCallCount, resetCallsForTests, type CallOptions } from "../src/calls"
import { createRoot } from "../src/signals"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
const emit = (module: string, event: string, payload: unknown) =>
  globalThis.__zn_onEvent(0, 8, JSON.stringify({ module, event, payload }))

interface DeviceModule {
  info(): Promise<{ model: string }>
  slowEcho(args: { text: string; ms: number }, options?: CallOptions): Promise<string>
  events: { tick: number }
}
const Device = nativeModule<DeviceModule>("Device", { version: 2 })

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  resetCallsForTests()  // the counts below are this file's: motion.test.ts leaves Motion calls nobody answered
})

test("a typed module call resolves; the version it needs travels with the args", async () => {
  const p = Device.info()
  const [c] = host.calls
  expect(c).toMatchObject({ module: "Device", method: "info", args: { __v: 2 } })
  reply({ id: c.id, ok: true, value: { model: "LXX503" } })
  expect(await p).toEqual({ model: "LXX503" })
  expect(pendingCallCount()).toBe(0)
})

test("errors carry a code; late or unknown replies are ignored", async () => {
  const p = callNative("nope", "x", { a: 1 })
  const [c] = host.calls
  reply({ id: c.id, ok: false, code: "unavailable", error: 'no native module "nope"' })
  const err = (await p.catch((e) => e)) as NativeError
  expect(err).toBeInstanceOf(NativeError)
  expect([err.code, err.module, err.method]).toEqual(["unavailable", "nope", "x"])
  reply({ id: c.id, ok: true, value: 1 })
  reply({ id: 9999, ok: true })
  expect(pendingCallCount()).toBe(0)
})

test("abort rejects at once with 'cancelled' and tells native", async () => {
  const ac = new AbortController()
  const p = Device.slowEcho({ text: "hi", ms: 5000 }, { signal: ac.signal })
  const [c] = host.calls
  ac.abort()
  expect(((await p.catch((e) => e)) as NativeError).code).toBe("cancelled")
  expect(host.cancelled).toEqual([c.id])
  reply({ id: c.id, ok: true, value: "hi" }) // native's late reply: dropped
  expect(pendingCallCount()).toBe(0)
  // Already aborted: never sent.
  const before = host.calls.length
  expect(((await Device.info(undefined as never, { signal: ac.signal } as never).catch((e: unknown) => e)) as NativeError).code)
    .toBe("cancelled")
  expect(host.calls.length).toBe(before)
})

test("a screen's calls are dropped quietly when it closes", () => {
  let settled = false
  const dispose = createRoot((d) => {
    Device.info().then(() => (settled = true), () => (settled = true))
    return d
  })
  const [c] = host.calls
  dispose()
  expect(host.cancelled).toEqual([c.id])
  expect(pendingCallCount()).toBe(0)
  reply({ id: c.id, ok: true, value: {} })
  expect(settled).toBe(false)
})

test("events reach listeners; native hears the listener count; a screen's listeners end with it", () => {
  const got: number[] = []
  const off = Device.on("tick", (n) => got.push(n))
  const dispose = createRoot((d) => {
    Device.on("tick", (n) => got.push(n * 100))
    return d
  })
  const counts = host.calls.filter((c) => c.method === "__listeners").map((c) => [c.args, c.id])
  expect(counts).toEqual([[{ event: "tick", count: 1 }, 0], [{ event: "tick", count: 2 }, 0]])
  emit("Device", "tick", 1)
  dispose()
  emit("Device", "tick", 2)
  off()
  emit("Device", "tick", 3)
  expect(got).toEqual([1, 100, 2])
  expect(host.calls.filter((c) => c.method === "__listeners").map((c) => (c.args as any).count)).toEqual([1, 2, 1, 0])
})
