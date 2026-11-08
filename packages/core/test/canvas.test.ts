import { describe, expect, test } from "bun:test"
import { draw } from "../src/canvas"

describe("H4: Canvas draw helpers", () => {
  test("creates shape commands", () => {
    const r = draw.rect(10, 20, 100, 50, { color: "#FF0000", style: "fill" })
    expect(r).toEqual({
      type: "rect",
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      paint: { color: "#FF0000", style: "fill" },
    })

    const rr = draw.roundRect(0, 0, 80, 80, 12, { color: "#00FF00" })
    expect(rr).toEqual({
      type: "roundRect",
      x: 0,
      y: 0,
      w: 80,
      h: 80,
      r: 12,
      paint: { color: "#00FF00" },
    })

    const c = draw.circle(50, 50, 25, { color: "#0000FF" })
    expect(c).toEqual({
      type: "circle",
      cx: 50,
      cy: 50,
      r: 25,
      paint: { color: "#0000FF" },
    })

    const line = draw.line(0, 0, 100, 100, { strokeWidth: 2, color: "#111827" })
    expect(line).toEqual({
      type: "line",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 100,
      paint: { strokeWidth: 2, color: "#111827" },
    })

    const arc = draw.arc(10, 10, 80, 80, 0, 180, true)
    expect(arc).toEqual({
      type: "arc",
      x: 10,
      y: 10,
      w: 80,
      h: 80,
      start: 0,
      sweep: 180,
      useCenter: true,
      paint: undefined,
    })
  })

  test("creates path and text commands", () => {
    const p = draw.path("M 0 0 L 100 100 Z", { color: "#F59E0B" })
    expect(p).toEqual({
      type: "path",
      d: "M 0 0 L 100 100 Z",
      paint: { color: "#F59E0B" },
    })

    const t = draw.text("Hello Canvas", 20, 30, { fontSize: 16, fontWeight: "bold", color: "#1E293B", align: "center" })
    expect(t).toEqual({
      type: "text",
      text: "Hello Canvas",
      x: 20,
      y: 30,
      options: { fontSize: 16, fontWeight: "bold", color: "#1E293B", align: "center" },
    })
  })

  test("creates matrix and clip commands", () => {
    expect(draw.save()).toEqual({ type: "save" })
    expect(draw.restore()).toEqual({ type: "restore" })
    expect(draw.translate(10, 20)).toEqual({ type: "translate", dx: 10, dy: 20 })
    expect(draw.scale(2, 2)).toEqual({ type: "scale", sx: 2, sy: 2 })
    expect(draw.rotate(45, 50, 50)).toEqual({ type: "rotate", degrees: 45, px: 50, py: 50 })
    expect(draw.clipRect(0, 0, 100, 100)).toEqual({ type: "clipRect", x: 0, y: 0, w: 100, h: 100 })
  })
})
