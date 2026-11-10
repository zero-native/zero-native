// Builds an app's screens in one step: TSX → (zero-native compiler + Bun bundler) → templates, manifest and one JS
// bundle with its source map. Used by an app's build script and by `zn dev` (tools/zn-dev.ts). Hermes bytecode is
// made from `js` afterwards (tools/hermesc.ts).
import { existsSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { scanFonts } from "./fonts"
import { packageRootOf, stableFileKey } from "./modules"
import { type BundleRequires, znBuild, type ZnManifest } from "./plugin"
import { decodeSourceMap, type DecodedMap, encodeSourceMap, type LineMap, lookup } from "./sourcemap"

export interface AppBuild {
  /** The .zn.ui file. */
  templates: Uint8Array
  manifest: ZnManifest
  /** One plain script (Hermes runs scripts, not ES modules). */
  js: string
  /** What an app must have to run this build (OTA capability check, docs/ota.md §3.2); bytecode format not included. */
  requires: BundleRequires
  /** Each needed module → the package it comes from (zn-bundle.json `moduleFrom`, for the dashboard; not signed). */
  moduleFrom: Record<string, string>
  /** Maps a position in `js` (0-based line and column) back to the TSX / TS file. */
  original(line: number, col: number): { file: string; line: number; col: number } | null
  /**
   * A standard v3 source map from `js` (named [file]) straight to the TSX / TS files, which are named relative to
   * [relativeTo] with "/" (step 4.8: kept with each released bundle, read by `bun run ota symbolicate`). Every point
   * of Bun's map goes through [original]. No source text inside.
   */
  sourceMap(file: string, relativeTo: string): string
}

export async function buildApp(entry: string): Promise<AppBuild> {
  // The app's fonts: <app>/assets/fonts next to <app>/src (the entry's folder). Read on every build, so a font added
  // while `zn dev` runs is known at the next build (its file reaches the phone with the next APK or OTA bundle).
  const zn = znBuild({ fonts: scanFonts(resolve(dirname(resolve(entry)), "../assets/fonts")) })
  const result = await Bun.build({
    entrypoints: [entry],
    target: "browser",
    format: "iife", // Hermes runs plain scripts, not ES modules
    minify: false,
    sourcemap: "external",
    plugins: [zn.plugin],
  })
  if (!result.success) throw new AggregateError(result.logs, result.logs.map(String).join("\n"))

  const js = result.outputs.find((o) => o.kind === "entry-point")!
  const mapFile = result.outputs.find((o) => o.kind === "sourcemap")
  // Bun ends the bundle with a random `//# debugId=` comment (it links the file to its source map). We keep the map
  // ourselves, and the same source must give the same bytes (docs/ota.md §3.1), so it is dropped. It is the last
  // line, so no position in the source map moves.
  // Bun also names each module in a comment line (`// packages/core/src/log.ts`), relative to the working folder: the
  // same source built from another folder gave other bytes, so `ota keep-map` (run in the app's folder) didn't match
  // the APK's bundle (step 4.8). They are named relative to the entry's folder instead; one line stays one line.
  // A file outside the app's own package (core, a plugin) is named by its package instead ("@zero-native/lottie/src/
  // index.tsx", modules.ts stableFileKey): the path from the app to the framework differs per machine, and Hermes keeps
  // a hash of the whole source (comments too) in main.hbc's header, so a Mac and Windows built other bytes (2026-11-10).
  const entryDir = dirname(resolve(entry))
  const appRoot = packageRootOf(resolve(entry))
  const inApp = (file: string) => {
    if (appRoot === null) return true
    const r = relative(appRoot, file)
    return !r.startsWith("..") && !isAbsolute(r)
  }
  const bundled = (await js.text())
    .replace(/\n\/\/# debugId=[0-9A-Fa-f]+\s*$/, "\n")
    .replace(/^([ \t]*)\/\/ (\S+\.(?:[cm]?[jt]sx?|json))$/gm, (line, indent: string, path: string) => {
      const file = resolve(process.cwd(), path)
      if (!existsSync(file)) return line
      return `${indent}// ${inApp(file) ? relative(entryDir, file).replaceAll("\\", "/") : stableFileKey(file)}`
    })
  const { templates, manifest, js: filledJs, requires, moduleFrom } = zn.outputs(bundled)
  const bundleMap: DecodedMap | null = mapFile ? decodeSourceMap(JSON.parse(await mapFile.text())) : null

  const original = (line: number, col: number) => {
    const hit = bundleMap && lookup(bundleMap, line, col)
    if (!hit) return null
    // Bun's map names sources relative to the working folder (seen with Bun 1.4); the compiler's maps are keyed by
    // absolute path. Fall back to the entry's folder in case that changes.
    const file = [resolve(process.cwd(), hit.source), resolve(dirname(entry), hit.source)].find(existsSync) ??
      hit.source
    const tsx: LineMap | undefined = zn.maps.get(file)
    const pos = tsx ? tsx.lookup(hit.line, hit.col) : { line: hit.line, col: hit.col }
    return pos ? { file, line: pos.line, col: pos.col } : null
  }

  return {
    templates,
    manifest,
    js: filledJs,
    requires,
    moduleFrom,
    original,
    sourceMap(file, relativeTo) {
      const sources: string[] = []
      const index = new Map<string, number>()
      const lines = (bundleMap?.lines ?? []).map((entries, line) => {
        const out: Array<[number, number, number, number]> = []
        for (const [genCol] of entries) {
          const pos = original(line, genCol)
          if (!pos) continue
          const name = relative(relativeTo, pos.file).replaceAll("\\", "/")
          let i = index.get(name)
          if (i === undefined) index.set(name, (i = sources.push(name) - 1))
          const prev = out[out.length - 1]
          if (prev && prev[0] === genCol) continue // two points on one column: the first wins, as in lookup
          out.push([genCol, i, pos.line, pos.col])
        }
        return out
      })
      return encodeSourceMap({ sources, lines }, file)
    },
  }
}
