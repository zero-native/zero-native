// Writes `zn-bundle.json`: what a bundle is (app, serial, id) and every file in it with its size and SHA-256
// (docs/ota.md §3.1). The APK carries one for its built-in bundle; every OTA bundle folder has one too.
// The phone reads it to choose which bundle to run (ZnBundles.kt). Signing (step 4.3) signs `sha256` below.
import { join, relative, sep } from "node:path"
import { readdirSync, statSync } from "node:fs"

/** Format of `zn-bundle.json`. The phone ignores a bundle whose format it doesn't know. */
export const BUNDLE_INFO_FORMAT = 1
export const BUNDLE_INFO_FILE = "zn-bundle.json"

export interface BundleFile {
  size: number
  sha256: string
}

export interface BundleInfo {
  format: number
  /** The app this bundle belongs to; the phone never runs another app's bundle. */
  app: string
  /** Bigger = newer. 0 = a local build that was never released (the release CLI, step 4.3, gives real serials). */
  serial: number
  /** `<app>_<serial>`, shown as #serial. */
  id: string
  /** SHA-256 of the file list below (one line per file, sorted: "name size sha256\n"): one value for the bundle. */
  sha256: string
  /** Paths relative to the bundle root, with "/" separators. */
  files: Record<string, BundleFile>
  builtAt: string
}

function sha256Hex(data: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex")
}

/** The bundle's one SHA-256: over the sorted file list, so it changes when any file changes. */
export function bundleSha256(files: Record<string, BundleFile>): string {
  const lines = Object.keys(files)
    .sort()
    .map((name) => `${name} ${files[name].size} ${files[name].sha256}\n`)
  return sha256Hex(lines.join(""))
}

/**
 * Lists [names] in [dir] (files, or folders such as "assets" whose files are all included), hashes them and writes
 * `zn-bundle.json` into [dir]. Returns what it wrote.
 */
export async function writeBundleInfo(
  dir: string,
  opts: { app: string; serial: number; names: string[] },
): Promise<BundleInfo> {
  if (!/^[a-z][a-z0-9_.-]*$/.test(opts.app)) throw new Error(`bundle app id "${opts.app}": use a-z, 0-9, _ . -`)
  if (!Number.isInteger(opts.serial) || opts.serial < 0) throw new Error(`bundle serial must be 0 or more`)
  const paths: string[] = []
  const walk = (path: string) => {
    if (statSync(path).isDirectory()) for (const child of readdirSync(path).sort()) walk(join(path, child))
    else paths.push(path)
  }
  for (const name of opts.names) walk(join(dir, name))

  const files: Record<string, BundleFile> = {}
  for (const path of paths) {
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer())
    files[relative(dir, path).split(sep).join("/")] = { size: bytes.length, sha256: sha256Hex(bytes) }
  }
  const info: BundleInfo = {
    format: BUNDLE_INFO_FORMAT,
    app: opts.app,
    serial: opts.serial,
    id: `${opts.app}_${opts.serial}`,
    sha256: bundleSha256(files),
    files,
    builtAt: new Date().toISOString(),
  }
  await Bun.write(join(dir, BUNDLE_INFO_FILE), JSON.stringify(info, null, 2) + "\n")
  return info
}
