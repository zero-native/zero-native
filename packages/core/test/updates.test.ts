import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { AppEvent } from "../src/app-events"
import { installCalls, pendingCallCount } from "../src/calls"
import { installEvents } from "../src/events"
import { createRoot } from "../src/signals"
import { Updates } from "../src/updates"

let host: FakeHost
const reply = (r: object) => globalThis.__zn_onEvent(0, AppEvent.CallResult, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

// Other test files leave calls pending in the shared call table: compare with the count before.
test("holdApply holds until released; releasing twice tells native once", async () => {
  const before = pendingCallCount()
  const release = Updates.holdApply()
  const [c] = host.calls
  expect(c).toMatchObject({ module: "Updates", method: "hold", args: { __v: 3 } })
  expect(host.cancelled).toEqual([])
  release()
  release()
  expect(host.cancelled).toEqual([c.id])
  await Promise.resolve() // the "cancelled" rejection is caught inside holdApply (no unhandled rejection)
  expect(pendingCallCount()).toBe(before)
})

test("a hold ends by itself when the screen that asked closes", () => {
  const before = pendingCallCount()
  const dispose = createRoot((d) => {
    Updates.holdApply()
    return d
  })
  const [c] = host.calls
  expect(host.cancelled).toEqual([])
  dispose()
  expect(host.cancelled).toEqual([c.id])
  expect(pendingCallCount()).toBe(before)
})

test("applyNow resolves with the reason when nothing is applied", async () => {
  const p = Updates.applyNow()
  const [c] = host.calls
  expect(c).toMatchObject({ module: "Updates", method: "applyNow", args: { __v: 3 } })
  reply({ id: c.id, ok: true, value: { applied: false, reason: "held" } })
  expect(await p).toEqual({ applied: false, reason: "held" })
})

test("markHealthy tells native and resolves", async () => {
  const p = Updates.markHealthy()
  const [c] = host.calls
  expect(c).toMatchObject({ module: "Updates", method: "markHealthy", args: { __v: 3 } })
  reply({ id: c.id, ok: true, value: null })
  expect(await p).toBeNull()
})
