import { afterEach, beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installCalls } from "../src/calls"
import { installEvents } from "../src/events"
import { Alert } from "../src/alert"
import { createRoot } from "../src/signals"

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

test("no buttons: one OK button, not cancelable", () => {
  Alert.alert("Saved")
  expect(host.calls).toHaveLength(1)
  expect(host.calls[0]).toMatchObject({
    module: "Alert",
    method: "show",
    args: { title: "Saved", message: null, buttons: ["OK"], cancelable: false, __v: 1 },
  })
  Alert.alert("Saved", "Done", [])
  expect(host.calls[1].args.buttons).toEqual(["OK"])
})

test("the tapped button's onPress runs; texts go in order", async () => {
  const pressed: string[] = []
  Alert.alert("Cancel payment?", "Not taken yet", [
    { text: "Keep", style: "cancel", onPress: () => pressed.push("keep") },
    { text: "Cancel", style: "destructive", onPress: () => pressed.push("cancel") },
  ])
  const c = host.calls[0]
  expect(c.args).toMatchObject({ title: "Cancel payment?", message: "Not taken yet", buttons: ["Keep", "Cancel"] })
  reply({ id: c.id, ok: true, value: { index: 1 } })
  await tick()
  expect(pressed).toEqual(["cancel"])
})

test("buttons without text: the last is OK, the others empty (as in RN)", () => {
  Alert.alert("x", undefined, [{}, {}, {}])
  expect(host.calls[0].args.buttons).toEqual(["", "", "OK"])
})

test("more than 3 buttons: the first 3 go, with a warning", async () => {
  const pressed: number[] = []
  Alert.alert("x", "y", [1, 2, 3, 4].map((n) => ({ text: `b${n}`, onPress: () => pressed.push(n) })))
  const c = host.calls[0]
  expect(c.args.buttons).toEqual(["b1", "b2", "b3"])
  expect(host.logs.some(([level, msg]) => level === 2 && msg.includes("up to 3 buttons"))).toBe(true)
  reply({ id: c.id, ok: true, value: { index: 2 } })
  await tick()
  expect(pressed).toEqual([3])
})

test("dismissed (back / outside): onDismiss runs, no button does", async () => {
  let dismissed = 0
  let pressed = 0
  Alert.alert("x", "y", [{ text: "OK", onPress: () => pressed++ }], { cancelable: true, onDismiss: () => dismissed++ })
  const c = host.calls[0]
  expect(c.args.cancelable).toBe(true)
  reply({ id: c.id, ok: true, value: { index: -1 } })
  await tick()
  expect([dismissed, pressed]).toEqual([1, 0])
})

test("a throwing onPress is reported, not thrown", async () => {
  Alert.alert("x", "y", [{ text: "OK", onPress: () => { throw new Error("boom") } }])
  reply({ id: host.calls[0].id, ok: true, value: { index: 0 } })
  await tick()
  expect(host.logs.some(([level, msg]) => level === 3 && msg.includes("Alert button onPress") && msg.includes("boom"))).toBe(true)
})

test("a failed call (no Activity) is logged, not thrown", async () => {
  Alert.alert("x")
  reply({ id: host.calls[0].id, ok: false, code: "no_activity", error: "no Activity to show the alert in" })
  await tick()
  expect(host.logs.some(([level, msg]) => level === 2 && msg.includes("no Activity"))).toBe(true)
})

test("the alert is not tied to the screen: buttons still run after it closes", async () => {
  let pressed = 0
  createRoot((dispose) => {
    Alert.alert("x", "y", [{ text: "OK", onPress: () => pressed++ }])
    dispose()
  })
  expect(host.cancelled).toEqual([])
  reply({ id: host.calls[0].id, ok: true, value: { index: 0 } })
  await tick()
  expect(pressed).toBe(1)
})
