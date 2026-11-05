import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { compileModule } from "../../../compiler/src/compile"
import { pressSpan, runs, span } from "../../../packages/core/src/text-spans"
import { DEFAULT_SPACING, DEFAULTS, inlineSpans, markdownRows, spacingOf } from "../src/render"

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

  test("space above (second-opinions 142): 10 between items, 16 above a heading, 6 under one, 12 around a rule, 14 otherwise", () => {
    const rows = markdownRows("a\n- b\n- c\n\n## d\ne\n\n---\n\nf\n\ng")
    expect(rows.map((r) => [r.kind, r.top])).toEqual([
      ["p", 0],
      ["li", 14],
      ["li", 10],
      ["h", 16],
      ["p", 6],
      ["hr", 12],
      ["p", 12],
      ["p", 14],
    ])
    // A numbered list right after a bullet list is a new list (14); a nested item is an item (10).
    expect(markdownRows("- a\n\n1. b\n   - c").map((r) => r.top)).toEqual([0, 14, 10])
    // A heading first has nothing above it; a heading after a rule keeps its 16.
    expect(markdownRows("# a\n\n---\n## b").map((r) => r.top)).toEqual([0, 12, 16])
  })

  test("default spacing: no spacing, {} and DEFAULT_SPACING give the same rows; marker columns 16 and 24", () => {
    const md = "# a\nb\n- c\n  - d\n\n1. e\n\n---\n> f"
    const plain = markdownRows(md, null)
    expect(markdownRows(md, null, {}, undefined, {})).toEqual(plain)
    expect(markdownRows(md, null, {}, undefined, DEFAULT_SPACING)).toEqual(plain)
    expect(plain.map((r) => [r.kind, r.top, r.indent, r.markerWidth])).toEqual([
      ["h", 0, 0, 16],
      ["p", 6, 0, 16],
      ["li", 14, 0, 16],
      ["li", 10, 16, 16],
      ["li", 14, 0, 24],
      ["hr", 12, 0, 16],
      ["quote", 12, 0, 16],
    ])
  })

  test("custom spacing reaches each row; bad values keep their default", () => {
    const sp = { blockGap: 4, itemGap: 2, headingTop: 8, headingBottom: 3, ruleGap: 5, markerWidth: 12, numberWidth: 20, indent: 10 }
    const rows = markdownRows("p\n# a\nb\n- c\n  - d\n\n1. e\n\n---\nf", null, {}, undefined, sp)
    expect(rows.map((r) => [r.kind, r.top, r.indent, r.markerWidth])).toEqual([
      ["p", 0, 0, 12],
      ["h", 8, 0, 12],
      ["p", 3, 0, 12],
      ["li", 4, 0, 12],
      ["li", 2, 10, 12],
      ["li", 4, 0, 20],
      ["hr", 5, 0, 12],
      ["p", 5, 0, 12],
    ])
    expect(spacingOf({ blockGap: -3, itemGap: Number.NaN, codePadding: "8" as unknown as number, quotePaddingY: 0 })).toEqual({
      ...DEFAULT_SPACING,
      quotePaddingY: 0,
    })
  })

  test("rows say a heading's level and whether an item is numbered (they pick the template)", () => {
    const rows = markdownRows("### a\n###### b\n1. c\n- d\np")
    expect(rows.map((r) => [r.kind, r.level, r.numbered])).toEqual([
      ["h", 3, false],
      ["h", 6, false],
      ["li", 0, true],
      ["li", 0, false],
      ["p", 0, false],
    ])
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
    // Every spacing value is a runtime padding slot on its node, not a build-time `gap` or margin.
    for (const v of ["r.top", "r.indent", "r.markerWidth", "3 + gap().quotePaddingX", "gap().quotePaddingX", "gap().quotePaddingY", "gap().codePadding"]) {
      expect(out.code).toContain(`() => (${v}), `)
    }
    // A list row is as tall as its text: the marker column has no fixed height (a height of 22 made one-line items
    // 5.5 dp taller than their text, so the gaps between items were uneven). The only fixed height is the rule line.
    expect(json.match(/"height":\d+/g)).toEqual(['"height":1'])
  })
})
