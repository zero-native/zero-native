// zn-updates end to end, in one process: PGlite in memory, files in a temp folder, the real HTTP server, and the
// release client signing locally. The phone side is played by the protocol-1 request ZnOta sends.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync, zipSync } from "fflate"
import { bundleSha256, readBundleInfo, setBundleSerial, writeBundleInfo } from "../../tools/bundle-info"
import { applyPatch } from "../../tools/ota/bsdiff"
import type { CheckRequest } from "../../tools/ota/decide"
import { BUILT_IN, generateKeys } from "../../tools/ota/signing"
import { type Conn, changeChannel, call, remakePatches, uploadBase, uploadBuilt } from "../../tools/updates/client"
import { migrate, openDb, type Db } from "../src/db"
import { startServer } from "../src/index"
import { makeFor, readBundleZip, whenIdle } from "../src/patches"
import { delayFor } from "../src/push"
import { resetFailures } from "../src/session"
import { type FileStore, openStore } from "../src/storage"

const TOKEN = "test-admin-token-123456"
const requires = { registry: 8, bytecode: 99, hostApi: 2, modules: { Fetch: 1 } }
const caps = { registry: 24, bytecode: 99, hostApi: 9, hostApiOldest: 1, modules: { Fetch: 1, Device: 6 } }
const keys = generateKeys()
const backup = generateKeys()
let db: Db
let stop: () => Promise<void>
let c: Conn
let base: string
let files: FileStore

async function built(code: string, req = requires): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "znu-built-"))
  writeFileSync(join(dir, "main.hbc"), code)
  writeFileSync(join(dir, "main.zn.ui"), "templates")
  writeFileSync(join(dir, "main.zn.ui.json"), "{}")
  await writeBundleInfo(dir, { app: "shop", serial: 0, names: ["main.hbc", "main.zn.ui", "main.zn.ui.json"], requires: req })
  return dir
}

function phoneReq(over: Partial<CheckRequest> = {}): CheckRequest {
  return { app: "shop", channel: "staging", installId: "install-aaaa-1", capabilities: caps, running: null, builtIn: { id: "shop_0", serial: 0 }, kept: [], seq: 0, ...over }
}

async function phoneCheck(r: CheckRequest) {
  const res = await fetch(`${base}/v1/check`, { method: "POST", body: JSON.stringify(r) })
  return (await res.json()) as { action: string; reason: string; pointer?: { seq: number; target: string }; bundle?: { id: string; url: string; zip: { sha256: string } } }
}

const clean = { commit: "abc1234", dirty: false, subject: "Home fix" }

// The FCM sender is a fake here: it keeps what it was asked to send (src/push.ts makes the messages)
const sent: { project: string; message: Record<string, unknown> }[] = []
let failNextPush = false
const fakePush = async (project: string, message: Record<string, unknown>) => {
  if (failNextPush) {
    failNextPush = false
    throw new Error("FCM answered 503: boom")
  }
  sent.push({ project, message })
  return `projects/${project}/messages/${sent.length}`
}

// ZN_TEST_POSTGRES_URL=postgres://… runs these tests on a real Postgres (Bun's own driver, as production), in a
// throwaway schema that is dropped at the end. Without it: PGlite in memory.
const pgUrl = process.env.ZN_TEST_POSTGRES_URL
const pgSchema = `zn_test_${Date.now().toString(36)}`

beforeAll(async () => {
  if (pgUrl) {
    const admin = await openDb(pgUrl)
    await admin.query(`CREATE SCHEMA ${pgSchema}`)
    await admin.close()
  }
  db = pgUrl ? await openDb(pgUrl, pgSchema) : await openDb("pglite:memory")
  await migrate(db)
  const store = openStore(`file:${mkdtempSync(join(tmpdir(), "znu-files-"))}`, mkdtempSync(join(tmpdir(), "znu-cache-")))
  files = store
  const s = startServer({ db, store, adminToken: TOKEN, port: 0, hostname: "127.0.0.1", log: false, push: fakePush })
  stop = s.stop
  base = `http://127.0.0.1:${s.server.port}`
  c = { server: base, token: TOKEN, by: "test" }
  await call(c, "POST", "/admin/apps", {
    id: "shop",
    name: "Shop",
    publicKeys: [keys.publicBase64, backup.publicBase64],
    store: { android: { packages: { "com.shop": "production", "com.shop.staging": "staging" } }, ios: { appStoreId: "123" } },
  })
})

afterAll(async () => {
  await stop()
  await db.close()
  if (pgUrl) {
    const admin = await openDb(pgUrl)
    await admin.query(`DROP SCHEMA ${pgSchema} CASCADE`)
    await admin.close()
  }
})

describe("json columns", () => {
  test("keys and store come back as a list and an object (not JSON text)", async () => {
    const a = await call<{ publicKeys: unknown; store: unknown }>(c, "GET", "/admin/apps/shop")
    expect(Array.isArray(a.publicKeys)).toBe(true)
    expect(typeof a.store).toBe("object")
    const t = await db.query<{ k: string; s: string }>(`SELECT jsonb_typeof(public_keys) AS k, jsonb_typeof(store) AS s FROM apps WHERE id = 'shop'`)
    expect(t[0]).toEqual({ k: "array", s: "object" })
  })
})

describe("zn-updates", () => {
  test("admin calls need the token", async () => {
    const res = await fetch(`${base}/admin/apps`)
    expect(res.status).toBe(401)
  })

  test("upload: a serial per bytes, the same bytes give the same bundle back", async () => {
    const a = await uploadBuilt(c, await built("v1"), keys.privatePem, clean)
    expect([a.manifest.serial, a.manifest.id, a.reused]).toEqual([1, "shop_1", false])
    const again = await uploadBuilt(c, await built("v1"), keys.privatePem, clean)
    expect([again.manifest.serial, again.reused]).toEqual([1, true])
  })

  test("a bundle signed with another key is refused", async () => {
    const other = generateKeys()
    await expect(uploadBuilt(c, await built("evil"), other.privatePem, clean)).rejects.toThrow(/signature/)
  })

  test("phone: nothing published → NONE; staging publish → UPDATE, the zip downloads and matches", async () => {
    expect((await phoneCheck(phoneReq())).reason).toBe("NO_CHANNEL")
    const r = await changeChannel(c, keys.privatePem, { app: "shop", channel: "staging", target: 1, rollout: 100 })
    expect(r.kind).toBe("publish")
    const d = await phoneCheck(phoneReq())
    expect([d.action, d.reason, d.bundle?.id, d.pointer?.seq]).toEqual(["UPDATE", "NEW_BUNDLE", "shop_1", 1])
    const zip = new Uint8Array(await (await fetch(base + d.bundle!.url)).arrayBuffer())
    expect(new Bun.CryptoHasher("sha256").update(zip).digest("hex")).toBe(d.bundle!.zip.sha256)
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(["main.hbc", "main.zn.ui", "main.zn.ui.json", "zn-bundle.json"])
    const part = await fetch(base + d.bundle!.url, { headers: { range: "bytes=10-" } })
    expect(part.status).toBe(206)
  })

  test("production: needs stable, the typed confirm; then a rollout change and a rollback", async () => {
    await expect(changeChannel(c, keys.privatePem, { app: "shop", channel: "production", target: 1, rollout: 10, confirm: "PRODUCTION #1" })).rejects.toThrow(/stable/)
    await call(c, "POST", "/admin/apps/shop/bundles/1/stable", { on: true, note: "checked on the Lava" })
    await expect(changeChannel(c, keys.privatePem, { app: "shop", channel: "production", target: 1, rollout: 10 })).rejects.toThrow(/PRODUCTION #1/)
    expect((await changeChannel(c, keys.privatePem, { app: "shop", channel: "production", target: 1, rollout: 10, confirm: "PRODUCTION #1" })).kind).toBe("publish")
    expect((await changeChannel(c, keys.privatePem, { app: "shop", channel: "production", target: 1, rollout: 50 })).kind).toBe("rollout")

    // The refused upload above kept its serial (a serial is never given to other bytes), so v2 is #3.
    const v2 = (await uploadBuilt(c, await built("v2"), keys.privatePem, clean)).manifest.serial
    expect(v2).toBe(3)
    await changeChannel(c, keys.privatePem, { app: "shop", channel: "staging", target: v2, rollout: 100 })
    await call(c, "POST", `/admin/apps/shop/bundles/${v2}/stable`, { on: true })
    await changeChannel(c, keys.privatePem, { app: "shop", channel: "production", target: v2, rollout: 100, confirm: `PRODUCTION #${v2}` })
    const back = await changeChannel(c, keys.privatePem, { app: "shop", channel: "production", target: 1, rollout: 100, confirm: "PRODUCTION #1", reason: "home crash" })
    expect(back.kind).toBe("rollback")
  })

  test("a stale seq is a 409; the kill switch needs its words and a reason on production", async () => {
    await expect(changeChannel(c, keys.privatePem, { app: "shop", channel: "staging", target: BUILT_IN, rollout: 100, confirm: "KILL" })).rejects.toThrow(/KILL STAGING/)
    await expect(changeChannel(c, keys.privatePem, { app: "shop", channel: "production", target: BUILT_IN, rollout: 100, confirm: "KILL PRODUCTION" })).rejects.toThrow(/reason/)
    const k = await changeChannel(c, keys.privatePem, { app: "shop", channel: "staging", target: BUILT_IN, rollout: 100, priority: "critical", confirm: "KILL STAGING", reason: "test" })
    expect(k.kind).toBe("kill")
    const d = await phoneCheck(phoneReq({ running: { id: "shop_3", sha256: "x" }, seq: k.pointer.seq - 1 }))
    expect([d.action, d.reason]).toEqual(["BUILT_IN", "KILL_SWITCH"])
  })

  test("a store build reserves a serial above every bundle; its family shows what it can run", async () => {
    const s = await call<{ serial: number }>(c, "POST", "/admin/apps/shop/serials", { kind: "store" })
    expect(s.serial).toBe(4)
    const r = await call<{ family: string }>(c, "POST", "/admin/apps/shop/store-builds", {
      os: "android", channel: "production", label: "production AAB", versionCode: 170, versionName: "1.7.0",
      builtinSerial: s.serial, builtinSha256: "a".repeat(64), capabilities: caps, git: { commit: "abc1234", dirty: false },
    })
    expect(r.family).toMatch(/^fam_[0-9a-f]{12}$/)
    const st = await call<{ families: { family: string; canRun: Record<string, string | null> }[] }>(c, "GET", "/admin/apps/shop/state")
    expect(st.families[0]!.canRun.shop_1).toBeNull()
    // A phone on that store build: its built-in bundle (#3) is newer than production's #1.
    const d = await phoneCheck(phoneReq({ channel: "production", builtIn: { id: "shop_4", serial: 4 } }))
    expect(d.reason).toBe("APK_NEWER")
  })

  test("store rules: forced needs its words; test rows only for test versions; the old header check works", async () => {
    const add = (b: object) => call(c, "POST", "/admin/apps/shop/store-rules", b)
    await expect(add({ os: "android", version: 170, critical: 2 })).rejects.toThrow(/FORCE UPDATE 170/)
    await add({ os: "android", version: 170, critical: 2, confirm: "FORCE UPDATE 170", title: "Important update" })
    await add({ os: "android", version: 175, critical: 1 })
    await add({ os: "android", version: 180, critical: 2, isTest: true })
    await add({ os: "android", version: 179, critical: 0, isTest: true })
    const ask = async (v: number) => (await (await fetch(`${base}/v1/store?app=shop&os=android&version=${v}`)).json()) as { update: { version: number; critical: number; title?: string } | null }
    expect((await ask(160)).update).toEqual({ version: 175, critical: 2, title: "Important update" })
    expect((await ask(172)).update).toEqual({ version: 175, critical: 1 })
    expect((await ask(175)).update).toBeNull()
    expect((await ask(179)).update).toEqual({ version: 180, critical: 2 }) // a test version sees the test rows
    const legacy = await fetch(`${base}/v1/updates/check`, { headers: { "x-zota-app-id": "com.shop", "x-zota-version-code": "160" } })
    expect([legacy.headers.get("x-zota-store-version"), legacy.headers.get("x-zota-store-critical")]).toEqual(["175", "2"])
    await add({ os: "ios", version: "1.7.0", critical: 1 })
    const ios = (await (await fetch(`${base}/v1/store?app=shop&os=ios&version=1.6.2`)).json()) as { update: unknown; store: unknown }
    expect(ios).toEqual({ update: { version: "1.7.0", critical: 1 }, store: { appStoreId: "123" } })
  })

  test("stats: one phone a day, outcomes counted, stacks kept", async () => {
    await phoneCheck(phoneReq({ outcomes: [{ kind: "error_screen", bundle: "shop_3", detail: "x", stack: "at Home (main.js:1:2)" }] }))
    await phoneCheck(phoneReq())
    const s = await call<{ phones: { phones: number }[]; events: { kind: string; count: number }[]; errors: { stack: string }[] }>(c, "GET", "/admin/apps/shop/stats?channel=staging&days=1")
    expect(s.phones.reduce((n, r) => n + r.phones, 0)).toBe(1)
    expect(s.events.find((e) => e.kind === "error_screen")?.count).toBe(1)
    expect(s.errors[0]!.stack).toContain("main.js")
  })
})

describe("check-now pushes", () => {
  type Push = { sent: boolean; topic: string; delayMs?: number; error?: string } | null
  const change = (o: Parameters<typeof changeChannel>[2]) => changeChannel(c, keys.privatePem, o) as Promise<{ kind: string; push: Push }>

  test("no Firebase project: changes still work, nothing is sent", async () => {
    expect(sent.length).toBe(0)
    const r = await change({ app: "shop", channel: "staging", target: 3, rollout: 100 })
    expect(r.push).toMatchObject({ sent: false, topic: "zn-ota-shop-staging" })
  })

  test("publish, rollback and kill send to the channel's topic; a lower rollout sends nothing", async () => {
    await call(c, "POST", "/admin/apps", { id: "shop", push: { fcmProject: "proj-1", delayMs: { production: 7_200_000 } } })
    const app = await call<{ push: unknown; publicKeys: string[] }>(c, "GET", "/admin/apps/shop")
    expect(app.push).toEqual({ fcmProject: "proj-1", delayMs: { production: 7_200_000 } })
    expect(app.publicKeys.length).toBe(2) // saving push alone keeps the keys

    const back = await change({ app: "shop", channel: "staging", target: 1, rollout: 100 })
    expect([back.kind, back.push?.sent, back.push?.delayMs]).toEqual(["rollback", true, 3000])
    expect(sent.at(-1)).toEqual({
      project: "proj-1",
      message: { topic: "zn-ota-shop-staging", data: { zn_ota: "check", zn_ota_delay_ms: "3000" }, android: { priority: "HIGH", ttl: "86400s" } },
    })

    const down = await change({ app: "shop", channel: "production", target: 1, rollout: 40 })
    expect([down.kind, down.push]).toEqual(["rollout", null])
    const up = await change({ app: "shop", channel: "production", target: 1, rollout: 80 })
    expect([up.push?.sent, up.push?.topic, up.push?.delayMs]).toEqual([true, "zn-ota-shop-production", 7_200_000])

    const kill = await change({ app: "shop", channel: "production", target: BUILT_IN, rollout: 100, priority: "critical", confirm: "KILL PRODUCTION", reason: "bad build" })
    expect([kill.kind, kill.push?.delayMs]).toEqual(["kill", 600_000]) // a kill reaches phones within 10 minutes
  })

  test("priority high or critical: the wait is at most 10 minutes; normal keeps the channel's wait", async () => {
    const cfg = { delayMs: { production: 7_200_000 } }
    expect([delayFor(cfg, "production", "publish"), delayFor(cfg, "production", "publish", "normal")]).toEqual([7_200_000, 7_200_000])
    expect([delayFor(cfg, "production", "publish", "high"), delayFor(cfg, "production", "publish", "critical"), delayFor(cfg, "production", "kill")]).toEqual([600_000, 600_000, 600_000])
    expect(delayFor({ delayMs: { production: 120_000 } }, "production", "publish", "high")).toBe(120_000) // a shorter wait stays

    // Through the server: the kill switch above ended production's line, so publish #1 again with each priority.
    const high = await change({ app: "shop", channel: "production", target: 1, rollout: 60, priority: "high", confirm: "PRODUCTION #1" })
    expect([high.kind, high.push?.delayMs]).toEqual(["publish", 600_000])
    const normal = await change({ app: "shop", channel: "production", target: 1, rollout: 70, priority: "normal" })
    expect([normal.kind, normal.push?.delayMs]).toEqual(["rollout", 7_200_000])
    const critical = await change({ app: "shop", channel: "production", target: 1, rollout: 80, priority: "critical" })
    expect(critical.push?.delayMs).toBe(600_000)
    // A push by hand has the wait of the priority the channel serves now (critical).
    const manual = await call<Push>(c, "POST", "/admin/apps/shop/channels/production/push")
    expect(manual?.delayMs).toBe(600_000)
  })

  test("a failed push never fails the change; it is in the activity log; a manual push works", async () => {
    failNextPush = true
    const r = await change({ app: "shop", channel: "staging", target: 3, rollout: 100 })
    expect([r.kind, r.push?.sent]).toEqual(["publish", false])
    expect(r.push?.error).toContain("503")
    const act = await call<{ action: string }[] | { rows: { action: string }[] }>(c, "GET", "/admin/apps/shop/activity")
    const rows = Array.isArray(act) ? act : act.rows
    expect(rows.some((x) => x.action === "push.failed")).toBe(true)

    const count = sent.length
    const quiet = await change({ app: "shop", channel: "staging", target: 1, rollout: 100, push: false })
    expect([quiet.kind, quiet.push, sent.length]).toEqual(["rollback", null, count]) // push: false = a quiet change

    const manual = await call<Push>(c, "POST", "/admin/apps/shop/channels/staging/push")
    expect([manual?.sent, manual?.topic]).toEqual([true, "zn-ota-shop-staging"])
    await expect(call(c, "POST", "/admin/apps/shop/channels/nope/push")).rejects.toThrow(/no channel/)
  })
})

// ---- OTA patches and priority (docs/ota-patches.md) -------------------------------------------------------------------

/** Fixed-seed random bytes (xorshift32): incompressible, and the same every run. */
function rnd(size: number, seed: number): Uint8Array {
  let s = seed | 0 || 1
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    out[i] = s & 0xff
  }
  return out
}

/** [b] with some bytes replaced: [[offset, length, seed], ...]. */
function edited(b: Uint8Array, edits: [number, number, number][]): Uint8Array {
  const out = b.slice()
  for (const [at, len, seed] of edits) out.set(rnd(len, seed), at)
  return out
}

type Files = Record<string, Uint8Array>

/** A built bundle folder of app "patchy" with these files: serial 0, or [serial] for a store build's built-in bundle. */
async function builtFiles(files: Files, serial = 0): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "znu-patchy-"))
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(join(dir, ...name.split("/").slice(0, -1)), { recursive: true })
    writeFileSync(join(dir, ...name.split("/")), bytes)
  }
  await writeBundleInfo(dir, { app: "patchy", serial: 0, names: Object.keys(files), requires })
  if (serial > 0) await setBundleSerial(dir, serial)
  return dir
}

const ui = new TextEncoder().encode("templates")
const hbc1 = rnd(120_000, 1)
const png = rnd(40_000, 2)
const v1: Files = { "main.hbc": hbc1, "main.zn.ui": ui, "assets/a.png": png }
// The store build's built-in bundle: its main.hbc is further from v3's than v1's is.
const builtInFiles: Files = { "main.hbc": edited(hbc1, [[5_000, 300, 50]]), "main.zn.ui": ui, "assets/a.png": png }
const v3: Files = { "main.hbc": edited(hbc1, [[70_000, 100, 60]]), "main.zn.ui": ui, "assets/a.png": png, "assets/big.bin": rnd(40_000, 3), "assets/new.bin": rnd(2_000, 4) }
// Nothing in common with the bundles before it: its patch is as big as the full zip, so none is kept.
const v4: Files = { "main.hbc": rnd(120_000, 77), "main.zn.ui": new TextEncoder().encode("templates v4"), "assets/a.png": rnd(40_000, 78), "assets/big.bin": rnd(40_000, 79), "assets/new.bin": rnd(2_000, 80) }

const text = (b: Uint8Array) => new TextDecoder().decode(b)
const sha = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex")

/** What the phone does with a patch zip (docs/ota-patches.md §3, §6): builds every file, checks it against zn-bundle.json. */
function applyPatchZip(patchZip: Uint8Array, baseFiles: Files) {
  const z = unzipSync(patchZip)
  const meta = JSON.parse(text(z["zn-patch.json"]!)) as {
    format: string
    from: { id: string; sha256: string }
    to: { id: string; sha256: string }
    files: Record<string, { copy?: string; patch?: string; base?: string; zip?: string }>
  }
  const info = JSON.parse(text(z["zn-bundle.json"]!)) as { id: string; sha256: string; files: Record<string, { size: number; sha256: string }> }
  expect(Object.keys(meta.files).sort()).toEqual(Object.keys(info.files).sort()) // every file of the new bundle, and nothing else
  const out: Files = {}
  for (const [name, how] of Object.entries(meta.files)) {
    const want = info.files[name]!
    const bytes = how.copy !== undefined ? baseFiles[how.copy]! : how.patch !== undefined ? applyPatch(baseFiles[how.base!]!, z[how.patch]!, want.size) : z[how.zip!]!
    expect([name, bytes.length, sha(bytes)]).toEqual([name, want.size, want.sha256])
    out[name] = bytes
  }
  expect(bundleSha256(info.files)).toBe(info.sha256)
  return { meta, info, out, names: Object.keys(z) }
}

describe("OTA patches", () => {
  const phoneP = (over: Partial<CheckRequest> = {}): CheckRequest => ({
    app: "patchy", channel: "staging", installId: "install-bbbb-1", capabilities: caps, running: null, builtIn: { id: "patchy_0", serial: 0 }, kept: [], seq: 0, patches: ["znbsdiff1"], ...over,
  })
  type Answer = {
    action: string
    reason: string
    bundle?: { id: string; url: string; bundleSha256: string; zip: { path: string; sha256: string; size: number } }
    patch?: { format: string; from: string; fromSha256: string; url: string; sha256: string; size: number }
  }
  const askP = async (r: object) => {
    const res = await fetch(`${base}/v1/check`, { method: "POST", body: JSON.stringify(r) })
    expect(res.status).toBe(200)
    return (await res.json()) as Answer
  }
  type Row = { fromId: string; fromSha256: string; size: number; path: string; sha256: string }
  const patchesOf = async (serial: number) => (await call<{ patches: Row[] }>(c, "GET", `/admin/apps/patchy/bundles/${serial}`)).patches
  const download = async (path: string) => new Uint8Array(await (await fetch(`${base}/v1/files/${path}`)).arrayBuffer())
  const activityOf = async (action: string) => (await call<{ action: string; detail: Record<string, any> }[]>(c, "GET", "/admin/apps/patchy/activity?limit=200")).filter((r) => r.action === action)
  let v1Sha = ""
  let builtInSha = ""
  let v3Zip: Uint8Array
  let v3Sha = ""

  test("setup: an app, bundle #1, a store build (#2) and its base; a wrong base is refused", async () => {
    await call(c, "POST", "/admin/apps", { id: "patchy", name: "Patchy", publicKeys: [keys.publicBase64] })
    const a = await uploadBuilt(c, await builtFiles(v1), keys.privatePem, clean)
    expect(a.manifest.serial).toBe(1)
    v1Sha = a.manifest.bundleSha256
    await whenIdle()
    expect(await patchesOf(1)).toEqual([]) // nothing earlier to patch from

    const s = await call<{ serial: number }>(c, "POST", "/admin/apps/patchy/serials", { kind: "store" })
    expect(s.serial).toBe(2)
    const dir = await builtFiles(builtInFiles, 2)
    builtInSha = readBundleInfo(dir).sha256
    await call(c, "POST", "/admin/apps/patchy/store-builds", {
      os: "android", channel: "production", label: "production AAB", versionCode: 10, versionName: "1.0.0",
      builtinSerial: 2, builtinSha256: builtInSha, capabilities: caps, git: { commit: "abc1234", dirty: false },
    })
    // Refused: a folder with other bytes than the store build's, another build's number, a serial that is no store build.
    await expect(uploadBase(c, "patchy", 2, await builtFiles(v1, 2))).rejects.toThrow(/SHA-256/)
    await expect(uploadBase(c, "patchy", 2, await builtFiles(builtInFiles, 5))).rejects.toThrow(/patchy_5/)
    await expect(uploadBase(c, "patchy", 1, await builtFiles(builtInFiles, 1))).rejects.toThrow(/no store build/)
    const none = await call<{ storeBuilds: { baseSize: number | null }[] }>(c, "GET", "/admin/apps/patchy/state")
    expect(none.storeBuilds[0]!.baseSize).toBeNull()

    const r = await uploadBase(c, "patchy", 2, dir)
    expect([r.serial, r.path]).toEqual([2, `patchy/bases/${builtInSha}.zip`])
    const st = await call<{ storeBuilds: { baseSize: number | null }[] }>(c, "GET", "/admin/apps/patchy/state")
    expect(st.storeBuilds[0]!.baseSize).toBe(r.size)
    expect((await fetch(`${base}/v1/files/${r.path}`)).status).toBe(404) // a base is for the server only
  })

  test("a new bundle gets its patches in the background: copy, patch and zip per file; the phone's steps rebuild it", async () => {
    const u = await uploadBuilt(c, await builtFiles(v3), keys.privatePem, clean)
    expect(u.manifest.serial).toBe(3)
    v3Sha = u.manifest.bundleSha256
    await whenIdle()
    v3Zip = await download(u.manifest.zip.path)
    const rows = await patchesOf(3)
    expect(rows.map((r) => r.fromId).sort()).toEqual(["patchy_1", "patchy_2"])
    expect(rows.find((r) => r.fromId === "patchy_1")!.fromSha256).toBe(v1Sha)
    expect(rows.find((r) => r.fromId === "patchy_2")!.fromSha256).toBe(builtInSha)
    for (const r of rows) {
      expect(r.path).toBe(`patchy/patches/patchy_3/${r.fromSha256}.zip`)
      expect(r.size).toBeLessThan(v3Zip.length * 0.6)
      const z = await download(r.path)
      expect([z.length, sha(z)]).toEqual([r.size, r.sha256])
    }

    // From bundle #1: main.hbc is patched, the unchanged files are copied, new files come whole.
    const from1 = applyPatchZip(await download(rows.find((r) => r.fromId === "patchy_1")!.path), v1)
    expect(from1.meta.format).toBe("znbsdiff1")
    expect([from1.meta.from, from1.meta.to]).toEqual([{ id: "patchy_1", sha256: v1Sha }, { id: "patchy_3", sha256: v3Sha }])
    expect(from1.meta.files).toEqual({
      "assets/a.png": { copy: "assets/a.png" },
      "assets/big.bin": { zip: "f/assets/big.bin" },
      "assets/new.bin": { zip: "f/assets/new.bin" },
      "main.hbc": { patch: "p/main.hbc", base: "main.hbc" },
      "main.zn.ui": { copy: "main.zn.ui" },
    })
    expect(from1.names).toEqual(["zn-patch.json", "zn-bundle.json", "p/main.hbc", "f/assets/big.bin", "f/assets/new.bin"])
    for (const [name, bytes] of Object.entries(v3)) expect(sha(from1.out[name]!)).toBe(sha(bytes))
    // zn-bundle.json is the new bundle's, byte for byte as in the full zip
    expect(sha(unzipSync(await download(rows[0]!.path))["zn-bundle.json"]!)).toBe(sha(unzipSync(v3Zip)["zn-bundle.json"]!))

    // From the store build's built-in bundle: the same files rebuild from its own bytes.
    const fromBuiltIn = applyPatchZip(await download(rows.find((r) => r.fromId === "patchy_2")!.path), builtInFiles)
    expect(fromBuiltIn.meta.files["main.hbc"]).toEqual({ patch: "p/main.hbc", base: "main.hbc" })
    for (const [name, bytes] of Object.entries(v3)) expect(sha(fromBuiltIn.out[name]!)).toBe(sha(bytes))

    const made = (await activityOf("patches.made")).find((a) => a.detail.serial === 3)
    expect(made?.detail.made.map((m: { from: string }) => m.from).sort()).toEqual(["patchy_1", "patchy_2"])
  })

  test("the check answer offers the smallest patch whose base the phone has; the full bundle is always there too", async () => {
    // Publish #3 to staging (this also shows that priority "critical" is accepted).
    const r = await changeChannel(c, keys.privatePem, { app: "patchy", channel: "staging", target: 3, rollout: 100, priority: "critical" })
    expect([r.kind, r.pointer.priority]).toEqual(["publish", "critical"])
    const st = await call<{ channels: { name: string; current: { pointer: { priority: string } } }[] }>(c, "GET", "/admin/apps/patchy/state")
    expect(st.channels.find((x) => x.name === "staging")!.current.pointer.priority).toBe("critical")

    const rows = await patchesOf(3)
    const p1 = rows.find((x) => x.fromId === "patchy_1")!
    const pb = rows.find((x) => x.fromId === "patchy_2")!
    expect(p1.size).toBeLessThan(pb.size) // the closer base makes the smaller patch

    // running bundle #1 (matched by the SHA it sent)
    const a = await askP(phoneP({ running: { id: "patchy_1", sha256: v1Sha } }))
    expect([a.action, a.reason, a.bundle?.id]).toEqual(["UPDATE", "NEW_BUNDLE", "patchy_3"])
    expect(a.patch).toEqual({ format: "znbsdiff1", from: "patchy_1", fromSha256: v1Sha, url: `/v1/files/${p1.path}`, sha256: p1.sha256, size: p1.size })
    expect(a.bundle!.url).toBe(`/v1/files/${a.bundle!.zip.path}`)
    // the built-in bundle (running: null), matched by builtIn.sha256
    const b = await askP(phoneP({ builtIn: { id: "patchy_2", serial: 2, sha256: builtInSha } }))
    expect([b.action, b.patch?.from, b.patch?.size]).toEqual(["UPDATE", "patchy_2", pb.size])
    // both known: the smaller one
    const both = await askP(phoneP({ running: { id: "patchy_1", sha256: v1Sha }, builtIn: { id: "patchy_2", serial: 2, sha256: builtInSha } }))
    expect(both.patch?.from).toBe("patchy_1")
    // a kept bundle (by id)
    const kept = await askP(phoneP({ kept: ["patchy_1"] }))
    expect([kept.action, kept.patch?.from]).toEqual(["UPDATE", "patchy_1"])
    // a phone whose built-in bundle id is not the one we know it by still gets the id it sent
    expect((await askP(phoneP({ builtIn: { id: "patchy_9", serial: 2, sha256: builtInSha } }))).patch?.from).toBe("patchy_9")
  })

  test("no patch: the phone didn't list the format, sent a wrong SHA, has no base, or is not updating", async () => {
    const running = { id: "patchy_1", sha256: v1Sha }
    const old = await askP(phoneP({ running, patches: undefined }))
    expect([old.action, "patch" in old]).toEqual(["UPDATE", false]) // an old phone: nothing new in the answer
    expect("patch" in (await askP(phoneP({ running, patches: ["other"] })))).toBe(false)
    expect("patch" in (await askP(phoneP({ running, patches: [] })))).toBe(false)
    // wrong or broken fields never fail the check: no patch, a normal UPDATE
    const wrongBuiltIn = await askP(phoneP({ builtIn: { id: "patchy_2", serial: 2, sha256: "f".repeat(64) } }))
    expect([wrongBuiltIn.action, "patch" in wrongBuiltIn]).toEqual(["UPDATE", false])
    const brokenFields = await askP({ ...phoneP({ builtIn: { id: "patchy_2", serial: 2, sha256: "not-a-sha" } }), patches: "znbsdiff1" })
    expect([brokenFields.action, "patch" in brokenFields]).toEqual(["UPDATE", false])
    const wrongRunning = await askP(phoneP({ running: { id: "patchy_1", sha256: "e".repeat(64) } }))
    expect([wrongRunning.action, "patch" in wrongRunning]).toEqual(["UPDATE", false])
    // nothing the phone has is a base
    const strange = await askP(phoneP({ running: { id: "patchy_7", sha256: "d".repeat(64) }, kept: ["patchy_7"] }))
    expect([strange.action, "patch" in strange]).toEqual(["UPDATE", false])
    // a phone that already runs #3 is not updating: no patch
    const same = await askP(phoneP({ running: { id: "patchy_3", sha256: v3Sha } }))
    expect([same.action, "patch" in same]).toEqual(["NONE", false])
  })

  test("/v1/files serves a patch with Range; a patch path that doesn't exist, and a base, are 404", async () => {
    const p = (await patchesOf(3)).find((x) => x.fromId === "patchy_1")!
    const url = `${base}/v1/files/${p.path}`
    const whole = new Uint8Array(await (await fetch(url)).arrayBuffer())
    const head = await fetch(url, { method: "HEAD" })
    expect([head.status, head.headers.get("content-length"), head.headers.get("accept-ranges")]).toEqual([200, String(p.size), "bytes"])
    const part = await fetch(url, { headers: { range: "bytes=10-" } })
    expect([part.status, part.headers.get("content-range"), part.headers.get("content-type")]).toEqual([206, `bytes 10-${p.size - 1}/${p.size}`, "application/zip"])
    expect(sha(new Uint8Array(await part.arrayBuffer()))).toBe(sha(whole.subarray(10)))
    const middle = await fetch(url, { headers: { range: "bytes=5-20" } })
    expect([middle.status, middle.headers.get("content-range")]).toEqual([206, `bytes 5-20/${p.size}`])
    expect((await fetch(url, { headers: { range: `bytes=${p.size}-` } })).status).toBe(416)
    expect((await fetch(`${base}/v1/files/patchy/patches/patchy_3/${"0".repeat(64)}.zip`)).status).toBe(404)
    expect((await fetch(`${base}/v1/files/patchy/patches/patchy_3/${p.fromSha256}.zip.bak`)).status).toBe(404)
    expect((await fetch(`${base}/v1/files/patchy/patches/patchy_3/..%2F..%2Fbases%2F${builtInSha}.zip`)).status).toBe(404)
  })

  test("a patch is not kept when it is 60 % or more of the full zip", async () => {
    const u = await uploadBuilt(c, await builtFiles(v4), keys.privatePem, clean)
    expect(u.manifest.serial).toBe(4)
    await whenIdle()
    expect(await patchesOf(4)).toEqual([])
    const made = (await activityOf("patches.made")).find((a) => a.detail.serial === 4)
    expect(made?.detail.made).toEqual([])
    expect(made?.detail.tooBig.map((t: { from: string }) => t.from).sort()).toEqual(["patchy_1", "patchy_2", "patchy_3"])
    for (const t of made!.detail.tooBig as { size: number }[]) expect(t.size).toBeGreaterThanOrEqual(u.manifest.zip.size * 0.6)
  })

  test("a remake gives the same patches (same bytes), and drops the ones that don't qualify", async () => {
    const before = await patchesOf(3)
    const r = await remakePatches(c, "patchy", 3)
    expect([r.result.made.length, r.result.tooBig.length, r.result.failed.length]).toEqual([2, 0, 0])
    expect(r.patches.map((p) => [p.fromId, p.sha256, p.size]).sort()).toEqual(before.map((p) => [p.fromId, p.sha256, p.size]).sort())
    const again = await remakePatches(c, "patchy", 4)
    expect([again.patches.length, again.result.tooBig.length]).toEqual([0, 3])
    await expect(call(c, "POST", "/admin/apps/patchy/bundles/99/patches")).rejects.toThrow(/no bundle #99/)
  })

  test("a base that can't be read is logged as patches.failed; the other patches are made, the old patch stays", async () => {
    const broken: FileStore = { where: files.where, put: (p, d) => files.put(p, d), local: (p) => (p.includes("/bases/") ? Promise.resolve(null) : files.local(p)) }
    const r = await makeFor(db, broken, "patchy", 3, "test", true)
    expect([r.made.map((m) => m.from), r.failed.map((f) => f.from)]).toEqual([["patchy_1"], ["patchy_2"]])
    expect(r.failed[0]!.error).toContain("bases/")
    const failed = (await activityOf("patches.failed")).filter((a) => a.detail.serial === 3)
    expect(failed.length).toBe(1)
    expect(failed[0]!.detail.from).toBe("patchy_2")
    expect((await patchesOf(3)).map((p) => p.fromId).sort()).toEqual(["patchy_1", "patchy_2"])
    // Without force a base that has its patch is skipped: nothing is made twice.
    const quiet = await makeFor(db, files, "patchy", 3, "test")
    expect([quiet.made.length, quiet.skipped]).toEqual([0, 2])
  })

  test("a bad zip is a plain error, not a crash", () => {
    expect(() => readBundleZip(new Uint8Array([1, 2, 3]))).toThrow(/not a zip/)
    expect(() => readBundleZip(unzipless())).toThrow(/zn-bundle.json/)
  })

  function unzipless(): Uint8Array {
    // a valid zip with no zn-bundle.json
    return zipSync({ "a.txt": new TextEncoder().encode("a") })
  }
})

describe("priority", () => {
  test("normal, high and critical are accepted; anything else is refused; a pointer is stored as sent", async () => {
    for (const priority of ["high", "normal"] as const) {
      const r = await changeChannel(c, keys.privatePem, { app: "patchy", channel: "staging", target: 4, rollout: 100, priority })
      expect(r.pointer.priority).toBe(priority)
    }
    await expect(changeChannel(c, keys.privatePem, { app: "patchy", channel: "staging", target: 3, rollout: 100, priority: "urgent" as never })).rejects.toThrow(/normal, high or critical/)
  })

  test("the kill switch is critical (no priority given), and a phone gets that pointer", async () => {
    const k = await changeChannel(c, keys.privatePem, { app: "patchy", channel: "staging", target: BUILT_IN, rollout: 100, confirm: "KILL STAGING", reason: "test" })
    expect([k.kind, k.pointer.priority]).toEqual(["kill", "critical"])
    const res = await fetch(`${base}/v1/check`, {
      method: "POST",
      body: JSON.stringify({ app: "patchy", channel: "staging", installId: "install-bbbb-2", capabilities: caps, running: { id: "patchy_3", sha256: "a".repeat(64) }, builtIn: { id: "patchy_0", serial: 0 }, kept: [], seq: 0 }),
    })
    const d = (await res.json()) as { action: string; pointer?: { priority: string } }
    expect([d.action, d.pointer?.priority]).toEqual(["BUILT_IN", "critical"])
  })
})

describe("dashboard sign-in", () => {
  const raw = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { redirect: "manual", ...init })
  const cookieFrom = (res: Response) => /zn_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? ""
  let cookie = ""

  test("without a session the dashboard does not exist (404), /health still answers", async () => {
    const res = await raw("/")
    expect(res.status).toBe(404)
    expect(await res.text()).toBe("not found")
    expect((await raw("/health")).status).toBe(200)
    expect((await raw("/open")).status).toBe(404)
  })

  test("the CLI's one-time code gives a session cookie, once", async () => {
    const noName = await raw("/admin/login-links", { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })
    expect(noName.status).toBe(400) // who you are is needed for the activity log
    const { code, expiresInSeconds } = await call<{ code: string; expiresInSeconds: number }>(c, "POST", "/admin/login-links")
    expect(expiresInSeconds).toBe(60)
    const res = await raw(`/open?code=${code}`)
    expect(res.status).toBe(303)
    expect(res.headers.get("location")).toBe("/")
    const set = res.headers.get("set-cookie") ?? ""
    expect(set).toContain("HttpOnly")
    expect(set).toContain("SameSite=Lax")
    expect(set).not.toContain("Secure") // plain http here; behind the load balancer (x-forwarded-proto https) it is Secure
    cookie = cookieFrom(res)
    expect(cookie.length).toBeGreaterThan(30)
    expect((await raw(`/open?code=${code}`)).status).toBe(404) // used once
  })

  test("an expired code does not work", async () => {
    const { code } = await call<{ code: string }>(c, "POST", "/admin/login-links")
    await db.query(`UPDATE login_codes SET expires_at = now() - interval '1 second' WHERE used_at IS NULL`)
    expect((await raw(`/open?code=${code}`)).status).toBe(404)
  })

  test("with the session: the page and its files; the admin API needs the x-zn-admin header too", async () => {
    const page = await raw("/", { headers: { cookie: `zn_session=${cookie}` } })
    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toContain("text/html")
    const html = await page.text()
    expect(html).toContain('id="root"')
    const js = /src="\.?\/?([^"]+\.js)"/.exec(html)?.[1]
    expect(js).toBeTruthy()
    expect((await raw(`/${js}`, { headers: { cookie: `zn_session=${cookie}` } })).status).toBe(200)
    expect((await raw(`/${js}`)).status).toBe(404) // its files are hidden too

    expect((await raw("/admin/apps", { headers: { cookie: `zn_session=${cookie}` } })).status).toBe(403)
    const who = await raw("/admin/session", { headers: { cookie: `zn_session=${cookie}`, "x-zn-admin": "1" } })
    expect(await who.json()).toMatchObject({ by: "test", via: "session" })
    expect((await raw("/admin/apps", { headers: { cookie: `zn_session=${cookie}`, "x-zn-admin": "1" } })).status).toBe(200)
    // A session can't make itself a new link (only the token can)
    const again = await raw("/admin/login-links", { method: "POST", headers: { cookie: `zn_session=${cookie}`, "x-zn-admin": "1" } })
    expect(again.status).toBe(403)
  })

  test("sign out ends the session", async () => {
    const out = await raw("/admin/logout", { method: "POST", headers: { cookie: `zn_session=${cookie}`, "x-zn-admin": "1" } })
    expect(out.status).toBe(200)
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0")
    expect((await raw("/admin/apps", { headers: { cookie: `zn_session=${cookie}`, "x-zn-admin": "1" } })).status).toBe(401)
    expect((await raw("/", { headers: { cookie: `zn_session=${cookie}` } })).status).toBe(404)
  })

  test("many wrong tokens from one address are slowed down (429)", async () => {
    const wrong = { authorization: "Bearer wrong-token-wrong-token" }
    resetFailures() // the used and expired codes above counted too
    for (let i = 0; i < 20; i++) expect((await raw("/admin/apps", { headers: wrong })).status).toBe(401)
    expect((await raw("/admin/apps", { headers: wrong })).status).toBe(429)
    expect((await raw("/admin/apps", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(429) // even the right one, for a while
    resetFailures()
    expect((await raw("/admin/apps", { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200)
  })
})
