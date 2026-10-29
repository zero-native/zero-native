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
