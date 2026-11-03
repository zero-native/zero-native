import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { Clipboard } from "../src/clipboard"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))
// Lets the answer's Promise callbacks run (microtasks only: other test files replace setTimeout).
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

// Answers what a test left open: pending calls are shared by every test file (calls.test.ts counts them).
afterEach(() => {
  for (const c of host.calls) if (c.id !== 0) reply({ id: c.id, ok: true, value: null })
})

test("setString sends the text and returns at once; a failure is only logged", async () => {
  expect(Clipboard.setString("zerobill@upi")).toBeUndefined()
  const c = host.calls[0]
  expect(c).toMatchObject({ module: "Clipboard", method: "setString", args: { text: "zerobill@upi", __v: 1 } })
  reply({ id: c.id, ok: false, code: "failed", error: "Clipboard.setString failed: x" })
  await tick()
  expect(host.logs.some(([level, msg]) => level === 2 && msg.includes("Clipboard.setString failed"))).toBe(true)
})

test("setString takes only a string", () => {
  expect(() => (Clipboard.setString as any)(42)).toThrow(TypeError)
  expect(host.calls).toHaveLength(0)
})

test("getString and hasString answer what native says", async () => {
  const text = Clipboard.getString()
  const has = Clipboard.hasString()
  const [g, h] = host.calls
  expect([g.method, h.method]).toEqual(["getString", "hasString"])
  expect(g.args).toEqual({ __v: 1 })
  reply({ id: g.id, ok: true, value: "123456" })
  reply({ id: h.id, ok: true, value: false })
  expect(await text).toBe("123456")
  expect(await has).toBe(false)
})
