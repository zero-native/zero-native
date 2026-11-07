// The Google advertising id, for ad attribution (2026-11-07). Native side: android/.../AdIdPlugin.kt. README: Play's
// rules for using it.
//
//   import { AdId } from "@zero-native/ad-id"
//   const { id, limitAdTracking } = await AdId.get()
//   if (id !== null && !limitAdTracking) attribution.setAdId(id)
//
// Never rejects. `id` is null when the phone has no Play services, Play services fails, or the user deleted the id
// (Android 12+ gives all zeros then). `limitAdTracking` true: the user turned off ads personalisation. The id can still
// be there then (Android 11 and older): don't use it for personalised ads or ad profiles.
import { nativeModule, type CallOptions } from "@zero-native/core"

export interface AdIdInfo {
  /** The advertising id, or null when there is none to use. */
  id: string | null
  /** The user turned off ads personalisation (or deleted the id). */
  limitAdTracking: boolean
}

interface AdIdModule {
  get(args?: Record<string, never>, options?: CallOptions): Promise<AdIdInfo | null>
}

const Native = nativeModule<AdIdModule>("AdId", { version: 1 })
const unowned: CallOptions = { owned: false } // module-level code and stores call it too

const NONE: AdIdInfo = { id: null, limitAdTracking: false }

export const AdId = {
  /**
   * Reads the id from Play services (a few ms; longer while Play services is busy). Read it each time you need it:
   * the user can delete or reset it at any time. An APK without this plugin answers `{ id: null }` too.
   */
  get(): Promise<AdIdInfo> {
    return Native.get({}, unowned).then(
      (v) => (v && typeof v === "object" ? { id: typeof v.id === "string" && v.id ? v.id : null, limitAdTracking: v.limitAdTracking === true } : NONE),
      () => NONE,
    )
  },
}

export default AdId
