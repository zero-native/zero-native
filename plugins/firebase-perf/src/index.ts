// The Performance plugin's JS side (RN Firebase's `perf()`). Native side: android/.../PerfPlugin.kt.
//
// Most apps need no JS: the app start, every `fetch` and every screen (route) are traced by themselves. JS is for your
// own steps:
//
//   const t = await Perf.startTrace("checkout_load")
//   t.putAttribute("method", "upi")
//   ...
//   t.incrementMetric("retries")
//   await t.stop()
//
//   await Perf.trace("receipt_render", async (t) => { ... })   // starts, runs, stops (also when it throws)
//
// Each call answers and never rejects. A bad name (Firebase's rules) answers with a console warning and is left out.
// With no Firebase every call does nothing, and `status()` says `available: false`.
import { nativeModule, type CallOptions } from "@zeronative/core"

export interface PerfStatus {
  available: boolean
  enabled: boolean
}

export interface PerfModule {
  status(args?: Record<string, never>, options?: CallOptions): Promise<PerfStatus>
  setCollectionEnabled(args: { on: boolean }, options?: CallOptions): Promise<boolean>
  /** Each answers "" or why not. */
  startTrace(args: { id: string; name: string }, options?: CallOptions): Promise<string>
  putMetric(args: { id: string; name: string; value: number }, options?: CallOptions): Promise<string>
  incrementMetric(args: { id: string; name: string; by: number }, options?: CallOptions): Promise<string>
  putAttribute(args: { id: string; name: string; value: string | null }, options?: CallOptions): Promise<string>
  stopTrace(args: { id: string }, options?: CallOptions): Promise<string>
}

const Native = nativeModule<PerfModule>("FirebasePerf", { version: 1 })
// Not tied to a screen: a trace may outlive the screen that started it.
const unowned = { owned: false }
let nextId = 1
let lastEnabled = false

function checked(p: Promise<string>): Promise<boolean> {
  return p.then(
    (problem) => {
      if (problem) console.warn(`perf: ${problem}`)
      return !problem
    },
    () => false,
  )
}

/** A running trace. Metrics are whole numbers (Firebase's rule); up to 5 attributes (40-character names). */
export interface Trace {
  readonly name: string
  putMetric(name: string, value: number): Promise<boolean>
  incrementMetric(name: string, by?: number): Promise<boolean>
  putAttribute(name: string, value: string): Promise<boolean>
  removeAttribute(name: string): Promise<boolean>
  /** Sends it. A trace never stopped is never sent. */
  stop(): Promise<boolean>
}

function makeTrace(name: string, id: string): Trace {
  return {
    name,
    putMetric: (m, value) => checked(Native.putMetric({ id, name: m, value }, unowned)),
    incrementMetric: (m, by = 1) => checked(Native.incrementMetric({ id, name: m, by }, unowned)),
    putAttribute: (a, value) => checked(Native.putAttribute({ id, name: a, value }, unowned)),
    removeAttribute: (a) => checked(Native.putAttribute({ id, name: a, value: null }, unowned)),
    stop: () => checked(Native.stopTrace({ id }, unowned)),
  }
}

export const Perf = {
  /** `{ available, enabled }`. */
  status: (): Promise<PerfStatus> =>
    Native.status({}, unowned).then(
      (s) => {
        lastEnabled = s.enabled
        return s
      },
      () => ({ available: false, enabled: false }),
    ),

  /** On or off (the user's choice), kept across starts. */
  setPerformanceCollectionEnabled: (on: boolean): Promise<boolean> =>
    Native.setCollectionEnabled({ on }, unowned).then(
      (ok) => {
        if (ok) lastEnabled = on
        return ok
      },
      () => false,
    ),

  /** RN Firebase's property: the last value `status()` or the call above saw. */
  get isPerformanceCollectionEnabled(): boolean {
    return lastEnabled
  },

  /** Starts a trace: 1 to 100 characters, no space at either end, not starting with `_`. */
  startTrace: async (name: string): Promise<Trace> => {
    const id = `t${nextId++}`
    await checked(Native.startTrace({ id, name }, unowned))
    return makeTrace(name, id)
  },

  /** Starts [name], runs [fn], stops it, also when [fn] throws (the error goes on). */
  trace: async <T>(name: string, fn: (t: Trace) => T | Promise<T>): Promise<T> => {
    const t = await Perf.startTrace(name)
    try {
      return await fn(t)
    } finally {
      void t.stop()
    }
  },
}

/** RN Firebase's names, for code that ports over: `perf().startTrace(...)`, `getPerformance()`. */
export const perf = () => Perf
export const getPerformance = () => Perf
