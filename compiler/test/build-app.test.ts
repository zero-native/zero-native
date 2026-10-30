import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { buildApp } from "../src/build-app"

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
