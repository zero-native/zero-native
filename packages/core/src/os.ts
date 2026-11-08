// Os: small things about the phone. Native side: android/runtime/.../ZnOs.kt. Guide: docs/guide-notes.md §33.
//
//   Os.haptic("success")
//   Os.openUrl("https://example.com/help")
//   const { appVersion } = await Os.info()
import { callNative } from "./calls"

export interface OsInfo {
  appVersion: string
  appBuild: number
  /**
   * The installed app's id (Gradle's applicationId, with any flavor suffix), as RN's DeviceInfo.getBundleId().
   * Missing on APKs from before 2026-11-06: an OTA bundle must not treat "missing" as production.
   */
  packageName?: string
  android: string
  sdk: number
  model: string
  manufacturer: string
  /** True when the phone's language reads right to left (the app must set android:supportsRtl). */
  rtl: boolean
}

export type Haptic = "light" | "medium" | "success" | "error"

// v2: share's subject and dialogTitle, canOpenUrl (RN basics pack).
const call = <T>(method: string, args: Record<string, unknown> = {}) =>
  callNative<T>("Os", method, { ...args, __v: 2 }, { owned: false })

export const Os = {
  info: () => call<OsInfo>("info"),

  /** A small buzz. False if the phone gave none (the user turned touch feedback off, say). */
  haptic: (kind: Haptic) => call<boolean>("haptic", { kind }),

  /** The app's page in Android settings: the only way out of a "blocked" permission. */
  openSettings: () => call<boolean>("openSettings"),

  /** Android's share sheet, for plain text. `subject`: an email's subject; `dialogTitle`: the sheet's title. */
  share: (args: { text: string; subject?: string; dialogTitle?: string }) => call<boolean>("share", args),

  /** Opens a link in another app, any scheme as in RN; intent:, file:, javascript: and no scheme are `not_allowed`. `no_app`: nothing can open it. */
  openUrl: (url: string) => call<boolean>("openUrl", { url }),

  /** True if some app can open [url]. False for any link openUrl would refuse. */
  canOpenUrl: (url: string) => call<boolean>("canOpenUrl", { url }),
}
