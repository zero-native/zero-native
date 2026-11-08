import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls, NativeError } from "../src/calls"
import { installEvents } from "../src/events"
import { Os } from "../src/os"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("each call names the Os module and its args", async () => {
  const p = Os.haptic("success")
  const [c] = host.calls
  expect(c).toMatchObject({ module: "Os", method: "haptic", args: { kind: "success", __v: 2 } })
  reply({ id: c.id, ok: true, value: true })
  expect(await p).toBe(true)
})

test("a refused link comes back as not_allowed", async () => {
  const p = Os.openUrl("upi://pay?pa=x")
  const c = host.calls.at(-1)!
  expect(c.args.url).toBe("upi://pay?pa=x")
  reply({ id: c.id, ok: false, code: "not_allowed", error: "openUrl can't open intent:, file: or javascript: links, or a link with no scheme" })
  expect(((await p.catch((e) => e)) as NativeError).code).toBe("not_allowed")
})
