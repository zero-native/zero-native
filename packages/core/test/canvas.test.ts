import { beforeEach, describe, expect, test } from "bun:test"
import { canvasJson, draw, MAX_CANVAS_COMMANDS, resetCanvasWarnings, smoothPath, type CanvasCommand } from "../src/canvas"
import type { MotionSource } from "../src/motion"

// ARGB numbers, as core parseColor gives them.
const RED = 0xffff0000
const GREEN = 0xff00ff00
const BLUE = 0xff0000ff

const logs: string[] = []
beforeEach(() => {
  logs.length = 0
  resetCanvasWarnings()
  ;(globalThis as any).__zn_log = (_level: number, msg: string) => void logs.push(msg)
})

describe("H4: Canvas draw helpers", () => {
  test("creates shape commands", () => {
    const r = draw.rect(10, 20, 100, 50, { color: "#FF0000", style: "fill" })
    expect(r).toEqual({
      type: "rect",
      x: 10,
      y: 20,
      w: 100,
      h: 50,
      paint: { color: RED, style: "fill" },
    })

    const rr = draw.roundRect(0, 0, 80, 80, 12, { color: "#00FF00" })
    expect(rr).toEqual({
      type: "roundRect",
      x: 0,
      y: 0,
      w: 80,
      h: 80,
      r: 12,
      paint: { color: GREEN },
    })

    const c = draw.circle(50, 50, 25, { color: "#0000FF" })
    expect(c).toEqual({
      type: "circle",
      cx: 50,
      cy: 50,
      r: 25,
      paint: { color: BLUE },
    })

    const line = draw.line(0, 0, 100, 100, { strokeWidth: 2, color: "#111827" })
    expect(line).toEqual({
      type: "line",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 100,
      paint: { strokeWidth: 2, color: 0xff111827 },
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
      paint: { color: 0xfff59e0b },
    })

    const t = draw.text("Hello Canvas", 20, 30, { fontSize: 16, fontWeight: "bold", color: "#1E293B", align: "center" })
    expect(t).toEqual({
      type: "text",
      text: "Hello Canvas",
      x: 20,
      y: 30,
      options: { fontSize: 16, fontWeight: "bold", color: 0xff1e293b, align: "center" },
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

describe("H4: Canvas colours become ARGB numbers", () => {
  test("every format core accepts, with alpha in the right place", () => {
    const col = (color: string) => (draw.rect(0, 0, 1, 1, { color }) as { paint: { color: number } }).paint.color
    expect(col("#FF000080")).toBe(0x80ff0000) // #RRGGBBAA: alpha last (Color.parseColor would read #AARRGGBB)
    expect(col("#F00")).toBe(RED)
    expect(col("rgb(0, 255, 0)")).toBe(GREEN)
    expect(col("rgba(0, 0, 255, 0.5)")).toBe(0x800000ff)
    expect(col("hsl(0, 100%, 50%)")).toBe(RED)
    expect(col("transparent")).toBe(0)
    expect(col("white")).toBe(0xffffffff)
  })

  test("gradient colours are converted; numbers stay", () => {
    const r = draw.rect(0, 0, 10, 10, { linearGradient: { x0: 0, y0: 0, x1: 10, y1: 0, colors: ["#F00", BLUE] } })
    expect((r as any).paint.linearGradient.colors).toEqual([RED, BLUE])
    const c = draw.circle(5, 5, 5, { radialGradient: { cx: 5, cy: 5, r: 5, colors: ["red", "blue"], stops: [0, 1] } })
    expect((c as any).paint.radialGradient).toEqual({ cx: 5, cy: 5, r: 5, colors: [RED, BLUE], stops: [0, 1] })
  })

  test("a bad colour is black with one warning naming the command", () => {
    const r = draw.rect(0, 0, 1, 1, { color: "#12" })
    expect((r as any).paint.color).toBe(0xff000000)
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain("rect color")
  })

  test("canvasJson converts hand-written objects without changing them", () => {
    const hand: CanvasCommand[] = [
      { type: "rect", x: 0, y: 0, w: 10, h: 10, paint: { color: "#FF000080" } },
      { type: "text", text: "a", x: 0, y: 10, options: { color: "rgb(0, 255, 0)" } },
    ]
    const json = JSON.parse(canvasJson(hand))
    expect(json[0].paint.color).toBe(0x80ff0000)
    expect(json[1].options.color).toBe(GREEN)
    expect((hand[0] as any).paint.color).toBe("#FF000080") // the author's object is not changed
    expect(logs).toEqual([])
  })

  test("canvasJson keeps helper output as is and passes strings through", () => {
    const list = [draw.rect(0, 0, 10, 10, { color: "#F00" }), null, false, draw.save(), draw.restore()]
    expect(canvasJson(list)).toBe(JSON.stringify(list))
    expect(canvasJson('[{"type":"save"}]')).toBe('[{"type":"save"}]')
    expect(canvasJson(null)).toBe("[]")
    expect(canvasJson(undefined)).toBe("[]")
    expect(logs).toEqual([])
  })
})

describe("H4: Canvas validation warnings", () => {
  test("non-finite numbers name the index and field", () => {
    canvasJson([draw.rect(0, 0, 10, 10), draw.circle(NaN, 5, 5), draw.line(0, 0, Infinity, 0)])
    expect(logs).toEqual([
      "Canvas: command 1 (circle).cx must be a finite number; skipped",
      "Canvas: command 2 (line).x2 must be a finite number; skipped",
    ])
  })

  test("a gradient with under 2 colours, and stops that don't match", () => {
    canvasJson([
      draw.rect(0, 0, 10, 10, { linearGradient: { x0: 0, y0: 0, x1: 10, y1: 0, colors: ["#F00"] } }),
      draw.rect(0, 0, 10, 10, { linearGradient: { x0: 0, y0: 0, x1: 10, y1: 0, colors: [RED, BLUE], stops: [0, 0.5, 1] } }),
    ])
    expect(logs.length).toBe(2)
    expect(logs[0]).toContain("command 0 (rect) linearGradient needs at least 2 colours, has 1")
    expect(logs[1]).toContain("command 1 (rect) linearGradient.stops")
  })

  test("dash: odd length, negative and all zero", () => {
    canvasJson([
      draw.line(0, 0, 10, 0, { dash: [4] }),
      draw.line(0, 0, 10, 0, { dash: [4, -1] }),
      draw.line(0, 0, 10, 0, { dash: [0, 0] }),
      draw.line(0, 0, 10, 0, { dash: [4, 4] }),
    ])
    expect(logs.length).toBe(3)
    expect(logs[0]).toContain("command 0 (line) dash")
    expect(logs[1]).toContain("command 1 (line) dash")
    expect(logs[2]).toContain("command 2 (line) dash")
  })

  test("unknown type and a missing path d", () => {
    canvasJson([{ type: "blob" } as unknown as CanvasCommand, { type: "path" } as unknown as CanvasCommand])
    expect(logs).toEqual(['Canvas: command 0: unknown type "blob"; skipped', "Canvas: command 1 (path).d must be a string; skipped"])
  })

  test("the cap: exactly 10,000 is sent, 10,001 is refused with a warning", () => {
    const ok = Array.from({ length: MAX_CANVAS_COMMANDS }, () => draw.save())
    expect(JSON.parse(canvasJson(ok)).length).toBe(MAX_CANVAS_COMMANDS)
    expect(logs).toEqual([])
    const over = Array.from({ length: MAX_CANVAS_COMMANDS + 1 }, () => draw.save())
    expect(canvasJson(over)).toBe("[]")
    expect(logs.length).toBe(1)
    expect(logs[0]).toContain("10001 commands")
  })

  test("the same warning is logged once, not on every update", () => {
    for (let i = 0; i < 5; i++) canvasJson([draw.line(0, 0, 10, 0, { dash: [4] })])
    expect(logs.length).toBe(1)
  })
})

// A stand-in for a motion value (useMotion, pan.touchX, v.map(...)): canvas only reads its __znMotion id.
const motion = (id: number) => Object.assign(() => 0, { __znMotion: id }) as unknown as MotionSource
const motionColor = (id: number) => ({ __znMotion: id, __znColor: true as const })

describe("C1: motion values in Canvas commands", () => {
  test("numbers, paint colour, opacity and strokeWidth are sent as references", () => {
    const x = motion(301)
    const list = [
      draw.circle(x, 20, 4, { color: motionColor(302), opacity: motion(303), strokeWidth: motion(304), style: "stroke" }),
      draw.arc(0, 0, 100, 100, -90, motion(305), false, { color: "#F00" }),
      draw.text("a", x, 10, { color: motionColor(306) }),
    ]
    expect((list[0] as any).cx).toBe(x) // the helper keeps the value; canvasJson turns it into a reference
    const json = JSON.parse(canvasJson(list))
    expect(json[0].cx).toBe("\u0000m301")
    expect(json[0].paint).toEqual({ color: "\u0000m302", opacity: "\u0000m303", strokeWidth: "\u0000m304", style: "stroke" })
    expect(json[1].sweep).toBe("\u0000m305")
    expect(json[1].paint.color).toBe(RED)
    expect(json[2].x).toBe("\u0000m301")
    expect(json[2].options.color).toBe("\u0000m306")
    expect(logs).toEqual([])
  })

  test("path trims may move", () => {
    const end = motion(310)
    const c = draw.path("M 0 0 L 10 0", { style: "stroke" }, { trimStart: 0, trimEnd: end })
    expect(c).toEqual({ type: "path", d: "M 0 0 L 10 0", paint: { style: "stroke" }, trimStart: 0, trimEnd: end })
    expect(JSON.parse(canvasJson([c]))[0].trimEnd).toBe("\u0000m310")
    expect(draw.path("M 0 0")).toEqual({ type: "path", d: "M 0 0", paint: undefined })
    canvasJson([draw.path("M 0 0", undefined, { trimOffset: NaN })])
    expect(logs).toEqual(["Canvas: command 0 (path).trimOffset must be a finite number; skipped"])
  })

  test("a motion value where none is allowed is warned about", () => {
    const m = motion(320) as any
    canvasJson([
      draw.rect(0, 0, 10, 10, { linearGradient: { x0: m, y0: 0, x1: 10, y1: 0, colors: [RED, BLUE] } }),
      draw.line(0, 0, 10, 0, { dash: [m, 4] }),
      draw.paragraph("a", 0, 0, m),
      draw.text("a", 0, 0, { fontSize: m }),
    ])
    expect(logs.length).toBe(4)
    expect(logs[0]).toContain("command 0 (rect) linearGradient.x0 can't be a motion value")
    expect(logs[1]).toContain("command 1 (line) dash")
    expect(logs[2]).toContain("command 2 (paragraph).width can't be a motion value")
    expect(logs[3]).toContain("command 3 (text) fontSize")
  })

  test("a list without motion values is the same JSON as before", () => {
    const list = [draw.rect(0, 0, 10, 10, { color: "#F00", strokeWidth: 2, opacity: 0.5 })]
    expect(canvasJson(list)).toBe(JSON.stringify(list))
  })
})

describe("C4-C7: new commands", () => {
  test("paragraph, image and clips", () => {
    expect(draw.paragraph("Hi", 10, 20, 100, { fontSize: 12, color: "#F00", maxLines: 2 })).toEqual({
      type: "paragraph",
      text: "Hi",
      x: 10,
      y: 20,
      width: 100,
      options: { fontSize: 12, color: RED, maxLines: 2 },
    })
    expect(draw.image("asset:images/a.png", 0, 0, 80, 40, { fit: "contain", radius: 8 })).toEqual({
      type: "image",
      src: "asset:images/a.png",
      x: 0,
      y: 0,
      w: 80,
      h: 40,
      options: { fit: "contain", radius: 8 },
    })
    expect(draw.clipRect(0, 0, 10, 10, { op: "difference" })).toEqual({ type: "clipRect", x: 0, y: 0, w: 10, h: 10, op: "difference" })
    expect(draw.clipRoundRect(0, 0, 10, 10, 4)).toEqual({ type: "clipRoundRect", x: 0, y: 0, w: 10, h: 10, r: 4 })
    expect(draw.clipPath("M 0 0 L 10 0 Z", { op: "difference", fillType: "evenOdd" })).toEqual({
      type: "clipPath",
      d: "M 0 0 L 10 0 Z",
      op: "difference",
      fillType: "evenOdd",
    })
    expect(logs).toEqual([])
  })

  test("paint effects: colours become ARGB numbers", () => {
    const r = draw.rect(0, 0, 10, 10, {
      sweepGradient: { cx: 5, cy: 5, colors: ["#F00", "#00F"], startAngle: -90 },
      shadow: { dx: 0, dy: 2, blur: 6, color: "#F00" },
      blendMode: "multiply",
      blur: 2,
    }) as any
    expect(r.paint.sweepGradient.colors).toEqual([RED, BLUE])
    expect(r.paint.shadow).toEqual({ dx: 0, dy: 2, blur: 6, color: RED })
    canvasJson([r])
    expect(logs).toEqual([])
  })

  test("bad new commands are warned about", () => {
    canvasJson([
      { type: "image", x: 0, y: 0, w: 1, h: 1 } as unknown as CanvasCommand,
      { type: "clipRect", x: 0, y: 0, w: 1, h: 1, op: "union" } as unknown as CanvasCommand,
      draw.rect(0, 0, 1, 1, { blendMode: "hue" as any }),
      draw.rect(0, 0, 1, 1, { sweepGradient: { cx: 0, cy: 0, colors: [RED] } }),
      draw.paragraph("a", 0, 0, 10, { maxLines: 0 }),
    ])
    expect(logs.length).toBe(5)
    expect(logs[0]).toContain("command 0 (image).src")
    expect(logs[1]).toContain("command 1 (clipRect).op")
    expect(logs[2]).toContain('command 2 (rect) blendMode "hue"')
    expect(logs[3]).toContain("command 3 (rect) sweepGradient needs at least 2 colours")
    expect(logs[4]).toContain("command 4 (paragraph) maxLines")
  })
})

describe("C8: polyline and smoothPath", () => {
  test("polyline is a path through the points, nested or flat", () => {
    expect(draw.polyline([[0, 0], [10, 5], [20, 0]], { style: "stroke" })).toEqual({
      type: "path",
      d: "M 0 0 L 10 5 L 20 0",
      paint: { style: "stroke" },
    })
    expect((draw.polyline([0, 0, 10, 5]) as any).d).toBe("M 0 0 L 10 5")
  })

  test("smoothPath: empty, one point, and the same curve for both point forms", () => {
    expect(smoothPath([])).toBe("")
    expect(smoothPath([[3, 4]])).toBe("M 3 4")
    expect(smoothPath([[0, 0], [10, 10]])).toBe("M 0 0 C 3.33 3.33 6.67 6.67 10 10")
    expect(smoothPath([0, 0, 10, 20, 20, 5])).toBe(smoothPath([[0, 0], [10, 20], [20, 5]]))
  })

  test("smoothPath never overshoots: control points stay between the points they join", () => {
    const pts: [number, number][] = [[0, 50], [10, 10], [20, 10], [30, 90], [40, 85], [50, 0], [60, 0]]
    const nums = smoothPath(pts).replace(/[MC]/g, " ").trim().split(/\s+/).map(Number)
    // After "M x y", each C has 6 numbers: c1x c1y c2x c2y x y.
    for (let i = 0; i < pts.length - 1; i++) {
      const y0 = pts[i][1]
      const y1 = pts[i + 1][1]
      const c = nums.slice(2 + i * 6, 2 + i * 6 + 6)
      const lo = Math.min(y0, y1) - 1e-9
      const hi = Math.max(y0, y1) + 1e-9
      expect(c[1] >= lo && c[1] <= hi).toBe(true)
      expect(c[3] >= lo && c[3] <= hi).toBe(true)
    }
  })

  test("points that aren't finite are left out with one warning", () => {
    expect(smoothPath([[0, 0], [NaN, 3], [10, 0]])).toBe(smoothPath([[0, 0], [10, 0]]))
    expect(logs).toEqual(["Canvas: smoothPath: points that aren't finite numbers are left out"])
  })
})
