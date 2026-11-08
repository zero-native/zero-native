// Platform: React Native's names for "which OS, which version" (RN basics pack, docs/guide-notes.md §39).
//
//   if (Platform.OS === "android" && Platform.Version >= 33) await Permissions.request(["notifications"])
//   const pad = Platform.select({ android: 8, default: 0 })
//
// Native sends the facts once, right after the main script runs (app event DEVICE, android/runtime/.../ZnWindow.kt),
// before any screen is built. So read them in screens, handlers and startApp; at the top level of a file they are not
// there yet (Version reads 0, with a warning).
//
// iOS (2026-11-08): native gives `nativeConstants("Platform")` = { os: "ios", release } before any JS runs, so `OS` is
// right even at the top level of a file. Android gives none: "android". On iOS, `Version` is the major iOS version as
// a number (18), where React Native gives the string "18.0": read `constants.Release` for that.
import { APP, AppEvent } from "./app-events"
import { nativeConstants } from "./calls"
import { onEvent } from "./events"
import type { NativeValue } from "./native"

export type PlatformOSType = "android" | "ios" | "windows" | "macos" | "web" | "native"

interface Device {
  sdk: number
  release: string
  model: string
  brand: string
  manufacturer: string
}

let device: Device | null = null
let warned = false

function facts(): Device {
  if (device) return device
  if (!warned) {
    warned = true
    globalThis.__zn_log(2, "Platform: read before native sent the phone's facts (top level of a file?); Version is 0 here")
  }
  return { sdk: 0, release: "", model: "", brand: "", manufacturer: "" }
}

let os: PlatformOSType | null = null

function readOS(): PlatformOSType {
  if (os === null) os = nativeConstants<{ os?: string }>("Platform")?.os === "ios" ? "ios" : "android"
  return os
}

export const Platform = {
  /** "android" or "ios". */
  get OS(): PlatformOSType {
    return readOS()
  },

  /** Android: the API level (33 is Android 13), as in React Native. iOS: the major version (18). */
  get Version(): number {
    const d = facts()
    return readOS() === "ios" ? Number.parseInt(d.release, 10) || 0 : d.sdk
  },

  /** React Native's constants that apps use (Android's names; on iOS Brand and Manufacturer are "Apple"). */
  get constants(): { Version: number; Release: string; Model: string; Brand: string; Manufacturer: string } {
    const d = facts()
    return { Version: this.Version, Release: d.release, Model: d.model, Brand: d.brand, Manufacturer: d.manufacturer }
  },

  isTV: false,
  isTesting: false,

  /** The value for this OS (`android` or `ios`), else `native`, else `default`. */
  select<T>(specifics: { android?: T; ios?: T; native?: T; default?: T } & Record<string, T | undefined>): T | undefined {
    const here = readOS()
    if (here in specifics) return specifics[here]
    if ("native" in specifics) return specifics.native
    return specifics.default
  },
}

/** App-level event DEVICE. Called by installRuntime, so it is there before the main script ends. */
export function installPlatform(): void {
  onEvent(APP, AppEvent.Device, (payload: NativeValue) => {
    device = JSON.parse(String(payload)) as Device
  })
}

export function resetPlatformForTests(): void {
  device = null
  os = null
  warned = false
}
