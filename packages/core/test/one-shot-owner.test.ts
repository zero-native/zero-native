// What a tap's work belongs to (second-opinions 151). Work that ends by itself (a native call, a setTimeout, an abort
// signal) belongs to the screen, so it ends even if the tapped part went away first. Work that repeats (setInterval)
// stays with the part. A native call made in an effect rejects "cancelled" when the effect runs again.
import { beforeEach, expect, test } from "bun:test"
import { installFakeHost, type FakeHost } from "./fake-host"
import { useAbortSignal } from "../src/abort"
import { callNative, installCalls, NativeError, pendingCallCount } from "../src/calls"
import { installEvents } from "../src/events"
import { effect, signal } from "../src/signals"
import { activeTimerCount, installTimers, setInterval, setTimeout } from "../src/timers"
import { on, renderRoot, view, when } from "../src/view"

let host: FakeHost
const ROOT = 0x80000001
const reply = (r: object) => globalThis.__zn_onEvent(0, 7, JSON.stringify(r))

beforeEach(() => {
  host = installFakeHost()
  installEvents()
  installCalls()
  installTimers({ replaceGlobals: false })
})

/**
 * A screen with one button inside `{shown() && ...}`. A tap runs [onTap]; [hide] hides the button (its part is
 * disposed), as a tap that hides its own button or a list refresh that builds the row again would. Returns the tap,
 * hide and close (the screen closes).
 */
function screenWithButton(onTap: () => void) {
  const shown = signal(true)
  const close = renderRoot(ROOT, () =>
    view(0, (i) => when(i, 1, () => shown(), () => view(1, (b) => on(b, 1, onTap)))),
  undefined)
  const button = host.ops.filter((o) => o[0] === "mount").at(-1)![4] as number
  return {
    tap: () => globalThis.__zn_onEvent(button, 1, null),
    hide: () => shown.set(false),
    close,
  }
}

test("a native call made in a tap settles after the tapped part went away", async () => {
  let answer: unknown = null
  const s = screenWithButton(() => void callNative("Os", "info").then((v) => (answer = v)))
  s.tap()
  const [c] = host.calls
  s.hide() // before the fix: the call was dropped here, and its promise never settled
  expect(host.cancelled).toEqual([])
  reply({ id: c.id, ok: true, value: "lava" })
  await Promise.resolve()
  expect(answer).toBe("lava")
})

test("a native call made in a tap is still dropped quietly when its screen closes", async () => {
  let settled = false
  const s = screenWithButton(() => void callNative("Os", "info").finally(() => (settled = true)))
  const before = pendingCallCount() // other test files leave calls in the shared table
  s.tap()
  const [c] = host.calls
  s.close()
  expect(host.cancelled).toEqual([c.id])
  expect(pendingCallCount()).toBe(before)
  await Promise.resolve()
  expect(settled).toBe(false)
})

test("a setTimeout made in a tap fires after the tapped part went away, and stops when the screen closes", () => {
  let fired = 0
  const s = screenWithButton(() => void setTimeout(() => fired++, 1000))
  s.tap()
  const [first] = [...host.timers.keys()]
  s.hide()
  host.fire(first) // a countdown started by a button that then hid itself goes on
  expect(fired).toBe(1)
  const t = screenWithButton(() => void setTimeout(() => fired++, 1000))
  t.tap()
  const before = activeTimerCount()
  t.close()
  expect(activeTimerCount()).toBe(before - 1)
})

test("a setInterval made in a tap still stops with the tapped part (no pile-up on a screen that stays open)", () => {
  const s = screenWithButton(() => void setInterval(() => {}, 1000))
  s.tap()
  s.tap()
  expect(activeTimerCount()).toBe(2)
  s.hide()
  expect(activeTimerCount()).toBe(0)
})

test("useAbortSignal in a tap aborts when the screen closes, not when the tapped part goes away", () => {
  let tapSignal: AbortSignal | null = null
  const s = screenWithButton(() => (tapSignal = useAbortSignal()))
  s.tap()
  s.hide()
  expect(tapSignal!.aborted).toBe(false)
  s.close()
  expect(tapSignal!.aborted).toBe(true)
})

test("a native call made in an effect rejects 'cancelled' when the effect runs again; a closed screen stays quiet", async () => {
  const page = signal(1)
  const results: string[] = []
  const close = renderRoot(ROOT, () => {
    effect(() => {
      const p = page()
      callNative("Offers", "load", { p }).then(
        (v) => results.push(`ok ${p} ${v}`),
        (e: NativeError) => results.push(`${e.code} ${p}`),
      )
    })
    return view(0, () => {})
  }, undefined)
  const [first] = host.calls
  page.set(2) // the effect runs again: the first call can't hang
  expect(host.cancelled).toEqual([first.id])
  await Promise.resolve()
  expect(results).toEqual(["cancelled 1"])
  const second = host.calls[1]
  close() // the screen closed: dropped quietly, as before
  expect(host.cancelled).toEqual([first.id, second.id])
  await Promise.resolve()
  expect(results).toEqual(["cancelled 1"])
})
