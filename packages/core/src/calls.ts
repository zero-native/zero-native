// Native modules (ARCHITECTURE §15.1, docs/native-modules.md): the JS side of calling native code and hearing back.
//
// - `callNative(module, method, args, { signal })` → Promise. Native runs the call off the JS and UI threads
//   (android/runtime/.../ZnModules.kt) and answers with app event 7 `{ id, ok, value | code, error }`. Async only:
//   neither thread ever waits.
// - Cancellation: an AbortSignal rejects at once with code "cancelled" and tells native (`__zn_cancel`), which marks
//   the call cancelled and drops its late reply. A call made while a screen is active is dropped quietly (never
//   settles, native is told to stop) when that screen closes, like its timers. A call made in a tap handler belongs to
//   the screen, not to the tapped part (signals.ts oneShotOwner). A call made in an effect rejects "cancelled" when the
//   effect runs again.
// - Errors are `NativeError { code, message, module, method }`: "unavailable" (no such module, method or version),
//   "cancelled", "invalid_args", "failed", or a module's own code.
// - Binary data: `bytes` (an ArrayBuffer or typed array) goes to native as raw bytes (`call.bytes`), and a native
//   `resolveBytes(value, bytes)` answer arrives as app event 9, one ArrayBuffer [u32 LE head size][head JSON][body];
//   the Promise then resolves with `{ value, bytes }`, `bytes` being a Uint8Array view (no copy, no base64).
// - Events (native → JS): `Module.on("event", handler)` → unsubscribe function; also ended when the screen closes.
//   Native delivers app event 8 `{ module, event, payload }`. Native is told how many listeners an event has, so it
//   can start / stop work (GPS, receivers) only while someone listens.
// - `nativeModule<T>("Name", { version })` gives a typed handle over all of this. Arguments and results are JSON.
import { APP, AppEvent } from "./app-events"
import { reportError } from "./errors"
import { onEvent } from "./events"
import type { NativeValue } from "./native"
import { getOwner, onCleanup, oneShotOwner, runWithOwner, type Owner } from "./signals"

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
  /** Binary input for native (`call.bytes` in Kotlin). Read once, during the call. */
  bytes?: ArrayBuffer | ArrayBufferView
  /**
   * false: the call is not tied to the current screen, so it still settles after the screen closes (fetch uses
   * this). Default true: the screen closing drops it quietly.
   */
  owned?: boolean
}

/** What a native `resolveBytes(value, bytes)` answer resolves with. */
export interface BytesResult<T = unknown> {
  value: T
  bytes: Uint8Array
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
    const owned = options.owned === false ? null : ownedSet()
    owned?.add(id)
    pending.set(id, { resolve, reject, module, method, owned })
    signal?.addEventListener("abort", () => {
      if (!finish(id)) return
      globalThis.__zn_cancel(id)
      reject(new NativeError("cancelled", `${module}.${method} was cancelled`, module, method))
    })
    try {
      const b = options.bytes
      if (b === undefined) globalThis.__zn_call(module, method, JSON.stringify(args), id)
      else if (b instanceof ArrayBuffer) globalThis.__zn_call(module, method, JSON.stringify(args), id, b, 0, b.byteLength)
      else globalThis.__zn_call(module, method, JSON.stringify(args), id, b.buffer as ArrayBuffer, b.byteOffset, b.byteLength)
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

/**
 * The calls of the owner that asked (signals.ts oneShotOwner: the screen when asked from a tap), dropped together when
 * it is disposed, or rejected with "cancelled" when it is an effect that runs again.
 */
function ownedSet(): Set<number> | null {
  const owner = oneShotOwner()
  if (!owner || owner.disposed) return null
  let set = byOwner.get(owner)
  if (!set) {
    const s = new Set<number>()
    set = s
    byOwner.set(owner, s)
    runWithOwner(owner, () =>
      onCleanup(() => {
        byOwner.delete(owner)
        // Disposed: the screen (or part) that asked is gone, so the call is dropped quietly and never settles (its
        // `finally` doesn't run). Not disposed: an effect running again; the code that waits is still there, so the
        // call rejects "cancelled" instead of hanging (second-opinions 151).
        const rerun = !owner.disposed
        for (const id of [...s]) {
          const p = pending.get(id)
          if (!finish(id)) continue
          globalThis.__zn_cancel(id)
          if (rerun && p) p.reject(new NativeError("cancelled", `${p.module}.${p.method} was cancelled: the effect that asked ran again`, p.module, p.method))
        }
      }),
    )
  }
  return set
}

type Answer = { id: number; ok: boolean; value?: unknown; code?: string; error?: string }

function onResult(payload: NativeValue): void {
  settle(JSON.parse(String(payload)) as Answer)
}

/** App event 9: [u32 LE head size][head: the same JSON as event 7][body bytes]. */
function onResultBytes(payload: unknown): void {
  if (!(payload instanceof ArrayBuffer) || payload.byteLength < 4) {
    reportError("native answer", new Error("binary answer is not an ArrayBuffer"))
    return
  }
  const headSize = new DataView(payload).getUint32(0, true)
  const head = globalThis.__zn_utf8Decode(payload, 4, headSize, false) as string
  settle(JSON.parse(head) as Answer, new Uint8Array(payload, 4 + headSize))
}

function settle(r: Answer, bytes?: Uint8Array): void {
  const p = pending.get(r.id)
  if (!p || !finish(r.id)) return
  if (!r.ok) p.reject(new NativeError(r.code ?? "failed", r.error ?? "native call failed", p.module, p.method))
  else if (bytes) p.resolve({ value: r.value ?? null, bytes })
  else p.resolve(r.value ?? null)
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

declare global {
  /** Native modules' constants (ZnModule.constants), a JSON string set before the main script. Missing on older APKs. */
  // eslint-disable-next-line no-var
  var __zn_constants: string | undefined
}

let constants: Record<string, unknown> | null = null

/**
 * Native module [name]'s constants, read synchronously (RN's `getConstants`): values native gave before the app's JS
 * started, so module-level code can use them (`const BASE_URL = ...`). Undefined if the module gave none, or the app's
 * native side is older than this feature: always have a fallback.
 */
export function nativeConstants<T = Record<string, unknown>>(name: string): T | undefined {
  if (constants === null) {
    try {
      constants = JSON.parse(globalThis.__zn_constants ?? "{}") as Record<string, unknown>
    } catch {
      constants = {}
    }
  }
  return constants[name] as T | undefined
}

/** Tests only: forget the parsed constants, so a new `__zn_constants` is read. */
export function resetNativeConstantsForTests(): void {
  constants = null
}

/** Number of calls still waiting for native (for tests and leak checks). */
export function pendingCallCount(): number {
  return pending.size
}

export function installCalls(): void {
  onEvent(APP, AppEvent.CallResult, onResult)
  onEvent(APP, AppEvent.ModuleEvent, onModuleEvent)
  onEvent(APP, AppEvent.CallResultBytes, onResultBytes as (payload: NativeValue) => void) // its payload is an ArrayBuffer
}
