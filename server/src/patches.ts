// OTA patches (docs/ota-patches.md §3, §5). A patch zip turns an older bundle on the phone into a new bundle. It is much
// smaller than the full zip, and nothing in it is trusted: the phone builds every file, checks its size and SHA-256 against
// the new bundle's file list, and the list against the signed bundle SHA, as for a full zip. A wrong patch can only fail.
//
// Patches are made in the background after a bundle upload (never slowing or failing the upload), one job at a time.
import { deflateSync, unzipSync, zipSync } from "fflate"
import { type BundleInfo, bundleSha256 } from "../../tools/bundle-info"
import { applyPatch, makePatch } from "../../tools/ota/bsdiff"
import { sha256Hex } from "../../tools/ota/signing"
import type { Db } from "./db"
import * as model from "./model"
import { RuleError } from "./model"
import type { FileStore } from "./storage"

/** The patch format name phones list in `patches` and the server answers in `patch.format`. */
export const PATCH_FORMAT = "znbsdiff1"
/** A patch (a file's bsdiff, or the whole patch zip) is kept only if it is under 60 % of what it replaces. */
export const PATCH_LIMIT = 0.6
/** A file smaller than this is sent whole: a patch would save almost nothing. */
export const MIN_DIFF_SIZE = 32 * 1024
/** Bases: the newest earlier OTA bundles, and the built-in bundles of the newest store builds with a lower serial. */
export const BASE_BUNDLES = 5
export const BASE_STORE_BUILDS = 3

const FIXED_TIME = new Date(Date.UTC(1980, 0, 2)) // the same as tools/ota/core.ts zipFolder: equal input, equal bytes
const encoder = new TextEncoder()

// ---- Reading a bundle zip ---------------------------------------------------------------------------------------------

/** A bundle zip, opened and checked: every file in its list is there, with the listed size and SHA-256. */
export interface BundleContents {
  info: BundleInfo
  /** zn-bundle.json exactly as it is in the zip (a patch zip carries it byte for byte). */
  infoBytes: Uint8Array
  files: Map<string, Uint8Array>
}

/** A file name from a bundle's list: relative, "/" only, no empty or ".." parts. */
function checkName(name: string) {
  if (!name || name.startsWith("/") || name.includes("\\") || /[\u0000-\u001f]/.test(name) || name.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new RuleError(`the bundle lists a file name that is not allowed: ${JSON.stringify(name.slice(0, 80))}`)
  }
}

/** Opens a bundle zip and checks it against its own zn-bundle.json (files, sizes, SHA-256, and the bundle SHA-256). */
export function readBundleZip(zip: Uint8Array): BundleContents {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip)
  } catch (e) {
    throw new RuleError(`not a zip file: ${(e as Error).message}`)
  }
  const infoBytes = entries["zn-bundle.json"]
  if (!infoBytes) throw new RuleError("the zip has no zn-bundle.json")
  let info: BundleInfo
  try {
    info = JSON.parse(new TextDecoder().decode(infoBytes)) as BundleInfo
  } catch {
    throw new RuleError("zn-bundle.json is not JSON")
  }
  if (!info || typeof info.app !== "string" || typeof info.id !== "string" || typeof info.sha256 !== "string" || !info.files || typeof info.files !== "object") {
    throw new RuleError("zn-bundle.json is missing app, id, sha256 or files")
  }
  const files = new Map<string, Uint8Array>()
  for (const [name, f] of Object.entries(info.files)) {
    checkName(name)
    if (!f || !Number.isInteger(f.size) || f.size < 0 || !/^[0-9a-f]{64}$/.test(String(f.sha256))) throw new RuleError(`zn-bundle.json: bad entry for ${name}`)
    const bytes = entries[name]
    if (!bytes) throw new RuleError(`${name} is listed in zn-bundle.json but not in the zip`)
    if (bytes.length !== f.size || sha256Hex(bytes) !== f.sha256) throw new RuleError(`${name} does not match its size and SHA-256 in zn-bundle.json`)
    files.set(name, bytes)
  }
  if (bundleSha256(info.files) !== info.sha256) throw new RuleError("zn-bundle.json: its sha256 is not the SHA-256 of its file list")
  return { info, infoBytes, files }
}

// ---- Making one patch zip ---------------------------------------------------------------------------------------------

export interface PatchFile {
  /** The base file whose bytes are exactly these. */
  copy?: string
  /** A ZNBSDIFF1 entry in the zip, and the base file it applies to. */
  patch?: string
  base?: string
  /** The file itself, in the zip. */
  zip?: string
}

export interface PatchZip {
  zip: Uint8Array
  /** How many files took each way. */
  counts: { copy: number; patch: number; zip: number }
  files: Record<string, PatchFile>
}

const yieldToServer = () => Bun.sleep(0)
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.compare(a, b) === 0

/**
 * The patch zip that turns [from] into [to] (layout: docs/ota-patches.md §3). Per file of the new bundle: the base has
 * a file with the same SHA-256 → `copy`; else 32 KB or more and the base has a file of that name → bsdiff, if its
 * deflated size is under 60 % of the deflated file; else the file itself (`zip`). The caller decides about the 60 % limit
 * of the whole zip.
 */
export async function buildPatchZip(to: BundleContents, from: BundleContents): Promise<PatchZip> {
  const baseBySha = new Map<string, string>()
  for (const [name, f] of Object.entries(from.info.files)) if (!baseBySha.has(f.sha256)) baseBySha.set(f.sha256, name)
  const plan: Record<string, PatchFile> = {}
  const patchEntries: Record<string, [Uint8Array, { level: 9; mtime: Date }]> = {}
  const wholeEntries: Record<string, [Uint8Array, { level: 9; mtime: Date }]> = {}
  const counts = { copy: 0, patch: 0, zip: 0 }
  for (const name of Object.keys(to.info.files).sort()) {
    const f = to.info.files[name]!
    const bytes = to.files.get(name)!
    const copyFrom = from.info.files[name]?.sha256 === f.sha256 ? name : baseBySha.get(f.sha256)
    if (copyFrom !== undefined) {
      plan[name] = { copy: copyFrom }
      counts.copy++
      continue
    }
    const old = from.files.get(name)
    if (old && bytes.length >= MIN_DIFF_SIZE) {
      await yieldToServer() // making a patch takes about half a second of CPU: let phone checks in between
      const patch = makePatch(old, bytes)
      // Never trust our own patch blindly: it must make exactly this file.
      let ok = false
      try {
        ok = same(applyPatch(old, patch, bytes.length), bytes)
      } catch {
        ok = false
      }
      if (ok && deflateSync(patch, { level: 9 }).length < deflateSync(bytes, { level: 9 }).length * PATCH_LIMIT) {
        plan[name] = { patch: `p/${name}`, base: name }
        patchEntries[`p/${name}`] = [patch, { level: 9, mtime: FIXED_TIME }]
        counts.patch++
        continue
      }
    }
    plan[name] = { zip: `f/${name}` }
    wholeEntries[`f/${name}`] = [bytes, { level: 9, mtime: FIXED_TIME }]
    counts.zip++
  }
  const patchJson = {
    format: PATCH_FORMAT,
    from: { id: from.info.id, sha256: from.info.sha256 },
    to: { id: to.info.id, sha256: to.info.sha256 },
    files: plan,
  }
  const zip = zipSync(
    {
      "zn-patch.json": [encoder.encode(JSON.stringify(patchJson, null, 2) + "\n"), { level: 9, mtime: FIXED_TIME }],
      "zn-bundle.json": [to.infoBytes, { level: 9, mtime: FIXED_TIME }],
      ...patchEntries,
      ...wholeEntries,
    },
    { level: 9 },
  )
  return { zip, counts, files: plan }
}

// ---- Making the patches of a bundle -----------------------------------------------------------------------------------

export interface MakeResult {
  /** Patches written now. */
  made: { from: string; size: number }[]
  /** Patches made but dropped: 60 % or more of the full zip. */
  tooBig: { from: string; size: number }[]
  /** Bases that could not be used (missing file, a zip that does not match its list). */
  failed: { from: string; error: string }[]
  /** Bases that already had a patch (nothing to do). */
  skipped: number
}

interface Base {
  id: string
  sha256: string
  /** "bundle": an OTA bundle; "built-in": a store build's built-in bundle. */
  kind: "bundle" | "built-in"
  path: string
}

async function readStored(store: FileStore, path: string): Promise<Uint8Array> {
  const local = await store.local(path)
  if (!local) throw new RuleError(`the file ${path} is not in the store`)
  return new Uint8Array(await Bun.file(local).arrayBuffer())
}

/** The bases for bundle [serial]: the 5 newest earlier bundles, then the built-in bundles of the 3 newest lower store builds. One per bundle SHA. */
async function basesFor(db: Db, app: string, serial: number): Promise<Base[]> {
  const out: Base[] = []
  const seen = new Set<string>()
  const add = (b: Base) => {
    if (seen.has(b.sha256)) return
    seen.add(b.sha256)
    out.push(b)
  }
  const bundles = await db.query<{ id: string; bundle_sha256: string; zip_path: string }>(
    `SELECT id, bundle_sha256, zip_path FROM bundles WHERE app = $1 AND serial < $2 ORDER BY serial DESC LIMIT ${BASE_BUNDLES}`,
    [app, serial],
  )
  for (const b of bundles) add({ id: b.id, sha256: b.bundle_sha256, kind: "bundle", path: b.zip_path })
  const builds = await db.query<{ builtin_serial: number; builtin_sha256: string; base_path: string | null }>(
    `SELECT builtin_serial, builtin_sha256, max(base_path) AS base_path FROM store_builds WHERE app = $1 AND builtin_serial < $2
     GROUP BY builtin_serial, builtin_sha256 ORDER BY builtin_serial DESC LIMIT ${BASE_STORE_BUILDS}`,
    [app, serial],
  )
  for (const b of builds) if (b.base_path) add({ id: `${app}_${b.builtin_serial}`, sha256: b.builtin_sha256, kind: "built-in", path: b.base_path })
  return out
}

/**
 * Makes the patches for bundle [serial] from its bases (see basesFor). Idempotent: a base that has a patch already is
 * skipped. With [force] every base is made again, and patches that no longer qualify are removed. One base that fails
 * does not stop the others; `patches.failed` goes in the activity log for it.
 */
export async function makeFor(db: Db, store: FileStore, app: string, serial: number, by: string, force = false): Promise<MakeResult> {
  const to = await model.bundle(db, app, serial)
  const toZip = await readStored(store, to.manifest.zip.path)
  if (sha256Hex(toZip) !== to.manifest.zip.sha256) throw new RuleError(`the stored zip of #${serial} does not match its manifest`)
  const toContents = readBundleZip(toZip)
  if (toContents.info.sha256 !== to.manifest.bundleSha256) throw new RuleError(`the zip of #${serial} has another bundle SHA-256 than its manifest`)

  const have = new Set((await db.query<{ from_sha256: string }>(`SELECT from_sha256 FROM patches WHERE app = $1 AND to_id = $2`, [app, to.id])).map((r) => r.from_sha256))
  const result: MakeResult = { made: [], tooBig: [], failed: [], skipped: 0 }
  const tooBigShas = new Set<string>()
  const bases = await basesFor(db, app, serial)
  for (const base of bases) {
    if (!force && have.has(base.sha256)) {
      result.skipped++
      continue
    }
    try {
      const baseZip = await readStored(store, base.path)
      const baseContents = readBundleZip(baseZip)
      if (baseContents.info.sha256 !== base.sha256) throw new RuleError(`the zip of ${base.id} has another bundle SHA-256 than the one on record`)
      const built = await buildPatchZip(toContents, baseContents)
      if (built.zip.length >= to.manifest.zip.size * PATCH_LIMIT) {
        result.tooBig.push({ from: base.id, size: built.zip.length })
        tooBigShas.add(base.sha256)
        continue
      }
      const path = `${app}/patches/${to.id}/${base.sha256}.zip`
      await store.put(path, built.zip)
      await db.query(
        `INSERT INTO patches (app, to_id, from_id, from_sha256, path, sha256, size) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (app, to_id, from_sha256) DO UPDATE SET from_id = $3, path = $5, sha256 = $6, size = $7, made_at = now()`,
        [app, to.id, base.id, base.sha256, path, sha256Hex(built.zip), built.zip.length],
      )
      result.made.push({ from: base.id, size: built.zip.length })
    } catch (e) {
      const error = (e as Error).message.slice(0, 300)
      result.failed.push({ from: base.id, error })
      await model.logActivity(db, app, by, "patches.failed", { serial, from: base.id, error }).catch(() => {})
    }
    await yieldToServer()
  }
  if (force) {
    // A remake drops the patches that no longer qualify: a base that fell out of the window, or a patch that is too big now.
    // (A base that failed keeps its old patch: the failure may be temporary.)
    const keep = new Set(bases.filter((b) => !tooBigShas.has(b.sha256)).map((b) => b.sha256))
    for (const sha of have) if (!keep.has(sha)) await db.query(`DELETE FROM patches WHERE app = $1 AND to_id = $2 AND from_sha256 = $3`, [app, to.id, sha])
  }
  if (result.made.length || result.tooBig.length) {
    await model.logActivity(db, app, by, "patches.made", {
      serial,
      made: result.made.map((m) => ({ from: m.from, size: m.size })),
      tooBig: result.tooBig.length ? result.tooBig : undefined,
    }).catch(() => {})
  }
  return result
}

// ---- The queue: one job at a time, in this process --------------------------------------------------------------------

let tail: Promise<unknown> = Promise.resolve()

/** Runs [job] after the jobs before it (one server process, so a plain chain is enough). */
export function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = tail.then(job)
  tail = run.catch(() => {})
  return run
}

/** Resolves when no patch job is running or waiting (tests wait for this after an upload). */
export async function whenIdle(): Promise<void> {
  let t: Promise<unknown>
  do {
    t = tail
    await t
  } while (t !== tail)
}

/** After a bundle upload: makes its patches in the background. Never throws; a failure goes in the activity log. */
export function makeInBackground(db: Db, store: FileStore, app: string, serial: number, by: string): void {
  void enqueue(() => makeFor(db, store, app, serial, by)).catch(async (e: unknown) => {
    const error = (e as Error).message.slice(0, 300)
    console.warn(`patches ${app} #${serial}: ${error}`)
    await model.logActivity(db, app, by, "patches.failed", { serial, error }).catch(() => {})
  })
}

/** `POST …/bundles/<serial>/patches`: makes them again and answers with the list. Waits for the jobs before it. */
export async function remake(db: Db, store: FileStore, app: string, serial: number, by: string) {
  const to = await model.bundle(db, app, serial)
  const result = await enqueue(() => makeFor(db, store, app, serial, by, true))
  return { result, patches: await model.patchesOf(db, app, to.id) }
}

// ---- Bases: a store build's built-in bundle ---------------------------------------------------------------------------

/**
 * Stores the built-in bundle of a store build, as a zip, to be a base for patches (`<app>/bases/<bundle sha>.zip`).
 * Checked: the zip is a good bundle zip of this app, and its bundle SHA-256 and serial are the store build's. A zip of
 * another bundle (a different build of the JS) is refused: a patch from the wrong base would only fail on phones.
 */
export async function uploadBase(db: Db, store: FileStore, app: string, serial: number, zip: Uint8Array, by: string) {
  await model.getApp(db, app)
  // Store builds with the same built-in serial share one bundle (and one base), so any of their rows will do.
  const rows = await db.query<{ builtin_sha256: string }>(`SELECT DISTINCT builtin_sha256 FROM store_builds WHERE app = $1 AND builtin_serial = $2`, [app, serial])
  if (!rows[0]) throw new RuleError(`no store build with built-in serial #${serial} in ${app}`, 404)
  const c = readBundleZip(zip)
  if (c.info.app !== app) throw new RuleError(`the zip is for app "${c.info.app}"`)
  if (c.info.id !== `${app}_${serial}`) throw new RuleError(`the zip is bundle ${c.info.id}, the store build's built-in bundle is ${app}_${serial}`)
  const want = rows[0].builtin_sha256
  if (c.info.sha256 !== want) {
    throw new RuleError(`the zip's bundle SHA-256 (${c.info.sha256.slice(0, 12)}) is not the store build's (${want.slice(0, 12)}): upload the built-in bundle of that build`)
  }
  const path = `${app}/bases/${want}.zip`
  // The same bundle again (a second store build with this serial, or the CLI run again) is fine: the path has the
  // bundle SHA in it, so the file is written again and every store build with this serial points to it.
  await store.put(path, zip)
  await db.tx(async (q) => {
    await q.query(`UPDATE store_builds SET base_path = $3, base_size = $4 WHERE app = $1 AND builtin_serial = $2`, [app, serial, path, zip.length])
    await model.logActivity(q, app, by, "base.upload", { serial, size: zip.length })
  })
  return { serial, path, size: zip.length }
}

/** A store build's built-in bundle as the dashboard shows it (Pavan, 2026-11-10: every bundle opens the same way). */
export interface BuiltInBundle {
  serial: number
  sha256: string
  /** The base zip's size; null = no base uploaded (then needs and files are unknown too). */
  zipSize: number | null
  /** From the base zip's zn-bundle.json. */
  requires: BundleInfo["requires"] | null
  moduleFrom: Record<string, string> | null
  files: number | null
  /** Patches made from this bundle to later ones: what its phones download. */
  patches: Array<{ toId: string; size: number }>
}

/** Built-in bundle #[serial]: from its store builds, their base zip (if any) and the patches made from it. */
export async function builtInBundle(db: Db, store: FileStore, app: string, serial: number): Promise<BuiltInBundle> {
  const builds = await db.query<{ builtin_sha256: string; base_path: string | null }>(
    `SELECT builtin_sha256, base_path FROM store_builds WHERE app = $1 AND builtin_serial = $2 ORDER BY built_at DESC`,
    [app, serial],
  )
  if (!builds[0]) throw new RuleError(`no built-in bundle #${serial} in ${app}`, 404)
  const sha256 = builds[0].builtin_sha256
  const basePath = builds.find((b) => b.base_path)?.base_path ?? null
  let zipSize: number | null = null
  let info: (BundleInfo & { moduleFrom?: Record<string, string> }) | null = null
  if (basePath) {
    const local = await store.local(basePath)
    if (local) {
      const zip = new Uint8Array(await Bun.file(local).arrayBuffer())
      zipSize = zip.length
      const entry = unzipSync(zip, { filter: (f) => f.name === "zn-bundle.json" })["zn-bundle.json"]
      if (entry) info = JSON.parse(new TextDecoder().decode(entry))
    }
  }
  const patches = await db.query<{ to_id: string; size: number }>(
    `SELECT to_id, size FROM patches WHERE app = $1 AND from_sha256 = $2 ORDER BY made_at DESC`,
    [app, sha256],
  )
  return {
    serial,
    sha256,
    zipSize,
    requires: info?.requires ?? null,
    moduleFrom: info?.moduleFrom ?? null,
    files: info ? Object.keys(info.files).length : null,
    patches: patches.map((p) => ({ toId: p.to_id, size: Number(p.size) })),
  }
}
