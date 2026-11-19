// Each plugin's native modules are named after the plugin (Pavan, 2026-11-11): the name starts with the package's first
// word, so "Push" can't hide in @zeronative/firebase-messaging ("FirebaseMessaging") and two plugins can't both take
// a short name like "Auth" or "Analytics". The bundle's needs list shows these names (docs/plugins.md, "Module names").
// The JS, Kotlin and Swift sides must also agree: a module the native side registers under another name is "missing".
import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const root = import.meta.dir

function files(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((n) => {
    if (n === "node_modules" || n === "build" || n === ".gradle" || n === "test") return []
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p, ext) : p.endsWith(ext) ? [p] : []
  })
}

function names(paths: string[], pattern: RegExp): Set<string> {
  const out = new Set<string>()
  for (const p of paths) for (const m of readFileSync(p, "utf8").matchAll(pattern)) out.add(m[1]!)
  return out
}

const plugins = readdirSync(root).filter((n) => existsSync(join(root, n, "package.json")))

test("there are plugins to check", () => {
  expect(plugins.length).toBeGreaterThan(10)
})

for (const dir of plugins) {
  const pkg = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as { name: string }
  const js = names(files(join(root, dir, "src"), ".ts"), /nativeModule(?:<[^>]*>)?\(\s*"([A-Za-z0-9]+)"/g)
  if (js.size === 0) continue
  const kotlin = names(files(join(root, dir, "android"), ".kt"), /ZnModuleBase\(\s*"([A-Za-z0-9]+)"/g)
  const swift = names(files(join(root, dir, "ios"), ".swift"), /super\.init\(\s*"([A-Za-z0-9]+)"/g)

  test(`${pkg.name}: module names start with the package's first word`, () => {
    const first = pkg.name.replace(/^@[^/]+\//, "").split("-")[0]!.toLowerCase()
    for (const name of js) expect(`${name} starts with ${first}: ${name.toLowerCase().startsWith(first)}`).toBe(`${name} starts with ${first}: true`)
  })

  test(`${pkg.name}: Kotlin and Swift register the JS names`, () => {
    for (const name of kotlin) expect(js.has(name) ? name : `${name} (Kotlin only)`).toBe(name)
    for (const name of swift) expect(js.has(name) ? name : `${name} (Swift only)`).toBe(name)
  })
}
