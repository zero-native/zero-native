import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeBundleInfo } from "../../bundle-info"
import * as core from "../core"
import type { CheckRequest } from "../decide"
import { startServer, type CheckResponse } from "../server"
import { bundleText, generateKeys, pointerText, sha256Hex, verifyText } from "../signing"
import { LocalStore } from "../store"

const keys = generateKeys()
const requires = { registry: 8, bytecode: 99, hostApi: 2, modules: { Fetch: 1 } }
const caps = { registry: 8, bytecode: 99, hostApi: 2, hostApiOldest: 1, modules: { Fetch: 1, Keyboard: 1 } }
const storeRoot = mkdtempSync(join(tmpdir(), "zn-ota-server-store-"))
const dataDir = mkdtempSync(join(tmpdir(), "zn-ota-server-data-"))
const ctx: core.Context = { store: new LocalStore(storeRoot), app: "sample", privatePem: keys.privatePem }
let server: ReturnType<typeof startServer>
let base = ""

async function release(code: string, bytes = 4000) {
  const dir = mkdtempSync(join(tmpdir(), "zn-ota-server-built-"))
  // Random bytes don't compress: the zip stays big enough to test Range on.
  writeFileSync(join(dir, "main.hbc"), Buffer.concat([Buffer.from(code), randomBytes(bytes)]))
  writeFileSync(join(dir, "main.zn.ui"), "templates")
  writeFileSync(join(dir, "main.zn.ui.json"), "{}")
  await writeBundleInfo(dir, { app: "sample", serial: 0, names: ["main.hbc", "main.zn.ui", "main.zn.ui.json"], requires })
  return (await core.releaseBuilt(ctx, dir, { commit: "c", dirty: false })).manifest
}

function phone(over: Partial<CheckRequest> = {}): CheckRequest {
  return {
    app: "sample", channel: "staging", installId: "install-test-1", capabilities: caps, running: null,
    builtIn: { id: "sample_0", serial: 0 }, kept: [], seq: 0, ...over,
  }
}

async function check(body: unknown): Promise<{ status: number; answer: CheckResponse & { error?: string } }> {
  const r = await fetch(`${base}/v1/check`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  expect(r.headers.get("cache-control")).toBe("no-store")
  return { status: r.status, answer: (await r.json()) as CheckResponse & { error?: string } }
}

beforeAll(() => {
  server = startServer({ storeRoot, dataDir, port: 0, log: false })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(() => {
  server.stop(true)
})

describe("the reference update server", () => {
  let first: core.Manifest
  let second: core.Manifest

  test("health, and an empty channel answers NONE NO_CHANNEL", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ ok: true, protocol: 1 })
    const { status, answer } = await check(phone())
    expect([status, answer.action, answer.reason, answer.protocol]).toEqual([200, "NONE", "NO_CHANNEL", 1])
  })

  test("a new phone gets UPDATE; the zip downloads, matches its manifest, and both signatures verify", async () => {
    first = await release("v1", 60_000)
    second = await release("v2", 60_000)
    await core.publish(ctx, { channel: "staging", bundle: 2 })
    const { answer } = await check(phone())
    expect([answer.action, answer.reason, answer.bundle?.id, answer.pointer?.seq]).toEqual(["UPDATE", "NEW_BUNDLE", "sample_2", 1])

    // What the phone does with the answer (step 4.5): verify the pointer and the bundle, then the download.
    const p = answer.pointer!
    expect(verifyText(pointerText(p), p.signature, [keys.publicBase64])).toBe(true)
    const b = answer.bundle!
    const text = bundleText({ app: b.app, id: b.id, serial: b.serial, bundleSha256: b.bundleSha256, requires: b.requires, zipSha256: b.zip.sha256, zipSize: b.zip.size })
    expect(verifyText(text, b.signature, [keys.publicBase64])).toBe(true)
    const r = await fetch(base + b.url)
    expect([r.status, r.headers.get("accept-ranges"), r.headers.get("cache-control")]).toEqual([200, "bytes", "public, max-age=31536000, immutable"])
    const zip = new Uint8Array(await r.arrayBuffer())
    expect([zip.length, sha256Hex(zip)]).toEqual([b.zip.size, b.zip.sha256])
  })

  test("a cut download resumes with Range and gives the same bytes", async () => {
    const url = `${base}/v1/files/${second.zip.path}`
    const head = await fetch(url, { headers: { range: "bytes=0-999" } })
    expect([head.status, head.headers.get("content-range")]).toEqual([206, `bytes 0-999/${second.zip.size}`])
    const a = new Uint8Array(await head.arrayBuffer())
    const rest = await fetch(url, { headers: { range: "bytes=1000-" } })
    expect(rest.status).toBe(206)
    const b = new Uint8Array(await rest.arrayBuffer())
    const all = new Uint8Array(a.length + b.length)
    all.set(a)
    all.set(b, a.length)
    expect(sha256Hex(all)).toBe(second.zip.sha256)
    const past = await fetch(url, { headers: { range: `bytes=${second.zip.size}-` } })
    expect([past.status, past.headers.get("content-range")]).toEqual([416, `bytes */${second.zip.size}`])
    const h = await fetch(url, { method: "HEAD" })
    expect([h.status, h.headers.get("content-length")]).toEqual([200, String(second.zip.size)])
  })

  test("the phone on the bundle is UP_TO_DATE; a rollback to a kept bundle is USE_LOCAL; the kill switch is BUILT_IN", async () => {
    const on2 = { running: { id: "sample_2", sha256: second.bundleSha256 }, seq: 1, kept: ["sample_1", "sample_2"] }
    expect((await check(phone(on2))).answer.reason).toBe("UP_TO_DATE")
    await core.publish(ctx, { channel: "staging", bundle: 1, reason: "rollback" })
    const back = (await check(phone(on2))).answer
    expect([back.action, back.reason, back.bundle?.id, back.pointer?.seq]).toEqual(["USE_LOCAL", "KEPT", first.id, 2])
    await core.kill(ctx, "staging", "KILL STAGING")
    const killed = (await check(phone({ ...on2, seq: 2 }))).answer
    expect([killed.action, killed.reason, killed.pointer?.target, killed.pointer?.seq]).toEqual(["BUILT_IN", "KILL_SWITCH", "BUILT_IN", 3])
  })

  test("a phone that saw a newer seq ignores an older server answer; an app without a module gets INCOMPATIBLE", async () => {
    expect((await check(phone({ seq: 99 }))).answer.reason).toBe("STALE_SEQ")
    await core.publish(ctx, { channel: "beta", bundle: 2 })
    const old = (await check(phone({ channel: "beta", capabilities: { ...caps, modules: { Keyboard: 1 } } }))).answer
    expect([old.action, old.reason, old.detail, old.bundle]).toEqual(["NONE", "INCOMPATIBLE", "needs native module Fetch", undefined])
  })

  test("bad requests are refused: wrong shapes, too big, paths outside released zips", async () => {
    expect((await check({ app: "sample" })).status).toBe(400)
    expect((await check(phone({ seq: -1 }))).answer.error).toBe("bad check request: seq")
    expect((await check(phone({ installId: "../../etc" }))).status).toBe(400)
    const big = await fetch(`${base}/v1/check`, { method: "POST", body: "x".repeat(70_000) })
    expect(big.status).toBe(413)
    const bad = await fetch(`${base}/v1/check`, { method: "POST", body: "{not json" })
    expect(bad.status).toBe(400)
    for (const p of [`sample/bundles/sample_2/manifest.json`, `../${second.zip.path}`, `sample/bundles/sample_2/..%2f..%2fx.zip`]) {
      expect((await fetch(`${base}/v1/files/${p}`)).status).toBe(404)
    }
    expect((await fetch(`${base}/v1/check`)).status).toBe(404) // GET
  })

  test("every check is recorded with the outcomes the phone sent", async () => {
    await check(phone({ outcomes: [{ kind: "applied", bundle: "sample_2", at: "2026-10-30T10:00:00Z" }] }))
    const dir = join(dataDir, "sample")
    const lines = readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").trim().split("\n")).map((l) => JSON.parse(l))
    expect(lines.length).toBeGreaterThan(5)
    const last = lines.at(-1)
    // A phone already on its built-in bundle under the kill switch: nothing to do.
    expect([last.installId, last.action, last.reason, last.outcomes[0].kind]).toEqual(["install-test-1", "NONE", "KILL_SWITCH", "applied"])
  })
})
