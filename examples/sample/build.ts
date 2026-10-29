// Builds the sample app for android/sample:
//   src/*.tsx → zero-native compiler (Bun plugin) → one JS bundle + templates
//   assets/main.zn.ui (templates), assets/main.zn.ui.json (manifest), assets/main.hbc (Hermes bytecode)
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { znBuild } from "@zero-native/compiler"
import { hermesc } from "../../tools/hermesc"

const root = join(import.meta.dir, "../..")
const assets = join(root, "android/sample/src/main/assets")
const tmpDir = join(import.meta.dir, "build")
mkdirSync(assets, { recursive: true })
mkdirSync(tmpDir, { recursive: true })

const zn = znBuild()
const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/main.ts")],
  target: "browser",
  format: "iife", // Hermes runs plain scripts, not ES modules
  minify: false,
  plugins: [zn.plugin],
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

const { templates, manifest } = zn.outputs()
await Bun.write(join(assets, "main.zn.ui"), templates)
await Bun.write(join(assets, "main.zn.ui.json"), JSON.stringify(manifest, null, 2))
console.log(`sample: wrote main.zn.ui (${templates.length} bytes, components ${JSON.stringify(manifest.components)})`)

const jsPath = join(tmpDir, "main.js")
await Bun.write(jsPath, await result.outputs[0].text())
await hermesc(jsPath, join(assets, "main.hbc"))
console.log("sample: wrote main.hbc")
