// Store update rules (Play / App Store): "phones below version V should (1) or must (2) update from the store".
// Same meaning as the ZeroBill RN backend (RN repo tools/release/core/storeDecide.ts, backend otaDecide decideStore):
//   optional threshold = the highest version with critical >= 1; forced threshold = the highest with critical 2.
//   A phone below the forced threshold must update; below the optional one it is asked; else nothing.
//   Test rows (Play internal app sharing, TestFlight) count only for a phone whose own version is a test row, so a
//   test build can be asked to update while customers see nothing.
// iOS versions are compared as one number: "1.6.2" → 1_006_002 (each part up to 999).

export type Os = "android" | "ios"
export const OSES: Os[] = ["android", "ios"]

export interface StoreRule {
  version: number
  critical: 0 | 1 | 2
  isTest: boolean
  /** What the app's own update screen may show (optional; the app has its own default text). */
  title?: string | null
  message?: string | null
}

export interface StoreAnswer {
  /** The store version the phone should reach: Android versionCode, iOS "1.6.2". */
  version: number | string
  critical: 1 | 2
  title?: string
  message?: string
}

export function iosVersionNumber(v: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?$/.exec(v.trim())
  if (!m) return null
  return Number(m[1]) * 1_000_000 + Number(m[2] ?? 0) * 1_000 + Number(m[3] ?? 0)
}

export function iosVersionString(n: number): string {
  return `${Math.floor(n / 1_000_000)}.${Math.floor(n / 1_000) % 1_000}.${n % 1_000}`
}

/** The version as a number for this OS, or null if it isn't one ("1.6.2" on iOS, a whole number on Android). */
export function versionNumber(os: Os, v: string | number): number | null {
  if (os === "ios") return typeof v === "number" ? v : iosVersionNumber(v)
  const n = typeof v === "number" ? v : Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

function thresholds(rules: StoreRule[]) {
  let optional: StoreRule | null = null
  let forced: StoreRule | null = null
  for (const r of rules) {
    if (r.critical >= 1 && (!optional || r.version > optional.version)) optional = r
    if (r.critical === 2 && (!forced || r.version > forced.version)) forced = r
  }
  return { optional, forced }
}

/** The store answer for a phone at [phoneVersion], or null when it has nothing to do. */
export function decideStore(os: Os, rules: StoreRule[], phoneVersion: number): StoreAnswer | null {
  const isTestPhone = rules.some((r) => r.isTest && r.version === phoneVersion)
  const { optional, forced } = thresholds(isTestPhone ? rules : rules.filter((r) => !r.isTest))
  const show = (v: number) => (os === "ios" ? iosVersionString(v) : v)
  const text = (r: StoreRule) => ({ ...(r.title ? { title: r.title } : {}), ...(r.message ? { message: r.message } : {}) })
  if (forced && phoneVersion < forced.version) {
    // Must update; aim at the newest version anyone is asked for, so a forced phone doesn't land below the optional one.
    const aim = optional && optional.version > forced.version ? optional : forced
    return { version: show(aim.version), critical: 2, ...text(forced) }
  }
  if (optional && phoneVersion < optional.version) return { version: show(optional.version), critical: 1, ...text(optional) }
  return null
}

/** Problems with a rule before it is saved (also checked in the dashboard). */
// A forced rule for customers (not a test row) needs the typed confirmation: it stops every older phone at the door.
export function ruleProblems(os: Os, r: { version: number | null; critical: number; isTest: boolean }, confirm?: string): string[] {
  const p: string[] = []
  if (r.version === null || !Number.isInteger(r.version) || r.version <= 0) p.push(os === "ios" ? "version must look like 1.6.2" : "version must be a versionCode (a whole number)")
  if (![0, 1, 2].includes(r.critical)) p.push("critical must be 0, 1 or 2")
  if (r.critical === 2 && !r.isTest && r.version !== null) {
    const shown = os === "ios" ? iosVersionString(r.version) : String(r.version)
    if (confirm !== `FORCE UPDATE ${shown}`) p.push(`type the confirmation exactly: FORCE UPDATE ${shown}`)
  }
  return p
}
