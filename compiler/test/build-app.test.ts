import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { buildApp } from "../src/build-app"
import { decodeSourceMap, encodeSourceMap, lookup } from "../src/sourcemap"

const entry = join(import.meta.dir, "fixtures/order/main.ts")

describe("buildApp output is the same for the same source (docs/ota.md §3.1)", () => {
  test("template ids follow file path order, not the order Bun loads files in", async () => {
    const app = await buildApp(entry)
    // main.ts imports b.tsx first, but a.tsx sorts first.
    expect(app.manifest.components).toEqual({ AScreen: 0, BScreen: 1 })
    expect(app.js).toContain(`view(0            ,`) // placeholder filled in, padded to its width
    expect(app.js).not.toContain("__znT")
    expect(app.js).not.toContain("debugId")
  })

  test("two builds give the same bytes", async () => {
    const one = await buildApp(entry)
    const two = await buildApp(entry)
    expect(two.js).toBe(one.js)
    expect(two.templates).toEqual(one.templates)
    expect(JSON.stringify(two.manifest)).toBe(JSON.stringify(one.manifest))
  })

  test("the working folder doesn't change the bytes (step 4.8: `ota keep-map` must match the APK's bundle)", async () => {
    const here = process.cwd()
    try {
      process.chdir(dirname(entry))
      const inApp = await buildApp(entry)
      process.chdir(join(import.meta.dir, "../.."))
      const atRoot = await buildApp(entry)
      expect(atRoot.js).toBe(inApp.js)
      expect(inApp.js).toContain("// b.tsx") // Bun's module comments, named from the entry's folder
    } finally {
      process.chdir(here)
    }
  })

  test("where the framework sits next to the app doesn't change the bytes (a Mac and Windows, 2026-11-10)", async () => {
    // The same app and the same linked package, in two folder layouts. Bun names each module in a comment; Hermes keeps
    // a hash of the whole source in main.hbc, so a path from the app to the package gave each machine other bytes.
    const root = mkdtempSync(join(tmpdir(), "zn-layout-"))
    try {
      const make = (pkgDir: string, appDir: string) => {
        mkdirSync(join(pkgDir, "src"), { recursive: true })
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "plug", main: "src/index.ts" }))
        writeFileSync(join(pkgDir, "src", "index.ts"), `export const hello = () => "hi"
`)
        mkdirSync(join(appDir, "src"), { recursive: true })
        mkdirSync(join(appDir, "node_modules"), { recursive: true })
        writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "app" }))
        writeFileSync(join(appDir, "src", "main.ts"), `import { hello } from "plug"
;(globalThis as any).x = hello()
`)
        symlinkSync(pkgDir, join(appDir, "node_modules", "plug"), "junction") // as `bun install` links a workspace package
        return join(appDir, "src", "main.ts")
      }
      const a = await buildApp(make(join(root, "a", "Futuristic", "fw", "plug"), join(root, "a", "projects", "app")))
      const b = await buildApp(make(join(root, "b", "fw", "plug"), join(root, "b", "z", "y", "app")))
      expect(b.js).toBe(a.js)
      expect(a.js).toContain("// plug/src/index.ts") // named by its package, not by a path from the app
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("a package installed from npm gives the same bytes as the same package linked from a checkout (2026-11-19)", async () => {
    // The real path: on a Mac the temp folder is behind a symlink (/var → /private/var), which hides the case.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "zn-installed-")))
    try {
      const make = (appDir: string, installed: boolean) => {
        const pkgDir = installed ? join(appDir, "node_modules", "plug") : join(root, "checkout", "plug")
        mkdirSync(join(pkgDir, "src"), { recursive: true })
        writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "plug", main: "src/index.ts" }))
        writeFileSync(join(pkgDir, "src", "index.ts"), `export const hello = () => "hi"
`)
        mkdirSync(join(appDir, "src"), { recursive: true })
        mkdirSync(join(appDir, "node_modules"), { recursive: true })
        writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "app" }))
        writeFileSync(join(appDir, "src", "main.ts"), `import { hello } from "plug"
;(globalThis as any).x = hello()
`)
        if (!installed) symlinkSync(pkgDir, join(appDir, "node_modules", "plug"), "junction")
        return join(appDir, "src", "main.ts")
      }
      const linked = await buildApp(make(join(root, "linked"), false))
      const installed = await buildApp(make(join(root, "installed"), true))
      expect(installed.js).toBe(linked.js)
      expect(installed.js).toContain("// plug/src/index.ts")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("source positions still map back after the ids are filled in", async () => {
    const app = await buildApp(entry)
    const lines = app.js.split("\n")
    // `props.on` comes after two filled-in ids on its line (`view(1 ...` above it, `view(2 ...` on it).
    const line = lines.findIndex((l) => l.includes("() => props.on"))
    expect(line).toBeGreaterThanOrEqual(0)
    const pos = app.original(line, lines[line].indexOf("props.on"))
    expect(pos?.file.endsWith("b.tsx")).toBe(true)
    expect(pos?.line).toBe(6) // 0-based: `      {props.on && <Text>on</Text>}`
    expect(pos?.col).toBe(7)
  })
})

describe("the saved source map (step 4.8, `ota symbolicate`)", () => {
  test("it gives the same TSX position as original(), named relative to the app folder", async () => {
    const app = await buildApp(entry)
    const raw = JSON.parse(app.sourceMap("main.js", dirname(entry)))
    expect(raw).toMatchObject({ version: 3, file: "main.js", names: [] })
    expect(raw.sources).toContain("b.tsx")
    const map = decodeSourceMap(raw)
    const lines = app.js.split("\n")
    const line = lines.findIndex((l) => l.includes("() => props.on"))
    const hit = lookup(map, line, lines[line].indexOf("props.on"))
    expect(hit).toEqual({ source: "b.tsx", line: 6, col: 7 })
  })

  test("encode → decode gives the entries back", () => {
    const map = { sources: ["a.tsx", "../lib/b.ts"], lines: [[[0, 0, 0, 0], [7, 1, 40, 2]], [], [[3, 0, 12, 9]]] as Array<Array<[number, number, number, number]>> }
    expect(decodeSourceMap(JSON.parse(encodeSourceMap(map, "main.js")))).toEqual(map)
  })

  test("two builds give the same map", async () => {
    const one = await buildApp(entry)
    const two = await buildApp(entry)
    expect(two.sourceMap("main.js", dirname(entry))).toBe(one.sourceMap("main.js", dirname(entry)))
  })
})

describe("a .ts file that imports a .tsx file (issue A16)", () => {
  const a16 = join(import.meta.dir, "fixtures/ts-imports-tsx/main.ts")

  test("builds: the .tsx file goes through the zero-native compiler, not React's JSX", async () => {
    // screen.tsx imports Badge and GAP from parts.ts, which re-exports Badge from badge.tsx. Loading parts.ts at
    // build time to fold GAP made Bun read badge.tsx as React JSX: "Cannot find package 'react'".
    const app = await buildApp(a16)
    expect(Object.keys(app.manifest.components).sort()).toEqual(["Badge", "HomeScreen"])
    expect(app.js).toContain(`component(__i0, 2, Badge, { label: "new" })`)
    expect(app.js).not.toContain("jsx")
  })

  test("its values are read at runtime; a tokens file with no .tsx import is still folded", async () => {
    const app = await buildApp(a16)
    expect(app.js).toContain("() => GAP") // a slot: parts.ts is not loaded at build time
    expect(app.js).not.toContain("PAD") // folded into the template from tokens.ts
  })
})
