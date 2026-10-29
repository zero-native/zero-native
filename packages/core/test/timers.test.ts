import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { activeTimerCount, clearInterval, clearTimeout, installTimers, setInterval, setTimeout } from "../src/timers"

let host: FakeHost

beforeEach(() => {
  host = installFakeHost()
  installTimers({ replaceGlobals: false })
})

test("setTimeout runs once and is forgotten", () => {
  let runs = 0
  const h = setTimeout(() => runs++, 50)
  expect(host.timers.get(h)).toEqual({ delay: 50, repeat: false })
  host.fire(h)
  host.fire(h)
  expect(runs).toBe(1)
  expect(activeTimerCount()).toBe(0)
})

test("setInterval keeps one handle for every tick", () => {
  let runs = 0
  const h = setInterval(() => runs++, 150)
  host.fire(h)
  host.fire(h)
  host.fire(h)
  expect(runs).toBe(3)
  expect(host.timers.has(h)).toBe(true)
  clearInterval(h)
})

test("clearInterval always wins, even over a fire already queued (v0 zombie timer)", () => {
  let runs = 0
  const h = setInterval(() => runs++, 150)
  host.fire(h)
  clearInterval(h)
  // Simulate native delivering a fire that was queued before the clear:
  globalThis.__zn_onTimer(h)
  expect(runs).toBe(1)
  expect(host.timers.has(h)).toBe(false)
})

test("clearInterval inside its own callback stops it", () => {
  let runs = 0
  const h = setInterval(() => {
    runs++
    clearInterval(h)
  }, 10)
  host.fire(h)
  host.fire(h)
  expect(runs).toBe(1)
})

test("a repeating timer never asks for 0 ms", () => {
  const h = setInterval(() => {}, 0)
  expect(host.timers.get(h)?.delay).toBeGreaterThanOrEqual(1)
  clearInterval(h)
})

test("a throwing callback is logged and doesn't stop other timers", () => {
  let other = 0
  const bad = setTimeout(() => {
    throw new Error("boom")
  })
  const good = setTimeout(() => other++)
  host.fire(bad)
  host.fire(good)
  expect(other).toBe(1)
  expect(host.logs.some(([level, msg]) => level === 3 && msg.includes("boom"))).toBe(true)
})

test("clearTimeout accepts null and undefined", () => {
  expect(() => clearTimeout(undefined)).not.toThrow()
  expect(() => clearTimeout(null)).not.toThrow()
})
