import { expect, test } from "bun:test"
import { sourceRegistryNeed } from "../src/needs"

const app = (body: string, imports = "draw") => `import { ${imports} } from "@zero-native/core"\n${body}`

test("registry 23 canvas use needs nothing extra", () => {
  expect(sourceRegistryNeed(app(`const c = [draw.rect(0, 0, 10, 10, { color: "#f00" }), draw.clipRect(0, 0, 5, 5)]`), "a.tsx")).toBe(0)
})

test("each registry 24 canvas command or paint key needs 24", () => {
  for (const body of [
    `draw.image("asset:x.png", 0, 0, 10, 10)`,
    `draw.paragraph("hi", 0, 0, 100)`,
    `draw.clipRoundRect(0, 0, 5, 5, 2)`,
    `draw.clipPath("M0 0")`,
    `draw.clipRect(0, 0, 5, 5, { op: "difference" })`,
    `const p = { color: 1, blur: 4 }`,
    `const p = { shadow: { dx: 0, dy: 2, blur: 4 } }`,
    `const p = { blendMode: "multiply" }`,
    `const p = { sweepGradient: { cx: 0, cy: 0, colors: [] } }`,
    `draw.path("M0 0", undefined, { trimEnd: 0.5 })`,
  ]) {
    expect(sourceRegistryNeed(app(body), "a.ts")).toBe(24)
  }
})

test("a renamed or namespace import still counts", () => {
  expect(sourceRegistryNeed(app(`d.image("x", 0, 0, 1, 1)`, "draw as d"), "a.ts")).toBe(24)
  expect(sourceRegistryNeed(`import * as zn from "@zero-native/core"\nzn.draw.paragraph("x", 0, 0, 9)`, "a.ts")).toBe(24)
})

test("files that don't use the canvas API, and core itself, need nothing", () => {
  expect(sourceRegistryNeed(app(`const s = { shadow: 1, blur: 2 }`, "signal"), "a.tsx")).toBe(0)
  expect(sourceRegistryNeed(app(`draw.image("x", 0, 0, 1, 1)`), "/repo/packages/core/src/canvas.ts")).toBe(0)
})
