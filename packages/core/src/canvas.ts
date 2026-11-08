// <Canvas> commands (registry 23; native ZnCanvas.kt). Build them with the `draw.*` helpers:
//   <Canvas style={{ width: 300, height: 120 }} commands={[draw.rect(0, 0, 300, 120, { color: "#F1F5F9" }), ...]} />
// Units are dp. Colours are turned into ARGB numbers here (core's parseColor), because native never parses colour
// strings. `canvasJson` also does this for hand-written command objects and checks the list (finite numbers,
// gradients, dash, the 10,000 cap) with a warning naming the command index. Native checks again and never crashes.
// A command's numbers (and paint colour, opacity, strokeWidth) may be motion values (docs/motion.md): they are sent as
// "\u0000m<id>" (as motion.ts viewPropsJson does) and native reads them in the draw phase, so they move with no JS.
import { parseColor } from "./color"
import type { MotionColor, MotionSource } from "./motion"

/** A colour string ("#RRGGBB", "rgba(...)", "hsl(...)", a CSS name) or an ARGB number. */
export type CanvasColor = string | number

/** A number, or a motion value (useMotion, pan.touchX, v.map(...), derive(...)) that native reads on each draw. */
export type CanvasNum = number | MotionSource

/** A colour, or a motion colour (v.mapColor(...), a derive ending in interpolateColor). */
export type CanvasColorValue = CanvasColor | MotionColor | MotionSource

export interface CanvasLinearGradient {
  x0: number
  y0: number
  x1: number
  y1: number
  /** At least 2 colours. */
  colors: CanvasColor[]
  /** One stop (0 to 1) per colour; left out when the counts don't match. */
  stops?: number[]
}

export interface CanvasRadialGradient {
  cx: number
  cy: number
  r: number
  /** At least 2 colours. */
  colors: CanvasColor[]
  stops?: number[]
}

/** Colours round a centre (a gradient ring). 0° is 3 o'clock, clockwise; `startAngle` turns where it starts. */
export interface CanvasSweepGradient {
  cx: number
  cy: number
  /** At least 2 colours. */
  colors: CanvasColor[]
  stops?: number[]
  startAngle?: number
}

export interface CanvasShadow {
  dx: number
  dy: number
  blur: number
  color: CanvasColor
}

/** How a shape mixes with what this canvas drew before it (Compose BlendMode names). */
export type CanvasBlendMode =
  | "srcOver"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "plus"
  | "clear"
  | "srcIn"
  | "srcOut"
  | "srcAtop"
  | "dstIn"
  | "dstOut"
  | "dstOver"
  | "dstAtop"
  | "xor"

export interface CanvasPaint {
  color?: CanvasColorValue
  style?: "fill" | "stroke"
  strokeWidth?: CanvasNum
  strokeCap?: "butt" | "round" | "square"
  strokeJoin?: "miter" | "round" | "bevel"
  /** On and off lengths in dp: an even count (2, 4, ...), each ≥ 0. */
  dash?: number[]
  opacity?: CanvasNum
  linearGradient?: CanvasLinearGradient
  radialGradient?: CanvasRadialGradient
  sweepGradient?: CanvasSweepGradient
  /** Paths only: which parts of a shape that crosses itself are inside. Default "nonZero". */
  fillType?: "nonZero" | "evenOdd"
  blendMode?: CanvasBlendMode
  /** Shapes on Android 9+ (text has no paint). Below Android 9 shapes draw without it. */
  shadow?: CanvasShadow
  /** Blur radius in dp (soft edges, a glow). Android 9+; below, the shape draws sharp. */
  blur?: number
}

export interface CanvasTextOptions {
  fontSize?: number
  fontWeight?: number | "normal" | "bold"
  color?: CanvasColorValue
  align?: "left" | "center" | "right"
}

export interface CanvasParagraphOptions extends CanvasTextOptions {
  /** dp from one line's top to the next. Default: the font's own. */
  lineHeight?: number
  /** Lines after this are cut, the last one ends with "…". */
  maxLines?: number
}

export interface CanvasImageOptions {
  /** "cover" (default): fills the box, cut to fit. "contain": all of it shows. "fill": stretched. */
  fit?: "cover" | "contain" | "fill"
  radius?: CanvasNum
  opacity?: CanvasNum
}

/** A path's visible piece (0 to 1 of its length), like <Svg> trims. */
export interface CanvasPathOptions {
  trimStart?: CanvasNum
  trimEnd?: CanvasNum
  trimOffset?: CanvasNum
}

export type CanvasClipOp = "intersect" | "difference"

export type CanvasCommand =
  | { type: "rect"; x: CanvasNum; y: CanvasNum; w: CanvasNum; h: CanvasNum; paint?: CanvasPaint }
  | { type: "roundRect"; x: CanvasNum; y: CanvasNum; w: CanvasNum; h: CanvasNum; r: CanvasNum; paint?: CanvasPaint }
  | { type: "circle"; cx: CanvasNum; cy: CanvasNum; r: CanvasNum; paint?: CanvasPaint }
  | { type: "oval"; x: CanvasNum; y: CanvasNum; w: CanvasNum; h: CanvasNum; paint?: CanvasPaint }
  | { type: "line"; x1: CanvasNum; y1: CanvasNum; x2: CanvasNum; y2: CanvasNum; paint?: CanvasPaint }
  | { type: "arc"; x: CanvasNum; y: CanvasNum; w: CanvasNum; h: CanvasNum; start: CanvasNum; sweep: CanvasNum; useCenter?: boolean; paint?: CanvasPaint }
  | { type: "path"; d: string; paint?: CanvasPaint; trimStart?: CanvasNum; trimEnd?: CanvasNum; trimOffset?: CanvasNum }
  | { type: "text"; text: string; x: CanvasNum; y: CanvasNum; options?: CanvasTextOptions }
  | { type: "paragraph"; text: string; x: CanvasNum; y: CanvasNum; width: number; options?: CanvasParagraphOptions }
  | { type: "image"; src: string; x: CanvasNum; y: CanvasNum; w: CanvasNum; h: CanvasNum; options?: CanvasImageOptions }
  | { type: "save" }
  | { type: "restore" }
  | { type: "translate"; dx: CanvasNum; dy: CanvasNum }
  | { type: "scale"; sx: CanvasNum; sy?: CanvasNum }
  | { type: "rotate"; degrees: CanvasNum; px?: CanvasNum; py?: CanvasNum }
  | { type: "clipRect"; x: CanvasNum; y: CanvasNum; w: CanvasNum; h: CanvasNum; op?: CanvasClipOp }
  | { type: "clipRoundRect"; x: CanvasNum; y: CanvasNum; w: CanvasNum; h: CanvasNum; r: CanvasNum; op?: CanvasClipOp }
  | { type: "clipPath"; d: string; op?: CanvasClipOp; fillType?: "nonZero" | "evenOdd" }

/** An entry of a command list: `null`, `undefined` and `false` are skipped (`[a, cond && draw.circle(...)]`). */
export type CanvasEntry = CanvasCommand | null | undefined | false

/** Points for polyline / smoothPath: `[[x, y], ...]` or flat `[x0, y0, x1, y1, ...]`. */
export type CanvasPoints = readonly (readonly [number, number])[] | readonly number[]

/** Same as native ZnCanvas.kt MAX_CANVAS_COMMANDS: over this, nothing is drawn. */
export const MAX_CANVAS_COMMANDS = 10000

const BLACK = 0xff000000
const REF = "\u0000m"

// Warnings are logged once per message, so a list that updates every frame doesn't flood the log.
const warned = new Set<string>()
function warn(message: string): void {
  if (warned.has(message)) return
  if (warned.size < 200) warned.add(message)
  globalThis.__zn_log?.(2, `Canvas: ${message}`)
}

/** For tests: forget which warnings were logged. */
export function resetCanvasWarnings(): void {
  warned.clear()
}

/** A motion value, mapping, formula or motion colour (motion.ts isSource: it is not exported, so the same test here). */
function isMotion(v: unknown): v is { __znMotion: number } {
  return (typeof v === "function" || typeof v === "object") && v !== null && typeof (v as { __znMotion?: unknown }).__znMotion === "number"
}

function argb(c: CanvasColorValue, where: string): number | MotionColor | MotionSource {
  if (typeof c === "number" || isMotion(c)) return c
  try {
    return parseColor(String(c))
  } catch (e) {
    warn(`${where}: ${e instanceof Error ? e.message : String(e)}; black is used`)
    return BLACK
  }
}

function gradientOut<G extends { colors: CanvasColor[] }>(g: G, where: string): G {
  if (!Array.isArray(g.colors) || !g.colors.some((c) => typeof c !== "number")) return g
  // A motion value in a gradient stays as it is here: check() warns, and native draws it black.
  return { ...g, colors: g.colors.map((c, i) => (isMotion(c) ? c : argb(c, `${where} colour ${i}`))) }
}

/** [paint] with its colours as ARGB numbers. Returns the same object when nothing needs to change. */
function paintOut(paint: CanvasPaint | undefined, where: string): CanvasPaint | undefined {
  if (paint == null || typeof paint !== "object") return paint
  const needsColor = paint.color !== undefined && typeof paint.color !== "number" && !isMotion(paint.color)
  const lin = paint.linearGradient ? gradientOut(paint.linearGradient, `${where} linearGradient`) : paint.linearGradient
  const rad = paint.radialGradient ? gradientOut(paint.radialGradient, `${where} radialGradient`) : paint.radialGradient
  const sweep = paint.sweepGradient ? gradientOut(paint.sweepGradient, `${where} sweepGradient`) : paint.sweepGradient
  const shadowColor = paint.shadow && typeof paint.shadow === "object" && paint.shadow.color !== undefined && typeof paint.shadow.color !== "number"
  if (!needsColor && !shadowColor && lin === paint.linearGradient && rad === paint.radialGradient && sweep === paint.sweepGradient) return paint
  const out: CanvasPaint = { ...paint }
  if (needsColor) out.color = argb(paint.color as CanvasColor, `${where} color`)
  if (lin !== paint.linearGradient) out.linearGradient = lin
  if (rad !== paint.radialGradient) out.radialGradient = rad
  if (sweep !== paint.sweepGradient) out.sweepGradient = sweep
  if (shadowColor) {
    const s = paint.shadow as CanvasShadow
    out.shadow = { ...s, color: isMotion(s.color) ? s.color : (argb(s.color, `${where} shadow color`) as number) }
  }
  return out
}

function optionsOut<O extends CanvasTextOptions>(options: O | undefined, where: string): O | undefined {
  if (options == null || typeof options !== "object" || options.color === undefined || typeof options.color === "number" || isMotion(options.color)) {
    return options
  }
  return { ...options, color: argb(options.color, `${where} color`) }
}

/** [c] with its colours as ARGB numbers (a copy only when something changes). */
function commandOut(c: CanvasCommand, where: string): CanvasCommand {
  if ("paint" in c && c.paint !== undefined) {
    const paint = paintOut(c.paint, where)
    return paint === c.paint ? c : ({ ...c, paint } as CanvasCommand)
  }
  if ((c.type === "text" || c.type === "paragraph") && c.options !== undefined) {
    const options = optionsOut(c.options, where)
    return options === c.options ? c : ({ ...c, options } as CanvasCommand)
  }
  return c
}

// The number fields each command needs (native skips the command when one is missing or not finite). Each may be a
// motion value, except those in STILL.
const NUMBERS: Record<string, readonly string[]> = {
  rect: ["x", "y", "w", "h"],
  roundRect: ["x", "y", "w", "h", "r"],
  circle: ["cx", "cy", "r"],
  oval: ["x", "y", "w", "h"],
  line: ["x1", "y1", "x2", "y2"],
  arc: ["x", "y", "w", "h", "start", "sweep"],
  path: [],
  text: ["x", "y"],
  paragraph: ["x", "y", "width"],
  image: ["x", "y", "w", "h"],
  save: [],
  restore: [],
  translate: ["dx", "dy"],
  scale: ["sx"],
  rotate: ["degrees"],
  clipRect: ["x", "y", "w", "h"],
  clipRoundRect: ["x", "y", "w", "h", "r"],
  clipPath: [],
}
const OPTIONAL_NUMBERS: Record<string, readonly string[]> = {
  scale: ["sy"],
  rotate: ["px", "py"],
  path: ["trimStart", "trimEnd", "trimOffset"],
}
/** Numbers that can't follow a motion value: native builds something from them once per list. */
const STILL: Record<string, readonly string[]> = { paragraph: ["width"] }

const bad = (v: unknown) => typeof v !== "number" || !Number.isFinite(v)
const badOrMotion = (v: unknown) => !isMotion(v) && bad(v)

function checkGradient(g: { colors: CanvasColor[]; stops?: number[] }, keys: readonly string[], where: string): void {
  const n = Array.isArray(g.colors) ? g.colors.length : 0
  if (n < 2) warn(`${where} needs at least 2 colours, has ${n}; it is drawn in one colour`)
  if (Array.isArray(g.colors) && g.colors.some(isMotion)) warn(`${where} colours can't be motion values; black is used`)
  const o = g as unknown as Record<string, unknown>
  for (const k of keys) {
    if (isMotion(o[k])) warn(`${where}.${k} can't be a motion value (gradients are built once per list); the command is skipped`)
    else if (bad(o[k])) warn(`${where}.${k} must be a finite number; the command is skipped`)
  }
  if (g.stops !== undefined && (!Array.isArray(g.stops) || g.stops.length !== n || g.stops.some(bad))) {
    warn(`${where}.stops must be one finite number per colour; stops are left out`)
  }
}

const BLEND_MODES = new Set<string>([
  "srcOver", "multiply", "screen", "overlay", "darken", "lighten", "plus", "clear",
  "srcIn", "srcOut", "srcAtop", "dstIn", "dstOut", "dstOver", "dstAtop", "xor",
])

function checkPaint(p: CanvasPaint, where: string): void {
  if (p.strokeWidth !== undefined && badOrMotion(p.strokeWidth)) warn(`${where} strokeWidth must be a finite number; the command is skipped`)
  if (p.opacity !== undefined && badOrMotion(p.opacity)) warn(`${where} opacity must be a finite number; the command is skipped`)
  if (p.dash !== undefined) {
    const d = p.dash
    const ok =
      Array.isArray(d) && d.length >= 2 && d.length % 2 === 0 && d.every((v) => !bad(v) && v >= 0) && d.reduce((a, b) => a + b, 0) > 0
    if (!ok) warn(`${where} dash must be an even count (2, 4, ...) of finite numbers ≥ 0, not all 0 (no motion values); no dash is drawn`)
  }
  if (p.linearGradient) checkGradient(p.linearGradient, ["x0", "y0", "x1", "y1"], `${where} linearGradient`)
  if (p.radialGradient) checkGradient(p.radialGradient, ["cx", "cy", "r"], `${where} radialGradient`)
  if (p.sweepGradient) {
    checkGradient(p.sweepGradient, ["cx", "cy"], `${where} sweepGradient`)
    const a = p.sweepGradient.startAngle
    if (a !== undefined && bad(a)) warn(`${where} sweepGradient.startAngle must be a finite number; 0 is used`)
  }
  if (p.blendMode !== undefined && !BLEND_MODES.has(p.blendMode)) warn(`${where} blendMode "${String(p.blendMode)}" is not known; srcOver is used`)
  if (p.shadow !== undefined) {
    const s = p.shadow as unknown as Record<string, unknown>
    if (s === null || typeof s !== "object" || bad(s.dx) || bad(s.dy) || bad(s.blur) || typeof s.color !== "number") {
      warn(`${where} shadow needs finite dx, dy, blur and a colour (no motion values); no shadow is drawn`)
    }
  }
  if (p.blur !== undefined && bad(p.blur)) warn(`${where} blur must be a finite number (not a motion value); no blur`)
}

/**
 * Warns about what native would skip or change. Cheap: a few property reads per command. Returns true when the
 * command holds a motion value (canvasJson then turns them into references).
 */
function check(c: CanvasCommand, where: string): boolean {
  const fields = NUMBERS[c.type]
  if (fields === undefined) {
    warn(`${where}: unknown type "${String((c as { type?: unknown }).type)}"; skipped`)
    return false
  }
  const o = c as unknown as Record<string, unknown>
  const still = STILL[c.type]
  let moves = false
  for (const k of fields) {
    const v = o[k]
    if (isMotion(v)) {
      if (still?.includes(k)) warn(`${where} (${c.type}).${k} can't be a motion value; skipped`)
      moves = true
    } else if (bad(v)) warn(`${where} (${c.type}).${k} must be a finite number; skipped`)
  }
  for (const k of OPTIONAL_NUMBERS[c.type] ?? []) {
    const v = o[k]
    if (isMotion(v)) moves = true
    else if (v !== undefined && bad(v)) warn(`${where} (${c.type}).${k} must be a finite number; skipped`)
  }
  if ((c.type === "path" || c.type === "clipPath") && typeof c.d !== "string") warn(`${where} (${c.type}).d must be a string; skipped`)
  if (c.type === "image" && typeof c.src !== "string") warn(`${where} (image).src must be a string; skipped`)
  if ((c.type === "text" || c.type === "paragraph") && c.options && typeof c.options === "object") {
    if (isMotion(c.options.color)) moves = true
    if (c.options.fontSize !== undefined && bad(c.options.fontSize)) warn(`${where} (${c.type}) fontSize must be a finite number (not a motion value); skipped`)
  }
  if (c.type === "paragraph" && c.options && typeof c.options === "object") {
    const { lineHeight, maxLines } = c.options
    if (lineHeight !== undefined && bad(lineHeight)) warn(`${where} (paragraph) lineHeight must be a finite number; the font's own is used`)
    if (maxLines !== undefined && (bad(maxLines) || maxLines < 1)) warn(`${where} (paragraph) maxLines must be 1 or more; no limit`)
  }
  if (c.type === "image" && c.options && typeof c.options === "object") {
    const { radius, opacity } = c.options
    if (isMotion(radius) || isMotion(opacity)) moves = true
    if (radius !== undefined && badOrMotion(radius)) warn(`${where} (image) radius must be a finite number; skipped`)
    if (opacity !== undefined && badOrMotion(opacity)) warn(`${where} (image) opacity must be a finite number; skipped`)
  }
  if ("op" in c && c.op !== undefined && c.op !== "intersect" && c.op !== "difference") {
    warn(`${where} (${c.type}).op must be "intersect" or "difference"; intersect is used`)
  }
  if ("paint" in c && c.paint) {
    checkPaint(c.paint, `${where} (${c.type})`)
    if (isMotion(c.paint.color) || isMotion(c.paint.opacity) || isMotion(c.paint.strokeWidth)) moves = true
  }
  return moves
}

/** JSON.stringify's replacer: a motion value becomes "\u0000m<id>" (core motion.ts viewPropsJson does the same). */
function motionRefs(_k: string, v: unknown): unknown {
  return isMotion(v) ? REF + v.__znMotion : v
}

/**
 * The JSON native reads for a <Canvas> `commands` value. A string is sent as it is (its colours must already be ARGB
 * numbers). A list is walked once: colour strings become ARGB numbers (also in hand-written objects), motion values
 * become references, and problems are warned about with the command index. `null` / `false` entries stay; native
 * skips them.
 */
export function canvasJson(commands: readonly CanvasEntry[] | string | null | undefined): string {
  if (typeof commands === "string") return commands
  if (commands == null) return "[]"
  if (!Array.isArray(commands)) {
    warn("commands must be an array of draw.* commands; nothing is drawn")
    return "[]"
  }
  if (commands.length > MAX_CANVAS_COMMANDS) {
    warn(`${commands.length} commands, more than the ${MAX_CANVAS_COMMANDS} allowed; nothing is drawn`)
    return "[]"
  }
  let out: CanvasEntry[] | null = null
  let moves = false
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]
    if (c == null || c === false) continue
    if (typeof c !== "object") {
      warn(`command ${i} is not a command object; skipped`)
      continue
    }
    const where = `command ${i}`
    if (check(c, where)) moves = true
    const n = commandOut(c, where)
    if (n !== c) {
      if (out === null) out = commands.slice()
      out[i] = n
    }
  }
  // The replacer only when needed: it is called for every value, which a 10,000 command chart would feel.
  return moves ? JSON.stringify(out ?? commands, motionRefs) : JSON.stringify(out ?? commands)
}

/** [points] as [x0, y0, x1, y1, ...], dropping pairs that aren't finite (with one warning). */
function flatPoints(points: CanvasPoints, where: string): number[] {
  const out: number[] = []
  if (!Array.isArray(points)) {
    warn(`${where}: points must be an array`)
    return out
  }
  const nested = points.length > 0 && Array.isArray(points[0])
  const n = nested ? points.length : Math.floor(points.length / 2)
  let dropped = false
  for (let i = 0; i < n; i++) {
    const x = nested ? (points[i] as readonly number[])[0] : (points[i * 2] as number)
    const y = nested ? (points[i] as readonly number[])[1] : (points[i * 2 + 1] as number)
    if (bad(x) || bad(y)) {
      dropped = true
      continue
    }
    out.push(x, y)
  }
  if (dropped) warn(`${where}: points that aren't finite numbers are left out`)
  return out
}

/** Short numbers in path data: 2 decimals is under a hundredth of a dp. */
const fmt = (v: number) => String(Math.round(v * 100) / 100)

/**
 * SVG path data for a smooth curve through [points] (a monotone cubic, Fritsch-Butland): it never overshoots, so a
 * chart's curve never goes above its highest point or below its lowest. Points must go left to right; a step back in x
 * is drawn as a straight line.
 */
export function smoothPath(points: CanvasPoints): string {
  const p = flatPoints(points, "smoothPath")
  const n = p.length / 2
  if (n === 0) return ""
  if (n === 1) return `M ${fmt(p[0])} ${fmt(p[1])}`
  // Slopes of each segment, then a tangent at each point.
  const h: number[] = []
  const s: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const dx = p[i * 2 + 2] - p[i * 2]
    h.push(dx)
    s.push(dx > 0 ? (p[i * 2 + 3] - p[i * 2 + 1]) / dx : 0)
  }
  const m: number[] = new Array(n)
  m[0] = s[0]
  m[n - 1] = s[n - 2]
  for (let i = 1; i < n - 1; i++) {
    const s0 = s[i - 1]
    const s1 = s[i]
    // Flat at a peak or a valley (the slopes change sign), so the curve doesn't bulge past it.
    if (s0 * s1 <= 0 || h[i - 1] <= 0 || h[i] <= 0) m[i] = 0
    else m[i] = (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / s0 + (h[i] + 2 * h[i - 1]) / s1)
  }
  let d = `M ${fmt(p[0])} ${fmt(p[1])}`
  for (let i = 0; i < n - 1; i++) {
    const x0 = p[i * 2]
    const y0 = p[i * 2 + 1]
    const x1 = p[i * 2 + 2]
    const y1 = p[i * 2 + 3]
    if (h[i] <= 0) {
      d += ` L ${fmt(x1)} ${fmt(y1)}`
      continue
    }
    const k = h[i] / 3
    d += ` C ${fmt(x0 + k)} ${fmt(y0 + m[i] * k)} ${fmt(x1 - k)} ${fmt(y1 - m[i + 1] * k)} ${fmt(x1)} ${fmt(y1)}`
  }
  return d
}

/** SVG path data for straight lines through [points]. */
function polylinePath(points: CanvasPoints): string {
  const p = flatPoints(points, "polyline")
  let d = ""
  for (let i = 0; i < p.length; i += 2) d += `${i === 0 ? "M" : " L"} ${fmt(p[i])} ${fmt(p[i + 1])}`
  return d
}

export const draw = {
  rect(x: CanvasNum, y: CanvasNum, w: CanvasNum, h: CanvasNum, paint?: CanvasPaint): CanvasCommand {
    return { type: "rect", x, y, w, h, paint: paintOut(paint, "rect") }
  },
  roundRect(x: CanvasNum, y: CanvasNum, w: CanvasNum, h: CanvasNum, r: CanvasNum, paint?: CanvasPaint): CanvasCommand {
    return { type: "roundRect", x, y, w, h, r, paint: paintOut(paint, "roundRect") }
  },
  circle(cx: CanvasNum, cy: CanvasNum, r: CanvasNum, paint?: CanvasPaint): CanvasCommand {
    return { type: "circle", cx, cy, r, paint: paintOut(paint, "circle") }
  },
  oval(x: CanvasNum, y: CanvasNum, w: CanvasNum, h: CanvasNum, paint?: CanvasPaint): CanvasCommand {
    return { type: "oval", x, y, w, h, paint: paintOut(paint, "oval") }
  },
  line(x1: CanvasNum, y1: CanvasNum, x2: CanvasNum, y2: CanvasNum, paint?: CanvasPaint): CanvasCommand {
    return { type: "line", x1, y1, x2, y2, paint: paintOut(paint, "line") }
  },
  /** Angles in degrees: 0 is 3 o'clock, a positive sweep goes clockwise. */
  arc(x: CanvasNum, y: CanvasNum, w: CanvasNum, h: CanvasNum, start: CanvasNum, sweep: CanvasNum, useCenter = false, paint?: CanvasPaint): CanvasCommand {
    return { type: "arc", x, y, w, h, start, sweep, useCenter, paint: paintOut(paint, "arc") }
  },
  /** [d] is SVG path data, in dp. `trimStart` / `trimEnd` / `trimOffset` (0 to 1) draw only a piece of it. */
  path(d: string, paint?: CanvasPaint, options?: CanvasPathOptions): CanvasCommand {
    const c: CanvasCommand = { type: "path", d, paint: paintOut(paint, "path") }
    if (options?.trimStart !== undefined) c.trimStart = options.trimStart
    if (options?.trimEnd !== undefined) c.trimEnd = options.trimEnd
    if (options?.trimOffset !== undefined) c.trimOffset = options.trimOffset
    return c
  },
  /** Straight lines through [points] (a path command). */
  polyline(points: CanvasPoints, paint?: CanvasPaint, options?: CanvasPathOptions): CanvasCommand {
    return draw.path(polylinePath(points), paint, options)
  },
  /** [y] is the text's baseline, not its top. */
  text(text: string, x: CanvasNum, y: CanvasNum, options?: CanvasTextOptions): CanvasCommand {
    return { type: "text", text, x, y, options: optionsOut(options, "text") }
  },
  /** Text that wraps at [width] dp. [y] is the top of the first line. */
  paragraph(text: string, x: CanvasNum, y: CanvasNum, width: number, options?: CanvasParagraphOptions): CanvasCommand {
    return { type: "paragraph", text, x, y, width, options: optionsOut(options, "paragraph") }
  },
  /** [src]: an http(s) URL, "asset:images/x.png" or a zn:// handle (the same as <Image>). Nothing shows until it loads. */
  image(src: string, x: CanvasNum, y: CanvasNum, w: CanvasNum, h: CanvasNum, options?: CanvasImageOptions): CanvasCommand {
    return { type: "image", src, x, y, w, h, options }
  },
  save(): CanvasCommand {
    return { type: "save" }
  },
  restore(): CanvasCommand {
    return { type: "restore" }
  },
  translate(dx: CanvasNum, dy: CanvasNum): CanvasCommand {
    return { type: "translate", dx, dy }
  },
  scale(sx: CanvasNum, sy: CanvasNum = sx): CanvasCommand {
    return { type: "scale", sx, sy }
  },
  /** Degrees, clockwise, around (px, py). */
  rotate(degrees: CanvasNum, px: CanvasNum = 0, py: CanvasNum = 0): CanvasCommand {
    return { type: "rotate", degrees, px, py }
  },
  /** "difference" cuts the box out (draws everywhere but there). */
  clipRect(x: CanvasNum, y: CanvasNum, w: CanvasNum, h: CanvasNum, options?: { op?: CanvasClipOp }): CanvasCommand {
    const c: CanvasCommand = { type: "clipRect", x, y, w, h }
    if (options?.op !== undefined) c.op = options.op
    return c
  },
  clipRoundRect(x: CanvasNum, y: CanvasNum, w: CanvasNum, h: CanvasNum, r: CanvasNum, options?: { op?: CanvasClipOp }): CanvasCommand {
    const c: CanvasCommand = { type: "clipRoundRect", x, y, w, h, r }
    if (options?.op !== undefined) c.op = options.op
    return c
  },
  /** [d] is SVG path data, in dp. */
  clipPath(d: string, options?: { op?: CanvasClipOp; fillType?: "nonZero" | "evenOdd" }): CanvasCommand {
    const c: CanvasCommand = { type: "clipPath", d }
    if (options?.op !== undefined) c.op = options.op
    if (options?.fillType !== undefined) c.fillType = options.fillType
    return c
  },
}
