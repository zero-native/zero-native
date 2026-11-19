// Each plugin with native code writes its OSes in `zeroNative.platforms`. The compiler falls back to the plugin's
// android/ and ios/ folders, but the npm package ships only src/ (those folders go to Maven and SwiftPM), so an app that
// installs the plugin from npm has no folders to look at. Without the field, an iOS plugin would count as Android only,
// and an iOS phone would take an OTA bundle without checking that it has the module (docs/ota-requires-per-os.md).
import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const root = import.meta.dir

test("every plugin with native code lists its platforms, and they match its folders", () => {
  const wrong: string[] = []
  for (const name of readdirSync(root).sort()) {
    const pkgPath = join(root, name, "package.json")
    if (!existsSync(pkgPath)) continue
    const zn = JSON.parse(readFileSync(pkgPath, "utf8")).zeroNative as { platforms?: string[]; android?: unknown } | undefined
    const folders: string[] = []
    if (zn?.android !== undefined || existsSync(join(root, name, "android"))) folders.push("android")
    if (existsSync(join(root, name, "ios"))) folders.push("ios")
    if (folders.length === 0) continue // JS only (markdown): counts for both OSes
    const written = zn?.platforms
    if (JSON.stringify(written) !== JSON.stringify(folders)) wrong.push(`${name}: platforms ${JSON.stringify(written)}, folders ${JSON.stringify(folders)}`)
  }
  expect(wrong).toEqual([])
})
