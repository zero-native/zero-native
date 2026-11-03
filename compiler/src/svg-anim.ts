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
// in that order), and the geometry of shapes with no stroke (cx, cy, r, rx, ry, x, y, width, height), which is an
// exact scale and move of the drawn shape. SMIL begin chains ("a.end-0.1s") are flattened into one repeating cycle.
// Everything else fails the build with a hint: moving along a path, morphing `d`, stroke width or dashes, geometry of
// stroked shapes, click triggers, CSS selectors beyond class / id / tag.
import { Prop } from "@zero-native/template"
import type { Matrix } from "./svg-data"
import { IDENTITY, multiply, parseTransform } from "./svg-path"
import type { SvgAttr, SvgNode } from "./svg-xml"

// ---- Curves: values over time, with an easing per segment --------------------------------------------------------

type Ease = { k: "lin" } | { k: "step" } | { k: "bez"; b: [number, number, number, number] }
const LIN: Ease = { k: "lin" }

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
  return {
    t: c.t.map((x) => start + end - x).reverse(),
    v: [...c.v].reverse(),
    e: [...c.e].reverse().map((e) => (e.k === "bez" ? { k: "bez", b: [1 - e.b[2], 1 - e.b[3], 1 - e.b[0], 1 - e.b[1]] } : e.k === "step" ? LIN : e)),
  }
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
  /** Its own transform, when an animation replaces it (the rest value), else null. */
  replaced: Matrix | null
  /** Geometry before the build changed it, and what was baked: base / baked is the rest scale. */
  base: Record<string, number>
  baked: Record<string, number>
  /** Opacity values before the build set them to 1. */
  baseOpacity: Record<string, number>
  /** Base colours of animated fill / stroke. */
  baseColor: Record<string, number>
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
/** CSS properties a keyframe or rule may set besides the animation ones, written into the element as attributes. */
const CSS_PRESENTATION = new Set([
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit",
  "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "color", "visibility", "display",
])

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
  return n.tag === "style" || SMIL.has(n.tag) || n.children.some(hasAnimation)
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
interface Selector {
  tag?: string
  id?: string
  classes: string[]
}
interface Keyframes {
  stops: Array<{ offsets: number[]; decls: Map<string, string> }>
  at: string
}

class Extractor {
  private elements: AnimatedElement[] = []
  private ids = new Set<string>()
  private next = 0
  private rules: Rule[] = []
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
        fail(at, `begin "${p}" isn't supported (a time, or another animation's begin / end; no click or other events): ${HINT}`)
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

  private dur(anim: SvgNode): number {
    const d = anim.attrs.get("dur")
    if (!d || d.value === "indefinite") return fail(anim.at, `an animation needs a dur (like dur="1s"): ${HINT}`)
    const ms = clock(d.value, d.at, "dur")
    if (!(ms > 0)) fail(d.at, "dur must be more than 0")
    return ms
  }

  // ---- Walking the tree --------------------------------------------------------------------------------------

  private walk(n: SvgNode, parentCtm: Matrix, begins: Map<SvgNode, number[]>, inDefs: boolean, inh = { fill: "black", stroke: "none" }): SvgNode {
    if (n.tag === "style" || SMIL.has(n.tag)) return n // dropped by the parent below
    const defs = inDefs || ["defs", "clipPath", "mask", "symbol", "linearGradient", "radialGradient", "pattern"].includes(n.tag)
    const attrs = new Map(n.attrs)
    // CSS rules write their presentation values as attributes (style="..." still wins, as in CSS).
    const css = this.cssFor(n)
    for (const [k, v] of css) {
      if (CSS_PRESENTATION.has(k)) attrs.set(k, { value: v.value, at: v.at })
    }
    // Fill and stroke as inherited, for an animated colour's start value.
    const styled = (k: string) => new RegExp(`(?:^|;)\\s*${k}\\s*:\\s*([^;]+)`).exec(attrs.get("style")?.value ?? "")?.[1]?.trim()
    const mine = {
      fill: styled("fill") ?? attrs.get("fill")?.value.trim() ?? inh.fill,
      stroke: styled("stroke") ?? attrs.get("stroke")?.value.trim() ?? inh.stroke,
    }
    this.inherited.set(n, mine)
    const anims = n.children.filter((c) => SMIL.has(c.tag))
    const cssAnim = this.cssAnimations(n, css, attrs)
    const own = attrs.get("transform")
    const ownM = own ? this.transform(own) : null
    let ctm = ownM ? multiply(parentCtm, ownM) : parentCtm
    const children: SvgNode[] = []

    if (anims.length > 0 || cssAnim.length > 0) {
      if (defs) fail(n.at, `animations inside <defs>, clip paths, masks or gradients aren't supported: ${HINT}`)
      if (n === this.root) fail(n.at, `animating the <svg> itself isn't supported: animate the elements inside it, or animate the zn element that shows the SVG`)
      const id = attrs.get("id")?.value ?? this.newId()
      attrs.set("id", { value: id, at: n.at })
      const el: AnimatedElement = { id, tag: n.tag, at: n.at, tracks: [], ctm, replaced: null, base: {}, baked: {}, baseOpacity: {}, baseColor: {} }
      const byAttr = new Map<string, SourceTrack[]>()
      for (const a of anims) {
        const t = this.smilTrack(n, a, attrs, begins.get(a)!)
        byAttr.set(t.attr, [...(byAttr.get(t.attr) ?? []), t])
      }
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
  }

  // ---- SMIL ----------------------------------------------------------------------------------------------------

  private smilTrack(el: SvgNode, a: SvgNode, attrs: Map<string, SvgAttr>, begins: number[]): SourceTrack {
    const at = a.at
    if (a.tag === "animateMotion") fail(at, `<animateMotion> (moving along a path) isn't supported: ${HINT}`)
    if (a.tag === "set") fail(at, `<set> isn't supported: ${HINT}`)
    if (a.attrs.has("href") || a.attrs.has("xlink:href")) fail(at, `an animation that points at another element (href) isn't supported: put it inside that element`)
    const name = a.attrs.get("attributeName")?.value
    if (!name) return fail(at, "an animation needs attributeName")
    if (a.attrs.get("attributeType")?.value === "XML" && name === "style") fail(at, `animating style isn't supported: ${HINT}`)
    const accumulate = a.attrs.get("accumulate")?.value === "sum"
    if (accumulate) fail(at, `accumulate="sum" isn't supported: ${HINT}`)
    let attr = name
    let kind = ""
    if (a.tag === "animateTransform") {
      if (name !== "transform") fail(at, `animateTransform on "${name}" isn't supported (only transform)`)
      kind = a.attrs.get("type")?.value ?? "translate"
      if (!["rotate", "scale", "translate"].includes(kind)) fail(at, `animateTransform type="${kind}" isn't supported (rotate, scale, translate): ${HINT}`)
      attr = kind
    } else {
      this.checkAnimatable(el, name, at)
    }
    const read = (s: string): number[] => this.smilValue(attr, s, at, el)
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
    const out: SourceTrack = { attr, track, at, additive: a.attrs.get("additive")?.value === "sum", cycle, freeze }
    if (attr === "rotate") out.origin = [values[0]![1]!, values[0]![2]!]
    if (attr === "scale") out.origin = [0, 0]
    return out
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
    return { ...first, track: trackOf(rotate(c, -lead), Math.max(0, t0), -1, false) }
  }

  /** The value of [attr] when nothing animates it (for from-less animations and fill="remove"). */
  private baseValue(attr: string, el: SvgNode, attrs: Map<string, SvgAttr>, at: string): number[] {
    if (attr === "rotate") return [0, 0, 0]
    if (attr === "scale") return [1, 1]
    if (attr === "translate") return [0, 0]
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
    if (COLORS.has(attr)) {
      const c = this.colorOf(s.trim())
      if (c === null) fail(at, `can't read colour "${s}" in an animation`)
      return [c!]
    }
    const n = plainNumbers(s, at, attr)
    if (attr === "rotate") return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0]
    if (attr === "scale") return [n[0] ?? 1, n[1] ?? n[0] ?? 1]
    if (attr === "translate") return [n[0] ?? 0, n[1] ?? 0]
    if (n.length !== 1) fail(at, `"${attr}" takes one number, got "${s}"`)
    if (OPACITIES.has(attr)) return [clamp01(n[0]!)]
    return n
  }

  /** What an animation (SMIL or CSS) may change on [el], with a hint for the rest. */
  private checkAnimatable(el: SvgNode, name: string, at: string) {
    if (OPACITIES.has(name) || COLORS.has(name)) return
    if (GEOMETRY[el.tag]?.includes(name)) return
    if (name === "d") fail(at, `morphing a path (animating d) isn't supported: ${HINT}`)
    if (name === "stroke-width") fail(at, `animating stroke-width isn't supported: ${HINT}`)
    if (name === "stroke-dasharray" || name === "stroke-dashoffset") {
      fail(at, `animating stroke dashes isn't supported: draw the line with a part's trimStart / trimEnd instead (docs/svg.md §9)`)
    }
    if (["x", "y", "width", "height", "cx", "cy", "r", "rx", "ry", "x1", "y1", "x2", "y2", "points"].includes(name)) {
      fail(at, `animating "${name}" on <${el.tag}> isn't supported (geometry animates on <circle>, <ellipse> and <rect>): ${HINT}`)
    }
    fail(at, `animating "${name}" isn't supported: ${HINT}`)
  }

  // ---- CSS -----------------------------------------------------------------------------------------------------

  private parseCss(text: string, at: string) {
    const src = text.replace(/\/\*[\s\S]*?\*\//g, "")
    let i = 0
    let order = 0
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
      if (head.startsWith("@")) fail(at, `CSS ${head.split(/\s/)[0]} isn't supported in an SVG (only plain rules and @keyframes)`)
      this.rules.push({ selectors: head.split(",").map((s) => this.selector(s.trim(), at)), decls: this.decls(body, at), order: order++, at })
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

  /** `.a`, `#id`, `tag`, `tag.a.b`, and descendants of those (`.a circle`). */
  private selector(s: string, at: string): Selector[] {
    const parts = s.split(/\s+/)
    return parts.map((p) => {
      const m = /^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)$/.exec(p)
      if (!m || p === "") return fail(at, `CSS selector "${s}" isn't supported (use .class, #id, a tag, or "parent child" of those)`)
      const sel: Selector = { classes: [] }
      if (m[1] && m[1] !== "*") sel.tag = m[1]
      for (const x of m[2]!.match(/[.#][\w-]+/g) ?? []) {
        if (x[0] === "#") sel.id = x.slice(1)
        else sel.classes.push(x.slice(1))
      }
      return sel
    })
  }

  private parents = new Map<SvgNode, SvgNode>()
  private inherited = new Map<SvgNode, { fill: string; stroke: string }>()

  private matches(n: SvgNode, sel: Selector[]): boolean {
    const one = (x: SvgNode, s: Selector) => {
      if (s.tag && x.tag !== s.tag) return false
      if (s.id && x.attrs.get("id")?.value !== s.id) return false
      const cls = (x.attrs.get("class")?.value ?? "").split(/\s+/)
      return s.classes.every((c) => cls.includes(c))
    }
    if (!one(n, sel[sel.length - 1]!)) return false
    let k = sel.length - 2
    for (let p = this.parentOf(n); p && k >= 0; p = this.parentOf(p)) if (one(p, sel[k]!)) k--
    return k < 0
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
        const spec = sel.reduce((a, s) => a + (s.id ? 10_000 : 0) + s.classes.length * 100 + (s.tag ? 1 : 0), 0)
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
      if (k === "transform") continue
      fail(css.get(k)!.at, `CSS property "${k}" isn't supported in an SVG`)
    }
    const anim = this.animationList(css)
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
        if (p !== "transform") this.checkAnimatable(n, p, kf!.at)
        // Keyframes that set this property, sorted; the ends come from the element when missing.
        const points: Array<{ t: number; v: number[]; e: Ease | null }> = []
        for (const s of kf!.stops) {
          if (!s.decls.has(p)) continue
          const tf = s.decls.get("animation-timing-function")
          for (const o of s.offsets) points.push({ t: o, v: this.cssValue(p, s.decls.get(p)!, kf!.at), e: tf ? this.timingFunction(tf, kf!.at) : null })
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
        const base = p === "transform" ? this.restTransform(attrs, css, n) : this.baseValue(p, n, attrs, a.at)
        if (points[0]!.t > 0) points.unshift({ t: 0, v: base, e: null })
        if (points[points.length - 1]!.t < 1) points.push({ t: 1, v: base, e: null })
        let curve: Curve = {
          t: points.map((x) => x.t * a.dur),
          v: points.map((x) => x.v),
          e: points.slice(0, -1).map((x) => x.e ?? a.ease),
        }
        if (a.direction === "reverse" || a.direction === "alternate-reverse") curve = mirror(curve)
        const reverse = a.direction === "alternate" || a.direction === "alternate-reverse"
        let delay = a.delay
        if (delay < 0) {
          if (a.count !== Infinity) fail(a.at, `a negative animation-delay on an animation that doesn't loop isn't supported: ${HINT}`)
          curve = reverse ? rotate(concat(curve, mirror(curve)), -delay) : rotate(curve, -delay)
          delay = 0
          if (reverse) {
            out.push(this.cssTrack(p, trackOf(curve, 0, -1, false), a.at, n, css))
            continue
          }
        }
        out.push(this.cssTrack(p, trackOf(curve, delay, a.count === Infinity ? -1 : a.count, reverse), a.at, n, css))
      }
    }
    return out
  }

  private cssTrack(p: string, track: Track, at: string, n: SvgNode, css: Map<string, { value: string; at: string }>): SourceTrack {
    if (p !== "transform") return { attr: p, track, at }
    return { attr: "css-transform", track, at, origin: this.origin(css, n) }
  }

  /** The element's own transform as [tx, ty, deg, sx, sy] around its CSS origin: what a missing keyframe uses. */
  private restTransform(attrs: Map<string, SvgAttr>, css: Map<string, { value: string; at: string }>, n: SvgNode): number[] {
    const a = attrs.get("transform")
    if (!a) return [0, 0, 0, 1, 1]
    const r = decompose(this.transform(a), this.origin(css, n), a.at)
    return [r.tx, r.ty, r.deg, r.sx, r.sy]
  }

  /** animation / animation-* → one entry per animation name. */
  private animationList(css: Map<string, { value: string; at: string }>) {
    type A = { name: string; dur: number; delay: number; ease: Ease; count: number; direction: string; at: string }
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
          } else if (tok in CSS_EASE || tok.startsWith("cubic-bezier(") || tok.startsWith("steps(")) a.ease = this.timingFunction(tok, at)
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

  private timingFunction(s: string, at: string): Ease {
    const t = s.trim()
    if (t in CSS_EASE) return CSS_EASE[t]!
    const m = /^cubic-bezier\(([^)]*)\)$/.exec(t)
    if (m) return { k: "bez", b: bezier(m[1]!, at) }
    // One jump at the end of each segment (hold, then change), like SMIL calcMode="discrete".
    if (/^steps\(\s*1\s*(,\s*(end|jump-end)\s*)?\)$/.test(t)) return { k: "step" }
    if (t.startsWith("steps(") || t === "step-start") fail(at, `${t} timing isn't supported (only steps(1) / step-end): ${HINT}`)
    return fail(at, `can't read the timing function "${t}"`)
  }

  private cssValue(p: string, v: string, at: string): number[] {
    if (p === "transform") return this.cssTransform(v, at).values
    if (COLORS.has(p)) {
      const c = this.colorOf(v)
      if (c === null) fail(at, `can't read colour "${v}" in a keyframe`)
      return [c!]
    }
    const pct = /^([\d.]+)%$/.exec(v)
    if (pct && OPACITIES.has(p)) return [clamp01(Number(pct[1]) / 100)]
    const n = plainNumbers(v, at, p)
    if (n.length !== 1) fail(at, `"${p}" takes one value, got "${v}"`)
    return OPACITIES.has(p) ? [clamp01(n[0]!)] : n
  }

  /**
   * A CSS transform list → [tx, ty, deg, sx, sy] (translate, then rotate, then scale, any of them left out), and the
   * same as SVG transform text. Other orders or functions fail: they don't move linearly in these values.
   */
  private cssTransform(v: string, at: string): { values: number[]; text: string; kinds: string } {
    const s = v.trim()
    if (s === "none") return { values: [0, 0, 0, 1, 1], text: "", kinds: "" }
    const out = [0, 0, 0, 1, 1]
    let stage = 0 // 1 translate, 2 rotate, 3 scale
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
        if (st <= stage) fail(at, `transform "${s}": only translate, then rotate, then scale (in that order) can animate: ${HINT}`)
        stage = st
        kinds += "TRS"[st - 1]
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
      } else if (f === "scale" || f === "scaleX" || f === "scaleY") {
        want(3)
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

const ORDER = ["translate", "rotate", "scale"]

function isTransform(attr: string): boolean {
  return attr === "rotate" || attr === "scale" || attr === "translate" || attr === "css-transform"
}

const CSS_EASE: Record<string, Ease> = {
  linear: LIN,
  ease: { k: "bez", b: [0.25, 0.1, 0.25, 1] },
  "ease-in": { k: "bez", b: [0.42, 0, 1, 1] },
  "ease-out": { k: "bez", b: [0, 0, 0.58, 1] },
  "ease-in-out": { k: "bez", b: [0.42, 0, 0.58, 1] },
  "step-end": { k: "step" },
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
 * `animate` string in the template's timing format (registry 11, with "z" per-segment easings).
 */
export function motionParts(elements: AnimatedElement[], info: (id: string) => PartInfo | undefined): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>()
  for (const el of elements) {
    const part = info(el.id)
    if (!part) continue // draws nothing
    const props: Record<string, unknown> = {}
    const animate: string[] = []
    let turns = false
    const channel = (prop: string, t: Track, rest: number | null) => {
      if (rest !== null && Math.abs(rest - DEFAULTS[prop]!) > 1e-9) props[prop] = round(rest, 4)
      animate.push(`${Prop[prop as keyof typeof Prop].id}=${encode(t)}`)
      if (prop === "rotate" || prop === "scaleX" || prop === "scaleY") turns = true
    }
    const transforms = el.tracks.filter((t) => isTransform(t.attr))
    const geometry = el.tracks.filter((t) => GEOMETRY[el.tag]?.includes(t.attr))
    const k = conjugation(el, transforms.some((t) => t.attr === "rotate" || t.attr === "css-transform"))
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

    // Transforms: one pivot for the part; translate, rotate and scale tracks become its channels.
    let pivot: [number, number] | null = null
    if (transforms.length > 0) {
      if (!k) fail(el.at, `an animated transform inside a rotated, skewed or stretched group isn't supported: ${HINT}`)
      const origins = transforms.filter((t) => t.attr !== "translate").map((t) => t.origin!)
      const o = origins[0] ?? [0, 0]
      if (origins.some((p) => Math.abs(p[0] - o[0]) > 1e-6 || Math.abs(p[1] - o[1]) > 1e-6)) {
        fail(el.at, `a rotation and a scale around different points on one element isn't supported: ${HINT}`)
      }
      const seen = new Set<string>()
      for (const t of transforms) {
        const keys = t.attr === "css-transform" ? ["translate", "rotate", "scale"] : [t.attr]
        for (const key of keys) {
          if (seen.has(key)) fail(t.at, `two ${key} animations on one element aren't supported: ${HINT}`)
          seen.add(key)
        }
      }
      pivot = apply(k!, o)
      // The element's own transform, when replaced, is the rest value: as the same channels around the pivot.
      const rest = el.replaced ? decompose(el.replaced, o, el.at) : { tx: 0, ty: 0, deg: 0, sx: 1, sy: 1 }
      for (const t of transforms) {
        const tr = t.track
        if (t.attr === "rotate") channel("rotate", scalar(tr, 0, k!.turn), rest.deg * k!.turn)
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
        }
      }
    }

    // Geometry of a shape with no stroke: an exact scale and move around the baked shape's centre.
    if (geometry.length > 0) {
      if (part.stroke) fail(geometry[0]!.at, `animating the size or position of a shape with a stroke isn't supported (the stroke would scale too): ${HINT}`)
      if (!k) fail(el.at, `an animated shape inside a rotated, skewed or stretched group isn't supported: ${HINT}`)
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

const DEFAULTS: Record<string, number> = { opacity: 1, rotate: 0, scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }

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

/** [m] as translate + rotate + scale around [o]: m(p) = o + t + R S (p - o). Skews fail. */
function decompose(m: Matrix, o: [number, number], at: string): { tx: number; ty: number; deg: number; sx: number; sy: number } {
  const [a, b, c, d, e, f] = m
  const sx = Math.hypot(a, b)
  const th = Math.atan2(b, a)
  const sy = sx === 0 ? d : (a * d - b * c) / sx
  // R S has c = -sin(th) sy, d = cos(th) sy.
  if (Math.abs(c + Math.sin(th) * sy) > 1e-6 || Math.abs(d - Math.cos(th) * sy) > 1e-6) {
    fail(at, `the element's own transform has a skew, which can't be its rest value under an animation: ${HINT}`)
  }
  const tx = e + a * o[0] + c * o[1] - o[0]
  const ty = f + b * o[0] + d * o[1] - o[1]
  return { tx, ty, deg: (th * 180) / Math.PI, sx, sy }
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
  return `${base}~${opts.join("~")}`
}
