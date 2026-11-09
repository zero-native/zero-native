// zn-updates end to end, in one process: PGlite in memory, files in a temp folder, the real HTTP server, and the
// release client signing locally. The phone side is played by the protocol-1 request ZnOta sends.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { writeBundleInfo } from "../../tools/bundle-info"
import type { CheckRequest } from "../../tools/ota/decide"
import { BUILT_IN, generateKeys } from "../../tools/ota/signing"
import { type Conn, changeChannel, call, uploadBuilt } from "../../tools/updates/client"
import { migrate, openDb, type Db } from "../src/db"
import { startServer } from "../src/index"
import { resetFailures } from "../src/session"
import { openStore } from "../src/storage"

const TOKEN = "test-admin-token-123456"
const requires = { registry: 8, bytecode: 99, hostApi: 2, modules: { Fetch: 1 } }
const caps = { registry: 24, bytecode: 99, hostApi: 9, hostApiOldest: 1, modules: { Fetch: 1, Device: 6 } }
const keys = generateKeys()
const backup = generateKeys()
let db: Db
let stop: () => Promise<void>
let c: Conn
let base: string

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
    const k = await changeChannel(c, keys.privatePem, { app: "shop", channel: "staging", target: BUILT_IN, rollout: 100, priority: "high", confirm: "KILL STAGING", reason: "test" })
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

    const kill = await change({ app: "shop", channel: "production", target: BUILT_IN, rollout: 100, priority: "high", confirm: "KILL PRODUCTION", reason: "bad build" })
    expect([kill.kind, kill.push?.delayMs]).toEqual(["kill", 600_000]) // a kill reaches phones within 10 minutes
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
