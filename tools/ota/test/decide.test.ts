import { describe, expect, test } from "bun:test"
import type { Manifest, Pointer } from "../core"
import { decide, missing, rolloutBucket, type CheckRequest } from "../decide"
import { BUILT_IN } from "../signing"

const caps = { registry: 8, bytecode: 99, hostApi: 2, hostApiOldest: 1, modules: { Fetch: 1, Device: 2 } }
const sig = { keyId: "k", value: "s" }

function bundle(serial: number, requires = { registry: 8, bytecode: 99, hostApi: 2, modules: { Fetch: 1 } }): Manifest {
  return {
    format: 1, app: "sample", id: `sample_${serial}`, serial, bundleSha256: `sha${serial}`, requires,
    zip: { path: `sample/bundles/sample_${serial}/z.zip`, sha256: "z", size: 1 }, git: { commit: "c", dirty: false },
    builtAt: "t", signature: sig,
  }
}
function pointer(seq: number, target: string, rollout = 100): Pointer {
  return { format: 1, app: "sample", channel: "production", seq, target, rollout, priority: "normal", at: "t", signature: sig }
}
function req(over: Partial<CheckRequest> = {}): CheckRequest {
  return {
    app: "sample", channel: "production", installId: "install-1", capabilities: caps,
    running: null, builtIn: { id: "sample_10", serial: 10 }, kept: [], seq: 0, ...over,
  }
}
/** An install id in (or out of) the rollout for [percent]. */
function installWhere(inside: boolean, percent: number): string {
  for (let i = 0; ; i++) {
    const id = `install-${i}`
    if ((rolloutBucket(id, "sample", "production") < percent) === inside) return id
  }
}

describe("decide: one row at a time, in order", () => {
  test("1 nothing published → NONE NO_CHANNEL", () => {
    expect(decide(req(), null, null)).toEqual({ action: "NONE", reason: "NO_CHANNEL" })
  })

  test("2 the server's pointer is older than the phone's → NONE STALE_SEQ, pointer not sent", () => {
    expect(decide(req({ seq: 9 }), pointer(8, "sample_12"), bundle(12))).toEqual({ action: "NONE", reason: "STALE_SEQ" })
  })

  test("3 kill switch → BUILT_IN; a phone already on its built-in bundle only records the seq", () => {
    const k = pointer(5, BUILT_IN)
    const onDownloaded = decide(req({ running: { id: "sample_12", sha256: "x" }, seq: 4 }), k, null)
    expect([onDownloaded.action, onDownloaded.reason, onDownloaded.pointer?.seq]).toEqual(["BUILT_IN", "KILL_SWITCH", 5])
    const onBuiltIn = decide(req({ seq: 4 }), k, null)
    expect([onBuiltIn.action, onBuiltIn.pointer?.seq]).toEqual(["NONE", 5])
    expect(decide(req({ seq: 5 }), k, null).pointer).toBeUndefined() // same seq: nothing new to record
  })

  test("4 the phone runs the target → NONE UP_TO_DATE (pointer sent if its seq is newer)", () => {
    const d = decide(req({ running: { id: "sample_12", sha256: "x" }, seq: 3 }), pointer(4, "sample_12"), bundle(12))
    expect([d.action, d.reason, d.pointer?.seq, d.bundle]).toEqual(["NONE", "UP_TO_DATE", 4, undefined])
  })

  test("5 outside the rollout → NONE NOT_IN_ROLLOUT, pointer not sent", () => {
    const d = decide(req({ installId: installWhere(false, 10) }), pointer(1, "sample_12", 10), bundle(12))
    expect(d).toEqual({ action: "NONE", reason: "NOT_IN_ROLLOUT" })
    expect(decide(req({ installId: installWhere(true, 10) }), pointer(1, "sample_12", 10), bundle(12)).action).toBe("UPDATE")
  })

  test("6 the pointer names a bundle the store lacks → NONE MISSING_BUNDLE", () => {
    expect(decide(req(), pointer(1, "sample_12"), null)).toEqual({ action: "NONE", reason: "MISSING_BUNDLE" })
  })

  test("7 the APK's own bundle is the same or newer → BUILT_IN APK_NEWER (or nothing, if it runs it already)", () => {
    const d = decide(req({ running: { id: "sample_12", sha256: "x" } }), pointer(2, "sample_9"), bundle(9))
    expect([d.action, d.reason]).toEqual(["BUILT_IN", "APK_NEWER"]) // a rollback below the APK: run the APK's
    expect(decide(req(), pointer(2, "sample_10"), bundle(10)).action).toBe("NONE")
  })

  test("8 the app can't run it → NONE INCOMPATIBLE with what it lacks, pointer not sent", () => {
    const needsScanner = bundle(12, { registry: 8, bytecode: 99, hostApi: 2, modules: { Scanner: 1 } })
    expect(decide(req(), pointer(1, "sample_12"), needsScanner)).toEqual({
      action: "NONE", reason: "INCOMPATIBLE", detail: "needs native module Scanner",
    })
  })

  test("9 the phone keeps the bundle → USE_LOCAL KEPT (a rollback downloads nothing)", () => {
    const d = decide(req({ running: { id: "sample_12", sha256: "x" }, kept: ["sample_11", "sample_12"], seq: 6 }), pointer(7, "sample_11"), bundle(11))
    expect([d.action, d.reason, d.bundle?.id, d.pointer?.seq]).toEqual(["USE_LOCAL", "KEPT", "sample_11", 7])
  })

  test("10 otherwise → UPDATE NEW_BUNDLE with the bundle and the pointer", () => {
    const d = decide(req({ seq: 1 }), pointer(2, "sample_12"), bundle(12))
    expect([d.action, d.reason, d.bundle?.id, d.pointer?.seq]).toEqual(["UPDATE", "NEW_BUNDLE", "sample_12", 2])
  })

  test("11 a change the phone already made (same seq) → NONE ALREADY_DONE, never a change without a pointer", () => {
    const on11 = { running: { id: "sample_11", sha256: "x" }, seq: 7 }
    // Installed #12 and waits for the next start, or #12 threw in applyNow and #11 runs again.
    expect(decide(req({ ...on11, kept: ["sample_12"] }), pointer(7, "sample_12"), bundle(12))).toEqual({ action: "NONE", reason: "ALREADY_DONE" })
    expect(decide(req(on11), pointer(7, "sample_12"), bundle(12))).toEqual({ action: "NONE", reason: "ALREADY_DONE" })
    // Took the kill switch, still runs #11 until the next start.
    expect(decide(req(on11), pointer(7, BUILT_IN), null)).toEqual({ action: "NONE", reason: "ALREADY_DONE" })
    // A newer pointer still decides as before.
    expect(decide(req({ ...on11, kept: ["sample_12"] }), pointer(8, "sample_12"), bundle(12)).action).toBe("USE_LOCAL")
  })
})

describe("rules underneath", () => {
  test("capabilities: same rule as ZnCapabilities.kt", () => {
    const r = { registry: 8, bytecode: 99, hostApi: 2, modules: { Fetch: 1 } }
    expect(missing(caps, r)).toBeNull()
    expect(missing(caps, { ...r, registry: 9 })).toBe("needs registry v9, app has v8")
    expect(missing(caps, { ...r, bytecode: 98 })).toBe("bytecode format 98, app runs 99")
    expect(missing(caps, { ...r, hostApi: 3 })).toBe("needs host API v3, app has v2")
    expect(missing({ ...caps, hostApiOldest: 2 }, { ...r, hostApi: 1 })).toBe("built for host API v1, app runs v2+")
    expect(missing(caps, { ...r, modules: { Device: 3 } })).toBe("needs Device v3, app has v2")
  })

  test("per-OS needs: only the phone's own OS part counts; no os means Android", () => {
    const r = { registry: 8, bytecode: 99, hostApi: 2, modules: { Fetch: 1 }, os: { android: { AdId: 1 }, ios: { Haptics: 1 } } }
    expect(missing(caps, r)).toBe("needs native module AdId") // an older Android app sends no os
    expect(missing({ ...caps, modules: { ...caps.modules, AdId: 1 } }, r)).toBeNull()
    expect(missing({ ...caps, os: "ios" }, r)).toBe("needs native module Haptics")
    expect(missing({ ...caps, os: "ios", modules: { ...caps.modules, Haptics: 1 } }, r)).toBeNull()
  })

  test("Motion on older iOS apps: below host API 10 their Motion v1 is a stub, so no bundle that uses Motion", () => {
    const ios9 = { registry: 24, bytecode: 99, hostApi: 9, hostApiOldest: 1, modules: { Fetch: 1, Motion: 1 }, os: "ios" as const }
    const motion = { registry: 24, bytecode: 99, hostApi: 9, modules: { Fetch: 1, Motion: 1 } }
    const plain = { registry: 24, bytecode: 99, hostApi: 9, modules: { Fetch: 1 } }
    expect(missing(ios9, motion)).toBe("uses Motion; this iOS app (host API v9) has only the Motion stub (the engine is v10+)")
    expect(missing(ios9, plain)).toBeNull() // bundles without motion still reach it
    expect(missing(ios9, { ...plain, os: { ios: { Motion: 1 } } })).toMatch(/Motion stub/)
    expect(missing(ios9, { ...plain, os: { android: { Motion: 1 } } })).toBeNull() // Android's own part doesn't count
    expect(missing({ ...ios9, hostApi: 10 }, motion)).toBeNull() // the engine
    expect(missing({ ...ios9, os: "android" }, motion)).toBeNull() // Android always had the engine
    const { os: _, ...noOs } = ios9
    expect(missing(noOs, motion)).toBeNull() // no os: Android
    // Through the decision: the phone stays on what it runs.
    const d = decide(req({ capabilities: ios9 }), pointer(1, "sample_11"), bundle(11, motion))
    expect(d).toMatchObject({ action: "NONE", reason: "INCOMPATIBLE" })
  })

  test("rollout buckets are stable and spread evenly; raising the rollout only adds installs", () => {
    expect(rolloutBucket("a", "sample", "production")).toBe(rolloutBucket("a", "sample", "production"))
    const buckets = Array.from({ length: 10_000 }, (_, i) => rolloutBucket(`install-${i}`, "sample", "production"))
    const under10 = buckets.filter((b) => b < 10).length
    expect(under10).toBeGreaterThan(850)
    expect(under10).toBeLessThan(1150)
    // Every install inside 10 % is also inside 50 % (same bucket).
    expect(buckets.every((b) => !(b < 10) || b < 50)).toBe(true)
  })
})
