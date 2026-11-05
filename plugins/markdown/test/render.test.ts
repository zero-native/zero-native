import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { compileModule } from "../../../compiler/src/compile"
import { pressSpan, runs, span } from "../../../packages/core/src/text-spans"
import { DEFAULTS, inlineSpans, markdownRows } from "../src/render"

describe("rows and span styles", () => {
  test("each block gets its spans' styles: body, then the element, then the app's", () => {
    const rows = markdownRows("# Hi\nGet **₹400** at [Ravi](https://x.in)", { color: "#111111" }, { strong: { color: "#047857" } })
    expect(rows.map((r) => [r.kind, r.top])).toEqual([
      ["h", 0],
      ["p", 6],
    ])
    expect(rows[0].spans[0].style).toEqual([DEFAULTS.text, { color: "#111111" }, DEFAULTS.h1, undefined])
    const [plain, bold, , link] = rows[1].spans
    expect(plain).toEqual({ text: "Get ", style: [DEFAULTS.text, { color: "#111111" }] })
    expect(bold.style).toEqual([DEFAULTS.text, { color: "#111111" }, DEFAULTS.strong, { color: "#047857" }])
    expect(link).toEqual({ text: "Ravi", href: "https://x.in", style: [DEFAULTS.text, { color: "#111111" }, DEFAULTS.link, undefined] })
  })

  test("space above: 4 between items, 14 above a heading, 6 under one, 10 otherwise", () => {
    const rows = markdownRows("a\n- b\n- c\n\n## d\ne\n\n---")
    expect(rows.map((r) => [r.kind, r.top])).toEqual([
      ["p", 0],
      ["li", 10],
      ["li", 4],
      ["h", 14],
      ["p", 6],
      ["hr", 10],
    ])
    // A numbered list right after a bullet list is a new list (10); a nested item stays close (4).
    expect(markdownRows("- a\n\n1. b\n   - c").map((r) => r.top)).toEqual([0, 10, 4])
  })

  test("bold keeps the body colour unless the app gives styles.strong.color", () => {
    const [, bold] = markdownRows("a **b**", { color: "#047857" })[0].spans
    expect(bold.style).toEqual([DEFAULTS.text, { color: "#047857" }, { fontWeight: 700 }, undefined])
  })

  test("list items: indent 16 per depth, the marker has its own style", () => {
    const rows = markdownRows("1. a\n   - b", null, { marker: { color: "#FF0000" } })
    expect(rows.map((r) => [r.markerText, r.indent])).toEqual([
      ["1.", 0],
      ["◦", 16],
    ])
    expect(rows[0].marker).toEqual([DEFAULTS.text, null, DEFAULTS.marker, { color: "#FF0000" }])
  })

  test("the runtime turns the styles into native span JSON (the keys native reads)", () => {
    const sp = inlineSpans("a **b** [c](https://x.in)", { fontSize: 16 })
    const r = runs(sp.map((s) => span(s.style, s.href ? () => {} : undefined, [s.text])))
    expect(r.text).toBe("a \u001fb\u001f \u001fc")
    expect(JSON.parse(r.spans)).toEqual([
      { color: 0xff374151, fontSize: 16 },
      { color: 0xff374151, fontSize: 16, fontWeight: 700 },
      { color: 0xff374151, fontSize: 16 },
      { color: 0xff1d4ed8, fontSize: 16, fontWeight: 600, textDecorationLine: 1, p: 1 },
    ])
  })

  test("a link tap gives the app the url and the link's text", () => {
    const got: string[] = []
    const onLinkPress = (url: string, text: string) => got.push(`${url}|${text}`)
    const sp = inlineSpans("go [here](https://x.in/a)")
    const r = runs(sp.map((s) => span(s.style, s.href !== undefined ? () => onLinkPress(s.href!, s.text) : undefined, [s.text])))
    pressSpan(r, 1)
    pressSpan(r, 0) // not a link: nothing
    expect(got).toEqual(["https://x.in/a|here"])
  })
})

describe("compile", () => {
  test("Markdown.tsx compiles: Markdown and MarkdownText, runtime spans with onSpanPress, no WebView", () => {
    const path = join(import.meta.dir, "../src/Markdown.tsx")
    const templates: unknown[] = []
    const views: string[] = []
    const out = compileModule(readFileSync(path, "utf8"), path, {
      reserveTemplate: () => templates.push(null) - 1,
      defineTemplate: (id, spec) => void (templates[id] = spec),
      nativeView: (name) => void views.push(name),
    })
    expect(Object.keys(out.components).sort()).toEqual(["Markdown", "MarkdownText"])
    expect(views).toEqual([])
    const json = JSON.stringify(templates)
    expect(json).toContain('"spans":{"$slot"')
    expect(json).toContain('"onSpanPress":{"$event"')
    expect(json).not.toContain("NativeView")
    // The rows are a keyed list; every block's text is runtime spans.
    expect(out.code).toContain("__zn.each(")
    expect(out.code.match(/__zn\.runs\(/g)?.length).toBeGreaterThanOrEqual(10)
  })
})
