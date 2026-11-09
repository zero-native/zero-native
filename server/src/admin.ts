// The admin API (docs/zn-updates-server.md §5), used by the dashboard and the CLI. Two ways in:
// - the CLI: one shared token (`Authorization: Bearer <ADMIN_TOKEN>`); `x-by` names the person in the activity log;
// - the dashboard: a session cookie (src/session.ts) plus the header `x-zn-admin: 1`; the person comes from the session.
// Per-person tokens come later.
import type { Manifest } from "../../tools/ota/core"
import type { Capabilities } from "../../tools/ota/decide"
import type { Db } from "./db"
import * as model from "./model"
import { RuleError } from "./model"
import { makeInBackground, remake, uploadBase } from "./patches"
import { type PushSender, tellPhones, worthPush } from "./push"
import { ADMIN_HEADER, cookieOf, createLoginCode, endSession, isBlocked, isHttps, noteFailure, sessionCookie, sessionOf } from "./session"
import type { FileStore } from "./storage"
import { OSES, type Os, ruleProblems, versionNumber } from "./storeRules"

export interface AdminDeps {
  db: Db
  store: FileStore
  token: string
  started: string
  version: string
  /** Sends the "check for an update now" push (src/push.ts); tests pass a fake one. */
  push: PushSender
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

/** Constant-time compare, so the token can't be guessed a character at a time from timings. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** [address]: the caller, for slowing down wrong tokens (src/session.ts clientAddress). */
export async function handle(d: AdminDeps, request: Request, url: URL, address = "unknown"): Promise<Response> {
  const parts = url.pathname.split("/").filter(Boolean).slice(1) // after "admin"
  const method = request.method
  if (isBlocked(address)) return json({ error: "too many wrong sign-ins from this address: wait 10 minutes" }, 429)
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim()
  let by: string
  let session: { by: string; expiresAt: string } | null = null
  if (bearer) {
    if (!sameToken(bearer, d.token)) {
      noteFailure(address)
      return json({ error: "sign in: the admin token is wrong" }, 401)
    }
    by = (request.headers.get("x-by") ?? "").trim().slice(0, 60) || "unknown"
  } else {
    session = await sessionOf(d.db, cookieOf(request))
    if (!session) return json({ error: "signed out: run `bun run updates dashboard` in your app folder to open the dashboard again" }, 401)
    // A cookie alone is not enough: another site can make the browser send it, but it can't add this header
    if (request.headers.get(ADMIN_HEADER) !== "1") return json({ error: `missing the ${ADMIN_HEADER} header` }, 403)
    by = session.by
  }
  try {
    // Sign-in: only the token can make a one-time dashboard link (a session can't extend itself)
    if (parts[0] === "login-links" && parts.length === 1 && method === "POST") {
      if (session) return json({ error: "a dashboard link needs the admin token (the CLI), not a session" }, 403)
      if (by === "unknown") throw new RuleError("say who you are: the x-by header (`updates login --by <your name>`)")
      return json(await createLoginCode(d.db, by))
    }
    if (parts[0] === "session" && parts.length === 1 && method === "GET") {
      return json({ by, via: session ? "session" : "token", expiresAt: session?.expiresAt ?? null })
    }
    if (parts[0] === "logout" && parts.length === 1 && method === "POST") {
      await endSession(d.db, cookieOf(request))
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": sessionCookie("", 0, isHttps(request, url)) },
      })
    }
    return await route(d, request, url, parts, method, by)
  } catch (e) {
    if (e instanceof RuleError) return json({ error: e.message }, e.status)
    console.error(`✗ admin ${method} ${url.pathname}: ${(e as Error).stack ?? e}`)
    return json({ error: `server error: ${(e as Error).message}` }, 500)
  }
}

async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    throw new RuleError("the body must be JSON")
  }
}

function osParam(v: unknown): Os {
  if (!OSES.includes(v as Os)) throw new RuleError("os must be android or ios")
  return v as Os
}

async function route(d: AdminDeps, request: Request, url: URL, p: string[], method: string, by: string): Promise<Response> {
  const { db } = d
  if (p[0] === "env" && method === "GET") {
    return json({ database: db.kind, storage: d.store.where, started: d.started, version: d.version, now: new Date().toISOString() })
  }
  if (p[0] !== "apps") throw new RuleError("not found", 404)
  if (p.length === 1) {
    if (method === "GET") return json(await model.listApps(db))
    if (method === "POST") {
      const b = await body<{ id: string; name?: string; publicKeys?: string[]; store?: Record<string, unknown>; push?: Record<string, unknown> }>(request)
      await model.saveApp(db, b, by)
      return json(await model.getApp(db, b.id))
    }
  }
  const app = p[1]!
  const what = p[2]
  if (!what && method === "GET") return json(await model.getApp(db, app))
  if (what === "state" && method === "GET") return json(await model.state(db, app))
  if (what === "stats" && method === "GET") {
    return json(await model.stats(db, app, url.searchParams.get("channel") ?? model.PRODUCTION, Number(url.searchParams.get("days") ?? "7")))
  }
  if (what === "activity" && method === "GET") {
    const before = url.searchParams.get("before")
    return json(await model.activity(db, app, Number(url.searchParams.get("limit") ?? "100"), before ? Number(before) : undefined))
  }
  if (what === "serials" && p.length === 4 && p[3] === "peek" && method === "POST") {
    // Read-only: the serial these bytes would get (a test APK's built-in bundle, `updates builtin`). Takes nothing.
    const b = await body<{ sha256?: string; requires?: Manifest["requires"] }>(request)
    if (!b.sha256 || !b.requires) throw new RuleError("send sha256 and requires")
    return json(await model.peekSerial(db, app, { sha256: b.sha256, requires: b.requires }))
  }
  if (what === "serials" && method === "POST") {
    const b = await body<{ kind: "bundle" | "store"; sha256?: string; requires?: Manifest["requires"] }>(request)
    if (b.kind !== "bundle" && b.kind !== "store") throw new RuleError("kind must be bundle or store")
    // Both kinds send the bytes they are for: the same bytes get the same serial (one bundle = one serial). A store
    // build may leave them out (an older CLI): then it only gets a new number.
    if (!!b.sha256 !== !!b.requires) throw new RuleError("send sha256 and requires together")
    const bytes = b.sha256 && b.requires ? { sha256: b.sha256, requires: b.requires } : null
    return json(await model.reserveSerial(db, app, b.kind, bytes, by))
  }
  if (what === "bundles") {
    if (p.length === 3 && method === "POST") {
      // multipart: manifest (JSON text), zip (file), gitSubject
      const form = await request.formData().catch(() => null)
      if (!form) throw new RuleError("send multipart form data: manifest, zip, gitSubject")
      const manifestText = form.get("manifest")
      const zip = form.get("zip")
      if (typeof manifestText !== "string" || !(zip instanceof Blob)) throw new RuleError("manifest (JSON) and zip (file) are required")
      const manifest = JSON.parse(manifestText) as Manifest
      const had = Number.isInteger(manifest.serial) ? (await db.query(`SELECT 1 FROM bundles WHERE app = $1 AND serial = $2`, [app, manifest.serial]))[0] : undefined
      const row = await model.uploadBundle(db, d.store, app, manifest, new Uint8Array(await zip.arrayBuffer()), {
        gitSubject: String(form.get("gitSubject") ?? ""),
        builtBy: by,
      })
      // A new bundle: make its patches in the background (the answer doesn't wait for them and never fails because of them).
      if (!had) makeInBackground(db, d.store, app, row.serial, by)
      return json(row)
    }
    const serial = Number(p[3])
    if (!Number.isInteger(serial)) throw new RuleError("bundle serial must be a number")
    if (p.length === 4 && method === "GET") {
      const row = await model.bundle(db, app, serial)
      return json({ ...row, patches: await model.patchesOf(db, app, row.id) })
    }
    if (p[4] === "patches" && p.length === 5 && method === "POST") return json(await remake(db, d.store, app, serial, by))
    if (p.length === 4 && method === "DELETE") {
      await model.deleteBundle(db, app, serial, by)
      return json({ ok: true })
    }
    if (p[4] === "stable" && method === "POST") {
      const b = await body<{ on: boolean; note?: string }>(request)
      await model.setStable(db, app, serial, b.on !== false, by, b.note)
      return json(await model.bundle(db, app, serial))
    }
    if (p[4] === "title" && method === "POST") {
      const b = await body<{ title: string }>(request)
      await model.setTitle(db, app, serial, String(b.title ?? ""), by)
      return json(await model.bundle(db, app, serial))
    }
  }
  if (what === "channels" && p[4] === "next" && method === "GET") {
    return json(await model.nextPointerText(db, app, p[3]!, url.searchParams.get("target") ?? ""))
  }
  if (what === "pointers" && method === "POST") {
    const req = await body<model.PointerRequest & { push?: boolean }>(request)
    const row = await model.addPointer(db, app, req, by)
    // Tell the channel's phones to check soon (they spread their checks); a failed push never fails the change.
    // `push: false` in the body: a quiet change, phones find it at their next start.
    const push = req.push !== false && worthPush(row.kind, row.pointer.rollout, row.previousRollout ?? null)
      ? await tellPhones(db, d.push, await model.getApp(db, app), row.pointer.channel, { kind: row.kind, seq: row.pointer.seq, by, priority: row.pointer.priority })
      : null
    return json({ ...row, push })
  }
  if (what === "channels" && p[4] === "push" && method === "POST") {
    if (!(await model.channels(db, app)).includes(p[3]!)) throw new RuleError(`no channel "${p[3]}"`, 404)
    // A push by hand has the wait of the priority the channel serves now.
    const priority = (await model.current(db, app, p[3]!))?.priority
    return json(await tellPhones(db, d.push, await model.getApp(db, app), p[3]!, { kind: "manual", by, priority }))
  }
  // A store build's built-in bundle as a zip: the base for patches (src/patches.ts)
  if (what === "store-builds" && p.length === 5 && p[4] === "base" && method === "POST") {
    const baseSerial = Number(p[3])
    if (!Number.isInteger(baseSerial)) throw new RuleError("the store build's built-in serial must be a number")
    const form = await request.formData().catch(() => null)
    const zip = form?.get("zip")
    if (!(zip instanceof Blob)) throw new RuleError("send multipart form data with the zip (file)")
    return json(await uploadBase(db, d.store, app, baseSerial, new Uint8Array(await zip.arrayBuffer()), by))
  }
  if (what === "store-builds" && method === "POST") {
    const b = await body<model.StoreBuildInput>(request)
    return json(await model.addStoreBuild(db, app, { ...b, os: osParam(b.os), capabilities: b.capabilities as Capabilities }, by))
  }
  if (what === "store-rules") {
    if (p.length === 3 && method === "POST") {
      const b = await body<{ os: string; channel?: string; version: string | number; critical: number; isTest?: boolean; title?: string; message?: string; note?: string; confirm?: string; push?: boolean }>(request)
      const os = osParam(b.os)
      const channel = b.channel ?? model.PRODUCTION
      const version = versionNumber(os, b.version)
      const critical = Number(b.critical)
      const problems = ruleProblems(os, { version, critical, isTest: !!b.isTest }, b.confirm)
      if (problems.length) throw new RuleError(problems.join("; "))
      await model.saveStoreRule(db, app, channel, os, { version: version!, critical: critical as 0 | 1 | 2, isTest: !!b.isTest, title: b.title, message: b.message, note: b.note }, by)
      return json({ rules: await model.storeRules(db, app, os), push: b.push === false ? null : await pushChannel(d, app, channel, by, critical === 2) })
    }
    // DELETE /store-rules/<os>/<version>?channel=<channel> (no channel = production)
    if (p.length === 5 && method === "DELETE") {
      const os = osParam(p[3])
      const channel = url.searchParams.get("channel") ?? model.PRODUCTION
      const version = Number(p[4])
      await model.deleteStoreRule(db, app, channel, os, version, by)
      return json({ rules: await model.storeRules(db, app, os), push: url.searchParams.get("push") === "false" ? null : await pushChannel(d, app, channel, by) })
    }
  }
  if (what === "store-check" && method === "GET") {
    const os = osParam(url.searchParams.get("os"))
    return json({ update: await model.storeAnswer(db, app, url.searchParams.get("channel") ?? model.PRODUCTION, os, url.searchParams.get("version") ?? "") })
  }
  throw new RuleError("not found", 404)
}

/** A store rule changed: tell the channel's phones to check now (the same push a channel change sends). Never throws. */
function pushChannel(d: AdminDeps, app: string, channel: string, by: string, forced = false) {
  // A forced rule (critical 2) gets the short wait, like a critical OTA (at most 10 min); other rule changes the
  // channel's normal wait (production: hours).
  return model.getApp(d.db, app).then((a) => tellPhones(d.db, d.push, a, channel, { kind: "store.rule", by, ...(forced ? { priority: "critical" as const } : {}) }))
}
