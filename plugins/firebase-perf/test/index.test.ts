import { beforeEach, expect, spyOn, test } from "bun:test"
import { installCalls } from "../../../packages/core/src/calls"
import { installEvents } from "../../../packages/core/src/events"
import { installFakeHost, type FakeHost } from "../../../packages/core/test/fake-host"
import { Perf, perf } from "../src/index"

let host: FakeHost

const reply = (id: number, value: unknown) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: true, value }))
const refuse = (id: number, code: string) => globalThis.__zn_onEvent(0, 7, JSON.stringify({ id, ok: false, code, error: code }))
const last = (method: string) => host.calls.filter((c) => c.method === method).at(-1)!
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  host.calls.length = 0
})

test("a trace's calls carry its id; stop sends it", async () => {
  const p = perf().startTrace("checkout_load")
  const start = last("startTrace")
  expect(start.args).toMatchObject({ name: "checkout_load" })
  const id = (start.args as { id: string }).id
  reply(start.id, "")
  const t = await p
  void t.putAttribute("method", "upi")
  expect(last("putAttribute").args).toMatchObject({ id, name: "method", value: "upi" })
  void t.incrementMetric("retries")
  expect(last("incrementMetric").args).toMatchObject({ id, name: "retries", by: 1 })
  const s = t.stop()
  expect(last("stopTrace").args).toMatchObject({ id })
  reply(last("stopTrace").id, "")
  expect(await s).toBe(true)
})

test("a bad name warns; a missing plugin answers false; nothing rejects", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const p = Perf.startTrace("_reserved")
  reply(last("startTrace").id, '"_reserved" starts with _ (Firebase keeps those)')
  const t = await p
  expect(warn.mock.calls[0]?.[0]).toContain("_reserved")
  warn.mockRestore()
  const m = t.putMetric("x", 1)
  refuse(last("putMetric").id, "unavailable")
  expect(await m).toBe(false)
  const st = Perf.status()
  refuse(last("status").id, "unavailable")
  expect(await st).toEqual({ available: false, enabled: false })
})

test("trace() stops the trace also when the work throws", async () => {
  const run = Perf.trace("receipt_render", () => {
    throw new Error("boom")
  })
  reply(last("startTrace").id, "")
  await expect(run).rejects.toThrow("boom")
  await tick()
  expect(host.calls.some((c) => c.method === "stopTrace")).toBe(true)
})
