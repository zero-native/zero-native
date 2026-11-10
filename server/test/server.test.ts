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
import { BUILT_IN, generateKeys, requiresLine } from "../../tools/ota/signing"
import { type Conn, changeChannel, call, remakePatches, uploadBase, uploadBuilt } from "../../tools/updates/client"
import { migrate, openDb, type Db } from "../src/db"
import { startServer } from "../src/index"
import { needsTag } from "../src/model"
import { makeFor, readBundleZip, whenIdle } from "../src/patches"
import * as phone from "../src/phone"
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

  // The store question rides on the check (docs/zn-updates-server.md §4): the answer's `store`, for the phone's channel.
  type StoreAsk = { os: "android" | "ios"; version: number | string }
  type StoreAnswerBody = { action: string; reason: string; store?: { update: { version: number | string; critical: number; title?: string; message?: string } | null; appStoreId?: string } }
  const askStore = async (channel: string, store: StoreAsk | unknown, over: Partial<CheckRequest> = {}) => {
    const res = await fetch(`${base}/v1/check`, { method: "POST", body: JSON.stringify({ ...phoneReq({ channel, ...over }), store }) })
    expect(res.status).toBe(200)
    return (await res.json()) as StoreAnswerBody
  }
  const addRule = (b: object) => call(c, "POST", "/admin/apps/shop/store-rules", b)

  test("store rules: forced needs its words; test rows only for test versions (the rules are production's by default)", async () => {
    await expect(addRule({ os: "android", version: 170, critical: 2 })).rejects.toThrow(/FORCE UPDATE 170/)
    await addRule({ os: "android", version: 170, critical: 2, confirm: "FORCE UPDATE 170", title: "Important update" })
    await addRule({ os: "android", version: 175, critical: 1 })
    await addRule({ os: "android", version: 180, critical: 2, isTest: true })
    await addRule({ os: "android", version: 179, critical: 0, isTest: true })
    const ask = async (v: number) => (await askStore("production", { os: "android", version: v })).store!.update
    expect(await ask(160)).toEqual({ version: 175, critical: 2, title: "Important update" })
    expect(await ask(172)).toEqual({ version: 175, critical: 1 })
    expect(await ask(175)).toBeNull()
    expect(await ask(179)).toEqual({ version: 180, critical: 2 }) // a test version sees the test rows
    const rules = await call<{ rules: { channel: string }[] }>(c, "POST", "/admin/apps/shop/store-rules", { os: "android", version: 175, critical: 1 })
    expect(rules.rules.every((r) => r.channel === "production")).toBe(true)
    // The admin's phone checker takes the channel too (default production)
    const viaAdmin = (ch: string) => call<{ update: unknown }>(c, "GET", `/admin/apps/shop/store-check?${ch ? `channel=${ch}&` : ""}os=android&version=160`)
    expect((await viaAdmin("")).update).toEqual({ version: 175, critical: 2, title: "Important update" })
    expect((await viaAdmin("staging")).update).toBeNull()
  })

  test("the check answers the store question for the phone's channel: a staging rule never reaches production, and the other way round", async () => {
    // Production has rules (above), staging has none yet: a staging phone is told nothing.
    expect((await askStore("staging", { os: "android", version: 160 })).store).toEqual({ update: null })
    await addRule({ os: "android", channel: "staging", version: 200, critical: 1, note: "staging only" })
    expect((await askStore("staging", { os: "android", version: 160 })).store).toEqual({ update: { version: 200, critical: 1 } })
    // A production phone at 190 is fine for production's rules; staging's rule 200 is not its business.
    expect((await askStore("production", { os: "android", version: 190 })).store).toEqual({ update: null })
    // And production's rules (175 forced) don't reach a staging phone at 160 beyond staging's own: it is only asked for 200, optional.
    expect((await askStore("staging", { os: "android", version: 172 })).store!.update).toEqual({ version: 200, critical: 1 })
    // Test rows count per channel too: 179 is a test version on production only
    expect((await askStore("production", { os: "android", version: 179 })).store!.update).toEqual({ version: 180, critical: 2 })
    expect((await askStore("staging", { os: "android", version: 179 })).store!.update).toEqual({ version: 200, critical: 1 })
    // The same version number can have a different rule on each channel
    await addRule({ os: "android", channel: "staging", version: 175, critical: 0 })
    const st = await call<{ rules: { android: { channel: string; version: number }[] } }>(c, "GET", "/admin/apps/shop/state")
    expect(st.rules.android.filter((r) => r.version === 175).map((r) => r.channel).sort()).toEqual(["production", "staging"])
    // The OTA part is the same as without `store`
    const withStore = await askStore("staging", { os: "android", version: 160 })
    expect((await phoneCheck(phoneReq())).reason).toBe(withStore.reason)
    // An unknown channel can't take a rule
    await expect(addRule({ os: "android", channel: "nope", version: 300, critical: 1 })).rejects.toThrow(/no channel/)
  })

  test("iOS: the answer has the App Store id when the app's store facts have it; Android never does", async () => {
    await addRule({ os: "ios", version: "1.7.0", critical: 1 })
    const prod = await askStore("production", { os: "ios", version: "1.6.2" })
    expect(prod.store).toEqual({ update: { version: "1.7.0", critical: 1 }, appStoreId: "123" })
    const stg = await askStore("staging", { os: "ios", version: "1.6.2" })
    expect(stg.store).toEqual({ update: null, appStoreId: "123" }) // production's rule is not staging's
    expect((await askStore("production", { os: "android", version: 160 })).store).not.toHaveProperty("appStoreId")
    // Android's version may come as digits in a string; it is read as the number
    expect((await askStore("production", { os: "android", version: "160" })).store!.update).toMatchObject({ version: 175, critical: 2 })
  })

  test("no `store` in the request = no `store` in the answer; a bad `store` field never breaks the OTA answer", async () => {
    const plain = (await (await fetch(`${base}/v1/check`, { method: "POST", body: JSON.stringify(phoneReq()) })).json()) as object
    expect(plain).not.toHaveProperty("store")
    const reference = (await phoneCheck(phoneReq())).reason
    for (const bad of [
      { os: "windows", version: 1 },
      { os: "android", version: "abc" },
      { os: "android", version: 0 },
      { os: "android", version: 1.5 },
      { os: "ios", version: "latest" },
      { os: "ios", version: 12 },
      { os: "android" },
      "android",
      7,
      [],
    ]) {
      const a = await askStore("staging", bad)
      expect([JSON.stringify(bad), a.reason, "store" in a]).toEqual([JSON.stringify(bad), reference, false])
    }
    // A null store is the same as none
    expect("store" in (await askStore("staging", null))).toBe(false)
  })

  test("if the store lookup fails, the OTA part answers as always and `store` is left out", async () => {
    const broken = { ...db, query: (text: string, params?: unknown[]) => (/FROM store_rules/.test(text) ? Promise.reject(new Error("boom")) : db.query(text, params)) } as Db
    // a channel that nothing asked before: its rules are not in the 10 s cache
    const res = await phone.check(
      { db: broken, store: files, log: false },
      new Request(`${base}/v1/check`, { method: "POST", body: JSON.stringify({ ...phoneReq({ channel: "canary" }), store: { os: "android", version: 160 } }) }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { action: string; reason: string }
    expect([body.action, body.reason]).toEqual(["NONE", "NO_CHANNEL"])
    expect(body).not.toHaveProperty("store")
  })

  test("the store-only routes are gone: /v1/store and /v1/updates/check are 404", async () => {
    expect((await fetch(`${base}/v1/store?app=shop&os=android&version=160`)).status).toBe(404)
    expect((await fetch(`${base}/v1/updates/check`, { headers: { "x-zota-app-id": "com.shop", "x-zota-version-code": "160" } })).status).toBe(404)
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
      message: {
        topic: "zn-ota-shop-staging",
        data: { zn_ota: "check", zn_ota_delay_ms: "3000" },
        android: { priority: "HIGH", ttl: "86400s" },
        // iOS: silent, no alert
        apns: { headers: { "apns-push-type": "background", "apns-priority": "5" }, payload: { aps: { "content-available": 1 } } },
      },
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

  test("saving or deleting a store rule sends the check-now push to that rule's channel; a failed push never fails the save", async () => {
    type RuleAnswer = { rules: { channel: string; version: number }[]; push: Push }
    const save = (b: object) => call<RuleAnswer>(c, "POST", "/admin/apps/shop/store-rules", b)
    const n = sent.length
    const stg = await save({ os: "android", channel: "staging", version: 210, critical: 1 })
    expect([stg.push?.sent, stg.push?.topic, stg.push?.delayMs, sent.length]).toEqual([true, "zn-ota-shop-staging", 3000, n + 1])
    expect(sent.at(-1)!.message).toMatchObject({ topic: "zn-ota-shop-staging", data: { zn_ota: "check" } })
    const prod = await save({ os: "android", version: 211, critical: 1 }) // no channel = production
    expect([prod.push?.sent, prod.push?.topic, prod.push?.delayMs]).toEqual([true, "zn-ota-shop-production", 7_200_000])
    expect(prod.rules.some((r) => r.channel === "production" && r.version === 211)).toBe(true)
    // A forced rule gets the short wait (at most 10 min), like a critical OTA
    const forced = await save({ os: "android", version: 214, critical: 2, confirm: "FORCE UPDATE 214" })
    expect([forced.push?.topic, forced.push?.delayMs]).toEqual(["zn-ota-shop-production", 600_000])
    await call(c, "DELETE", "/admin/apps/shop/store-rules/android/214?push=false")

    const del = await call<RuleAnswer>(c, "DELETE", "/admin/apps/shop/store-rules/android/210?channel=staging")
    expect([del.push?.sent, del.push?.topic, sent.length]).toEqual([true, "zn-ota-shop-staging", n + 4])
    expect(del.rules.some((r) => r.version === 210)).toBe(false)
    // The same version on production was not touched
    await save({ os: "android", version: 210, critical: 1, push: false })
    expect(sent.length).toBe(n + 4) // push: false = quiet
    await call(c, "DELETE", "/admin/apps/shop/store-rules/android/210?channel=staging&push=false") // nothing there: fine
    const left = (await call<RuleAnswer>(c, "DELETE", "/admin/apps/shop/store-rules/android/210?push=false")).rules
    expect(left.some((r) => r.version === 210)).toBe(false)

    failNextPush = true
    const failed = await save({ os: "android", channel: "staging", version: 212, critical: 1 })
    expect([failed.push?.sent, failed.rules.some((r) => r.version === 212 && r.channel === "staging")]).toEqual([false, true])
    expect(failed.push?.error).toContain("503")
    // An unknown channel is refused before anything is sent
    const count = sent.length
    await expect(save({ os: "android", channel: "nope", version: 213, critical: 1 })).rejects.toThrow(/no channel/)
    expect(sent.length).toBe(count)
    // The log says which channel
    const act = await call<{ action: string; detail: { channel?: string } }[]>(c, "GET", "/admin/apps/shop/activity?limit=200")
    expect(act.some((x) => x.action === "store.rule" && x.detail.channel === "staging")).toBe(true)
    expect(act.some((x) => x.action === "store.rule.delete" && x.detail.channel === "staging")).toBe(true)
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

  test("a built-in bundle opens like any bundle: needs and files from its base zip, the patches made from it (2026-11-10)", async () => {
    type BuiltIn = { serial: number; sha256: string; zipSize: number | null; requires: { registry: number } | null; files: number | null; patches: { toId: string; size: number }[] }
    const b = await call<BuiltIn>(c, "GET", "/admin/apps/patchy/bundles/2/builtin")
    const st = await call<{ storeBuilds: { baseSize: number | null }[] }>(c, "GET", "/admin/apps/patchy/state")
    expect([b.serial, b.sha256, b.zipSize]).toEqual([2, builtInSha, st.storeBuilds[0]!.baseSize])
    expect(b.requires?.registry).toBeGreaterThan(0)
    expect(b.files).toBe(Object.keys(builtInFiles).length)
    expect(b.patches.map((p) => p.toId)).toEqual(["patchy_3"])
    // The size route answers for it too (no source map in this test: no sizes, and no error)
    expect(await call<unknown>(c, "GET", "/admin/apps/patchy/bundles/2/size")).toEqual({ sizes: null, before: null })
    // Needs tags (the dashboard's colours): the store build's tag is its built-in bundle's needs; OTA bundles have theirs
    const tags = await call<{ storeBuilds: { needs: string | null }[]; bundles: { serial: number; needs: string; manifest: { requires: Parameters<typeof requiresLine>[0] } }[] }>(c, "GET", "/admin/apps/patchy/state")
    // (this store build took its serial without sending its bundle's needs, the old way: its tag is unknown)
    expect(tags.storeBuilds[0]!.needs).toBeNull()
    for (const x of tags.bundles) expect(x.needs).toBe(needsTag(requiresLine(x.manifest.requires)))
    expect(tags.bundles.every((x) => /^[0-9a-f]{6}$/.test(x.needs))).toBe(true)
    // An OTA bundle's number, or none at all, is not a built-in bundle
    await expect(call(c, "GET", "/admin/apps/patchy/bundles/1/builtin")).rejects.toThrow(/no built-in bundle #1/)
    await expect(call(c, "GET", "/admin/apps/patchy/bundles/99/size")).rejects.toThrow(/no built-in bundle #99/)
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
    const broken: FileStore = { where: files.where, put: (p, d) => files.put(p, d), remove: (p) => files.remove(p), local: (p) => (p.includes("/bases/") ? Promise.resolve(null) : files.local(p)) }
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

// ---- One bundle = one serial (store builds too) -----------------------------------------------------------------------

describe("one bundle = one serial", () => {
  const A = "reuse"
  const jsA: Files = { "main.hbc": rnd(60_000, 11), "main.zn.ui": ui }
  const jsB: Files = { "main.hbc": rnd(60_000, 12), "main.zn.ui": ui }
  const jsC: Files = { "main.hbc": edited(jsB["main.hbc"]!, [[100, 50, 13]]), "main.zn.ui": ui }

  /** A built bundle folder of app "reuse": serial 0, or [serial] (a store build's built-in bundle). */
  async function folder(files: Files, serial = 0): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "znu-reuse-"))
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(dir, name), bytes)
    await writeBundleInfo(dir, { app: A, serial: 0, names: Object.keys(files), requires })
    if (serial > 0) await setBundleSerial(dir, serial)
    return dir
  }
  const reserve = (kind: "bundle" | "store", dir?: string) => {
    const info = dir ? readBundleInfo(dir) : null
    return call<{ serial: number; existing: { id: string } | null }>(c, "POST", `/admin/apps/${A}/serials`, { kind, ...(info ? { sha256: info.sha256, requires: info.requires } : {}) })
  }
  const storeBuild = (b: object) =>
    call<{ family: string | null }>(c, "POST", `/admin/apps/${A}/store-builds`, { os: "android", channel: "production", label: "production AAB", versionCode: 10, versionName: "1.0.0", git: { commit: "abc1234", dirty: false }, ...b })
  const state = () => call<{ storeBuilds: { builtinSerial: number; versionCode: number; os: string; baseSize: number | null }[]; bundles: { serial: number }[] }>(c, "GET", `/admin/apps/${A}/state`)
  const serialRow = async (serial: number) => (await db.query<{ kind: string; bundle_sha256: string | null; requires_line: string | null }>(`SELECT kind, bundle_sha256, requires_line FROM serials WHERE app = $1 AND serial = $2`, [A, serial]))[0]!
  let storeA = 0

  test("setup: an app; a store build reserves its serial FOR its bytes (sha256 and requires are recorded)", async () => {
    await call(c, "POST", "/admin/apps", { id: A, name: "Reuse", publicKeys: [keys.publicBase64] })
    const dir = await folder(jsA)
    const r = await reserve("store", dir)
    expect([r.serial, r.existing]).toEqual([1, null])
    storeA = r.serial
    const row = await serialRow(1)
    expect([row.kind, row.bundle_sha256, row.requires_line !== null]).toEqual(["store", readBundleInfo(dir).sha256, true])
  })

  test("two store builds with the same JS get the same number; other JS gets a new one", async () => {
    expect((await reserve("store", await folder(jsA))).serial).toBe(storeA)
    expect((await reserve("store", await folder(jsA))).existing).toBeNull() // not released as an OTA bundle
    const other = await reserve("store", await folder(jsB))
    expect(other.serial).toBe(2)
    // other needs = other bytes for the serial's purposes
    const needs = await folder(jsA)
    const info = readBundleInfo(needs)
    const r = await call<{ serial: number }>(c, "POST", `/admin/apps/${A}/serials`, { kind: "store", sha256: info.sha256, requires: { ...info.requires, hostApi: info.requires.hostApi + 1 } })
    expect(r.serial).toBe(3)
  })

  test("an OTA release of the code that is in a store build gets that store build's number (and uploads fine)", async () => {
    const u = await uploadBuilt(c, await folder(jsA), keys.privatePem, clean)
    expect([u.manifest.serial, u.reused]).toEqual([storeA, false])
    expect((await state()).bundles.map((b) => b.serial)).toEqual([storeA])
    const again = await uploadBuilt(c, await folder(jsA), keys.privatePem, clean)
    expect([again.manifest.serial, again.reused]).toEqual([storeA, true])
    // and a store build for bytes that were released as a bundle gets the bundle's number back, with its manifest
    const b = await uploadBuilt(c, await folder(jsC), keys.privatePem, clean)
    expect(b.reused).toBe(false)
    const r = await reserve("store", await folder(jsC))
    expect([r.serial, r.existing?.id]).toEqual([b.manifest.serial, b.manifest.id])
  })

  test("record store builds: a second one with the same serial works (another OS, or another build); the same build twice is one row", async () => {
    const dir = await folder(jsA, storeA)
    const sha = readBundleInfo(dir).sha256
    await storeBuild({ builtinSerial: storeA, builtinSha256: sha, versionCode: 10 })
    await storeBuild({ os: "ios", label: "production IPA", builtinSerial: storeA, builtinSha256: sha, versionCode: 11, versionName: "1.0.0" })
    await storeBuild({ channel: "staging", label: "staging APK", builtinSerial: storeA, builtinSha256: sha, versionCode: 12 })
    // the same build recorded again (the CLI run twice): no second row
    await storeBuild({ builtinSerial: storeA, builtinSha256: sha, versionCode: 10, label: "production AAB (again)" })
    const rows = (await state()).storeBuilds.filter((b) => b.builtinSerial === storeA)
    expect(rows.map((b) => b.versionCode).sort()).toEqual([10, 11, 12])
    // wrong bytes for the serial, and a serial nobody reserved
    await expect(storeBuild({ builtinSerial: storeA, builtinSha256: readBundleInfo(await folder(jsB, 2)).sha256, versionCode: 13 })).rejects.toThrow(/other bytes/)
    await expect(storeBuild({ builtinSerial: 99, builtinSha256: sha, versionCode: 13 })).rejects.toThrow(/not reserved/)
    // a store build whose serial is a released bundle's (OTA first, store build after)
    const c1 = await uploadBuilt(c, await folder(jsB), keys.privatePem, clean)
    expect([c1.manifest.serial, c1.reused]).toEqual([2, false]) // jsB took serial 2 as a store serial earlier: now it is released too
    const sb = await reserve("store", await folder(jsB))
    expect(sb.serial).toBe(c1.manifest.serial)
    await storeBuild({ builtinSerial: sb.serial, builtinSha256: readBundleInfo(await folder(jsB)).sha256, versionCode: 14, label: "later AAB" })
    expect((await state()).storeBuilds.some((b) => b.builtinSerial === sb.serial && b.versionCode === 14)).toBe(true)
    // Needs tags (the dashboard's colours): other JS with the same needs = the same tag; other needs = another tag
    const st = await call<{ storeBuilds: { builtinSerial: number; needs: string | null }[] }>(c, "GET", `/admin/apps/${A}/state`)
    const tagOf = (n: number) => st.storeBuilds.find((x) => x.builtinSerial === n)!.needs
    const reqA = readBundleInfo(await folder(jsA)).requires
    expect(tagOf(storeA)).toBe(needsTag(requiresLine(reqA)))
    expect(tagOf(sb.serial)).toBe(tagOf(storeA))
    expect(needsTag(requiresLine({ ...reqA, hostApi: reqA.hostApi + 1 }))).not.toBe(tagOf(storeA))
  })

  test("the base for patches: the same bytes again works (also for a second store build of the serial); other bytes are refused", async () => {
    const dir = await folder(jsA, storeA)
    const first = await uploadBase(c, A, storeA, dir)
    const again = await uploadBase(c, A, storeA, dir)
    expect([again.serial, again.path, again.size]).toEqual([first.serial, first.path, first.size])
    // every store build with this serial has the base
    const withBase = (await state()).storeBuilds.filter((b) => b.builtinSerial === storeA)
    expect(withBase.length).toBe(3)
    expect(withBase.every((b) => b.baseSize === first.size)).toBe(true)
    // a rebuilt folder (new builtAt, same files) is the same bundle: fine
    const rebuilt = await uploadBase(c, A, storeA, await folder(jsA, storeA))
    expect(rebuilt.path).toBe(first.path)
    // other bytes: refused, and the base stays
    await expect(uploadBase(c, A, storeA, await folder(jsB, storeA))).rejects.toThrow(/SHA-256/)
    expect((await state()).storeBuilds.find((b) => b.builtinSerial === storeA)!.baseSize).toBe(rebuilt.size)
  })

  test("a bundle gets one patch from a built-in bundle even when several store builds share its serial", async () => {
    const jsD: Files = { "main.hbc": rnd(60_000, 15), "main.zn.ui": ui }
    const d = await reserve("store", await folder(jsD))
    const builtIn = await folder(jsD, d.serial)
    const sha = readBundleInfo(builtIn).sha256
    for (const versionCode of [20, 21, 22]) await storeBuild({ builtinSerial: d.serial, builtinSha256: sha, versionCode })
    await uploadBase(c, A, d.serial, builtIn)
    const u = await uploadBuilt(c, await folder({ "main.hbc": edited(jsD["main.hbc"]!, [[500, 40, 14]]), "main.zn.ui": ui }), keys.privatePem, clean)
    expect(u.manifest.serial).toBeGreaterThan(d.serial)
    await whenIdle()
    const rows = (await call<{ patches: { fromId: string; fromSha256: string }[] }>(c, "GET", `/admin/apps/${A}/bundles/${u.manifest.serial}`)).patches
    expect(rows.filter((p) => p.fromId === `${A}_${d.serial}`).map((p) => p.fromSha256)).toEqual([sha])
  })

  test("an older CLI (a store serial without bytes) still gets a new number each time; sha256 and requires go together", async () => {
    const a = await reserve("store")
    const b = await reserve("store")
    expect(b.serial).toBe(a.serial + 1)
    expect((await serialRow(a.serial)).bundle_sha256).toBeNull()
    await expect(call(c, "POST", `/admin/apps/${A}/serials`, { kind: "store", sha256: "a".repeat(64) })).rejects.toThrow(/together/)
    await expect(call(c, "POST", `/admin/apps/${A}/serials`, { kind: "bundle" })).rejects.toThrow(/sha256/)
  })

  test("peek (a test APK's built-in, `updates builtin`): known bytes get their serial, new bytes the next one, and nothing is taken", async () => {
    const peek = (dir: string) => {
      const info = readBundleInfo(dir)
      return call<{ serial: number; taken: boolean }>(c, "POST", `/admin/apps/${A}/serials/peek`, { sha256: info.sha256, requires: info.requires })
    }
    const count = async () => (await db.query(`SELECT 1 FROM serials WHERE app = $1`, [A])).length
    expect(await peek(await folder(jsA))).toEqual({ serial: storeA, taken: true })
    const before = await count()
    const top = (await db.query<{ max: number }>(`SELECT max(serial)::int AS max FROM serials WHERE app = $1`, [A]))[0]!.max
    // Ten test APKs with other JS before a release: all show the same next number, and no number is used up
    const jsE: Files = { "main.hbc": rnd(60_000, 16), "main.zn.ui": ui }
    const jsF: Files = { "main.hbc": rnd(60_000, 17), "main.zn.ui": ui }
    expect(await peek(await folder(jsE))).toEqual({ serial: top + 1, taken: false })
    expect(await peek(await folder(jsF))).toEqual({ serial: top + 1, taken: false })
    expect(await count()).toBe(before)
    // The release takes that number; the next test APK shows the one after it
    const released = await uploadBuilt(c, await folder(jsF), keys.privatePem, clean)
    expect(released.manifest.serial).toBe(top + 1)
    expect(await peek(await folder(jsE))).toEqual({ serial: top + 2, taken: false })
    await expect(call(c, "POST", `/admin/apps/${A}/serials/peek`, { sha256: "x" })).rejects.toThrow(/sha256 and requires/)
  })

  test("a phone learns a store build's capabilities only when its built-in bytes match (a test APK may share the serial)", async () => {
    const jsG: Files = { "main.hbc": rnd(60_000, 18), "main.zn.ui": ui }
    const g = await reserve("store", await folder(jsG))
    const sha = readBundleInfo(await folder(jsG, g.serial)).sha256
    await storeBuild({ builtinSerial: g.serial, builtinSha256: sha, versionCode: 30 })
    const capsOf = async () =>
      (await db.query<{ capabilities: unknown }>(`SELECT capabilities FROM store_builds WHERE app = $1 AND builtin_serial = $2`, [A, g.serial]))[0]!.capabilities
    const check = (builtinSha: string) =>
      fetch(`${base}/v1/check`, {
        method: "POST",
        body: JSON.stringify({ app: A, channel: "production", installId: `install-learn-${builtinSha.slice(0, 4)}`, capabilities: caps, running: null, builtIn: { id: `${A}_${g.serial}`, serial: g.serial, sha256: builtinSha }, kept: [], seq: 0 }),
      })
    await check("b".repeat(64)) // a test APK with the same serial, other bytes
    await whenIdle()
    expect(await capsOf()).toBeNull()
    await check(sha)
    await whenIdle()
    expect(await capsOf()).not.toBeNull()
  })
})

// ---- The release CLI: store-build and rule (a fake build command; the real server) ----------------------------------------

describe("updates CLI", () => {
  const cli = join(import.meta.dir, "..", "..", "tools", "updates", "cli.ts").replace(/\\/g, "/")
  const info = join(import.meta.dir, "..", "..", "tools", "bundle-info.ts").replace(/\\/g, "/")
  const app = "clitest"
  let appDir = ""
  // The CLI keeps source maps and logins in the home folder: give it a throwaway one
  const home = mkdtempSync(join(tmpdir(), "znu-home-"))

  const run = async (args: string[], env: Record<string, string> = {}, server = base) => {
    const p = Bun.spawn([process.execPath, "run", cli, ...args, "--app-dir", appDir, "--server", server, "--token", TOKEN, "--by", "cli-test"], {
      cwd: appDir,
      env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { out, err, code }
  }
  const storeBuildArgs = (code: number, over: string[] = []) => ["store-build", "--os", "android", "--channel", "staging", "--label", `staging APK ${code}`, "--version-code", String(code), "--version-name", "1.0.0", ...over]
  const sbs = () => call<{ storeBuilds: { builtinSerial: number; versionCode: number; baseSize: number | null }[]; bundles: { serial: number }[] }>(c, "GET", `/admin/apps/${app}/state`)

  test("setup: an app folder with a fake build command", async () => {
    appDir = mkdtempSync(join(tmpdir(), "znu-cli-"))
    // The fake build writes a bundle like zn-build.ts does: --out <dir> --serial <n> --map <file>. FAKE_JS is its "source code".
    // With FAKE_SERIAL_IN_JS the serial leaks into a file (the case the CLI must catch).
    writeFileSync(
      join(appDir, "fake-build.ts"),
      `import { mkdirSync, writeFileSync } from "node:fs"
import { writeBundleInfo } from "${info}"
const arg = (n: string) => process.argv[process.argv.indexOf(n) + 1]!
const out = arg("--out")
const serial = Number(arg("--serial"))
mkdirSync(out, { recursive: true })
writeFileSync(out + "/main.hbc", (process.env.FAKE_JS ?? "v1").repeat(100) + (process.env.FAKE_SERIAL_IN_JS ? serial : ""))
writeFileSync(arg("--map"), JSON.stringify({ version: 3, sources: ["src/App.tsx"], names: [], mappings: "AAAA" }))
await writeBundleInfo(out, { app: "${app}", serial, names: ["main.hbc"], requires: ${JSON.stringify(requires)} })
`,
    )
    writeFileSync(join(appDir, "zn-updates.json"), JSON.stringify({ app, server: base, build: [process.execPath, "run", join(appDir, "fake-build.ts").replace(/\\/g, "/")], assets: "assets" }))
    await call(c, "POST", "/admin/apps", { id: app, name: "CLI test", publicKeys: [keys.publicBase64] })
  }, 60_000)

  test("store-build: builds twice (serial 0, then the real one), reserves for the bytes, records the build and the base", async () => {
    const r = await run(storeBuildArgs(1))
    expect([r.code, r.err.slice(0, 200)]).toEqual([0, ""])
    expect(r.out).toContain("built-in bundle #1")
    const st = await sbs()
    expect(st.storeBuilds.map((b) => [b.builtinSerial, b.versionCode, b.baseSize !== null])).toEqual([[1, 1, true]])
    expect(readBundleInfo(join(appDir, "assets")).serial).toBe(1)
    // the source map went to the server too (stacks from phones are decoded there)
    const m = await call<{ sources: string[] }>(c, "GET", `/admin/apps/${app}/maps/${readBundleInfo(join(appDir, "assets")).sha256}`)
    expect(m.sources).toEqual(["src/App.tsx"])
  }, 60_000)

  test("store-build again with the same JS: the same number (a second store build with that serial, one base)", async () => {
    const r = await run(storeBuildArgs(2))
    expect([r.code, r.err.slice(0, 200)]).toEqual([0, ""])
    const st = await sbs()
    expect(st.storeBuilds.map((b) => [b.builtinSerial, b.versionCode]).sort()).toEqual([[1, 1], [1, 2]])
    expect(st.storeBuilds.every((b) => b.baseSize !== null)).toBe(true)
    // the number is taken once
    expect((await db.query(`SELECT 1 FROM serials WHERE app = $1`, [app])).length).toBe(1)
  }, 60_000)

  test("an OTA release of that same JS gets the store build's number; other JS gets the next one", async () => {
    const same = await uploadBuilt(c, await (async () => { const d = mkdtempSync(join(tmpdir(), "znu-cli-b-")); writeFileSync(join(d, "main.hbc"), "v1".repeat(100)); await writeBundleInfo(d, { app, serial: 0, names: ["main.hbc"], requires }); return d })(), keys.privatePem, clean)
    expect([same.manifest.serial, same.reused]).toEqual([1, false])
    const r = await run(storeBuildArgs(3), { FAKE_JS: "v2" })
    expect([r.code, r.err.slice(0, 200)]).toEqual([0, ""])
    expect((await sbs()).storeBuilds.find((b) => b.versionCode === 3)!.builtinSerial).toBe(2)
  }, 60_000)

  test("store-build stops with a clear message when the bytes change between the two builds", async () => {
    const r = await run(storeBuildArgs(4), { FAKE_JS: "v3", FAKE_SERIAL_IN_JS: "1" })
    expect(r.code).toBe(1)
    expect(r.err).toContain("another bundle SHA-256")
    expect((await sbs()).storeBuilds.some((b) => b.versionCode === 4)).toBe(false) // nothing was recorded
  }, 60_000)

  test("builtin (app:js): known JS gets its serial, new JS the next one without taking it; offline dev keeps 0, staging stops", async () => {
    const serials = async () => (await db.query(`SELECT 1 FROM serials WHERE app = $1`, [app])).length
    const before = await serials()
    const top = (await db.query<{ max: number }>(`SELECT max(serial)::int AS max FROM serials WHERE app = $1`, [app]))[0]!.max
    // The JS of store build #1: that number
    let r = await run(["builtin", "--flavor", "staging"])
    expect([r.code, r.err.slice(0, 200)]).toEqual([0, ""])
    expect(readBundleInfo(join(appDir, "assets")).serial).toBe(1)
    expect(readBundleInfo(join(appDir, "assets")).serialTaken).toBeUndefined() // taken: a release build may ship it
    // New JS, twice (two test APKs): the same next number both times, and nothing is taken
    for (const js of ["t1", "t2"]) {
      r = await run(["builtin", "--flavor", "staging"], { FAKE_JS: js })
      expect([r.code, r.err.slice(0, 200)]).toEqual([0, ""])
      expect(r.out).toContain("not taken")
      expect(readBundleInfo(join(appDir, "assets")).serial).toBe(top + 1)
      // #223: marked, so the app's production release build refuses it
      expect(readBundleInfo(join(appDir, "assets")).serialTaken).toBe(false)
    }
    expect(await serials()).toBe(before)
    // Offline: dev goes on with serial 0 and a warning; staging and production stop
    const dead = "http://127.0.0.1:9"
    r = await run(["builtin"], { FAKE_JS: "t3" }, dead)
    expect(r.code).toBe(0)
    expect(r.err).toContain("keeps serial 0")
    expect(readBundleInfo(join(appDir, "assets")).serial).toBe(0)
    r = await run(["builtin", "--flavor", "staging"], { FAKE_JS: "t3" }, dead)
    expect(r.code).toBe(1)
    expect(r.err).toContain("must not ship with serial 0")
    r = await run(["builtin", "--flavor", "beta"])
    expect(r.code).toBe(1)
  }, 60_000)

  test("rule --channel: saves for that channel (default production) and prints the push line", async () => {
    const r = await run(["rule", "--os", "android", "--version", "50", "--critical", "1", "--channel", "staging"])
    expect([r.code, r.err.slice(0, 200)]).toEqual([0, ""])
    expect(r.out).toContain("on staging")
    expect(r.out).toContain("zn-ota-clitest-staging") // no Firebase project for this app: "no push to …"
    const d = await run(["rule", "--os", "android", "--version", "51", "--critical", "1"])
    expect(d.out).toContain("on production")
    const rows = await db.query<{ version: number; channel: string }>(`SELECT version, channel FROM store_rules WHERE app = $1 ORDER BY version`, [app])
    expect(rows).toEqual([{ version: 50, channel: "staging" }, { version: 51, channel: "production" }])
  }, 60_000)
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

describe("delete with a 30-day hold, the live mark, source maps (2026-11-10)", () => {
  const T = "trim"
  async function trimBuilt(code: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "znu-trim-"))
    writeFileSync(join(dir, "main.hbc"), code)
    writeFileSync(join(dir, "main.zn.ui"), "templates")
    await writeBundleInfo(dir, { app: T, serial: 0, names: ["main.hbc", "main.zn.ui"], requires })
    return dir
  }
  const mark = (serial: number, on = true) => call<{ deleteAt: string | null }>(c, "POST", `/admin/apps/${T}/bundles/${serial}/delete`, { on })
  type TrimState = {
    bundles: { serial: number; deleteAt: string | null; manifest: { bundleSha256: string; zip: { path: string } } }[]
    storeBuilds: { id: number; builtinSerial: number; versionCode: number; liveAt: string | null; deleteAt: string | null }[]
  }
  const st = () => call<TrimState>(c, "GET", `/admin/apps/${T}/state`)
  const sha: Record<number, string> = {}
  const map = JSON.stringify({ version: 3, sources: ["src/Home.tsx", "src/Pay.tsx"], names: [], mappings: "AAAA,SCAA,KAAK;AAAL" })

  test("setup: bundles #1, #2 (staging serves #2), a store build #3 whose bytes are also released as an OTA bundle", async () => {
    await call(c, "POST", "/admin/apps", { id: T, name: "Trim", publicKeys: [keys.publicBase64] })
    for (const code of ["one", "two"]) {
      const r = await uploadBuilt(c, await trimBuilt(code), keys.privatePem, clean)
      sha[r.manifest.serial] = r.manifest.bundleSha256
    }
    await changeChannel(c, keys.privatePem, { app: T, channel: "staging", target: 2, rollout: 100 })
    const dir = await trimBuilt("three")
    const info = readBundleInfo(dir)
    const s = await call<{ serial: number }>(c, "POST", `/admin/apps/${T}/serials`, { kind: "store", sha256: info.sha256, requires: info.requires })
    expect(s.serial).toBe(3)
    await call(c, "POST", `/admin/apps/${T}/store-builds`, {
      os: "android", channel: "production", label: "production AAB", versionCode: 10, versionName: "1.0.0",
      builtinSerial: 3, builtinSha256: info.sha256, capabilities: caps, git: { commit: "abc1234", dirty: false },
    })
    const r3 = await uploadBuilt(c, await trimBuilt("three"), keys.privatePem, clean)
    expect(r3.manifest.serial).toBe(3) // the same bytes: the store build's number
    sha[3] = r3.manifest.bundleSha256
  })

  test("a bundle a channel serves can't be marked; others can, with an undo; a marked bundle can't be published", async () => {
    await expect(mark(2)).rejects.toThrow(/staging serves #2/)
    const m = await mark(1)
    const days = (Date.parse(m.deleteAt!) - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)
    await expect(mark(1)).rejects.toThrow(/already marked/)
    await expect(changeChannel(c, keys.privatePem, { app: T, channel: "staging", target: 1, rollout: 100 })).rejects.toThrow(/marked for delete/)
    expect((await mark(1, false)).deleteAt).toBeNull()
    await expect(mark(1, false)).rejects.toThrow(/not marked/)
    // DELETE (older dashboards, the CLI) is a mark too, not a removal
    await call(c, "DELETE", `/admin/apps/${T}/bundles/1`)
    expect((await st()).bundles.find((b) => b.serial === 1)!.deleteAt).not.toBeNull()
  })

  test("the live mark: a live store build and its built-in bundle can't be marked; without it they can", async () => {
    const id = (await st()).storeBuilds[0]!.id
    await call(c, "POST", `/admin/apps/${T}/store-builds/${id}/live`, { on: true })
    expect((await st()).storeBuilds[0]!.liveAt).not.toBeNull()
    await expect(mark(3)).rejects.toThrow(/marked live on the store/)
    await expect(call(c, "POST", `/admin/apps/${T}/store-builds/${id}/delete`, { on: true })).rejects.toThrow(/marked live/)
    await call(c, "POST", `/admin/apps/${T}/store-builds/${id}/live`, { on: false })
    await call(c, "POST", `/admin/apps/${T}/store-builds/${id}/delete`, { on: true })
    await expect(call(c, "POST", `/admin/apps/${T}/store-builds/${id}/live`, { on: true })).rejects.toThrow(/undo that first/)
    expect((await st()).storeBuilds[0]!.deleteAt).not.toBeNull()
  })

  test("phones on a bundle in the last 30 days: as an OTA bundle or as the APK's own", async () => {
    const ask = (installId: string, over: object) => fetch(`${base}/v1/check`, { method: "POST", body: JSON.stringify({ ...phoneReq(), app: T, installId, ...over }) })
    await ask("install-trim-1", { running: { id: `${T}_1`, sha256: sha[1] } })
    await ask("install-trim-2", { builtIn: { id: `${T}_3`, serial: 3, sha256: sha[3] } })
    await ask("install-trim-3", { builtIn: { id: `${T}_3`, serial: 3, sha256: sha[3] } })
    expect((await call<{ phones: number }>(c, "GET", `/admin/apps/${T}/bundles/1/phones`)).phones).toBe(1)
    expect((await call<{ phones: number }>(c, "GET", `/admin/apps/${T}/bundles/3/phones`)).phones).toBe(2)
    const id = (await st()).storeBuilds[0]!.id
    expect((await call<{ phones: number }>(c, "GET", `/admin/apps/${T}/store-builds/${id}/phones`)).phones).toBe(2)
  })

  test("source maps: upload, read back; a phone's stack is shown with its TSX lines; the size by file", async () => {
    const send = (s: string, body: string) => {
      const form = new FormData()
      form.append("map", new Blob([body]), "x.map")
      return call(c, "POST", `/admin/apps/${T}/maps/${s}`, form)
    }
    await expect(send(sha[2]!, "not json")).rejects.toThrow(/not JSON/)
    await expect(send("abc", map)).rejects.toThrow(/64 hex/)
    await send(sha[2]!, map)
    expect(await (await fetch(`${base}/admin/apps/${T}/maps/${sha[2]}`, { headers: { authorization: `Bearer ${TOKEN}` } })).text()).toBe(map)
    await expect(call(c, "GET", `/admin/apps/${T}/maps/${"0".repeat(64)}`)).rejects.toThrow(/no source map/)

    const stack = "TypeError: x\n    at Pay (main.js:2:1)\n    at Home (main.js:1:3)"
    await fetch(`${base}/v1/check`, {
      method: "POST",
      body: JSON.stringify({ ...phoneReq(), app: T, installId: "install-trim-4", running: { id: `${T}_2`, sha256: sha[2] }, outcomes: [{ kind: "error_screen", bundle: `${T}_2`, detail: "x", stack, sha: sha[2] }] }),
    })
    const s = await call<{ errors: { stack: string; decoded: string | null }[] }>(c, "GET", `/admin/apps/${T}/stats?channel=staging&days=1`)
    expect(s.errors[0]!.decoded).toContain("src/Pay.tsx:1:1 (main.js:2:1)")
    expect(s.errors[0]!.decoded).toContain("src/Home.tsx:1:3 (main.js:1:3)")

    type Size = { sizes: { mapped: number; files: { name: string; bytes: number }[]; folders: { name: string }[] } | null; before: unknown }
    const z = await call<Size>(c, "GET", `/admin/apps/${T}/bundles/2/size`)
    // Line 1: Home 0-9, Pay 9-14 and 14 (+1, a line's last piece); line 2: Pay at 0 (+1)
    expect(z.sizes!.files).toEqual([{ name: "src/Home.tsx", bytes: 9 }, { name: "src/Pay.tsx", bytes: 7 }])
    expect(z.sizes!.folders[0]!.name).toBe("src")
    expect(z.before).toBeNull()
    expect((await call<Size>(c, "GET", `/admin/apps/${T}/bundles/1/size`)).sizes).toBeNull() // no map
  })

  test("purge: due marks go (rows and files), the serial stays taken; a bundle a channel serves keeps no mark", async () => {
    const { purgeDeleted } = await import("../src/model")
    const zip1 = (await st()).bundles.find((b) => b.serial === 1)!.manifest.zip.path
    expect(await files.local(zip1)).not.toBeNull()
    // Not due yet: nothing goes
    expect(await purgeDeleted(db, files)).toEqual({ bundles: [], storeBuilds: [] })
    // Staging serves #2: a mark made behind the rules' back is taken off, not acted on
    await db.query(`UPDATE bundles SET delete_at = now() WHERE app = $1 AND serial = 2`, [T])
    // A second store build with built-in #3 (not marked), and OTA #3 marked: the patches from #3's bytes and its map
    // must stay for that store build's phones. Patches from #1 (nobody keeps its bytes) go.
    await call(c, "POST", `/admin/apps/${T}/store-builds`, {
      os: "android", channel: "production", label: "production AAB 11", versionCode: 11, versionName: "1.0.1",
      builtinSerial: 3, builtinSha256: sha[3], capabilities: caps, git: { commit: "abc1234", dirty: false },
    })
    await mark(3)
    const fake = async (from: number) => {
      const path = `${T}/patches/${T}_2/${sha[from]}.zip`
      await files.put(path, new Uint8Array([1, 2, 3]))
      await db.query(`INSERT INTO patches (app, to_id, from_id, from_sha256, path, sha256, size) VALUES ($1, $2, $3, $4, $5, $6, 3)`, [T, `${T}_2`, `${T}_${from}`, sha[from], path, "0".repeat(64)])
      return path
    }
    const fromOne = await fake(1)
    const fromThree = await fake(3)
    await files.put(`${T}/maps/${sha[3]}.map`, new TextEncoder().encode(map))
    const later = new Date(Date.now() + 31 * 86_400_000)
    const r = await purgeDeleted(db, files, later)
    expect(r.bundles.sort()).toEqual([1, 3])
    expect(r.storeBuilds.length).toBe(1)
    const after = await st()
    expect(after.bundles.map((b) => b.serial).sort()).toEqual([2])
    expect(after.bundles.find((b) => b.serial === 2)!.deleteAt).toBeNull()
    expect(after.storeBuilds.map((b) => b.versionCode)).toEqual([11])
    expect(await files.local(zip1)).toBeNull()
    expect(await files.local(fromOne)).toBeNull()
    expect(await files.local(fromThree)).not.toBeNull()
    expect((await db.query<{ from_id: string }>(`SELECT from_id FROM patches WHERE app = $1`, [T])).map((p) => p.from_id)).toEqual([`${T}_3`])
    expect(await files.local(`${T}/maps/${sha[3]}.map`)).not.toBeNull()
    expect((await db.query(`SELECT 1 FROM serials WHERE app = $1 AND serial = 1`, [T])).length).toBe(1) // never reused
    // Done once: a second run finds nothing
    expect(await purgeDeleted(db, files, later)).toEqual({ bundles: [], storeBuilds: [] })
    // A new bundle never gets #1 again
    const r4 = await uploadBuilt(c, await trimBuilt("four"), keys.privatePem, clean)
    expect(r4.manifest.serial).toBe(4)
  })
})
