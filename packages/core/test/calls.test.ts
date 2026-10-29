import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { callNative, installCalls, pendingCallCount } from "../src/calls"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("a call resolves with native's value", async () => {
  const p = callNative<{ package: string }[]>("os", "upiApps")
  const [c] = host.calls
  expect(c).toMatchObject({ module: "os", method: "upiApps", args: {} })
  reply({ id: c.id, ok: true, value: [{ package: "com.phonepe.app" }] })
  expect(await p).toEqual([{ package: "com.phonepe.app" }])
  expect(pendingCallCount()).toBe(0)
})

test("an error rejects; unknown or repeated replies are ignored", async () => {
  const p = callNative("nope", "x", { a: 1 })
  const [c] = host.calls
  expect(c.args).toEqual({ a: 1 })
  reply({ id: c.id, ok: false, error: 'no native module "nope"' })
  await expect(p).rejects.toThrow(/no native module/)
  reply({ id: c.id, ok: true, value: 1 }) // a second reply for the same id: nothing happens
  reply({ id: 9999, ok: true })
  expect(pendingCallCount()).toBe(0)
})
