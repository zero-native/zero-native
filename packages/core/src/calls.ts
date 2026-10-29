// Native modules (ARCHITECTURE §15.1, docs/native-modules.md): the JS side of calling native code and hearing back.
//
// - `callNative(module, method, args, { signal })` → Promise. Native runs the call off the JS and UI threads
//   (android/runtime/.../ZnModules.kt) and answers with app event 7 `{ id, ok, value | code, error }`. Async only:
//   neither thread ever waits.
// - Cancellation: an AbortSignal rejects at once with code "cancelled" and tells native (`__zn_cancel`), which marks
//   the call cancelled and drops its late reply. A call made while a screen is active is dropped quietly (never
//   settles, native is told to stop) when that screen closes, like its timers.
// - Errors are `NativeError { code, message, module, method }`: "unavailable" (no such module, method or version),
//   "cancelled", "invalid_args", "failed", or a module's own code.
// - Events (native → JS): `Module.on("event", handler)` → unsubscribe function; also ended when the screen closes.
//   Native delivers app event 8 `{ module, event, payload }`. Native is told how many listeners an event has, so it
//   can start / stop work (GPS, receivers) only while someone listens.
// - `nativeModule<T>("Name", { version })` gives a typed handle over all of this. Arguments and results are JSON.
import { reportError } from "./errors"
import { onEvent } from "./events"
import type { NativeValue } from "./native"
import { getOwner, onCleanup, type Owner } from "./signals"

export class NativeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly module: string,
    readonly method: string,
  ) {
    super(message)
    this.name = "NativeError"
  }
}

export interface CallOptions {
  /** Abort the call: the Promise rejects with code "cancelled" and native is told to stop. */
  signal?: AbortSignal
}

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  module: string
  method: string
  owned: Set<number> | null
}

const pending = new Map<number, Pending>()
const byOwner = new WeakMap<Owner, Set<number>>()
let nextId = 1

/** Ids below this never get a reply (internal messages such as listener counts use 0). */
const NO_REPLY = 0

export function callNative<T = unknown>(
  module: string,
  method: string,
  args: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const signal = options.signal
    if (signal?.aborted) return reject(new NativeError("cancelled", `${module}.${method} was cancelled`, module, method))
    const id = nextId++
    const owned = ownedSet()
    owned?.add(id)
    pending.set(id, { resolve, reject, module, method, owned })
    signal?.addEventListener("abort", () => {
      if (!finish(id)) return
      globalThis.__zn_cancel(id)
      reject(new NativeError("cancelled", `${module}.${method} was cancelled`, module, method))
    })
    try {
      globalThis.__zn_call(module, method, JSON.stringify(args), id)
    } catch (e) {
      finish(id)
      reject(new NativeError("invalid_args", e instanceof Error ? e.message : String(e), module, method))
    }
  })
}

/** Removes a pending call; false if it already finished. */
function finish(id: number): boolean {
  const p = pending.get(id)
  if (!p) return false
  pending.delete(id)
  p.owned?.delete(id)
  return true
}

/** The calls of the current owner (screen, component), dropped together when it is disposed. */
function ownedSet(): Set<number> | null {
  const owner = getOwner()
  if (!owner || owner.disposed) return null
  let set = byOwner.get(owner)
  if (!set) {
    const s = new Set<number>()
    set = s
    byOwner.set(owner, s)
    onCleanup(() => {
      byOwner.delete(owner)
      for (const id of [...s]) {
        if (finish(id)) globalThis.__zn_cancel(id) // dropped quietly: the screen that asked is gone
      }
    })
  }
  return set
}

function onResult(payload: NativeValue): void {
  const r = JSON.parse(String(payload)) as { id: number; ok: boolean; value?: unknown; code?: string; error?: string }
  const p = pending.get(r.id)
  if (!p || !finish(r.id)) return
  if (r.ok) p.resolve(r.value ?? null)
  else p.reject(new NativeError(r.code ?? "failed", r.error ?? "native call failed", p.module, p.method))
}

// ---- Events (native → JS) ------------------------------------------------------------------------------------------

type Listener = (payload: any) => void
const listeners = new Map<string, Set<Listener>>()

/** Subscribes to a module's event; returns the unsubscribe function. Ends by itself when the current screen closes. */
export function onNativeEvent(module: string, event: string, handler: Listener): () => void {
  const key = `${module}\u0000${event}`
  let set = listeners.get(key)
  if (!set) listeners.set(key, (set = new Set()))
  const s = set
  s.add(handler)
  globalThis.__zn_call(module, "__listeners", JSON.stringify({ event, count: s.size }), NO_REPLY)
  let active = true
  const off = () => {
    if (!active) return
    active = false
    s.delete(handler)
    globalThis.__zn_call(module, "__listeners", JSON.stringify({ event, count: s.size }), NO_REPLY)
  }
  if (getOwner()) onCleanup(off)
  return off
}

function onModuleEvent(payload: NativeValue): void {
  const e = JSON.parse(String(payload)) as { module: string; event: string; payload?: unknown }
  const set = listeners.get(`${e.module}\u0000${e.event}`)
  if (!set) return
  for (const h of [...set]) {
    try {
      h(e.payload ?? null)
    } catch (err) {
      reportError(`${e.module}.${e.event} listener`, err)
    }
  }
}

// ---- Typed handles ----------------------------------------------------------------------------------------------------

type Fn = (...args: any[]) => Promise<any>
type MethodsOf<T> = { [K in keyof T as K extends "events" ? never : T[K] extends Fn ? K : never]: T[K] }
type EventsOf<T> = T extends { events: infer E } ? E : {}

export type ModuleHandle<T> = MethodsOf<T> & {
  /** Listen to a native event; returns the unsubscribe function (also called when the screen closes). */
  on<E extends keyof EventsOf<T> & string>(event: E, handler: (payload: EventsOf<T>[E]) => void): () => void
}

/**
 * A typed handle to a native module. Declare the module once as a TS interface: methods take one plain args object
 * (optional) and `CallOptions` (optional), and return a Promise; `events` lists what native can send.
 *
 *   interface DeviceModule {
 *     info(): Promise<{ model: string }>
 *     slowEcho(args: { text: string; ms: number }, options?: CallOptions): Promise<string>
 *     events: { tick: number }
 *   }
 *   export const Device = nativeModule<DeviceModule>("Device", { version: 1 })
 *
 * `version`: the lowest native version this code needs; an older app answers every call with "unavailable".
 */
export function nativeModule<T>(name: string, config: { version?: number } = {}): ModuleHandle<T> {
  const version = config.version ?? 1
  const methods = new Map<string, Fn>()
  return new Proxy({} as ModuleHandle<T>, {
    get(_, prop) {
      if (typeof prop !== "string" || prop === "then") return undefined // not a thenable
      if (prop === "on") return (event: string, handler: Listener) => onNativeEvent(name, event, handler)
      let fn = methods.get(prop)
      if (!fn) {
        fn = (args?: Record<string, unknown>, options?: CallOptions) =>
          callNative(name, prop, { ...(args ?? {}), __v: version }, options)
        methods.set(prop, fn)
      }
      return fn
    },
  })
}

/** Number of calls still waiting for native (for tests and leak checks). */
export function pendingCallCount(): number {
  return pending.size
}

export function installCalls(): void {
  onEvent(0, 7, onResult)
  onEvent(0, 8, onModuleEvent)
}
