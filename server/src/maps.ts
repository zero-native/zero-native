// Source maps on the server (Pavan, 2026-11-10). Before, a bundle's map was kept only on the machine that built it
// (~/.zero-native/maps/<app>/<sha>.map): a lost laptop meant production stacks could never be decoded, and the Mac kept
// the iOS ones. Now the CLI also uploads each map here, into the same private storage as the zips. The server uses it
// to decode the stacks phones send (the dashboard's errors) and to show what a bundle is made of (its size by file).
//
// A map holds the app's source file names and line positions (no source text: Bun's maps have no sourcesContent), but
// it is still private: only the admin API reads it, never a public URL.
import { decodeSourceMap, type DecodedMap } from "../../compiler/src/sourcemap"
import { symbolicate } from "../../tools/ota/symbolicate"
import { RuleError } from "./model"
import type { FileStore } from "./storage"

/** A map is at most this big (ZeroBill's is about 1 MB). */
export const MAP_MAX_BYTES = 40 * 1024 * 1024

export const mapPath = (app: string, sha: string) => `${app}/maps/${sha}.map`

function checkSha(sha: string) {
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new RuleError("the bundle SHA-256 must be 64 hex characters")
}

/** Stores the map of the bundle with SHA-256 [sha]. The same bundle's map again is fine (same bytes). */
export async function putMap(store: FileStore, app: string, sha: string, data: Uint8Array) {
  checkSha(sha)
  if (data.length > MAP_MAX_BYTES) throw new RuleError(`a source map is at most ${MAP_MAX_BYTES >> 20} MB`)
  let raw: { mappings?: unknown; sources?: unknown }
  try {
    raw = JSON.parse(new TextDecoder().decode(data))
  } catch {
    throw new RuleError("the map is not JSON")
  }
  if (typeof raw.mappings !== "string" || !Array.isArray(raw.sources)) throw new RuleError("the map has no mappings or sources")
  await store.put(mapPath(app, sha), data, "application/json")
  decoded.delete(`${app}|${sha}`)
  sizes.delete(`${app}|${sha}`)
}

/** The map's text, or null when it was never uploaded. */
export async function mapText(store: FileStore, app: string, sha: string): Promise<string | null> {
  checkSha(sha)
  const file = await store.local(mapPath(app, sha))
  return file ? await Bun.file(file).text() : null
}

// A few decoded maps in memory: decoding ZeroBill's takes ~100 ms, and the errors of one bundle come together.
const decoded = new Map<string, DecodedMap>()
const DECODED_KEEP = 4

async function decodedMap(store: FileStore, app: string, sha: string): Promise<DecodedMap | null> {
  const key = `${app}|${sha}`
  const hit = decoded.get(key)
  if (hit) {
    decoded.delete(key)
    decoded.set(key, hit) // most recent last
    return hit
  }
  const text = await mapText(store, app, sha)
  if (!text) return null
  const m = decodeSourceMap(JSON.parse(text))
  decoded.set(key, m)
  while (decoded.size > DECODED_KEEP) decoded.delete(decoded.keys().next().value!)
  return m
}

/**
 * The phones' error stacks with their TSX lines: `decoded` is set when the bundle's map is on the server and at least
 * one frame was found in it. Never throws (a stack that can't be decoded is shown as it came).
 */
export async function decodeStacks<T extends { stack: string | null; sha: string | null }>(store: FileStore, app: string, rows: T[]): Promise<(T & { decoded: string | null })[]> {
  const out: (T & { decoded: string | null })[] = []
  for (const r of rows) {
    let text: string | null = null
    if (r.stack && r.sha && /^[0-9a-f]{64}$/.test(r.sha)) {
      try {
        const m = await decodedMap(store, app, r.sha)
        if (m) {
          const s = symbolicate(r.stack, m)
          if (s.mapped > 0) text = s.text
        }
      } catch (e) {
        console.warn(`decode stack (${r.sha.slice(0, 12)}): ${(e as Error).message}`)
      }
    }
    out.push({ ...r, decoded: text })
  }
  return out
}

// ---- What a bundle is made of -----------------------------------------------------------------------------------------

export interface SizePart {
  name: string
  bytes: number
}
export interface Sizes {
  /** Bytes of main.js the map points to a source file. */
  mapped: number
  /** main.js bytes the map points nowhere (glue the build adds). */
  unmapped: number
  files: SizePart[]
  folders: SizePart[]
  /** How many source files are in the bundle. */
  fileCount: number
}

const sizes = new Map<string, Sizes>()

/**
 * A source file's share of main.js, from the map alone (main.js itself isn't kept). Each mapped piece runs to the next
 * one on its line; the last piece of a line counts 1 character, as the line's length isn't in the map. Measured on the
 * sample (2026-11-10): about 9 % under the real sizes, evenly across files, so the order and the change from bundle to
 * bundle are right; the dashboard says "about".
 */
export function sizesOf(m: DecodedMap): Sizes {
  const perFile = new Map<string, number>()
  let unmapped = 0
  for (const segs of m.lines) {
    if (!segs.length) continue
    unmapped += segs[0]![0]
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k]!
      const end = k + 1 < segs.length ? segs[k + 1]![0] : s[0] + 1
      const n = Math.max(0, end - s[0])
      if (s.length < 4) {
        unmapped += n
        continue
      }
      const file = cleanName(m.sources[s[1]] ?? "?")
      perFile.set(file, (perFile.get(file) ?? 0) + n)
    }
  }
  const perFolder = new Map<string, number>()
  for (const [f, n] of perFile) {
    const folder = folderOf(f)
    perFolder.set(folder, (perFolder.get(folder) ?? 0) + n)
  }
  const sorted = (x: Map<string, number>, top: number) =>
    [...x].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, bytes]) => ({ name, bytes }))
  return {
    mapped: [...perFile.values()].reduce((a, b) => a + b, 0),
    unmapped,
    files: sorted(perFile, 60),
    folders: sorted(perFolder, 40),
    fileCount: perFile.size,
  }
}

/** `../../Futuristic/zero-native/packages/core/src/nav.ts` → `zero-native/packages/core/src/nav.ts`. */
export function cleanName(source: string): string {
  let s = source.replace(/\\/g, "/").replace(/^(\.\.?\/)+/, "")
  const nm = s.lastIndexOf("node_modules/")
  if (nm >= 0) return s.slice(nm)
  const zn = s.indexOf("zero-native/")
  if (zn >= 0) s = s.slice(zn)
  return s
}

/** The folder a file counts under: its npm package, or its folder. */
export function folderOf(file: string): string {
  const nm = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(file)
  if (nm) return nm[1]!
  const i = file.lastIndexOf("/")
  return i > 0 ? file.slice(0, i) : "(top)"
}

/** The size breakdown of the bundle with SHA-256 [sha], or null without a map. Cached per bundle. */
export async function bundleSizes(store: FileStore, app: string, sha: string): Promise<Sizes | null> {
  const key = `${app}|${sha}`
  const hit = sizes.get(key)
  if (hit) return hit
  const m = await decodedMap(store, app, sha)
  if (!m) return null
  const s = sizesOf(m)
  sizes.set(key, s)
  if (sizes.size > 64) sizes.delete(sizes.keys().next().value!)
  return s
}
