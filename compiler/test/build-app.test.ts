import { describe, expect, test } from "bun:test"
import { dirname, join } from "node:path"
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
