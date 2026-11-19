// The test plugin's native module, declared once in TypeScript (docs/native-modules.md). Native side:
// android/.../DeviceModule.kt. No side effects: nativeModule() only creates a handle.
import { nativeModule, nativeMotion, type CallOptions, type MotionSource, type MotionTiming } from "@zeronative/core"

/** launched false: the other app didn't open. */
export interface LaunchStarted {
  launched: boolean
  reason?: string
}

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
  /** v4, debug builds only: opens the mock UPI app for a result, under the launch key "mock-upi". */
  openMockUpi(args: { id: string }): Promise<LaunchStarted>
  /** v4, debug builds only: a launch of an app that isn't installed, under the key "mock-missing". */
  openMissingApp(args: { id: string }): Promise<LaunchStarted>
  /** v5: runs a background task; answers DONE, FAILED, NO_TASK or TIMED_OUT. */
  runTask(args: { name: string; timeoutMs: number }): Promise<string>
  /** v5: writes a small picture to the handle folder. */
  makeFile(): Promise<{ handle: string; outsideRefused: boolean }>
  /** v6: the motion value `id` goes round a circle natively, each frame (a plugin motion source). Use orbit(). */
  orbit(args: { id: number; radius: number; periodMs: number; axis: "x" | "y" }): Promise<void>
  events: {
    /** A counter every 50 ms, only while someone listens; if JS is busy only the newest value arrives. */
    tick: number
  }
}

export const Device = nativeModule<DeviceModule>("Device", { version: 6 })

/**
 * v6, lab 9: a motion value a native plugin moves each frame (x or y of a circle). Bind it like any motion value.
 * The plugin's own helper, so a bundle that uses it needs this plugin.
 */
export function orbit(options: { radius?: number; periodMs?: number; axis?: "x" | "y" } = {}): MotionSource {
  return nativeMotion((id) => Device.orbit({ id, radius: options.radius ?? 40, periodMs: options.periodMs ?? 2000, axis: options.axis ?? "x" }))
}

/** v6, lab 9: the plugin's "device.wobble" curve for v.to(x, wobble()): it overshoots and rings like a bell. */
export function wobble(options: { rings?: number; ms?: number } = {}): MotionTiming {
  return { driver: "device.wobble", params: { rings: options.rings ?? 3, ms: options.ms ?? 900 } }
}
