// SVG → draw data, at build time (docs/svg.md §5, §6). Used for .svg files (via svg-xml.ts) and for inline <Svg> in
// TSX (compile.ts turns the JSX into the same SvgNode tree). Every element and attribute is checked against the
// supported subset: anything else fails the build with its file:line:col and a hint. Nothing is silently dropped
// except the attributes listed in IGNORED (hints that don't change the picture) and editor data.
import { readFileSync, statSync } from "node:fs"
import {
  type ClipDef,
  type DrawData,
  type DrawOp,
  type EffectDef,
  type FilterDef,
  type FilterPrim,
  type GradientDef,
  type Matrix,
  type Paint,
  type PathCmd,
  type StrokeSpec,
  type TextRun,
  writeDrawData,
} from "./svg-data"
import {
  applyToPoint,
  arcToCubics,
  ellipsePath,
  forEachSegment,
  IDENTITY,
  multiply,
  numberList,
  parsePathData,
  parseTransform,
  pathBBox,
  polyPath,
  rectPath,
  similarityScale,
  transformPath,
} from "./svg-path"
import { extractAnimations, motionParts } from "./svg-anim"
import { parseSvgXml, type SvgNode } from "./svg-xml"

export interface CompiledSvg {
  /** The draw data (svg-data.ts). */
  data: string
  /** Element id → its op index: the parts a screen can change. */
  parts: Map<string, number>
  /** A part's op index → its box [x0, y0, x1, y1] in viewBox space (none for a part that draws nothing). */
  boxes: Map<number, [number, number, number, number]>
  /**
   * The file's own animations (SMIL / CSS, svg-anim.ts) as SvgPart props, keyed by element id: rest values, pivot and
   * `animate`. Empty for an SVG that doesn't move.
   */
  motion: Map<string, Record<string, unknown>>
  /** Whether the drawing uses currentColor (the Svg node's `color`). */
  usesCurrentColor: boolean
  /** Registry 13: the SVG's <text>, joined (the Svg node's default TalkBack label); "" without text. */
  text: string
  /** Stroked shapes whose width a group part's strokeWidth must not replace (compile.ts pins them). */
  widthPins: WidthPin[]
  /** The SVG's own size in dp: its width / height attributes, else the viewBox size. */
  width: number
  height: number
}

/**
 * A shape that set its own stroke-width below some part groups (registry 13). A strokeWidth on a group in [above]
 * must leave it at [width] (its own, in the units the part's strokeWidth uses), unless a group in [below] (under where
 * the width was set) also has one, as that one is nearer.
 */
export interface WidthPin {
  shape: number
  width: number
  above: number[]
  below: number[]
}

// ---- What is supported ---------------------------------------------------------------------------------------------

/** Presentation properties that children inherit (SVG 1.1), with their initial values. */
const INHERITED = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "clip-rule", "color", "visibility",
  "paint-order", "marker-start", "marker-mid", "marker-end",
  "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "text-anchor", "dominant-baseline",
] as const
type InheritedName = (typeof INHERITED)[number]
const INITIAL: Record<InheritedName, string> = {
  fill: "black", "fill-opacity": "1", "fill-rule": "nonzero", stroke: "none", "stroke-width": "1",
  "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4", "stroke-dasharray": "none",
  "stroke-dashoffset": "0", "stroke-opacity": "1", "clip-rule": "nonzero", color: "currentColor", visibility: "visible",
  "paint-order": "normal", "marker-start": "none", "marker-mid": "none", "marker-end": "none",
  "font-family": "sans-serif", "font-size": "16", "font-weight": "normal", "font-style": "normal",
  "letter-spacing": "normal", "text-anchor": "start", "dominant-baseline": "auto",
}
/** Properties that may also be written in style="...". */
const STYLE_PROPS = new Set<string>([
  ...INHERITED, "opacity", "clip-path", "mask", "display", "stop-color", "stop-opacity", "vector-effect", "mask-type",
  "filter", "flood-color", "flood-opacity", "mix-blend-mode", "marker", "text-decoration", "font", "white-space",
])
const COMMON = new Set<string>([...STYLE_PROPS, "id", "style", "transform", "class", "requiredFeatures", "requiredExtensions", "systemLanguage"])

/** Hints that don't change the picture (docs/svg.md §5 "Ignored on purpose"). Also any `data-*`, `aria-*`, `x:y`. */
const IGNORED = new Set([
  "version", "baseProfile", "shape-rendering", "text-rendering", "image-rendering", "color-interpolation",
  "color-interpolation-filters", "color-rendering", "isolation", "enable-background", "role", "focusable", "overflow",
  "xmlns", "word-spacing", "font-stretch", "font-variant", "font-kerning",
  "data-name", "tabindex",
])
// unDraw illustrations carry `artist` and `source` (credits) on the root.
IGNORED.add("artist")
IGNORED.add("source")
const ignoredName = (n: string) => IGNORED.has(n) || n.startsWith("data-") || n.startsWith("aria-") || (n.includes(":") && n !== "xlink:href")

/** Element-specific attributes, on top of COMMON. */
const OWN: Record<string, string[]> = {
  svg: ["viewBox", "width", "height", "preserveAspectRatio", "x", "y"],
  g: [],
  switch: [],
  text: ["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"],
  tspan: ["x", "y", "dx", "dy", "rotate", "textLength", "lengthAdjust"],
  marker: ["viewBox", "preserveAspectRatio", "refX", "refY", "markerUnits", "markerWidth", "markerHeight", "orient", "overflow"],
  path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  defs: [],
  linearGradient: ["x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod", "href", "xlink:href"],
  radialGradient: ["cx", "cy", "r", "fx", "fy", "fr", "gradientUnits", "gradientTransform", "spreadMethod", "href", "xlink:href"],
  stop: ["offset"],
  clipPath: ["clipPathUnits"],
  mask: ["x", "y", "width", "height", "maskUnits", "maskContentUnits"],
  pattern: ["x", "y", "width", "height", "patternUnits", "patternContentUnits", "patternTransform", "viewBox", "preserveAspectRatio", "href", "xlink:href"],
  filter: ["x", "y", "width", "height", "filterUnits", "primitiveUnits"],
  // Filter primitives (registry 13). x / y / width / height (a primitive's own region) are read only to refuse them.
  feGaussianBlur: ["in", "stdDeviation", "edgeMode", "result", "x", "y", "width", "height"],
  feOffset: ["in", "dx", "dy", "result", "x", "y", "width", "height"],
  feFlood: ["result", "x", "y", "width", "height"],
  // `mode` on feColorMatrix is a common typo for `type` (svg-spinners' gooey files); browsers ignore it.
  feColorMatrix: ["in", "type", "values", "mode", "result", "x", "y", "width", "height"],
  feComposite: ["in", "in2", "operator", "k1", "k2", "k3", "k4", "result", "x", "y", "width", "height"],
  feBlend: ["in", "in2", "mode", "result", "x", "y", "width", "height"],
  feMerge: ["result", "x", "y", "width", "height"],
  feMergeNode: ["in"],
  feDropShadow: ["in", "dx", "dy", "stdDeviation", "result", "x", "y", "width", "height"],
  use: ["href", "xlink:href", "x", "y", "width", "height"],
  symbol: ["viewBox", "preserveAspectRatio"],
}
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"])
/** Dropped with everything inside them. */
const DROPPED = new Set(["title", "desc", "metadata"])

/** Refused elements, with the hint the build error gives. */
const REFUSED: Record<string, string> = {
  textPath: "<textPath> isn't supported: convert the text to outlines in the design tool",
  image: "<image> isn't supported: put an <Image> and the SVG in a <Stack>",
  foreignObject: "<foreignObject> isn't supported",
  ...Object.fromEntries(
    ["feTurbulence", "feDisplacementMap", "feComponentTransfer", "feConvolveMatrix", "feMorphology", "feImage", "feTile",
      "feDiffuseLighting", "feSpecularLighting"].map((t) => [t, `<${t}> isn't supported: filters may use blur, offset, flood, colour matrix, composite, blend, merge and drop shadow (docs/svg.md §17); export the effect as a PNG`]),
  ),
  animate: "SMIL animation isn't supported: animate parts with zn's animate (phase 2), or use a Lottie file",
  animateTransform: "SMIL animation isn't supported: animate parts with zn's animate (phase 2), or use a Lottie file",
  animateMotion: "SMIL animation isn't supported: animate parts with zn's animate (phase 2), or use a Lottie file",
  set: "SMIL animation isn't supported: animate parts with zn's animate (phase 2), or use a Lottie file",
  style: "<style> (CSS) isn't supported: inline the styles as attributes (svgo's inlineStyles, or the design tool's presentation-attributes export)",
}
const REFUSED_ATTRS: Record<string, string> = {
}

// ---- Entry points --------------------------------------------------------------------------------------------------

const fileCache = new Map<string, { mtime: number; size: number; out: CompiledSvg }>()

/** Reads and compiles an .svg file. Cached by path, change time and size (`zn dev` rebuilds in one process). */
export function compileSvgFile(path: string): CompiledSvg {
  const st = statSync(path)
  const hit = fileCache.get(path)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.out
  const out = compileSvgTree(parseSvgXml(readFileSync(path, "utf8"), path))
  fileCache.set(path, { mtime: st.mtimeMs, size: st.size, out })
  return out
}

/** Compiles a parsed SVG (root: the <svg> element). Throws "file:line:col: message" for anything unsupported. */
export function compileSvgTree(root: SvgNode): CompiledSvg {
  // SMIL and CSS animations come out first; the rest of the file compiles as a still picture with parts.
  const { root: still, elements } = extractAnimations(root, parseSvgColor)
  const c = new SvgCompiler(still, new Set(elements.filter((e) => e.tag === "stop").map((e) => e.id)))
  const out = c.run()
  if (elements.length > 0) {
    out.motion = motionParts(elements, (id) => {
      const index = out.parts.get(id)
      if (index === undefined) return undefined
      const paint = c.paints.get(index) ?? { fill: false, stroke: false }
      return { index, box: out.boxes.get(index), ...paint }
    })
  }
  return out
}

// ---- The compiler --------------------------------------------------------------------------------------------------

type Inherited = Record<InheritedName, string>
type Box = [number, number, number, number]

/** One op before simplifying: like DrawOp, plus the element id. */
type IOp =
  | { op: "group"; id?: string; opacity: number; clip: number; mask?: number; filter?: number; blend?: number; children: IOp[]; depth?: number }
  | (Extract<DrawOp, { op: "shape" }> & { id?: string; widthAt?: number })
  | (Extract<DrawOp, { op: "text" }> & { id?: string; box: Bounds | null })

/** A group's mask, filter or blend (registry 13): such a group is never merged away. */
const hasEffects = (o: { mask?: number; filter?: number; blend?: number }) =>
  (o.mask ?? -1) >= 0 || (o.filter ?? -1) >= 0 || (o.blend ?? 0) !== 0

/** An op without its element ids (pattern and mask contents have no parts). */
function plainOp(o: IOp): DrawOp {
  if (o.op === "group") {
    const { id: _id, children, ...g } = o
    return { ...g, children: children.map(plainOp) }
  }
  if (o.op === "text") {
    const { id: _id, box: _box, ...text } = o
    return text
  }
  const { id: _id, ...shape } = o
  return shape
}

class SvgCompiler {
  private ids = new Map<string, SvgNode>()
  private gradients: GradientDef[] = []
  private gradientKeys = new Map<string, number>()
  private clips: ClipDef[] = []
  private clipKeys = new Map<string, number>()
  private filters: FilterDef[] = []
  private filterKeys = new Map<string, number>()
  /** Patterns and masks in the order they are written; each kind numbered on its own. */
  private effects: EffectDef[] = []
  private effectKeys = new Map<string, number>()
  private patternCount = 0
  private maskCount = 0
  /** Patterns and masks being compiled (one that uses itself fails). */
  private patternStack: SvgNode[] = []
  private maskStack: SvgNode[] = []
  private usesCurrent = false
  private vb: [number, number, number, number] = [0, 0, 0, 0]
  private useStack: SvgNode[] = []
  /** A part's op index → whether it (or anything inside it) has a fill / a stroke. */
  readonly paints = new Map<number, { fill: boolean; stroke: boolean }>()
  /** Gradient stops that take a part's colour (registry 13), by the stop element's id. */
  private stopLinks: Array<{ gradient: number; stop: number; id: string }> = []
  /** How deep in the tree the element being drawn is, and (per inherited style) where its stroke-width was set. */
  private treeDepth = 0
  private widthDepth = new WeakMap<Inherited, number>()

  /** [animatedStops]: ids of <stop> elements whose colour animates (svg-anim.ts). */
  constructor(
    private root: SvgNode,
    private animatedStops: Set<string> = new Set(),
  ) {}

  private fail(at: string, msg: string): never {
    throw new Error(`${at}: ${msg}`)
  }

  run(): CompiledSvg {
    const root = this.root
    if (root.tag !== "svg") this.fail(root.at, `the root element must be <svg>, not <${root.tag}>`)
    this.collectIds(root)

    // Size and viewBox.
    const w = this.optLength(root, "width")
    const h = this.optLength(root, "height")
    const vbAttr = root.attrs.get("viewBox")
    if (vbAttr) {
      let v: number[] = []
      try {
        v = numberList(vbAttr.value, "viewBox")
      } catch (e) {
        this.fail(vbAttr.at, (e as Error).message)
      }
      if (v.length !== 4 || !(v[2]! > 0) || !(v[3]! > 0)) this.fail(vbAttr.at, `viewBox needs 4 numbers with a positive width and height, got "${vbAttr.value}"`)
      this.vb = v as [number, number, number, number]
    } else {
      if (w === null || h === null) this.fail(root.at, "the <svg> needs a viewBox (or a numeric width and height)")
      this.vb = [0, 0, w!, h!]
    }
    const aspect = this.aspect(root)

    // The root's own presentation attributes (fill="none" from Figma, ...) and transform apply to everything inside.
    const rootInh = this.inherit(root, { ...INITIAL })
    const rootCtm = this.ctmOf(root, IDENTITY)
    const rootOp = this.element(root, rootCtm, this.children(root, rootCtm, rootInh))
    const simplified = this.simplify(rootOp ? [rootOp] : [])

    // Number the ops (pre-order) and collect parts, with each part's box in viewBox space (its turning point).
    const parts = new Map<string, number>()
    const boxes = new Map<number, [number, number, number, number]>()
    let index = 0
    const union = (a: Box | null, b: Box | null): Box | null =>
      !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
    const boxOf = (o: IOp): Box | null => {
      if (o.op === "group") return o.children.reduce<Box | null>((acc, c) => union(acc, boxOf(c)), null)
      if (o.op === "text") return o.box
      const p = o.matrix ? transformPath(o.path, o.matrix) : o.path
      return pathBBox(p)
    }
    const paintOf = (o: IOp): { fill: boolean; stroke: boolean } => {
      if (o.op === "shape") return { fill: o.fill.kind !== "none", stroke: o.stroke.kind !== "none" }
      if (o.op === "text") return { fill: o.runs.some((r) => r.fill.kind !== "none"), stroke: o.runs.some((r) => r.stroke.kind !== "none") }
      return o.children.map(paintOf).reduce((a, b) => ({ fill: a.fill || b.fill, stroke: a.stroke || b.stroke }), { fill: false, stroke: false })
    }
    // Groups around the op being numbered (index, tree depth), for the stroke width pins.
    const chain: Array<{ index: number; depth: number }> = []
    const widthPins: WidthPin[] = []
    const toDraw = (o: IOp): DrawOp => {
      const i = index++
      if (o.id !== undefined) {
        parts.set(o.id, i)
        const box = boxOf(o)
        if (box) boxes.set(i, box)
        this.paints.set(i, paintOf(o))
      }
      if (o.op === "group") {
        const { id: _id, children, depth, ...g } = o
        chain.push({ index: i, depth: depth ?? -1 })
        const out = { ...g, children: children.map(toDraw) }
        chain.pop()
        return out
      }
      if (o.op === "text") {
        const { id: _id, box: _box, ...text } = o
        return text
      }
      const { id: _id, widthAt, ...shape } = o
      // Groups above the element that set this stroke's width can't change it (SVG keeps the child's own).
      if (widthAt !== undefined && shape.strokeSpec && shape.strokeSpec.width > 0) {
        const above = chain.filter((g) => g.depth >= 0 && g.depth < widthAt).map((g) => g.index)
        if (above.length > 0) widthPins.push({ shape: i, width: shape.strokeSpec.width, above, below: chain.filter((g) => g.depth >= widthAt).map((g) => g.index) })
      }
      return shape
    }
    const drawOps = simplified.map(toDraw)
    // Animated gradient stops are parts numbered after the ops, one per stop element.
    const stopLinks: Array<[number, number, number]> = []
    for (const l of [...this.stopLinks].sort((a, b) => a.gradient - b.gradient || a.stop - b.stop)) {
      if (!parts.has(l.id)) parts.set(l.id, index++)
      stopLinks.push([l.gradient, l.stop, parts.get(l.id)!])
    }

    const maxSide = Math.max(this.vb[2], this.vb[3])
    const decimals = Math.max(0, Math.min(4, Math.ceil(Math.log10(2_000 / maxSide) - 1e-9)))
    const data: DrawData = {
      viewBox: this.vb,
      aspect,
      gradients: this.gradients,
      clips: this.clips,
      filters: this.filters,
      effects: this.effects,
      stopLinks,
      ops: drawOps,
    }
    return {
      data: writeDrawData(data, decimals),
      parts,
      boxes,
      motion: new Map(),
      usesCurrentColor: this.usesCurrent,
      text: this.allText(drawOps),
      widthPins,
      width: w ?? this.vb[2],
      height: h ?? this.vb[3],
    }
  }

  /** The text of every text op in [ops], one line per chunk, joined with spaces. */
  private allText(ops: DrawOp[]): string {
    const out: string[] = []
    const walk = (o: DrawOp) => {
      if (o.op === "text") out.push(o.runs.map((r) => r.text).join("").trim())
      else if (o.op === "group") o.children.forEach(walk)
    }
    ops.forEach(walk)
    return out.filter((t) => t !== "").join(" ")
  }

  // ---- Checks --------------------------------------------------------------------------------------------------

  private collectIds(n: SvgNode) {
    this.check(n)
    const id = n.attrs.get("id")
    if (id) {
      if (this.ids.has(id.value)) this.fail(id.at, `id "${id.value}" is used twice (also at ${this.ids.get(id.value)!.at})`)
      this.ids.set(id.value, n)
    }
    if (DROPPED.has(n.tag) || n.tag.includes(":")) return
    for (const c of n.children) this.collectIds(c)
  }

  /** Refuses unknown or unsupported elements and attributes. */
  private check(n: SvgNode) {
    if (DROPPED.has(n.tag) || n.tag.includes(":")) return
    if (n.tag in REFUSED) this.fail(n.at, REFUSED[n.tag]!)
    const own = OWN[n.tag]
    if (!own) this.fail(n.at, `<${n.tag}> isn't supported in zero-native SVGs (docs/svg.md §5)`)
    for (const [name, a] of n.attrs) {
      if (name in REFUSED_ATTRS) this.fail(a.at, REFUSED_ATTRS[name]!)
      if (COMMON.has(name) || own!.includes(name) || ignoredName(name)) continue
      this.fail(a.at, `attribute "${name}" isn't supported on <${n.tag}> (docs/svg.md §5)`)
    }
    const style = n.attrs.get("style")
    if (style) this.styleOf(n) // validates
    if (n.text.trim() !== "" && n.tag !== "stop" && n.tag !== "text" && n.tag !== "tspan") this.fail(n.at, `text inside <${n.tag}> isn't supported`)
  }

  private styleCache = new Map<SvgNode, Map<string, string>>()

  /** The style="..." declarations of [n] (validated). */
  private styleOf(n: SvgNode): Map<string, string> {
    const hit = this.styleCache.get(n)
    if (hit) return hit
    const out = new Map<string, string>()
    const style = n.attrs.get("style")
    if (style) {
      for (const decl of style.value.split(";")) {
        if (decl.trim() === "") continue
        const colon = decl.indexOf(":")
        if (colon < 0) this.fail(style.at, `can't read style "${decl.trim()}"`)
        const name = decl.slice(0, colon).trim()
        const value = decl.slice(colon + 1).trim().replace(/\s*!important$/, "")
        if (name === "mix-blend-mode" && value === "normal") continue
        if (name in REFUSED_ATTRS) this.fail(style.at, REFUSED_ATTRS[name]!)
        if (STYLE_PROPS.has(name)) out.set(name, value)
        else if (!ignoredName(name)) this.fail(style.at, `style property "${name}" isn't supported (docs/svg.md §5)`)
      }
    }
    this.styleCache.set(n, out)
    return out
  }

  /** A property of [n]: style="..." wins over the attribute (as in CSS). */
  private prop(n: SvgNode, name: string): { value: string; at: string } | null {
    const s = this.styleOf(n).get(name)
    if (s !== undefined) return { value: s, at: n.attrs.get("style")!.at }
    const a = n.attrs.get(name)
    return a ? { value: a.value.trim(), at: a.at } : null
  }

  private inherit(n: SvgNode, parent: Inherited): Inherited {
    const out = { ...parent }
    // The `marker` shorthand sets all three (the longhands, written on the same element, win).
    const all = this.prop(n, "marker")
    if (all && all.value !== "inherit") out["marker-start"] = out["marker-mid"] = out["marker-end"] = all.value
    for (const k of INHERITED) {
      const p = this.prop(n, k)
      if (p && p.value !== "inherit") out[k] = p.value
    }
    const sw = this.prop(n, "stroke-width")
    this.widthDepth.set(out, sw && sw.value !== "inherit" ? this.treeDepth : (this.widthDepth.get(parent) ?? -1))
    return out
  }

  // ---- Walking the tree ------------------------------------------------------------------------------------------

  private children(n: SvgNode, ctm: Matrix, inh: Inherited): IOp[] {
    const out: IOp[] = []
    for (const c of n.children) {
      const op = this.render(c, ctm, inh)
      if (op) out.push(op)
    }
    return out
  }

  /** One element and what's inside it, or null when it draws nothing. */
  private render(n: SvgNode, parentCtm: Matrix, parentInh: Inherited): IOp | null {
    this.treeDepth++
    try {
      return this.renderAt(n, parentCtm, parentInh)
    } finally {
      this.treeDepth--
    }
  }

  private renderAt(n: SvgNode, parentCtm: Matrix, parentInh: Inherited): IOp | null {
    if (DROPPED.has(n.tag) || n.tag.includes(":")) return null
    if (["defs", "linearGradient", "radialGradient", "clipPath", "mask", "pattern", "filter", "marker", "symbol", "stop"].includes(n.tag)) {
      if (n.tag === "stop") this.fail(n.at, "<stop> belongs inside a gradient")
      return null
    }
    if (this.prop(n, "display")?.value === "none") return null
    if (!this.passes(n)) return null
    const ctm = this.ctmOf(n, parentCtm)
    const inh = this.inherit(n, parentInh)

    if (n.tag === "g") return this.element(n, ctm, this.children(n, ctm, inh))
    // <switch> (registry 13): only its first child whose conditions pass.
    if (n.tag === "switch") {
      const pick = n.children.find((c) => !DROPPED.has(c.tag) && !c.tag.includes(":") && this.passes(c))
      const op = pick ? this.render(pick, ctm, inh) : null
      return this.element(n, ctm, op ? [op] : [])
    }
    if (n.tag === "svg") return this.nestedSvg(n, ctm, inh)
    if (n.tag === "text") return this.text(n, ctm, inh)
    if (n.tag === "use") return this.use(n, ctm, inh)
    if (SHAPES.has(n.tag)) return this.shape(n, ctm, inh)
    return this.fail(n.at, `<${n.tag}> can't be drawn here`)
  }

  /**
   * SVG's conditions: requiredExtensions names extensions we don't have (never passes), systemLanguage passes for
   * English (the build can't know the phone's language: docs/svg.md §17), requiredFeatures always passes (SVG 2).
   */
  private passes(n: SvgNode): boolean {
    if (n.attrs.has("requiredExtensions")) return false
    const lang = n.attrs.get("systemLanguage")
    if (lang) return lang.value.split(",").some((l) => /^en(-|$)/i.test(l.trim()))
    return true
  }

  /** A nested <svg> (registry 13): a group moved to x, y, its viewBox mapped into its size, cut to it (overflow). */
  private nestedSvg(n: SvgNode, ctm: Matrix, inh: Inherited): IOp | null {
    const x = this.coord(n, "x", "w")
    const y = this.coord(n, "y", "h")
    const size = (name: string, axis: Axis) => {
      const a = n.attrs.get(name)
      return a && a.value.trim() !== "auto" ? this.length(a.value, a.at, name, axis) : this.length("100%", n.at, name, axis)
    }
    const w = size("width", "w")
    const h = size("height", "h")
    if (w <= 0 || h <= 0) return null
    let inner = multiply(ctm, [1, 0, 0, 1, x, y])
    const vbA = n.attrs.get("viewBox")
    if (vbA) {
      let vb: number[] = []
      try {
        vb = numberList(vbA.value, "viewBox")
      } catch (e) {
        this.fail(vbA.at, (e as Error).message)
      }
      if (vb.length !== 4 || !(vb[2]! > 0) || !(vb[3]! > 0)) this.fail(vbA.at, `viewBox needs 4 numbers with a positive width and height, got "${vbA.value}"`)
      inner = multiply(inner, viewBoxMatrix(vb as Bounds, this.aspect(n), w, h))
    }
    const op = this.element(n, ctm, this.children(n, inner, inh))
    if (!op) return null
    const overflow = n.attrs.get("overflow")?.value.trim()
    if (overflow === "visible" || overflow === "auto") return op
    const clip = this.addClip({ paths: [{ rule: 0, path: transformPath(rectPath(x, y, w, h, 0, 0), ctm) }] })
    return { op: "group", opacity: 1, clip, children: [op] }
  }

  /** paint-order (registry 13) as the full order of "fill", "stroke", "markers" (the ones not named follow, in that order). */
  private paintOrder(v: string, at: string): string[] {
    const s = v.trim()
    if (s === "normal") return ["fill", "stroke", "markers"]
    const named = s.split(/\s+/)
    for (const w of named) {
      if (!["fill", "stroke", "markers"].includes(w)) this.fail(at, `paint-order must be normal or a list of fill, stroke, markers, got "${v}"`)
    }
    return [...named, ...["fill", "stroke", "markers"].filter((w) => !named.includes(w))]
  }

  /** mix-blend-mode (registry 13): 0 normal, else the draw data's blend code. */
  private blendOf(n: SvgNode): number {
    const p = this.prop(n, "mix-blend-mode")
    if (!p || p.value === "normal") return 0
    const i = BLEND_NAMES.indexOf(p.value)
    if (i < 0) this.fail(p.at, `mix-blend-mode "${p.value}" isn't supported (${BLEND_NAMES.join(", ")})`)
    return i + 1
  }

  private ctmOf(n: SvgNode, parent: Matrix): Matrix {
    const t = n.attrs.get("transform")
    if (!t) return parent
    try {
      return multiply(parent, parseTransform(t.value))
    } catch (e) {
      return this.fail(t.at, (e as Error).message)
    }
  }

  /** A group for [n] (the root, a <g> or a <use>): its opacity, clip and mask, around [children]. */
  private element(n: SvgNode, ctm: Matrix, children: IOp[]): IOp | null {
    const id = n.attrs.get("id")?.value
    const opacity = this.opacity(n)
    const fx = this.clipsOf(n, ctm, null)
    const filter = this.filterOf(n, ctm, null)
    if (fx.hide || filter === HIDE) return null
    const clips = fx.clips
    let op: IOp = { op: "group", id, opacity, clip: clips.length > 0 ? clips[0]! : -1, children, depth: this.treeDepth }
    if (fx.mask >= 0) op.mask = fx.mask
    if (filter >= 0) op.filter = filter
    const blend = this.blendOf(n)
    if (blend !== 0) op.blend = blend
    // A clip and a white mask on one element: two groups, the outer one with the second clip.
    for (const c of clips.slice(1)) op = { op: "group", opacity: 1, clip: c, children: [op] }
    return op
  }

  private use(n: SvgNode, ctm: Matrix, inh: Inherited): IOp | null {
    const href = n.attrs.get("href") ?? n.attrs.get("xlink:href")
    if (!href) this.fail(n.at, "<use> needs href")
    const target = this.ref(href!.value, href!.at, "#id")
    if (this.useStack.includes(target)) this.fail(n.at, "<use> refers to itself")
    if (n.attrs.has("width") || n.attrs.has("height")) {
      if (target.tag === "symbol" || target.tag === "svg") this.fail(n.at, "<use> with width / height on a symbol isn't supported")
    }
    const x = this.num(n, "x", 0)
    const y = this.num(n, "y", 0)
    const inner = multiply(ctm, [1, 0, 0, 1, x, y])
    this.useStack.push(target)
    let kids: IOp[]
    if (target.tag === "symbol") {
      if (target.attrs.has("viewBox")) this.fail(target.at, "a <symbol> with a viewBox isn't supported: use a <g>")
      kids = this.children(target, inner, inh)
    } else {
      // The target is drawn as if it were inside the <use>, without its own id (the <use>'s id names the part).
      const op = this.render({ ...target, attrs: new Map([...target.attrs].filter(([k]) => k !== "id")) }, inner, inh)
      kids = op ? [op] : []
    }
    this.useStack.pop()
    return this.element(n, ctm, kids)
  }

  // ---- Shapes ----------------------------------------------------------------------------------------------------

  private shape(n: SvgNode, ctm: Matrix, inh: Inherited): IOp | null {
    if (inh.visibility === "hidden" || inh.visibility === "collapse") return null
    const local = this.geometry(n)
    if (local.length === 0) return null
    const bbox = pathBBox(local)

    const strokeWidth = this.length(inh["stroke-width"], this.atOf(n, "stroke-width"), "stroke-width", "diag")
    let stroke = this.paint(n, inh, "stroke")
    if (strokeWidth <= 0) stroke = { raw: "none", at: stroke.at }
    const hasStroke = stroke.raw !== "none"
    const scale = similarityScale(ctm)
    // vector-effect="non-scaling-stroke" (not inherited): the stroke is so many dp wide, whatever the SVG's size.
    const effect = this.prop(n, "vector-effect")
    if (effect && effect.value !== "none" && effect.value !== "non-scaling-stroke") {
      this.fail(effect.at, `vector-effect="${effect.value}" isn't supported (only non-scaling-stroke)`)
    }
    const nonScaling = hasStroke && effect?.value === "non-scaling-stroke"
    // A stroke under a non-uniform scale or a skew must be drawn through the matrix; everything else is baked in.
    const keep = hasStroke && scale === null ? ctm : null
    const s = keep ? 1 : (scale ?? 1)
    const path = keep ? local : transformPath(local, ctm)
    const space = keep ? IDENTITY : ctm

    // A line has no inside, so no fill.
    const fill: Paint = n.tag === "line" ? { kind: "none" } : this.resolvePaint(this.paint(n, inh, "fill"), inh, bbox, space)
    const strokePaint = hasStroke ? this.resolvePaint(stroke, inh, bbox, space) : ({ kind: "none" } as Paint)

    let strokeSpec: StrokeSpec | null = null
    if (strokePaint.kind !== "none") {
      const cap = this.choice(inh["stroke-linecap"], this.atOf(n, "stroke-linecap"), "stroke-linecap", ["butt", "round", "square"])
      const joinName = inh["stroke-linejoin"] === "miter-clip" || inh["stroke-linejoin"] === "arcs" ? "miter" : inh["stroke-linejoin"]
      const join = this.choice(joinName, this.atOf(n, "stroke-linejoin"), "stroke-linejoin", ["miter", "round", "bevel"])
      const miter = this.plainNumber(inh["stroke-miterlimit"], this.atOf(n, "stroke-miterlimit"), "stroke-miterlimit")
      if (miter < 1) this.fail(this.atOf(n, "stroke-miterlimit"), "stroke-miterlimit must be 1 or more")
      const dashes = this.dashes(inh["stroke-dasharray"], this.atOf(n, "stroke-dasharray"))
      if (nonScaling && dashes.length > 0) this.fail(effect!.at, "dashes on a non-scaling stroke aren't supported: remove the dashes or the vector-effect")
      strokeSpec = {
        width: nonScaling ? strokeWidth : strokeWidth * s,
        cap: cap as 0 | 1 | 2,
        join: join as 0 | 1 | 2,
        miter,
        dashes: dashes.map((d) => d * s),
        dashOffset: this.length(inh["stroke-dashoffset"], this.atOf(n, "stroke-dashoffset"), "stroke-dashoffset", "diag") * s,
      }
      if (nonScaling) strokeSpec.nonScaling = true
    }
    const order = this.paintOrder(inh["paint-order"], this.atOf(n, "paint-order"))
    const shape: Extract<IOp, { op: "shape" }> = {
      op: "shape",
      id: n.attrs.get("id")?.value,
      fill,
      fillAlpha: this.alpha(inh["fill-opacity"], this.atOf(n, "fill-opacity"), "fill-opacity"),
      stroke: strokePaint,
      strokeAlpha: this.alpha(inh["stroke-opacity"], this.atOf(n, "stroke-opacity"), "stroke-opacity"),
      rule: this.choice(inh["fill-rule"], this.atOf(n, "fill-rule"), "fill-rule", ["nonzero", "evenodd"]) as 0 | 1,
      ...(fill.kind !== "none" && strokePaint.kind !== "none" && order.indexOf("stroke") < order.indexOf("fill") ? { strokeFirst: true } : {}),
      opacity: this.opacity(n),
      strokeSpec,
      matrix: keep,
      path,
    }
    // How deep the element that set the stroke-width is (a group part's strokeWidth must not replace it: run()).
    const widthAt = this.widthDepth.get(inh) ?? -1
    if (strokeSpec && widthAt >= 0) shape.widthAt = widthAt
    const fx = this.clipsOf(n, ctm, bbox)
    const filter = this.filterOf(n, ctm, bbox)
    if (fx.hide || filter === HIDE) return null
    let op: IOp = shape
    // Markers (registry 13): copies of the marker's content at the vertices, in paint-order with the fill and stroke.
    const markers = n.tag === "rect" || n.tag === "circle" || n.tag === "ellipse" ? [] : this.markers(n, inh, local, ctm, strokeWidth)
    if (markers.length > 0) {
      const list: IOp[] = []
      const strokeOnly = (): IOp => ({ ...shape, id: undefined, fill: { kind: "none" }, strokeFirst: undefined, opacity: 1 })
      const mi = order.indexOf("markers")
      // Markers between the fill and the stroke split the shape in two (the fill keeps the id).
      const between = fill.kind !== "none" && strokePaint.kind !== "none" && mi === 1
      if (between) {
        const first = order[0] === "fill" ? { ...shape, stroke: { kind: "none" } as Paint, strokeSpec: null, opacity: 1 } : strokeOnly()
        const second = order[0] === "fill" ? strokeOnly() : { ...shape, stroke: { kind: "none" } as Paint, strokeSpec: null, opacity: 1 }
        if (order[0] !== "fill") (second as typeof shape).id = shape.id
        list.push(first, ...markers, second)
      } else if (mi === 0) {
        list.push(...markers, { ...shape, opacity: 1 })
      } else {
        list.push({ ...shape, opacity: 1 }, ...markers)
      }
      // The element's opacity covers the markers too.
      op = { op: "group", opacity: shape.opacity, clip: -1, children: list }
    }
    // SVG's order: the filter first, then the clip, then the mask.
    if (filter >= 0) op = { op: "group", opacity: 1, clip: -1, filter, children: [op] }
    for (const c of fx.clips) op = { op: "group", opacity: 1, clip: c, children: [op] }
    if (fx.mask >= 0) op = { op: "group", opacity: 1, clip: -1, mask: fx.mask, children: [op] }
    const blend = this.blendOf(n)
    if (blend !== 0) op = { op: "group", opacity: 1, clip: -1, blend, children: [op] }
    return op
  }

  /**
   * [n]'s markers (registry 13) as ops in viewBox space, start, mid and end in vertex order. [local]: its geometry in
   * user space; [strokeWidth]: its stroke-width in user units (markerUnits="strokeWidth" scales by it).
   */
  private markers(n: SvgNode, inh: Inherited, local: PathCmd[], ctm: Matrix, strokeWidth: number): IOp[] {
    const which = (name: "marker-start" | "marker-mid" | "marker-end"): SvgNode | null => {
      const v = inh[name].trim()
      if (v === "none") return null
      const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(v)
      if (!m) this.fail(this.atOf(n, name), `${name} must be url(#id) or none, got "${v}"`)
      const t = this.ids.get(m![1]!)
      if (!t) return null // SVG: a missing marker draws nothing
      if (t.tag !== "marker") this.fail(this.atOf(n, name), `"${m![1]}" is a <${t.tag}>, not a <marker>`)
      return t
    }
    const start = which("marker-start")
    const mid = which("marker-mid")
    const end = which("marker-end")
    if (!start && !mid && !end) return []
    const vertices = markerVertices(local)
    const out: IOp[] = []
    vertices.forEach((v, i) => {
      const m = i === 0 ? start : i === vertices.length - 1 ? end : mid
      if (!m) return
      if (this.useStack.includes(m)) this.fail(m.at, "a marker uses itself")
      // orient: auto (the direction there), auto-start-reverse, or an angle.
      const orient = m.attrs.get("orient")?.value.trim() ?? "0"
      let angle: number
      if (orient === "auto" || orient === "auto-start-reverse") {
        angle = v.angle
        if (orient === "auto-start-reverse" && i === 0) angle += 180
      } else {
        const a = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|rad|grad|turn)?$/.exec(orient)
        if (!a) this.fail(m.attrs.get("orient")!.at, `orient must be auto, auto-start-reverse or an angle, got "${orient}"`)
        const x = Number(a![1])
        angle = a![2] === "rad" ? (x * 180) / Math.PI : a![2] === "grad" ? x * 0.9 : a![2] === "turn" ? x * 360 : x
      }
      const units = m.attrs.get("markerUnits")?.value ?? "strokeWidth"
      if (units !== "strokeWidth" && units !== "userSpaceOnUse") this.fail(m.attrs.get("markerUnits")!.at, `markerUnits "${units}" isn't valid`)
      const k = units === "strokeWidth" ? strokeWidth : 1
      const mw = this.num(m, "markerWidth", 3)
      const mh = this.num(m, "markerHeight", 3)
      if (mw <= 0 || mh <= 0) return
      const vbA = m.attrs.get("viewBox")
      let vbM: Matrix = IDENTITY
      if (vbA) {
        let vb: number[] = []
        try {
          vb = numberList(vbA.value, "viewBox")
        } catch (e) {
          this.fail(vbA.at, (e as Error).message)
        }
        if (vb.length !== 4 || !(vb[2]! > 0) || !(vb[3]! > 0)) return
        vbM = viewBoxMatrix(vb as Bounds, this.aspect(m), mw, mh)
      }
      // The ref point (in the marker's content units) lands on the vertex.
      const [rx, ry] = applyToPoint(vbM, this.num(m, "refX", 0), this.num(m, "refY", 0))
      const r = (angle * Math.PI) / 180
      const place = multiply(multiply(ctm, [Math.cos(r) * k, Math.sin(r) * k, -Math.sin(r) * k, Math.cos(r) * k, v.x, v.y]), [1, 0, 0, 1, -rx, -ry])
      this.useStack.push(m)
      const kids = this.children(m, multiply(place, vbM), this.inherit(m, { ...INITIAL })).map(stripIds)
      this.useStack.pop()
      if (kids.length === 0) return
      const overflow = m.attrs.get("overflow")?.value.trim()
      const clip = overflow === "visible" || overflow === "auto" ? -1 : this.addClip({ paths: [{ rule: 0, path: transformPath(rectPath(0, 0, mw, mh, 0, 0), place) }] })
      out.push({ op: "group", opacity: 1, clip, children: kids })
    })
    return out
  }

  /**
   * A <text> (registry 13): one text op per line chunk (a new absolute x / y starts one), each made of runs in one
   * style (the text and its <tspan>s). The phone lays the line out with its own fonts. Not supported: per-character
   * positions (lists in x / y / dx / dy, rotate), textLength, <textPath>, decorations, vertical text.
   */
  private text(n: SvgNode, ctm: Matrix, inh: Inherited): IOp | null {
    if (inh.visibility === "hidden" || inh.visibility === "collapse") return null
    type Chunk = { x: number; y: number; anchor: 0 | 1 | 2; runs: Array<{ run: TextRun; el: SvgNode }> }
    const chunks: Chunk[] = []
    const preserve = n.attrs.get("xml:space")?.value === "preserve"
    const one = (k: SvgNode, name: string, size: number): number | null => {
      const a = k.attrs.get(name)
      if (!a) return null
      const list = a.value.trim().split(/[\s,]+/).filter((v) => v !== "")
      if (list.length > 1) this.fail(a.at, `${name} with several values (one per character) isn't supported: use one value, or a <tspan> per piece`)
      if (list.length === 0) return null
      return this.fontLength(list[0]!, a.at, name, size, name === "x" || name === "dx" ? "w" : "h")
    }
    const walk = (k: SvgNode, kInh: Inherited) => {
      for (const r of ["rotate", "textLength"]) {
        if (k.attrs.has(r)) this.fail(k.attrs.get(r)!.at, `${r} on <${k.tag}> isn't supported: convert the text to outlines, or remove ${r}`)
      }
      const deco = this.prop(k, "text-decoration")
      if (deco && deco.value !== "none") this.fail(deco.at, "text-decoration isn't supported in SVG text: draw the line as a shape")
      const fontP = this.prop(k, "font")
      if (fontP) this.fail(fontP.at, "the font shorthand isn't supported: use font-size, font-weight and font-family")
      const style = this.runStyle(k, kInh)
      const x = one(k, "x", style.size)
      const y = one(k, "y", style.size)
      let dx = one(k, "dx", style.size) ?? 0
      let dy = one(k, "dy", style.size) ?? 0
      if (x !== null || y !== null || chunks.length === 0) {
        const last = chunks[chunks.length - 1]
        if ((x === null || y === null) && last) {
          this.fail(k.at, `a <${k.tag}> that sets only ${x === null ? "y" : "x"} isn't supported: set both x and y (the build can't measure the text before it)`)
        }
        const anchorV = kInh["text-anchor"]
        const anchor = this.choice(anchorV, this.atOf(k, "text-anchor"), "text-anchor", ["start", "middle", "end"]) as 0 | 1 | 2
        chunks.push({ x: x ?? 0, y: y ?? 0, anchor, runs: [] })
      }
      for (const piece of k.content ?? []) {
        if (typeof piece === "string") {
          const text = preserve ? piece.replace(/[\n\r\t]/g, " ") : piece.replace(/[\n\r]/g, "").replace(/\t/g, " ").replace(/ {2,}/g, " ")
          if (text === "") continue
          chunks[chunks.length - 1]!.runs.push({ run: { ...style, dx, dy, text }, el: k })
          dx = 0
          dy = 0
          continue
        }
        if (DROPPED.has(piece.tag) || piece.tag.includes(":")) continue
        if (piece.tag === "textPath") this.fail(piece.at, REFUSED.textPath!)
        if (piece.tag !== "tspan") this.fail(piece.at, `<${piece.tag}> can't be inside <${k.tag}> (only text and <tspan>)`)
        if (this.prop(piece, "display")?.value === "none" || !this.passes(piece)) continue
        walk(piece, this.inherit(piece, kInh))
      }
    }
    walk(n, inh)
    // White space (xml:space default): no space at a line's start or end, none twice across runs.
    for (const c of chunks) {
      if (!preserve) {
        for (let i = 0; i < c.runs.length; i++) {
          const r = c.runs[i]!.run
          if (i > 0 && c.runs[i - 1]!.run.text.endsWith(" ") && r.text.startsWith(" ")) r.text = r.text.slice(1)
        }
        if (c.runs[0]) c.runs[0].run.text = c.runs[0].run.text.replace(/^ /, "")
        const lastRun = c.runs[c.runs.length - 1]
        if (lastRun) lastRun.run.text = lastRun.run.text.replace(/ $/, "")
      }
      c.runs = c.runs.filter((r) => r.run.text !== "")
    }
    const ops: IOp[] = []
    const matrix = ctm[0] === 1 && ctm[1] === 0 && ctm[2] === 0 && ctm[3] === 1 && ctm[4] === 0 && ctm[5] === 0 ? null : ctm
    for (const c of chunks) {
      if (c.runs.length === 0) continue
      // The box, guessed (the build can't measure text): about 0.55 em per character, an em high above the baseline.
      const size = Math.max(...c.runs.map((r) => r.run.size))
      const width = c.runs.reduce((acc, r) => acc + r.run.text.length * r.run.size * 0.55 + r.run.dx, 0)
      const x0 = c.x - width * (c.anchor / 2)
      const box = pathBBox(transformPath(rectPath(x0, c.y - size * 0.8, width, size, 0, 0), ctm))
      ops.push({ op: "text", x: c.x, y: c.y, anchor: c.anchor, matrix, runs: c.runs.map((r) => r.run), box })
    }
    if (ops.length === 0) return null
    const id = n.attrs.get("id")?.value
    const fx = this.clipsOf(n, ctm, null)
    const filter = this.filterOf(n, ctm, null)
    if (fx.hide || filter === HIDE) return null
    const opacity = this.opacity(n)
    const blend = this.blendOf(n)
    // One chunk with nothing around it is the part itself; else a group holds the chunks.
    if (ops.length === 1 && opacity === 1 && fx.clips.length === 0 && fx.mask < 0 && filter < 0 && blend === 0) {
      ;(ops[0] as { id?: string }).id = id
      return ops[0]!
    }
    let op: IOp = { op: "group", id, opacity, clip: fx.clips[0] ?? -1, children: ops }
    if (fx.mask >= 0) op.mask = fx.mask
    if (filter >= 0) op.filter = filter
    if (blend !== 0) op.blend = blend
    for (const c of fx.clips.slice(1)) op = { op: "group", opacity: 1, clip: c, children: [op] }
    return op
  }

  /** One text run's style from [k] and what it inherits (paint, stroke, font). */
  private runStyle(k: SvgNode, inh: Inherited): Omit<TextRun, "dx" | "dy" | "text"> {
    const size = this.fontSize(k, inh)
    // Paints: object units use a guessed box (the build can't measure the text).
    const guess: Bounds = [0, -size * 0.8, size * 4, size * 0.2]
    const fill = this.resolvePaint(this.paint(k, inh, "fill"), inh, guess, IDENTITY)
    const sw = this.length(inh["stroke-width"], this.atOf(k, "stroke-width"), "stroke-width", "diag")
    const strokeRaw = sw > 0 ? this.paint(k, inh, "stroke") : { raw: "none", at: k.at }
    const stroke = this.resolvePaint(strokeRaw, inh, guess, IDENTITY)
    let strokeSpec: StrokeSpec | null = null
    if (stroke.kind !== "none") {
      const cap = this.choice(inh["stroke-linecap"], this.atOf(k, "stroke-linecap"), "stroke-linecap", ["butt", "round", "square"])
      const joinName = inh["stroke-linejoin"] === "miter-clip" || inh["stroke-linejoin"] === "arcs" ? "miter" : inh["stroke-linejoin"]
      const join = this.choice(joinName, this.atOf(k, "stroke-linejoin"), "stroke-linejoin", ["miter", "round", "bevel"])
      strokeSpec = {
        width: sw,
        cap: cap as 0 | 1 | 2,
        join: join as 0 | 1 | 2,
        miter: Math.max(1, this.plainNumber(inh["stroke-miterlimit"], this.atOf(k, "stroke-miterlimit"), "stroke-miterlimit")),
        dashes: this.dashes(inh["stroke-dasharray"], this.atOf(k, "stroke-dasharray")),
        dashOffset: this.length(inh["stroke-dashoffset"], this.atOf(k, "stroke-dashoffset"), "stroke-dashoffset", "diag"),
      }
    }
    const w = inh["font-weight"].trim()
    const weight = w === "normal" ? 400 : w === "bold" || w === "bolder" ? 700 : w === "lighter" ? 300 : Number(w)
    if (!Number.isFinite(weight) || weight < 1 || weight > 1000) this.fail(this.atOf(k, "font-weight"), `font-weight must be normal, bold or 100–900, got "${w}"`)
    const fam = inh["font-family"].toLowerCase()
    // Only the phone's own fonts (no new fonts in a template): the generic family the list asks for, sans-serif else.
    const family = /\bmono|courier|consolas|menlo/.test(fam) ? 2 : /(^|[\s,'"])serif|times|georgia/.test(fam) && !/sans/.test(fam) ? 1 : 0
    const ls = inh["letter-spacing"].trim()
    const spacing = ls === "normal" ? 0 : this.fontLength(ls, this.atOf(k, "letter-spacing"), "letter-spacing", size, "w")
    const db = inh["dominant-baseline"].trim()
    const baseline = ["auto", "alphabetic", "ideographic"].includes(db) ? 0 : ["middle", "central"].includes(db) ? 1 : ["hanging", "text-before-edge", "text-top"].includes(db) ? 2 : -1
    if (baseline < 0) this.fail(this.atOf(k, "dominant-baseline"), `dominant-baseline "${db}" isn't supported (auto, alphabetic, middle, central, hanging)`)
    return {
      fill,
      fillAlpha: this.alpha(inh["fill-opacity"], this.atOf(k, "fill-opacity"), "fill-opacity"),
      stroke,
      strokeAlpha: this.alpha(inh["stroke-opacity"], this.atOf(k, "stroke-opacity"), "stroke-opacity"),
      opacity: k.tag === "tspan" ? this.opacity(k) : 1,
      strokeSpec,
      size,
      weight: Math.round(weight / 100) * 100,
      italic: /italic|oblique/.test(inh["font-style"]),
      family: family as 0 | 1 | 2,
      spacing,
      baseline: baseline as 0 | 1 | 2,
    }
  }

  /** [k]'s font size in user units: a number or px, em / % of the parent's size, or a CSS size keyword. */
  private fontSize(k: SvgNode, inh: Inherited): number {
    const raw = inh["font-size"].trim()
    const words: Record<string, number> = { "xx-small": 9, "x-small": 10, small: 13, medium: 16, large: 18, "x-large": 24, "xx-large": 32 }
    if (raw in words) return words[raw]!
    return this.fontLength(raw, this.atOf(k, "font-size"), "font-size", 16, "h")
  }

  /** A length in text: a number, px, em (of [em]), or % (of [em] for font sizes, else of the viewBox). */
  private fontLength(v: string, at: string, what: string, em: number, axis: Axis): number {
    const s = v.trim()
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(em|rem)$/.exec(s)
    if (m) return Number(m[1]) * (m[2] === "rem" ? 16 : em)
    if (what === "font-size" && s.endsWith("%")) return (Number(s.slice(0, -1)) / 100) * em
    return this.length(s, at, what, axis)
  }

  /** The element's own geometry, in its user space. */
  private geometry(n: SvgNode): PathCmd[] {
    switch (n.tag) {
      case "path": {
        const d = n.attrs.get("d")
        if (!d || d.value.trim() === "") return []
        try {
          return parsePathData(d.value)
        } catch (e) {
          return this.fail(d.at, (e as Error).message)
        }
      }
      case "rect": {
        const x = this.coord(n, "x", "w")
        const y = this.coord(n, "y", "h")
        const w = this.coord(n, "width", "w")
        const h = this.coord(n, "height", "h")
        if (w < 0 || h < 0) this.fail(n.at, "a <rect> width / height can't be negative")
        if (w === 0 || h === 0) return []
        const rxA = n.attrs.get("rx")
        const ryA = n.attrs.get("ry")
        let rx = rxA && rxA.value !== "auto" ? this.coord(n, "rx", "w") : null
        let ry = ryA && ryA.value !== "auto" ? this.coord(n, "ry", "h") : null
        if ((rx !== null && rx < 0) || (ry !== null && ry < 0)) this.fail(n.at, "rx / ry can't be negative")
        rx ??= ry ?? 0
        ry ??= rx
        return rectPath(x, y, w, h, Math.min(rx, w / 2), Math.min(ry, h / 2))
      }
      case "circle": {
        const r = this.coord(n, "r", "diag")
        if (r < 0) this.fail(n.at, "r can't be negative")
        return r === 0 ? [] : ellipsePath(this.coord(n, "cx", "w"), this.coord(n, "cy", "h"), r, r)
      }
      case "ellipse": {
        const rx = this.coord(n, "rx", "w")
        const ry = this.coord(n, "ry", "h")
        if (rx < 0 || ry < 0) this.fail(n.at, "rx / ry can't be negative")
        return rx === 0 || ry === 0 ? [] : ellipsePath(this.coord(n, "cx", "w"), this.coord(n, "cy", "h"), rx, ry)
      }
      case "line":
        return [["M", this.coord(n, "x1", "w"), this.coord(n, "y1", "h")], ["L", this.coord(n, "x2", "w"), this.coord(n, "y2", "h")]]
      default: {
        const p = n.attrs.get("points")
        if (!p) return []
        let pts: number[] = []
        try {
          pts = numberList(p.value, "points")
        } catch (e) {
          this.fail(p.at, (e as Error).message)
        }
        if (pts.length % 2 === 1) pts.pop() // SVG: an odd last number is dropped
        return pts.length < 4 ? [] : polyPath(pts, n.tag === "polygon")
      }
    }
  }

  // ---- Paints ----------------------------------------------------------------------------------------------------

  private paint(n: SvgNode, inh: Inherited, which: "fill" | "stroke"): { raw: string; at: string } {
    return { raw: inh[which], at: this.atOf(n, which) }
  }

  /** Where property [name] was set on [n] (or the element itself). */
  private atOf(n: SvgNode, name: string): string {
    return this.prop(n, name)?.at ?? n.at
  }

  private resolvePaint(p: { raw: string; at: string }, inh: Inherited, bbox: Bounds | null, space: Matrix): Paint {
    const raw = p.raw.trim()
    if (raw === "none") return { kind: "none" }
    if (raw === "currentColor") return this.current(inh, p.at)
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)\s*(.*)$/.exec(raw)
    if (url) {
      const target = this.ids.get(url[1]!)
      if (!target) {
        if (url[2]) return this.resolvePaint({ raw: url[2], at: p.at }, inh, bbox, space)
        this.fail(p.at, `no element with id "${url[1]}"`)
      }
      if (target!.tag === "pattern") return this.pattern(target!, bbox, space, p.at)
      if (target!.tag !== "linearGradient" && target!.tag !== "radialGradient") {
        this.fail(p.at, `"${url[1]}" is a <${target!.tag}>, not a gradient or a pattern`)
      }
      return this.gradient(target!, bbox, space)
    }
    if (raw.startsWith("url(")) this.fail(p.at, `only local references like url(#id) are supported, got "${raw}"`)
    return { kind: "color", argb: this.color(raw, p.at) }
  }

  private current(inh: Inherited, at: string): Paint {
    // `color` set somewhere inside the SVG fixes currentColor at build time; otherwise it is the Svg node's color.
    if (inh.color !== "currentColor" && inh.color !== "inherit") return { kind: "color", argb: this.color(inh.color, at) }
    this.usesCurrent = true
    return { kind: "current" }
  }

  private color(s: string, at: string): number {
    const argb = parseSvgColor(s)
    if (argb === null) this.fail(at, `can't read colour "${s}" (use #RGB, #RRGGBB, #RRGGBBAA, rgb(), rgba() or a colour name)`)
    return argb!
  }

  private gradient(g: SvgNode, bbox: Bounds | null, space: Matrix): Paint {
    // href chains: attributes and stops come from the first gradient in the chain that has them.
    const chain: SvgNode[] = []
    for (let cur: SvgNode | undefined = g; cur; ) {
      if (chain.includes(cur)) this.fail(cur.at, "gradient href chain refers to itself")
      chain.push(cur)
      const h = cur.attrs.get("href") ?? cur.attrs.get("xlink:href")
      if (!h) break
      cur = this.ref(h.value, h.at, "#id")
      if (cur.tag !== "linearGradient" && cur.tag !== "radialGradient") this.fail(h.at, "a gradient's href must point to a gradient")
    }
    const attr = (name: string) => {
      for (const c of chain) {
        const a = c.attrs.get(name)
        if (a) return a
      }
      return null
    }
    const stopsFrom = chain.find((c) => c.children.some((k) => k.tag === "stop"))
    const units = attr("gradientUnits")?.value ?? "objectBoundingBox"
    if (units !== "objectBoundingBox" && units !== "userSpaceOnUse") this.fail(attr("gradientUnits")!.at, `gradientUnits "${units}" isn't valid`)
    const obb = units === "objectBoundingBox"

    // Stops.
    const stops: Array<{ offset: number; argb: number }> = []
    // Animated stops (registry 13): which stop numbers take a part's colour.
    const live: Array<[number, string]> = []
    for (const s of stopsFrom?.children ?? []) {
      if (s.tag !== "stop") {
        if (DROPPED.has(s.tag) || s.tag.includes(":")) continue
        this.fail(s.at, `<${s.tag}> can't be inside a gradient`)
      }
      const sid = s.attrs.get("id")?.value
      if (sid !== undefined && this.animatedStops.has(sid)) live.push([stops.length, sid])
      const offA = s.attrs.get("offset")
      let offset = offA ? this.fraction(offA.value, offA.at, "offset") : 0
      offset = Math.min(1, Math.max(0, offset, stops.length > 0 ? stops[stops.length - 1]!.offset : 0))
      const colorP = this.prop(s, "stop-color")
      const raw = colorP?.value ?? "black"
      if (raw === "currentColor") this.fail(colorP!.at, "currentColor in a gradient stop isn't supported")
      const argb = this.color(raw, colorP?.at ?? s.at)
      const opP = this.prop(s, "stop-opacity")
      const op = opP ? this.alpha(opP.value, opP.at, "stop-opacity") : 1
      const a = Math.round(((argb >>> 24) & 0xff) * op)
      stops.push({ offset, argb: ((a << 24) | (argb & 0xffffff)) >>> 0 })
    }
    if (stops.length === 0) return { kind: "none" }
    if (stops.length === 1) return { kind: "color", argb: stops[0]!.argb }

    // Coordinates, in the gradient's own units.
    const linear = g.tag === "linearGradient"
    const coordOf = (name: string, def: string, axis: Axis) => {
      const a = attr(name)
      const v = a?.value ?? def
      if (obb) return this.fraction(v, a?.at ?? g.at, name)
      return this.length(v, a?.at ?? g.at, name, axis)
    }
    let coords: number[]
    if (linear) {
      coords = [coordOf("x1", "0%", "w"), coordOf("y1", "0%", "h"), coordOf("x2", "100%", "w"), coordOf("y2", "0%", "h")]
    } else {
      coords = [coordOf("cx", "50%", "w"), coordOf("cy", "50%", "h"), coordOf("r", "50%", "diag")]
      if (coords[2]! <= 0) return { kind: "color", argb: stops[stops.length - 1]!.argb }
      // A focal circle (registry 13): fx / fy default to the centre, fr to 0.
      const fxA = attr("fx")
      const fyA = attr("fy")
      const frA = attr("fr")
      let fx = fxA ? coordOf("fx", "0", "w") : coords[0]!
      let fy = fyA ? coordOf("fy", "0", "h") : coords[1]!
      const fr = frA ? coordOf("fr", "0", "diag") : 0
      if (Math.abs(fx - coords[0]!) > 1e-9 || Math.abs(fy - coords[1]!) > 1e-9 || fr > 0) {
        // As browsers do (SVG 1.1): a focal point outside the circle moves onto its edge (just inside it).
        const dx = fx - coords[0]!
        const dy = fy - coords[1]!
        const dist = Math.hypot(dx, dy)
        const max = coords[2]! * 0.999
        if (dist > max) {
          fx = coords[0]! + (dx * max) / dist
          fy = coords[1]! + (dy * max) / dist
        }
        coords.push(fx, fy, Math.min(fr, coords[2]!))
      }
    }

    let m: Matrix = space
    if (obb) {
      if (!bbox || bbox[2] - bbox[0] <= 0 || bbox[3] - bbox[1] <= 0) return { kind: "none" } // SVG: not painted
      m = multiply(m, [bbox[2] - bbox[0], 0, 0, bbox[3] - bbox[1], bbox[0], bbox[1]])
    }
    const gt = attr("gradientTransform")
    if (gt) {
      try {
        m = multiply(m, parseTransform(gt.value))
      } catch (e) {
        this.fail(gt.at, (e as Error).message)
      }
    }
    const spreadA = attr("spreadMethod")
    const spread = this.choice(spreadA?.value ?? "pad", spreadA?.at ?? g.at, "spreadMethod", ["pad", "reflect", "repeat"]) as 0 | 1 | 2
    const def: GradientDef = {
      kind: linear ? "linear" : "radial",
      coords,
      spread,
      matrix: m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0 ? null : m,
      stops,
    }
    const key = JSON.stringify(def)
    let index = this.gradientKeys.get(key)
    if (index === undefined) {
      index = this.gradients.push(def) - 1
      this.gradientKeys.set(key, index)
    }
    for (const [j, sid] of live) {
      if (!this.stopLinks.some((l) => l.gradient === index && l.stop === j)) this.stopLinks.push({ gradient: index, stop: j, id: sid })
    }
    return { kind: "gradient", index }
  }

  /**
   * A pattern (registry 13): one tile in the pattern's space, its content drawn in that space, and the matrix from it
   * to the shape's [space]. Attributes and content come from the first pattern in the href chain that has them.
   */
  private pattern(p: SvgNode, bbox: Bounds | null, space: Matrix, at: string): Paint {
    const chain: SvgNode[] = []
    for (let cur: SvgNode | undefined = p; cur; ) {
      if (chain.includes(cur)) this.fail(cur.at, "pattern href chain refers to itself")
      chain.push(cur)
      const h = cur.attrs.get("href") ?? cur.attrs.get("xlink:href")
      if (!h) break
      cur = this.ref(h.value, h.at, "#id")
      if (cur.tag !== "pattern") this.fail(h.at, "a pattern's href must point to a pattern")
    }
    const attr = (name: string) => {
      for (const c of chain) {
        const a = c.attrs.get(name)
        if (a) return a
      }
      return null
    }
    const drawable = (k: SvgNode) => !DROPPED.has(k.tag) && !k.tag.includes(":")
    const holder = chain.find((c) => c.children.some(drawable))
    if (!holder) return { kind: "none" }
    if (this.patternStack.includes(holder)) this.fail(at, "a pattern uses itself")

    const units = attr("patternUnits")?.value ?? "objectBoundingBox"
    const contentUnits = attr("patternContentUnits")?.value ?? "userSpaceOnUse"
    for (const [name, v] of [["patternUnits", units], ["patternContentUnits", contentUnits]] as const) {
      if (v !== "objectBoundingBox" && v !== "userSpaceOnUse") this.fail(attr(name)!.at, `${name} "${v}" isn't valid`)
    }
    const empty = !bbox || bbox[2] - bbox[0] <= 0 || bbox[3] - bbox[1] <= 0
    if ((units === "objectBoundingBox" || contentUnits === "objectBoundingBox") && empty) return { kind: "none" }
    const bw = empty ? 0 : bbox![2] - bbox![0]
    const bh = empty ? 0 : bbox![3] - bbox![1]
    const v = (name: string, axis: Axis) => {
      const a = attr(name)
      if (units === "objectBoundingBox") {
        const f = a ? this.fraction(a.value, a.at, name) : 0
        return axis === "w" ? (name === "x" ? bbox![0] + f * bw : f * bw) : name === "y" ? bbox![1] + f * bh : f * bh
      }
      return a ? this.length(a.value, a.at, name, axis) : 0
    }
    const tile: [number, number, number, number] = [v("x", "w"), v("y", "h"), v("width", "w"), v("height", "h")]
    if (tile[2] <= 0 || tile[3] <= 0) return { kind: "none" } // SVG: a tile with no size paints nothing

    let m: Matrix = space
    const pt = attr("patternTransform")
    if (pt) {
      try {
        m = multiply(m, parseTransform(pt.value))
      } catch (e) {
        this.fail(pt.at, (e as Error).message)
      }
    }
    // The content's space inside the tile: its origin at the tile's corner, then the viewBox or the object units.
    let content: Matrix = [1, 0, 0, 1, tile[0], tile[1]]
    const vbA = attr("viewBox")
    if (vbA) {
      let vb: number[] = []
      try {
        vb = numberList(vbA.value, "viewBox")
      } catch (e) {
        this.fail(vbA.at, (e as Error).message)
      }
      if (vb.length !== 4 || !(vb[2]! > 0) || !(vb[3]! > 0)) this.fail(vbA.at, `viewBox needs 4 numbers with a positive width and height, got "${vbA.value}"`)
      const aspectNode = chain.find((c) => c.attrs.has("preserveAspectRatio")) ?? p
      content = multiply(content, viewBoxMatrix(vb as Bounds, this.aspect(aspectNode), tile[2], tile[3]))
    } else if (contentUnits === "objectBoundingBox") {
      content = multiply(content, [bw, 0, 0, bh, 0, 0]) // as browsers do: the box's size, from the tile's corner
    }
    this.patternStack.push(holder)
    const kids = this.simplify(this.children(holder, content, this.inherit(holder, { ...INITIAL })))
    this.patternStack.pop()
    if (kids.length === 0) return { kind: "none" }
    const isId = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
    const index = this.addEffect({ kind: "pattern", tile, matrix: isId ? null : m, ops: kids.map(plainOp) })
    return { kind: "pattern", index }
  }

  // ---- Filters (registry 13) -------------------------------------------------------------------------------------

  /**
   * [n]'s filter: a filter number, -1 for none, or HIDE when it hides the element (object units on something with no
   * size). `filter="url(#f)"` or CSS filter functions. [bbox]: [n]'s geometry in its user space (null: worked out).
   */
  private filterOf(n: SvgNode, ctm: Matrix, bbox: Bounds | null): number {
    const p = this.prop(n, "filter")
    if (!p || p.value === "none") return -1
    const box = bbox ?? this.userBox(n)
    const url = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(p.value)
    const prims: FilterPrim[] = []
    let region: Bounds
    if (url) {
      const f = this.ids.get(url[1]!)
      if (!f) this.fail(p.at, `no element with id "${url[1]}"`)
      if (f!.tag !== "filter") this.fail(p.at, `"${url[1]}" is a <${f!.tag}>, not a <filter>`)
      const r = this.filterPrims(f!, ctm, box, prims)
      if (r === null) return HIDE
      region = r
    } else {
      if (!box) return -1 // CSS filters on something that draws nothing
      region = this.cssFilter(p.value, p.at, ctm, box, prims)
    }
    if (prims.length === 0) return -1
    const def: FilterDef = { region, prims, shadows: filterShadows(prims) }
    const key = JSON.stringify(def)
    let index = this.filterKeys.get(key)
    if (index === undefined) {
      index = this.filters.push(def) - 1
      this.filterKeys.set(key, index)
    }
    return index
  }

  /** <filter> [f]'s primitives into [out], in viewBox space; returns the region, or null when it hides the element. */
  private filterPrims(f: SvgNode, ctm: Matrix, box: Bounds | null, out: FilterPrim[]): Bounds | null {
    const units = f.attrs.get("filterUnits")?.value ?? "objectBoundingBox"
    const pUnits = f.attrs.get("primitiveUnits")?.value ?? "userSpaceOnUse"
    for (const [name, v] of [["filterUnits", units], ["primitiveUnits", pUnits]] as const) {
      if (v !== "objectBoundingBox" && v !== "userSpaceOnUse") this.fail(f.attrs.get(name)!.at, `${name} "${v}" isn't valid`)
    }
    const empty = !box || box[2] - box[0] <= 0 || box[3] - box[1] <= 0
    if ((units === "objectBoundingBox" || pUnits === "objectBoundingBox") && empty) return null
    const bw = empty ? 0 : box![2] - box![0]
    const bh = empty ? 0 : box![3] - box![1]
    // The region in user space, then its box in viewBox space.
    const rv = (name: string, def: string, axis: Axis) => {
      const a = f.attrs.get(name)
      if (units === "objectBoundingBox") {
        const fr = this.fraction(a?.value ?? def, a?.at ?? f.at, name)
        return name === "x" ? box![0] + fr * bw : name === "y" ? box![1] + fr * bh : fr * (axis === "w" ? bw : bh)
      }
      return this.length(a?.value ?? def, a?.at ?? f.at, name, axis)
    }
    const x = rv("x", "-10%", "w")
    const y = rv("y", "-10%", "h")
    const w = rv("width", "120%", "w")
    const h = rv("height", "120%", "h")
    if (w <= 0 || h <= 0) return null
    const region = pathBBox(transformPath(rectPath(x, y, w, h, 0, 0), ctm))!

    // Lengths: in user units (or fractions of the box), then into viewBox units through the matrix.
    const [a, b, c, d] = ctm
    const kx = Math.hypot(a, b)
    const ky = Math.hypot(c, d)
    const ux = pUnits === "objectBoundingBox" ? bw : 1
    const uy = pUnits === "objectBoundingBox" ? bh : 1
    const vec = (dx: number, dy: number): [number, number] => [a * dx * ux + c * dy * uy, b * dx * ux + d * dy * uy]
    const nums = (k: SvgNode, name: string, count: number, def: number[]): number[] => {
      const at = k.attrs.get(name)
      if (!at) return def
      let v: number[] = []
      try {
        v = numberList(at.value, name)
      } catch (e) {
        this.fail(at.at, (e as Error).message)
      }
      if (v.length === 0 || v.length > count) this.fail(at.at, `${name} needs ${count === 1 ? "a number" : `1 to ${count} numbers`}, got "${at.value}"`)
      return v
    }
    const results = new Map<string, number>()
    let prev = -1 // the previous primitive's result (SourceGraphic before the first)
    const input = (k: SvgNode, name: "in" | "in2"): number => {
      const at = k.attrs.get(name)
      if (!at) {
        if (name === "in2") this.fail(k.at, `<${k.tag}> needs in2`)
        return prev
      }
      const v = at.value.trim()
      if (v === "SourceGraphic") return -1
      if (v === "SourceAlpha") return -2
      if (["BackgroundImage", "BackgroundAlpha", "FillPaint", "StrokePaint"].includes(v)) {
        this.fail(at.at, `in="${v}" isn't supported (only SourceGraphic, SourceAlpha and earlier results)`)
      }
      return results.get(v) ?? prev // SVG: an unknown result name is read as no name
    }
    const push = (p: FilterPrim) => out.push(p) - 1
    const flood = (k: SvgNode): number => {
      const cp = this.prop(k, "flood-color")
      const raw = cp?.value ?? "black"
      if (raw === "currentColor") this.fail(cp!.at, "currentColor in a filter isn't supported: write the colour")
      const argb = this.color(raw, cp?.at ?? k.at)
      const op = this.prop(k, "flood-opacity")
      const alpha = op ? this.alpha(op.value, op.at, "flood-opacity") : 1
      return ((Math.round(((argb >>> 24) & 0xff) * alpha) << 24) | (argb & 0xffffff)) >>> 0
    }
    for (const k of f.children) {
      if (DROPPED.has(k.tag) || k.tag.includes(":")) continue
      for (const r of ["x", "y", "width", "height"]) {
        if (k.attrs.has(r)) this.fail(k.attrs.get(r)!.at, `a primitive's own region (${r} on <${k.tag}>) isn't supported: remove it (the filter's region applies)`)
      }
      let result: number
      switch (k.tag) {
        case "feGaussianBlur": {
          const s = nums(k, "stdDeviation", 2, [0]).map((v) => Math.max(0, v))
          const sx = s[0]!
          const sy = s[1] ?? sx
          result = push({ p: "b", in: input(k, "in"), sx: sx * kx * ux, sy: sy * ky * uy })
          break
        }
        case "feOffset": {
          const [dx, dy] = vec(this.num(k, "dx", 0), this.num(k, "dy", 0))
          result = push({ p: "o", in: input(k, "in"), dx, dy })
          break
        }
        case "feFlood":
          result = push({ p: "f", argb: flood(k) })
          break
        case "feColorMatrix": {
          const type = k.attrs.get("type")?.value ?? "matrix"
          const values = colorMatrix(type, k.attrs.get("values")?.value, k.attrs.get("values")?.at ?? k.attrs.get("type")?.at ?? k.at, (at, m) => this.fail(at, m))
          result = push({ p: "m", in: input(k, "in"), values })
          break
        }
        case "feComposite": {
          const opName = k.attrs.get("operator")?.value ?? "over"
          const i1 = input(k, "in")
          const i2 = input(k, "in2")
          const ops = ["over", "in", "out", "atop", "xor"]
          if (ops.includes(opName)) {
            result = push({ p: "c", in: i1, in2: i2, op: ops.indexOf(opName) })
          } else if (opName === "arithmetic") {
            const kv = ["k1", "k2", "k3", "k4"].map((n) => this.num(k, n, 0))
            const is = (...want: number[]) => want.every((v, j) => Math.abs(kv[j]! - v) < 1e-9)
            if (is(0, 1, 1, 0)) result = push({ p: "c", in: i1, in2: i2, op: 5 })
            else if (is(0, -1, 1, 0)) result = push({ p: "c", in: i1, in2: i2, op: 6 })
            else if (is(0, 1, 0, 0)) result = i1
            else if (is(0, 0, 1, 0)) result = i2
            else this.fail(k.attrs.get("operator")!.at, `feComposite arithmetic with k1..k4 = ${kv.join(" ")} isn't supported (only the sum "0 1 1 0" and Figma's inner shadow "0 -1 1 0")`)
          } else {
            this.fail(k.attrs.get("operator")!.at, `feComposite operator "${opName}" isn't valid`)
          }
          break
        }
        case "feBlend": {
          const mode = k.attrs.get("mode")?.value ?? "normal"
          const blend = mode === "normal" ? 0 : BLEND_NAMES.indexOf(mode) + 1
          if (blend < 0 || (mode !== "normal" && blend === 0)) this.fail(k.attrs.get("mode")!.at, `feBlend mode "${mode}" isn't valid`)
          result = push({ p: "B", in: input(k, "in"), in2: input(k, "in2"), blend })
          break
        }
        case "feMerge": {
          const ins = k.children.filter((m) => m.tag === "feMergeNode").map((m) => input(m, "in"))
          if (ins.length === 0) this.fail(k.at, "<feMerge> needs at least one <feMergeNode>")
          result = push({ p: "M", ins })
          break
        }
        case "feDropShadow": {
          const src = input(k, "in")
          const s = nums(k, "stdDeviation", 2, [2]).map((v) => Math.max(0, v))
          const [dx, dy] = vec(this.num(k, "dx", 2), this.num(k, "dy", 2))
          // = flood colour inside the offset, blurred alpha of the input, under the input.
          const alpha = src === -1 ? -2 : push({ p: "m", in: src, values: ALPHA_ONLY })
          const blur = push({ p: "b", in: alpha, sx: s[0]! * kx * ux, sy: (s[1] ?? s[0]!) * ky * uy })
          const moved = push({ p: "o", in: blur, dx, dy })
          const color = push({ p: "f", argb: flood(k) })
          const shadow = push({ p: "c", in: color, in2: moved, op: 1 })
          result = push({ p: "M", ins: [shadow, src] })
          break
        }
        default:
          this.fail(k.at, `<${k.tag}> can't be inside a <filter>`)
      }
      prev = result!
      const name = k.attrs.get("result")?.value.trim()
      if (name) results.set(name, prev)
    }
    // A filter whose output is just the source (or that has no primitives) changes nothing.
    if (prev === -1) out.length = 0
    else if (prev !== out.length - 1) out.push({ p: "M", ins: [prev] }) // the output is an earlier result
    return region
  }

  /** CSS filter functions (blur(), drop-shadow(), brightness(), ...) into [out]; returns the region in viewBox space. */
  private cssFilter(value: string, at: string, ctm: Matrix, box: Bounds, out: FilterPrim[]): Bounds {
    const [a, b, c, d] = ctm
    const k = Math.sqrt(Math.abs(a * d - b * c))
    const len = (s: string) => {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(px)?$/.exec(s.trim())
      if (!m) this.fail(at, `filter: lengths must be numbers or px, got "${s}"`)
      return Number(m![1])
    }
    const amount = (s: string | undefined, def: number) => {
      if (s === undefined || s.trim() === "") return def
      const t = s.trim()
      const v = t.endsWith("%") ? Number(t.slice(0, -1)) / 100 : Number(t)
      if (!Number.isFinite(v)) this.fail(at, `filter: can't read "${s}"`)
      return v
    }
    let prev = -1
    let grow = 0 // how far the effects reach past the box, in user units
    const re = /([a-z-]+)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g
    const rest = value.replace(re, "").trim()
    if (rest !== "") this.fail(at, `filter "${value}" isn't supported (url(#id) or CSS filter functions)`)
    for (const m of value.matchAll(re)) {
      const fn = m[1]!
      const arg = m[2]!.trim()
      if (fn === "blur") {
        const s = len(arg || "0")
        prev = out.push({ p: "b", in: prev, sx: s * k, sy: s * k }) - 1
        grow += 3 * s
      } else if (fn === "drop-shadow") {
        // offset-x offset-y [blur radius] [colour], the colour first or last.
        const parts = arg.match(/(?:rgba?|hsla?)\([^)]*\)|\S+/g) ?? []
        const colorPart = parts.find((p) => parseSvgColor(p) !== null && !/^[+-]?[\d.]/.test(p))
        const nums = parts.filter((p) => p !== colorPart).map(len)
        if (nums.length < 2 || nums.length > 3) this.fail(at, `drop-shadow() needs 2 or 3 lengths, got "${arg}"`)
        const argb = colorPart ? this.color(colorPart, at) : 0xff000000
        const std = (nums[2] ?? 0) / 2 // CSS gives a blur radius: twice the standard deviation
        const src = prev
        const alpha = src === -1 ? -2 : out.push({ p: "m", in: src, values: ALPHA_ONLY }) - 1
        const blur = out.push({ p: "b", in: alpha, sx: std * k, sy: std * k }) - 1
        const moved = out.push({ p: "o", in: blur, dx: a * nums[0]! + c * nums[1]!, dy: b * nums[0]! + d * nums[1]! }) - 1
        const color = out.push({ p: "f", argb }) - 1
        const shadow = out.push({ p: "c", in: color, in2: moved, op: 1 }) - 1
        prev = out.push({ p: "M", ins: [shadow, src] }) - 1
        grow += 3 * std + Math.max(Math.abs(nums[0]!), Math.abs(nums[1]!))
      } else {
        const values = cssColorMatrix(fn, amount(arg.split(/\s+/)[0], 1), arg, (msg) => this.fail(at, msg))
        prev = out.push({ p: "m", in: prev, values }) - 1
      }
    }
    const r = pathBBox(transformPath(rectPath(box[0] - grow, box[1] - grow, box[2] - box[0] + 2 * grow, box[3] - box[1] + 2 * grow, 0, 0), ctm))!
    return r
  }

  // ---- Clips and masks -------------------------------------------------------------------------------------------

  /**
   * [n]'s clip-path and mask: clip numbers (0, 1 or 2: a mask of plain white shapes is a clip), a mask number (or -1),
   * or hide when the mask hides everything. [bbox]: [n]'s geometry in its user space (null for a group: worked out).
   */
  private clipsOf(n: SvgNode, ctm: Matrix, bbox: Bounds | null): { clips: number[]; mask: number; hide: boolean } {
    const out = { clips: [] as number[], mask: -1, hide: false }
    for (const which of ["clip-path", "mask"] as const) {
      const p = this.prop(n, which)
      if (!p || p.value === "none") continue
      const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(p.value)
      if (!m) this.fail(p.at, `${which} must be url(#id), got "${p.value}"`)
      const target = this.ids.get(m![1]!)
      if (!target) this.fail(p.at, `no element with id "${m![1]}"`)
      const want = which === "clip-path" ? "clipPath" : "mask"
      if (target!.tag !== want) this.fail(p.at, `"${m![1]}" is a <${target!.tag}>, not a <${want}>`)
      if (which === "clip-path") {
        out.clips.push(this.clip(target!, ctm, bbox ?? this.userBox(n), p.at, n))
        continue
      }
      const mask = this.mask(target!, ctm, bbox ?? this.userBox(n), p.at, n)
      if (mask.hide) out.hide = true
      else if (mask.clip !== undefined) out.clips.push(mask.clip)
      else out.mask = mask.mask!
    }
    return out
  }

  /**
   * A mask (registry 13): its content drawn in viewBox space, and its region as a clip. A mask of plain white,
   * fully opaque shapes inside its region is the same as a clip, so it becomes one (cheaper and exact).
   */
  private mask(c: SvgNode, ctm: Matrix, box: Bounds | null, at: string, user: SvgNode): { clip?: number; mask?: number; hide?: true } {
    const regionUnits = c.attrs.get("maskUnits")?.value ?? "objectBoundingBox"
    const contentUnits = c.attrs.get("maskContentUnits")?.value ?? "userSpaceOnUse"
    for (const [name, v] of [["maskUnits", regionUnits], ["maskContentUnits", contentUnits]] as const) {
      if (v !== "objectBoundingBox" && v !== "userSpaceOnUse") this.fail(c.attrs.get(name)!.at, `${name} "${v}" isn't valid`)
    }
    const empty = !box || box[2] - box[0] <= 0 || box[3] - box[1] <= 0
    // SVG: object units on something with no size: the element isn't drawn.
    if ((regionUnits === "objectBoundingBox" || contentUnits === "objectBoundingBox") && empty) return { hide: true }
    // The region, in the user's space.
    let region: Bounds
    if (regionUnits === "objectBoundingBox") {
      const [x0, y0, x1, y1] = box!
      const f = (name: string, def: string) => {
        const a = c.attrs.get(name)
        return this.fraction(a?.value ?? def, a?.at ?? c.at, name)
      }
      const x = x0 + f("x", "-10%") * (x1 - x0)
      const y = y0 + f("y", "-10%") * (y1 - y0)
      region = [x, y, x + f("width", "120%") * (x1 - x0), y + f("height", "120%") * (y1 - y0)]
    } else {
      const l = (name: string, def: string, axis: Axis) => {
        const a = c.attrs.get(name)
        return this.length(a?.value ?? def, a?.at ?? c.at, name, axis)
      }
      const x = l("x", "-10%", "w")
      const y = l("y", "-10%", "h")
      region = [x, y, x + l("width", "120%", "w"), y + l("height", "120%", "h")]
    }
    if (region[2] <= region[0] || region[3] <= region[1]) return { hide: true }
    const contentM = contentUnits === "objectBoundingBox" ? multiply(ctm, [box![2] - box![0], 0, 0, box![3] - box![1], box![0], box![1]]) : ctm
    const typeP = this.prop(c, "mask-type")
    if (typeP && typeP.value !== "luminance" && typeP.value !== "alpha") this.fail(typeP.at, `mask-type must be luminance or alpha, got "${typeP.value}"`)
    const luminance = typeP?.value !== "alpha"

    // Plain white shapes inside the region: a clip.
    if (luminance && this.whiteMask(c)) {
      const inner = contentUnits === "objectBoundingBox" ? [box![2] - box![0], 0, 0, box![3] - box![1], box![0], box![1]] as Matrix : IDENTITY
      const cb = this.contentBox(c, inner)
      if (cb && cb[0] >= region[0] && cb[1] >= region[1] && cb[2] <= region[2] && cb[3] <= region[3]) {
        return { clip: this.clip(c, ctm, box, at, user) }
      }
    }
    if (this.maskStack.includes(c)) this.fail(at, "a mask uses itself")
    this.maskStack.push(c)
    const kids = this.simplify(this.children(c, contentM, this.inherit(c, { ...INITIAL })))
    this.maskStack.pop()
    if (kids.length === 0) return { hide: true } // an empty mask hides everything
    const regionPath = transformPath(rectPath(region[0], region[1], region[2] - region[0], region[3] - region[1], 0, 0), ctm)
    const regionClip = this.addClip({ paths: [{ rule: 0, path: regionPath }] })
    return { mask: this.addEffect({ kind: "mask", luminance, region: regionClip, ops: kids.map(plainOp) }) }
  }

  /** Whether mask [c] holds only plain white, fully opaque shapes (no stroke, no opacity, no effects). */
  private whiteMask(c: SvgNode): boolean {
    const ok = (k: SvgNode, inh: Inherited): boolean => {
      if (DROPPED.has(k.tag) || k.tag.includes(":")) return true
      if (this.prop(k, "display")?.value === "none") return true
      const kInh = this.inherit(k, inh)
      if (this.prop(k, "clip-path") || this.prop(k, "mask")) return false
      if (k.tag === "g") return this.opacity(k) === 1 && k.children.every((kk) => ok(kk, kInh))
      if (k.tag === "use") {
        const href = k.attrs.get("href") ?? k.attrs.get("xlink:href")
        const t = href ? this.ids.get(href.value.replace(/^#/, "")) : undefined
        return !!t && SHAPES.has(t.tag) && this.opacity(k) === 1 && ok(t, kInh)
      }
      if (!SHAPES.has(k.tag)) return false
      const fill = parseSvgColor(kInh.fill)
      return (
        fill !== null && (fill & 0xffffff) === 0xffffff && fill >>> 24 === 0xff && kInh.stroke === "none" &&
        this.alpha(kInh["fill-opacity"], k.at, "fill-opacity") === 1 && this.opacity(k) === 1
      )
    }
    const inh = this.inherit(c, { ...INITIAL })
    return c.children.every((k) => ok(k, inh))
  }

  /** The box of what [n] draws (its geometry and its children's), in its user space times [m]; null if nothing. */
  private contentBox(n: SvgNode, m: Matrix): Bounds | null {
    let acc: Bounds | null = null
    const add = (b: Bounds | null) => {
      if (!b) return
      acc = !acc ? b : [Math.min(acc[0], b[0]), Math.min(acc[1], b[1]), Math.max(acc[2], b[2]), Math.max(acc[3], b[3])]
    }
    for (const k of n.children) {
      if (DROPPED.has(k.tag) || k.tag.includes(":") || this.prop(k, "display")?.value === "none") continue
      const km = this.ctmOf(k, m)
      if (SHAPES.has(k.tag)) {
        const g = this.geometry(k)
        if (g.length > 0) add(pathBBox(transformPath(g, km)))
      } else if (k.tag === "g" || k.tag === "a") {
        add(this.contentBox(k, km))
      } else if (k.tag === "use") {
        const href = k.attrs.get("href") ?? k.attrs.get("xlink:href")
        const t = href ? this.ids.get(href.value.trim().replace(/^#/, "")) : undefined
        if (!t || this.useStack.includes(t)) continue
        const um = multiply(km, [1, 0, 0, 1, this.num(k, "x", 0), this.num(k, "y", 0)])
        this.useStack.push(t)
        add(SHAPES.has(t.tag) ? (this.geometry(t).length > 0 ? pathBBox(transformPath(this.geometry(t), this.ctmOf(t, um))) : null) : this.contentBox(t, this.ctmOf(t, um)))
        this.useStack.pop()
      }
    }
    return acc
  }

  /** [n]'s object bounding box in its own user space (its children's geometry for a group or a use). */
  private userBox(n: SvgNode): Bounds | null {
    if (SHAPES.has(n.tag)) {
      const g = this.geometry(n)
      return g.length > 0 ? pathBBox(g) : null
    }
    if (n.tag === "use") {
      const href = n.attrs.get("href") ?? n.attrs.get("xlink:href")
      const t = href ? this.ids.get(href.value.trim().replace(/^#/, "")) : undefined
      if (!t) return null
      const um: Matrix = [1, 0, 0, 1, this.num(n, "x", 0), this.num(n, "y", 0)]
      if (SHAPES.has(t.tag)) {
        const g = this.geometry(t)
        return g.length > 0 ? pathBBox(transformPath(g, this.ctmOf(t, um))) : null
      }
      return this.contentBox(t, this.ctmOf(t, um))
    }
    return this.contentBox(n, IDENTITY)
  }

  private addClip(def: ClipDef): number {
    const key = JSON.stringify(def)
    let index = this.clipKeys.get(key)
    if (index === undefined) {
      index = this.clips.push(def) - 1
      this.clipKeys.set(key, index)
    }
    return index
  }

  /** Adds a pattern or mask (shared when equal); returns its number among its kind. */
  private addEffect(def: EffectDef): number {
    const key = JSON.stringify(def)
    const hit = this.effectKeys.get(key)
    if (hit !== undefined) return hit
    this.effects.push(def)
    const index = def.kind === "pattern" ? this.patternCount++ : this.maskCount++
    this.effectKeys.set(key, index)
    return index
  }

  private clip(c: SvgNode, ctm: Matrix, bbox: Bounds | null, at: string, user: SvgNode): number {
    const isMask = c.tag === "mask"
    const unitsName = isMask ? "maskContentUnits" : "clipPathUnits"
    const units = c.attrs.get(unitsName)?.value ?? "userSpaceOnUse"
    let m = ctm
    if (units === "objectBoundingBox") {
      if (!bbox) this.fail(at, `${unitsName}="objectBoundingBox" is only supported on shapes, not on <${user.tag}>`)
      m = multiply(m, [bbox![2] - bbox![0], 0, 0, bbox![3] - bbox![1], bbox![0], bbox![1]])
    } else if (units !== "userSpaceOnUse") {
      this.fail(c.attrs.get(unitsName)!.at, `${unitsName} "${units}" isn't valid`)
    }
    m = this.ctmOf(c, m)
    if (c.attrs.has("clip-path") || this.styleOf(c).has("clip-path")) this.fail(c.at, "a clip path with its own clip-path isn't supported")
    const paths: ClipDef["paths"] = []
    const add = (k: SvgNode, km: Matrix, inh: Inherited) => {
      if (DROPPED.has(k.tag) || k.tag.includes(":")) return
      if (this.prop(k, "display")?.value === "none") return
      const kInh = this.inherit(k, inh)
      const kmm = this.ctmOf(k, km)
      if (k.tag === "use") {
        const href = k.attrs.get("href") ?? k.attrs.get("xlink:href")
        if (!href) this.fail(k.at, "<use> needs href")
        const t = this.ref(href!.value, href!.at, "#id")
        add({ ...t, attrs: new Map([...t.attrs].filter(([key]) => key !== "id")) }, multiply(kmm, [1, 0, 0, 1, this.num(k, "x", 0), this.num(k, "y", 0)]), kInh)
        return
      }
      if (k.tag === "g" && isMask) {
        for (const kk of k.children) add(kk, kmm, kInh)
        return
      }
      if (!SHAPES.has(k.tag)) this.fail(k.at, `<${k.tag}> can't be inside a <${c.tag}> (only shapes${isMask ? ", groups" : ""} and <use>)`)
      if (k.attrs.has("clip-path")) this.fail(k.at, "clip-path inside a clip path isn't supported")
      const geo = this.geometry(k)
      if (geo.length === 0) return
      const ruleName = isMask ? kInh["fill-rule"] : kInh["clip-rule"]
      const rule = this.choice(ruleName, k.at, isMask ? "fill-rule" : "clip-rule", ["nonzero", "evenodd"]) as 0 | 1
      paths.push({ rule, path: transformPath(geo, kmm) })
    }
    const baseInh = this.inherit(c, { ...INITIAL })
    for (const k of c.children) add(k, m, baseInh)
    // An empty clip hides everything: one empty path does that.
    return this.addClip({ paths: paths.length > 0 ? paths : [{ rule: 0, path: [] }] })
  }

  // ---- Simplify --------------------------------------------------------------------------------------------------

  /** docs/svg.md §6 step 4. Elements with an id are never merged away, so their op index is stable. */
  private simplify(ops: IOp[]): IOp[] {
    const out: IOp[] = []
    for (const o of ops) {
      if (o.op === "text") {
        out.push(o)
        continue
      }
      if (o.op === "shape") {
        if (o.fill.kind === "none" && o.stroke.kind === "none" && o.id === undefined) continue
        // A shape with only a fill or only a stroke needs no layer: its opacity goes into that paint's alpha.
        if (o.opacity < 1 && (o.fill.kind === "none" || o.stroke.kind === "none")) {
          if (o.fill.kind !== "none") o.fillAlpha *= o.opacity
          if (o.stroke.kind !== "none") o.strokeAlpha *= o.opacity
          o.opacity = 1
        }
        out.push(o)
        continue
      }
      const kids = this.simplify(o.children)
      if (o.id === undefined && kids.length === 0) continue
      if (o.id === undefined && !hasEffects(o)) {
        if (o.clip < 0 && o.opacity === 1) {
          out.push(...kids)
          continue
        }
        if (o.clip < 0 && kids.length === 1 && kids[0]!.op !== "text") {
          const only = kids[0]!
          only.opacity *= o.opacity
          out.push(...this.simplify([only]))
          continue
        }
      }
      out.push({ ...o, children: kids })
    }
    return out
  }

  // ---- Values ----------------------------------------------------------------------------------------------------

  private ref(value: string, at: string, what: string): SvgNode {
    const m = /^#(.+)$/.exec(value.trim())
    if (!m) this.fail(at, `only local references (${what}) are supported, got "${value}"`)
    const t = this.ids.get(m![1]!)
    if (!t) this.fail(at, `no element with id "${m![1]}"`)
    return t!
  }

  private aspect(root: SvgNode): number {
    const a = root.attrs.get("preserveAspectRatio")
    if (!a) return 4
    const parts = a.value.trim().replace(/^defer\s+/, "").split(/\s+/)
    if (parts[0] === "none") return 18
    const m = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/.exec(parts[0] ?? "")
    if (!m || (parts[1] !== undefined && parts[1] !== "meet" && parts[1] !== "slice")) {
      this.fail(a.at, `preserveAspectRatio "${a.value}" isn't valid (e.g. "xMidYMid meet", "xMinYMin slice", "none")`)
    }
    const idx = (s: string) => ["Min", "Mid", "Max"].indexOf(s)
    return idx(m![1]!) + 3 * idx(m![2]!) + (parts[1] === "slice" ? 9 : 0)
  }

  private opacity(n: SvgNode): number {
    const p = this.prop(n, "opacity")
    return p ? this.alpha(p.value, p.at, "opacity") : 1
  }

  /** 0–1, or N%; clamped. */
  private alpha(v: string, at: string, what: string): number {
    const s = v.trim()
    const n = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s)
    if (s === "" || !Number.isFinite(n)) this.fail(at, `${what} must be a number 0–1 or N%, got "${v}"`)
    return Math.min(1, Math.max(0, n))
  }

  /** A number or N% as a fraction (gradient offsets, object-relative coordinates). */
  private fraction(v: string, at: string, what: string): number {
    const s = v.trim()
    const n = s.endsWith("%") ? Number(s.slice(0, -1)) / 100 : Number(s)
    if (s === "" || !Number.isFinite(n)) this.fail(at, `${what} must be a number or N%, got "${v}"`)
    return n
  }

  private plainNumber(v: string, at: string, what: string): number {
    const n = Number(v.trim())
    if (v.trim() === "" || !Number.isFinite(n)) this.fail(at, `${what} must be a number, got "${v}"`)
    return n
  }

  /** A length: a number, Npx, or N% of the viewBox (width, height, or its diagonal / √2). */
  private length(v: string, at: string, what: string, axis: Axis): number {
    const s = v.trim()
    const pct = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)%$/.exec(s)
    if (pct) {
      const f = Number(pct[1]) / 100
      const [, , w, h] = this.vb
      return f * (axis === "w" ? w : axis === "h" ? h : Math.hypot(w, h) / Math.SQRT2)
    }
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(px)?$/.exec(s)
    if (!m) this.fail(at, `${what}: use a plain number (or px / %), got "${v}"`)
    return Number(m![1])
  }

  private coord(n: SvgNode, name: string, axis: Axis): number {
    const a = n.attrs.get(name)
    return a ? this.length(a.value, a.at, name, axis) : 0
  }

  private num(n: SvgNode, name: string, def: number): number {
    const a = n.attrs.get(name)
    return a ? this.length(a.value, a.at, name, "w") : def
  }

  private optLength(n: SvgNode, name: string): number | null {
    const a = n.attrs.get(name)
    if (!a || a.value.trim().endsWith("%") || a.value.trim() === "auto") return null
    const v = this.length(a.value, a.at, name, "w")
    if (!(v > 0)) this.fail(a.at, `${name} must be positive`)
    return v
  }

  private choice(v: string, at: string, what: string, options: string[]): number {
    const i = options.indexOf(v.trim())
    if (i < 0) this.fail(at, `${what} must be one of ${options.join(", ")}, got "${v}"`)
    return i
  }

  private dashes(v: string, at: string): number[] {
    if (v.trim() === "none" || v.trim() === "") return []
    let list: number[] = []
    try {
      list = v.split(/[\s,]+/).filter((x) => x !== "").map((x) => this.length(x, at, "stroke-dasharray", "diag"))
    } catch (e) {
      this.fail(at, (e as Error).message)
    }
    if (list.some((d) => d < 0)) this.fail(at, "stroke-dasharray can't have negative lengths")
    if (list.every((d) => d === 0)) return []
    return list.length % 2 === 1 ? [...list, ...list] : list
  }
}

type Bounds = [number, number, number, number]
type Axis = "w" | "h" | "diag"

/** An op without element ids (copies, like markers, must not make parts). */
function stripIds(o: IOp): IOp {
  if (o.op === "group") return { ...o, id: undefined, children: o.children.map(stripIds) }
  return { ...o, id: undefined }
}

/**
 * A path's marker vertices (SVG 2, "vertex"): every segment's end, plus the first point. [angle]: the marker's
 * direction there in degrees: the bisector of the directions in and out (only one of them at an open path's ends;
 * at a closed subpath's start, the closing segment comes in).
 */
export function markerVertices(path: PathCmd[]): Array<{ x: number; y: number; angle: number }> {
  // Segments with their start and end directions (arcs as cubics).
  type Seg = { x0: number; y0: number; x: number; y: number; din: number | null; dout: number | null; move: boolean; close: boolean }
  const segs: Seg[] = []
  const dir = (ax: number, ay: number, bx: number, by: number) => (ax === bx && ay === by ? null : Math.atan2(by - ay, bx - ax))
  const firstDir = (pts: number[][]) => {
    for (let i = 1; i < pts.length; i++) {
      const d = dir(pts[0]![0]!, pts[0]![1]!, pts[i]![0]!, pts[i]![1]!)
      if (d !== null) return d
    }
    return null
  }
  forEachSegment(path, (c, x0, y0) => {
    switch (c[0]) {
      case "M":
        segs.push({ x0, y0, x: c[1], y: c[2], din: null, dout: null, move: true, close: false })
        break
      case "L": {
        const d = dir(x0, y0, c[1], c[2])
        segs.push({ x0, y0, x: c[1], y: c[2], din: d, dout: d, move: false, close: false })
        break
      }
      case "C": {
        const pts = [[x0, y0], [c[1], c[2]], [c[3], c[4]], [c[5], c[6]]]
        segs.push({ x0, y0, x: c[5], y: c[6], dout: firstDir(pts), din: firstDir([...pts].reverse()) === null ? null : firstDir([...pts].reverse())! + Math.PI, move: false, close: false })
        break
      }
      case "Q": {
        const pts = [[x0, y0], [c[1], c[2]], [c[3], c[4]]]
        segs.push({ x0, y0, x: c[3], y: c[4], dout: firstDir(pts), din: firstDir([...pts].reverse()) === null ? null : firstDir([...pts].reverse())! + Math.PI, move: false, close: false })
        break
      }
      case "A": {
        const cubics = arcToCubics(x0, y0, c[1], c[2], c[3], c[4], c[5], c[6], c[7])
        if (cubics.length === 0) {
          segs.push({ x0, y0, x: c[6], y: c[7], din: null, dout: null, move: false, close: false })
          break
        }
        let px = x0
        let py = y0
        let dout: number | null = null
        let din: number | null = null
        for (const k of cubics) {
          const pts = k[0] === "C" ? [[px, py], [k[1], k[2]], [k[3], k[4]], [k[5], k[6]]] : [[px, py], [k[1] as number, k[2] as number]]
          const o = firstDir(pts)
          if (dout === null) dout = o
          const back = firstDir([...pts].reverse())
          if (back !== null) din = back + Math.PI
          px = pts[pts.length - 1]![0]!
          py = pts[pts.length - 1]![1]!
        }
        segs.push({ x0, y0, x: c[6], y: c[7], din, dout, move: false, close: false })
        break
      }
      case "Z": {
        // Back to the subpath's start: find it.
        let s = segs.length - 1
        while (s >= 0 && !segs[s]!.move) s--
        const sx = s >= 0 ? segs[s]!.x : 0
        const sy = s >= 0 ? segs[s]!.y : 0
        const d = dir(x0, y0, sx, sy)
        segs.push({ x0, y0, x: sx, y: sy, din: d, dout: d, move: false, close: true })
        break
      }
    }
  })
  const deg = (r: number) => (r * 180) / Math.PI
  const bisect = (a: number | null, b: number | null): number => {
    if (a === null && b === null) return 0
    if (a === null) return b!
    if (b === null) return a
    let d = b - a
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    return a + d / 2
  }
  const out: Array<{ x: number; y: number; angle: number }> = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!
    const next = segs[i + 1]
    // Direction in: this segment's end (none for a move); out: the next segment's start (none if it moves).
    let din = s.move ? null : s.din
    let dout = next && !next.move ? next.dout : null
    if (s.move && next && !next.move) {
      // A subpath's start: if it is closed, the closing segment comes in.
      let j = i + 1
      while (j < segs.length && !segs[j]!.move && !segs[j]!.close) j++
      if (j < segs.length && segs[j]!.close) din = segs[j]!.din
    }
    if (s.close) {
      // At the end of a closing segment: out is the subpath's first segment.
      let j = i - 1
      while (j >= 0 && !segs[j]!.move) j--
      const first = segs[j + 1]
      dout = first && !first.move && first !== s ? first.dout : dout
    }
    out.push({ x: s.x, y: s.y, angle: deg(bisect(din, dout)) })
  }
  return out
}

// ---- Filter helpers (registry 13) ----------------------------------------------------------------------------------

/** filterOf's answer for "the element isn't drawn". */
const HIDE = -2

/** mix-blend-mode / feBlend names, in the order of the draw data's blend codes 1–15 (svg-data.ts "blend"). */
const BLEND_NAMES = [
  "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light",
  "difference", "exclusion", "hue", "saturation", "color", "luminosity",
]

/** A colour matrix that keeps only the alpha (black, with the input's alpha). */
const ALPHA_ONLY = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]

function saturateMatrix(s: number): number[] {
  return [
    0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0, 0,
    0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s, 0, 0,
    0, 0, 0, 1, 0,
  ]
}

function hueRotateMatrix(deg: number): number[] {
  const r = (deg * Math.PI) / 180
  const cs = Math.cos(r)
  const sn = Math.sin(r)
  return [
    0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928, 0, 0,
    0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.14, 0.072 - cs * 0.072 - sn * 0.283, 0, 0,
    0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072, 0, 0,
    0, 0, 0, 1, 0,
  ]
}

/** feColorMatrix's type and values as a 4 × 5 matrix (SVG's order, offsets 0–1). */
function colorMatrix(type: string, values: string | undefined, at: string, fail: (at: string, msg: string) => never): number[] {
  const nums = values === undefined ? null : numberList(values, "values")
  switch (type) {
    case "matrix":
      if (nums === null) return IDENTITY_MATRIX
      if (nums.length !== 20) fail(at, `feColorMatrix type="matrix" needs 20 values, got ${nums.length}`)
      return nums
    case "saturate":
      return saturateMatrix(nums?.[0] ?? 1)
    case "hueRotate":
      return hueRotateMatrix(nums?.[0] ?? 0)
    case "luminanceToAlpha":
      return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.2125, 0.7154, 0.0721, 0, 0]
    default:
      return fail(at, `feColorMatrix type "${type}" isn't valid`)
  }
}

/** A CSS filter function other than blur() / drop-shadow() as a colour matrix (Filter Effects 1, §13). */
function cssColorMatrix(fn: string, amount: number, arg: string, fail: (msg: string) => never): number[] {
  const a = Math.max(0, amount)
  const lin = (slope: number, intercept: number, alphaSlope = 1) => [
    slope, 0, 0, 0, intercept, 0, slope, 0, 0, intercept, 0, 0, slope, 0, intercept, 0, 0, 0, alphaSlope, 0,
  ]
  switch (fn) {
    case "grayscale":
      return saturateMatrix(1 - Math.min(1, a))
    case "saturate":
      return saturateMatrix(a)
    case "sepia": {
      const t = 1 - Math.min(1, a)
      return [
        0.393 + 0.607 * t, 0.769 - 0.769 * t, 0.189 - 0.189 * t, 0, 0,
        0.349 - 0.349 * t, 0.686 + 0.314 * t, 0.168 - 0.168 * t, 0, 0,
        0.272 - 0.272 * t, 0.534 - 0.534 * t, 0.131 + 0.869 * t, 0, 0,
        0, 0, 0, 1, 0,
      ]
    }
    case "invert": {
      const t = Math.min(1, a)
      return lin(1 - 2 * t, t)
    }
    case "opacity":
      return lin(1, 0, Math.min(1, a))
    case "brightness":
      return lin(a, 0)
    case "contrast":
      return lin(a, 0.5 - 0.5 * a)
    case "hue-rotate": {
      const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(deg|turn|rad|grad)?$/.exec(arg.trim() || "0")
      if (!m) fail(`hue-rotate() needs an angle, got "${arg}"`)
      const v = Number(m![1])
      const unit = m![2] ?? "deg"
      return hueRotateMatrix(unit === "turn" ? v * 360 : unit === "rad" ? (v * 180) / Math.PI : unit === "grad" ? v * 0.9 : v)
    }
    default:
      return fail(`filter function ${fn}() isn't supported (blur, drop-shadow, brightness, contrast, grayscale, hue-rotate, invert, opacity, saturate, sepia)`)
  }
}

/**
 * The plain drop shadows in a filter, for phones that can't run it (svg-data.ts "shadow"): the filter must end by
 * drawing the source over shadows, each one the blurred, moved, coloured alpha of the source. Anything else: none
 * (such a phone draws the element without its filter).
 */
function filterShadows(prims: FilterPrim[]): FilterDef["shadows"] {
  type Shadow = FilterDef["shadows"][number]
  const clear = (i: number) => {
    const p = prims[i]
    return p?.p === "f" && p.argb >>> 24 === 0
  }
  // One shadow: walk back from result [i] to the source's alpha.
  const trace = (i: number, dx = 0, dy = 0, std = 0, argb: number | null = null, colored = false): Shadow | null => {
    if (i === -2 || (i === -1 && colored)) return { dx, dy, std, argb: argb ?? 0xff000000 }
    if (i < 0) return null
    const p = prims[i]!
    switch (p.p) {
      case "o":
        return trace(p.in, dx + p.dx, dy + p.dy, std, argb, colored)
      case "b":
        return trace(p.in, dx, dy, Math.hypot(std, Math.max(p.sx, p.sy)), argb, colored)
      case "m": {
        // A colouring matrix: each colour a constant, the alpha a multiple of the input's alpha.
        const v = p.values
        const zero = [0, 1, 2, 3, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 19]
        if (!zero.every((j) => Math.abs(v[j]!) < 1e-9)) return null
        const ch = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255)
        const color = ((ch(v[18]!) << 24) | (ch(v[4]!) << 16) | (ch(v[9]!) << 8) | ch(v[14]!)) >>> 0
        return trace(p.in, dx, dy, std, argb ?? color, true)
      }
      case "c":
        if (p.op === 1 && prims[p.in]?.p === "f") return trace(p.in2, dx, dy, std, argb ?? (prims[p.in] as { argb: number }).argb, true)
        if (p.op === 2) return trace(p.in, dx, dy, std, argb, colored) // the shadow cut away under the shape
        return null
      case "B":
        if (p.blend !== 0) return null
        if (clear(p.in2)) return trace(p.in, dx, dy, std, argb, colored)
        if (clear(p.in)) return trace(p.in2, dx, dy, std, argb, colored)
        return null
      default:
        return null
    }
  }
  // A stack of shadows (bottom first), or null.
  const stack = (i: number): Shadow[] | null => {
    if (clear(i)) return []
    const one = trace(i)
    if (one) return [one]
    const p = prims[i]
    if (!p) return null
    const layers = p.p === "M" ? p.ins : (p.p === "B" && p.blend === 0) || (p.p === "c" && p.op === 0) ? [p.in2, p.in] : null
    if (!layers) return null
    const out: Shadow[] = []
    for (const l of layers) {
      const s = stack(l)
      if (!s) return null
      out.push(...s)
    }
    return out
  }
  const last = prims[prims.length - 1]
  if (!last) return []
  const layers = last.p === "M" ? last.ins : (last.p === "B" && last.blend === 0) || (last.p === "c" && last.op === 0) ? [last.in2, last.in] : null
  if (!layers || layers[layers.length - 1] !== -1) return []
  const out: Shadow[] = []
  for (const l of layers.slice(0, -1)) {
    const s = stack(l)
    if (!s) return []
    out.push(...s)
  }
  return out.filter((s) => s.argb >>> 24 !== 0)
}

/** viewBox [vb] into a w × h box with aspect code [aspect] (svg-data.ts "aspect"), as a matrix. */
export function viewBoxMatrix(vb: Bounds, aspect: number, w: number, h: number): Matrix {
  const [vx, vy, vw, vh] = vb
  if (aspect === 18) return [w / vw, 0, 0, h / vh, -vx * (w / vw), -vy * (h / vh)]
  const s = aspect >= 9 ? Math.max(w / vw, h / vh) : Math.min(w / vw, h / vh)
  const align = aspect % 9
  const tx = ((w - vw * s) * (align % 3)) / 2 - vx * s
  const ty = ((h - vh * s) * Math.floor(align / 3)) / 2 - vy * s
  return [s, 0, 0, s, tx, ty]
}

// ---- Colours ---------------------------------------------------------------------------------------------------------

/** CSS / SVG colour → ARGB, or null. Hex (3, 4, 6, 8 digits), rgb() / rgba() (numbers or %), names, transparent. */
export function parseSvgColor(input: string): number | null {
  const s = input.trim().toLowerCase()
  if (s === "transparent") return 0
  if (s in NAMED) return (0xff000000 | NAMED[s]!) >>> 0
  let m = /^#([0-9a-f]{3,8})$/.exec(s)
  if (m) {
    const h = m[1]!
    const x = (i: number, n: number) => parseInt(h.slice(i, i + n), 16)
    if (h.length === 3 || h.length === 4) {
      const d = (i: number) => x(i, 1) * 17
      const a = h.length === 4 ? d(3) : 255
      return ((a << 24) | (d(0) << 16) | (d(1) << 8) | d(2)) >>> 0
    }
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? x(6, 2) : 255
      return ((a << 24) | (x(0, 2) << 16) | (x(2, 2) << 8) | x(4, 2)) >>> 0
    }
    return null
  }
  m = /^rgba?\((.*)\)$/.exec(s)
  if (m) {
    const parts = m[1]!.includes(",") ? m[1]!.split(",").map((p) => p.trim()) : m[1]!.replace("/", " / ").split(/\s+/).filter((p) => p !== "" && p !== "/")
    if (parts.length !== 3 && parts.length !== 4) return null
    const channel = (p: string) => {
      const v = p.endsWith("%") ? (Number(p.slice(0, -1)) * 255) / 100 : Number(p)
      return Number.isFinite(v) ? Math.round(Math.min(255, Math.max(0, v))) : NaN
    }
    const [r, g, b] = parts.slice(0, 3).map(channel) as [number, number, number]
    const ap = parts[3]
    const a = ap === undefined ? 255 : Math.round(Math.min(1, Math.max(0, ap.endsWith("%") ? Number(ap.slice(0, -1)) / 100 : Number(ap))) * 255)
    if ([r, g, b, a].some((v) => !Number.isFinite(v))) return null
    return ((a << 24) | (r << 16) | (g << 8) | b) >>> 0
  }
  return null
}

/** The SVG / CSS colour names (RGB). */
const NAMED: Record<string, number> = {
  aliceblue: 0xf0f8ff, antiquewhite: 0xfaebd7, aqua: 0x00ffff, aquamarine: 0x7fffd4, azure: 0xf0ffff, beige: 0xf5f5dc,
  bisque: 0xffe4c4, black: 0x000000, blanchedalmond: 0xffebcd, blue: 0x0000ff, blueviolet: 0x8a2be2, brown: 0xa52a2a,
  burlywood: 0xdeb887, cadetblue: 0x5f9ea0, chartreuse: 0x7fff00, chocolate: 0xd2691e, coral: 0xff7f50,
  cornflowerblue: 0x6495ed, cornsilk: 0xfff8dc, crimson: 0xdc143c, cyan: 0x00ffff, darkblue: 0x00008b,
  darkcyan: 0x008b8b, darkgoldenrod: 0xb8860b, darkgray: 0xa9a9a9, darkgreen: 0x006400, darkgrey: 0xa9a9a9,
  darkkhaki: 0xbdb76b, darkmagenta: 0x8b008b, darkolivegreen: 0x556b2f, darkorange: 0xff8c00, darkorchid: 0x9932cc,
  darkred: 0x8b0000, darksalmon: 0xe9967a, darkseagreen: 0x8fbc8f, darkslateblue: 0x483d8b, darkslategray: 0x2f4f4f,
  darkslategrey: 0x2f4f4f, darkturquoise: 0x00ced1, darkviolet: 0x9400d3, deeppink: 0xff1493, deepskyblue: 0x00bfff,
  dimgray: 0x696969, dimgrey: 0x696969, dodgerblue: 0x1e90ff, firebrick: 0xb22222, floralwhite: 0xfffaf0,
  forestgreen: 0x228b22, fuchsia: 0xff00ff, gainsboro: 0xdcdcdc, ghostwhite: 0xf8f8ff, gold: 0xffd700,
  goldenrod: 0xdaa520, gray: 0x808080, grey: 0x808080, green: 0x008000, greenyellow: 0xadff2f, honeydew: 0xf0fff0,
  hotpink: 0xff69b4, indianred: 0xcd5c5c, indigo: 0x4b0082, ivory: 0xfffff0, khaki: 0xf0e68c, lavender: 0xe6e6fa,
  lavenderblush: 0xfff0f5, lawngreen: 0x7cfc00, lemonchiffon: 0xfffacd, lightblue: 0xadd8e6, lightcoral: 0xf08080,
  lightcyan: 0xe0ffff, lightgoldenrodyellow: 0xfafad2, lightgray: 0xd3d3d3, lightgreen: 0x90ee90, lightgrey: 0xd3d3d3,
  lightpink: 0xffb6c1, lightsalmon: 0xffa07a, lightseagreen: 0x20b2aa, lightskyblue: 0x87cefa,
  lightslategray: 0x778899, lightslategrey: 0x778899, lightsteelblue: 0xb0c4de, lightyellow: 0xffffe0, lime: 0x00ff00,
  limegreen: 0x32cd32, linen: 0xfaf0e6, magenta: 0xff00ff, maroon: 0x800000, mediumaquamarine: 0x66cdaa,
  mediumblue: 0x0000cd, mediumorchid: 0xba55d3, mediumpurple: 0x9370db, mediumseagreen: 0x3cb371,
  mediumslateblue: 0x7b68ee, mediumspringgreen: 0x00fa9a, mediumturquoise: 0x48d1cc, mediumvioletred: 0xc71585,
  midnightblue: 0x191970, mintcream: 0xf5fffa, mistyrose: 0xffe4e1, moccasin: 0xffe4b5, navajowhite: 0xffdead,
  navy: 0x000080, oldlace: 0xfdf5e6, olive: 0x808000, olivedrab: 0x6b8e23, orange: 0xffa500, orangered: 0xff4500,
  orchid: 0xda70d6, palegoldenrod: 0xeee8aa, palegreen: 0x98fb98, paleturquoise: 0xafeeee, palevioletred: 0xdb7093,
  papayawhip: 0xffefd5, peachpuff: 0xffdab9, peru: 0xcd853f, pink: 0xffc0cb, plum: 0xdda0dd, powderblue: 0xb0e0e6,
  purple: 0x800080, rebeccapurple: 0x663399, red: 0xff0000, rosybrown: 0xbc8f8f, royalblue: 0x4169e1,
  saddlebrown: 0x8b4513, salmon: 0xfa8072, sandybrown: 0xf4a460, seagreen: 0x2e8b57, seashell: 0xfff5ee,
  sienna: 0xa0522d, silver: 0xc0c0c0, skyblue: 0x87ceeb, slateblue: 0x6a5acd, slategray: 0x708090,
  slategrey: 0x708090, snow: 0xfffafa, springgreen: 0x00ff7f, steelblue: 0x4682b4, tan: 0xd2b48c, teal: 0x008080,
  thistle: 0xd8bfd8, tomato: 0xff6347, turquoise: 0x40e0d0, violet: 0xee82ee, wheat: 0xf5deb3, white: 0xffffff,
  whitesmoke: 0xf5f5f5, yellow: 0xffff00, yellowgreen: 0x9acd32,
}
