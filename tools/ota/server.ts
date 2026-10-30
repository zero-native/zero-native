// The reference update server (docs/ota.md §3.4, step 4.4): Bun.serve over a release store (store.ts).
//   POST /v1/check                the phone's one request: the decision (decide.ts) + its outcomes for telemetry
//   GET  /v1/files/<zip path>     a released bundle's zip, as a static file, resumable (Range)
//   GET  /health
// It never holds the private key: it serves records the release CLI signed, and the phone checks every signature,
// the seq and its capabilities itself. An app's own backend can serve the same protocol instead (milestone 5).
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import * as core from "./core"
import { decide, type CheckRequest, type Decision } from "./decide"
import { BUILT_IN } from "./signing"
import { LocalStore } from "./store"

export const PROTOCOL = 1
const MAX_BODY = 64 * 1024
const ZIP_PATH = /^[a-z][a-z0-9_.-]*\/bundles\/[a-z][a-z0-9_.-]*_\d+\/[0-9a-f]{64}\.zip$/

export interface ServerOptions {
  /** The release store folder (the CLI's `store`). */
  storeRoot: string
  /** Where telemetry goes: <data>/<app>/checks-<date>.ndjson. */
  dataDir: string
  port?: number
  hostname?: string
  /** One line per check on stdout (default true). */
  log?: boolean
}

/** The answer to a check: the decision, with the bundle's download path (relative to the server) when there is one. */
export interface CheckResponse extends Omit<Decision, "bundle"> {
  protocol: number
  bundle?: core.Manifest & { url: string }
}

class BadRequest extends Error {}

function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new BadRequest(what)
}

const isId = (v: unknown, max = 80): v is string => typeof v === "string" && v.length > 0 && v.length <= max && /^[A-Za-z0-9_.:-]+$/.test(v)
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 2 ** 31

/** Validates the request body; throws BadRequest with what is wrong. */
export function parseCheck(body: unknown): CheckRequest {
  check(typeof body === "object" && body !== null, "body must be a JSON object")
  const r = body as Record<string, unknown>
  check(isId(r.app, 64) && /^[a-z][a-z0-9_.-]*$/.test(r.app), "app")
  check(isId(r.channel, 32) && /^[a-z][a-z0-9-]*$/.test(r.channel), "channel")
  check(isId(r.installId, 64), "installId")
  const c = r.capabilities as Record<string, unknown> | undefined
  check(c && isCount(c.registry) && isCount(c.bytecode) && isCount(c.hostApi) && isCount(c.hostApiOldest), "capabilities")
  check(typeof c.modules === "object" && c.modules !== null && Object.entries(c.modules).every(([k, v]) => isId(k, 64) && isCount(v)), "capabilities.modules")
  const running = r.running as Record<string, unknown> | null
  check(running === null || (running && isId(running.id) && isId(running.sha256)), "running")
  const builtIn = r.builtIn as Record<string, unknown> | undefined
  check(builtIn && isId(builtIn.id) && isCount(builtIn.serial), "builtIn")
  check(Array.isArray(r.kept) && r.kept.length <= 16 && r.kept.every((k) => isId(k)), "kept")
  check(isCount(r.seq), "seq")
  const outcomes = r.outcomes ?? []
  check(Array.isArray(outcomes) && outcomes.length <= 50, "outcomes")
  return {
    app: r.app,
    channel: r.channel,
    installId: r.installId,
    capabilities: c as unknown as CheckRequest["capabilities"],
    running: running as CheckRequest["running"],
    builtIn: builtIn as unknown as CheckRequest["builtIn"],
    kept: r.kept as string[],
    seq: r.seq,
    outcomes: (outcomes as Array<Record<string, unknown>>).map((o) => ({
      kind: String(o.kind ?? "").slice(0, 40),
      bundle: o.bundle === undefined ? undefined : String(o.bundle).slice(0, 80),
      detail: o.detail === undefined ? undefined : String(o.detail).slice(0, 300),
      at: o.at === undefined ? undefined : String(o.at).slice(0, 40),
    })),
  }
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })

export function startServer(o: ServerOptions) {
  const store = new LocalStore(o.storeRoot)
  const log = o.log ?? true

  async function onCheck(request: Request): Promise<Response> {
    const length = Number(request.headers.get("content-length") ?? "0")
    if (length > MAX_BODY) return json({ error: "body too large" }, 413)
    const text = await request.text()
    if (text.length > MAX_BODY) return json({ error: "body too large" }, 413)
    let req: CheckRequest
    try {
      req = parseCheck(JSON.parse(text))
    } catch (e) {
      return json({ error: `bad check request: ${e instanceof BadRequest ? e.message : "not JSON"}` }, 400)
    }
    const ctx = { store, app: req.app }
    const pointer = await core.current(ctx, req.channel)
    let target: core.Manifest | null = null
    if (pointer && pointer.target !== BUILT_IN) target = await core.manifest(ctx, pointer.target).catch(() => null)
    const d = decide(req, pointer, target)
    const answer: CheckResponse = {
      protocol: PROTOCOL,
      ...d,
      bundle: d.bundle ? { ...d.bundle, url: `/v1/files/${d.bundle.zip.path}` } : undefined,
    }
    record(req, d)
    return json(answer)
  }

  /** Telemetry: one line per check, with what the phone reported since its last check. */
  function record(req: CheckRequest, d: Decision) {
    const day = new Date().toISOString().slice(0, 10)
    const dir = join(o.dataDir, req.app)
    mkdirSync(dir, { recursive: true })
    const line = {
      at: new Date().toISOString(),
      channel: req.channel,
      installId: req.installId,
      running: req.running?.id ?? `built-in ${req.builtIn.id}`,
      seq: req.seq,
      action: d.action,
      reason: d.reason,
      target: d.bundle?.id ?? d.pointer?.target,
      outcomes: req.outcomes?.length ? req.outcomes : undefined,
    }
    appendFileSync(join(dir, `checks-${day}.ndjson`), JSON.stringify(line) + "\n")
    if (log) {
      const outcomes = req.outcomes?.length ? ` (+${req.outcomes.length} outcome(s))` : ""
      console.log(`check ${req.app}/${req.channel} ${req.installId.slice(0, 8)} on ${line.running} seq ${req.seq} → ${d.action} ${d.reason}${line.target ? ` ${line.target}` : ""}${outcomes}`)
    }
  }

  /** A released zip, resumable: a Range request gets 206 with just the asked bytes. Zips never change: cache forever. */
  async function onFile(request: Request, path: string): Promise<Response> {
    if (!ZIP_PATH.test(path)) return new Response("not found", { status: 404 })
    const file = Bun.file(join(o.storeRoot, ...path.split("/")))
    if (!(await file.exists())) return new Response("not found", { status: 404 })
    const size = file.size
    const etag = `"${path.slice(path.lastIndexOf("/") + 1, -4)}"` // the file's SHA-256
    const headers = {
      "content-type": "application/zip",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
      etag,
    }
    const range = request.headers.get("range")
    if (!range) return new Response(request.method === "HEAD" ? null : file, { headers: { ...headers, "content-length": String(size) } })
    const m = /^bytes=(\d+)-(\d*)$/.exec(range.trim())
    const start = m ? Number(m[1]) : NaN
    const end = m && m[2] !== "" ? Math.min(Number(m[2]), size - 1) : size - 1
    if (!m || start >= size || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } })
    }
    return new Response(request.method === "HEAD" ? null : file.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
    })
  }

  return Bun.serve({
    port: o.port ?? 8790,
    hostname: o.hostname ?? "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      try {
        if (url.pathname === "/v1/check" && request.method === "POST") return await onCheck(request)
        if (url.pathname.startsWith("/v1/files/") && (request.method === "GET" || request.method === "HEAD")) {
          return await onFile(request, decodeURIComponent(url.pathname.slice("/v1/files/".length)))
        }
        if (url.pathname === "/health") return json({ ok: true, protocol: PROTOCOL })
        return new Response("not found", { status: 404 })
      } catch (e) {
        console.error(`✗ ${request.method} ${url.pathname}: ${e instanceof Error ? e.stack : e}`)
        return json({ error: "server error" }, 500)
      }
    },
  })
}
