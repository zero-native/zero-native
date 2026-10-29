// Builds the sample app for android/sample:
//   src/*.tsx → zero-native compiler (Bun plugin) → one JS bundle + templates
//   assets/main.zn.ui (templates), assets/main.zn.ui.json (manifest), assets/main.hbc (Hermes bytecode)
// For live reload while you work, use `bun run dev` instead (tools/zn-dev.ts).
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { buildApp } from "@zero-native/compiler"
import { hermesc } from "../../tools/hermesc"

const root = join(import.meta.dir, "../..")
const assets = join(root, "android/sample/src/main/assets")
const tmpDir = join(import.meta.dir, "build")
mkdirSync(assets, { recursive: true })
mkdirSync(tmpDir, { recursive: true })

let app
try {
  app = await buildApp(join(import.meta.dir, "src/main.ts"))
} catch (e) {
  console.error((e as Error).message)
  process.exit(1)
}

await Bun.write(join(assets, "main.zn.ui"), app.templates)
await Bun.write(join(assets, "main.zn.ui.json"), JSON.stringify(app.manifest, null, 2))
console.log(`sample: wrote main.zn.ui (${app.templates.length} bytes, components ${JSON.stringify(app.manifest.components)})`)

const jsPath = join(tmpDir, "main.js")
await Bun.write(jsPath, app.js)
await hermesc(jsPath, join(assets, "main.hbc"))
console.log("sample: wrote main.hbc")
