// The update decision (docs/ota.md §3.4): one pure function, tested row by row (decide.test.ts). The reference server
// (server.ts) calls it for every check, and an app's own backend can port it as it is. Rows are checked in order; the
// first that matches decides. Nothing here is trusted by the phone without a signature: the phone checks the pointer
// and bundle signatures, the seq and its capabilities again, so a wrong answer can delay an update, never install a
// wrong one.
import { createHash } from "node:crypto"
import type { BundleRequires } from "../bundle-info"
import type { Manifest, Pointer } from "./core"
import { BUILT_IN } from "./signing"

/** What the app can run (ZnCapabilities.kt on Android). */
export interface Capabilities {
  registry: number
  bytecode: number
  hostApi: number
  hostApiOldest: number
  modules: Record<string, number>
}

/** What the phone sends (POST /v1/check). */
export interface CheckRequest {
  app: string
  channel: string
  /** A random id the app made once (not the user, not the device): picks the rollout bucket. */
  installId: string
  capabilities: Capabilities
  /** The bundle running now: null when it is the APK's built-in bundle. */
  running: { id: string; sha256: string } | null
  /** The APK's built-in bundle. A newer APK always wins over downloaded bundles. */
  builtIn: { id: string; serial: number }
  /** Downloaded bundles kept on the phone (checked), so going back to one downloads nothing. */
  kept: string[]
  /** The highest pointer seq the phone accepted on this channel (0 = none). It never accepts a lower one. */
  seq: number
  /** What happened since the last check (downloaded, applied, rollback, ...), for telemetry only. */
  outcomes?: Outcome[]
}

export interface Outcome {
  kind: string
  bundle?: string
  detail?: string
  at?: string
}

export type Action = "NONE" | "UPDATE" | "USE_LOCAL" | "BUILT_IN"

export type Reason =
  | "NO_CHANNEL" //    nothing was ever published on this channel
  | "STALE_SEQ" //     the server's pointer is older than one the phone already accepted (a stale cache)
  | "KILL_SWITCH" //   the channel points at BUILT_IN
  | "UP_TO_DATE" //    the phone runs what the channel points at
  | "NOT_IN_ROLLOUT" // this install isn't in the rollout % yet
  | "APK_NEWER" //     the APK's own bundle is the same or newer than the pointer's
  | "INCOMPATIBLE" //  this app can't run the bundle (capabilities)
  | "MISSING_BUNDLE" // the pointer names a bundle the store doesn't have (a broken store)
  | "KEPT" //          the phone has the bundle already: switch to it, no download
  | "NEW_BUNDLE" //    download it
  | "ALREADY_DONE" //  the phone already acted on this pointer (same seq) but runs something else: see decide()

export interface Decision {
  action: Action
  reason: Reason
  /** Sent whenever its seq is newer than the phone's, so the phone records it (even with action NONE). */
  pointer?: Pointer
  /** The bundle to download or switch to (UPDATE, USE_LOCAL). */
  bundle?: Manifest
  /** For INCOMPATIBLE: what the app lacks, in words (logs, telemetry). */
  detail?: string
}

/** Why an app with [caps] can't run a bundle that needs [req], or null if it can. Same rule as ZnCapabilities.kt. */
export function missing(caps: Capabilities, req: BundleRequires): string | null {
  if (req.registry > caps.registry) return `needs registry v${req.registry}, app has v${caps.registry}`
  if (req.bytecode !== caps.bytecode) return `bytecode format ${req.bytecode}, app runs ${caps.bytecode}`
  if (req.hostApi > caps.hostApi) return `needs host API v${req.hostApi}, app has v${caps.hostApi}`
  if (req.hostApi < caps.hostApiOldest) return `built for host API v${req.hostApi}, app runs v${caps.hostApiOldest}+`
  for (const [name, v] of Object.entries(req.modules)) {
    const have = caps.modules[name]
    if (have === undefined) return `needs native module ${name}`
    if (have < v) return `needs ${name} v${v}, app has v${have}`
  }
  return null
}

/**
 * The install's rollout bucket, 0–99: stable for an install and channel, so raising the rollout only adds installs
 * (nobody who got a bundle loses it again).
 */
export function rolloutBucket(installId: string, app: string, channel: string): number {
  const h = createHash("sha256").update(`${app}\n${channel}\n${installId}`).digest()
  return h.readUInt32BE(0) % 100
}

/**
 * The decision. [pointer]: the channel's current pointer (null if none); [target]: the manifest it names (null for
 * BUILT_IN, or if the store lacks it).
 */
export function decide(req: CheckRequest, pointer: Pointer | null, target: Manifest | null): Decision {
  const d = decideRow(req, pointer, target)
  // A change without a pointer means the phone has this pointer's seq already, and it saves a seq only once its action
  // is done. It still runs something else because the change waits for the next start, or because the bundle failed
  // on this phone (an `applyNow` whose code threw goes back to the old bundle). The phone can't take a change without
  // a newer signed pointer anyway: nothing to do until the channel moves on.
  if (d.action !== "NONE" && !d.pointer) return { action: "NONE", reason: "ALREADY_DONE" }
  return d
}

function decideRow(req: CheckRequest, pointer: Pointer | null, target: Manifest | null): Decision {
  if (!pointer) return { action: "NONE", reason: "NO_CHANNEL" }
  if (pointer.seq < req.seq) return { action: "NONE", reason: "STALE_SEQ" }
  // From here the pointer is the phone's or newer; send it whenever it is newer, so the phone records the seq.
  const withPointer = <T extends Decision>(d: T): T => (pointer.seq > req.seq ? { ...d, pointer } : d)

  if (pointer.target === BUILT_IN) {
    return withPointer({ action: req.running === null ? "NONE" : "BUILT_IN", reason: "KILL_SWITCH" })
  }
  if (req.running?.id === pointer.target) return withPointer({ action: "NONE", reason: "UP_TO_DATE" })
  if (rolloutBucket(req.installId, req.app, req.channel) >= pointer.rollout) {
    // Not in the rollout: nothing changes, and the pointer isn't sent (the phone records it once it is in).
    return { action: "NONE", reason: "NOT_IN_ROLLOUT" }
  }
  if (!target) return { action: "NONE", reason: "MISSING_BUNDLE" }
  if (req.builtIn.serial >= target.serial) {
    // The APK carries this bundle or a newer one: run that (a phone already on it has nothing to do).
    return withPointer({ action: req.running === null ? "NONE" : "BUILT_IN", reason: "APK_NEWER" })
  }
  const lacks = missing(req.capabilities, target.requires)
  if (lacks) return { action: "NONE", reason: "INCOMPATIBLE", detail: lacks }
  if (req.kept.includes(target.id)) return withPointer({ action: "USE_LOCAL", reason: "KEPT", bundle: target })
  return withPointer({ action: "UPDATE", reason: "NEW_BUNDLE", bundle: target })
}
