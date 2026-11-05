import { describe, expect, test } from "bun:test"
import { Enum } from "../../template/src/registry"
import { pressSpan, runs, span, SPAN_DECORATION, SPAN_FONT_STYLE } from "../src/text-spans"

describe("runtime text spans (registry 16)", () => {
  test("text, spans from .map and nested spans flatten to runs of one style each", () => {
    const parts = [{ text: "Pay ", bold: false }, { text: "₹400", bold: true }, { text: " now", bold: false }]
    const r = runs(["Hi ", parts.map((p) => span([p.bold ? { fontWeight: "bold", color: "#047857" } : null], undefined, [p.text]))])
    // "Hi " and "Pay " have different span objects (outer {} vs the first span's style), so they stay two runs.
    expect(r.text.split("\u001f")).toEqual(["Hi ", "Pay ", "₹400", " now"])
    expect(JSON.parse(r.spans)).toEqual([{}, {}, { fontWeight: 700, color: 0xff047857 }, {}])
    expect(r.press).toEqual([null, null, null, null])
  })

  test("styles inherit and merge; RN style arrays, falsy entries; unknown keys dropped", () => {
    const r = runs([span([{ fontStyle: "italic" }, false, [{ color: "red" }]], undefined, ["a", span({ textDecorationLine: "underline", padding: 4 }, undefined, ["b"])])])
    expect(JSON.parse(r.spans)).toEqual([{ fontStyle: 1, color: 0xffff0000 }, { fontStyle: 1, color: 0xffff0000, textDecorationLine: 1 }])
  })

  test("null, undefined and booleans show nothing; numbers show; same span merges", () => {
    const s = span(null, undefined, ["a", null, 1, false, true, undefined, "b"])
    const r = runs([s])
    expect(r.text).toBe("a1b")
    expect(JSON.parse(r.spans)).toEqual([{}])
  })

  test("onPress marks the span (p: 1); pressSpan runs the handler at that index; children inherit it", () => {
    const hits: string[] = []
    const r = runs(["By continuing you agree to ", span({ color: "#3D26ED" }, () => hits.push("terms"), ["Terms ", span({ fontWeight: 700 }, undefined, ["now"])])])
    expect(r.text.split("\u001f")).toEqual(["By continuing you agree to ", "Terms ", "now"])
    expect(JSON.parse(r.spans)).toEqual([{}, { color: 0xff3d26ed, p: 1 }, { color: 0xff3d26ed, fontWeight: 700, p: 1 }])
    pressSpan(r, 2)
    pressSpan(r, 0) // no handler: nothing
    pressSpan(r, 9) // out of range: nothing
    pressSpan(r, "x")
    expect(hits).toEqual(["terms"])
  })

  test("enum numbers match the registry", () => {
    expect(SPAN_FONT_STYLE).toEqual({ ...Enum.fontStyle })
    expect(SPAN_DECORATION).toEqual({ ...Enum.textDecorationLine })
  })
})
