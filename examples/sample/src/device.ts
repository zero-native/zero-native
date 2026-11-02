// The sample's own native module, declared once in TypeScript (docs/native-modules.md). Native side:
// android/sample/.../DeviceModule.kt. No side effects: nativeModule() only creates a handle.
import { nativeModule, type CallOptions } from "@zero-native/core"

export interface DeviceModule {
  info(): Promise<{ model: string; android: string; sdk: number }>
  /** Answers after `ms`; can be cancelled with an AbortSignal. */
  slowEcho(args: { text: string; ms: number }, options?: CallOptions): Promise<string>
  /** Always rejects with code "no_luck" (to show error codes). */
  fail(): Promise<never>
  /** Reads "dev.fromJs" through Kotlin's ZnStorage and writes dev.fromKotlin / kotlinNumber / kotlinFlag. */
  storageEcho(): Promise<{ fromJs: string | null; typeError: string }>
  /** A background thread writes dev.hammer.kotlin and dev.hammer.shared `count` times. */
  storageHammer(args: { count: number }): Promise<{ count: number; ms: number }>
  /** v2, debug builds only: crashes the app (a Kotlin exception on the main thread), to test the OTA watchdog. */
  crash(): Promise<never>
  /** v3, debug builds only: opens the mock UPI app for a result, to test a link arriving while it is on top. */
  openMockUpi(): Promise<boolean>
  events: {
    /** A counter every 50 ms, only while someone listens; if JS is busy only the newest value arrives. */
    tick: number
  }
}

export const Device = nativeModule<DeviceModule>("Device", { version: 3 })
