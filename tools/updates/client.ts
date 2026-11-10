// The release side of zn-updates (docs/zn-updates-server.md): what the `updates` CLI does, as functions the tests
// and the dashboard's build helper share. Signing happens here, on the owner's machine: the server never sees the
// private key, only signatures it checks against the app's public keys.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { zipSync } from "fflate"
import { BUNDLE_INFO_FILE, readBundleInfo, setBundleSerial } from "../bundle-info"
import { RECORD_FORMAT, zipFolder, type Manifest, type Pointer, type Priority } from "../ota/core"
import { BUILT_IN, bundleText, pointerText, sha256Hex, signText } from "../ota/signing"

export interface Conn {
  /** The server's base URL, e.g. https://appupdates.example.com */
  server: string
  token: string
  /** Who you are, for the activity log. */
  by: string
}

export class ServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export async function call<T>(c: Conn, method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData
  const res = await fetch(c.server.replace(/\/+$/, "") + path, {
    method,
    headers: {
      authorization: `Bearer ${c.token}`,
      "x-by": c.by,
      ...(body !== undefined && !isForm ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let data: unknown
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { error: text.slice(0, 300) }
  }
  if (!res.ok) throw new ServerError((data as { error?: string })?.error ?? `HTTP ${res.status}`, res.status)
  return data as T
}

export interface Uploaded {
  manifest: Manifest
  /** True when these bytes were released before (nothing uploaded). */
  reused: boolean
}

/**
 * Releases the bundle built in [builtDir] (its zn-bundle.json with serial 0): reserves a serial for its bytes, stamps
 * it, zips, signs, uploads. The same bytes again give the released bundle back. Never publishes.
 */
export async function uploadBuilt(
  c: Conn,
  builtDir: string,
  privatePem: string,
  git: { commit: string; dirty: boolean; subject?: string },
  now: () => Date = () => new Date(),
): Promise<Uploaded> {
  const info = readBundleInfo(builtDir)
  if (!info.requires) throw new Error("the build's zn-bundle.json has no requires (rebuild with the current tools)")
  const app = info.app
  const r = await call<{ serial: number; existing: Manifest | null }>(c, "POST", `/admin/apps/${app}/serials`, {
    kind: "bundle",
    sha256: info.sha256,
    requires: info.requires,
  })
  if (r.existing) return { manifest: r.existing, reused: true }
  const stamped = await setBundleSerial(builtDir, r.serial)
  const zip = zipFolder(builtDir)
  const zipSha256 = sha256Hex(zip)
  const zipPath = `${app}/bundles/${stamped.id}/${zipSha256}.zip`
  const m: Manifest = {
    format: RECORD_FORMAT,
    app,
    id: stamped.id,
    serial: r.serial,
    bundleSha256: info.sha256,
    requires: info.requires,
    zip: { path: zipPath, sha256: zipSha256, size: zip.length },
    git: { commit: git.commit, dirty: git.dirty },
    builtAt: now().toISOString(),
    signature: signText(
      bundleText({ app, id: stamped.id, serial: r.serial, bundleSha256: info.sha256, requires: info.requires, zipSha256, zipSize: zip.length }),
      privatePem,
    ),
    ...(info.moduleFrom ? { moduleFrom: info.moduleFrom } : {}),
  }
  const form = new FormData()
  form.set("manifest", JSON.stringify(m))
  form.set("zip", new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }), "bundle.zip")
  form.set("gitSubject", git.subject ?? "")
  await call(c, "POST", `/admin/apps/${app}/bundles`, form)
  return { manifest: m, reused: false }
}

/**
 * A built bundle folder as a zip in the same format a release zip has (zn-bundle.json and the files it lists), for a
 * store build's base (docs/ota-patches.md §5). Only the listed files go in: the host's assets folder holds other things too.
 */
export function zipBundleFiles(dir: string): Uint8Array {
  const info = readBundleInfo(dir)
  const mtime = new Date(Date.UTC(1980, 0, 2)) // the same fixed time as zipFolder: equal files, equal bytes
  const files: Record<string, [Uint8Array, { mtime: Date }]> = {}
  for (const name of [BUNDLE_INFO_FILE, ...Object.keys(info.files)].sort()) files[name] = [new Uint8Array(readFileSync(join(dir, ...name.split("/")))), { mtime }]
  return zipSync(files, { level: 9 })
}

/**
 * Uploads the built-in bundle in [dir] (a host's assets folder, built with the store build's serial) as the base for
 * patches of the store build with that built-in serial. The server refuses a bundle with another SHA-256 than the store build's.
 */
export async function uploadBase(c: Conn, app: string, serial: number, dir: string): Promise<{ serial: number; path: string; size: number }> {
  const zip = zipBundleFiles(dir)
  const form = new FormData()
  form.set("zip", new Blob([zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }), "base.zip")
  return call(c, "POST", `/admin/apps/${app}/store-builds/${serial}/base`, form)
}

/** A patch the server made: from which bundle (an OTA bundle, or a store build's built-in one), and how big. */
export interface PatchInfo {
  toId: string
  fromId: string
  fromSha256: string
  path: string
  sha256: string
  size: number
  madeAt: string
}

/** Makes the patches of one bundle again; the server answers with what it made (and what it dropped or could not make). */
export function remakePatches(c: Conn, app: string, serial: number) {
  return call<{
    result: { made: { from: string; size: number }[]; tooBig: { from: string; size: number }[]; failed: { from: string; error: string }[]; skipped: number }
    patches: PatchInfo[]
  }>(c, "POST", `/admin/apps/${app}/bundles/${serial}/patches`)
}

export interface ChangeOptions {
  app: string
  channel: string
  /** A bundle id (`<app>_<serial>`), a serial, or BUILT_IN (the kill switch). */
  target: string | number
  rollout: number
  /** Default normal; the kill switch is always critical (docs/ota-patches.md §7). */
  priority?: Priority
  reason?: string
  /** `PRODUCTION #N` for production publish / rollback; `KILL <CHANNEL>` for the kill switch. */
  confirm?: string
  /** false: no "check now" push after this change (phones find it at their next start). Default: the server decides. */
  push?: boolean
}

/** Signs the channel's next pointer locally and sends it (publish, roll back, rollout change, kill switch). */
export async function changeChannel(c: Conn, privatePem: string, o: ChangeOptions, now: () => Date = () => new Date()) {
  const target = o.target === BUILT_IN ? BUILT_IN : typeof o.target === "number" || /^\d+$/.test(o.target) ? `${o.app}_${o.target}` : o.target
  const next = await call<{ seq: number; text: string }>(c, "GET", `/admin/apps/${o.app}/channels/${o.channel}/next?target=${encodeURIComponent(target)}`)
  // Sign the text we build ourselves, never text the server sent: the server only gives the next seq.
  const text = pointerText({ app: o.app, channel: o.channel, seq: next.seq, target })
  if (!Number.isInteger(next.seq) || next.seq < 1 || next.text !== text) throw new Error("the server's next pointer doesn't match what we asked for; not signing")
  const p: Pointer = {
    format: RECORD_FORMAT,
    app: o.app,
    channel: o.channel,
    seq: next.seq,
    target,
    rollout: o.rollout,
    priority: o.priority ?? (target === BUILT_IN ? "critical" : "normal"),
    at: now().toISOString(),
    ...(o.reason ? { reason: o.reason } : {}),
    signature: signText(text, privatePem),
  }
  return call<{ pointer: Pointer; kind: string; push: PushResult | null }>(c, "POST", `/admin/apps/${o.app}/pointers`, { pointer: p, confirm: o.confirm, ...(o.push === false ? { push: false } : {}) })
}

/** What the server did about the "check now" push after a change (null: none was needed). */
export interface PushResult {
  sent: boolean
  topic: string
  delayMs?: number
  error?: string
}
