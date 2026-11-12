// The server's records and rules (docs/zn-updates-server.md §3, §5). Every write checks its rule here, whoever calls
// it (the dashboard, the CLI): the dashboard checks the same rules first only to explain them sooner.
import { createHash } from "node:crypto"
import type { BundleRequires } from "../../tools/bundle-info"
import { type Manifest, type Pointer, PRIORITIES } from "../../tools/ota/core"
import { missing, type Capabilities } from "../../tools/ota/decide"
import { BUILT_IN, bundleText, pointerText, requiresLine, sha256Hex, verifyText } from "../../tools/ota/signing"
import type { Db } from "./db"
import type { FileStore } from "./storage"
import { decideStore, type Os, type StoreRule, versionNumber } from "./storeRules"

export const PRODUCTION = "production"
export const STAGING = "staging"
export const TITLE_MAX = 30

/** A rule was broken: the message says which and what to do. `status` 409 = someone else changed it first. */
export class RuleError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

const APP_ID = /^[a-z][a-z0-9_.-]{0,63}$/
const CHANNEL = /^[a-z][a-z0-9-]{0,31}$/

export interface App {
  id: string
  name: string
  publicKeys: string[]
  store: Record<string, unknown>
  /** "Check for an update now" pushes (src/push.ts PushConfig); {} = none. */
  push: Record<string, unknown>
}

// ---- Apps and channels ------------------------------------------------------------------------------------------------

export async function listApps(db: Db): Promise<App[]> {
  const rows = await db.query<{ id: string; name: string; public_keys: string[]; store: Record<string, unknown>; push: Record<string, unknown> }>(
    `SELECT id, name, public_keys, store, push FROM apps ORDER BY id`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name, publicKeys: r.public_keys, store: r.store, push: r.push ?? {} }))
}

export async function getApp(db: Db, id: string): Promise<App> {
  const app = (await listApps(db)).find((a) => a.id === id)
  if (!app) throw new RuleError(`no app "${id}"`, 404)
  return app
}

/** Creates the app, or updates its name / keys / store facts. Channels staging and production always exist. */
export async function saveApp(db: Db, a: { id: string; name?: string; publicKeys?: string[]; store?: Record<string, unknown>; push?: Record<string, unknown> }, by: string) {
  if (!APP_ID.test(a.id)) throw new RuleError("app id: a-z, 0-9, _ . - (the zn app id from zn-bundle.json)")
  for (const k of a.publicKeys ?? []) {
    if (!/^[A-Za-z0-9+/=]{80,200}$/.test(k)) throw new RuleError("a public key must be base64 SPKI DER (`bun run ota keygen` prints it)")
  }
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO apps (id, name, public_keys, store) VALUES ($1, $2, $3::text::jsonb, $4::text::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         name = COALESCE($5, apps.name),
         public_keys = COALESCE($6::text::jsonb, apps.public_keys),
         store = COALESCE($7::text::jsonb, apps.store),
         push = COALESCE($8::text::jsonb, apps.push)`,
      [
        a.id,
        a.name ?? a.id,
        JSON.stringify(a.publicKeys ?? []),
        JSON.stringify(a.store ?? {}),
        a.name ?? null,
        a.publicKeys ? JSON.stringify(a.publicKeys) : null,
        a.store ? JSON.stringify(a.store) : null,
        a.push ? JSON.stringify(a.push) : null,
      ],
    )
    for (const ch of [STAGING, PRODUCTION]) {
      await q.query(`INSERT INTO channels (app, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [a.id, ch])
    }
    await logActivity(q, a.id, by, "app.save", { name: a.name, keys: a.publicKeys?.length, store: a.store, push: a.push })
  })
  appStoreIdCache.clear()
}

export async function channels(db: Db, app: string): Promise<string[]> {
  return (await db.query<{ name: string }>(`SELECT name FROM channels WHERE app = $1 ORDER BY name`, [app])).map((r) => r.name)
}

async function checkChannel(db: Db, app: string, channel: string) {
  if (!CHANNEL.test(channel) || !(await channels(db, app)).includes(channel)) throw new RuleError(`no channel "${channel}" in ${app}`)
}

// ---- Serials ----------------------------------------------------------------------------------------------------------

/**
 * The serial for a bundle that was just built ([kind] "bundle"), or for a store build's built-in bundle ("store").
 * One line per app, shared by both, so a store build is always newer than every OTA bundle before it.
 * One bundle = one serial: the same bytes (and the same needs) get the same serial back, whichever kind took it first
 * (an OTA release of the code that is in a store build gets that store build's number, and the other way round).
 * `existing` is the released bundle with that serial, if any.
 * [bytes] is required for a bundle. A store build should send it too; without it the serial is just a new number.
 */
export async function reserveSerial(
  db: Db,
  app: string,
  kind: "bundle" | "store",
  bytes: { sha256: string; requires: BundleRequires } | null,
  by: string,
): Promise<{ serial: number; existing: Manifest | null }> {
  await getApp(db, app)
  if (kind === "bundle" && !bytes) throw new RuleError("a bundle serial needs the bundle's sha256 and requires")
  if (bytes && !/^[0-9a-f]{64}$/.test(bytes.sha256)) throw new RuleError("sha256 must be 64 hex characters")
  const line = bytes ? requiresLine(bytes.requires) : null
  for (let attempt = 0; attempt < 5; attempt++) {
    if (bytes) {
      const same = await db.query<{ serial: number }>(
        `SELECT serial FROM serials WHERE app = $1 AND bundle_sha256 = $2 AND requires_line = $3 ORDER BY serial LIMIT 1`,
        [app, bytes.sha256, line],
      )
      if (same[0]) {
        const released = await db.query<{ manifest: Manifest }>(`SELECT manifest FROM bundles WHERE app = $1 AND serial = $2`, [app, same[0].serial])
        return { serial: same[0].serial, existing: released[0]?.manifest ?? null }
      }
    }
    const top = await db.query<{ max: number | null }>(`SELECT max(serial)::int AS max FROM serials WHERE app = $1`, [app])
    const serial = (top[0]?.max ?? 0) + 1
    try {
      await db.query(
        `INSERT INTO serials (app, serial, kind, bundle_sha256, requires_line, taken_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [app, serial, kind, bytes?.sha256 ?? null, line, by],
      )
      await logActivity(db, app, by, "serial.reserve", { serial, kind })
      return { serial, existing: null }
    } catch (e) {
      if (!isUniqueViolation(e)) throw e // someone took this serial (or these bytes) first: look again
    }
  }
  throw new RuleError("could not take a serial (other builds kept winning); try again", 409)
}

/**
 * Read-only: the serial these bytes would get, without taking it (`updates builtin` for a test APK). The same bytes
 * already have a serial: that one (`taken`). Otherwise the next free one, which the next release or store build takes;
 * every test APK built before that release shows the same number. Patches match by SHA-256, so a test APK whose
 * bytes differ from the bundle later released under that number never gets a wrong patch.
 */
export async function peekSerial(
  db: Db,
  app: string,
  bytes: { sha256: string; requires: BundleRequires },
): Promise<{ serial: number; taken: boolean }> {
  await getApp(db, app)
  if (!/^[0-9a-f]{64}$/.test(bytes.sha256)) throw new RuleError("sha256 must be 64 hex characters")
  const same = await db.query<{ serial: number }>(
    `SELECT serial FROM serials WHERE app = $1 AND bundle_sha256 = $2 AND requires_line = $3 ORDER BY serial LIMIT 1`,
    [app, bytes.sha256, requiresLine(bytes.requires)],
  )
  if (same[0]) return { serial: same[0].serial, taken: true }
  const top = await db.query<{ max: number | null }>(`SELECT max(serial)::int AS max FROM serials WHERE app = $1`, [app])
  return { serial: (top[0]?.max ?? 0) + 1, taken: false }
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; errno?: string })?.code ?? (e as { errno?: string })?.errno
  return code === "23505" || /duplicate key|unique constraint/i.test(String((e as Error)?.message))
}

// ---- Bundles ----------------------------------------------------------------------------------------------------------

export interface BundleRow {
  app: string
  serial: number
  id: string
  manifest: Manifest
  gitSubject: string
  builtBy: string
  builtAt: string
  stableAt: string | null
  stableBy: string | null
  stableNote: string | null
  customerTitle: string | null
  note: string | null
  /** Marked for delete: the server removes it at this time (30 days after the mark); null = kept. */
  deleteAt: string | null
  deleteBy: string | null
}

function bundleRow(r: Record<string, unknown>): BundleRow {
  return {
    app: r.app as string,
    serial: r.serial as number,
    id: r.id as string,
    manifest: r.manifest as Manifest,
    gitSubject: r.git_subject as string,
    builtBy: r.built_by as string,
    builtAt: iso(r.built_at),
    stableAt: r.stable_at ? iso(r.stable_at) : null,
    stableBy: (r.stable_by as string) ?? null,
    stableNote: (r.stable_note as string) ?? null,
    customerTitle: (r.customer_title as string) ?? null,
    note: (r.note as string) ?? null,
    deleteAt: r.delete_at ? iso(r.delete_at) : null,
    deleteBy: (r.delete_by as string) ?? null,
  }
}

export async function bundles(db: Db, app: string): Promise<BundleRow[]> {
  return (await db.query(`SELECT * FROM bundles WHERE app = $1 ORDER BY serial DESC`, [app])).map(bundleRow)
}

export async function bundle(db: Db, app: string, ref: string | number): Promise<BundleRow> {
  const serial = typeof ref === "number" ? ref : /^\d+$/.test(ref) ? Number(ref) : Number(ref.slice(ref.lastIndexOf("_") + 1))
  const rows = await db.query(`SELECT * FROM bundles WHERE app = $1 AND serial = $2`, [app, serial])
  if (!rows[0]) throw new RuleError(`no bundle #${serial} in ${app}`, 404)
  return bundleRow(rows[0])
}

/**
 * Stores a bundle the CLI built and signed: the manifest (exactly what phones get) and its zip. Checked: the serial
 * was reserved for these bytes, the zip is the one the manifest names, and the signature is good with the app's keys.
 */
export async function uploadBundle(
  db: Db,
  store: FileStore,
  app: string,
  manifest: Manifest,
  zip: Uint8Array,
  facts: { gitSubject?: string; builtBy: string },
): Promise<BundleRow> {
  const a = await getApp(db, app)
  const m = manifest
  if (m.app !== app) throw new RuleError(`the manifest is for app "${m.app}"`)
  if (m.id !== `${app}_${m.serial}`) throw new RuleError(`bundle id must be ${app}_${m.serial}`)
  const zipSha = sha256Hex(zip)
  if (zipSha !== m.zip.sha256 || zip.length !== m.zip.size) throw new RuleError("the zip is not the one the manifest names (SHA or size)")
  if (m.zip.path !== `${app}/bundles/${m.id}/${zipSha}.zip`) throw new RuleError(`zip path must be ${app}/bundles/${m.id}/${zipSha}.zip`)
  const text = bundleText({ app, id: m.id, serial: m.serial, bundleSha256: m.bundleSha256, requires: m.requires, zipSha256: zipSha, zipSize: zip.length })
  if (a.publicKeys.length === 0) throw new RuleError(`app ${app} has no public keys yet (Environment page)`)
  if (!verifyText(text, m.signature, a.publicKeys)) throw new RuleError("the bundle's signature doesn't match the app's public keys")
  const reserved = await db.query<{ bundle_sha256: string; requires_line: string }>(
    `SELECT bundle_sha256, requires_line FROM serials WHERE app = $1 AND serial = $2`,
    [app, m.serial],
  )
  // A store build's serial with these same bytes is fine too: one bundle = one serial.
  const r = reserved[0]
  if (!r || r.bundle_sha256 !== m.bundleSha256 || r.requires_line !== requiresLine(m.requires)) {
    throw new RuleError(`serial #${m.serial} was not reserved for these bytes; build again`)
  }
  const already = await db.query(`SELECT * FROM bundles WHERE app = $1 AND serial = $2`, [app, m.serial])
  if (already[0]) return bundleRow(already[0])
  await store.put(m.zip.path, zip)
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO bundles (app, serial, id, bundle_sha256, requires, zip_path, zip_sha256, zip_size, manifest, git_commit,
         git_subject, git_dirty, built_by, built_at)
       VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7, $8, $9::text::jsonb, $10, $11, $12, $13, $14)`,
      [app, m.serial, m.id, m.bundleSha256, JSON.stringify(m.requires), m.zip.path, zipSha, zip.length, JSON.stringify(m),
        m.git.commit, (facts.gitSubject ?? "").slice(0, 300), m.git.dirty, facts.builtBy, m.builtAt],
    )
    await logActivity(q, app, facts.builtBy, "bundle.upload", { serial: m.serial, size: zip.length, commit: m.git.commit, dirty: m.git.dirty })
  })
  return bundle(db, app, m.serial)
}

export async function setStable(db: Db, app: string, serial: number, on: boolean, by: string, note?: string) {
  const b = await bundle(db, app, serial)
  if (on) {
    const served = await db.query(`SELECT 1 FROM pointers WHERE app = $1 AND channel = $2 AND target = $3 LIMIT 1`, [app, STAGING, b.id])
    if (!served[0]) throw new RuleError(`staging never served #${serial}: publish it to staging and test it first`)
    if (b.stableAt) throw new RuleError(`#${serial} is already marked stable`)
  }
  await db.query(`UPDATE bundles SET stable_at = $3, stable_by = $4, stable_note = $5 WHERE app = $1 AND serial = $2`, [
    app, serial, on ? new Date().toISOString() : null, on ? by : null, on ? (note ?? "").slice(0, 300) || null : null,
  ])
  await logActivity(db, app, by, on ? "bundle.stable" : "bundle.unstable", { serial, note })
}

/** What customers see for this update (the app's update strip); empty = a silent fix. Printable, at most 30 characters. */
export async function setTitle(db: Db, app: string, serial: number, title: string, by: string) {
  const t = title.trim()
  if (t.length > TITLE_MAX) throw new RuleError(`a customer title is at most ${TITLE_MAX} characters`)
  if (/[\u0000-\u001f]/.test(t)) throw new RuleError("a customer title is one line of text")
  await bundle(db, app, serial)
  await db.query(`UPDATE bundles SET customer_title = $3 WHERE app = $1 AND serial = $2`, [app, serial, t || null])
  await logActivity(db, app, by, "bundle.title", { serial, title: t })
}

// ---- Delete with a 30-day hold, the "live" mark (Pavan, 2026-11-10) ---------------------------------------------------
// A delete is a mark: the dashboard hides the item, and the server removes it (rows and files) DELETE_AFTER_DAYS later
// (purgeDeleted). Until then it can be undone. Phones that run a deleted bundle keep their own copy; we only lose the
// rollback to it, patches from it (those phones download full zips) and, with its map, decoding its stacks.
// The serial stays taken for good: a phone that ran it must never see another bundle under the same number.

export const DELETE_AFTER_DAYS = 30

/** Why [b] can't be marked for delete now, or null. */
async function whyKeepBundle(db: Db, app: string, b: BundleRow): Promise<string | null> {
  for (const ch of await channels(db, app)) {
    if ((await current(db, app, ch))?.target === b.id) return `${ch} serves #${b.serial} now: publish another bundle there (or use the kill switch) first`
  }
  const live = await db.query<{ label: string }>(
    `SELECT label FROM store_builds WHERE app = $1 AND builtin_serial = $2 AND live_at IS NOT NULL AND delete_at IS NULL LIMIT 1`,
    [app, b.serial],
  )
  if (live[0]) return `#${b.serial} is built into "${live[0].label}", which is marked live on the store: its phones need it as a patch base`
  return null
}

/** Marks a bundle for delete ([on]), or takes the mark back. */
export async function markBundleDelete(db: Db, app: string, serial: number, on: boolean, by: string) {
  const b = await bundle(db, app, serial)
  if (on) {
    if (b.deleteAt) throw new RuleError(`#${serial} is already marked for delete`)
    const why = await whyKeepBundle(db, app, b)
    if (why) throw new RuleError(why)
  } else if (!b.deleteAt) throw new RuleError(`#${serial} is not marked for delete`)
  const at = on ? new Date(Date.now() + DELETE_AFTER_DAYS * 86_400_000).toISOString() : null
  await db.tx(async (q) => {
    await q.query(`UPDATE bundles SET delete_at = $3, delete_by = $4 WHERE app = $1 AND serial = $2`, [app, serial, at, on ? by : null])
    await logActivity(q, app, by, on ? "bundle.delete.mark" : "bundle.delete.undo", { serial, at })
  })
  return bundle(db, app, serial)
}

/** Kept for the CLI and older dashboards: a delete is now a mark (removed 30 days later). */
export async function deleteBundle(db: Db, app: string, serial: number, by: string) {
  await markBundleDelete(db, app, serial, true, by)
}

/** Phones that ran any of [running] (bundle ids, or `built-in:<id>`) in the last [days] days (stats keep 35). */
export async function phonesOn(db: Db, app: string, running: string[], days = DELETE_AFTER_DAYS): Promise<number> {
  if (running.length === 0) return 0
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const marks = running.map((_, i) => `$${i + 3}`).join(", ")
  const rows = await db.query<{ n: number }>(
    `SELECT count(DISTINCT install)::int AS n FROM installs_daily WHERE app = $1 AND day >= $2 AND running IN (${marks})`,
    [app, since, ...running],
  )
  return rows[0]?.n ?? 0
}

/** The ids a phone reports while it runs bundle #[serial]: as an OTA bundle, or as the APK's own (built-in) one. */
export function runningIds(app: string, serial: number): string[] {
  return [`${app}_${serial}`, `built-in:${app}_${serial}`]
}

async function storeBuildRow(db: Db, app: string, id: number) {
  const rows = await db.query(`SELECT * FROM store_builds WHERE app = $1 AND id = $2`, [app, id])
  if (!rows[0]) throw new RuleError(`no store build ${id} in ${app}`, 404)
  return rows[0]
}

/** Marks a store build "live on Play / App Store" ([on]) or takes the mark off. A live build can't be deleted. */
export async function setStoreBuildLive(db: Db, app: string, id: number, on: boolean, by: string) {
  const r = await storeBuildRow(db, app, id)
  if (on && r.delete_at) throw new RuleError(`"${r.label}" is marked for delete: undo that first`)
  await db.tx(async (q) => {
    await q.query(`UPDATE store_builds SET live_at = $3, live_by = $4 WHERE app = $1 AND id = $2`, [app, id, on ? new Date().toISOString() : null, on ? by : null])
    await logActivity(q, app, by, on ? "storebuild.live" : "storebuild.unlive", { id, label: r.label, serial: r.builtin_serial })
  })
}

/** Marks a store build for delete ([on]), or takes the mark back. Not while it is marked live. */
export async function markStoreBuildDelete(db: Db, app: string, id: number, on: boolean, by: string) {
  const r = await storeBuildRow(db, app, id)
  if (on) {
    if (r.delete_at) throw new RuleError(`"${r.label}" is already marked for delete`)
    if (r.live_at) throw new RuleError(`"${r.label}" is marked live on the store: take that mark off first`)
  } else if (!r.delete_at) throw new RuleError(`"${r.label}" is not marked for delete`)
  const at = on ? new Date(Date.now() + DELETE_AFTER_DAYS * 86_400_000).toISOString() : null
  await db.tx(async (q) => {
    await q.query(`UPDATE store_builds SET delete_at = $3, delete_by = $4 WHERE app = $1 AND id = $2`, [app, id, at, on ? by : null])
    await logActivity(q, app, by, on ? "storebuild.delete.mark" : "storebuild.delete.undo", { id, label: r.label, serial: r.builtin_serial, at })
  })
}

/** Phones that ran store build [id]'s built-in bundle (any store build with that serial) in the last 30 days. */
export async function storeBuildPhones(db: Db, app: string, id: number) {
  const r = await storeBuildRow(db, app, id)
  return phonesOn(db, app, [`built-in:${app}_${r.builtin_serial}`])
}

/**
 * Removes what was marked for delete and is due ([now]): its rows, then its files (zip, patches to and from it, its
 * patch base, its map when nothing kept has the same bytes). Each row is taken with DELETE ... RETURNING, so two
 * server copies never remove the same thing twice. A bundle a channel serves again (published after the mark) is
 * skipped and its mark taken off. Files that fail to go are logged (they cost space only).
 */
export async function purgeDeleted(db: Db, store: FileStore, now = new Date()): Promise<{ bundles: number[]; storeBuilds: number[] }> {
  const done = { bundles: [] as number[], storeBuilds: [] as number[] }
  const files: string[] = []
  const at = now.toISOString()
  const dueBundles = await db.query<{ app: string; serial: number; id: string }>(`SELECT app, serial, id FROM bundles WHERE delete_at IS NOT NULL AND delete_at <= $1`, [at])
  for (const d of dueBundles) {
    let servedNow = false
    for (const ch of await channels(db, d.app)) if ((await current(db, d.app, ch))?.target === d.id) servedNow = true
    if (servedNow) {
      await db.query(`UPDATE bundles SET delete_at = NULL, delete_by = NULL WHERE app = $1 AND serial = $2`, [d.app, d.serial])
      await logActivity(db, d.app, "server", "bundle.delete.undo", { serial: d.serial, why: "a channel serves it" })
      continue
    }
    await db.tx(async (q) => {
      const gone = await q.query<{ zip_path: string; bundle_sha256: string }>(
        `DELETE FROM bundles WHERE app = $1 AND serial = $2 AND delete_at IS NOT NULL AND delete_at <= $3 RETURNING zip_path, bundle_sha256`,
        [d.app, d.serial, at],
      )
      if (!gone[0]) return // another server copy took it
      // Patches to it go. Patches from its bytes stay while a store build has the same built-in bundle (one bundle = one
      // serial = one SHA): that build's phones still use them. Its map stays then too.
      const kept = await shaKept(q, d.app, gone[0].bundle_sha256)
      const patches = await q.query<{ path: string }>(
        kept ? `DELETE FROM patches WHERE app = $1 AND to_id = $2 RETURNING path` : `DELETE FROM patches WHERE app = $1 AND (to_id = $2 OR from_id = $2 OR from_sha256 = $3) RETURNING path`,
        kept ? [d.app, d.id] : [d.app, d.id, gone[0].bundle_sha256],
      )
      files.push(gone[0].zip_path, ...patches.map((p) => p.path))
      if (!kept) files.push(`${d.app}/maps/${gone[0].bundle_sha256}.map`)
      await logActivity(q, d.app, "server", "bundle.delete", { serial: d.serial })
      done.bundles.push(d.serial)
    })
  }
  const dueBuilds = await db.query<{ app: string; id: number }>(`SELECT app, id FROM store_builds WHERE delete_at IS NOT NULL AND delete_at <= $1`, [at])
  for (const d of dueBuilds) {
    await db.tx(async (q) => {
      const gone = await q.query<{ label: string; builtin_serial: number; builtin_sha256: string; base_path: string | null }>(
        `DELETE FROM store_builds WHERE app = $1 AND id = $2 AND delete_at IS NOT NULL AND delete_at <= $3 AND live_at IS NULL
         RETURNING label, builtin_serial, builtin_sha256, base_path`,
        [d.app, d.id, at],
      )
      const g = gone[0]
      if (!g) return
      const sameSerial = await q.query(`SELECT 1 FROM store_builds WHERE app = $1 AND builtin_serial = $2 LIMIT 1`, [d.app, g.builtin_serial])
      if (!sameSerial[0]) {
        // No other store build carries this built-in bundle: its base goes, and the patches from it and its map unless
        // an OTA bundle with the same bytes is kept (then they still serve that bundle's phones).
        if (g.base_path) files.push(g.base_path)
        if (!(await shaKept(q, d.app, g.builtin_sha256))) {
          const patches = await q.query<{ path: string }>(`DELETE FROM patches WHERE app = $1 AND from_sha256 = $2 RETURNING path`, [d.app, g.builtin_sha256])
          files.push(...patches.map((p) => p.path), `${d.app}/maps/${g.builtin_sha256}.map`)
        }
      }
      await logActivity(q, d.app, "server", "storebuild.delete", { id: d.id, label: g.label, serial: g.builtin_serial })
      done.storeBuilds.push(d.id)
    })
  }
  for (const f of files) {
    try {
      await store.remove(f)
    } catch (e) {
      console.warn(`purge: could not remove ${f}: ${(e as Error).message}`)
    }
  }
  if (done.bundles.length || done.storeBuilds.length) console.log(`purge: removed bundles ${done.bundles.join(", ") || "none"}, store builds ${done.storeBuilds.join(", ") || "none"}`)
  return done
}

/** True when a bundle or store build that stays has these bytes (its map and the patches from it are still needed). */
async function shaKept(q: Pick<Db, "query">, app: string, sha: string): Promise<boolean> {
  if ((await q.query(`SELECT 1 FROM bundles WHERE app = $1 AND bundle_sha256 = $2 LIMIT 1`, [app, sha]))[0]) return true
  return !!(await q.query(`SELECT 1 FROM store_builds WHERE app = $1 AND builtin_sha256 = $2 LIMIT 1`, [app, sha]))[0]
}

// ---- Pointers ---------------------------------------------------------------------------------------------------------

export interface PointerRow {
  pointer: Pointer
  kind: string
  publishedBy: string
  at: string
  /** The channel's rollout before this change (null: nothing was published). */
  previousRollout?: number | null
}

export async function current(db: Db, app: string, channel: string): Promise<Pointer | null> {
  const rows = await db.query<{ pointer: Pointer }>(
    `SELECT pointer FROM pointers WHERE app = $1 AND channel = $2 ORDER BY seq DESC LIMIT 1`,
    [app, channel],
  )
  return rows[0]?.pointer ?? null
}

export async function history(db: Db, app: string, channel: string, limit = 200): Promise<PointerRow[]> {
  const rows = await db.query<{ pointer: Pointer; kind: string; published_by: string; at: unknown }>(
    `SELECT pointer, kind, published_by, at FROM pointers WHERE app = $1 AND channel = $2 ORDER BY seq DESC LIMIT $3`,
    [app, channel, limit],
  )
  return rows.map((r) => ({ pointer: r.pointer, kind: r.kind, publishedBy: r.published_by, at: iso(r.at) }))
}

/** The text the owner signs for the next change of [channel] to [target] (the dashboard and CLI sign it locally). */
export async function nextPointerText(db: Db, app: string, channel: string, target: string) {
  await checkChannel(db, app, channel)
  const seq = ((await current(db, app, channel))?.seq ?? 0) + 1
  return { seq, text: pointerText({ app, channel, seq, target }) }
}

export interface PointerRequest {
  /** The signed pointer (format 1, as tools/ota/core.ts writes it). */
  pointer: Pointer
  /** Production publish / rollback: `PRODUCTION #N`. Kill switch: `KILL <CHANNEL>`. */
  confirm?: string
}

/**
 * Adds a channel change (publish, roll back, rollout / priority change, kill switch). The kind is worked out from what
 * changed; each kind has its rules. The seq must be the channel's next one: if someone else changed it first, 409.
 */
export async function addPointer(db: Db, app: string, req: PointerRequest, by: string): Promise<PointerRow> {
  const a = await getApp(db, app)
  const p = req.pointer
  if (!p || p.app !== app) throw new RuleError("the pointer is for another app")
  await checkChannel(db, app, p.channel)
  if (!Number.isInteger(p.rollout) || p.rollout < 1 || p.rollout > 100) throw new RuleError("rollout must be 1–100 (to pause, roll back or use the kill switch)")
  if (!PRIORITIES.includes(p.priority)) throw new RuleError("priority must be normal, high or critical")
  if (!verifyText(pointerText(p), p.signature, a.publicKeys)) throw new RuleError("the pointer's signature doesn't match the app's public keys")
  const now = await current(db, app, p.channel)
  const nextSeq = (now?.seq ?? 0) + 1
  if (p.seq !== nextSeq) throw new RuleError(`${p.channel} changed while you worked (next change is seq ${nextSeq}): reload and do it again`, 409)

  const prod = p.channel === PRODUCTION
  let kind: string
  if (p.target === BUILT_IN) {
    kind = "kill"
    if (req.confirm !== `KILL ${p.channel.toUpperCase()}`) throw new RuleError(`type the confirmation exactly: KILL ${p.channel.toUpperCase()}`)
    if (prod && !p.reason?.trim()) throw new RuleError("a production kill switch needs a reason")
  } else {
    const b = await bundle(db, app, p.target)
    if (b.deleteAt) throw new RuleError(`#${b.serial} is marked for delete: undo that first`)
    if (now && now.target === p.target) {
      kind = "rollout"
    } else {
      const nowSerial = now && now.target !== BUILT_IN ? Number(now.target.slice(now.target.lastIndexOf("_") + 1)) : -1
      kind = b.serial < nowSerial ? "rollback" : "publish"
      if (prod) {
        const servedBefore = (await db.query(`SELECT 1 FROM pointers WHERE app = $1 AND channel = $2 AND target = $3 LIMIT 1`, [app, PRODUCTION, b.id]))[0]
        if (!b.stableAt && !servedBefore) throw new RuleError(`#${b.serial} is not marked stable on staging: publish it to staging, test it, then mark it stable`)
        if (b.manifest.git.dirty) throw new RuleError(`#${b.serial} was built from uncommitted changes; production takes only bundles built from a commit`)
        if (req.confirm !== `PRODUCTION #${b.serial}`) throw new RuleError(`type the confirmation exactly: PRODUCTION #${b.serial}`)
      }
    }
  }
  try {
    await db.tx(async (q) => {
      await q.query(
        `INSERT INTO pointers (app, channel, seq, target, rollout, priority, kind, reason, pointer, published_by, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11)`,
        [app, p.channel, p.seq, p.target, p.rollout, p.priority, kind, p.reason ?? null, JSON.stringify(p), by, p.at],
      )
      await logActivity(q, app, by, `channel.${kind}`, { channel: p.channel, seq: p.seq, target: p.target, rollout: p.rollout, priority: p.priority, reason: p.reason })
    })
  } catch (e) {
    if (isUniqueViolation(e)) throw new RuleError(`${p.channel} changed while you worked: reload and do it again`, 409)
    throw e
  }
  answerCache.clear()
  return { pointer: p, kind, publishedBy: by, at: p.at, previousRollout: now && now.target !== BUILT_IN ? now.rollout : null }
}

// ---- Store builds and families ----------------------------------------------------------------------------------------

/**
 * A bundle's needs in 6 characters (from the signed needs line, tools/ota/signing.ts requiresLine): the same tag = the
 * same needs, for every module and both OSes. The dashboard colours bundles and store builds by it.
 */
export function needsTag(requiresLine: string): string {
  return createHash("sha256").update(requiresLine).digest("hex").slice(0, 6)
}

/** A capability set's short name: store builds with the same one can run exactly the same bundles. */
export function familyOf(c: Capabilities): string {
  const modules = Object.keys(c.modules).sort().map((m) => `${m}:${c.modules[m]}`).join(",")
  // iOS apps are a family of their own (per-OS needs); Android keeps the name it had before the OS was sent
  const os = c.os === "ios" ? ";os=ios" : ""
  const line = `registry=${c.registry};bytecode=${c.bytecode};hostApi=${c.hostApiOldest}-${c.hostApi};modules=${modules}${os}`
  return `fam_${createHash("sha256").update(line).digest("hex").slice(0, 12)}`
}

export interface StoreBuildInput {
  os: Os
  channel: string
  label: string
  versionCode: number
  versionName: string
  builtinSerial: number
  builtinSha256: string
  /** Optional: when missing, the first phone check from this build fills it in (learnCapabilities). */
  capabilities?: Capabilities | null
  git: { commit: string; dirty: boolean }
}

export async function addStoreBuild(db: Db, app: string, s: StoreBuildInput, by: string) {
  await checkChannel(db, app, s.channel)
  if (!Number.isInteger(s.versionCode) || s.versionCode <= 0) throw new RuleError("versionCode must be a whole number")
  if (!/^[0-9a-f]{64}$/.test(s.builtinSha256)) throw new RuleError("builtinSha256 must be the built-in bundle's sha256 (zn-bundle.json)")
  // The serial can be a store serial or an OTA bundle's (one bundle = one serial). If it has bytes on record, they must be these.
  const taken = await db.query<{ bundle_sha256: string | null }>(`SELECT bundle_sha256 FROM serials WHERE app = $1 AND serial = $2`, [app, s.builtinSerial])
  if (!taken[0]) throw new RuleError(`serial #${s.builtinSerial} was not reserved for a store build`)
  if (taken[0].bundle_sha256 && taken[0].bundle_sha256 !== s.builtinSha256) {
    throw new RuleError(`serial #${s.builtinSerial} was reserved for other bytes than this built-in bundle's; build again`)
  }
  // Store builds with the same serial have the same built-in bundle: patch bases are kept per serial.
  const other = await db.query(`SELECT 1 FROM store_builds WHERE app = $1 AND builtin_serial = $2 AND builtin_sha256 <> $3 LIMIT 1`, [app, s.builtinSerial, s.builtinSha256])
  if (other[0]) throw new RuleError(`another store build with built-in serial #${s.builtinSerial} has a different bundle SHA-256`)
  const family = s.capabilities ? familyOf(s.capabilities) : null
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO store_builds (app, os, channel, label, version_code, version_name, builtin_serial, builtin_sha256,
         capabilities, family, git_commit, git_dirty, built_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text::jsonb, $10, $11, $12, $13)
       ON CONFLICT (app, os, channel, version_code, builtin_serial) DO UPDATE SET
         label = $4, version_name = $6, capabilities = COALESCE($9::text::jsonb, store_builds.capabilities),
         family = COALESCE($10, store_builds.family), git_commit = $11, git_dirty = $12, built_by = $13, built_at = now()`,
      [app, s.os, s.channel, s.label.slice(0, 60), s.versionCode, s.versionName.slice(0, 40), s.builtinSerial, s.builtinSha256,
        s.capabilities ? JSON.stringify(s.capabilities) : null, family, s.git.commit, s.git.dirty, by],
    )
    await logActivity(q, app, by, "storebuild.add", { label: s.label, os: s.os, channel: s.channel, versionCode: s.versionCode, serial: s.builtinSerial, family })
  })
  return { family }
}

export async function storeBuilds(db: Db, app: string) {
  const rows = await db.query(`SELECT * FROM store_builds WHERE app = $1 ORDER BY builtin_serial DESC, built_at DESC, id DESC`, [app])
  return rows.map((r) => ({
    id: r.id as number,
    os: r.os as Os,
    channel: r.channel as string,
    label: r.label as string,
    versionCode: r.version_code as number,
    versionName: r.version_name as string,
    builtinSerial: r.builtin_serial as number,
    builtinSha256: r.builtin_sha256 as string,
    capabilities: (r.capabilities as Capabilities) ?? null,
    family: (r.family as string) ?? null,
    git: { commit: r.git_commit as string, dirty: r.git_dirty as boolean },
    builtBy: r.built_by as string,
    builtAt: iso(r.built_at),
    /** The size of the built-in bundle's zip kept as a patch base (docs/ota-patches.md §5); null = none (full zips only). */
    baseSize: (r.base_size as number) ?? null,
    /** Marked "live on Play / App Store": it can't be deleted, nor can its built-in bundle. */
    liveAt: r.live_at ? iso(r.live_at) : null,
    liveBy: (r.live_by as string) ?? null,
    /** Marked for delete: removed at this time; null = kept. */
    deleteAt: r.delete_at ? iso(r.delete_at) : null,
    deleteBy: (r.delete_by as string) ?? null,
  }))
}

/** For each family: which store builds are in it, and whether it can run each bundle (and what it lacks). */
export function familiesView(builds: Awaited<ReturnType<typeof storeBuilds>>, all: BundleRow[]) {
  const by = new Map<string, typeof builds>()
  for (const b of builds) if (b.family) by.set(b.family, [...(by.get(b.family) ?? []), b])
  return [...by.entries()].map(([family, list]) => ({
    family,
    capabilities: list[0]!.capabilities!,
    builds: list.map((b) => ({ label: b.label, os: b.os, channel: b.channel, versionCode: b.versionCode, versionName: b.versionName, builtinSerial: b.builtinSerial })),
    canRun: Object.fromEntries(all.map((b) => [b.id, missing(list[0]!.capabilities!, b.manifest.requires)])),
  }))
}

const learned = new Set<string>()

/**
 * A store build registered without its capabilities gets them from the first phone that runs it (the phone sends
 * exactly what its app has). Cheap: once per built-in bundle per process. Matched by the built-in bundle's SHA-256 too
 * (when the phone sends it): a test APK carries the next serial before it is taken (`updates builtin`), so a serial
 * alone could name a later store build with other bytes. Matched by OS too: an AAB and an IPA of one commit share the
 * built-in serial and bytes (2026-11-10), and an Android phone filled the IPA's row with its own facts (2026-11-12).
 * A phone that sends no OS is an Android one (as in `missing`).
 */
export async function learnCapabilities(db: Db, app: string, builtinSerial: number, caps: Capabilities, builtinSha256?: string) {
  const sha = builtinSha256 && /^[0-9a-f]{64}$/.test(builtinSha256) ? builtinSha256 : null
  const os = caps.os ?? "android"
  const key = `${app}|${os}|${builtinSerial}|${sha ?? ""}`
  if (builtinSerial < 1 || learned.has(key)) return
  learned.add(key)
  try {
    await db.query(
      `UPDATE store_builds SET capabilities = $3::text::jsonb, family = $4
       WHERE app = $1 AND builtin_serial = $2 AND capabilities IS NULL AND ($5::text IS NULL OR builtin_sha256 = $5)
         AND os = $6`,
      [app, builtinSerial, JSON.stringify(caps), familyOf(caps), sha, os],
    )
  } catch (e) {
    learned.delete(key)
    console.warn(`learn capabilities: ${(e as Error).message}`)
  }
}

// ---- Patches --------------------------------------------------------------------------------------------------------------

/** One patch zip: it turns the bundle `fromSha256` into bundle `toId` (docs/ota-patches.md §3, made by src/patches.ts). */
export interface PatchRow {
  toId: string
  /** The base bundle's id: an OTA bundle, or a store build's built-in bundle. */
  fromId: string
  fromSha256: string
  path: string
  sha256: string
  size: number
  madeAt: string
}

function patchRow(r: Record<string, unknown>): PatchRow {
  return {
    toId: r.to_id as string,
    fromId: r.from_id as string,
    fromSha256: r.from_sha256 as string,
    path: r.path as string,
    sha256: r.sha256 as string,
    size: r.size as number,
    madeAt: iso(r.made_at),
  }
}

/** The patches of one bundle (`toId`), or of every bundle of the app, smallest first. */
export async function patchesOf(db: Db, app: string, toId?: string): Promise<PatchRow[]> {
  const rows = await db.query(
    `SELECT * FROM patches WHERE app = $1 AND ($2::text IS NULL OR to_id = $2) ORDER BY to_id, size, from_sha256`,
    [app, toId ?? null],
  )
  return rows.map(patchRow)
}

// ---- Store rules ------------------------------------------------------------------------------------------------------
// Rules are per channel (a staging rule never reaches a production phone). `channel` is the phone's channel.

/** The rules of an app + OS: those of one [channel], or of every channel when it is left out. */
export async function storeRules(db: Db, app: string, os: Os, channel?: string) {
  const rows = await db.query(`SELECT * FROM store_rules WHERE app = $1 AND os = $2 AND ($3::text IS NULL OR channel = $3) ORDER BY channel, version DESC`, [app, os, channel ?? null])
  return rows.map((r) => ({
    id: r.id as number,
    channel: r.channel as string,
    version: r.version as number,
    critical: r.critical as 0 | 1 | 2,
    isTest: r.is_test as boolean,
    title: (r.title as string) ?? null,
    message: (r.message as string) ?? null,
    note: (r.note as string) ?? null,
    by: r.by as string,
    at: iso(r.at),
  }))
}

export async function saveStoreRule(
  db: Db,
  app: string,
  channel: string,
  os: Os,
  r: { version: number; critical: 0 | 1 | 2; isTest: boolean; title?: string | null; message?: string | null; note?: string | null },
  by: string,
) {
  await checkChannel(db, app, channel)
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO store_rules (app, os, channel, version, critical, is_test, title, message, note, by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (app, os, channel, version) DO UPDATE SET critical = $5, is_test = $6, title = $7, message = $8, note = $9, by = $10, at = now()`,
      [app, os, channel, r.version, r.critical, r.isTest, r.title?.trim() || null, r.message?.trim() || null, r.note?.trim() || null, by],
    )
    await logActivity(q, app, by, "store.rule", { channel, os, ...r })
  })
  storeCache.clear()
}

export async function deleteStoreRule(db: Db, app: string, channel: string, os: Os, version: number, by: string) {
  await checkChannel(db, app, channel)
  await db.tx(async (q) => {
    await q.query(`DELETE FROM store_rules WHERE app = $1 AND os = $2 AND channel = $3 AND version = $4`, [app, os, channel, version])
    await logActivity(q, app, by, "store.rule.delete", { channel, os, version })
  })
  storeCache.clear()
}

const storeCache = new Map<string, { at: number; rules: StoreRule[] }>()

/** The store answer for one phone of [channel] (rules cached 10 s per app + channel + OS). */
export async function storeAnswer(db: Db, app: string, channel: string, os: Os, version: string | number) {
  const v = versionNumber(os, version)
  if (v === null) return null
  const key = `${app}|${channel}|${os}`
  let c = storeCache.get(key)
  if (!c || Date.now() - c.at > 10_000) {
    const rules = (await storeRules(db, app, os, channel)).map((r) => ({ version: r.version, critical: r.critical, isTest: r.isTest, title: r.title, message: r.message }))
    c = { at: Date.now(), rules }
    storeCache.set(key, c)
  }
  return decideStore(os, c.rules, v)
}

const appStoreIdCache = new Map<string, { at: number; id: string | undefined }>()

/** The app's App Store id (store facts, ios.appStoreId), for the iOS phone's store answer. Cached 10 s; unknown app = none. */
export async function appStoreId(db: Db, app: string): Promise<string | undefined> {
  const c = appStoreIdCache.get(app)
  if (c && Date.now() - c.at < 10_000) return c.id
  const a = (await listApps(db)).find((x) => x.id === app)
  const id = ((a?.store?.ios ?? {}) as { appStoreId?: string }).appStoreId || undefined
  appStoreIdCache.set(app, { at: Date.now(), id })
  return id
}

// ---- The phone's check (cached answers) ------------------------------------------------------------------------------

/** What a channel serves now: its pointer and the manifest it names (cached 5 s; cleared by every pointer change). */
const answerCache = new Map<string, { at: number; pointer: Pointer | null; target: Manifest | null }>()

export async function served(db: Db, app: string, channel: string) {
  const key = `${app}|${channel}`
  const c = answerCache.get(key)
  if (c && Date.now() - c.at < 5_000) return c
  const pointer = await current(db, app, channel)
  let target: Manifest | null = null
  if (pointer && pointer.target !== BUILT_IN) {
    const rows = await db.query<{ manifest: Manifest }>(`SELECT manifest FROM bundles WHERE app = $1 AND id = $2`, [app, pointer.target])
    target = rows[0]?.manifest ?? null
  }
  const fresh = { at: Date.now(), pointer, target }
  answerCache.set(key, fresh)
  return fresh
}

// ---- Stats ------------------------------------------------------------------------------------------------------------

export interface PhoneOutcome {
  kind: string
  bundle?: string
  detail?: string
  stack?: string
  sha?: string
}

/** One check's telemetry: the phone counted once per day, its outcomes counted, error stacks kept. Never throws. */
export async function recordCheck(db: Db, app: string, channel: string, installId: string, running: string, outcomes: PhoneOutcome[]) {
  try {
    const day = new Date().toISOString().slice(0, 10)
    const install = createHash("sha256").update(`${app}\n${installId}`).digest("hex").slice(0, 32)
    await db.query(
      `INSERT INTO installs_daily (day, app, channel, install, running) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (day, app, channel, install) DO UPDATE SET running = $5, checks = installs_daily.checks + 1`,
      [day, app, channel, install, running],
    )
    for (const o of outcomes.slice(0, 50)) {
      const kind = o.kind.slice(0, 40)
      const bundle = (o.bundle ?? running).slice(0, 80)
      // Details with numbers or names in them would make a row per phone: keep the kind's own short words only.
      const detail = /^[a-z_]{1,40}$/.test(o.detail ?? "") ? o.detail! : ""
      await db.query(
        `INSERT INTO events_daily (day, app, channel, bundle, kind, detail, count) VALUES ($1, $2, $3, $4, $5, $6, 1)
         ON CONFLICT (day, app, channel, bundle, kind, detail) DO UPDATE SET count = events_daily.count + 1`,
        [day, app, channel, bundle, kind, detail],
      )
      if (o.stack || SERIOUS.includes(kind)) {
        await db.query(`INSERT INTO errors (app, channel, bundle, kind, detail, stack, sha) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
          app, channel, bundle, kind, (o.detail ?? "").slice(0, 300), o.stack?.slice(0, 1024) ?? null, o.sha?.slice(0, 64) ?? null,
        ])
      }
    }
  } catch (e) {
    console.warn(`stats: ${(e as Error).message}`)
  }
}

/** Outcomes that mean a bundle hurt someone (tools/ota/core.ts SERIOUS_OUTCOMES). */
export const SERIOUS = ["error_rollback", "error_screen", "launch_crashed", "watchdog_block", "apply_failed", "init_failed", "ota_off", "signature", "zip_sha"]

export async function stats(db: Db, app: string, channel: string, days: number) {
  const since = new Date(Date.now() - (Math.min(Math.max(days, 1), 35) - 1) * 86_400_000).toISOString().slice(0, 10)
  const phones = await db.query<{ day: unknown; running: string; phones: number }>(
    `SELECT day, running, count(*)::int AS phones FROM installs_daily WHERE app = $1 AND channel = $2 AND day >= $3 GROUP BY day, running ORDER BY day`,
    [app, channel, since],
  )
  const events = await db.query<{ day: unknown; bundle: string; kind: string; detail: string; count: number }>(
    `SELECT day, bundle, kind, detail, sum(count)::int AS count FROM events_daily WHERE app = $1 AND channel = $2 AND day >= $3
     GROUP BY day, bundle, kind, detail ORDER BY day`,
    [app, channel, since],
  )
  const errors = await db.query<{ at: unknown; bundle: string; kind: string; detail: string; stack: string | null; sha: string | null }>(`SELECT at, bundle, kind, detail, stack, sha FROM errors WHERE app = $1 AND channel = $2 AND at >= $3 ORDER BY at DESC LIMIT 50`, [app, channel, since])
  return {
    phones: phones.map((r) => ({ day: day(r.day), running: r.running, phones: r.phones })),
    events: events.map((r) => ({ day: day(r.day), bundle: r.bundle, kind: r.kind, detail: r.detail, count: r.count })),
    errors: errors.map((r) => ({ ...r, at: iso(r.at) })),
  }
}

/** Drops stats older than 35 days (run once an hour). */
export async function pruneStats(db: Db) {
  const before = new Date(Date.now() - 35 * 86_400_000).toISOString().slice(0, 10)
  await db.query(`DELETE FROM installs_daily WHERE day < $1`, [before])
  await db.query(`DELETE FROM events_daily WHERE day < $1`, [before])
  await db.query(`DELETE FROM errors WHERE at < $1`, [before])
}

// ---- Activity ---------------------------------------------------------------------------------------------------------

export async function logActivity(db: Db, app: string | null, by: string, action: string, detail: Record<string, unknown>) {
  await db.query(`INSERT INTO activity (app, by, action, detail) VALUES ($1, $2, $3, $4::text::jsonb)`, [app, by, action, JSON.stringify(detail)])
}

export async function activity(db: Db, app: string, limit = 200, before?: number) {
  const rows = await db.query(
    `SELECT id, at, by, action, detail FROM activity WHERE app = $1 AND ($3::bigint IS NULL OR id < $3) ORDER BY id DESC LIMIT $2`,
    [app, Math.min(limit, 500), before ?? null],
  )
  return rows.map((r) => ({ id: Number(r.id), at: iso(r.at), by: r.by as string, action: r.action as string, detail: r.detail }))
}

// ---- The whole state for the dashboard --------------------------------------------------------------------------------

export async function state(db: Db, app: string) {
  const a = await getApp(db, app)
  const all = await bundles(db, app)
  const chs = await channels(db, app)
  const channelState = await Promise.all(
    chs.map(async (ch) => {
      const h = await history(db, app, ch)
      return { name: ch, current: h[0] ?? null, history: h }
    }),
  )
  const builds = await storeBuilds(db, app)
  const patchesByTo = new Map<string, PatchRow[]>()
  for (const p of await patchesOf(db, app)) patchesByTo.set(p.toId, [...(patchesByTo.get(p.toId) ?? []), p])
  const served = new Map<string, string[]>()
  const everOn = new Map<string, Set<string>>()
  for (const c of channelState) {
    if (c.current && c.current.pointer.target !== BUILT_IN) served.set(c.current.pointer.target, [...(served.get(c.current.pointer.target) ?? []), c.name])
    for (const h of c.history) everOn.set(h.pointer.target, (everOn.get(h.pointer.target) ?? new Set()).add(c.name))
  }
  // Needs tags: a store build's built-in needs come from its serial's row (store-build sends the bundle's needs)
  const lines = new Map<number, string>()
  for (const r of await db.query<{ serial: number; requires_line: string | null }>(`SELECT serial, requires_line FROM serials WHERE app = $1`, [app])) {
    if (r.requires_line) lines.set(r.serial, r.requires_line)
  }
  return {
    app: a,
    channels: channelState,
    bundles: all.map((b) => ({
      ...b,
      liveOn: served.get(b.id) ?? [],
      everOn: [...(everOn.get(b.id) ?? [])],
      patches: patchesByTo.get(b.id) ?? [],
      needs: needsTag(requiresLine(b.manifest.requires)),
    })),
    // (a store build that took its serial without its needs: the OTA bundle with that serial, if any, has them)
    storeBuilds: builds.map((s) => {
      const line = lines.get(s.builtinSerial) ?? all.find((b) => b.serial === s.builtinSerial)?.manifest.requires
      return { ...s, needs: line === undefined ? null : needsTag(typeof line === "string" ? line : requiresLine(line)) }
    }),
    families: familiesView(builds, all),
    rules: { android: await storeRules(db, app, "android"), ios: await storeRules(db, app, "ios") },
  }
}

// ---- Helpers ----------------------------------------------------------------------------------------------------------

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v)
}

function day(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10)
}
