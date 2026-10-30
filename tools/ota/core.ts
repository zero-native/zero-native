// The release rules (docs/ota.md §3.1, §4 step 4.3). Every action and every rule is here; the CLI only parses
// arguments and asks for typed confirmations, so no path can skip a rule. Lessons kept from ZeroBill's RN OTA v2:
// builds never publish; one bundle = one serial = one SHA; staging first, then "stable", then production with a typed
// confirmation and an explicit rollout; rollback = point back; the kill switch is a signed pointer to the built-in
// bundle; records are never changed after they are written.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { zipSync } from "fflate"
import { readBundleInfo, setBundleSerial, type BundleRequires } from "../bundle-info"
import {
  BUILT_IN,
  bundleText,
  pointerText,
  requiresLine,
  sha256Hex,
  signText,
  verifyText,
  type Signature,
} from "./signing"
import type { Store } from "./store"

export const RECORD_FORMAT = 1
export const PRODUCTION = "production"
export const STAGING = "staging"

/** The signed record of one released bundle: `<app>/bundles/<id>/manifest.json`. Never changed. */
export interface Manifest {
  format: number
  app: string
  id: string
  serial: number
  /** SHA-256 over the bundle's file list (tools/bundle-info.ts): equal for equal bytes, whatever the serial. */
  bundleSha256: string
  requires: BundleRequires
  zip: { path: string; sha256: string; size: number }
  git: { commit: string; dirty: boolean }
  builtAt: string
  signature: Signature
}

/** One pointer change: `<app>/channels/<channel>/<seq>.json`. The highest seq is what the channel serves. */
export interface Pointer {
  format: number
  app: string
  channel: string
  seq: number
  /** A bundle id, or BUILT_IN (the kill switch: phones go back to the APK's own bundle). */
  target: string
  /** Not signed: only delays a bundle the owner already chose. 1–100 (% of installs, by install id). */
  rollout: number
  /** Not signed: "high" asks apps to apply sooner (their own rules decide when). */
  priority: "normal" | "high"
  at: string
  reason?: string
  signature: Signature
}

export interface Context {
  store: Store
  app: string
  /** The private key (PEM). Only actions that sign need it. */
  privatePem?: string
  now?: () => Date
}

export class ReleaseError extends Error {}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2) + "\n")
const pad = (seq: number) => String(seq).padStart(10, "0")
const at = (ctx: Context) => (ctx.now?.() ?? new Date()).toISOString()

function key(ctx: Context): string {
  if (!ctx.privatePem) throw new ReleaseError("this action signs: give the private key (--key, or the app's zn-ota.json)")
  return ctx.privatePem
}

function checkChannel(channel: string) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel)) throw new ReleaseError(`channel "${channel}": use a-z, 0-9 and -`)
}

async function readJson<T>(store: Store, path: string): Promise<T | null> {
  const b = await store.read(path)
  return b ? (JSON.parse(new TextDecoder().decode(b)) as T) : null
}

// ---- Reading ---------------------------------------------------------------------------------------------------------

export async function manifests(ctx: Context): Promise<Manifest[]> {
  const paths = (await ctx.store.list(`${ctx.app}/bundles`)).filter((p) => p.endsWith("/manifest.json"))
  const out: Manifest[] = []
  for (const p of paths) {
    const m = await readJson<Manifest>(ctx.store, p)
    if (m) out.push(m)
  }
  return out.sort((a, b) => a.serial - b.serial)
}

/** A bundle by serial ("12", 12) or id ("sample_12"). */
export async function manifest(ctx: Context, bundle: string | number): Promise<Manifest> {
  const id = /^\d+$/.test(String(bundle)) ? `${ctx.app}_${bundle}` : String(bundle)
  const m = await readJson<Manifest>(ctx.store, `${ctx.app}/bundles/${id}/manifest.json`)
  if (!m) throw new ReleaseError(`no released bundle ${id} in ${ctx.store.where}`)
  return m
}

/** Every pointer change of a channel, oldest first. */
export async function history(ctx: Context, channel: string): Promise<Pointer[]> {
  checkChannel(channel)
  const out: Pointer[] = []
  for (const p of await ctx.store.list(`${ctx.app}/channels/${channel}`)) {
    const v = await readJson<Pointer>(ctx.store, p)
    if (v) out.push(v)
  }
  return out.sort((a, b) => a.seq - b.seq)
}

/** What a channel serves now (its highest seq), or null if nothing was ever published on it. */
export async function current(ctx: Context, channel: string): Promise<Pointer | null> {
  return (await history(ctx, channel)).at(-1) ?? null
}

export async function isStable(ctx: Context, id: string): Promise<boolean> {
  return (await ctx.store.read(`${ctx.app}/bundles/${id}/stable.json`)) !== null
}

// ---- Build: a built folder becomes a released bundle ------------------------------------------------------------------

/** The folder's files in a zip: sorted names, fixed timestamps, so equal files give equal bytes. */
export function zipFolder(dir: string): Uint8Array {
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {}
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else files[relative(dir, p).split(sep).join("/")] = [new Uint8Array(readFileSync(p)), { mtime: new Date(Date.UTC(1980, 0, 2)) }]
    }
  }
  walk(dir)
  return zipSync(files, { level: 9 })
}

export interface BuildResult {
  manifest: Manifest
  /** True when the same bytes were released before: no new serial, nothing uploaded. */
  reused: boolean
}

/**
 * Releases the bundle built in [builtDir] (zn-bundle.json and its files, serial 0): the same bytes as a released bundle
 * reuse its serial; new bytes take the next serial, are zipped, signed and uploaded. Builds never publish.
 */
export async function releaseBuilt(ctx: Context, builtDir: string, git: { commit: string; dirty: boolean }): Promise<BuildResult> {
  const info = readBundleInfo(builtDir)
  if (info.app !== ctx.app) throw new ReleaseError(`the build is for app "${info.app}", not "${ctx.app}"`)
  if (!info.requires) throw new ReleaseError("the build's zn-bundle.json has no requires (rebuild with the current tools)")
  const all = await manifests(ctx)
  const same = all.find((m) => m.bundleSha256 === info.sha256 && requiresLine(m.requires) === requiresLine(info.requires))
  if (same) return { manifest: same, reused: true }

  const signingKey = key(ctx)
  const serial = Math.max(0, ...all.map((m) => m.serial)) + 1
  const stamped = await setBundleSerial(builtDir, serial)
  const zip = zipFolder(builtDir)
  const zipSha256 = sha256Hex(zip)
  // The zip's name has its SHA in it: a retry, or another release racing for the same serial, never replaces it.
  const zipPath = `${ctx.app}/bundles/${stamped.id}/${zipSha256}.zip`
  const base = { app: ctx.app, id: stamped.id, serial, bundleSha256: info.sha256, requires: info.requires, zipSha256, zipSize: zip.length }
  const m: Manifest = {
    format: RECORD_FORMAT,
    app: ctx.app,
    id: stamped.id,
    serial,
    bundleSha256: info.sha256,
    requires: info.requires,
    zip: { path: zipPath, sha256: zipSha256, size: zip.length },
    git,
    builtAt: at(ctx),
    signature: signText(bundleText(base), signingKey),
  }
  await ctx.store.write(zipPath, zip)
  // Creating the manifest is the moment the bundle exists. If someone took this serial first, nothing is lost: run again.
  if (!(await ctx.store.createOnly(`${ctx.app}/bundles/${stamped.id}/manifest.json`, json(m)))) {
    throw new ReleaseError(`serial #${serial} was just taken by another release; run the build again`)
  }
  return { manifest: m, reused: false }
}

// ---- Pointers: publish, roll out, kill -------------------------------------------------------------------------------

export interface PublishOptions {
  channel: string
  /** Serial or id; BUILT_IN for the kill switch (use kill()). */
  bundle: string | number
  /** 1–100. Required (no default) on production. */
  rollout?: number
  priority?: "normal" | "high"
  /** Production: the typed confirmation, exactly `PRODUCTION #<serial>`. */
  confirm?: string
  reason?: string
}

/** Points a channel at a bundle (a new pointer with the next seq). Also how to roll back: point at an older bundle. */
export async function publish(ctx: Context, o: PublishOptions): Promise<Pointer> {
  checkChannel(o.channel)
  const m = await manifest(ctx, o.bundle)
  const rollout = o.rollout ?? (o.channel === PRODUCTION ? undefined : 100)
  if (o.channel === PRODUCTION) {
    if (!(await isStable(ctx, m.id))) {
      throw new ReleaseError(`#${m.serial} is not marked stable on staging: publish it to staging, test it, then \`stable\``)
    }
    if (m.git.dirty) throw new ReleaseError(`#${m.serial} was built from uncommitted changes; production takes only bundles built from a commit`)
    if (rollout === undefined) throw new ReleaseError("production needs an explicit --rollout (1–100): start small")
    if (o.confirm !== `PRODUCTION #${m.serial}`) throw new ReleaseError(`type the confirmation exactly: PRODUCTION #${m.serial}`)
  }
  checkRollout(rollout!)
  return writePointer(ctx, o.channel, m.id, rollout!, o.priority ?? "normal", o.reason)
}

/** Changes the rollout of what a channel serves now (a new pointer, same bundle). */
export async function setRollout(ctx: Context, channel: string, rollout: number): Promise<Pointer> {
  const now = await current(ctx, channel)
  if (!now || now.target === BUILT_IN) throw new ReleaseError(`${channel} serves no bundle to roll out`)
  checkRollout(rollout)
  return writePointer(ctx, channel, now.target, rollout, now.priority, `rollout ${now.rollout}% → ${rollout}%`)
}

/**
 * The kill switch: the channel tells phones to run their APK's own bundle (a signed pointer to BUILT_IN, so a broken
 * server can't undo it and an old answer can't be replayed). Typed `KILL <CHANNEL>`; production also needs a reason.
 */
export async function kill(ctx: Context, channel: string, confirm: string | undefined, reason?: string): Promise<Pointer> {
  checkChannel(channel)
  if (confirm !== `KILL ${channel.toUpperCase()}`) throw new ReleaseError(`type the confirmation exactly: KILL ${channel.toUpperCase()}`)
  if (channel === PRODUCTION && !reason?.trim()) throw new ReleaseError("a production kill switch needs a --reason")
  return writePointer(ctx, channel, BUILT_IN, 100, "high", reason)
}

function checkRollout(rollout: number) {
  if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) throw new ReleaseError(`rollout must be 1–100, got ${rollout}`)
}

async function writePointer(
  ctx: Context,
  channel: string,
  target: string,
  rollout: number,
  priority: "normal" | "high",
  reason?: string,
): Promise<Pointer> {
  const signingKey = key(ctx)
  const seq = ((await current(ctx, channel))?.seq ?? 0) + 1
  const p: Pointer = {
    format: RECORD_FORMAT,
    app: ctx.app,
    channel,
    seq,
    target,
    rollout,
    priority,
    at: at(ctx),
    ...(reason ? { reason } : {}),
    signature: signText(pointerText({ app: ctx.app, channel, seq, target }), signingKey),
  }
  if (!(await ctx.store.createOnly(`${ctx.app}/channels/${channel}/${pad(seq)}.json`, json(p)))) {
    throw new ReleaseError(`${channel} changed while this ran (seq ${seq} is taken); check \`status\` and run again`)
  }
  return p
}

// ---- Marks -----------------------------------------------------------------------------------------------------------

/** "Stable on staging": only for a bundle the staging channel has pointed at. Needed before production. */
export async function markStable(ctx: Context, bundle: string | number): Promise<void> {
  const m = await manifest(ctx, bundle)
  const onStaging = (await history(ctx, STAGING)).some((p) => p.target === m.id)
  if (!onStaging) throw new ReleaseError(`staging never served #${m.serial}: publish it to staging and test it first`)
  const stagingSeq = (await current(ctx, STAGING))?.seq ?? 0
  const created = await ctx.store.createOnly(`${ctx.app}/bundles/${m.id}/stable.json`, json({ at: at(ctx), stagingSeq }))
  if (!created) throw new ReleaseError(`#${m.serial} is already marked stable`)
}

// ---- Checks ----------------------------------------------------------------------------------------------------------

/**
 * Checks the whole store with the app's public keys: every manifest and pointer signature, every zip's SHA and size,
 * seq numbers that match their file names, pointers that name released bundles. Returns the problems found.
 */
export async function verifyStore(ctx: Context, publicKeys: string[]): Promise<string[]> {
  const problems: string[] = []
  for (const m of await manifests(ctx)) {
    const base = { app: m.app, id: m.id, serial: m.serial, bundleSha256: m.bundleSha256, requires: m.requires, zipSha256: m.zip.sha256, zipSize: m.zip.size }
    if (!verifyText(bundleText(base), m.signature, publicKeys)) problems.push(`${m.id}: bad bundle signature`)
    const zip = await ctx.store.read(m.zip.path)
    if (!zip) problems.push(`${m.id}: zip ${m.zip.path} is missing`)
    else if (zip.length !== m.zip.size || sha256Hex(zip) !== m.zip.sha256) problems.push(`${m.id}: zip doesn't match its manifest`)
  }
  const channels = new Set((await ctx.store.list(`${ctx.app}/channels`)).map((p) => p.split("/")[2]))
  for (const ch of channels) {
    for (const p of await history(ctx, ch)) {
      const name = `${ctx.app}/channels/${ch}/${pad(p.seq)}.json`
      if (!(await ctx.store.read(name))) problems.push(`${ch} seq ${p.seq}: stored under another name`)
      if (!verifyText(pointerText(p), p.signature, publicKeys)) problems.push(`${ch} seq ${p.seq}: bad pointer signature`)
      if (p.target !== BUILT_IN && !(await ctx.store.read(`${ctx.app}/bundles/${p.target}/manifest.json`))) {
        problems.push(`${ch} seq ${p.seq}: points at ${p.target}, which isn't released`)
      }
    }
  }
  return problems
}

export interface Status {
  bundles: Array<{ id: string; serial: number; stable: boolean; dirty: boolean; builtAt: string; servedBy: string[]; zipKb: number }>
  channels: Array<{ channel: string; seq: number; target: string; rollout: number; priority: string; at: string; reason?: string }>
}

export async function status(ctx: Context): Promise<Status> {
  const channelNames = [...new Set((await ctx.store.list(`${ctx.app}/channels`)).map((p) => p.split("/")[2]))].sort()
  const now = (await Promise.all(channelNames.map((c) => current(ctx, c)))).filter((p): p is Pointer => p !== null)
  const bundles = await Promise.all(
    (await manifests(ctx)).map(async (m) => ({
      id: m.id,
      serial: m.serial,
      stable: await isStable(ctx, m.id),
      dirty: m.git.dirty,
      builtAt: m.builtAt,
      servedBy: now.filter((p) => p.target === m.id).map((p) => `${p.channel} ${p.rollout}%`),
      zipKb: Math.round(m.zip.size / 1024),
    })),
  )
  return {
    bundles,
    channels: now.map((p) => ({ channel: p.channel, seq: p.seq, target: p.target, rollout: p.rollout, priority: p.priority, at: p.at, reason: p.reason })),
  }
}

/** What phones reported about one bundle (telemetry, `ota status`; step 4.7). */
export interface BundleHealth {
  bundle: string
  /** Phones (install ids) that last checked in running it. */
  phones: number
  /** Outcome kinds the phones sent about it, with counts: downloaded, applied, healthy, error_rollback, ... */
  outcomes: Record<string, number>
}

/** Outcomes where a safety net acted on the phone (docs/ota.md §3.6): `ota status` shows them first. */
export const SERIOUS_OUTCOMES = ["error_rollback", "launch_crashed", "watchdog_block", "apply_failed", "init_failed", "ota_off", "signature", "zip_sha"]

/**
 * Sums the server's telemetry lines (`checks-<date>.ndjson`, one JSON check per line) per bundle: how many phones
 * run it now (their newest check) and what the phones reported about it. Bad lines are skipped.
 */
export function summarizeChecks(lines: string[]): BundleHealth[] {
  const lastRunning = new Map<string, { at: string; running: string }>()
  const byBundle = new Map<string, BundleHealth>()
  const entry = (bundle: string) => {
    let h = byBundle.get(bundle)
    if (!h) byBundle.set(bundle, (h = { bundle, phones: 0, outcomes: {} }))
    return h
  }
  for (const text of lines) {
    if (!text.trim()) continue
    let line: { at?: string; installId?: string; running?: string; outcomes?: Array<{ kind?: string; bundle?: string }> }
    try {
      line = JSON.parse(text)
    } catch {
      continue
    }
    if (typeof line.installId === "string" && typeof line.running === "string") {
      const seen = lastRunning.get(line.installId)
      if (!seen || String(line.at) >= seen.at) lastRunning.set(line.installId, { at: String(line.at), running: line.running })
    }
    for (const o of line.outcomes ?? []) {
      if (typeof o.kind !== "string" || !o.kind) continue
      const h = entry(typeof o.bundle === "string" && o.bundle ? o.bundle : "(none)")
      h.outcomes[o.kind] = (h.outcomes[o.kind] ?? 0) + 1
    }
  }
  for (const { running } of lastRunning.values()) entry(running).phones++
  return [...byBundle.values()].sort((a, b) => b.phones - a.phones || a.bundle.localeCompare(b.bundle))
}
