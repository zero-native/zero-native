// Platform: React Native's names for "which OS, which version" (RN basics pack, docs/guide-notes.md §39).
//
//   if (Platform.OS === "android" && Platform.Version >= 33) await Permissions.request(["notifications"])
//   const pad = Platform.select({ android: 8, default: 0 })
//
// Native sends the facts once, right after the main script runs (app event DEVICE, android/runtime/.../ZnWindow.kt),
// before any screen is built. So read them in screens, handlers and startApp; at the top level of a file they are not
// there yet (Version reads 0, with a warning).
import { APP, AppEvent } from "./app-events"
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

export const Platform = {
  /** Always "android" today. iOS comes later. */
  OS: "android" as PlatformOSType,

  /** The Android API level (33 is Android 13), a number, as in React Native. */
  get Version(): number {
    return facts().sdk
  },

  /** React Native's Android constants that apps use. */
  get constants(): { Version: number; Release: string; Model: string; Brand: string; Manufacturer: string } {
    const d = facts()
    return { Version: d.sdk, Release: d.release, Model: d.model, Brand: d.brand, Manufacturer: d.manufacturer }
  },

  isTV: false,
  isTesting: false,

  /** The value for this OS: `android`, else `native`, else `default`. */
  select<T>(specifics: { android?: T; ios?: T; native?: T; default?: T } & Record<string, T | undefined>): T | undefined {
    if ("android" in specifics) return specifics.android
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
  warned = false
}
