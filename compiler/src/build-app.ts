// Builds an app's screens in one step: TSX → (zero-native compiler + Bun bundler) → templates, manifest and one JS
// bundle with its source map. Used by an app's build script and by `zn dev` (tools/zn-dev.ts). Hermes bytecode is
// made from `js` afterwards (tools/hermesc.ts).
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { znBuild, type ZnManifest } from "./plugin"
import { decodeSourceMap, type DecodedMap, type LineMap, lookup } from "./sourcemap"

export interface AppBuild {
  /** The .zn.ui file. */
  templates: Uint8Array
  manifest: ZnManifest
  /** One plain script (Hermes runs scripts, not ES modules). */
  js: string
  /** Maps a position in `js` (0-based line and column) back to the TSX / TS file. */
  original(line: number, col: number): { file: string; line: number; col: number } | null
}

export async function buildApp(entry: string): Promise<AppBuild> {
  const zn = znBuild()
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
  const bundled = (await js.text()).replace(/\n\/\/# debugId=[0-9A-Fa-f]+\s*$/, "\n")
  const { templates, manifest, js: filledJs } = zn.outputs(bundled)
  const bundleMap: DecodedMap | null = mapFile ? decodeSourceMap(JSON.parse(await mapFile.text())) : null

  return {
    templates,
    manifest,
    js: filledJs,
    original(line, col) {
      const hit = bundleMap && lookup(bundleMap, line, col)
      if (!hit) return null
      // Bun's map names sources relative to the working folder (seen with Bun 1.4); the compiler's maps are keyed by
      // absolute path. Fall back to the entry's folder in case that changes.
      const file = [resolve(process.cwd(), hit.source), resolve(dirname(entry), hit.source)].find(existsSync) ??
        hit.source
      const tsx: LineMap | undefined = zn.maps.get(file)
      const pos = tsx ? tsx.lookup(hit.line, hit.col) : { line: hit.line, col: hit.col }
      return pos ? { file, line: pos.line, col: pos.col } : null
    },
  }
}
