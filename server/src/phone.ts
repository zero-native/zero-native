// What phones call (docs/zn-updates-server.md §4). No login: everything that decides what code runs is signed, and
// the phone checks it again. Answers are small and never cached by proxies (they differ per phone).
import { decide, type CheckRequest } from "../../tools/ota/decide"
import { parseCheck } from "../../tools/ota/server"
import type { Db } from "./db"
import * as model from "./model"
import { PATCH_FORMAT } from "./patches"
import type { FileStore } from "./storage"
import { OSES, type Os } from "./storeRules"

export const PROTOCOL = 1
const MAX_BODY = 64 * 1024
// A bundle zip or a patch zip. (Bases, `<app>/bases/<sha>.zip`, are for the server only: phones can't get them.)
const ZIP_PATH = /^[a-z][a-z0-9_.-]*\/(?:bundles|patches)\/[a-z][a-z0-9_.-]*_\d+\/[0-9a-f]{64}\.zip$/

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "private, no-store", ...headers } })

export interface PhoneDeps {
  db: Db
  store: FileStore
  log?: boolean
}

/** The patch answer (docs/ota-patches.md §4): which bundle on the phone it applies to, and where to get it. */
export interface PatchOffer {
  format: string
  from: string
  fromSha256: string
  url: string
  sha256: string
  size: number
}

/**
 * The smallest patch whose base the phone has: its running bundle or its built-in bundle (matched by the SHA it sent),
 * or a kept bundle (matched by id: an id is unique per bytes). `from` is the id the phone knows that bundle by.
 */
export function pickPatch(rows: model.PatchRow[], req: CheckRequest): PatchOffer | null {
  let best: PatchOffer | null = null
  for (const r of rows) {
    let from: string | null = null
    if (req.running && req.running.sha256 === r.fromSha256) from = req.running.id
    else if (req.builtIn.sha256 && req.builtIn.sha256 === r.fromSha256) from = req.builtIn.id
    else if (req.kept.includes(r.fromId)) from = r.fromId
    if (from === null || (best && best.size <= r.size)) continue
    best = { format: PATCH_FORMAT, from, fromSha256: r.fromSha256, url: `/v1/files/${r.path}`, sha256: r.sha256, size: r.size }
  }
  return best
}

/** POST /v1/check: protocol 1, the same request and answer as tools/ota/server.ts (what ZnOta sends today). */
export async function check(d: PhoneDeps, request: Request): Promise<Response> {
  const text = await request.text()
  if (text.length > MAX_BODY) return json({ error: "body too large" }, 413)
  let req: CheckRequest
  try {
    req = parseCheck(JSON.parse(text))
  } catch (e) {
    return json({ error: `bad check request: ${(e as Error).message}` }, 400)
  }
  const { pointer, target } = await model.served(d.db, req.app, req.channel)
  const decision = decide(req, pointer, target)
  // An UPDATE can carry a patch, if the phone listed the format. A patch never blocks an update: any problem = no patch.
  let patch: PatchOffer | null = null
  if (decision.action === "UPDATE" && decision.bundle && req.patches?.includes(PATCH_FORMAT)) {
    try {
      patch = pickPatch(await model.patchesOf(d.db, req.app, decision.bundle.id), req)
    } catch (e) {
      console.warn(`patch lookup: ${(e as Error).message}`)
    }
  }
  const running = req.running?.id ?? `built-in:${req.builtIn.id}`
  void model.recordCheck(d.db, req.app, req.channel, req.installId, running, req.outcomes ?? [])
  void model.learnCapabilities(d.db, req.app, req.builtIn.serial, req.capabilities)
  if (d.log ?? true) {
    console.log(`check ${req.app}/${req.channel} ${req.installId.slice(0, 8)} on ${running} seq ${req.seq} → ${decision.action} ${decision.reason}${decision.bundle ? ` ${decision.bundle.id}` : ""}${patch ? ` patch from ${patch.from} (${patch.size} B)` : ""}`)
  }
  return json({
    protocol: PROTOCOL,
    ...decision,
    bundle: decision.bundle ? { ...decision.bundle, url: `/v1/files/${decision.bundle.zip.path}` } : undefined,
    ...(patch ? { patch } : {}),
  })
}

/** GET /v1/files/<path>: a released zip or a patch zip, resumable (Range). Its path has a SHA in it, so it is cached forever. */
export async function file(d: PhoneDeps, request: Request, path: string): Promise<Response> {
  if (!ZIP_PATH.test(path)) return new Response("not found", { status: 404 })
  const local = await d.store.local(path)
  if (!local) return new Response("not found", { status: 404 })
  const f = Bun.file(local)
  const size = f.size
  const headers = {
    "content-type": "application/zip",
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
    etag: `"${path.slice(path.lastIndexOf("/") + 1, -4)}"`,
  }
  const range = request.headers.get("range")
  if (!range) return new Response(request.method === "HEAD" ? null : f, { headers: { ...headers, "content-length": String(size) } })
  const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
  const start = m ? Number(m[1]) : Number.NaN
  const end = m && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1
  if (!m || start >= size || start > end) return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
  return new Response(request.method === "HEAD" ? null : f.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
  })
}

/**
 * GET /v1/store?app=&os=&version=: the store update answer alone, for the app's JS (plugins/app-updates).
 * `{ update: null }` or `{ update: { version, critical, title?, message? }, store: { appStoreId? } }`.
 */
export async function store(d: PhoneDeps, url: URL): Promise<Response> {
  const app = url.searchParams.get("app") ?? ""
  const os = url.searchParams.get("os") as Os
  const version = url.searchParams.get("version") ?? ""
  if (!OSES.includes(os) || !app || !version) return json({ error: "app, os (android|ios) and version are required" }, 400)
  const a = await model.getApp(d.db, app).catch(() => null)
  if (!a) return json({ update: null })
  const update = await model.storeAnswer(d.db, app, os, version)
  const facts = (a.store?.[os] ?? {}) as { appStoreId?: string }
  return json({ update, store: os === "ios" && facts.appStoreId ? { appStoreId: facts.appStoreId } : {} })
}

/**
 * GET /v1/updates/check with the RN backend's `x-zota-*` headers, store part only: what the ZeroBill zn app's
 * storeUpdateSource.ts asks today. The package names the app and channel (the app's `store` facts). Answer headers:
 * `x-zota-store-version`, `x-zota-store-critical` (none = nothing to do), status 200.
 */
export async function legacyStoreCheck(d: PhoneDeps, request: Request): Promise<Response> {
  const pkg = (request.headers.get("x-zota-app-id") ?? "").trim()
  const headers: Record<string, string> = { "cache-control": "private, no-store", "x-zota-status": "NO_CHANNEL" }
  for (const a of await model.listApps(d.db)) {
    for (const os of OSES) {
      const facts = (a.store?.[os] ?? {}) as { packages?: Record<string, string> }
      if (!facts.packages?.[pkg]) continue
      const version = os === "ios" ? (request.headers.get("x-zota-version-name") ?? "") : (request.headers.get("x-zota-version-code") ?? "")
      const answer = await model.storeAnswer(d.db, a.id, os, version.trim())
      if (answer) {
        headers["x-zota-store-version"] = String(answer.version)
        headers["x-zota-store-critical"] = String(answer.critical)
      }
      headers["x-zota-status"] = "UP_TO_DATE"
      return new Response(null, { status: 200, headers })
    }
  }
  return new Response(null, { status: 200, headers })
}

