// Builds the sample app for android/sample:
//   src/*.tsx → zero-native compiler (Bun plugin) → one JS bundle + templates
//   assets/main.zn.ui (templates), assets/main.zn.ui.json (manifest), assets/main.hbc (Hermes bytecode),
//   assets/zn-bundle.json (bundle id + file hashes, docs/ota.md §3.1); the app's images in examples/sample/assets/
//   are copied in too (`asset:images/x.png` = examples/sample/assets/images/x.png)
// For live reload while you work, use `bun run dev` instead (tools/zn-dev.ts).
// Options: --serial N (bundle serial, default 0 = never released), --out DIR (write the bundle somewhere else, for
// example to copy it to the phone by hand as an OTA bundle), --map FILE (where the source map goes; default
// build/main.js.map). The map maps release stack traces back to TSX (`bun run ota symbolicate`, step 4.8); it is never
// part of the bundle, so it must not go inside --out.
import { join, resolve } from "node:path"
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { parseArgs } from "node:util"
import { buildApp } from "@zero-native/compiler"
import { bytecodeVersion, hermesc } from "../../tools/hermesc"
import { writeBundleInfo } from "../../tools/bundle-info"

const { values: args } = parseArgs({ options: { serial: { type: "string" }, out: { type: "string" }, map: { type: "string" } } })
const serial = Number(args.serial ?? "0")
const root = join(import.meta.dir, "../..")
const assets = args.out ? resolve(args.out) : join(root, "android/sample/src/main/assets")
const tmpDir = join(import.meta.dir, "build")
mkdirSync(assets, { recursive: true })
mkdirSync(tmpDir, { recursive: true })

let app
try {
  app = await buildApp(join(import.meta.dir, "src/main.ts"))
} catch (e) {
  console.error((e as Error).message)
  // Bun's "Bundle failed" keeps the real reasons (our compiler's messages) in `errors`.
  for (const err of (e as { errors?: unknown[] }).errors ?? []) console.error((err as Error).message ?? String(err))
  process.exit(1)
}

await Bun.write(join(assets, "main.zn.ui"), app.templates)
await Bun.write(join(assets, "main.zn.ui.json"), JSON.stringify(app.manifest, null, 2))
console.log(`sample: wrote main.zn.ui (${app.templates.length} bytes, components ${JSON.stringify(app.manifest.components)})`)

const jsPath = join(tmpDir, "main.js")
await Bun.write(jsPath, app.js)
await hermesc(jsPath, join(assets, "main.hbc"))
console.log("sample: wrote main.hbc")

// The app's own images (`asset:` paths) are part of the bundle, so an OTA update can change or add them too.
const appAssets = join(import.meta.dir, "assets")
const assetNames = existsSync(appAssets) ? readdirSync(appAssets) : []
if (assetNames.length > 0) cpSync(appAssets, assets, { recursive: true })

const names = ["main.hbc", "main.zn.ui", "main.zn.ui.json", ...assetNames]
const requires = { ...app.requires, bytecode: await bytecodeVersion(join(assets, "main.hbc")) }
const info = await writeBundleInfo(assets, { app: "sample", serial, names, requires })
console.log(`sample: wrote zn-bundle.json (${info.id}, sha256 ${info.sha256.slice(0, 12)}…, needs ${JSON.stringify(info.requires)})`)

// The source map: main.js → the TSX files (named relative to examples/sample), and which bundle it belongs to.
const mapPath = args.map ? resolve(args.map) : join(tmpDir, "main.js.map")
const map = JSON.parse(app.sourceMap("main.js", import.meta.dir))
await Bun.write(mapPath, JSON.stringify({ ...map, x_zn_bundle: { app: "sample", id: info.id, sha256: info.sha256 } }))
console.log(`sample: wrote ${args.map ? mapPath : "build/main.js.map"} (source map for ${info.sha256.slice(0, 12)})`)
