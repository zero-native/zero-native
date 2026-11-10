// The Crashlytics plugin's JS side. Native side: android/.../CrashlyticsPlugin.kt (Firebase Crashlytics).
//
// Most apps need no JS at all: every JS error already goes to Crashlytics as a non-fatal, with its JS stack, the
// running bundle and the top route (the plugin hooks core's error path natively, like RN Firebase's global handler).
// JS is for what only the app knows:
//
//   Crashlytics.setUserId(customerCode)                  // an id of yours. Never a phone number or an email
//   Crashlytics.log("checkout: pay tapped")              // breadcrumbs, shown with the next report
//   try { ... } catch (e) { Crashlytics.recordError(e, "Checkout.verify") }   // an error you caught yourself
//   await Crashlytics.setCrashlyticsCollectionEnabled(false)                   // the user opted out
//
// Each call answers with a value and never rejects. With no Firebase in the app (no google-services.json) every call
// does nothing, and `status()` says `available: false`.
import { nativeModule, type CallOptions } from "@zero-native/core"

export interface CrashlyticsStatus {
  /** False: Firebase isn't set up in this app (no google-services.json), or the plugin is missing. */
  available: boolean
  /** Reports are sent. Firebase keeps this setting across starts. */
  enabled: boolean
}

/** What a key's value can be. */
export type AttributeValue = string | number | boolean

/** Which crash `crash()` makes. "native": a SIGSEGV, seen only with firebase-crashlytics-ndk (README). */
export type CrashKind = "kotlin" | "native"

export interface CrashlyticsModule {
  status(args?: Record<string, never>, options?: CallOptions): Promise<CrashlyticsStatus>
  setCollectionEnabled(args: { on: boolean }, options?: CallOptions): Promise<CrashlyticsStatus>
  log(args: { message: string }, options?: CallOptions): Promise<boolean>
  recordError(args: { name?: string; message: string; stack?: string; tag?: string }, options?: CallOptions): Promise<boolean>
  setAttribute(args: { key: string; value: AttributeValue }, options?: CallOptions): Promise<boolean>
  setAttributes(args: { values: Record<string, AttributeValue> }, options?: CallOptions): Promise<boolean>
  setUserId(args: { id: string }, options?: CallOptions): Promise<boolean>
  crash(args: { kind: CrashKind }, options?: CallOptions): Promise<boolean>
}

const Native = nativeModule<CrashlyticsModule>("FirebaseCrashlytics", { version: 1 })
// Not tied to a screen: a log line or a report must not be cancelled because the screen that sent it closed.
const unowned = { owned: false }
const off: CrashlyticsStatus = { available: false, enabled: false }
let lastEnabled = false

function status(): Promise<CrashlyticsStatus> {
  return Native.status({}, unowned).then(remember, () => off)
}

function remember(s: CrashlyticsStatus): CrashlyticsStatus {
  lastEnabled = s.enabled
  return s
}

/** The parts of a thrown value Crashlytics needs: Hermes' stack has the frames `ota symbolicate` maps to TSX. */
function parts(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack }
  if (typeof error === "string") return { message: error }
  try {
    return { message: JSON.stringify(error) ?? String(error) }
  } catch {
    return { message: String(error) }
  }
}

const quietly = (p: Promise<boolean>) => p.catch(() => false)

export const Crashlytics = {
  /** `{ available, enabled }`. No dialog, no network. */
  status,

  /** A breadcrumb: shown with the next crash or non-fatal of this launch (Crashlytics keeps the last 64 KB). */
  log: (message: string): Promise<boolean> => quietly(Native.log({ message: String(message) }, unowned)),

  /**
   * An error your code caught, as a non-fatal with its JS stack. [tag] says where (RN Firebase's `jsErrorName`):
   * "Checkout.verify". Errors nobody caught are sent by themselves: don't send them again here.
   */
  recordError: (error: unknown, tag?: string): Promise<boolean> =>
    quietly(Native.recordError({ ...parts(error), ...(tag ? { tag } : {}) }, unowned)),

  /** A key on every later report of this launch. Keep private data out: keys are shown to everyone with console access. */
  setAttribute: (key: string, value: AttributeValue): Promise<boolean> => quietly(Native.setAttribute({ key, value }, unowned)),

  setAttributes: (values: Record<string, AttributeValue>): Promise<boolean> => quietly(Native.setAttributes({ values }, unowned)),

  /** Your own user id (a customer code), "" to clear it on logout. Never a phone number, an email or a VPA. */
  setUserId: (id: string): Promise<boolean> => quietly(Native.setUserId({ id }, unowned)),

  /** Turns sending on or off (the user's choice), kept across starts. Answers the new status. */
  setCrashlyticsCollectionEnabled: (on: boolean): Promise<CrashlyticsStatus> =>
    Native.setCollectionEnabled({ on }, unowned).then(remember, () => off),

  /** RN Firebase's property: the last value `status()` or `setCrashlyticsCollectionEnabled` saw. */
  get isCrashlyticsCollectionEnabled(): boolean {
    return lastEnabled
  },

  /** Crashes the app on purpose, to test the setup. The report arrives on the next start. */
  crash: (kind: CrashKind = "kotlin"): Promise<boolean> => quietly(Native.crash({ kind }, unowned)),
}

/** RN Firebase's names, for code that ports over: `crashlytics().log(...)`, `getCrashlytics()`. */
export const crashlytics = () => Crashlytics
export const getCrashlytics = () => Crashlytics
