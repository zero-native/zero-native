import { beforeEach, expect, test } from "bun:test"
import { installCalls, NativeError } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { Device } from "../src/index"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("a call names the module and the version the plugin needs", async () => {
  const p = Device.slowEcho({ text: "hi", ms: 10 })
  const [c] = host.calls
  expect(c).toMatchObject({ module: "Device", method: "slowEcho", args: { text: "hi", ms: 10, __v: 6 } })
  reply({ id: c.id, ok: true, value: "hi" })
  expect(await p).toBe("hi")
})

test("a refused argument arrives as invalid_args", async () => {
  const p = Device.storageHammer({ count: 1.5 })
  const [c] = host.calls
  reply({ id: c.id, ok: false, code: "invalid_args", error: 'Device.storageHammer: "count" must be an int, got 1.5' })
  const err = (await p.catch((e) => e)) as NativeError
  expect(err).toBeInstanceOf(NativeError)
  expect(err.code).toBe("invalid_args")
})
