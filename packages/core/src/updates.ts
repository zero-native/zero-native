// OTA updates from JS (step 4.5, docs/ota.md §3.5). Built-in native module: android/runtime/.../ZnOta.kt. The app turns
// updates on natively (ZnOta.configure in Application.onCreate); native checks by itself when the app comes on screen
// and returns to the foreground, and a downloaded bundle runs from the next cold start. These calls let a screen show
// what is happening and check on demand. Applying while the app runs (`applyNow`, `holdApply`) comes in step 4.6.
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
  /** True when the next start runs something else than now (an update is installed and waiting). */
  pendingRestart?: boolean
  /** When the last check ended (ms since 1970), its result ("UPDATE NEW_BUNDLE") and its error, if any. */
  lastCheckAt?: number | null
  lastResult?: string | null
  lastError?: string | null
}

export interface UpdateCheckResult {
  /** What the server said: NONE, UPDATE (downloaded and installed), USE_LOCAL / BUILT_IN (switched). */
  action: "NONE" | "UPDATE" | "USE_LOCAL" | "BUILT_IN"
  reason: string
  /** The bundle installed or switched to. */
  bundle?: string
  /** Set when the check failed ("server: check answered HTTP 500"). */
  error?: string
  status: UpdateStatus
}

interface UpdatesModule {
  status(): Promise<UpdateStatus>
  check(): Promise<UpdateCheckResult>
  events: { status: UpdateStatus }
}

const Module = nativeModule<UpdatesModule>("Updates", { version: 1 })

export const Updates = {
  /** Where updates stand now. */
  status: (): Promise<UpdateStatus> => Module.status(),
  /** Checks now (one at a time; native also checks on its own), and downloads and installs what the server says. */
  check: (): Promise<UpdateCheckResult> => Module.check(),
  /** Hears every change (phase, download progress). Returns the unsubscribe function; ends with the screen. */
  onStatus: (handler: (status: UpdateStatus) => void): (() => void) => Module.on("status", handler),
}
