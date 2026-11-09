// Dashboard sign-in (docs/zn-updates server §5.1). The browser never sees the admin token:
//   1. `bun run updates dashboard` sends the token (POST /admin/login-links) and gets a one-time code (60 s, one use).
//   2. It opens the browser at /open?code=…; the server trades the code for a session cookie (12 h, HttpOnly).
//   3. The dashboard's calls send the cookie plus the header `x-zn-admin: 1`. Another site can make a browser send the
//      cookie, but not a custom header, so it can't act for you.
// Without a session, the dashboard's pages answer 404: someone who opens the address learns nothing.
// Only hashes of codes and session ids are stored. Wrong tokens and codes are counted per address and slowed down.
import { createHash, randomBytes } from "node:crypto"
import type { Db } from "./db"

export const SESSION_COOKIE = "zn_session"
export const SESSION_HOURS = 12
export const CODE_SECONDS = 60
/** The header every cookie-signed admin call must carry (the dashboard adds it). */
export const ADMIN_HEADER = "x-zn-admin"

const hash = (s: string) => createHash("sha256").update(s).digest("hex")
const newSecret = () => randomBytes(32).toString("base64url")

/** A one-time code for `by` (the person in the activity log). */
export async function createLoginCode(db: Db, by: string): Promise<{ code: string; expiresInSeconds: number }> {
  const code = newSecret()
  await db.query(`INSERT INTO login_codes (code_hash, by, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`, [hash(code), by, CODE_SECONDS])
  return { code, expiresInSeconds: CODE_SECONDS }
}

/** Uses the code (once, before it expires) and starts a session. Null: unknown, used or expired. */
export async function useLoginCode(db: Db, code: string): Promise<{ sessionId: string; by: string; maxAgeSeconds: number } | null> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(code)) return null
  return db.tx(async (q) => {
    const rows = await q.query<{ by: string }>(
      `UPDATE login_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING by`,
      [hash(code)],
    )
    const by = rows[0]?.by
    if (!by) return null
    const sessionId = newSecret()
    await q.query(`INSERT INTO sessions (id_hash, by, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`, [hash(sessionId), by, SESSION_HOURS])
    return { sessionId, by, maxAgeSeconds: SESSION_HOURS * 3600 }
  })
}

export async function sessionOf(db: Db, sessionId: string | null): Promise<{ by: string; expiresAt: string } | null> {
  if (!sessionId || !/^[A-Za-z0-9_-]{20,100}$/.test(sessionId)) return null
  const rows = await db.query<{ by: string; expires_at: Date | string }>(
    `SELECT by, expires_at FROM sessions WHERE id_hash = $1 AND expires_at > now()`,
    [hash(sessionId)],
  )
  const r = rows[0]
  return r ? { by: r.by, expiresAt: new Date(r.expires_at).toISOString() } : null
}

export async function endSession(db: Db, sessionId: string | null) {
  if (sessionId) await db.query(`DELETE FROM sessions WHERE id_hash = $1`, [hash(sessionId)])
}

/** Drops expired codes and sessions (with the hourly stats prune). */
export async function pruneSessions(db: Db) {
  await db.query(`DELETE FROM login_codes WHERE expires_at < now() - interval '1 day'`)
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`)
}

export function cookieOf(request: Request, name = SESSION_COOKIE): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=")
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

/** True when the browser reached us over HTTPS (directly, or through the load balancer). */
export function isHttps(request: Request, url: URL): boolean {
  return url.protocol === "https:" || (request.headers.get("x-forwarded-proto") ?? "").split(",")[0]?.trim() === "https"
}

/** The Set-Cookie value. maxAge 0 ends it. SameSite=Lax so a bookmark still works; writes also need ADMIN_HEADER. */
export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`
}

// ---- Slowing down guesses -----------------------------------------------------------------------------------------------

const WINDOW_MS = 10 * 60_000
const MAX_FAILURES = 20
const failures = new Map<string, { count: number; since: number }>()

/**
 * The caller's address. Behind Google's load balancer the last X-Forwarded-For entry is the balancer and the one before
 * it is the client (anything earlier was sent by the client itself, so it can't be trusted).
 */
export function clientAddress(request: Request, direct?: string | null): string {
  const xff = (request.headers.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  if (xff.length >= 2) return xff[xff.length - 2]!
  return xff[0] ?? direct ?? "unknown"
}

/** True when this address had too many wrong tokens or codes lately. */
export function isBlocked(address: string): boolean {
  const f = failures.get(address)
  if (!f) return false
  if (Date.now() - f.since > WINDOW_MS) {
    failures.delete(address)
    return false
  }
  return f.count >= MAX_FAILURES
}

export function noteFailure(address: string) {
  const f = failures.get(address)
  if (!f || Date.now() - f.since > WINDOW_MS) failures.set(address, { count: 1, since: Date.now() })
  else f.count++
  if (failures.size > 10_000) failures.clear() // a flood of addresses: start over rather than grow without end
}

/** For tests. */
export function resetFailures() {
  failures.clear()
}
