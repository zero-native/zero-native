// Animated .svg files at build time (docs/svg.md §15, step S.14): SMIL (<animate>, <animateTransform>) and CSS
// (<style> with @keyframes) become zn part animations, so a loader from an icon site plays natively with no change.
//
// Two passes around the SVG compiler (svg.ts):
// 1. extractAnimations, before it: reads the animations and the <style>, takes them out of the tree, gives every
//    animated element an id (so it keeps its own op and becomes a part), and sets what is baked into the draw data:
//    opacity 1 for an animated opacity, the largest size for a growing circle, no transform for a replaced one.
// 2. motionParts, after it: turns each element's tracks into SvgPart props (rest values, pivot, animate string).
//
// What maps: opacity / fill-opacity / stroke-opacity, fill and stroke colours, transforms (rotate, scale, translate,
// in that order), and the geometry of circles, ellipses and rects (cx, cy, r, rx, ry, x, y, width, height), which is
// an exact scale and move of the drawn shape (a stroke keeps its width: the part scales its outline). Since registry 13
// (docs/svg.md §16) also stroke-width, dashes (one dash with a long gap becomes trims; a fixed pattern moves with the
// part's dashOffset) and `d` (a morph between paths with the same commands). SMIL begin chains ("a.end-0.1s") are
// flattened into one repeating cycle. Everything else fails the build with a hint: moving along a path, filters,
// click triggers, CSS selectors beyond class / id / tag.
import { Prop } from "@zero-native/template"
import type { Matrix, PathCmd } from "./svg-data"
import { arcToCubics, ellipsePath, IDENTITY, multiply, parsePathData, parseTransform, polyPath, rectPath, similarityScale, transformPath } from "./svg-path"
import type { SvgAttr, SvgNode } from "./svg-xml"

// ---- Curves: values over time, with an easing per segment --------------------------------------------------------

type Ease = { k: "lin" } | { k: "step" } | { k: "bez"; b: [number, number, number, number] }
const LIN: Ease = { k: "lin" }
/** CSS steps(n, jump-*) (registry 13): only while a curve is built, then written out as step keyframes (expandSteps). */
type Steps = { k: "steps"; n: number; jump: "start" | "end" | "none" | "both" }
type Timing = Ease | Steps

/** A value over [t[0], t[last]] ms: keyframe [v[i]] at [t[i]], segment i eased by [e[i]]. Values are vectors. */
interface Curve {
  t: number[]
  v: number[][]
  e: Ease[]
}

/** How zn plays a curve: [dur] ms per play (times 0–1), after [delay] ms, [plays] in all (-1 forever). */
export interface Track {
  dur: number
  delay: number
  plays: number
  reverse: boolean
  times: number[]
  values: number[][]
  eases: Ease[]
  /** Waits for a tap on the Svg (SMIL begin="click", registry 13): "~w". */
  tap?: boolean
}

function bezAt(b: [number, number, number, number], u: number): [number, number] {
  const m = 1 - u
  const x = 3 * m * m * u * b[0] + 3 * m * u * u * b[2] + u * u * u
  const y = 3 * m * m * u * b[1] + 3 * m * u * u * b[3] + u * u * u
  return [x, y]
}

/** The curve parameter where a cubic-bezier easing reaches time fraction [f] (x is monotonic for valid easings). */
function bezParam(b: [number, number, number, number], f: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (bezAt(b, mid)[0] < f) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

function easeAt(e: Ease, f: number): number {
  if (e.k === "lin") return f
  if (e.k === "step") return f >= 1 ? 1 : 0
  return bezAt(e.b, bezParam(e.b, f))[1]
}

/** Splits easing [e] at time fraction [f]: the two halves as easings of their own, and the progress at [f]. */
function splitEase(e: Ease, f: number): { left: Ease; right: Ease; p: number } {
  if (e.k === "lin") return { left: LIN, right: LIN, p: f }
  if (e.k === "step") return { left: f >= 1 ? e : { k: "step" }, right: e, p: f >= 1 ? 1 : 0 }
  const b = e.b
  const u = bezParam(b, f)
  // de Casteljau on (0,0) (b0,b1) (b2,b3) (1,1).
  const P0 = [0, 0]
  const P1 = [b[0], b[1]]
  const P2 = [b[2], b[3]]
  const P3 = [1, 1]
  const lerp = (a: number[], c: number[]) => [a[0]! + (c[0]! - a[0]!) * u, a[1]! + (c[1]! - a[1]!) * u]
  const A = lerp(P0, P1)
  const B = lerp(P1, P2)
  const C = lerp(P2, P3)
  const D = lerp(A, B)
  const E = lerp(B, C)
  const F = lerp(D, E) // the point on the curve
  const [fx, fy] = F as [number, number]
  // Each half, scaled back to the unit box. A half with no change in value is plain linear (nothing to ease).
  const norm = (p: number[][], x0: number, y0: number, x1: number, y1: number): Ease => {
    const dx = x1 - x0
    const dy = y1 - y0
    if (Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-6) return LIN
    const q = p.map(([x, y]) => [(x! - x0) / dx, (y! - y0) / dy])
    return { k: "bez", b: [clamp01(q[0]![0]!), q[0]![1]!, clamp01(q[1]![0]!), q[1]![1]!] }
  }
  return { left: norm([A, D], 0, 0, fx, fy), right: norm([E, C], fx, fy, 1, 1), p: fy }
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const lerpV = (a: number[], b: number[], p: number) => a.map((x, i) => x + (b[i]! - x) * p)

function curveAt(c: Curve, t: number): number[] {
  if (t <= c.t[0]!) return c.v[0]!
  for (let i = 0; i < c.e.length; i++) {
    const t0 = c.t[i]!
    const t1 = c.t[i + 1]!
    if (t <= t1) return t1 === t0 ? c.v[i + 1]! : lerpV(c.v[i]!, c.v[i + 1]!, easeAt(c.e[i]!, (t - t0) / (t1 - t0)))
  }
  return c.v[c.v.length - 1]!
}

/** The part of [c] between [a] and [b] (within its range), with the end segments split. */
function slice(c: Curve, a: number, b: number): Curve {
  const t: number[] = [a]
  const v: number[][] = [curveAt(c, a)]
  const e: Ease[] = []
  for (let i = 0; i < c.e.length; i++) {
    const t0 = c.t[i]!
    const t1 = c.t[i + 1]!
    if (t1 <= a || t0 >= b) continue
    const s0 = Math.max(t0, a)
    const s1 = Math.min(t1, b)
    if (s1 <= s0) continue
    let ease = c.e[i]!
    if (t1 > t0) {
      const fa = (s0 - t0) / (t1 - t0)
      const fb = (s1 - t0) / (t1 - t0)
      if (fa > 0) ease = splitEase(ease, fa).right
      if (fb < 1) {
        // The right part's own time fraction where [s1] falls.
        const fr = fa > 0 ? (fb - fa) / (1 - fa) : fb
        ease = splitEase(ease, fr).left
      }
    }
    t.push(s1)
    v.push(curveAt(c, s1))
    e.push(ease)
  }
  if (t[t.length - 1]! < b) {
    t.push(b)
    v.push(curveAt(c, b))
    e.push(LIN)
  }
  return { t, v, e }
}

/**
 * [b] after [a] in time ([b] starts where [a] ends). When they don't meet at the same value (a turn from 0 to 360
 * played again, or a new SMIL animation taking over), the value jumps: a 1 ms step taken from [b]'s first segment,
 * so the total length stays the same.
 */
function concat(a: Curve, b: Curve): Curve {
  const shift = a.t[a.t.length - 1]! - b.t[0]!
  const last = a.v[a.v.length - 1]!
  const same = last.every((x, i) => Math.abs(x - b.v[0]![i]!) < 1e-9)
  if (same || b.t.length < 2) return { t: [...a.t, ...b.t.slice(1).map((x) => x + shift)], v: [...a.v, ...b.v.slice(1)], e: [...a.e, ...b.e] }
  const end = a.t[a.t.length - 1]!
  const eps = Math.min(1, (b.t[1]! - b.t[0]!) / 2)
  return {
    t: [...a.t, end + eps, ...b.t.slice(1).map((x) => x + shift)],
    v: [...a.v, b.v[0]!, ...b.v.slice(1)],
    e: [...a.e, { k: "step" }, ...b.e],
  }
}

/** [c] played [n] times in a row. */
function unroll(c: Curve, n: number): Curve {
  let out = c
  for (let i = 1; i < n; i++) out = concat(out, c)
  return out
}

/** One play backwards (CSS direction: reverse): times mirrored, each easing mirrored. */
function mirror(c: Curve): Curve {
  const end = c.t[c.t.length - 1]!
  const start = c.t[0]!
  const t = c.t.map((x) => start + end - x).reverse()
  const v = [...c.v].reverse()
  const e = [...c.e].reverse()
  const out: Curve = { t: [t[0]!], v: [v[0]!], e: [] }
  for (let i = 0; i < e.length; i++) {
    const x = e[i]!
    const span = t[i + 1]! - t[i]!
    if (x.k === "step" && span > 0) {
      // A hold that jumps at its end, played backwards, jumps at its start and then holds: a 1 ms step, then a hold.
      const eps = Math.min(1, span / 2)
      out.t.push(t[i]! + eps, t[i + 1]!)
      out.v.push(v[i + 1]!, v[i + 1]!)
      out.e.push({ k: "step" }, LIN)
      continue
    }
    out.t.push(t[i + 1]!)
    out.v.push(v[i + 1]!)
    out.e.push(x.k === "bez" ? { k: "bez", b: [1 - x.b[2], 1 - x.b[3], 1 - x.b[0], 1 - x.b[1]] } : x)
  }
  return out
}

/**
 * A curve whose segments may use CSS steps(): each such segment becomes [n] holds that jump (step keyframes), at the
 * levels CSS gives: jump-end k/n, jump-start (k+1)/n, jump-none k/(n-1), jump-both (k+1)/(n+1). A jump right at the
 * segment's start is a 1 ms step.
 */
function expandSteps(c: { t: number[]; v: number[][]; e: Timing[] }): Curve {
  const t = [c.t[0]!]
  const v = [c.v[0]!]
  const e: Ease[] = []
  for (let i = 0; i < c.e.length; i++) {
    const s = c.e[i]!
    const t0 = c.t[i]!
    const t1 = c.t[i + 1]!
    const a = c.v[i]!
    const b = c.v[i + 1]!
    if (s.k !== "steps" || !(t1 > t0)) {
      t.push(t1)
      v.push(b)
      e.push(s.k === "steps" ? { k: "step" } : s)
      continue
    }
    const n = s.n
    const level = (k: number) => (s.jump === "start" ? (k + 1) / n : s.jump === "end" ? k / n : s.jump === "none" ? k / (n - 1) : (k + 1) / (n + 1))
    const d = (t1 - t0) / n
    if (level(0) > 0) {
      t.push(t0 + Math.min(1, d / 2))
      v.push(lerpV(a, b, level(0)))
      e.push({ k: "step" })
    }
    for (let k = 0; k < n; k++) {
      t.push(k + 1 === n ? t1 : t0 + (k + 1) * d)
      v.push(k + 1 === n ? b : lerpV(a, b, level(k + 1)))
      e.push({ k: "step" })
    }
  }
  return { t, v, e }
}

/** A loop of [c] (one period) that starts [phase] ms in (a negative CSS delay, or a SMIL begin before 0). */
function rotate(c: Curve, phase: number): Curve {
  const start = c.t[0]!
  const end = c.t[c.t.length - 1]!
  const p = start + (((phase % (end - start)) + (end - start)) % (end - start))
  if (p <= start + 1e-6) return c
  return concat(slice(c, p, end), slice(c, start, p))
}

function trackOf(c: Curve, delay: number, plays: number, reverse: boolean): Track {
  const t0 = c.t[0]!
  const dur = c.t[c.t.length - 1]! - t0
  return { dur, delay, plays, reverse, times: c.t.map((x) => (x - t0) / dur), values: c.v, eases: c.e }
}

// ---- What an animation is, from SMIL or CSS --------------------------------------------------------------------

/** The value an animation changes: "opacity", "r", ..., or a transform: "rotate" [deg, cx, cy], "scale", "translate", "css-transform" [tx, ty, deg, sx, sy]. */
interface SourceTrack {
  attr: string
  track: Track
  at: string
  /** Where the transform turns and scales, in the element's own user space. */
  origin?: [number, number]
  /** SMIL additive="sum": on top of the element's own transform (else it replaces it). */
  additive?: boolean
  /** A SMIL loop's cycle from its own start, and fill="freeze" (to merge several animations of one attribute). */
  cycle?: Cycle
  freeze?: boolean
  /** "motion" (animateMotion, CSS offset-path): the path in the parent's user space, and how the element turns on it. */
  motion?: MotionSpec
}

/**
 * A path an element moves along. [mode] 0: turned by [angle] degrees; 1: by the path's direction plus [angle];
 * 2: the same, reversed (plus 180).
 */
interface MotionSpec {
  path: PathCmd[]
  mode: 0 | 1 | 2
  angle: number
  /** Where it is when not animating (CSS: its offset-distance); none: not moved (SMIL). */
  rest?: number
}

/** One period of a looping SMIL animation, from its start at [begin] ms. */
interface Cycle {
  curve: Curve
  period: number
  begin: number
  /** How long it plays in each period before it holds (or drops back to the base value). */
  active: number
}

export interface AnimatedElement {
  id: string
  tag: string
  at: string
  tracks: SourceTrack[]
  /** The matrix the element's coordinates are baked with (its parent's, plus its own transform unless replaced). */
  ctm: Matrix
  /** Its parent's matrix: the space a motion path is in. */
  parent: Matrix
  /** Its own transform, when an animation replaces it (the rest value), else null. */
  replaced: Matrix | null
  /** Geometry before the build changed it, and what was baked: base / baked is the rest scale. */
  base: Record<string, number>
  baked: Record<string, number>
  /** Opacity values before the build set them to 1. */
  baseOpacity: Record<string, number>
  /** Base colours of animated fill / stroke. */
  baseColor: Record<string, number>
  /**
   * The stroke before the build changed it (own user units): width, dashes and offset, and the line it dashes
   * (its length, its number of pieces, and the file's pathLength, which dash lengths are measured against).
   */
  stroke: { width: number; dashes: number[]; offset: number; length: number; contours: number; pathLength: number | null }
  /** Animated dashes: "trim" (one dash with a long gap: the part's trims), "offset" (a fixed pattern that moves). */
  dashMode: "trim" | "offset" | null
  /** A morph (animated `d`): the commands every keyframe shares (M, C and Z), else null. */
  morph: string | null
}

const SMIL = new Set(["animate", "animateTransform", "animateMotion", "set"])
const GEOMETRY: Record<string, string[]> = {
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  rect: ["x", "y", "width", "height"],
}
const SIZES = new Set(["r", "rx", "ry", "width", "height"])
const OPACITIES = new Set(["opacity", "fill-opacity", "stroke-opacity"])
const COLORS = new Set(["fill", "stroke"])
const STROKES = new Set(["stroke-width", "stroke-dasharray", "stroke-dashoffset"])
/** What the walk passes down for animated values that start from an inherited one. */
interface Inherit {
  fill: string
  stroke: string
  "stroke-width": string
  "stroke-dasharray": string
  "stroke-dashoffset": string
}
const INHERIT_START: Inherit = { fill: "black", stroke: "none", "stroke-width": "1", "stroke-dasharray": "none", "stroke-dashoffset": "0" }
/** CSS properties a keyframe or rule may set besides the animation ones, written into the element as attributes. */
const CSS_PRESENTATION = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "color", "visibility", "display", "stop-color", "stop-opacity",
])
/** CSS motion path properties (registry 13): read by cssMotion, not written as attributes. */
const OFFSET_PROPS = new Set(["offset-path", "offset-distance", "offset-rotate", "offset-anchor", "offset-position"])

class Failure extends Error {}
const fail = (at: string, msg: string): never => {
  throw new Failure(`${at}: ${msg}`)
}
const HINT = "rebuild the motion with parts + animate (docs/svg.md §9), or use a Lottie file"

/**
 * Takes SMIL and CSS animations out of [root] and returns the tree to compile (a copy where something changed) and
 * the animated elements. A tree with no animation and no <style> comes back as it is.
 */
export function extractAnimations(root: SvgNode, colorOf: (s: string) => number | null): { root: SvgNode; elements: AnimatedElement[] } {
  if (!hasAnimation(root)) return { root, elements: [] }
  return new Extractor(root, colorOf).run()
}

function hasAnimation(n: SvgNode): boolean {
  return n.tag === "style" || SMIL.has(n.tag) || (n.attrs.get("style")?.value.includes("var(") ?? false) || n.children.some(hasAnimation)
}

// ---- Times and values ------------------------------------------------------------------------------------------

/** SMIL / CSS clock value in ms: "0.6s", "100ms", "1.2" (seconds), "00:01.5" isn't supported. */
function clock(s: string, at: string, what: string): number {
  const m = /^\s*(-?[\d.]+(?:e-?\d+)?)\s*(ms|s|min|h)?\s*$/.exec(s)
  if (!m) return fail(at, `can't read ${what} "${s}" (use seconds like 0.6s or ms like 600ms)`)
  const n = Number(m[1])
  if (!Number.isFinite(n)) return fail(at, `can't read ${what} "${s}"`)
  const unit = m[2] ?? "s"
  return n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "min" ? 60_000 : 3_600_000)
}

function plainNumbers(s: string, at: string, what: string): number[] {
  const parts = s.trim().split(/[\s,]+/).filter((x) => x !== "")
  return parts.map((p) => {
    const m = /^(-?[\d.]+(?:e-?\d+)?)(px)?$/.exec(p)
    if (!m) return fail(at, `can't read ${what} "${s}" (numbers in user units only; % and em aren't supported in animations)`)
    return Number(m[1])
  })
}

function bezier(s: string, at: string): [number, number, number, number] {
  const n = plainNumbers(s, at, "keySplines")
  if (n.length !== 4) fail(at, `a keySplines entry needs 4 numbers, got "${s}"`)
  return n as [number, number, number, number]
}

// ---- The extractor ---------------------------------------------------------------------------------------------

interface Rule {
  selectors: Selector[][]
  decls: Map<string, string>
  order: number
  at: string
}
/** One compound part of a selector, and how it joins the part before it (registry 13 adds all but " "). */
interface Selector {
  tag?: string
  id?: string
  classes: string[]
  attrs: Array<{ name: string; op: string; value: string }>
  /** :nth-child(A n + B) as [A, B, from the end]; :first-child is [0, 1, false]. */
  nth: Array<[number, number, boolean]>
  not: Selector[]
  root?: boolean
  comb?: " " | ">" | "+" | "~"
}
interface Keyframes {
  stops: Array<{ offsets: number[]; decls: Map<string, string> }>
  at: string
}

class Extractor {
  private elements: AnimatedElement[] = []
  private ids = new Set<string>()
  /** Elements by id (the first one with it), for <mpath href>. */
  private byId = new Map<string, SvgNode>()
  /** SMIL animations that start on a tap (begin="click", and chains to those): their tracks wait for one ("~w"). */
  private tapped = new Set<SvgNode>()
  private next = 0
  private rules: Rule[] = []
  /** Source order of the rules, across @media blocks. */
  private ruleOrder = 0
  private keyframes = new Map<string, Keyframes>()
  private vb: [number, number, number, number] = [0, 0, 0, 0]
  /** SMIL animations, with their element, for the begin chains. */
  private smil: Array<{ el: SvgNode; anim: SvgNode; id?: string }> = []

  constructor(
    private root: SvgNode,
    private colorOf: (s: string) => number | null,
  ) {}

  run(): { root: SvgNode; elements: AnimatedElement[] } {
    this.collect(this.root)
    const vbA = this.root.attrs.get("viewBox")
    if (vbA) this.vb = vbA.value.trim().split(/[\s,]+/).map(Number) as [number, number, number, number]
    else this.vb = [0, 0, Number.parseFloat(this.root.attrs.get("width")?.value ?? "0"), Number.parseFloat(this.root.attrs.get("height")?.value ?? "0")]
    const begins = this.solveBegins()
    const out = this.walk(this.root, IDENTITY, begins, false)
    return { root: out, elements: this.elements }
  }

  /** Ids in use, the <style> sheets, and every SMIL animation. */
  private collect(n: SvgNode, parent: SvgNode | null = null) {
    const id = n.attrs.get("id")?.value
    if (id) this.ids.add(id)
    if (id && !this.byId.has(id)) this.byId.set(id, n)
    if (n.tag === "style") {
      this.parseCss(n.text, n.at)
      return
    }
    if (SMIL.has(n.tag)) {
      if (!parent) fail(n.at, "an animation needs a parent element")
      this.smil.push({ el: parent!, anim: n, id })
      return
    }
    for (const c of n.children) this.collect(c, n)
  }

  private newId(): string {
    let id: string
    do id = `zn-anim-${this.next++}`
    while (this.ids.has(id))
    this.ids.add(id)
    return id
  }

  // ---- SMIL begin times --------------------------------------------------------------------------------------

  /**
   * Every SMIL animation's start times over the first 120 s, from offsets and from other animations' begin / end
   * ("a.end-0.1s"). Worked out until nothing changes; chains that loop give an even series of starts.
   */
  private solveBegins(): Map<SvgNode, number[]> {
    const H = 120_000
    const byId = new Map<string, SvgNode>()
    for (const s of this.smil) if (s.id) byId.set(s.id, s.anim)
    type Src = { kind: "offset"; t: number } | { kind: "sync"; ref: SvgNode; edge: "begin" | "end"; d: number }
    const sources = new Map<SvgNode, Src[]>()
    const active = new Map<SvgNode, number>()
    // Animations that start on a tap, and (below) the ones chained to them.
    const taps = this.tapped
    for (const { anim } of this.smil) {
      const at = anim.attrs.get("begin")?.at ?? anim.at
      const raw = anim.attrs.get("begin")?.value ?? "0s"
      const list: Src[] = []
      for (const part of raw.split(";")) {
        const p = part.trim()
        if (p === "") continue
        const sync = /^([A-Za-z_][\w.-]*?)\.(begin|end)\s*(?:([+-])\s*(.+))?$/.exec(p)
        if (sync) {
          const ref = byId.get(sync[1]!)
          if (!ref) fail(at, `begin "${p}": no animation with id "${sync[1]}"`)
          const d = sync[4] ? clock(sync[4], at, "begin") * (sync[3] === "-" ? -1 : 1) : 0
          list.push({ kind: "sync", ref: ref!, edge: sync[2] as "begin" | "end", d })
          continue
        }
        if (/^[-+]?[\d.]/.test(p)) {
          list.push({ kind: "offset", t: clock(p, at, "begin") })
          continue
        }
        // "click" or "id.click" (registry 13): starts on a tap anywhere on the Svg; its times count from the tap.
        const click = /^(?:[A-Za-z_][\w.-]*\.)?click\s*(?:([+-])\s*(.+))?$/.exec(p)
        if (click) {
          list.push({ kind: "offset", t: click[2] ? clock(click[2], at, "begin") * (click[1] === "-" ? -1 : 1) : 0 })
          taps.add(anim)
          continue
        }
        fail(at, `begin "${p}" isn't supported (a time, a click, or another animation's begin / end; no other events): ${HINT}`)
      }
      sources.set(anim, list)
      const dur = this.dur(anim)
      const rc = anim.attrs.get("repeatCount")?.value
      if (anim.attrs.has("repeatDur") || anim.attrs.has("end") || anim.attrs.has("min") || anim.attrs.has("max")) {
        fail(anim.at, `repeatDur / end / min / max on an animation aren't supported: ${HINT}`)
      }
      const n = rc === undefined ? 1 : rc === "indefinite" ? Infinity : Number(rc)
      if (!(n > 0) || (Number.isFinite(n) && !Number.isInteger(n))) fail(anim.at, `repeatCount "${rc}" isn't supported (a whole number or indefinite)`)
      active.set(anim, dur * n)
    }
    // A chain to a tap-started animation starts on the tap too. Mixing a tap with a time can't be one timeline.
    const clicks = new Set(taps)
    for (let changed = true; changed; ) {
      changed = false
      for (const [a, list] of sources) {
        if (!taps.has(a) && list.some((s) => s.kind === "sync" && taps.has(s.ref))) {
          taps.add(a)
          changed = true
        }
      }
    }
    for (const [a, list] of sources) {
      if (!taps.has(a)) continue
      const timed = list.some((s) => (s.kind === "offset" && !clicks.has(a)) || (s.kind === "sync" && !taps.has(s.ref)))
      const mixed = clicks.has(a) && (a.attrs.get("begin")?.value ?? "").split(";").some((p) => /^\s*[-+]?[\d.]/.test(p))
      if (timed || mixed) fail(a.attrs.get("begin")?.at ?? a.at, `this animation starts both on a tap and at a time, which isn't supported: ${HINT}`)
    }
    const begins = new Map<SvgNode, number[]>()
    for (const [a, list] of sources) begins.set(a, list.filter((s) => s.kind === "offset").map((s) => (s as { t: number }).t))
    const endsOf = (a: SvgNode) => {
      const b = [...begins.get(a)!].sort((x, y) => x - y)
      return b.map((t, i) => Math.min(t + active.get(a)!, i + 1 < b.length ? b[i + 1]! : Infinity)).filter((t) => t < H)
    }
    for (let round = 0; round < 2000; round++) {
      let changed = false
      for (const [a, list] of sources) {
        const set = new Set(begins.get(a)!.map((t) => Math.round(t * 1000) / 1000))
        for (const s of list) {
          if (s.kind !== "sync") continue
          const ref = s.edge === "begin" ? begins.get(s.ref)! : endsOf(s.ref)
          for (const t of ref) {
            const v = Math.round((t + s.d) * 1000) / 1000
            if (v < H && !set.has(v)) {
              set.add(v)
              changed = true
            }
          }
        }
        begins.set(a, [...set].sort((x, y) => x - y))
      }
      if (!changed) break
    }
    return begins
  }

  /** An animation's dur in ms; a <set> with none (or "indefinite") holds forever: Infinity. */
  private dur(anim: SvgNode): number {
    const d = anim.attrs.get("dur")
    if ((!d || d.value === "indefinite") && anim.tag === "set") return Infinity
    if (!d || d.value === "indefinite") return fail(anim.at, `an animation needs a dur (like dur="1s"): ${HINT}`)
    const ms = clock(d.value, d.at, "dur")
    if (!(ms > 0)) fail(d.at, "dur must be more than 0")
    return ms
  }

  // ---- Walking the tree --------------------------------------------------------------------------------------

  private walk(n: SvgNode, parentCtm: Matrix, begins: Map<SvgNode, number[]>, inDefs: boolean, inh: Inherit = INHERIT_START): SvgNode {
    if (n.tag === "style" || SMIL.has(n.tag)) return n // dropped by the parent below
    const defs = inDefs || ["defs", "clipPath", "mask", "symbol", "linearGradient", "radialGradient", "pattern"].includes(n.tag)
    const attrs = new Map(n.attrs)
    // Custom properties and var() (registry 13): resolved here, so the SVG compiler sees plain values.
    const vars = this.varsOf(n)
    const style = attrs.get("style")
    if (style && (style.value.includes("var(") || style.value.includes("--"))) {
      const kept = style.value.split(";").filter((d) => !d.trim().startsWith("--")).join(";")
      attrs.set("style", { value: resolveVars(kept, vars, style.at), at: style.at })
    }
    // CSS rules write their presentation values as attributes (style="..." still wins, as in CSS).
    const css = new Map([...this.cssFor(n)].map(([k, v]) => [k, { value: resolveVars(v.value, vars, v.at), at: v.at }]))
    for (const [k, v] of css) {
      if (CSS_PRESENTATION.has(k)) attrs.set(k, { value: v.value, at: v.at })
      // CSS d: path("...") on a <path> is its d.
      if (k === "d" && n.tag === "path") {
        const m = /^path\(\s*(["'])([\s\S]*)\1\s*\)$/.exec(v.value.trim())
        if (!m) fail(v.at, `can't read d "${v.value}" (use path("M ..."))`)
        attrs.set("d", { value: m![2]!, at: v.at })
      }
    }
    // Fill, stroke and the stroke's width and dashes as inherited, for an animated value's start.
    const styled = (k: string) => new RegExp(`(?:^|;)\\s*${k}\\s*:\\s*([^;]+)`).exec(attrs.get("style")?.value ?? "")?.[1]?.trim()
    const own = (k: keyof Inherit) => {
      const v = styled(k) ?? attrs.get(k)?.value.trim()
      return v === undefined || v === "inherit" ? inh[k] : v
    }
    const mine: Inherit = {
      fill: own("fill"),
      stroke: own("stroke"),
      "stroke-width": own("stroke-width"),
      "stroke-dasharray": own("stroke-dasharray"),
      "stroke-dashoffset": own("stroke-dashoffset"),
    }
    this.inherited.set(n, mine)
    const anims = n.children.filter((c) => SMIL.has(c.tag))
    const cssAnim = this.cssAnimations(n, css, attrs)
    const ownT = attrs.get("transform")
    const ownM = ownT ? this.transform(ownT) : null
    let ctm = ownM ? multiply(parentCtm, ownM) : parentCtm
    const children: SvgNode[] = []

    if (anims.length > 0 || cssAnim.length > 0) {
      if (defs && n.tag !== "stop") fail(n.at, `animations inside <defs>, clip paths, masks or gradients aren't supported: ${HINT}`)
      if (n === this.root) fail(n.at, `animating the <svg> itself isn't supported: animate the elements inside it, or animate the zn element that shows the SVG`)
      const id = attrs.get("id")?.value ?? this.newId()
      attrs.set("id", { value: id, at: n.at })
      const el: AnimatedElement = {
        id, tag: n.tag, at: n.at, tracks: [], ctm, parent: parentCtm, replaced: null, base: {}, baked: {}, baseOpacity: {}, baseColor: {},
        stroke: { width: 1, dashes: [], offset: 0, length: 0, contours: 0, pathLength: null }, dashMode: null, morph: null,
      }
      const byAttr = new Map<string, SourceTrack[]>()
      for (const a of anims) {
        const t = this.smilTrack(n, a, attrs, begins.get(a)!)
        byAttr.set(t.attr, [...(byAttr.get(t.attr) ?? []), t])
      }
      const motions = byAttr.get("motion") ?? []
      if (motions.length > 1) fail(motions[1]!.at, `two <animateMotion> on one element aren't supported: ${HINT}`)
      for (const list of byAttr.values()) el.tracks.push(list.length === 1 ? list[0]! : this.mergeSame(list))
      // Several SMIL transforms stack in document order; only translate, then rotate, then scale, all but the first
      // additive="sum" (a "replace" one would hide the ones before it), match a part's transform.
      const smilT = el.tracks.filter((t) => isTransform(t.attr))
      smilT.forEach((t, i) => {
        if (i > 0 && !t.additive) fail(t.at, `a second animateTransform without additive="sum" replaces the first, which isn't supported: ${HINT}`)
        if (i > 0 && ORDER.indexOf(t.attr) <= ORDER.indexOf(smilT[i - 1]!.attr)) {
          fail(t.at, `animateTransforms stack as translate, then rotate, then scale; this order isn't supported: ${HINT}`)
        }
      })
      if (smilT.length > 0 && cssAnim.some((t) => isTransform(t.attr))) fail(n.at, `a SMIL and a CSS transform animation on one element aren't supported: ${HINT}`)
      el.tracks.push(...cssAnim)
      if (el.tracks.filter((t) => t.attr === "motion").length > 1) fail(n.at, `an <animateMotion> and a CSS offset-path on one element aren't supported: ${HINT}`)
      if (n.tag === "stop" && el.tracks.some((t) => t.attr !== "stop-color" && t.attr !== "stop-opacity")) {
        fail(n.at, `a <stop> can animate its stop-color and stop-opacity only`)
      }
      // A transform animation replaces the element's own transform (unless additive="sum"): bake without it.
      const replacing = el.tracks.some((t) => isTransform(t.attr) && !t.additive)
      if (replacing) {
        el.replaced = ownM ?? IDENTITY
        el.ctm = parentCtm
        ctm = parentCtm
        attrs.delete("transform")
      }
      this.bakeValues(n, el, attrs)
      this.elements.push(el)
    }
    for (const c of n.children) {
      if (c.tag === "style" || SMIL.has(c.tag)) continue
      children.push(this.walk(c, ctm, begins, defs, mine))
    }
    return { ...n, attrs, children, text: n.tag === "style" ? "" : n.text }
  }

  private transform(a: SvgAttr): Matrix {
    try {
      return parseTransform(a.value)
    } catch (e) {
      return fail(a.at, (e as Error).message)
    }
  }

  /** Sets what the draw data bakes for an animated value, and keeps the values it replaces. */
  private bakeValues(n: SvgNode, el: AnimatedElement, attrs: Map<string, SvgAttr>) {
    const num = (k: string, def: number) => {
      const a = attrs.get(k)
      if (!a) return def
      const v = plainNumbers(a.value, a.at, k)
      return v[0] ?? def
    }
    for (const t of el.tracks) {
      const k = t.attr
      if (OPACITIES.has(k)) {
        el.baseOpacity[k] = clamp01(num(k, 1))
        attrs.set(k, { value: "1", at: t.at })
        if (k !== "opacity") {
          // The paint it fades, when that is a plain colour (its alpha can then carry the fade).
          const paint = k === "fill-opacity" ? "fill" : "stroke"
          const raw = this.inherited.get(n)?.[paint]
          const c = raw ? this.colorOf(raw) : null
          if (c !== null) el.baseColor[`_${paint}`] = c
        }
      } else if (k === "stop-color" || k === "stop-opacity") {
        // Both become the stop part's colour (motionParts); the draw data keeps the stop as it is.
        el.baseColor["stop-color"] = this.baseValue("stop-color", n, attrs, t.at)[0]!
        el.baseOpacity["stop-opacity"] = this.baseValue("stop-opacity", n, attrs, t.at)[0]!
      } else if (COLORS.has(k)) {
        el.baseColor[k] = this.baseValue(k, n, attrs, t.at)[0]!
      } else if (GEOMETRY[n.tag]?.includes(k)) {
        const base = num(k, 0)
        el.base[k] = base
        // A size that starts at 0 is baked at its largest value and scaled down from it.
        let baked = base
        if (SIZES.has(k) && base <= 0) baked = Math.max(...t.track.values.map((v) => v[0]!))
        if (SIZES.has(k) && !(baked > 0)) fail(t.at, `${k} is never more than 0, so nothing would show`)
        el.baked[k] = baked
        if (baked !== base) attrs.set(k, { value: String(baked), at: t.at })
      }
    }
    // Sizes not animated but needed for the centre (rect x + width / 2): keep as they are.
    for (const k of GEOMETRY[n.tag] ?? []) {
      if (!(k in el.base)) {
        el.base[k] = num(k, 0)
        el.baked[k] = el.base[k]!
      }
    }
    if (el.tracks.some((t) => STROKES.has(t.attr))) this.bakeStroke(n, el, attrs)
    if (el.tracks.some((t) => t.attr === "d")) el.morph = this.morphSig.get(n) ?? null
  }

  /**
   * Animated stroke width and dashes: keeps the values they start from, bakes a width that starts at 0 at its largest
   * (else the shape would have no stroke to change), and picks how dashes animate. One dash with a gap at least as
   * long as the line shows one piece of it: that is the part's trims (exact), and the shape is drawn solid. A fixed
   * pattern whose offset moves keeps its dashes and moves them with the part's dashOffset.
   */
  private bakeStroke(n: SvgNode, el: AnimatedElement, attrs: Map<string, SvgAttr>) {
    const inh = this.inherited.get(n)!
    const at = n.at
    const width = plainNumbers(inh["stroke-width"], at, "stroke-width")[0] ?? 1
    const dashes = inh["stroke-dasharray"] === "none" ? [] : this.dashList(inh["stroke-dasharray"], at)
    const offset = plainNumbers(inh["stroke-dashoffset"], at, "stroke-dashoffset")[0] ?? 0
    const line = lineOf(this.localPath(n, attrs))
    const plA = attrs.get("pathLength")
    const pathLength = plA ? plainNumbers(plA.value, plA.at, "pathLength")[0]! : null
    if (pathLength !== null && !(pathLength > 0)) fail(plA!.at, "pathLength must be more than 0")
    el.stroke = { width, dashes, offset, length: line.length, contours: line.contours, pathLength }

    const w = el.tracks.find((t) => t.attr === "stroke-width")
    if (w && width <= 0) {
      const most = Math.max(...w.track.values.map((v) => v[0]!))
      if (!(most > 0)) fail(w.at, "stroke-width is never more than 0, so nothing would show")
      attrs.set("stroke-width", { value: String(most), at: w.at })
    }

    const arr = el.tracks.find((t) => t.attr === "stroke-dasharray")
    const off = el.tracks.find((t) => t.attr === "stroke-dashoffset")
    if (!arr && !off) return
    const L = pathLength ?? line.length
    if (arr && arr.track.values.some((v) => v.length !== arr.track.values[0]!.length)) {
      fail(arr.at, "every keyframe of stroke-dasharray needs the same number of lengths")
    }
    // One dash and a long gap, on a line of one piece: only the first dash can show, whatever the offset.
    const dashAt = (j: number) => (arr ? arr.track.values[j]! : dashes)
    const offs = off ? off.track.values.map((v) => v[0]!) : [offset]
    const count = arr ? arr.track.values.length : 1
    let oneDash = line.contours === 1 && L > 0
    for (let j = 0; j < count && oneDash; j++) {
      const d = dashAt(j)
      if (d.length === 2 && d[0]! < 0) continue // "none": the whole line
      if (d.length !== 2 || d[0]! + d[1]! < L * (1 - 1e-6)) oneDash = false
      else for (const o of offs) if (o < -d[1]! - 1e-6 || d[0]! + d[1]! - o < L * (1 - 1e-6)) oneDash = false
    }
    if (oneDash) {
      el.dashMode = "trim"
      attrs.set("stroke-dasharray", { value: "none", at })
      attrs.set("stroke-dashoffset", { value: "0", at })
      attrs.delete("pathLength")
      return
    }
    if (arr) {
      fail(arr.at, `animating stroke-dasharray works for one dash with a gap at least as long as the line ("10 200" on a shorter line): draw the line with a part's trimStart / trimEnd instead (docs/svg.md §9)`)
    }
    if (dashes.length === 0) {
      // A moving offset on a solid stroke changes nothing (as in the browser).
      el.tracks = el.tracks.filter((t) => t !== off)
      return
    }
    if (pathLength !== null) fail(plA!.at, `pathLength with a moving dash pattern isn't supported: ${HINT}`)
    el.dashMode = "offset"
  }

  /** The element's outline in its own user units, for the length its dashes run along. */
  private localPath(n: SvgNode, attrs: Map<string, SvgAttr>): PathCmd[] {
    const num = (k: string, def = 0) => {
      const a = attrs.get(k)
      return a ? (plainNumbers(a.value, a.at, k)[0] ?? def) : def
    }
    switch (n.tag) {
      case "path": {
        const d = attrs.get("d")
        if (!d) return []
        try {
          return parsePathData(d.value)
        } catch (e) {
          return fail(d.at, (e as Error).message)
        }
      }
      case "circle":
        return num("r") > 0 ? ellipsePath(num("cx"), num("cy"), num("r"), num("r")) : []
      case "ellipse":
        return num("rx") > 0 && num("ry") > 0 ? ellipsePath(num("cx"), num("cy"), num("rx"), num("ry")) : []
      case "rect": {
        const w = num("width")
        const h = num("height")
        const rx = Math.min(attrs.has("rx") ? num("rx") : num("ry"), w / 2)
        const ry = Math.min(attrs.has("ry") ? num("ry") : num("rx"), h / 2)
        return w > 0 && h > 0 ? rectPath(num("x"), num("y"), w, h, rx, ry) : []
      }
      case "line":
        return [["M", num("x1"), num("y1")], ["L", num("x2"), num("y2")]]
      case "polyline":
      case "polygon": {
        const p = attrs.get("points")
        return p ? polyPath(plainNumbers(p.value, p.at, "points"), n.tag === "polygon") : []
      }
    }
    return fail(n.at, `animated dashes or stroke width on <${n.tag}> aren't supported (only on shapes)`)
  }

  /**
   * A stroke-dasharray value as lengths (an odd list is repeated, as SVG does). "none" (a solid line) is [-1, -1]:
   * it can only be the one-dash case's "whole line", where it stands for trims 0 to 1.
   */
  private dashList(s: string, at: string): number[] {
    if (s.trim() === "none") return [-1, -1]
    const list = plainNumbers(s, at, "stroke-dasharray")
    if (list.some((x) => x < 0)) fail(at, "stroke-dasharray can't have negative lengths")
    return list.length % 2 === 1 ? [...list, ...list] : list
  }

  /** One keyframe of a morph: the path's numbers, in its M / C / Z form. Every keyframe must have the same commands. */
  private pathNums(s: string, at: string, n: SvgNode): number[] {
    let cmds: PathCmd[]
    try {
      cmds = parsePathData(s)
    } catch (e) {
      return fail(at, (e as Error).message)
    }
    return this.morphNums(cmds, at, n)
  }

  /** One keyframe of a points morph (polygon / polyline): its outline as a path, like pathNums. */
  private pointsNums(s: string, at: string, n: SvgNode): number[] {
    const list = plainNumbers(s, at, "points")
    if (list.length < 2 || list.length % 2 !== 0) fail(at, `points "${s}" needs pairs of numbers`)
    return this.morphNums(polyPath(list, n.tag === "polygon"), at, n)
  }

  private morphNums(cmds: PathCmd[], at: string, n: SvgNode): number[] {
    const { sig, nums } = cubicForm(cmds)
    const known = this.morphSig.get(n)
    if (known === undefined) this.morphSig.set(n, sig)
    else if (known !== sig) {
      fail(at, `the paths of this morph don't match (${known.length} and ${sig.length} commands): every keyframe needs the same commands in the same order, as SMIL itself needs; ${HINT}`)
    }
    return nums
  }

  // ---- SMIL ----------------------------------------------------------------------------------------------------

  private smilTrack(el: SvgNode, a: SvgNode, attrs: Map<string, SvgAttr>, begins: number[]): SourceTrack {
    const at = a.at
    if (a.attrs.has("href") || a.attrs.has("xlink:href")) fail(at, `an animation that points at another element (href) isn't supported: put it inside that element`)
    const accumulate = a.attrs.get("accumulate")?.value === "sum"
    if (accumulate) fail(at, `accumulate="sum" isn't supported: ${HINT}`)
    if (a.tag === "animateMotion") return this.motionTrack(el, a, begins)
    const name = a.attrs.get("attributeName")?.value
    if (!name) return fail(at, "an animation needs attributeName")
    if (a.attrs.get("attributeType")?.value === "XML" && name === "style") fail(at, `animating style isn't supported: ${HINT}`)
    let attr = name
    let kind = ""
    if (a.tag === "animateTransform") {
      if (name !== "transform") fail(at, `animateTransform on "${name}" isn't supported (only transform)`)
      kind = a.attrs.get("type")?.value ?? "translate"
      if (!ORDER.includes(kind)) fail(at, `animateTransform type="${kind}" isn't supported (translate, rotate, skewX, skewY, scale): ${HINT}`)
      attr = kind
    } else {
      this.checkAnimatable(el, name, at)
    }
    const read = (s: string): number[] => this.smilValue(attr, s, at, el)
    // A polygon's or polyline's points morph like a path's d (the same point count in every keyframe).
    const out = (t: SourceTrack): SourceTrack => (attr === "points" ? { ...t, attr: "d" } : t)
    if (a.tag === "set") {
      // <set>: one value from its begin, for its dur (none: until the end), then back unless fill="freeze".
      const to = a.attrs.get("to")?.value
      if (to === undefined) return fail(at, "<set> needs a to value")
      const v = read(to)
      const d = this.dur(a)
      const forever = !Number.isFinite(d)
      // With no dur it holds forever: 1 ms is enough on its own, a chain needs a play as long as its period.
      const len = forever ? (begins.length > 1 ? 120_000 : 1) : d
      const rc = a.attrs.get("repeatCount")?.value
      const plays = forever ? 1 : rc === "indefinite" ? Infinity : rc === undefined ? 1 : Number(rc)
      const freeze = forever || a.attrs.get("fill")?.value === "freeze"
      const base = this.baseValue(attr, el, attrs, at)
      const { track, cycle } = this.smilTiming({ t: [0, len], v: [v, v], e: [LIN] }, len, plays, freeze, base, begins, at)
      if (this.tapped.has(a)) track.tap = true
      return out({ attr, track, at, cycle, freeze })
    }
    let values: number[][]
    const vAttr = a.attrs.get("values")
    if (vAttr) values = vAttr.value.split(";").map((s) => s.trim()).filter((s) => s !== "").map(read)
    else {
      const from = a.attrs.get("from")?.value
      const to = a.attrs.get("to")?.value
      const by = a.attrs.get("by")?.value
      const start = from !== undefined ? read(from) : this.baseValue(attr, el, attrs, at)
      if (to !== undefined) values = [start, read(to)]
      else if (by !== undefined) values = [start, lerpV(start, start.map((x, i) => x + read(by)[i]!), 1)]
      else return fail(at, "an animation needs values, or from / to / by")
    }
    if (values.length < 1) fail(at, "an animation needs values")
    if (values.length === 1) values = [values[0]!, values[0]!]
    const width = values[0]!.length
    if (values.some((v) => v.length !== width)) fail(at, "every value of one animation needs the same number of numbers")
    if (attr === "rotate") {
      const c = values.map((v) => `${v[1]},${v[2]}`)
      if (new Set(c).size > 1) fail(at, `a rotation whose centre moves isn't supported: ${HINT}`)
    }

    const calc = a.attrs.get("calcMode")?.value ?? (a.tag === "animateMotion" ? "paced" : "linear")
    if (!["linear", "spline", "discrete", "paced"].includes(calc)) fail(at, `calcMode "${calc}" isn't valid`)
    const kt = a.attrs.get("keyTimes")
    const dur = this.dur(a)
    let curve: Curve
    if (calc === "discrete") {
      const times = kt ? plainNumbers(kt.value.replace(/;/g, " "), kt.at, "keyTimes") : values.map((_, i) => i / values.length)
      if (times.length !== values.length) fail(at, "keyTimes needs one time per value")
      const t = [...times.map((x) => x * dur), dur]
      const v = [...values, values[values.length - 1]!]
      const e: Ease[] = [...values.slice(0, -1).map((): Ease => ({ k: "step" })), LIN]
      curve = { t, v, e }
    } else {
      const times = kt ? plainNumbers(kt.value.replace(/;/g, " "), kt.at, "keyTimes") : values.map((_, i) => i / (values.length - 1))
      if (times.length !== values.length) fail(at, "keyTimes needs one time per value")
      if (times[0] !== 0 || Math.abs(times[times.length - 1]! - 1) > 1e-6) fail(at, "keyTimes must start at 0 and end at 1")
      let e: Ease[] = values.slice(1).map(() => LIN)
      if (calc === "spline") {
        const ks = a.attrs.get("keySplines")
        if (!ks) return fail(at, 'calcMode="spline" needs keySplines')
        const list = ks.value.split(";").map((s) => s.trim()).filter((s) => s !== "")
        if (list.length !== values.length - 1) fail(ks.at, "keySplines needs one entry per segment (one less than values)")
        e = list.map((s) => ({ k: "bez", b: bezier(s, ks.at) }) as Ease)
      }
      curve = { t: times.map((x) => x * dur), v: values, e }
    }

    const rc = a.attrs.get("repeatCount")?.value
    const plays = rc === "indefinite" ? Infinity : rc === undefined ? 1 : Number(rc)
    const freeze = a.attrs.get("fill")?.value === "freeze"
    const base = this.baseValue(attr, el, attrs, at)
    const { track, cycle } = this.smilTiming(curve, dur, plays, freeze, base, begins, at)
    if (this.tapped.has(a)) track.tap = true
    const res: SourceTrack = { attr, track, at, additive: a.attrs.get("additive")?.value === "sum", cycle, freeze }
    if (attr === "rotate") res.origin = [values[0]![1]!, values[0]![2]!]
    if (attr === "scale" || attr === "skewX" || attr === "skewY") res.origin = [0, 0]
    return out(res)
  }

  /**
   * <animateMotion>: a path (its `path`, an <mpath>, or a line through `values` / from / to / by) in the parent's user
   * space, and a track of where the element is on it (0–1 of its length; -1 = not moved). The element's own origin
   * rides on the path; rotate="auto" / "auto-reverse" turns it with the path's direction.
   */
  private motionTrack(el: SvgNode, a: SvgNode, begins: number[]): SourceTrack {
    const at = a.at
    if (a.attrs.has("origin") && a.attrs.get("origin")!.value !== "default") fail(at, `animateMotion origin="${a.attrs.get("origin")!.value}" isn't valid`)
    const point = (s: string, what: string): [number, number] => {
      const n = plainNumbers(s, at, what)
      if (n.length !== 2) fail(at, `${what} "${s}" needs two numbers: x, y`)
      return [n[0]!, n[1]!]
    }
    const parsePath = (d: string, where: string): PathCmd[] => {
      try {
        return parsePathData(d)
      } catch (e) {
        return fail(where, (e as Error).message)
      }
    }
    const mpath = a.children.find((c) => c.tag === "mpath")
    let path: PathCmd[]
    // Vertices of a line through values: their length fractions are the keyframes of calcMode="linear".
    let vertices: Array<[number, number]> | null = null
    if (mpath) {
      const ref = (mpath.attrs.get("href") ?? mpath.attrs.get("xlink:href"))?.value.trim() ?? ""
      const target = ref.startsWith("#") ? this.byId.get(ref.slice(1)) : undefined
      if (!target || target.tag !== "path" || !target.attrs.get("d")) return fail(mpath.at, `<mpath href="${ref}"> needs the id of a <path> with a d`)
      path = parsePath(target.attrs.get("d")!.value, target.attrs.get("d")!.at)
    } else if (a.attrs.has("path")) {
      path = parsePath(a.attrs.get("path")!.value, a.attrs.get("path")!.at)
    } else {
      const vAttr = a.attrs.get("values")
      if (vAttr) vertices = vAttr.value.split(";").map((s) => s.trim()).filter((s) => s !== "").map((s) => point(s, "values"))
      else {
        const from = a.attrs.get("from")?.value
        const to = a.attrs.get("to")?.value
        const by = a.attrs.get("by")?.value
        const start: [number, number] = from !== undefined ? point(from, "from") : [0, 0]
        if (to !== undefined) vertices = [start, point(to, "to")]
        else if (by !== undefined) {
          const d = point(by, "by")
          vertices = [start, [start[0] + d[0], start[1] + d[1]]]
        } else return fail(at, "<animateMotion> needs a path, an <mpath>, values, or from / to / by")
      }
      if (vertices!.length === 1) vertices!.push(vertices![0]!)
      path = vertices!.map((p, i): PathCmd => [i === 0 ? "M" : "L", p[0], p[1]])
    }
    if (path.length === 0) fail(at, "the motion path is empty")

    // How it turns: auto follows the path's direction, auto-reverse the other way, a number is a fixed angle.
    const rot = a.attrs.get("rotate")?.value.trim() ?? "0"
    let mode: 0 | 1 | 2 = 0
    let angle = 0
    if (rot === "auto") mode = 1
    else if (rot === "auto-reverse") mode = 2
    else angle = plainNumbers(rot, at, "rotate")[0] ?? 0

    // Where on the path, over one play: keyPoints at keyTimes, else evenly by length (paced), or, for a line through
    // values with calcMode="linear" / "spline" / "discrete", its vertices at equal times.
    const calc = a.attrs.get("calcMode")?.value ?? "paced"
    if (!["linear", "spline", "discrete", "paced"].includes(calc)) fail(at, `calcMode "${calc}" isn't valid`)
    const kt = a.attrs.get("keyTimes")
    const kp = a.attrs.get("keyPoints")
    let points: number[]
    if (kp) {
      points = plainNumbers(kp.value.replace(/;/g, " "), kp.at, "keyPoints")
      if (points.some((p) => p < 0 || p > 1)) fail(kp.at, "keyPoints must be between 0 and 1")
      if (!kt) fail(at, "keyPoints needs keyTimes")
    } else if (vertices && calc !== "paced") {
      const lens = [0]
      for (let i = 1; i < vertices.length; i++) lens.push(lens[i - 1]! + Math.hypot(vertices[i]![0] - vertices[i - 1]![0], vertices[i]![1] - vertices[i - 1]![1]))
      const total = lens[lens.length - 1]!
      points = lens.map((l) => (total > 0 ? l / total : 0))
    } else {
      points = [0, 1]
    }
    const dur = this.dur(a)
    let curve: Curve
    if (calc === "discrete" && points.length > 1) {
      const times = kt ? plainNumbers(kt.value.replace(/;/g, " "), kt.at, "keyTimes") : points.map((_, i) => i / points.length)
      if (times.length !== points.length) fail(at, "keyTimes needs one time per key point")
      curve = {
        t: [...times.map((x) => x * dur), dur],
        v: [...points.map((p) => [p]), [points[points.length - 1]!]],
        e: [...points.slice(0, -1).map((): Ease => ({ k: "step" })), LIN],
      }
    } else {
      const times = kt && (kp || calc !== "paced") ? plainNumbers(kt.value.replace(/;/g, " "), kt.at, "keyTimes") : points.map((_, i) => i / (points.length - 1))
      if (times.length !== points.length) fail(at, "keyTimes needs one time per key point")
      if (times[0] !== 0 || Math.abs(times[times.length - 1]! - 1) > 1e-6) fail(at, "keyTimes must start at 0 and end at 1")
      let e: Ease[] = points.slice(1).map(() => LIN)
      if (calc === "spline") {
        const ks = a.attrs.get("keySplines")
        if (!ks) return fail(at, 'calcMode="spline" needs keySplines')
        const list = ks.value.split(";").map((s) => s.trim()).filter((s) => s !== "")
        if (list.length !== points.length - 1) fail(ks.at, "keySplines needs one entry per segment")
        e = list.map((s) => ({ k: "bez", b: bezier(s, ks.at) }) as Ease)
      }
      curve = { t: times.map((x) => x * dur), v: points.map((p) => [p]), e }
    }
    const rc = a.attrs.get("repeatCount")?.value
    const plays = rc === "indefinite" ? Infinity : rc === undefined ? 1 : Number(rc)
    const freeze = a.attrs.get("fill")?.value === "freeze"
    const { track, cycle } = this.smilTiming(curve, dur, plays, freeze, [-1], begins, at)
    if (this.tapped.has(a)) track.tap = true
    return { attr: "motion", track, at, cycle, freeze, motion: { path, mode, angle } }
  }

  /**
   * One SMIL animation's starts → how zn plays it (one cycle of a chain, or a plain loop), and for a loop, its cycle
   * from its own start (so several animations of one attribute can be merged).
   */
  private smilTiming(play: Curve, dur: number, plays: number, freeze: boolean, base: number[], begins: number[], at: string): { track: Track; cycle?: Cycle } {
    const H = 120_000
    if (begins.length === 0) fail(at, `this animation never starts (its begin refers to an animation that doesn't run): ${HINT}`)
    if (begins.length === 1) {
      const b = begins[0]!
      if (plays === Infinity) {
        return { track: trackOf(b < 0 ? rotate(play, -b) : play, Math.max(0, b), -1, false), cycle: { curve: play, period: dur, begin: b, active: dur } }
      }
      if (b < 0) fail(at, `a begin before 0 on an animation that doesn't loop isn't supported: ${HINT}`)
      let c = unroll(play, plays)
      if (!freeze) c = holdThen(c, base, 0)
      // Before its begin the element shows its own value; a delay would show the first keyframe. So a begin whose
      // first value differs is a hold of the own value, then a jump.
      if (b > 0 && base.length === c.v[0]!.length && base.some((x, i) => Math.abs(x - c.v[0]![i]!) > 1e-9)) {
        c = { t: [0, ...c.t.map((x) => x - c.t[0]! + b)], v: [base, ...c.v], e: [{ k: "step" }, ...c.e] }
        return { track: trackOf(c, 0, 1, false) }
      }
      return { track: trackOf(c, b, 1, false) }
    }
    // A chain: starts every P ms. Each start plays for min(active time, P), then holds (fill) until the next.
    const gaps = begins.slice(1).map((t, i) => t - begins[i]!)
    const P = gaps[gaps.length - 1]!
    if (gaps.some((g) => Math.abs(g - P) > 2) || begins[begins.length - 1]! < H - 3 * P) {
      fail(at, `this animation's start times don't repeat evenly (its begin chain), so it can't be one loop: ${HINT}`)
    }
    const activeTime = Math.min(plays === Infinity ? Infinity : dur * plays, P)
    const runs = Math.ceil(activeTime / dur - 1e-9)
    let c = slice(unroll(play, Math.max(1, runs)), 0, activeTime)
    if (activeTime < P - 1e-6) c = holdThen(c, freeze ? curveAt(c, activeTime) : base, P - activeTime)
    const b = begins[0]!
    return { track: trackOf(b < 0 ? rotate(c, -b) : c, Math.max(0, b), -1, false), cycle: { curve: c, period: P, begin: b, active: activeTime } }
  }

  /**
   * Several SMIL animations of one attribute on one element, as one track. SMIL's rule: the one that started last
   * sets the value (and a frozen one keeps it until another starts). All must loop with the same period and freeze.
   */
  private mergeSame(list: SourceTrack[]): SourceTrack {
    const first = list[0]!
    for (const t of list) {
      if (!t.cycle) fail(t.at, `two animations of "${t.attr}" on one element, one of them not looping, aren't supported: ${HINT}`)
      if (Math.abs(t.cycle!.period - first.cycle!.period) > 2) fail(t.at, `two animations of "${t.attr}" on one element repeat at different speeds, which isn't supported: ${HINT}`)
    }
    const P = first.cycle!.period
    const t0 = Math.min(...list.map((t) => t.cycle!.begin))
    // Each start within one period from t0; later in the file wins a tie (SMIL: document order).
    const starts = list.map((t, i) => ({ t, i, at: (((t.cycle!.begin - t0) % P) + P) % P })).sort((a, b) => a.at - b.at || a.i - b.i)
    const uniq = starts.filter((s, j) => j + 1 >= starts.length || Math.abs(starts[j + 1]!.at - s.at) > 1e-6)
    let curve: Curve | null = null
    uniq.forEach((s, j) => {
      const end = j + 1 < uniq.length ? uniq[j + 1]!.at : P + uniq[0]!.at
      // Without fill="freeze" SMIL would drop to a lower animation after this one ends: fine only when the next
      // one starts before that (a chain with no gap).
      if (!s.t.freeze && end - s.at > s.t.cycle!.active + 2) {
        fail(s.t.at, `two animations of "${s.t.attr}" on one element with a gap between them need fill="freeze": ${HINT}`)
      }
      const c0 = s.t.cycle!.curve
      const piece = slice(c0, c0.t[0]!, c0.t[0]! + (end - s.at))
      curve = curve ? concat(curve, piece) : piece
    })
    const c = curve! as Curve
    const lead = uniq[0]!.at // 0, since t0 is the earliest start
    if (list.some((t) => !!t.track.tap !== !!first.track.tap)) fail(first.at, `two animations of "${first.attr}" on one element, one starting on a tap and one not, aren't supported: ${HINT}`)
    const track = trackOf(rotate(c, -lead), Math.max(0, t0), -1, false)
    if (first.track.tap) track.tap = true
    return { ...first, track }
  }

  /** The value of [attr] when nothing animates it (for from-less animations and fill="remove"). */
  private baseValue(attr: string, el: SvgNode, attrs: Map<string, SvgAttr>, at: string): number[] {
    if (attr === "rotate") return [0, 0, 0]
    if (attr === "scale") return [1, 1]
    if (attr === "translate") return [0, 0]
    if (attr === "skewX" || attr === "skewY") return [0]
    if (attr === "d") {
      const d = attrs.get("d")
      if (!d) return fail(at, "a morph needs the path's own d to start from")
      return this.pathNums(d.value, d.at, el)
    }
    if (attr === "points") {
      const p = attrs.get("points")
      if (!p) return fail(at, "a points morph needs the shape's own points to start from")
      return this.pointsNums(p.value, p.at, el)
    }
    if (STROKES.has(attr)) {
      const v = this.inherited.get(el)?.[attr as "stroke-width"] ?? INHERIT_START[attr as "stroke-width"]
      return attr === "stroke-dasharray" ? this.dashList(v, at) : [plainNumbers(v, at, attr)[0] ?? 0]
    }
    if (attr === "stop-color" || attr === "stop-opacity") {
      // A stop's own value (style="stop-color:..." wins, as in CSS); stops don't inherit.
      const a = attrs.get(attr)?.value
      const st = new RegExp(`(?:^|;)\\s*${attr}\\s*:\\s*([^;]+)`).exec(attrs.get("style")?.value ?? "")?.[1]
      const v = (st ?? a ?? (attr === "stop-color" ? "black" : "1")).trim()
      if (attr === "stop-opacity") return [clamp01(plainNumbers(v, at, attr)[0] ?? 1)]
      const c = this.colorOf(v)
      if (c === null) fail(at, `an animated stop-color needs a plain colour on the stop to start from, got "${v}"`)
      return [c!]
    }
    const raw = attrs.get(attr)?.value
    if (COLORS.has(attr)) {
      const v = this.inherited.get(el)?.[attr as "fill" | "stroke"] ?? raw ?? (attr === "fill" ? "black" : "none")
      const c = this.colorOf(v.trim())
      if (c === null) fail(at, `an animated ${attr} needs a plain colour on the element to start from (not currentColor, none or a gradient), got "${v}"`)
      return [c!]
    }
    if (raw === undefined) return [OPACITIES.has(attr) ? 1 : 0]
    return [plainNumbers(raw, at, attr)[0] ?? 0]
  }

  private smilValue(attr: string, s: string, at: string, el: SvgNode): number[] {
    if (attr === "d") return this.pathNums(s, at, el)
    if (attr === "points") return this.pointsNums(s, at, el)
    if (attr === "stroke-dasharray") return this.dashList(s, at)
    if (COLORS.has(attr) || attr === "stop-color") {
      const c = this.colorOf(s.trim())
      if (c === null) fail(at, `can't read colour "${s}" in an animation`)
      return [c!]
    }
    const n = plainNumbers(s, at, attr)
    if (attr === "rotate") return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0]
    if (attr === "scale") return [n[0] ?? 1, n[1] ?? n[0] ?? 1]
    if (attr === "translate") return [n[0] ?? 0, n[1] ?? 0]
    if (attr === "skewX" || attr === "skewY") return [n[0] ?? 0]
    if (n.length !== 1) fail(at, `"${attr}" takes one number, got "${s}"`)
    if (OPACITIES.has(attr) || attr === "stop-opacity") return [clamp01(n[0]!)]
    return n
  }

  /** What an animation (SMIL or CSS) may change on [el], with a hint for the rest. */
  private checkAnimatable(el: SvgNode, name: string, at: string) {
    if (el.tag === "stop") {
      if (name === "stop-color" || name === "stop-opacity") return
      fail(at, `animating "${name}" on a <stop> isn't supported (stop-color and stop-opacity are)`)
    }
    if (name === "stop-color" || name === "stop-opacity") fail(at, `${name} animates on a gradient's <stop> only`)
    if (OPACITIES.has(name) || COLORS.has(name) || STROKES.has(name)) return
    if (GEOMETRY[el.tag]?.includes(name)) return
    if (name === "d") {
      if (el.tag !== "path") fail(at, `animating d works on a <path> only, not <${el.tag}>`)
      return
    }
    if (name === "points" && (el.tag === "polygon" || el.tag === "polyline")) return
    if (["x", "y", "width", "height", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "points"].includes(name)) {
      fail(at, `animating "${name}" on <${el.tag}> isn't supported (geometry animates on <circle>, <ellipse> and <rect>): ${HINT}`)
    }
    fail(at, `animating "${name}" isn't supported: ${HINT}`)
  }

  // ---- CSS -----------------------------------------------------------------------------------------------------

  private parseCss(text: string, at: string) {
    this.sheet(text.replace(/\/\*[\s\S]*?\*\//g, ""), at)
  }

  /** Rules and @keyframes of one style sheet, or of an @media block that applies (registry 13). */
  private sheet(src: string, at: string) {
    let i = 0
    const skipWs = () => {
      while (i < src.length && /\s/.test(src[i]!)) i++
    }
    /** The text up to the matching close brace of the block that starts at src[i] === "{". */
    const block = (): string => {
      let depth = 0
      const start = i + 1
      for (; i < src.length; i++) {
        if (src[i] === "{") depth++
        else if (src[i] === "}") {
          depth--
          if (depth === 0) {
            const body = src.slice(start, i)
            i++
            return body
          }
        }
      }
      return fail(at, "a CSS block isn't closed")
    }
    for (;;) {
      skipWs()
      if (i >= src.length) break
      const open = src.indexOf("{", i)
      if (open < 0) fail(at, `can't read the CSS near "${src.slice(i, i + 30).trim()}"`)
      const head = src.slice(i, open).trim()
      i = open
      const body = block()
      if (head.startsWith("@keyframes") || head.startsWith("@-webkit-keyframes")) {
        const name = head.replace(/^@(-webkit-)?keyframes\s+/, "").trim()
        this.keyframes.set(name, { stops: this.parseStops(body, at), at })
        continue
      }
      if (head.startsWith("@media")) {
        if (mediaApplies(head.slice(6).trim(), at)) this.sheet(body, at)
        continue
      }
      if (head.startsWith("@")) fail(at, `CSS ${head.split(/\s/)[0]} isn't supported in an SVG (only plain rules, @keyframes and @media for prefers-reduced-motion)`)
      this.rules.push({ selectors: splitTop(head).map((s) => this.selector(s.trim(), at)), decls: this.decls(body, at), order: this.ruleOrder++, at })
    }
  }

  private parseStops(body: string, at: string): Keyframes["stops"] {
    const out: Keyframes["stops"] = []
    const re = /([^{}]+)\{([^}]*)\}/g
    for (let m = re.exec(body); m; m = re.exec(body)) {
      const offsets = m[1]!.split(",").map((s) => {
        const t = s.trim()
        if (t === "from") return 0
        if (t === "to") return 1
        const p = /^([\d.]+)%$/.exec(t)
        if (!p) return fail(at, `can't read keyframe "${t}"`)
        return Number(p[1]) / 100
      })
      out.push({ offsets, decls: this.decls(m[2]!, at) })
    }
    return out
  }

  private decls(body: string, at: string): Map<string, string> {
    const out = new Map<string, string>()
    // Split on ";" outside brackets (cubic-bezier(0.33, .66, ...) has commas, not semicolons, so a plain split works).
    for (const d of body.split(";")) {
      const c = d.indexOf(":")
      if (c < 0) {
        if (d.trim() !== "") fail(at, `can't read the CSS "${d.trim()}"`)
        continue
      }
      out.set(d.slice(0, c).trim().toLowerCase(), d.slice(c + 1).trim().replace(/\s*!important$/, ""))
    }
    return out
  }

  /**
   * A selector as compound parts, each with how it joins the one before it (" " inside, ">" child, "+" right after,
   * "~" after). A compound: a tag or *, #id, .class, [attr] / [attr=v] (also ~= ^= $= *=), :first-child,
   * :last-child, :nth-child(an+b | odd | even), :root, and :not() of one simple part.
   */
  private selector(s: string, at: string): Selector[] {
    const bad = (): never => fail(at, `CSS selector "${s}" isn't supported (use tags, .class, #id, [attr], :nth-child() and the combinators " ", >, + and ~)`)
    const out: Selector[] = []
    let i = 0
    let comb: Selector["comb"] = undefined
    const ident = () => {
      const m = /^-?[A-Za-z_][\w-]*/.exec(s.slice(i))
      if (!m) return bad()
      i += m[0].length
      return m[0]
    }
    const simple = (sel: Selector): boolean => {
      const c = s[i]
      if (c === "#") {
        i++
        sel.id = ident()
      } else if (c === ".") {
        i++
        sel.classes.push(ident())
      } else if (c === "[") {
        const m = /^\[\s*([\w:-]+)\s*(?:([~^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/.exec(s.slice(i))
        if (!m) return bad()
        i += m[0].length
        sel.attrs.push({ name: m[1]!, op: m[2] ?? "", value: m[3] ?? m[4] ?? m[5] ?? "" })
      } else if (c === ":") {
        const m = /^:([\w-]+)(?:\(([^()]*)\))?/.exec(s.slice(i))
        if (!m) return bad()
        i += m[0].length
        const name = m[1]!
        if (name === "first-child") sel.nth.push([0, 1, false])
        else if (name === "last-child") sel.nth.push([0, 1, true])
        else if (name === "nth-child" || name === "nth-last-child") sel.nth.push([...nthOf(m[2] ?? "", bad), name === "nth-last-child"])
        else if (name === "root") sel.root = true
        else if (name === "not" && m[2] !== undefined) {
          const inner = this.selector(m[2].trim(), at)
          if (inner.length !== 1) return bad()
          sel.not.push(inner[0]!)
        } else return bad()
      } else return false
      return true
    }
    while (i < s.length) {
      const sel: Selector = { classes: [], attrs: [], nth: [], not: [], comb }
      let any = true
      if (s[i] === "*") i++
      else if (/[A-Za-z]/.test(s[i]!)) sel.tag = ident()
      else any = false
      while (i < s.length && simple(sel)) any = true
      if (!any) return bad()
      out.push(sel)
      const ws = /^\s*/.exec(s.slice(i))![0].length
      i += ws
      if (i >= s.length) break
      if (s[i] === ">" || s[i] === "+" || s[i] === "~") {
        comb = s[i] as ">" | "+" | "~"
        i++
        i += /^\s*/.exec(s.slice(i))![0].length
      } else if (ws > 0) comb = " "
      else return bad()
    }
    if (out.length === 0) return bad()
    return out
  }

  private parents = new Map<SvgNode, SvgNode>()
  private inherited = new Map<SvgNode, Inherit>()
  /** Per morphing element: the commands its first path had (every other keyframe must match). */
  private morphSig = new Map<SvgNode, string>()

  private matches(n: SvgNode, sel: Selector[]): boolean {
    const one = (x: SvgNode, s: Selector): boolean => {
      if (s.tag && x.tag !== s.tag) return false
      if (s.id && x.attrs.get("id")?.value !== s.id) return false
      if (s.root && x !== this.root) return false
      const cls = (x.attrs.get("class")?.value ?? "").split(/\s+/)
      if (!s.classes.every((c) => cls.includes(c))) return false
      for (const a of s.attrs) {
        const v = x.attrs.get(a.name)?.value
        if (v === undefined) return false
        if (a.op === "=" && v !== a.value) return false
        if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false
        if (a.op === "^=" && !(a.value !== "" && v.startsWith(a.value))) return false
        if (a.op === "$=" && !(a.value !== "" && v.endsWith(a.value))) return false
        if (a.op === "*=" && !(a.value !== "" && v.includes(a.value))) return false
      }
      if (s.nth.length > 0) {
        const sibs = this.parentOf(x)?.children ?? [x]
        const at = sibs.indexOf(x)
        for (const [A, B, fromEnd] of s.nth) {
          // Position counted from 1; it matches when pos = A·k + B for some k ≥ 0.
          const pos = fromEnd ? sibs.length - at : at + 1
          const ok = A === 0 ? pos === B : (pos - B) / A >= 0 && Number.isInteger((pos - B) / A)
          if (!ok) return false
        }
      }
      return !s.not.some((m) => one(x, m))
    }
    // Right to left; " " and "~" try every candidate (so a.b > c d works however the tree is).
    const at = (x: SvgNode, k: number): boolean => {
      const s = sel[k]!
      if (!one(x, s)) return false
      if (k === 0) return true
      const sibs = this.parentOf(x)?.children ?? []
      const i = sibs.indexOf(x)
      switch (s.comb) {
        case ">": {
          const p = this.parentOf(x)
          return p !== undefined && at(p, k - 1)
        }
        case "+":
          return i > 0 && at(sibs[i - 1]!, k - 1)
        case "~":
          for (let j = i - 1; j >= 0; j--) if (at(sibs[j]!, k - 1)) return true
          return false
        default:
          for (let p = this.parentOf(x); p; p = this.parentOf(p)) if (at(p, k - 1)) return true
          return false
      }
    }
    return at(n, sel.length - 1)
  }

  private varCache = new Map<SvgNode, Map<string, string>>()

  /** Custom properties (--name) of [n] (registry 13): its parent's, then its own rules', then its style's. */
  private varsOf(n: SvgNode): Map<string, string> {
    const hit = this.varCache.get(n)
    if (hit) return hit
    const p = this.parentOf(n)
    const out = new Map(p ? this.varsOf(p) : [])
    for (const [k, v] of this.cssFor(n)) if (k.startsWith("--")) out.set(k, v.value)
    for (const d of (n.attrs.get("style")?.value ?? "").split(";")) {
      const c = d.indexOf(":")
      if (c > 0 && d.trim().startsWith("--")) out.set(d.slice(0, c).trim().toLowerCase(), d.slice(c + 1).trim())
    }
    this.varCache.set(n, out)
    return out
  }

  private parentOf(n: SvgNode): SvgNode | undefined {
    if (this.parents.size === 0) {
      const fill = (p: SvgNode) => {
        for (const c of p.children) {
          this.parents.set(c, p)
          fill(c)
        }
      }
      fill(this.root)
    }
    return this.parents.get(n)
  }

  /** The CSS declarations that apply to [n], in cascade order (specificity, then source order). */
  private cssFor(n: SvgNode): Map<string, { value: string; at: string }> {
    const out = new Map<string, { value: string; at: string }>()
    if (this.rules.length === 0) return out
    const hits: Array<{ spec: number; order: number; rule: Rule }> = []
    for (const r of this.rules) {
      let best = -1
      for (const sel of r.selectors) {
        if (!this.matches(n, sel)) continue
        const spec = sel.reduce((a, s) => a + specificity(s), 0)
        best = Math.max(best, spec)
      }
      if (best >= 0) hits.push({ spec: best, order: r.order, rule: r })
    }
    hits.sort((a, b) => a.spec - b.spec || a.order - b.order)
    // Re-inserted so the map's order is the cascade order: a longhand after the `animation` shorthand wins over it.
    for (const h of hits) {
      for (const [k, v] of h.rule.decls) {
        out.delete(k)
        out.set(k, { value: v, at: h.rule.at })
      }
    }
    return out
  }

  /** The element's CSS animations, one track per animated property. */
  private cssAnimations(n: SvgNode, css: Map<string, { value: string; at: string }>, attrs: Map<string, SvgAttr>): SourceTrack[] {
    for (const k of css.keys()) {
      if (CSS_PRESENTATION.has(k) || k.startsWith("animation") || k === "transform-origin" || k === "transform-box") continue
      if (k === "transform" || OFFSET_PROPS.has(k) || k.startsWith("--") || (k === "d" && n.tag === "path")) continue
      fail(css.get(k)!.at, `CSS property "${k}" isn't supported in an SVG`)
    }
    const anim = this.animationList(css)
    const motion = this.cssMotion(css)
    const motionLength = motion ? lineOf(motion.path).length : 0
    const distance = (v: string, at: string): number => {
      const pct = /^(-?[\d.]+)%$/.exec(v.trim())
      if (pct) return Number(pct[1]) / 100
      const len = plainNumbers(v, at, "offset-distance")[0] ?? 0
      return motionLength > 0 ? len / motionLength : 0
    }
    if (motion) motion.rest = distance(css.get("offset-distance")?.value ?? "0%", css.get("offset-path")!.at)
    if (motion && anim.length === 0) fail(css.get("offset-path")!.at, `offset-path without an animated offset-distance isn't supported: ${HINT}`)
    if (anim.length === 0) {
      if (css.has("transform")) {
        // A static CSS transform: written as the element's transform (with its origin).
        const o = this.origin(css, n)
        const list = this.cssTransform(css.get("transform")!.value, css.get("transform")!.at)
        const t = `translate(${o[0]} ${o[1]}) ${list.text} translate(${-o[0]} ${-o[1]})`
        attrs.set("transform", { value: t, at: css.get("transform")!.at })
      }
      return []
    }
    if (css.has("transform")) {
      // The static value is the rest value: written as the element's own transform, which the animation replaces.
      const o = this.origin(css, n)
      const list = this.cssTransform(css.get("transform")!.value, css.get("transform")!.at)
      attrs.set("transform", { value: `translate(${o[0]} ${o[1]}) ${list.text} translate(${-o[0]} ${-o[1]})`, at: css.get("transform")!.at })
    }
    const out: SourceTrack[] = []
    for (const a of anim) {
      const kf = this.keyframes.get(a.name)
      if (!kf) fail(a.at, `no @keyframes "${a.name}"`)
      const props = new Set<string>()
      for (const s of kf!.stops) for (const k of s.decls.keys()) if (k !== "animation-timing-function") props.add(k)
      for (const p of props) {
        if (p === "offset-distance") {
          if (!motion) fail(kf!.at, `offset-distance moves an element along its offset-path, and this element has none`)
        } else if (p !== "transform") this.checkAnimatable(n, p, kf!.at)
        // Keyframes that set this property, sorted; the ends come from the element when missing.
        const points: Array<{ t: number; v: number[]; e: Timing | null }> = []
        for (const s of kf!.stops) {
          if (!s.decls.has(p)) continue
          const tf = s.decls.get("animation-timing-function")
          const raw = resolveVars(s.decls.get(p)!, this.varsOf(n), kf!.at)
          const v = p === "offset-distance" ? [distance(raw, kf!.at)] : this.cssValue(p, raw, kf!.at, n)
          for (const o of s.offsets) points.push({ t: o, v, e: tf ? this.timingFunction(tf, kf!.at) : null })
        }
        points.sort((x, y) => x.t - y.t)
        if (p === "transform") {
          // CSS moves function by function only when the lists match (a shorter one is padded at the end).
          const kinds = kf!.stops.filter((s) => s.decls.has("transform")).map((s) => this.cssTransform(s.decls.get("transform")!, kf!.at).kinds)
          const longest = kinds.reduce((x, y) => (y.length > x.length ? y : x), "")
          if (kinds.some((k) => !longest.startsWith(k))) {
            fail(kf!.at, `the keyframes of "${a.name}" use different transform lists, which CSS blends as matrices: ${HINT}`)
          }
        }
        const base =
          p === "transform" ? this.restTransform(attrs, css, n)
          : p === "offset-distance" ? [distance(css.get("offset-distance")?.value ?? "0%", a.at)]
          : this.baseValue(p, n, attrs, a.at)
        if (points[0]!.t > 0) points.unshift({ t: 0, v: base, e: null })
        if (points[points.length - 1]!.t < 1) points.push({ t: 1, v: base, e: null })
        let curve: Curve = expandSteps({
          t: points.map((x) => x.t * a.dur),
          v: points.map((x) => x.v),
          e: points.slice(0, -1).map((x) => x.e ?? a.ease),
        })
        if (a.direction === "reverse" || a.direction === "alternate-reverse") curve = mirror(curve)
        const reverse = a.direction === "alternate" || a.direction === "alternate-reverse"
        let delay = a.delay
        if (delay < 0) {
          if (a.count !== Infinity) fail(a.at, `a negative animation-delay on an animation that doesn't loop isn't supported: ${HINT}`)
          curve = reverse ? rotate(concat(curve, mirror(curve)), -delay) : rotate(curve, -delay)
          delay = 0
          if (reverse) {
            out.push(this.cssTrack(p, trackOf(curve, 0, -1, false), a.at, n, css, motion))
            continue
          }
        }
        out.push(this.cssTrack(p, trackOf(curve, delay, a.count === Infinity ? -1 : a.count, reverse), a.at, n, css, motion))
      }
    }
    if (motion && !out.some((t) => t.attr === "motion")) fail(css.get("offset-path")!.at, `offset-path without an animated offset-distance isn't supported: ${HINT}`)
    return out
  }

  private cssTrack(p: string, track: Track, at: string, n: SvgNode, css: Map<string, { value: string; at: string }>, motion: MotionSpec | null): SourceTrack {
    if (p === "offset-distance") return { attr: "motion", track, at, motion: motion! }
    if (p !== "transform") return { attr: p, track, at }
    return { attr: "css-transform", track, at, origin: this.origin(css, n) }
  }

  /**
   * CSS offset-path: path("...") (in the parent's user space, like animateMotion) and offset-rotate (auto by default,
   * as in CSS). The element's origin rides on the path, so a transform-origin or offset-anchor of its own fails.
   */
  private cssMotion(css: Map<string, { value: string; at: string }>): MotionSpec | null {
    const op = css.get("offset-path")
    if (!op || op.value.trim() === "none") return null
    const m = /^path\(\s*(["'])([\s\S]*)\1\s*\)$/.exec(op.value.trim())
    if (!m) return fail(op.at, `offset-path "${op.value}" isn't supported (only path("M ..."))`)
    let path: PathCmd[]
    try {
      path = parsePathData(m[2]!)
    } catch (e) {
      return fail(op.at, (e as Error).message)
    }
    for (const k of ["offset-anchor", "offset-position"]) {
      const v = css.get(k)?.value.trim()
      if (v !== undefined && v !== "auto" && v !== "normal") fail(css.get(k)!.at, `${k} "${v}" isn't supported (the element's origin rides on the path): ${HINT}`)
    }
    if (css.has("transform-origin")) fail(css.get("transform-origin")!.at, `offset-path with a transform-origin isn't supported (the element's origin 0 0 rides on the path): ${HINT}`)
    const r = css.get("offset-rotate")
    let mode: 0 | 1 | 2 = 0
    let angle = 0
    for (const w of (r?.value ?? "auto").trim().split(/\s+/)) {
      if (w === "auto") mode = 1
      else if (w === "reverse") mode = 2
      else {
        const a = /^(-?[\d.]+(?:e-?\d+)?)(deg|turn|rad|grad)?$/.exec(w)
        if (!a) return fail(r!.at, `can't read offset-rotate "${r!.value}"`)
        angle += Number(a[1]) * (a[2] === "turn" ? 360 : a[2] === "rad" ? 180 / Math.PI : a[2] === "grad" ? 0.9 : 1)
      }
    }
    return { path, mode, angle }
  }

  /** The element's own transform as [tx, ty, deg, sx, sy, skewX, skewY] around its CSS origin: what a missing keyframe uses. */
  private restTransform(attrs: Map<string, SvgAttr>, css: Map<string, { value: string; at: string }>, n: SvgNode): number[] {
    const a = attrs.get("transform")
    if (!a) return [0, 0, 0, 1, 1, 0, 0]
    const r = decompose(this.transform(a), this.origin(css, n), a.at)
    return [r.tx, r.ty, r.deg, r.sx, r.sy, r.kx, 0]
  }

  /** animation / animation-* → one entry per animation name. */
  private animationList(css: Map<string, { value: string; at: string }>) {
    type A = { name: string; dur: number; delay: number; ease: Timing; count: number; direction: string; at: string }
    const list: A[] = []
    const short = css.get("animation")
    const at = (short ?? css.get("animation-name"))?.at ?? ""
    if (short) {
      for (const one of splitTop(short.value)) {
        const a: A = { name: "", dur: 0, delay: 0, ease: CSS_EASE.ease!, count: 1, direction: "normal", at }
        let times = 0
        for (const tok of tokens(one)) {
          if (/^-?[\d.]+m?s$/.test(tok)) {
            if (times++ === 0) a.dur = clock(tok, at, "animation-duration")
            else a.delay = clock(tok, at, "animation-delay")
          } else if (tok in CSS_EASE || tok === "step-start" || tok.startsWith("cubic-bezier(") || tok.startsWith("steps(")) a.ease = this.timingFunction(tok, at)
          else if (tok === "infinite") a.count = Infinity
          else if (/^[\d.]+$/.test(tok)) a.count = Number(tok)
          else if (["normal", "reverse", "alternate", "alternate-reverse"].includes(tok)) a.direction = tok
          else if (["none", "forwards", "backwards", "both", "running", "paused"].includes(tok)) {
            if (tok === "paused") fail(at, "animation-play-state: paused isn't supported (use the zn element's paused prop)")
          } else a.name = tok
        }
        list.push(a)
      }
    } else if (css.has("animation-name")) {
      for (const name of splitTop(css.get("animation-name")!.value)) {
        list.push({ name: name.trim(), dur: 0, delay: 0, ease: CSS_EASE.ease!, count: 1, direction: "normal", at })
      }
    }
    const order = [...css.keys()]
    const longhand = (k: string, f: (a: A, v: string) => void) => {
      const v = css.get(k)
      if (!v) return
      if (short && order.indexOf(k) < order.indexOf("animation")) return // the later shorthand reset it
      const vals = splitTop(v.value)
      list.forEach((a, i) => f(a, vals[i % vals.length]!.trim()))
    }
    longhand("animation-duration", (a, v) => (a.dur = clock(v, at, "animation-duration")))
    longhand("animation-delay", (a, v) => (a.delay = clock(v, at, "animation-delay")))
    longhand("animation-timing-function", (a, v) => (a.ease = this.timingFunction(v, at)))
    longhand("animation-iteration-count", (a, v) => (a.count = v === "infinite" ? Infinity : Number(v)))
    longhand("animation-direction", (a, v) => (a.direction = v))
    longhand("animation-play-state", (_a, v) => {
      if (v === "paused") fail(at, "animation-play-state: paused isn't supported (use the zn element's paused prop)")
    })
    const out = list.filter((a) => a.name !== "" && a.name !== "none")
    for (const a of out) {
      if (!(a.dur > 0)) fail(a.at, `animation "${a.name}" needs a duration`)
      if (!(a.count > 0) || (Number.isFinite(a.count) && !Number.isInteger(a.count))) fail(a.at, "animation-iteration-count must be a whole number or infinite")
    }
    return out
  }

  private timingFunction(s: string, at: string): Timing {
    const t = s.trim()
    if (t in CSS_EASE) return CSS_EASE[t]!
    const m = /^cubic-bezier\(([^)]*)\)$/.exec(t)
    if (m) return { k: "bez", b: bezier(m[1]!, at) }
    // One jump at the end of each segment (hold, then change), like SMIL calcMode="discrete".
    if (/^steps\(\s*1\s*(,\s*(end|jump-end)\s*)?\)$/.test(t)) return { k: "step" }
    if (t === "step-start") return { k: "steps", n: 1, jump: "start" }
    const st = /^steps\(\s*(\d+)\s*(?:,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.exec(t)
    if (st) {
      const n = Number(st[1])
      const jump = (st[2] ?? "end").replace("jump-", "") as Steps["jump"]
      if (!(n >= 1) || (jump === "none" && n < 2)) fail(at, `${t} isn't valid (steps needs at least 1 step, jump-none at least 2)`)
      return { k: "steps", n, jump }
    }
    return fail(at, `can't read the timing function "${t}"`)
  }

  private cssValue(p: string, v: string, at: string, el: SvgNode): number[] {
    if (p === "transform") return this.cssTransform(v, at).values
    if (p === "d") {
      const m = /^path\(\s*(["'])([\s\S]*)\1\s*\)$/.exec(v.trim())
      if (!m) return fail(at, `can't read d "${v}" in a keyframe (use path("M..."))`)
      return this.pathNums(m[2]!, at, el)
    }
    if (p === "stroke-dasharray") return this.dashList(v, at)
    if (COLORS.has(p) || p === "stop-color") {
      const c = this.colorOf(v)
      if (c === null) fail(at, `can't read colour "${v}" in a keyframe`)
      return [c!]
    }
    const pct = /^([\d.]+)%$/.exec(v)
    if (pct && (OPACITIES.has(p) || p === "stop-opacity")) return [clamp01(Number(pct[1]) / 100)]
    const n = plainNumbers(v, at, p)
    if (n.length !== 1) fail(at, `"${p}" takes one value, got "${v}"`)
    return OPACITIES.has(p) || p === "stop-opacity" ? [clamp01(n[0]!)] : n
  }

  /**
   * A CSS transform list → [tx, ty, deg, sx, sy, skewX, skewY] (translate, then rotate, then skewX, skewY, then scale,
   * any of them left out), and the same as SVG transform text. Other orders or functions fail: they don't move
   * linearly in these values.
   */
  private cssTransform(v: string, at: string): { values: number[]; text: string; kinds: string } {
    const s = v.trim()
    if (s === "none") return { values: [0, 0, 0, 1, 1, 0, 0], text: "", kinds: "" }
    const out = [0, 0, 0, 1, 1, 0, 0]
    let stage = 0 // 1 translate, 2 rotate, 3 skewX, 4 skewY, 5 scale
    let kinds = ""
    const text: string[] = []
    const re = /([a-zA-Z]+)\(([^)]*)\)/g
    let used = 0
    for (let m = re.exec(s); m; m = re.exec(s)) {
      used += m[0].length
      const f = m[1]!
      const args = m[2]!.split(/[\s,]+/).filter((x) => x !== "")
      const len = (x: string) => {
        if (x.endsWith("%")) return fail(at, `a % translate in CSS isn't supported: ${HINT}`)
        const n = /^(-?[\d.]+(?:e-?\d+)?)(px)?$/.exec(x)
        if (!n) return fail(at, `can't read "${x}" in transform "${s}"`)
        return Number(n[1])
      }
      const angle = (x: string) => {
        const n = /^(-?[\d.]+(?:e-?\d+)?)(deg|turn|rad|grad)?$/.exec(x)
        if (!n) return fail(at, `can't read angle "${x}" in transform "${s}"`)
        const k = n[2] === "turn" ? 360 : n[2] === "rad" ? 180 / Math.PI : n[2] === "grad" ? 0.9 : 1
        return Number(n[1]) * k
      }
      const want = (st: number) => {
        if (st <= stage) fail(at, `transform "${s}": only translate, then rotate, then skew, then scale (in that order) can animate: ${HINT}`)
        stage = st
        kinds += "TRXYS"[st - 1]
      }
      if (f === "translate" || f === "translateX" || f === "translateY") {
        want(1)
        const x = f === "translateY" ? 0 : len(args[0] ?? "0")
        const y = f === "translateX" ? 0 : f === "translateY" ? len(args[0] ?? "0") : len(args[1] ?? "0")
        out[0] = x
        out[1] = y
        text.push(`translate(${x} ${y})`)
      } else if (f === "rotate") {
        want(2)
        out[2] = angle(args[0] ?? "0")
        text.push(`rotate(${out[2]})`)
      } else if (f === "skewX" || f === "skewY" || f === "skew") {
        // skew(a, b) with both set is one shear matrix, not skewX then skewY: only one of them may be set.
        const ax = f === "skewY" ? 0 : angle(args[0] ?? "0")
        const ay = f === "skewX" ? 0 : f === "skewY" ? angle(args[0] ?? "0") : angle(args[1] ?? "0")
        if (ax !== 0 && ay !== 0) fail(at, `skew(${args.join(", ")}) with two angles isn't supported (use skewX or skewY): ${HINT}`)
        if (f === "skewY" || (f === "skew" && ax === 0 && ay !== 0)) {
          want(4)
          out[6] = ay
          text.push(`skewY(${ay})`)
        } else {
          want(3)
          out[5] = ax
          text.push(`skewX(${ax})`)
        }
      } else if (f === "scale" || f === "scaleX" || f === "scaleY") {
        want(5)
        const a = Number(args[0] ?? "1")
        out[3] = f === "scaleY" ? 1 : a
        out[4] = f === "scaleX" ? 1 : f === "scaleY" ? a : Number(args[1] ?? args[0] ?? "1")
        text.push(`scale(${out[3]} ${out[4]})`)
      } else {
        fail(at, `transform function ${f}() isn't supported in an animation: ${HINT}`)
      }
    }
    if (used === 0) fail(at, `can't read transform "${s}"`)
    return { values: out, text: text.join(" "), kinds }
  }

  /** transform-origin in the element's user space (transform-box view-box, the default, or fill-box). */
  private origin(css: Map<string, { value: string; at: string }>, n: SvgNode): [number, number] {
    const o = css.get("transform-origin")
    if (!o) return [0, 0]
    const box = css.get("transform-box")?.value ?? "view-box"
    let ref: [number, number, number, number]
    if (box === "view-box") ref = this.vb
    else if (box === "fill-box") ref = this.fillBox(n, o.at)
    else return fail(o.at, `transform-box "${box}" isn't supported (view-box or fill-box)`)
    const words = o.value.trim().split(/\s+/)
    const axis = (w: string, i: 0 | 1): number => {
      const size = i === 0 ? ref[2] : ref[3]
      const start = i === 0 ? ref[0] : ref[1]
      if (w === "center") return start + size / 2
      if (w === "left" || w === "top") return start
      if (w === "right" || w === "bottom") return start + size
      const p = /^(-?[\d.]+)%$/.exec(w)
      if (p) return start + (size * Number(p[1])) / 100
      const px = /^(-?[\d.]+)(px)?$/.exec(w)
      // A length origin is from the reference box's corner.
      if (px) return (box === "fill-box" ? start : 0) + Number(px[1])
      return fail(o.at, `can't read transform-origin "${o.value}"`)
    }
    let [x, y] = [words[0] ?? "50%", words[1] ?? (words[0] === "center" || words.length === 1 ? "center" : "50%")]
    if (x === "top" || x === "bottom") [x, y] = [y, x]
    return [axis(x, 0), axis(y, 1)]
  }

  private fillBox(n: SvgNode, at: string): [number, number, number, number] {
    const g = (k: string) => Number(n.attrs.get(k)?.value ?? "0")
    if (n.tag === "circle") return [g("cx") - g("r"), g("cy") - g("r"), 2 * g("r"), 2 * g("r")]
    if (n.tag === "ellipse") return [g("cx") - g("rx"), g("cy") - g("ry"), 2 * g("rx"), 2 * g("ry")]
    if (n.tag === "rect") return [g("x"), g("y"), g("width"), g("height")]
    return fail(at, `transform-box: fill-box is supported on <circle>, <ellipse> and <rect> only`)
  }
}

/** How a part's transform stacks (registry 13 adds the skews): what SMIL animateTransforms may use, in this order. */
const ORDER = ["translate", "rotate", "skewX", "skewY", "scale"]

function isTransform(attr: string): boolean {
  return ORDER.includes(attr) || attr === "css-transform"
}

const CSS_EASE: Record<string, Ease> = {
  linear: LIN,
  ease: { k: "bez", b: [0.25, 0.1, 0.25, 1] },
  "ease-in": { k: "bez", b: [0.42, 0, 1, 1] },
  "ease-out": { k: "bez", b: [0, 0, 0.58, 1] },
  "ease-in-out": { k: "bez", b: [0.42, 0, 0.58, 1] },
  "step-end": { k: "step" },
}

/** [v] with each var(--name, fallback) replaced by the custom property's value (registry 13). */
function resolveVars(v: string, vars: Map<string, string>, at: string, depth = 0): string {
  if (!v.includes("var(")) return v
  if (depth > 20) return fail(at, `CSS var() in "${v}" refers to itself`)
  let out = ""
  let i = 0
  while (i < v.length) {
    const j = v.indexOf("var(", i)
    if (j < 0) {
      out += v.slice(i)
      break
    }
    out += v.slice(i, j)
    let k = j + 3
    for (let d = 0; k < v.length; k++) {
      if (v[k] === "(") d++
      else if (v[k] === ")" && --d === 0) break
    }
    if (k >= v.length) return fail(at, `can't read "${v}" (a var() isn't closed)`)
    const inner = v.slice(j + 4, k)
    const comma = inner.indexOf(",")
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim().toLowerCase() // names as decls() reads them
    const value = vars.get(name) ?? (comma < 0 ? undefined : inner.slice(comma + 1).trim())
    if (value === undefined) return fail(at, `CSS var(${name}) has no value here and no fallback`)
    out += resolveVars(value, vars, at, depth + 1)
    i = k + 1
  }
  return out
}

/** CSS specificity of one compound part: ids, then classes / attributes / pseudo-classes, then tags. */
function specificity(s: Selector): number {
  return (s.id ? 10_000 : 0) + (s.classes.length + s.attrs.length + s.nth.length + (s.root ? 1 : 0)) * 100 + (s.tag ? 1 : 0) +
    s.not.reduce((a, m) => a + specificity(m), 0)
}

/** :nth-child's argument as [A, B] (position = A·k + B, k ≥ 0): "odd", "even", "3", "2n+1", "-n+3". */
function nthOf(arg: string, bad: () => never): [number, number] {
  const t = arg.replace(/\s+/g, "").toLowerCase()
  if (t === "odd") return [2, 1]
  if (t === "even") return [2, 0]
  if (/^[+-]?\d+$/.test(t)) return [0, Number(t)]
  const m = /^([+-]?\d*)n([+-]\d+)?$/.exec(t)
  if (!m) return bad()
  const a = m[1] === "" || m[1] === "+" ? 1 : m[1] === "-" ? -1 : Number(m[1])
  return [a, m[2] ? Number(m[2]) : 0]
}

/**
 * Whether an @media block applies (registry 13). The phone plays animations unless its "Remove animations" setting
 * is on, and then shows each part's resting value by itself: so prefers-reduced-motion is "no-preference" here.
 * Media types all / screen apply; other features fail with a hint.
 */
function mediaApplies(query: string, at: string): boolean {
  return splitTop(query).some((one) => {
    let q = one.trim().toLowerCase()
    let not = false
    if (q.startsWith("not ")) {
      not = true
      q = q.slice(4).trim()
    }
    const ok = q.split(/\s+and\s+/).every((p) => {
      const t = p.trim().replace(/^only\s+/, "")
      if (t === "all" || t === "screen") return true
      if (t === "print") return false
      const f = /^\(\s*prefers-reduced-motion\s*(?::\s*(reduce|no-preference)\s*)?\)$/.exec(t)
      if (f) return f[1] === "no-preference"
      return fail(at, `@media ${one.trim()} isn't supported (only prefers-reduced-motion, all and screen)`)
    })
    return not ? !ok : ok
  })
}

/** Splits on commas that aren't inside brackets. */
function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++
    else if (s[i] === ")") depth--
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out.map((x) => x.trim()).filter((x) => x !== "")
}

/** Space-separated tokens, keeping "cubic-bezier(a, b, c, d)" whole. */
function tokens(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ""
  for (const ch of s) {
    if (ch === "(") depth++
    if (ch === ")") depth--
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur)
      cur = ""
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

/** [c], then a jump to [v] held for [hold] ms (fill="remove" after the last play, or the wait in a chain). */
function holdThen(c: Curve, v: number[], hold: number): Curve {
  const end = c.t[c.t.length - 1]!
  const same = v.every((x, i) => Math.abs(x - c.v[c.v.length - 1]![i]!) < 1e-9)
  if (hold <= 0) {
    if (same) return c
    // A jump right at the end: a step segment of 1 ms.
    return { t: [...c.t, end + 1], v: [...c.v, v], e: [...c.e, { k: "step" }] }
  }
  if (same) return { t: [...c.t, end + hold], v: [...c.v, v], e: [...c.e, LIN] }
  const jump = Math.min(1, hold / 2)
  return { t: [...c.t, end + jump, end + hold], v: [...c.v, v, v], e: [...c.e, { k: "step" }, LIN] }
}

// ---- After the SVG compiler: tracks → SvgPart props ---------------------------------------------------------------

export interface PartInfo {
  index: number
  box: [number, number, number, number] | undefined
  fill: boolean
  stroke: boolean
}

/**
 * The SvgPart props for every animated element (keyed by its id): rest values, pivot (viewBox units) and an
 * `animate` string in the template's timing format (registry 13, with "z" per-segment easings).
 */
export function motionParts(elements: AnimatedElement[], info: (id: string) => PartInfo | undefined): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (const el of elements) {
    const part = info(el.id)
    if (!part) continue // draws nothing
    const props: Record<string, unknown> = {}
    const animate: string[] = []
    let turns = false
    if (el.tag === "stop") {
      // A gradient stop (registry 13): its colour, with stop-opacity in the alpha, is the part's fill.
      const sc = el.tracks.find((t) => t.attr === "stop-color")
      const so = el.tracks.find((t) => t.attr === "stop-opacity")
      if (sc && so) fail(so.at, `stop-color and stop-opacity animated together on one <stop> aren't supported (animate one): ${HINT}`)
      const c0 = el.baseColor["stop-color"]!
      const o0 = el.baseOpacity["stop-opacity"] ?? 1
      const withAlpha = (c: number, a: number) => ((Math.round(((c >>> 24) & 255) * clamp01(a)) << 24) | (c & 0xffffff)) >>> 0
      const values = sc ? sc.track.values.map((v) => [withAlpha(v[0]!, o0)]) : so!.track.values.map((v) => [withAlpha(c0, v[0]!)])
      props.fill = cssColor(withAlpha(c0, o0))
      props.animate = `${Prop.fill.id}=${encode({ ...(sc ?? so)!.track, values }, true)}`
      out.set(el.id, props)
      continue
    }
    const channel = (prop: string, t: Track, rest: number | null) => {
      const def = DEFAULTS[prop]
      if (rest !== null && (def === undefined || Math.abs(rest - def) > 1e-9)) props[prop] = round(rest, 4)
      animate.push(`${Prop[prop as keyof typeof Prop].id}=${encode(t)}`)
      if (prop === "rotate" || prop === "scaleX" || prop === "scaleY" || prop === "skewX" || prop === "skewY") turns = true
    }
    const transforms = el.tracks.filter((t) => isTransform(t.attr))
    const geometry = el.tracks.filter((t) => GEOMETRY[el.tag]?.includes(t.attr))
    const k0 = conjugation(el, transforms.some((t) => t.attr === "rotate" || t.attr === "skewX" || t.attr === "skewY" || t.attr === "css-transform"))
    // Inside a rotated, skewed or stretched group the part's transform happens in the element's own space: the phone
    // draws it through frame · transform · frame⁻¹ (registry 13), with the pivot and the moves in that space.
    const frame = !k0 && (transforms.length > 0 || geometry.length > 0) ? el.ctm : null
    if (frame) {
      if (Math.abs(frame[0] * frame[3] - frame[1] * frame[2]) < 1e-12) fail(el.at, "the element's group squashes it flat, so it can't animate")
      props.frame = frame.map((x) => round(x, 6)).join(" ")
    }
    const k: Conj | null = k0 ?? (frame ? { sx: 1, sy: 1, tx: 0, ty: 0, turn: 1 } : null)
    if (transforms.length > 0 && geometry.length > 0) fail(el.at, `a transform animation and a size or position animation on one element isn't supported: ${HINT}`)

    // Opacity and colours. fill-opacity / stroke-opacity on a plain colour become that colour's alpha (exact, even
    // with the other paint there); otherwise the part's opacity, when the other paint is absent.
    const ops = el.tracks.filter((t) => OPACITIES.has(t.attr))
    if (ops.length > 1) fail(el.at, `more than one kind of opacity animation on one element isn't supported: ${HINT}`)
    const colors = el.tracks.filter((t) => COLORS.has(t.attr))
    for (const t of ops) {
      const paint = t.attr === "fill-opacity" ? "fill" : t.attr === "stroke-opacity" ? "stroke" : null
      const plain = paint ? el.baseColor[`_${paint}`] : undefined
      if (paint && plain !== undefined && !colors.some((c) => c.attr === paint)) {
        const withAlpha = (c: number, a: number) => ((Math.round(((c >>> 24) & 255) * clamp01(a)) << 24) | (c & 0xffffff)) >>> 0
        props[paint] = cssColor(withAlpha(plain, el.baseOpacity[t.attr] ?? 1))
        animate.push(`${Prop[paint as "fill"].id}=${encode({ ...t.track, values: t.track.values.map((v) => [withAlpha(plain, v[0]!)]) }, true)}`)
        continue
      }
      if (paint === "fill" && part.stroke) fail(t.at, `fill-opacity animated on a gradient or currentColor fill with a stroke isn't supported (use opacity): ${HINT}`)
      if (paint === "stroke" && part.fill) fail(t.at, `stroke-opacity animated on a gradient or currentColor stroke with a fill isn't supported (use opacity): ${HINT}`)
      channel("opacity", scalar(t.track, 0), el.baseOpacity[t.attr] ?? 1)
    }
    for (const t of colors) {
      props[t.attr] = cssColor(el.baseColor[t.attr]!)
      animate.push(`${Prop[t.attr as "fill"].id}=${encode(t.track, true)}`)
    }

    // Stroke width and dashes (registry 13), in viewBox units: the shape's own units scaled as its stroke is, or the
    // shape's own units when it keeps its matrix (a stroke under a stretch).
    const keep = part.stroke && similarityScale(el.ctm) === null
    const unit = keep ? 1 : Math.abs(similarityScale(el.ctm) ?? 1)
    const sw = el.tracks.find((t) => t.attr === "stroke-width")
    if (sw) channel("strokeWidth", scalar(sw.track, 0, unit), el.stroke.width * unit)
    const arr = el.tracks.find((t) => t.attr === "stroke-dasharray")
    const off = el.tracks.find((t) => t.attr === "stroke-dashoffset")
    if (el.dashMode === "trim") {
      // One dash: it shows from -offset to dash - offset along the line, cut at its ends (SVG doesn't wrap dashes).
      if (arr && off && !sameTimeline(arr.track, off.track)) {
        fail(off.at, `stroke-dasharray and stroke-dashoffset animate with different timings on one element, which isn't supported: ${HINT}`)
      }
      const L = el.stroke.pathLength ?? el.stroke.length
      const tl = (arr ?? off)!.track
      const dash = (j: number) => (arr ? arr.track.values[j]![0]! : el.stroke.dashes[0]!)
      const offset = (j: number) => (off ? off.track.values[j]![0]! : el.stroke.offset)
      const piece = (j: number) => (dash(j) < 0 ? [0, 1] : [-offset(j) / L, (dash(j) - offset(j)) / L])
      const cut = clampSplit({ ...tl, values: tl.values.map((_, j) => piece(j)) }, 0, 1)
      // A dash of length 0 on the line still draws its caps in SVG (a dot with a round cap): registry 13's trimCaps.
      if (tl.values.some((_, j) => dash(j) === 0 && -offset(j) >= 0 && -offset(j) <= L)) props.trimCaps = true
      // At rest: the dashes the file has without its animations (none: the whole line).
      const restDash = el.stroke.dashes.length === 2 ? el.stroke.dashes[0]! : null
      channel("trimStart", scalar(cut, 0), restDash === null ? 0 : clamp01(-el.stroke.offset / L))
      channel("trimEnd", scalar(cut, 1), restDash === null ? 1 : clamp01((restDash - el.stroke.offset) / L))
    } else if (el.dashMode === "offset") {
      channel("dashOffset", scalar(off!.track, 0, unit), el.stroke.offset * unit)
    }

    // A morph: the keyframe paths (in viewBox space, like the shape's own) and where it is in them.
    const dT = el.tracks.find((t) => t.attr === "d")
    if (dT) {
      if (el.dashMode === "trim") fail(dT.at, `a morph and animated dashes on one element aren't supported: ${HINT}`)
      const m = keep ? IDENTITY : el.ctm
      const frames = dT.track.values.map((v) => {
        const out: string[] = []
        for (let i = 0; i < v.length; i += 2) {
          out.push(String(round(m[0] * v[i]! + m[2] * v[i + 1]! + m[4], 3)), String(round(m[1] * v[i]! + m[3] * v[i + 1]! + m[5], 3)))
        }
        return out.join(" ")
      })
      props.morph = `${el.morph}|${frames.join("|")}`
      channel("morphAt", { ...dT.track, values: dT.track.values.map((_, i) => [i]) }, -1)
    }

    // Transforms: one pivot for the part; translate, rotate and scale tracks become its channels.
    let pivot: [number, number] | null = null
    if (transforms.length > 0) {
      const origins = transforms.filter((t) => t.attr !== "translate").map((t) => t.origin!)
      const o = origins[0] ?? [0, 0]
      if (origins.some((p) => Math.abs(p[0] - o[0]) > 1e-6 || Math.abs(p[1] - o[1]) > 1e-6)) {
        fail(el.at, `a rotation and a scale around different points on one element isn't supported: ${HINT}`)
      }
      const seen = new Set<string>()
      for (const t of transforms) {
        const keys = t.attr === "css-transform" ? ORDER : [t.attr]
        for (const key of keys) {
          if (seen.has(key)) fail(t.at, `two ${key} animations on one element aren't supported: ${HINT}`)
          seen.add(key)
        }
      }
      pivot = apply(k!, o)
      // The element's own transform, when replaced, is the rest value: as the same channels around the pivot.
      const rest = el.replaced ? decompose(el.replaced, o, el.at) : { tx: 0, ty: 0, deg: 0, sx: 1, sy: 1, kx: 0 }
      if (rest.kx !== 0 && !transforms.some((t) => t.attr === "skewX" || t.attr === "css-transform")) {
        fail(el.at, `the element's own transform has a skew, which can't be its rest value under this animation: ${HINT}`)
      }
      for (const t of transforms) {
        const tr = t.track
        if (t.attr === "rotate") channel("rotate", scalar(tr, 0, k!.turn), rest.deg * k!.turn)
        else if (t.attr === "skewX") channel("skewX", scalar(tr, 0, k!.turn), rest.kx * k!.turn)
        else if (t.attr === "skewY") channel("skewY", scalar(tr, 0, k!.turn), 0)
        else if (t.attr === "scale") {
          channel("scaleX", scalar(tr, 0), rest.sx)
          channel("scaleY", scalar(tr, 1), rest.sy)
        } else if (t.attr === "translate") {
          channel("translateX", scalar(tr, 0, k!.sx), rest.tx * k!.sx)
          channel("translateY", scalar(tr, 1, k!.sy), rest.ty * k!.sy)
        } else {
          const vary = (i: number) => tr.values.some((x) => Math.abs(x[i]! - tr.values[0]![i]!) > 1e-9)
          if (vary(0) || rest.tx !== 0) channel("translateX", scalar(tr, 0, k!.sx), rest.tx * k!.sx)
          if (vary(1) || rest.ty !== 0) channel("translateY", scalar(tr, 1, k!.sy), rest.ty * k!.sy)
          if (vary(2) || rest.deg !== 0) channel("rotate", scalar(tr, 2, k!.turn), rest.deg * k!.turn)
          if (vary(3) || rest.sx !== 1) channel("scaleX", scalar(tr, 3), rest.sx)
          if (vary(4) || rest.sy !== 1) channel("scaleY", scalar(tr, 4), rest.sy)
          if (vary(5) || rest.kx !== 0) channel("skewX", scalar(tr, 5, k!.turn), rest.kx * k!.turn)
          if (vary(6)) channel("skewY", scalar(tr, 6, k!.turn), 0)
        }
      }
    }

    // Moving along a path (animateMotion, CSS offset-path): outside the part's own transform, in viewBox units. The
    // path is mapped by the parent's matrix; with a turn, that matrix must keep shapes (a turn would shear otherwise).
    const mo = el.tracks.find((t) => t.attr === "motion")
    if (mo) {
      const P = el.parent
      const spec = mo.motion!
      const keeps = similarityScale(P) !== null
      if (!keeps && (spec.mode !== 0 || spec.angle !== 0)) fail(mo.at, `a motion that turns the element, inside a stretched or skewed group, isn't supported: ${HINT}`)
      const th = keeps ? (Math.atan2(P[1], P[0]) * 180) / Math.PI : 0
      const turn = P[0] * P[3] - P[1] * P[2] < 0 ? -1 : 1
      // The phone turns by: mode 0, the angle; 1, the path's direction minus the angle; 2, the same plus 180.
      const angle = spec.mode === 0 ? turn * spec.angle : th - turn * spec.angle
      const { sig, nums } = cubicForm(transformPath(spec.path, P))
      props.motionPath = `${round(P[4], 4)} ${round(P[5], 4)} ${round(angle, 4)} ${spec.mode};${sig};${nums.map((x) => round(x, 3)).join(" ")}`
      channel("motionAt", mo.track, spec.rest ?? -1)
    }

    // Geometry: an exact scale and move around the baked shape's centre. With a stroke, the part scales its outline
    // and the stroke keeps its width (scaleOutline), as when the browser changes r or width.
    if (geometry.length > 0) {
      if (keep) fail(geometry[0]!.at, `animating the size or position of a stroked shape inside a stretched group isn't supported: ${HINT}`)
      if (frame && part.stroke && geometry.some((t) => SIZES.has(t.attr))) {
        fail(geometry[0]!.at, `animating the size of a stroked shape inside a rotated or skewed group isn't supported: ${HINT}`)
      }
      if (part.stroke && geometry.some((t) => SIZES.has(t.attr))) props.scaleOutline = true
      const B = el.baked
      const base = el.base
      const tracks = new Map(geometry.map((t) => [t.attr, t]))
      const centre: [number, number] =
        el.tag === "rect" ? [B.x! + B.width! / 2, B.y! + B.height! / 2] : [B.cx!, B.cy!]
      pivot = apply(k!, centre)
      // Each output = f(its inputs); inputs that animate must share one timeline.
      const out = (prop: string, inputs: string[], f: (v: Record<string, number>) => number) => {
        const live = inputs.filter((i) => tracks.has(i))
        if (live.length === 0) return
        const first = tracks.get(live[0]!)!.track
        for (const i of live.slice(1)) {
          if (!sameTimeline(first, tracks.get(i)!.track)) {
            fail(tracks.get(i)!.at, `"${live[0]}" and "${i}" animate with different timings on one element, which isn't supported: ${HINT}`)
          }
        }
        const values = first.values.map((_, j) => {
          const v: Record<string, number> = {}
          for (const i of inputs) v[i] = tracks.has(i) ? tracks.get(i)!.track.values[j]![0]! : base[i]!
          return [f(v)]
        })
        const restV: Record<string, number> = {}
        for (const i of inputs) restV[i] = base[i]!
        channel(prop, { ...first, values }, f(restV))
      }
      if (el.tag === "rect") {
        out("scaleX", ["width"], (v) => v.width! / B.width!)
        out("scaleY", ["height"], (v) => v.height! / B.height!)
        out("translateX", ["x", "width"], (v) => (v.x! + v.width! / 2 - centre[0]) * k!.sx)
        out("translateY", ["y", "height"], (v) => (v.y! + v.height! / 2 - centre[1]) * k!.sy)
      } else {
        const rx = el.tag === "circle" ? "r" : "rx"
        const ry = el.tag === "circle" ? "r" : "ry"
        out("scaleX", [rx], (v) => v[rx]! / B[rx]!)
        out("scaleY", [ry], (v) => v[ry]! / B[ry]!)
        out("translateX", ["cx"], (v) => (v.cx! - centre[0]) * k!.sx)
        out("translateY", ["cy"], (v) => (v.cy! - centre[1]) * k!.sy)
      }
    }

    if (animate.length === 0) continue
    if (pivot && turns) {
      props.pivotX = round(pivot[0], 4)
      props.pivotY = round(pivot[1], 4)
    }
    props.animate = animate.join(";")
    out.set(el.id, props)
  }
  return out
}

const DEFAULTS: Record<string, number> = {
  opacity: 1, rotate: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0, trimStart: 0, trimEnd: 1, morphAt: -1,
  skewX: 0, skewY: 0, motionAt: -1,
}

/**
 * The element's baking matrix when it keeps the axes (scale per axis, flips, move): a part transform in the element's
 * own space is then the same transform in viewBox space around the mapped pivot, with moves scaled per axis and a
 * turn reversed by a flip. [turn] is null when the axes scale differently (a turn would shear). Else null.
 */
interface Conj {
  sx: number
  sy: number
  tx: number
  ty: number
  turn: number
}
function conjugation(el: AnimatedElement, needsTurn: boolean): Conj | null {
  const [a, b, c, d, e, f] = el.ctm
  if (Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9 || a === 0 || d === 0) return null
  const even = Math.abs(Math.abs(a) - Math.abs(d)) < 1e-9
  if (needsTurn && !even) return null
  return { sx: a, sy: d, tx: e, ty: f, turn: a * d < 0 ? -1 : 1 }
}

function apply(k: Conj, p: [number, number]): [number, number] {
  return [k.sx * p[0] + k.tx, k.sy * p[1] + k.ty]
}

/**
 * [m] as translate + rotate + skewX + scale around [o]: m(p) = o + t + R K S (p - o). Any matrix with a size splits
 * this way (R from the first column, then K S is what is left: [[sx, tan(k) sy], [0, sy]]).
 */
function decompose(m: Matrix, o: [number, number], at: string): { tx: number; ty: number; deg: number; sx: number; sy: number; kx: number } {
  const [a, b, c, d, e, f] = m
  const sx = Math.hypot(a, b)
  const th = Math.atan2(b, a)
  const sy = sx === 0 ? d : (a * d - b * c) / sx
  // What K S has above its diagonal; with a scale of 0 (a "pop in" from scale(0)) it can only be 0.
  const top = sx === 0 ? c : c * Math.cos(th) + d * Math.sin(th)
  if ((sx === 0 || sy === 0) && Math.abs(top) > 1e-6) {
    fail(at, `the element's own transform has a skew on a scale of 0, which can't be its rest value under an animation: ${HINT}`)
  }
  const shear = sx === 0 || sy === 0 ? 0 : top / sy
  const tx = e + a * o[0] + c * o[1] - o[0]
  const ty = f + b * o[0] + d * o[1] - o[1]
  return { tx, ty, deg: (th * 180) / Math.PI, sx, sy, kx: Math.abs(shear) < 1e-9 ? 0 : (Math.atan(shear) * 180) / Math.PI }
}

/** How long a path is (arcs and curves measured in small steps) and how many pieces it draws. */
function lineOf(path: PathCmd[]): { length: number; contours: number } {
  let length = 0
  let contours = 0
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  let drawn = false
  const steps = 64
  const curve = (pts: number[]) => {
    // A cubic from (x, y) through pts[0..5].
    let px = x
    let py = y
    for (let i = 1; i <= steps; i++) {
      const u = i / steps
      const m = 1 - u
      const qx = m * m * m * x + 3 * m * m * u * pts[0]! + 3 * m * u * u * pts[2]! + u * u * u * pts[4]!
      const qy = m * m * m * y + 3 * m * m * u * pts[1]! + 3 * m * u * u * pts[3]! + u * u * u * pts[5]!
      length += Math.hypot(qx - px, qy - py)
      px = qx
      py = qy
    }
  }
  const segment = (c: PathCmd) => {
    if (!drawn) contours++
    drawn = true
    if (c[0] === "L") length += Math.hypot(c[1] - x, c[2] - y)
    else if (c[0] === "C") curve(c.slice(1) as number[])
    else if (c[0] === "Q") curve([x + (2 / 3) * (c[1] - x), y + (2 / 3) * (c[2] - y), c[3] + (2 / 3) * (c[1] - c[3]), c[4] + (2 / 3) * (c[2] - c[4]), c[3], c[4]])
  }
  for (const c of path) {
    if (c[0] === "M") {
      x = sx = c[1]
      y = sy = c[2]
      drawn = false
      continue
    }
    if (c[0] === "Z") {
      if (drawn) length += Math.hypot(sx - x, sy - y)
      x = sx
      y = sy
      continue
    }
    if (c[0] === "A") {
      for (const k of arcToCubics(x, y, c[1], c[2], c[3], c[4], c[5], c[6], c[7])) {
        segment(k)
        x = k[k.length - 2] as number
        y = k[k.length - 1] as number
      }
      continue
    }
    segment(c)
    x = c[c.length - 2] as number
    y = c[c.length - 1] as number
  }
  return { length, contours }
}

/**
 * A path as M / C / Z only (lines become straight cubics, exact), so two keyframes with the same commands can be mixed
 * number by number. [sig]: the command letters; [nums]: their points.
 */
function cubicForm(cmds: PathCmd[]): { sig: string; nums: number[] } {
  let sig = ""
  const nums: number[] = []
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  for (const c of cmds) {
    if (c[0] === "M") {
      sig += "M"
      nums.push(c[1], c[2])
      x = sx = c[1]
      y = sy = c[2]
    } else if (c[0] === "L") {
      sig += "C"
      nums.push(x + (c[1] - x) / 3, y + (c[2] - y) / 3, x + (2 * (c[1] - x)) / 3, y + (2 * (c[2] - y)) / 3, c[1], c[2])
      x = c[1]
      y = c[2]
    } else if (c[0] === "C") {
      sig += "C"
      nums.push(c[1], c[2], c[3], c[4], c[5], c[6])
      x = c[5]
      y = c[6]
    } else if (c[0] === "Q") {
      sig += "C"
      nums.push(x + (2 / 3) * (c[1] - x), y + (2 / 3) * (c[2] - y), c[3] + (2 / 3) * (c[1] - c[3]), c[4] + (2 / 3) * (c[2] - c[4]), c[3], c[4])
      x = c[3]
      y = c[4]
    } else if (c[0] === "A") {
      for (const k of arcToCubics(x, y, c[1], c[2], c[3], c[4], c[5], c[6], c[7])) {
        const f = cubicForm([["M", x, y], k])
        sig += f.sig.slice(1)
        nums.push(...f.nums.slice(2))
        x = k[k.length - 2] as number
        y = k[k.length - 1] as number
      }
    } else {
      sig += "Z"
      x = sx
      y = sy
    }
  }
  return { sig, nums }
}

/** The time fraction where easing [e] reaches progress [p] (first crossing). */
function fracAt(e: Ease, p: number): number {
  if (e.k === "lin") return p
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (easeAt(e, mid) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * [t] with every value kept within [lo, hi], exactly: a segment whose value crosses a bound is split there (its
 * easing split too), so after clamping each piece still moves the same way as before.
 */
function clampSplit(t: Track, lo: number, hi: number): Track {
  const times = [t.times[0]!]
  const values = [t.values[0]!]
  const eases: Ease[] = []
  for (let i = 0; i < t.eases.length; i++) {
    const a = t.values[i]!
    const b = t.values[i + 1]!
    const e = t.eases[i]!
    const t0 = t.times[i]!
    const t1 = t.times[i + 1]!
    const cuts: number[] = []
    if (e.k !== "step") {
      for (let c = 0; c < a.length; c++) {
        const dv = b[c]! - a[c]!
        if (Math.abs(dv) < 1e-12) continue
        for (const bound of [lo, hi]) {
          const p = (bound - a[c]!) / dv
          if (p > 1e-6 && p < 1 - 1e-6) cuts.push(fracAt(e, p))
        }
      }
    }
    cuts.sort((x, y) => x - y)
    let rest = e
    let done = 0
    for (const f of cuts) {
      if (f - done < 1e-6 || f > 1 - 1e-6) continue
      const s = splitEase(rest, (f - done) / (1 - done))
      eases.push(s.left)
      const E = easeAt(e, f)
      times.push(t0 + f * (t1 - t0))
      values.push(a.map((x, c) => x + (b[c]! - x) * E))
      rest = s.right
      done = f
    }
    eases.push(rest)
    times.push(t1)
    values.push(b)
  }
  return { ...t, times, values: values.map((v) => v.map((x) => Math.min(hi, Math.max(lo, x)))), eases }
}

/** Component [i] of a vector track (times [scale]). */
function scalar(t: Track, i: number, scale = 1): Track {
  return { ...t, values: t.values.map((v) => [v[i]! * scale]) }
}

function sameTimeline(a: Track, b: Track): boolean {
  const eq = (x: number, y: number) => Math.abs(x - y) < 1e-6
  if (!eq(a.dur, b.dur) || !eq(a.delay, b.delay) || a.plays !== b.plays || a.reverse !== b.reverse) return false
  if (a.times.length !== b.times.length || a.times.some((x, i) => !eq(x, b.times[i]!))) return false
  return a.eases.every((e, i) => JSON.stringify(e) === JSON.stringify(b.eases[i]))
}

const round = (x: number, d: number) => {
  const r = Math.round(x * 10 ** d) / 10 ** d
  return Object.is(r, -0) ? 0 : r
}

function cssColor(argb: number): string {
  const a = (argb >>> 24) & 255
  const hex = (argb & 0xffffff).toString(16).padStart(6, "0").toUpperCase()
  return a === 255 ? `#${hex}` : `rgba(${(argb >>> 16) & 255}, ${(argb >>> 8) & 255}, ${argb & 255}, ${round(a / 255, 3)})`
}

const easeId = (e: Ease) => (e.k === "lin" ? "3" : e.k === "step" ? "5" : `4,${e.b.map((x) => round(x, 4)).join(",")}`)

/** A track in the template's timing format (ZnTiming.parse in ZnAnimation.kt). */
export function encode(t: Track, color = false): string {
  const dur = Math.max(1, Math.round(t.dur))
  // Keyframe times as whole ms (the phone places keyframes by ms), rising by at least 1 ms.
  const ms: number[] = []
  for (const x of t.times) {
    let m = Math.round(x * dur)
    if (ms.length > 0 && m <= ms[ms.length - 1]!) m = ms[ms.length - 1]! + 1
    ms.push(m)
  }
  const total = Math.max(dur, ms[ms.length - 1]!)
  const value = (v: number[]) => (color ? `#${(v[0]! >>> 0).toString(16).toUpperCase().padStart(8, "0")}` : String(round(v[0]!, 4)))
  const allSame = t.eases.every((e) => JSON.stringify(e) === JSON.stringify(t.eases[0]))
  const e0 = t.eases[0] ?? LIN
  let base: string
  const opts: string[] = []
  if (allSame && e0.k === "lin") base = `t${total}e3`
  else if (allSame && e0.k === "bez") {
    base = `t${total}e4`
    opts.push(`b${e0.b.map((x) => round(x, 4)).join(":")}`)
  } else {
    base = `t${total}e3`
    opts.push(`z${t.eases.map(easeId).join(":")}`)
  }
  if (t.delay > 0) opts.push(`d${Math.round(t.delay)}`)
  opts.push(`k${t.values.map(value).join(":")}`)
  opts.push(`m${ms.map((m) => round(m / total, 6)).join(":")}`)
  if (t.plays !== 1) opts.push(`r${t.plays}`)
  if (t.reverse) opts.push("v")
  if (t.tap) opts.push("w")
  return `${base}~${opts.join("~")}`
}
