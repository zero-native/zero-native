import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents, onEvent } from "../src/events"

let host: FakeHost

beforeEach(() => {
  host = installFakeHost()
  installEvents()
})

test("an event reaches the handler for its instance and event id", () => {
  const got: unknown[] = []
  onEvent(1, 7, (p) => got.push(p))
  onEvent(2, 7, () => got.push("wrong instance"))
  globalThis.__zn_onEvent(1, 7, "tap")
  expect(got).toEqual(["tap"])
})

test("unsubscribe removes the handler", () => {
  let runs = 0
  const off = onEvent(3, 1, () => runs++)
  off()
  globalThis.__zn_onEvent(3, 1, null)
  expect(runs).toBe(0)
  expect(host.logs.some(([level]) => level === 2)).toBe(true)
})

test("a throwing handler is logged, not rethrown to native", () => {
  onEvent(4, 1, () => {
    throw new Error("bad handler")
  })
  expect(() => globalThis.__zn_onEvent(4, 1, null)).not.toThrow()
  expect(host.logs.some(([level, msg]) => level === 3 && msg.includes("bad handler"))).toBe(true)
})

test("latest(): an event prop runs the handler it holds now, and nothing when it holds none (as in React Native)", async () => {
  const { latest } = await import("../src/view")
  const { signal } = await import("../src/signals")
  const got: unknown[] = []
  const pay = (p: unknown) => got.push(`pay ${p}`)
  const busy = signal(false)
  onEvent(5, 1, latest(() => (busy() ? undefined : pay)))
  globalThis.__zn_onEvent(5, 1, "1")
  busy.set(true)
  globalThis.__zn_onEvent(5, 1, "2") // no handler now: no error, nothing logged as one
  busy.set(false)
  globalThis.__zn_onEvent(5, 1, "3")
  expect(got).toEqual(["pay 1", "pay 3"])
  expect(host.logs.some(([level]) => level === 3)).toBe(false)
  // A prop that was never given (`onPress={props.onPress}` with no onPress passed) and a null one: taps do nothing.
  onEvent(6, 1, latest(() => undefined))
  onEvent(7, 1, latest(() => null))
  globalThis.__zn_onEvent(6, 1, null)
  globalThis.__zn_onEvent(7, 1, null)
  expect(host.logs.some(([level]) => level === 3)).toBe(false)
})
