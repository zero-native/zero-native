import { describe, expect, test } from "bun:test"
import { encodeSourceMap } from "../../../compiler/src/sourcemap"
import { bundleIn, symbolicate } from "../symbolicate"

// main.js line 3 (0-based 2): col 4 → HomeScreen.tsx 0-based (26, 4); col 20 → nav.ts (99, 0).
const map = encodeSourceMap(
  { sources: ["src/HomeScreen.tsx", "../../packages/core/src/nav.ts"], lines: [[], [], [[4, 0, 26, 4], [20, 1, 99, 0]]] },
  "main.js",
)

describe("symbolicate (step 4.8)", () => {
  test("Hermes frames map to TSX, keeping the main.js position", () => {
    const trace = "Error: boom\n    at HomeScreen (main.js:3:5)\n    at render (main.js:3:21)\n    at native (native)"
    const r = symbolicate(trace, map)
    expect(r.text).toBe(
      "Error: boom\n    at HomeScreen (src/HomeScreen.tsx:27:5 (main.js:3:5))\n" +
        "    at render (../../packages/core/src/nav.ts:100:1 (main.js:3:21))\n    at native (native)",
    )
    expect([r.mapped, r.frames]).toEqual([2, 2])
  })

  test("older bundles' full paths and Crashlytics frames without a column", () => {
    expect(symbolicate(String.raw`at x (C:\work\app\build\main.js:3:9)`, map).text).toBe("at x (src/HomeScreen.tsx:27:9 (main.js:3:9))")
    expect(symbolicate("at zn.js.HomeScreen(main.js:3)", map).text).toBe("at zn.js.HomeScreen(src/HomeScreen.tsx:27 (main.js:3))")
  })

  test("without a column, the line most points map to (Bun maps leading spaces to the line before)", () => {
    // As seen on the phone: `          throw new Error(...)` — col 0 maps to the end of the line before (0-based 76).
    const real = encodeSourceMap({ sources: ["src/CrashLabScreen.tsx"], lines: [[[0, 0, 76, 95], [10, 0, 77, 12], [16, 0, 77, 18], [26, 0, 77, 28]]] }, "main.js")
    expect(symbolicate("at zn.js.anonymous(main.js:1)", real).text).toBe("at zn.js.anonymous(src/CrashLabScreen.tsx:78 (main.js:1))")
    expect(symbolicate("at anonymous (main.js:1:27)", real).text).toBe("at anonymous (src/CrashLabScreen.tsx:78:29 (main.js:1:27))")
  })

  test("lines the map doesn't cover stay; names can be rewritten", () => {
    expect(symbolicate("at y (main.js:1:1)", map).text).toBe("at y (main.js:1:1)")
    expect(symbolicate("at x (main.js:3:5)", map, (s) => `examples/sample/${s}`).text).toContain("examples/sample/src/HomeScreen.tsx:27:5")
  })

  test("the bundle label in a report", () => {
    expect(bundleIn("JS error [sample_8@1a2b3c4d5e6f] screen ...")).toEqual({ id: "sample_8", sha: "1a2b3c4d5e6f" })
    expect(bundleIn("no label here sample_8")).toBeNull()
  })
})
