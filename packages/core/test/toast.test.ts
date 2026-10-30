import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { installEvents } from "../src/events"
import { installCalls } from "../src/calls"
import { toast } from "../src/toast"
import { createRoot } from "../src/signals"

let host: FakeHost

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
})

test("toast sends show call to Toast module with __v: 1 and default short duration", () => {
  toast("Copied")
  expect(host.calls.length).toBe(1)
  expect(host.calls[0]).toMatchObject({
    module: "Toast",
    method: "show",
    args: { message: "Copied", duration: "short", __v: 1 },
  })
})

test("toast respects long duration", () => {
  toast("Payment verified", { duration: "long" })
  expect(host.calls.length).toBe(1)
  expect(host.calls[0]).toMatchObject({
    module: "Toast",
    method: "show",
    args: { message: "Payment verified", duration: "long", __v: 1 },
  })
})

test("toast is unowned: survives screen owner disposal", () => {
  createRoot((dispose) => {
    toast("Saved")
    dispose()
  })
  // The call is still in flight (not cancelled on dispose)
  expect(host.calls.length).toBe(1)
  expect(host.cancelled.length).toBe(0)
})

test("invalid message or duration throws TypeError", () => {
  expect(() => (toast as any)(null)).toThrow(TypeError)
  expect(() => toast("Hi", { duration: "forever" as any })).toThrow(TypeError)
})
