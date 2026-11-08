import { describe, expect, test } from "bun:test"
import { el, event, parseColor, slot, writeTemplateFile } from "../src"
import { Component, Prop } from "../src/registry"

/** Minimal reader following the format comment in src/writer.ts (the Kotlin reader is tested separately). */
function read(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = 0
  const u8 = () => v.getUint8(p++)
  const u16 = () => ((p += 2), v.getUint16(p - 2, true))
  const u32 = () => ((p += 4), v.getUint32(p - 4, true))
  const f64 = () => ((p += 8), v.getFloat64(p - 8, true))
  const value = () => {
    const k = u8()
    if (k === 0) return null
    if (k === 1) return false
    if (k === 2) return true
    if (k === 3) return f64()
    if (k === 4) return { str: u32() }
    if (k === 5) return { argb: u32() }
    if (k === 6) return { percent: f64() }
    if (k === 7) return { enum: u16() }
    throw new Error(`kind ${k}`)
  }
  const magic = u32()
  const format = u16()
  const registry = u16()
  const strings: string[] = []
  for (let i = u32(); i > 0; i--) {
    const n = u32()
    strings.push(new TextDecoder().decode(bytes.slice(p, p + n)))
    p += n
  }
  const templates = []
  for (let t = u16(); t > 0; t--) {
    const nodes = []
    for (let n = u16(); n > 0; n--) {
      const component = u16()
      const parent = u16()
      const props: Record<number, unknown> = {}
      for (let c = u8(); c > 0; c--) props[u16()] = value()
      nodes.push({ component, parent, props })
    }
    const slots = []
    for (let s = u16(); s > 0; s--) slots.push({ node: u16(), prop: u16(), def: value() })
    const events = []
    for (let e = u16(); e > 0; e--) events.push({ node: u16(), kind: u16(), id: u16() })
    templates.push({ nodes, slots, events })
  }
  return { magic, format, registry, strings, templates, rest: bytes.length - p }
}

describe("writeTemplateFile", () => {
  test("encodes nodes in tree order with static props, slots and events", () => {
    const { bytes, ids } = writeTemplateFile([
      el(
        "Column",
        { style: { padding: 24, gap: 16, backgroundColor: "#F8FAFC" }, alignItems: "stretch" },
        el("Text", { text: slot("ticks", "…"), fontSize: 18, color: "#0F172A" }),
        el("Pressable", { onPress: event("tap"), style: { width: "100%" } }, el("Text", { text: "Tap" })),
      ),
    ])
    const f = read(bytes)
    expect(f.magic).toBe(0x49554e5a)
    expect(f.format).toBe(1)
    expect(f.rest).toBe(0)

    const t = f.templates[0]
    expect(t.nodes.map((n) => [n.component, n.parent])).toEqual([
      [Component.Column, 0xffff],
      [Component.Text, 0],
      [Component.Pressable, 0],
      [Component.Text, 2],
    ])
    expect(t.nodes[0].props[Prop.padding.id]).toBe(24)
    expect(t.nodes[0].props[Prop.backgroundColor.id]).toEqual({ argb: 0xfff8fafc })
    expect(t.nodes[0].props[Prop.alignItems.id]).toEqual({ enum: 3 })
    expect(t.nodes[2].props[Prop.width.id]).toEqual({ percent: 1 })
    // The slot-bound text is not a static prop; it is a slot with a default.
    expect(t.nodes[1].props[Prop.text.id]).toBeUndefined()
    expect(t.slots).toEqual([{ node: 1, prop: Prop.text.id, def: { str: f.strings.indexOf("…") } }])
    expect(t.events).toEqual([{ node: 2, kind: 1, id: 1 }])
    expect(ids[0]).toEqual({ slots: { ticks: 0 }, events: { tap: 1 } })
  })

  test("rejects unknown props, bad values and props that can't be dynamic", () => {
    expect(() => writeTemplateFile([el("Row", { flexDirection: "row" } as any)])).toThrow(/unknown prop/)
    expect(() => writeTemplateFile([el("Row", { justifyContent: "middle" as any })])).toThrow(/needs one of/)
    expect(() => writeTemplateFile([el("Row", { style: { width: "wide" } })])).toThrow(/number \(dp\) or "N%"/)
    expect(() => writeTemplateFile([el("Row", { style: { padding: slot("p", 4) } })])).toThrow(/can't change/)
    expect(() => writeTemplateFile([el("Row", { style: { backgroundColor: "reddish" } })])).toThrow(/invalid colour/)
  })

  test("rejects a slot name used twice", () => {
    expect(() =>
      writeTemplateFile([el("Column", {}, el("Text", { text: slot("a", "") }), el("Text", { text: slot("a", "") }))]),
    ).toThrow(/used twice/)
  })

  test("Text onPress and List horizontal require registry 23", () => {
    const tText = writeTemplateFile([el("Text", { onPress: event("tap") })])
    expect(read(tText.bytes).registry).toBe(23)
    const tList = writeTemplateFile([el("List", { horizontal: true })])
    expect(read(tList.bytes).registry).toBe(23)
  })
})

describe("parseColor", () => {
  test("RN colour forms become ARGB", () => {
    expect(parseColor("#fff")).toBe(0xffffffff)
    expect(parseColor("#3D26ED")).toBe(0xff3d26ed)
    expect(parseColor("#3D26ED80")).toBe(0x803d26ed)
    expect(parseColor("#0008")).toBe(0x88000000)
    expect(parseColor("transparent")).toBe(0)
    expect(parseColor("rgb(61, 38, 237)")).toBe(0xff3d26ed)
    expect(parseColor("rgba(0,0,0,0.85)")).toBe(0xd9000000)
    expect(parseColor("rgba(0, 0, 0, 30%)")).toBe(0x4d000000)
    expect(() => parseColor("rgba(300,0,0,1)")).toThrow(/channels 0–255/)
    // CSS colour names and hsl() (RN-compat sweep P1.3, 2026-11-05).
    expect(parseColor("red")).toBe(0xffff0000)
    expect(parseColor("White")).toBe(0xffffffff)
    expect(parseColor("rebeccapurple")).toBe(0xff663399)
    expect(parseColor("hsl(0, 100%, 50%)")).toBe(0xffff0000)
    expect(parseColor("hsl(120, 100%, 25%)")).toBe(0xff008000)
    expect(parseColor("hsla(240, 100%, 50%, 0.5)")).toBe(0x800000ff)
    expect(parseColor("hsl(200deg, 50%, 50%)")).toBe(0xff4095bf)
    expect(() => parseColor("hsl(0, 120%, 50%)")).toThrow(/saturation and lightness/)
    expect(() => parseColor("reddish")).toThrow(/invalid colour/)
  })
})
