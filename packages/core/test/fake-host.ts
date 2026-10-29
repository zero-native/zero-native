// A fake native host for unit tests: records what JS sends and lets a test fire timers and events by hand.
import type { NativeValue } from "../src/native"

export type Op =
  | ["patch", number, number, NativeValue]
  | ["mount", number, number, number, number, number, NativeValue[]]
  | ["remove", number]
  | ["move", number, number]
  | ["nav", number, number, number, string | null]
  | ["listSet", number, number, string[], number[]]
  | ["listSplice", number, number, number, number, string[], number[]]
  | ["listRow", number, number, string, number]

export interface FakeHost {
  timers: Map<number, { delay: number; repeat: boolean }>
  /** Slot patches only (kept for the timer/event tests). */
  patches: Array<[number, number, NativeValue]>
  /** Every batch op in order. */
  ops: Op[]
  logs: Array<[number, string]>
  /** Native module calls JS made. */
  calls: Array<{ module: string; method: string; args: unknown; id: number }>
  /** Call ids JS told native to cancel. */
  cancelled: number[]
  /** FlowStore contents (key → JSON) and keys to report as broken. */
  store: Map<string, string>
  broken: Set<string>
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
    calls: [],
    cancelled: [],
    store: new Map(),
    broken: new Set(),
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
  globalThis.__zn_listSet = (i, n, keys, types) => {
    host.ops.push(["listSet", i, n, keys, types])
  }
  globalThis.__zn_listSplice = (i, n, at, remove, keys, types) => {
    host.ops.push(["listSplice", i, n, at, remove, keys, types])
  }
  globalThis.__zn_listRow = (i, n, key, row) => {
    host.ops.push(["listRow", i, n, key, row])
  }
  globalThis.__zn_call = (module, method, args, id) => {
    host.calls.push({ module, method, args: JSON.parse(args), id })
  }
  globalThis.__zn_cancel = (id) => {
    host.cancelled.push(id)
  }
  globalThis.__zn_store_write = (key, json) => {
    host.store.set(key, json)
    return true
  }
  globalThis.__zn_store_read = (key) => (host.broken.has(key) ? false : (host.store.get(key) ?? null))
  globalThis.__zn_store_list = () => [...host.store.keys()]
  globalThis.__zn_store_remove = (key) => host.store.delete(key)
  globalThis.__zn_log = (level, msg) => {
    host.logs.push([level, msg])
  }
  // Native logs a reported JS error as "<where>: <details>" (core Platform::jsError).
  globalThis.__zn_error = (where, details) => {
    host.logs.push([3, `${where}: ${details}`])
  }
  globalThis.__zn_now = () => 0
  return host
}
