// Store updates: Google Play's in-app updates on Android, the App Store on iOS, driven by the zn-updates server's store
// rules (GET /v1/store). Native side: android/.../AppUpdatesPlugin.kt and ios/AppUpdatesPlugin.swift. README: how an app
// wires it, the rules, and how to test with Play.
//
//   import { AppUpdates, checkStore, createAppUpdateEngine, playUpdates } from "@zero-native/app-updates"
//   const answer = await checkStore({ server, app: "myapp", os: "android", version: DeviceInfo.getBuildNumber() })
//   if (answer?.update?.critical === 2) await AppUpdates.start({ flexible: false })
//
// Nothing here rejects: a failure answers "no update" / false / null, because an update check must never stop the app.
import { fetch, nativeModule, type CallOptions } from "@zero-native/core"
import type { PlayUpdates, PlayUpdateState, StoreCheck, StoreUpdate } from "./rules"

export * from "./rules"

/** Play's install state: `accepted` / `declined` (the optional sheet's answer), download progress, `downloaded`, ... */
export type AppUpdateState = PlayUpdateState

/** What Play says about this phone (Android). iOS always answers `available: false`. */
export interface PlayAvailability {
  /** Play offers a newer build to this phone. */
  available: boolean
  /** The newest versionCode Play offers (0 when none). */
  versionCode: number
  /** Play allows a forced (IMMEDIATE) update now. */
  immediateAllowed: boolean
  /** Play allows an optional (FLEXIBLE) update now. */
  flexibleAllowed: boolean
  /** Days since Play first offered this update to the phone, when Play knows. */
  stalenessDays?: number
}

/** The answer of `start` and `complete`. `unavailable`: this OS has no in-app update (iOS). */
export interface StartResult {
  ok: boolean
  unavailable?: boolean
}

type NoArgs = Record<string, never>

interface AppUpdatesModule {
  isUpdateAvailable(args: NoArgs, options?: CallOptions): Promise<Partial<PlayAvailability> | null>
  start(args: { flexible: boolean }, options?: CallOptions): Promise<StartResult | null>
  complete(args: NoArgs, options?: CallOptions): Promise<StartResult | null>
  setBusy(args: { busy: boolean }, options?: CallOptions): Promise<null>
  openStore(args: { appStoreId?: string }, options?: CallOptions): Promise<{ opened: boolean } | null>
  events: { state: AppUpdateState }
}

const Native = nativeModule<AppUpdatesModule>("AppUpdates", { version: 1 })

// Not tied to a screen: Play's sheet answers whichever screen is open, and app-level code calls these too
const unowned: CallOptions = { owned: false }

const NOT_AVAILABLE: PlayAvailability = { available: false, versionCode: 0, immediateAllowed: false, flexibleAllowed: false }

function availability(v: Partial<PlayAvailability> | null): PlayAvailability {
  if (!v || typeof v !== "object" || v.available !== true) return { ...NOT_AVAILABLE, versionCode: num(v?.versionCode) }
  const out: PlayAvailability = {
    available: true,
    versionCode: num(v.versionCode),
    immediateAllowed: v.immediateAllowed === true,
    flexibleAllowed: v.flexibleAllowed === true,
  }
  if (typeof v.stalenessDays === "number") out.stalenessDays = v.stalenessDays
  return out
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

function result(v: StartResult | null): StartResult {
  if (!v || typeof v !== "object") return { ok: false }
  return v.unavailable === true ? { ok: false, unavailable: true } : { ok: v.ok === true }
}

export const AppUpdates = {
  /** Asks Play if it offers an update to this phone (Android). iOS: always `available: false`. Never rejects. */
  isUpdateAvailable: (): Promise<PlayAvailability> =>
    Native.isUpdateAvailable({}, unowned).then(availability, () => ({ ...NOT_AVAILABLE })),

  /**
   * Opens Play's update: `flexible` true = optional (a sheet, then a download in the background), false = forced (full
   * screen; cancelling opens it again). `ok` = Play was asked; Play itself decides if it shows. iOS: `unavailable`.
   */
  start: (options: { flexible: boolean }): Promise<StartResult> =>
    Native.start({ flexible: options.flexible === true }, unowned).then(result, () => ({ ok: false })),

  /** Installs a downloaded optional update: Play restarts the app. iOS: `unavailable`. Never rejects. */
  complete: (): Promise<StartResult> => Native.complete({}, unowned).then(result, () => ({ ok: false })),

  /**
   * The app is busy (a payment, a checkout, a form being sent): no forced update re-opens, no downloaded update
   * installs, and the download card hides. Kept on disk, so a new Activity after Android killed the app also waits.
   * Set it back to false when the busy part ends. Never rejects.
   */
  setBusy: (busy: boolean): Promise<null> => Native.setBusy({ busy: busy === true }, unowned).catch(() => null),

  /**
   * Opens the app's store page: Play on Android, the App Store on iOS (needs `appStoreId`, from `checkStore`'s
   * `store.appStoreId`). Never rejects.
   */
  openStore: (options: { appStoreId?: string } = {}): Promise<boolean> =>
    Native.openStore(options.appStoreId ? { appStoreId: options.appStoreId } : {}, unowned).then(
      (v) => v?.opened === true,
      () => false,
    ),

  /** Play's install state (the sheet's answer, download progress, downloaded, failed). Returns the stop function. */
  onState: (handler: (state: AppUpdateState) => void): (() => void) => Native.on("state", handler),
}

/** `AppUpdates` in the shape `createAppUpdateEngine` wants (Android). */
export const playUpdates: PlayUpdates = {
  isAvailable: () => AppUpdates.isUpdateAvailable(),
  start: (options) => AppUpdates.start(options),
  complete: () => AppUpdates.complete(),
}

// ---- The server's store answer --------------------------------------------------------------------------------------

/** The time limit for `checkStore` (as ZeroBill's store check). */
export const STORE_CHECK_TIMEOUT_MS = 8000

/** The parts of a fetch answer `checkStore` reads. */
export interface StoreFetchResponse {
  status: number
  json(): Promise<unknown>
}

export interface CheckStoreOptions {
  /** The zn-updates server, e.g. "https://updates.example.com" (no "/v1"). */
  server: string
  /** The app's id on the server. */
  app: string
  os: "android" | "ios"
  /** This build's version: Android versionCode ("168"), iOS CFBundleShortVersionString ("1.6.2"). */
  version: string | number
  timeoutMs?: number
  /** For tests: a fetch to use instead of core's. */
  fetch?: (url: string, init: { method: string; timeout: number }) => Promise<StoreFetchResponse>
}

function parseUpdate(v: unknown): StoreUpdate | null | undefined {
  if (v === null) return null
  if (!v || typeof v !== "object") return undefined
  const u = v as Record<string, unknown>
  const okVersion = (typeof u.version === "number" && Number.isFinite(u.version)) || (typeof u.version === "string" && u.version !== "")
  if (!okVersion || (u.critical !== 1 && u.critical !== 2)) return undefined
  const out: StoreUpdate = { version: u.version as number | string, critical: u.critical }
  if (typeof u.title === "string" && u.title) out.title = u.title
  if (typeof u.message === "string" && u.message) out.message = u.message
  return out
}

/**
 * Asks the zn-updates server if this build should update from the store: `GET <server>/v1/store?app=&os=&version=`.
 * Answers `{ update: null, store }` when there is nothing to do, and null when there is no answer (offline, a time-out
 * after 8 s, a server error, an answer it can't read). Never rejects.
 */
export async function checkStore(options: CheckStoreOptions): Promise<StoreCheck | null> {
  const timeout = options.timeoutMs ?? STORE_CHECK_TIMEOUT_MS
  const base = options.server.replace(/\/+$/, "")
  const query = `app=${encodeURIComponent(options.app)}&os=${encodeURIComponent(options.os)}&version=${encodeURIComponent(String(options.version))}`
  const url = `${base}/v1/store?${query}`
  try {
    const get = options.fetch ?? ((u: string, init: { method: string; timeout: number }) => fetch(u, { ...init, headers: { accept: "application/json" } }))
    const res = await get(url, { method: "GET", timeout })
    if (res.status !== 200) {
      console.warn(`[AppUpdates] store check answered ${res.status}`)
      return null
    }
    const body = (await res.json()) as Record<string, unknown> | null
    if (!body || typeof body !== "object") return null
    const update = parseUpdate(body.update ?? null)
    if (update === undefined) {
      console.warn("[AppUpdates] store check: an answer this version can't read")
      return null
    }
    const store = body.store && typeof body.store === "object" ? (body.store as Record<string, unknown>) : {}
    return { update, store: typeof store.appStoreId === "string" && store.appStoreId ? { appStoreId: store.appStoreId } : {} }
  } catch (e) {
    console.warn("[AppUpdates] store check failed:", e)
    return null
  }
}

export default AppUpdates
