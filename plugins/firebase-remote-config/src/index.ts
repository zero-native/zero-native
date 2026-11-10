// The Remote Config plugin's JS side (RN Firebase's `remoteConfig()`). Native side: android/.../RemoteConfigPlugin.kt.
//
// At start (main.ts or the first screen):
//
//   await RemoteConfig.setDefaults({ checkout_v2: false, max_cashback: 50 })
//   await RemoteConfig.fetchAndActivate()              // new values from the console, if any (and allowed by the interval)
//   if (RemoteConfig.getValue("checkout_v2").asBoolean()) ...
//
// Reads (`getValue`, `getString`, ...) need no call: each answer of setDefaults / fetch / activate / getAll brings all
// values to JS. Before the first answer they give the defaults JS set. Each call answers and never rejects. With no
// Firebase in the app every value is its default, and `available` is false.
import { nativeModule, type CallOptions } from "@zero-native/core"

/** Where a value came from: the console ("remote"), `setDefaults` ("default"), or nowhere ("static": "", 0, false). */
export type ValueSource = "remote" | "default" | "static"
export type FetchStatus = "success" | "failure" | "throttled" | "no_fetch_yet"
/** Why a fetch or activate failed. "throttled": too many fetches (raise `minimumFetchIntervalMillis`). */
export type FailReason = "unavailable" | "no_network" | "throttled" | "failed"
export type DefaultValue = string | number | boolean

interface NativeResult {
  available: boolean
  ok: boolean
  reason: FailReason | null
  changed: boolean
  values: Record<string, { value: string; source: ValueSource }>
  lastFetchStatus: FetchStatus
  fetchTimeMillis: number
}

export interface RemoteConfigModule {
  setDefaults(args: { defaults: Record<string, DefaultValue> }, options?: CallOptions): Promise<boolean>
  setConfigSettings(args: { minimumFetchIntervalMillis?: number; fetchTimeMillis?: number }, options?: CallOptions): Promise<boolean>
  fetch(args: { expirationSeconds?: number }, options?: CallOptions): Promise<NativeResult>
  activate(args?: Record<string, never>, options?: CallOptions): Promise<NativeResult>
  fetchAndActivate(args?: Record<string, never>, options?: CallOptions): Promise<NativeResult>
  getAll(args?: Record<string, never>, options?: CallOptions): Promise<NativeResult>
  reset(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  startUpdates(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  stopUpdates(args?: Record<string, never>, options?: CallOptions): Promise<boolean>
  events: { updated: { updatedKeys: string[]; error?: string } }
}

/** One value, read in the type you need (RN Firebase's ConfigValue). */
export interface ConfigValue {
  asString(): string
  /** 0 when it isn't a number. */
  asNumber(): number
  /** True for "true", "1", "yes", "y", "on" (any case), as Firebase does. */
  asBoolean(): boolean
  getSource(): ValueSource
}

const Native = nativeModule<RemoteConfigModule>("FirebaseRemoteConfig", { version: 1 })
// Not tied to a screen: a fetch started on one screen must still land when it closes.
const unowned = { owned: false }

let values: Record<string, { value: string; source: ValueSource }> = {}
let defaults: Record<string, DefaultValue> = {}
let available = false
let lastFetchStatus: FetchStatus = "no_fetch_yet"
let fetchTimeMillis = -1

const TRUE = new Set(["true", "1", "yes", "y", "on"])

function value(raw: string, source: ValueSource): ConfigValue {
  return {
    asString: () => raw,
    asNumber: () => {
      const n = Number(raw)
      return raw.trim() !== "" && Number.isFinite(n) ? n : 0
    },
    asBoolean: () => TRUE.has(raw.trim().toLowerCase()),
    getSource: () => source,
  }
}

function keep(r: NativeResult): NativeResult {
  available = r.available
  if (r.available) {
    values = r.values
    lastFetchStatus = r.lastFetchStatus
    fetchTimeMillis = r.fetchTimeMillis
  }
  return r
}

/** What a fetch / activate call answers: `ok`, and `changed` (activate: new values came into use). */
export interface Outcome {
  ok: boolean
  reason: FailReason | null
  changed: boolean
}

const outcome = (p: Promise<NativeResult>): Promise<Outcome> =>
  p.then(
    (r) => {
      keep(r)
      return { ok: r.ok, reason: r.reason, changed: r.changed }
    },
    (): Outcome => ({ ok: false, reason: "unavailable", changed: false }),
  )

export const RemoteConfig = {
  /** False until a call answered from a Firebase app (no google-services.json: always false). */
  get available(): boolean {
    return available
  },

  /** Used until the console has a value (and when there is no Firebase). Call it before reading. */
  setDefaults: (d: Record<string, DefaultValue>): Promise<boolean> => {
    defaults = { ...defaults, ...d }
    return Native.setDefaults({ defaults: d }, unowned).then(
      (ok) => Native.getAll({}, unowned).then(keep).then(() => ok, () => ok),
      () => false,
    )
  },

  /**
   * `minimumFetchIntervalMillis`: Firebase fetches at most this often (default 12 hours; use 0 only in debug builds,
   * or the console throttles the app). `fetchTimeMillis`: the network time limit (default 60 s).
   */
  setConfigSettings: (s: { minimumFetchIntervalMillis?: number; fetchTimeMillis?: number }): Promise<boolean> =>
    Native.setConfigSettings(s, unowned).catch(() => false),

  /** New values from the console, kept for `activate`. [expirationSeconds] overrides the interval once. */
  fetch: (expirationSeconds?: number): Promise<Outcome> =>
    outcome(Native.fetch(expirationSeconds == null ? {} : { expirationSeconds }, unowned)),

  /** The fetched values come into use. `changed`: they differ from before. */
  activate: (): Promise<Outcome> => outcome(Native.activate({}, unowned)),

  fetchAndActivate: (): Promise<Outcome> => outcome(Native.fetchAndActivate({}, unowned)),

  /**
   * Loads the values Firebase already has (the last activated ones, from its cache) without a fetch: call it at start
   * to read last session's values at once (RN Firebase's `ensureInitialized`).
   */
  ensureInitialized: (): Promise<boolean> =>
    Native.getAll({}, unowned).then(
      (r) => keep(r).available,
      () => false,
    ),

  getValue: (key: string): ConfigValue => {
    const v = values[key]
    if (v) return value(v.value, v.source)
    if (key in defaults) return value(String(defaults[key]), "default")
    return value("", "static")
  },
  getString: (key: string): string => RemoteConfig.getValue(key).asString(),
  getNumber: (key: string): number => RemoteConfig.getValue(key).asNumber(),
  getBoolean: (key: string): boolean => RemoteConfig.getValue(key).asBoolean(),

  /** Every key with a value (console or default). */
  getAll: (): Record<string, ConfigValue> => {
    const out: Record<string, ConfigValue> = {}
    for (const k of new Set([...Object.keys(defaults), ...Object.keys(values)])) out[k] = RemoteConfig.getValue(k)
    return out
  },

  get lastFetchStatus(): FetchStatus {
    return lastFetchStatus
  },
  /** When the last successful fetch was, ms since 1970; -1 for never. */
  get fetchTimeMillis(): number {
    return fetchTimeMillis
  },

  /** Deletes the fetched and activated values and the settings (the defaults stay in JS). */
  reset: (): Promise<boolean> => {
    values = {}
    return Native.reset({}, unowned).catch(() => false)
  },

  /**
   * Real-time: [handler] runs when the console publishes changes (after them, call `activate()`). Firebase keeps a
   * connection open while anyone listens. Returns the unsubscribe function.
   */
  onConfigUpdated: (handler: (event: { updatedKeys: string[]; error?: string }) => void): (() => void) => {
    listeners += 1
    if (listeners === 1) void Native.startUpdates({}, unowned).catch(() => false)
    const off = Native.on("updated", handler)
    let done = false
    return () => {
      if (done) return
      done = true
      off()
      listeners -= 1
      if (listeners === 0) void Native.stopUpdates({}, unowned).catch(() => false)
    }
  },
}
let listeners = 0

/** RN Firebase's names, for code that ports over: `remoteConfig().getValue(...)`, `getRemoteConfig()`. */
export const remoteConfig = () => RemoteConfig
export const getRemoteConfig = () => RemoteConfig
