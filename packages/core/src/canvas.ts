// <Canvas> commands (registry 23; native ZnCanvas.kt). Build them with the `draw.*` helpers:
//   <Canvas style={{ width: 300, height: 120 }} commands={[draw.rect(0, 0, 300, 120, { color: "#F1F5F9" }), ...]} />
// Units are dp. Colours are turned into ARGB numbers here (core's parseColor), because native never parses colour
// strings. `canvasJson` also does this for hand-written command objects and checks the list (finite numbers,
// gradients, dash, the 10,000 cap) with a warning naming the command index. Native checks again and never crashes.
import { parseColor } from "./color"

/** A colour string ("#RRGGBB", "rgba(...)", "hsl(...)", a CSS name) or an ARGB number. */
export type CanvasColor = string | number

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

export interface CanvasPaint {
  color?: CanvasColor
  style?: "fill" | "stroke"
  strokeWidth?: number
  strokeCap?: "butt" | "round" | "square"
  strokeJoin?: "miter" | "round" | "bevel"
  /** On and off lengths in dp: an even count (2, 4, ...), each ≥ 0. */
  dash?: number[]
  opacity?: number
  linearGradient?: CanvasLinearGradient
  radialGradient?: CanvasRadialGradient
}

export interface CanvasTextOptions {
  fontSize?: number
  fontWeight?: number | "normal" | "bold"
  color?: CanvasColor
  align?: "left" | "center" | "right"
}

export type CanvasCommand =
  | { type: "rect"; x: number; y: number; w: number; h: number; paint?: CanvasPaint }
  | { type: "roundRect"; x: number; y: number; w: number; h: number; r: number; paint?: CanvasPaint }
  | { type: "circle"; cx: number; cy: number; r: number; paint?: CanvasPaint }
  | { type: "oval"; x: number; y: number; w: number; h: number; paint?: CanvasPaint }
  | { type: "line"; x1: number; y1: number; x2: number; y2: number; paint?: CanvasPaint }
  | { type: "arc"; x: number; y: number; w: number; h: number; start: number; sweep: number; useCenter?: boolean; paint?: CanvasPaint }
  | { type: "path"; d: string; paint?: CanvasPaint }
  | { type: "text"; text: string; x: number; y: number; options?: CanvasTextOptions }
  | { type: "save" }
  | { type: "restore" }
  | { type: "translate"; dx: number; dy: number }
  | { type: "scale"; sx: number; sy?: number }
  | { type: "rotate"; degrees: number; px?: number; py?: number }
  | { type: "clipRect"; x: number; y: number; w: number; h: number }

/** An entry of a command list: `null`, `undefined` and `false` are skipped (`[a, cond && draw.circle(...)]`). */
export type CanvasEntry = CanvasCommand | null | undefined | false

/** Same as native ZnCanvas.kt MAX_CANVAS_COMMANDS: over this, nothing is drawn. */
export const MAX_CANVAS_COMMANDS = 10000

const BLACK = 0xff000000

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

function argb(c: CanvasColor, where: string): number {
  if (typeof c === "number") return c
  try {
    return parseColor(String(c))
  } catch (e) {
    warn(`${where}: ${e instanceof Error ? e.message : String(e)}; black is used`)
    return BLACK
  }
}

function gradientOut<G extends CanvasLinearGradient | CanvasRadialGradient>(g: G, where: string): G {
  if (!Array.isArray(g.colors) || !g.colors.some((c) => typeof c !== "number")) return g
  return { ...g, colors: g.colors.map((c, i) => argb(c, `${where} colour ${i}`)) }
}

/** [paint] with its colours as ARGB numbers. Returns the same object when nothing needs to change. */
function paintOut(paint: CanvasPaint | undefined, where: string): CanvasPaint | undefined {
  if (paint == null || typeof paint !== "object") return paint
  const needsColor = paint.color !== undefined && typeof paint.color !== "number"
  const lin = paint.linearGradient ? gradientOut(paint.linearGradient, `${where} linearGradient`) : paint.linearGradient
  const rad = paint.radialGradient ? gradientOut(paint.radialGradient, `${where} radialGradient`) : paint.radialGradient
  if (!needsColor && lin === paint.linearGradient && rad === paint.radialGradient) return paint
  const out: CanvasPaint = { ...paint }
  if (needsColor) out.color = argb(paint.color as CanvasColor, `${where} color`)
  if (lin !== paint.linearGradient) out.linearGradient = lin
  if (rad !== paint.radialGradient) out.radialGradient = rad
  return out
}

function optionsOut(options: CanvasTextOptions | undefined, where: string): CanvasTextOptions | undefined {
  if (options == null || typeof options !== "object" || options.color === undefined || typeof options.color === "number") return options
  return { ...options, color: argb(options.color, `${where} color`) }
}

/** [c] with its colours as ARGB numbers (a copy only when something changes). */
function commandOut(c: CanvasCommand, where: string): CanvasCommand {
  if ("paint" in c && c.paint !== undefined) {
    const paint = paintOut(c.paint, where)
    return paint === c.paint ? c : ({ ...c, paint } as CanvasCommand)
  }
  if (c.type === "text" && c.options !== undefined) {
    const options = optionsOut(c.options, where)
    return options === c.options ? c : { ...c, options }
  }
  return c
}

// The number fields each command needs (native skips the command when one is missing or not finite).
const NUMBERS: Record<string, readonly string[]> = {
  rect: ["x", "y", "w", "h"],
  roundRect: ["x", "y", "w", "h", "r"],
  circle: ["cx", "cy", "r"],
  oval: ["x", "y", "w", "h"],
  line: ["x1", "y1", "x2", "y2"],
  arc: ["x", "y", "w", "h", "start", "sweep"],
  path: [],
  text: ["x", "y"],
  save: [],
  restore: [],
  translate: ["dx", "dy"],
  scale: ["sx"],
  rotate: ["degrees"],
  clipRect: ["x", "y", "w", "h"],
}
const OPTIONAL_NUMBERS: Record<string, readonly string[]> = { scale: ["sy"], rotate: ["px", "py"] }

const bad = (v: unknown) => typeof v !== "number" || !Number.isFinite(v)

function checkGradient(g: CanvasLinearGradient | CanvasRadialGradient, keys: readonly string[], where: string): void {
  const n = Array.isArray(g.colors) ? g.colors.length : 0
  if (n < 2) warn(`${where} needs at least 2 colours, has ${n}; it is drawn in one colour`)
  const o = g as unknown as Record<string, unknown>
  for (const k of keys) if (bad(o[k])) warn(`${where}.${k} must be a finite number; the command is skipped`)
  if (g.stops !== undefined && (!Array.isArray(g.stops) || g.stops.length !== n || g.stops.some(bad))) {
    warn(`${where}.stops must be one finite number per colour; stops are left out`)
  }
}

function checkPaint(p: CanvasPaint, where: string): void {
  if (p.strokeWidth !== undefined && bad(p.strokeWidth)) warn(`${where} strokeWidth must be a finite number; the command is skipped`)
  if (p.opacity !== undefined && bad(p.opacity)) warn(`${where} opacity must be a finite number; the command is skipped`)
  if (p.dash !== undefined) {
    const d = p.dash
    const ok =
      Array.isArray(d) && d.length >= 2 && d.length % 2 === 0 && d.every((v) => !bad(v) && v >= 0) && d.reduce((a, b) => a + b, 0) > 0
    if (!ok) warn(`${where} dash must be an even count (2, 4, ...) of finite numbers ≥ 0, not all 0; no dash is drawn`)
  }
  if (p.linearGradient) checkGradient(p.linearGradient, ["x0", "y0", "x1", "y1"], `${where} linearGradient`)
  if (p.radialGradient) checkGradient(p.radialGradient, ["cx", "cy", "r"], `${where} radialGradient`)
}

/** Warns about what native would skip or change. Cheap: a few property reads per command. */
function check(c: CanvasCommand, where: string): void {
  const fields = NUMBERS[c.type]
  if (fields === undefined) {
    warn(`${where}: unknown type "${String((c as { type?: unknown }).type)}"; skipped`)
    return
  }
  const o = c as unknown as Record<string, unknown>
  for (const k of fields) if (bad(o[k])) warn(`${where} (${c.type}).${k} must be a finite number; skipped`)
  for (const k of OPTIONAL_NUMBERS[c.type] ?? []) if (o[k] !== undefined && bad(o[k])) warn(`${where} (${c.type}).${k} must be a finite number; skipped`)
  if (c.type === "path" && typeof c.d !== "string") warn(`${where} (path).d must be a string; skipped`)
  if ("paint" in c && c.paint) checkPaint(c.paint, `${where} (${c.type})`)
}

/**
 * The JSON native reads for a <Canvas> `commands` value. A string is sent as it is (its colours must already be ARGB
 * numbers). A list is walked once: colour strings become ARGB numbers (also in hand-written objects), and problems
 * are warned about with the command index. `null` / `false` entries stay; native skips them.
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
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i]
    if (c == null || c === false) continue
    if (typeof c !== "object") {
      warn(`command ${i} is not a command object; skipped`)
      continue
    }
    const where = `command ${i}`
    check(c, where)
    const n = commandOut(c, where)
    if (n !== c) {
      if (out === null) out = commands.slice()
      out[i] = n
    }
  }
  return JSON.stringify(out ?? commands)
}

export const draw = {
  rect(x: number, y: number, w: number, h: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "rect", x, y, w, h, paint: paintOut(paint, "rect") }
  },
  roundRect(x: number, y: number, w: number, h: number, r: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "roundRect", x, y, w, h, r, paint: paintOut(paint, "roundRect") }
  },
  circle(cx: number, cy: number, r: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "circle", cx, cy, r, paint: paintOut(paint, "circle") }
  },
  oval(x: number, y: number, w: number, h: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "oval", x, y, w, h, paint: paintOut(paint, "oval") }
  },
  line(x1: number, y1: number, x2: number, y2: number, paint?: CanvasPaint): CanvasCommand {
    return { type: "line", x1, y1, x2, y2, paint: paintOut(paint, "line") }
  },
  /** Angles in degrees: 0 is 3 o'clock, a positive sweep goes clockwise. */
  arc(x: number, y: number, w: number, h: number, start: number, sweep: number, useCenter = false, paint?: CanvasPaint): CanvasCommand {
    return { type: "arc", x, y, w, h, start, sweep, useCenter, paint: paintOut(paint, "arc") }
  },
  /** [d] is SVG path data, in dp. */
  path(d: string, paint?: CanvasPaint): CanvasCommand {
    return { type: "path", d, paint: paintOut(paint, "path") }
  },
  /** [y] is the text's baseline, not its top. */
  text(text: string, x: number, y: number, options?: CanvasTextOptions): CanvasCommand {
    return { type: "text", text, x, y, options: optionsOut(options, "text") }
  },
  save(): CanvasCommand {
    return { type: "save" }
  },
  restore(): CanvasCommand {
    return { type: "restore" }
  },
  translate(dx: number, dy: number): CanvasCommand {
    return { type: "translate", dx, dy }
  },
  scale(sx: number, sy = sx): CanvasCommand {
    return { type: "scale", sx, sy }
  },
  /** Degrees, clockwise, around (px, py). */
  rotate(degrees: number, px = 0, py = 0): CanvasCommand {
    return { type: "rotate", degrees, px, py }
  },
  clipRect(x: number, y: number, w: number, h: number): CanvasCommand {
    return { type: "clipRect", x, y, w, h }
  },
}
