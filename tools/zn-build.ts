// Builds an app's JS for its Android host:
//   src/*.tsx → zero-native compiler (Bun plugin) → one JS bundle + templates
//   assets/main.zn.ui (templates), assets/main.zn.ui.json (manifest), assets/main.hbc (Hermes bytecode),
//   assets/zn-bundle.json (bundle id + file hashes, docs/ota.md §3.1); the app's images in <appDir>/assets/ are copied
//   in too (`asset:images/x.png` = <appDir>/assets/images/x.png)
// For live reload while you work, use `bun run dev` instead (tools/zn-dev.ts).
//
//   bun run tools/zn-build.ts <appDir> --name myapp --assets <the host's src/main/assets>
//
// An app outside this repo runs it the same way (docs/guide-notes.md §34). The sample calls znBuild from its build.ts.
// Options: --serial N (bundle serial, default 0 = never released), --out DIR (write the bundle somewhere else, for
// example to copy it to the phone by hand as an OTA bundle), --map FILE (where the source map goes; default
// <appDir>/build/main.js.map). The map maps release stack traces back to TSX (`bun run ota symbolicate`, step 4.8); it is
// never part of the bundle, so it must not go inside --out.
import { basename, join, resolve } from "node:path"
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs"
import { parseArgs } from "node:util"
import { buildApp } from "../compiler/src"
import { bytecodeVersion, hermesc } from "./hermesc"
import { writeBundleInfo } from "./bundle-info"

export async function znBuild(defaults: { appDir?: string; name?: string; assets?: string } = {}) {
  const { values: args, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      assets: { type: "string" },
      serial: { type: "string" },
      out: { type: "string" },
      map: { type: "string" },
    },
  })
  const dir = defaults.appDir ?? positionals[0]
  const assetsDir = args.out ?? args.assets ?? defaults.assets
  if (!dir || !assetsDir) {
    console.error("usage: bun run tools/zn-build.ts <appDir> --assets <dir> [--name N] [--serial N] [--out DIR] [--map FILE]")
    process.exit(1)
  }
  const appDir = resolve(dir)
  const name = args.name ?? defaults.name ?? basename(appDir)
  const serial = Number(args.serial ?? "0")
  const assets = resolve(assetsDir)
  const tmpDir = join(appDir, "build")
  mkdirSync(assets, { recursive: true })
  mkdirSync(tmpDir, { recursive: true })

  let app
  try {
    app = await buildApp(join(appDir, "src/main.ts"))
  } catch (e) {
    console.error((e as Error).message)
    // Bun's "Bundle failed" keeps the real reasons (our compiler's messages) in `errors`.
    for (const err of (e as { errors?: unknown[] }).errors ?? []) console.error((err as Error).message ?? String(err))
    process.exit(1)
  }

  await Bun.write(join(assets, "main.zn.ui"), app.templates)
  await Bun.write(join(assets, "main.zn.ui.json"), JSON.stringify(app.manifest, null, 2))
  console.log(`${name}: wrote main.zn.ui (${app.templates.length} bytes, components ${JSON.stringify(app.manifest.components)})`)

  const jsPath = join(tmpDir, "main.js")
  await Bun.write(jsPath, app.js)
  await hermesc(jsPath, join(assets, "main.hbc"))
  console.log(`${name}: wrote main.hbc`)

  // The app's own images (`asset:` paths) are part of the bundle, so an OTA update can change or add them too.
  const appAssets = join(appDir, "assets")
  const assetNames = existsSync(appAssets) ? readdirSync(appAssets) : []
  if (assetNames.length > 0) cpSync(appAssets, assets, { recursive: true })

  const names = ["main.hbc", "main.zn.ui", "main.zn.ui.json", ...assetNames]
  const requires = { ...app.requires, bytecode: await bytecodeVersion(join(assets, "main.hbc")) }
  const info = await writeBundleInfo(assets, { app: name, serial, names, requires })
  console.log(`${name}: wrote zn-bundle.json (${info.id}, sha256 ${info.sha256.slice(0, 12)}…, needs ${JSON.stringify(info.requires)})`)

  // The source map: main.js → the TSX files (named relative to the app's folder), and which bundle it belongs to.
  const mapPath = args.map ? resolve(args.map) : join(tmpDir, "main.js.map")
  const map = JSON.parse(app.sourceMap("main.js", appDir))
  await Bun.write(mapPath, JSON.stringify({ ...map, x_zn_bundle: { app: name, id: info.id, sha256: info.sha256 } }))
  console.log(`${name}: wrote ${args.map ? mapPath : "build/main.js.map"} (source map for ${info.sha256.slice(0, 12)})`)
}

if (import.meta.main) await znBuild()
