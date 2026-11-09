import { beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeBundleInfo } from "../../bundle-info"
import * as core from "../core"
import { BUILT_IN, generateKeys, pointerText, requiresLine, verifyText } from "../signing"
import { LocalStore } from "../store"

const requires = { registry: 8, bytecode: 99, hostApi: 2, modules: { Fetch: 1, Device: 1 } }
const keys = generateKeys()
const backup = generateKeys()
let ctx: core.Context
let clock = 0

/** A built bundle folder, as the app's build writes it (serial 0). [code] changes main.hbc's bytes. */
async function built(code: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "zn-ota-test-built-"))
  writeFileSync(join(dir, "main.hbc"), code)
  writeFileSync(join(dir, "main.zn.ui"), "templates")
  writeFileSync(join(dir, "main.zn.ui.json"), "{}")
  await writeBundleInfo(dir, { app: "sample", serial: 0, names: ["main.hbc", "main.zn.ui", "main.zn.ui.json"], requires })
  return dir
}

const clean = { commit: "abc123", dirty: false }

beforeEach(() => {
  ctx = {
    store: new LocalStore(mkdtempSync(join(tmpdir(), "zn-ota-test-store-"))),
    app: "sample",
    privatePem: keys.privatePem,
    now: () => new Date(Date.UTC(2026, 9, 30, 10, 0, clock++)),
  }
})

describe("build: one bundle = one serial = one SHA", () => {
  test("new bytes take the next serial; the same bytes reuse it; it never publishes", async () => {
    const a = await core.releaseBuilt(ctx, await built("v1"), clean)
    expect([a.manifest.serial, a.manifest.id, a.reused]).toEqual([1, "sample_1", false])
    const again = await core.releaseBuilt(ctx, await built("v1"), clean)
    expect([again.manifest.serial, again.reused]).toEqual([1, true])
    const b = await core.releaseBuilt(ctx, await built("v2"), clean)
    expect(b.manifest.serial).toBe(2)
    expect(await core.current(ctx, "staging")).toBeNull()
    expect(requiresLine(b.manifest.requires)).toBe("registry=8;bytecode=99;hostApi=2;modules=Device:1,Fetch:1")
  })

  test("the released zip holds the files with the serial stamped in zn-bundle.json", async () => {
    const { manifest } = await core.releaseBuilt(ctx, await built("v1"), clean)
    const zip = await ctx.store.read(manifest.zip.path)
    const { unzipSync } = await import("fflate")
    const files = unzipSync(zip!)
    expect(Object.keys(files).sort()).toEqual(["main.hbc", "main.zn.ui", "main.zn.ui.json", "zn-bundle.json"])
    const info = JSON.parse(new TextDecoder().decode(files["zn-bundle.json"]))
    expect([info.serial, info.id, info.sha256]).toEqual([1, "sample_1", manifest.bundleSha256])
  })

  test("a serial taken by another release at the same moment fails cleanly, nothing overwritten", async () => {
    await core.releaseBuilt(ctx, await built("v1"), clean)
    // Another computer created #2's manifest between our listing and our create:
    const other = new TextEncoder().encode(JSON.stringify({ app: "sample", id: "sample_2", serial: 2 }))
    const real = ctx.store
    let listed = false
    ctx.store = {
      where: real.where,
      read: (p) => real.read(p),
      write: (p, d) => real.write(p, d),
      list: async (p) => {
        const r = await real.list(p)
        if (!listed) {
          listed = true
          await real.createOnly("sample/bundles/sample_2/manifest.json", other)
        }
        return r.filter((x) => !x.includes("sample_2"))
      },
      createOnly: (p, d) => real.createOnly(p, d),
    }
    await expect(core.releaseBuilt(ctx, await built("v2"), clean)).rejects.toThrow("#2 was just taken")
    expect(new TextDecoder().decode((await real.read("sample/bundles/sample_2/manifest.json"))!)).toBe(JSON.stringify({ app: "sample", id: "sample_2", serial: 2 }))
  })
})

describe("pointers", () => {
  test("staging: publish, seq goes up by one each change, rollback = point back", async () => {
    await core.releaseBuilt(ctx, await built("v1"), clean)
    await core.releaseBuilt(ctx, await built("v2"), clean)
    expect((await core.publish(ctx, { channel: "staging", bundle: 1 })).seq).toBe(1)
    expect((await core.publish(ctx, { channel: "staging", bundle: "sample_2" })).seq).toBe(2)
    const back = await core.publish(ctx, { channel: "staging", bundle: 1, reason: "rollback" })
    expect([back.seq, back.target, back.rollout]).toEqual([3, "sample_1", 100])
    expect((await core.current(ctx, "staging"))!.target).toBe("sample_1")
  })

  test("production: only stable, committed, explicit rollout, typed PRODUCTION #N", async () => {
    await core.releaseBuilt(ctx, await built("v1"), clean)
    const ok = { channel: "production", bundle: 1, rollout: 10, confirm: "PRODUCTION #1" }
    await expect(core.publish(ctx, ok)).rejects.toThrow("not marked stable")
    await expect(core.markStable(ctx, 1)).rejects.toThrow("staging never served #1")
    await core.publish(ctx, { channel: "staging", bundle: 1 })
    await core.markStable(ctx, 1)
    await expect(core.markStable(ctx, 1)).rejects.toThrow("already marked stable")
    await expect(core.publish(ctx, { ...ok, rollout: undefined })).rejects.toThrow("explicit --rollout")
    await expect(core.publish(ctx, { ...ok, confirm: "PRODUCTION #2" })).rejects.toThrow("PRODUCTION #1")
    await expect(core.publish(ctx, { ...ok, confirm: undefined })).rejects.toThrow("PRODUCTION #1")
    const p = await core.publish(ctx, ok)
    expect([p.channel, p.seq, p.target, p.rollout]).toEqual(["production", 1, "sample_1", 10])
    expect((await core.setRollout(ctx, "production", 50)).rollout).toBe(50)
  })

  test("production refuses a bundle built from uncommitted changes", async () => {
    await core.releaseBuilt(ctx, await built("v1"), { commit: "abc", dirty: true })
    await core.publish(ctx, { channel: "staging", bundle: 1 })
    await core.markStable(ctx, 1)
    await expect(core.publish(ctx, { channel: "production", bundle: 1, rollout: 5, confirm: "PRODUCTION #1" })).rejects.toThrow("uncommitted")
  })

  test("kill switch: typed KILL <CHANNEL>, a reason on production, a signed pointer to BUILT_IN", async () => {
    await core.releaseBuilt(ctx, await built("v1"), clean)
    await core.publish(ctx, { channel: "staging", bundle: 1 })
    await expect(core.kill(ctx, "staging", "kill staging")).rejects.toThrow("KILL STAGING")
    const k = await core.kill(ctx, "staging", "KILL STAGING")
    expect([k.target, k.seq, k.priority]).toEqual([BUILT_IN, 2, "critical"]) // the kill switch is always critical
    expect(verifyText(pointerText(k), k.signature, [keys.publicBase64])).toBe(true)
    await expect(core.kill(ctx, "production", "KILL PRODUCTION")).rejects.toThrow("needs a --reason")
    await expect(core.setRollout(ctx, "staging", 10)).rejects.toThrow("serves no bundle")
  })

  test("two changes racing for the same seq: the second fails, nothing overwritten", async () => {
    await core.releaseBuilt(ctx, await built("v1"), clean)
    await core.publish(ctx, { channel: "staging", bundle: 1 })
    await ctx.store.createOnly("sample/channels/staging/0000000002.json", new TextEncoder().encode("{}"))
    const real = ctx.store
    ctx.store = { ...real, where: real.where, read: real.read.bind(real), write: real.write.bind(real), createOnly: real.createOnly.bind(real),
      list: async (p) => (await real.list(p)).filter((x) => !x.endsWith("0000000002.json")) }
    await expect(core.publish(ctx, { channel: "staging", bundle: 1 })).rejects.toThrow("seq 2 is taken")
  })

  test("unknown bundles, bad channels and rollouts are refused", async () => {
    await expect(core.publish(ctx, { channel: "staging", bundle: 7 })).rejects.toThrow("no released bundle sample_7")
    await core.releaseBuilt(ctx, await built("v1"), clean)
    await expect(core.publish(ctx, { channel: "Prod!", bundle: 1 })).rejects.toThrow("use a-z")
    await expect(core.publish(ctx, { channel: "staging", bundle: 1, rollout: 0 })).rejects.toThrow("1–100")
  })
})

describe("verify", () => {
  test("a clean store checks out with the main key; a tampered zip, manifest or pointer is found", async () => {
    const { manifest } = await core.releaseBuilt(ctx, await built("v1"), clean)
    await core.publish(ctx, { channel: "staging", bundle: 1 })
    expect(await core.verifyStore(ctx, [keys.publicBase64, backup.publicBase64])).toEqual([])
    expect((await core.verifyStore(ctx, [backup.publicBase64])).length).toBe(2) // signed with main, not backup

    await ctx.store.write(manifest.zip.path, new TextEncoder().encode("not the zip"))
    const pointerPath = "sample/channels/staging/0000000001.json"
    const p = JSON.parse(new TextDecoder().decode((await ctx.store.read(pointerPath))!))
    await ctx.store.write(pointerPath, new TextEncoder().encode(JSON.stringify({ ...p, target: "sample_9" })))
    const problems = await core.verifyStore(ctx, [keys.publicBase64])
    expect(problems).toContain("sample_1: zip doesn't match its manifest")
    expect(problems).toContain("staging seq 1: bad pointer signature")
    expect(problems).toContain("staging seq 1: points at sample_9, which isn't released")
  })

  test("status shows bundles, marks and what each channel serves", async () => {
    await core.releaseBuilt(ctx, await built("v1"), clean)
    await core.publish(ctx, { channel: "staging", bundle: 1 })
    await core.markStable(ctx, 1)
    const s = await core.status(ctx)
    expect(s.bundles.map((b) => [b.id, b.stable, b.servedBy])).toEqual([["sample_1", true, ["staging 100%"]]])
    expect(s.channels.map((c) => [c.channel, c.seq, c.target])).toEqual([["staging", 1, "sample_1"]])
  })
})

describe("telemetry summary (ota status)", () => {
  test("counts phones by their newest check and outcomes per bundle", () => {
    const lines = [
      JSON.stringify({ at: "2026-10-30T10:00:00Z", installId: "a", running: "built-in sample_1", outcomes: [{ kind: "downloaded", bundle: "sample_5" }] }),
      JSON.stringify({ at: "2026-10-30T11:00:00Z", installId: "a", running: "sample_5", outcomes: [{ kind: "error_rollback", bundle: "sample_5" }, { kind: "healthy", bundle: "sample_4" }] }),
      JSON.stringify({ at: "2026-10-30T10:30:00Z", installId: "b", running: "sample_4" }),
      "not json",
      "",
      JSON.stringify({ at: "2026-10-30T12:00:00Z", installId: "b", running: "sample_4", outcomes: [{ kind: "init_failed" }] }),
    ]
    expect(core.summarizeChecks(lines)).toEqual([
      { bundle: "sample_4", phones: 1, outcomes: { healthy: 1 } },
      { bundle: "sample_5", phones: 1, outcomes: { downloaded: 1, error_rollback: 1 } },
      { bundle: "(none)", phones: 0, outcomes: { init_failed: 1 } },
    ])
  })
})

describe("source maps (step 4.8)", () => {
  const mapFor = (sha: string, app = "sample", id = "sample_1") =>
    JSON.stringify({ version: 3, file: "main.js", sources: ["src/a.tsx"], names: [], mappings: "AAAA", x_zn_bundle: { app, id, sha256: sha } })

  test("a release keeps its map by the bundle's SHA, once; a map of another build is refused", async () => {
    const dir = await built("v1")
    const sha = (await import("../../bundle-info")).readBundleInfo(dir).sha256
    const { manifest } = await core.releaseBuilt(ctx, dir, clean, mapFor(sha))
    expect(manifest.bundleSha256).toBe(sha)
    expect(await ctx.store.read(core.mapPath("sample", sha))).not.toBeNull()
    expect((await core.findMap(ctx, "sample_1")).sha256).toBe(sha)
    expect((await core.findMap(ctx, "1")).sha256).toBe(sha)
    expect((await core.findMap(ctx, sha.slice(0, 12))).sha256).toBe(sha)
    expect(await core.missingMaps(ctx)).toEqual([])
    await expect(core.releaseBuilt(ctx, await built("v2"), clean, mapFor("a".repeat(64)))).rejects.toThrow("the source map is for aaaaaaaaaaaa")
  })

  test("keep-map: the APK's own bundle is found by SHA only; bad maps are refused", async () => {
    const sha = "b".repeat(64)
    expect(await core.keepMap(ctx, mapFor(sha, "sample", "sample_0"))).toEqual({ id: "sample_0", sha256: sha, created: true })
    expect((await core.keepMap(ctx, mapFor(sha, "sample", "sample_0"))).created).toBe(false)
    expect((await core.findMap(ctx, "bbbbbbbbbbbb")).sha256).toBe(sha)
    await expect(core.findMap(ctx, "sample_0")).rejects.toThrow("give its SHA")
    await expect(core.keepMap(ctx, mapFor(sha, "other"))).rejects.toThrow('for app "other"')
    await expect(core.keepMap(ctx, JSON.stringify({ version: 3, mappings: "" }))).rejects.toThrow("doesn't name its bundle")
    await expect(core.keepMap(ctx, "nope")).rejects.toThrow("isn't JSON")
  })

  test("bundles released without a map are listed", async () => {
    await core.releaseBuilt(ctx, await built("v1"), clean)
    expect(await core.missingMaps(ctx)).toEqual(["sample_1"])
    await expect(core.findMap(ctx, "sample_1")).rejects.toThrow("no source map kept")
  })
})
