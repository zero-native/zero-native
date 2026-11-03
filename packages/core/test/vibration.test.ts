import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { resetVibrationForTests, Vibration } from "../src/vibration"

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
  resetVibrationForTests()
})

// Answers what a test left open: pending calls are shared by every test file (calls.test.ts counts them).
afterEach(() => {
  for (const c of host.calls) if (c.id !== 0) reply({ id: c.id, ok: true, value: null })
})

test("no arguments: 400 ms; a number: one buzz that long, never repeating", () => {
  Vibration.vibrate()
  Vibration.vibrate(100, true)
  expect(host.calls.map((c) => c.args)).toEqual([
    { pattern: [0, 400], repeat: false, __v: 1 },
    { pattern: [0, 100], repeat: false, __v: 1 },
  ])
  expect(host.calls[0]).toMatchObject({ module: "Vibration", method: "vibrate" })
})

test("an array is Android's pattern [wait, buzz, ...]; repeat goes with it", () => {
  Vibration.vibrate([0, 200, 100, 200])
  Vibration.vibrate([0, 500, 500], true)
  expect(host.calls.map((c) => c.args)).toEqual([
    { pattern: [0, 200, 100, 200], repeat: false, __v: 1 },
    { pattern: [0, 500, 500], repeat: true, __v: 1 },
  ])
})

test("a pattern with no buzz sends nothing", () => {
  Vibration.vibrate(0)
  Vibration.vibrate([])
  Vibration.vibrate([300, 0, 200])
  expect(host.calls).toHaveLength(0)
})

test("bad values throw a TypeError", () => {
  for (const bad of [-1, NaN, Infinity, [0, -5], [0, "100"], "400", null]) {
    expect(() => (Vibration.vibrate as any)(bad)).toThrow(TypeError)
  }
  expect(host.calls).toHaveLength(0)
})

test("cancel calls native", () => {
  Vibration.cancel()
  expect(host.calls[0]).toMatchObject({ module: "Vibration", method: "cancel", args: { __v: 1 } })
})

test("a missing VIBRATE permission is a warning, once per run, never thrown", async () => {
  const message = 'Vibration needs <uses-permission android:name="android.permission.VIBRATE"/> in the app\'s AndroidManifest.xml'
  Vibration.vibrate()
  Vibration.vibrate(50)
  Vibration.cancel()
  for (const c of host.calls) reply({ id: c.id, ok: false, code: "not_declared", error: message })
  await tick()
  const warnings = host.logs.filter(([level, msg]) => level === 2 && msg.includes("android.permission.VIBRATE"))
  expect(warnings).toHaveLength(1)
})

test("other failures are logged each time", async () => {
  Vibration.vibrate()
  Vibration.vibrate()
  for (const c of host.calls) reply({ id: c.id, ok: false, code: "failed", error: "Vibration.vibrate failed: x" })
  await tick()
  expect(host.logs.filter(([level, msg]) => level === 2 && msg.includes("failed: x"))).toHaveLength(2)
})
