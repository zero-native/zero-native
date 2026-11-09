// OTA updates from JS (steps 4.5, 4.6, docs/ota.md §3.5). Built-in native module: android/runtime/.../ZnOta.kt. The app
// turns updates on natively (ZnOta.configure in Application.onCreate); native checks by itself when the app comes on
// screen and returns to the foreground, and a downloaded bundle runs from the next cold start. These calls let a screen
// show what is happening, check on demand, run an installed update now (`applyNow`), and keep it from being applied
// in place during a payment or a form (`holdApply`). Safety nets (step 4.7, §3.6): a new bundle that fails before it
// is healthy is rolled back by native; `markHealthy` says "healthy" earlier than the automatic 4 s mark.
import { nativeModule } from "./calls"

export interface UpdateStatus {
  /** False when the app didn't call ZnOta.configure (then phase is "off" and nothing else is set). */
  enabled: boolean
  phase: "off" | "idle" | "checking" | "downloading" | "installing" | "failed"
  /** 0–1 while downloading. */
  progress: number
  channel?: string
  /** The bundle running now (`app_12`); null = the APK's own bundle. */
  running?: string | null
  /** The APK's own bundle id. */
  builtIn?: string | null
  /** What runs from the next cold start; null = the APK's own bundle. */
  next?: string | null
  /** True when the next start runs something else than now (an update is installed and waiting): see `applyNow`. */
  pendingRestart?: boolean
  /**
   * The priority of the waiting update (when `pendingRestart`): 0 normal (runs from the next start), 1 high, 2 critical
   * (a kill switch too). An app's gates call `applyNow` at a calm moment for 2 (and 1 if it likes), never in a payment.
   * Missing on apps built before 2026-11-09.
   */
  nextPriority?: 0 | 1 | 2
  /** True while some code holds updates (`holdApply`). */
  held?: boolean
  /** True once the running bundle was marked healthy (`markHealthy`, or 4 s after its first screens); always for the APK's. */
  healthy?: boolean
  /** Where a rollback goes: the last bundle marked healthy on this phone; null = the APK's own bundle. */
  lastGood?: string | null
  /** Bundles blocked on this phone by the safety nets: "error" (failed before healthy) or "watchdog" (crashes). */
  blocked?: Record<string, "error" | "watchdog">
  /** True when OTA is off in this process (its start-up failed; twice in a row: until the next APK install). */
  otaOff?: boolean
  /** When the last check ended (ms since 1970), its result ("UPDATE NEW_BUNDLE") and its error, if any. */
  lastCheckAt?: number | null
  lastResult?: string | null
  lastError?: string | null
  /**
   * The store update answer that came with the last check (the same call as OTA, docs/zn-updates-server.md), for this
   * APK; null before the first one (or an older server). `update` null = nothing to do. What to do with it (Play's
   * in-app update, an App Store link, your own screen) is the app's call: `@zero-native/app-updates` does Play's.
   * A new answer comes with a `status` event (`onStatus`) after each check: compare `at`. Missing on apps built
   * before 2026-11-10.
   */
  store?: StoreStatus | null
}

/** The store part of `UpdateStatus`. */
export interface StoreStatus {
  update: {
    /** The store version to reach: Android versionCode, iOS "1.6.2". */
    version: number | string
    /** 1 = optional, 2 = forced. */
    critical: 1 | 2
    /** The rule's own words for the app's update screen, if it has them. */
    title?: string
    message?: string
  } | null
  /** iOS: the App Store id, when the server knows it. */
  appStoreId?: string
  /** When this answer came (ms since 1970). */
  at: number
}

export interface UpdateCheckResult {
  /** What the server said: NONE, UPDATE (downloaded and installed), USE_LOCAL / BUILT_IN (switched). */
  action: "NONE" | "UPDATE" | "USE_LOCAL" | "BUILT_IN"
  /** The server's reason, or the phone's: BLOCKED (the channel's bundle is blocked here), OTA_OFF, OFF, ERROR. */
  reason: string
  /** The bundle installed or switched to. */
  bundle?: string
  /** Set when the check failed ("server: check answered HTTP 500"). */
  error?: string
  status: UpdateStatus
}

/** Why `applyNow` applied nothing. When it does apply, this JS is replaced and its Promise never settles. */
export interface ApplyRefused {
  applied: false
  /**
   * off: updates are off. held: some code holds updates (`holdApply`). busy: an apply is in progress. not_started: the
   * app's screens aren't up yet. nothing: the next start runs what runs now. failed: the installed bundle can't run
   * here (`error` says why; nothing changed). If its code throws while starting, this JS is already gone: the old
   * bundle runs again with its screens opened again, stays current, and `status().lastError` says what happened.
   */
  reason: "off" | "held" | "busy" | "not_started" | "nothing" | "failed"
  error?: string
}

interface UpdatesModule {
  status(): Promise<UpdateStatus>
  check(): Promise<UpdateCheckResult>
  applyNow(args?: { open?: string }): Promise<ApplyRefused>
  hold(args?: Record<string, never>, options?: { signal?: AbortSignal }): Promise<never>
  markHealthy(): Promise<void>
  events: { status: UpdateStatus }
}

const Module = nativeModule<UpdatesModule>("Updates", { version: 3 })

export const Updates = {
  /** Where updates stand now. */
  status: (): Promise<UpdateStatus> => Module.status(),
  /** Checks now (one at a time; native also checks on its own), and downloads and installs what the server says. */
  check: (): Promise<UpdateCheckResult> => Module.check(),
  /** Hears every change (phase, download progress). Returns the unsubscribe function; ends with the screen. */
  onStatus: (handler: (status: UpdateStatus) => void): (() => void) => Module.on("status", handler),
  /**
   * Runs the installed update now (`status().pendingRestart`), without restarting the app: the JS is replaced by the
   * new bundle's, and the open screens open again by route and params, with fresh state (like after Android restored
   * the app). Storage and SecureStore stay as they are. Call it at a calm moment (the user on the home screen, or
   * after they tapped "Update now"), never in the middle of a flow. If it applies, the Promise never settles: this code
   * is gone. Otherwise it resolves with the reason.
   *
   * `open`: a link of this app (as a deep link would come, e.g. "myapp://scan") opened on top once the screens are
   * open again. For a gate before a flow: the user tapped Scan, the update applies, and the scanner opens in the new
   * bundle. Apps built before 2026-11-09 ignore it (they apply without opening it).
   */
  applyNow: (options?: { open?: string }): Promise<ApplyRefused> =>
    Module.applyNow(options?.open ? { open: options.open } : undefined),
  /**
   * Keeps updates from being applied in place (`applyNow` answers "held") until the returned function is called, or
   * the screen (or component) that called it closes. For payments, forms, anything that must not be cut. Called
   * outside a screen, only the returned function releases it. Cold starts are not affected.
   */
  holdApply: (): (() => void) => {
    const controller = new AbortController()
    Module.hold({}, { signal: controller.signal }).catch(() => {}) // settles only as "cancelled", on release
    let held = true
    return () => {
      if (!held) return
      held = false
      controller.abort()
    }
  },
  /**
   * Says the running bundle works: call it once the first screen has really loaded (its data is on screen). Until a
   * new bundle is healthy, an error screen or a crash rolls it back to the last healthy one. Without this call it
   * becomes healthy 4 s after its first screens are up in the foreground (`ZnOta.Config.healthyAfterMs`; 0 = only
   * this call). Calling it again, or on the APK's own bundle, does nothing.
   */
  markHealthy: (): Promise<void> => Module.markHealthy(),
}
