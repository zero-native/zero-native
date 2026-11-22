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
import type { AppUpdateEngine, PlayUpdates, PlayUpdateState, StoreCheck, StoreConfirm, StoreSource, StoreUpdate } from "./rules"

export * from "./rules"

/**
 * Play's install state: `accepted` / `declined` (the optional sheet's answer), download progress, `downloaded`, ...
 * iOS sends only the App Store sheet's close: `declined` (optional) or `canceled` (forced).
 */
export type AppUpdateState = PlayUpdateState

/**
 * What the store says about this phone: Play on Android, the App Store's lookup on iOS (the store's version is newer
 * than this build's and this iOS can run it).
 */
export interface PlayAvailability {
  /** The store offers a newer build to this phone. */
  available: boolean
  /** The newest versionCode Play offers (0 when none; always 0 on iOS). */
  versionCode: number
  /** A forced update can start now (Play's IMMEDIATE; iOS: whenever there is an update). */
  immediateAllowed: boolean
  /** An optional update can start now (Play's FLEXIBLE; iOS: whenever there is an update). */
  flexibleAllowed: boolean
  /** Days since Play first offered this update to the phone, when Play knows (iOS: since the version came out). */
  stalenessDays?: number
  /** iOS: the App Store's version, "1.6.2". */
  storeVersion?: string
  /** iOS: the app's App Store id (for `openStore`). */
  appStoreId?: string
}

/** The answer of `start` and `complete`. `unavailable`: this OS can't do it (iOS's `complete`). */
export interface StartResult {
  ok: boolean
  unavailable?: boolean
}

type NoArgs = Record<string, never>

interface AppUpdatesModule {
  isUpdateAvailable(args: { appStoreId?: string }, options?: CallOptions): Promise<Partial<PlayAvailability> | null>
  start(args: { flexible: boolean; appStoreId?: string }, options?: CallOptions): Promise<StartResult | null>
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
  if (!v || typeof v !== "object") return { ...NOT_AVAILABLE }
  if (v.available !== true) return withStore({ ...NOT_AVAILABLE, versionCode: num(v.versionCode) }, v)
  const out: PlayAvailability = {
    available: true,
    versionCode: num(v.versionCode),
    immediateAllowed: v.immediateAllowed === true,
    flexibleAllowed: v.flexibleAllowed === true,
  }
  if (typeof v.stalenessDays === "number") out.stalenessDays = v.stalenessDays
  return withStore(out, v)
}

/** iOS's App Store facts, kept whatever the answer. */
function withStore(out: PlayAvailability, v: Partial<PlayAvailability>): PlayAvailability {
  if (typeof v.storeVersion === "string" && v.storeVersion) out.storeVersion = v.storeVersion
  if (typeof v.appStoreId === "string" && /^\d{1,12}$/.test(v.appStoreId)) out.appStoreId = v.appStoreId
  return out
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)

function result(v: StartResult | null): StartResult {
  if (!v || typeof v !== "object") return { ok: false }
  return v.unavailable === true ? { ok: false, unavailable: true } : { ok: v.ok === true }
}

export const AppUpdates = {
  /**
   * Asks the store if it offers an update to this phone: Play (Android), the App Store's lookup (iOS, kept for an hour;
   * `appStoreId` asks for that App Store id instead of this app's bundle id; Android ignores it). Never rejects.
   */
  isUpdateAvailable: (options: { appStoreId?: string } = {}): Promise<PlayAvailability> =>
    Native.isUpdateAvailable(options.appStoreId ? { appStoreId: options.appStoreId } : {}, unowned).then(availability, () => ({ ...NOT_AVAILABLE })),

  /**
   * Opens the store's update. Android: Play's, `flexible` true = optional (a sheet, then a download in the background),
   * false = forced (full screen; cancelling opens it again); `ok` = Play was asked, Play itself decides if it shows.
   * iOS: the App Store's sheet for the app inside the app (its Update button installs; the App Store app when the sheet
   * can't load); closing it sends a `state`; a forced one opens again each time the app comes back to the front.
   * `appStoreId` (iOS) names the app when its bundle id isn't in the App Store. Never rejects.
   */
  start: (options: { flexible: boolean; appStoreId?: string }): Promise<StartResult> =>
    Native.start(
      options.appStoreId ? { flexible: options.flexible === true, appStoreId: options.appStoreId } : { flexible: options.flexible === true },
      unowned,
    ).then(result, () => ({ ok: false })),

  /** Installs a downloaded optional update: Play restarts the app. iOS: `unavailable` (the App Store installs). Never rejects. */
  complete: (): Promise<StartResult> => Native.complete({}, unowned).then(result, () => ({ ok: false })),

  /**
   * The app is busy (a payment, a checkout, a form being sent): no forced update re-opens, no downloaded update
   * installs, and the download card hides. Kept on disk, so a new Activity after Android killed the app also waits
   * (iOS: no forced App Store sheet opens again).
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

  /** Play's install state (the sheet's answer, download progress, downloaded, failed; iOS: the sheet's close). Returns the stop function. */
  onState: (handler: (state: AppUpdateState) => void): (() => void) => Native.on("state", handler),
}

/** `AppUpdates` in the shape `createAppUpdateEngine` wants (Android). */
export const playUpdates: PlayUpdates = {
  isAvailable: () => AppUpdates.isUpdateAvailable(),
  start: (options) => AppUpdates.start(options),
  complete: () => AppUpdates.complete(),
}

/**
 * The App Store's lookup in the shape `createAppUpdateEngine`'s `confirm` wants (iOS): the app's own update screens
 * show only once the App Store has the version (Apple's CDN can lag a release by hours), as Play's answer on Android.
 * The server's `appStoreId`, when it sends one, is the app asked about.
 */
export const appStoreUpdates: StoreConfirm = {
  isAvailable: (store) => AppUpdates.isUpdateAvailable(store?.appStoreId ? { appStoreId: store.appStoreId } : {}),
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
