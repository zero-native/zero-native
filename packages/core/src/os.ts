// Os: small things about the phone. Native side: android/runtime/.../ZnOs.kt. Guide: docs/guide-notes.md §33.
//
//   Os.haptic("success")
//   Os.openUrl("https://example.com/help")
//   const { appVersion } = await Os.info()
import { callNative } from "./calls"

export interface OsInfo {
  appVersion: string
  appBuild: number
  android: string
  sdk: number
  model: string
  manufacturer: string
}

export type Haptic = "light" | "medium" | "success" | "error"

const call = <T>(method: string, args: Record<string, unknown> = {}) =>
  callNative<T>("Os", method, { ...args, __v: 1 }, { owned: false })

export const Os = {
  info: () => call<OsInfo>("info"),

  /** A small buzz. False if the phone gave none (the user turned touch feedback off, say). */
  haptic: (kind: Haptic) => call<boolean>("haptic", { kind }),

  /** The app's page in Android settings: the only way out of a "blocked" permission. */
  openSettings: () => call<boolean>("openSettings"),

  /** Android's share sheet, for plain text. */
  share: (args: { text: string }) => call<boolean>("share", args),

  /** Opens a link in another app. Only http, https, mailto and tel: anything else is `not_allowed`. `no_app`: nothing can open it. */
  openUrl: (url: string) => call<boolean>("openUrl", { url }),
}
