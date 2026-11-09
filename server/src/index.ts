// zn-updates: the update server (docs/zn-updates-server.md). One process serves the phone API (/v1/*), the admin API
// (/admin/*) and the dashboard (/, only for a signed-in session: src/session.ts). Config from the environment:
//   DATABASE_URL  postgres://…  (or pglite:<folder> / pglite:memory for local runs)
//   STORAGE       gs://<bucket>/<prefix>  or  file:<folder>
//   ADMIN_TOKEN   the shared admin token (required)
//   CACHE_DIR     where GCS files are kept locally (default ./.cache)
//   PORT          3000
import { handle as adminHandle } from "./admin"
import { dashboardFile } from "./dashboard"
import { type Db, migrate, openDb } from "./db"
import { pruneStats } from "./model"
import * as phone from "./phone"
import { fcmSender, type PushSender } from "./push"
import { clientAddress, cookieOf, isBlocked, isHttps, noteFailure, pruneSessions, sessionCookie, sessionOf, useLoginCode } from "./session"
import { type FileStore, openStore } from "./storage"

const notFound = () => new Response("not found", { status: 404, headers: { "content-type": "text/plain", "cache-control": "no-store" } })

export const SERVER_VERSION = "0.1.0"

export interface StartOptions {
  db: Db
  store: FileStore
  adminToken: string
  port?: number
  hostname?: string
  log?: boolean
  /** The FCM sender for "check now" pushes (default: FCM HTTP v1, src/push.ts). */
  push?: PushSender
}

export function startServer(o: StartOptions) {
  if (o.adminToken.length < 16) throw new Error("ADMIN_TOKEN must be at least 16 characters")
  const started = new Date().toISOString()
  const deps = { db: o.db, store: o.store, log: o.log }
  const admin = { db: o.db, store: o.store, token: o.adminToken, started, version: SERVER_VERSION, push: o.push ?? fcmSender }
  const prune = setInterval(() => {
    void pruneStats(o.db).catch(() => {})
    void pruneSessions(o.db).catch(() => {})
  }, 3_600_000)
  const server = Bun.serve({
    port: o.port ?? 3000,
    hostname: o.hostname ?? "0.0.0.0",
    development: false,
    routes: {
      "/health": () => Response.json({ ok: true, protocol: phone.PROTOCOL, version: SERVER_VERSION }),
    },
    async fetch(request, srv) {
      const url = new URL(request.url)
      const path = url.pathname
      const address = clientAddress(request, srv.requestIP(request)?.address)
      try {
        if (path === "/v1/check" && request.method === "POST") return await phone.check(deps, request)
        if (path.startsWith("/v1/files/") && (request.method === "GET" || request.method === "HEAD")) {
          return await phone.file(deps, request, decodeURIComponent(path.slice("/v1/files/".length)))
        }
        if (path === "/v1/store" && request.method === "GET") return await phone.store(deps, url)
        if (path === "/v1/updates/check" && request.method === "GET") return await phone.legacyStoreCheck(deps, request)
        if (path.startsWith("/admin/")) return await adminHandle(admin, request, url, address)
        // The one-time link from `bun run updates dashboard`: trade the code for a session cookie, then go to the page
        if (path === "/open" && request.method === "GET") {
          if (isBlocked(address)) return new Response("too many wrong links from this address: wait 10 minutes", { status: 429 })
          const s = await useLoginCode(o.db, url.searchParams.get("code") ?? "")
          if (!s) {
            noteFailure(address)
            return new Response("This link has expired or was used already. Open the dashboard again from your terminal.", {
              status: 404,
              headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
            })
          }
          return new Response(null, {
            status: 303,
            headers: { location: "/", "cache-control": "no-store", "set-cookie": sessionCookie(s.sessionId, s.maxAgeSeconds, isHttps(request, url)) },
          })
        }
        // The dashboard's page and files: only for a signed-in session; to anyone else they don't exist
        if (request.method === "GET" && !path.startsWith("/v1/")) {
          if (!(await sessionOf(o.db, cookieOf(request)))) return notFound()
          const f = await dashboardFile(path)
          if (!f) return notFound()
          return new Response(f.body, {
            headers: { "content-type": f.type, "cache-control": path === "/" ? "no-store" : "private, max-age=86400", "x-content-type-options": "nosniff" },
          })
        }
        return notFound()
      } catch (e) {
        console.error(`✗ ${request.method} ${path}: ${(e as Error).stack ?? e}`)
        return Response.json({ error: "server error" }, { status: 500 })
      }
    },
  })
  return {
    server,
    stop: async () => {
      clearInterval(prune)
      server.stop(true)
    },
  }
}

if (import.meta.main) {
  const env = process.env
  const db = await openDb(env.DATABASE_URL ?? "")
  const applied = await migrate(db)
  if (applied.length) console.log(`database: applied ${applied.join(", ")}`)
  const store = openStore(env.STORAGE ?? "", env.CACHE_DIR ?? "./.cache")
  const { server } = startServer({ db, store, adminToken: env.ADMIN_TOKEN ?? "", port: Number(env.PORT ?? 3000) })
  console.log(`zn-updates ${SERVER_VERSION} on :${server.port} (${db.kind}, ${store.where})`)
}
