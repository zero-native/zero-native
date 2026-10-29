// The sample's own native module, declared once in TypeScript (docs/native-modules.md). Native side:
// android/sample/.../DeviceModule.kt. No side effects: nativeModule() only creates a handle.
import { nativeModule, type CallOptions } from "@zero-native/core"

export interface DeviceModule {
  info(): Promise<{ model: string; android: string; sdk: number }>
  /** Answers after `ms`; can be cancelled with an AbortSignal. */
  slowEcho(args: { text: string; ms: number }, options?: CallOptions): Promise<string>
  /** Always rejects with code "no_luck" (to show error codes). */
  fail(): Promise<never>
  events: {
    /** A counter every 50 ms, only while someone listens; if JS is busy only the newest value arrives. */
    tick: number
  }
}

export const Device = nativeModule<DeviceModule>("Device", { version: 1 })
