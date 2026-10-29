// A fake native host for unit tests: records what JS sends and lets a test fire timers and events by hand.
import type { NativeValue } from "../src/native"

export type Op =
  | ["patch", number, number, NativeValue]
  | ["mount", number, number, number, number, number, NativeValue[]]
  | ["remove", number]
  | ["move", number, number]
  | ["nav", number, number, number, string | null]

export interface FakeHost {
  timers: Map<number, { delay: number; repeat: boolean }>
  /** Slot patches only (kept for the timer/event tests). */
  patches: Array<[number, number, NativeValue]>
  /** Every batch op in order. */
  ops: Op[]
  logs: Array<[number, string]>
  /** Fires a timer the way native does: only if it is still registered on the native side. */
  fire(handle: number): void
}

export function installFakeHost(): FakeHost {
  let next = 1
  const host: FakeHost = {
    timers: new Map(),
    patches: [],
    ops: [],
    logs: [],
    fire(handle) {
      const t = host.timers.get(handle)
      if (!t) return
      if (!t.repeat) host.timers.delete(handle)
      globalThis.__zn_onTimer(handle)
    },
  }
  globalThis.__zn_setTimer = (delay, repeat) => {
    const h = next++
    host.timers.set(h, { delay, repeat })
    return h
  }
  globalThis.__zn_clearTimer = (h) => {
    host.timers.delete(h)
  }
  globalThis.__zn_patch = (i, s, v) => {
    host.patches.push([i, s, v])
    host.ops.push(["patch", i, s, v])
  }
  globalThis.__zn_mount = (t, p, a, i, idx, values) => {
    host.ops.push(["mount", t, p, a, i, idx, values])
  }
  globalThis.__zn_remove = (i) => {
    host.ops.push(["remove", i])
  }
  globalThis.__zn_move = (i, to) => {
    host.ops.push(["move", i, to])
  }
  globalThis.__zn_nav = (kind, entry, route, params) => {
    host.ops.push(["nav", kind, entry, route, params])
  }
  globalThis.__zn_log = (level, msg) => {
    host.logs.push([level, msg])
  }
  globalThis.__zn_now = () => 0
  return host
}
