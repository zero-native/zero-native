// Store updates: Google Play's in-app updates on Android, the App Store on iOS, driven by the zn-updates server's store
// rules. The answer comes with native's OTA check (one call to the server: `Updates.status().store`), so this plugin
// makes no network call. Native side: android/.../AppUpdatesPlugin.kt and ios/AppUpdatesPlugin.swift. README: how an
// app wires it, the rules, and how to test with Play.
//
//   import { AppUpdates, storeAnswer, createAppUpdateEngine, playUpdates } from "@zeronative/app-updates"
//   const answer = await storeAnswer()
//   if (answer?.update?.critical === 2) await AppUpdates.start({ flexible: false })
//
// Nothing here rejects: a failure answers "no update" / false / null, because an update check must never stop the app.
import { nativeModule, Updates, type CallOptions, type StoreStatus, type UpdateStatus } from "@zeronative/core"
import type { AppUpdateEngine, PlayUpdates, PlayUpdateState, StoreCheck, StoreSource, StoreUpdate } from "./rules"

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
   * Opens the app's store page: Play on Android, the App Store on iOS (needs `appStoreId`, from `storeAnswer`'s
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

// ---- The store answer (from the OTA check) -------------------------------------------------------------------------

/**
 * The store answer native got with its last update check (`Updates.status().store`: the zn-updates server answers OTA
 * and "update from the store?" in the same call). `{ update: null, store }` when there is nothing to do; null before
 * the first answer (or with an older server). Never rejects. No network call of its own.
 */
export async function storeAnswer(status?: UpdateStatus): Promise<StoreCheck | null> {
  try {
    const s = status ?? (await Updates.status())
    return fromStatus(s.store)
  } catch (e) {
    console.warn("[AppUpdates] store answer: Updates.status failed:", e)
    return null
  }
}

/** `storeAnswer` in the shape `createAppUpdateEngine` wants. */
export const nativeStoreSource: StoreSource = { get: () => storeAnswer() }

/**
 * Runs `engine.check()` once after each update check native makes (start, return, push; how often is the app's
 * `ZnOta.Config.checkIntervalMs`), and once now if native has checked already. For an engine made with
 * `autoCheck: false` and `source: nativeStoreSource`. Returns the stop function.
 */
export function checkAfterUpdateChecks(engine: AppUpdateEngine): () => void {
  let seen: number | null | undefined
  const onStatus = (s: UpdateStatus) => {
    const at = s.lastCheckAt ?? null
    if (at === null || at === seen) return // not a new check (a phase or progress change)
    seen = at
    void engine.check()
  }
  const stop = Updates.onStatus(onStatus)
  Updates.status().then(onStatus, () => {})
  return stop
}

function fromStatus(v: StoreStatus | null | undefined): StoreCheck | null {
  if (!v || typeof v !== "object") return null
  const u = v.update
  let update: StoreUpdate | null = null
  if (u) {
    const okVersion = (typeof u.version === "number" && Number.isFinite(u.version)) || (typeof u.version === "string" && u.version !== "")
    if (!okVersion || (u.critical !== 1 && u.critical !== 2)) return null
    update = { version: u.version, critical: u.critical }
    if (typeof u.title === "string" && u.title) update.title = u.title
    if (typeof u.message === "string" && u.message) update.message = u.message
  }
  return { update, store: typeof v.appStoreId === "string" && v.appStoreId ? { appStoreId: v.appStoreId } : {} }
}

export default AppUpdates
