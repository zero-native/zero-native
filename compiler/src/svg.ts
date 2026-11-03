// SVG → draw data, at build time (docs/svg.md §5, §6). Used for .svg files (via svg-xml.ts) and for inline <Svg> in
// TSX (compile.ts turns the JSX into the same SvgNode tree). Every element and attribute is checked against the
// supported subset: anything else fails the build with its file:line:col and a hint. Nothing is silently dropped
// except the attributes listed in IGNORED (hints that don't change the picture) and editor data.
import { readFileSync, statSync } from "node:fs"
import {
  type ClipDef,
  type DrawData,
  type DrawOp,
  type GradientDef,
  type Matrix,
  type Paint,
  type PathCmd,
  type StrokeSpec,
  writeDrawData,
} from "./svg-data"
import {
  ellipsePath,
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
import { parseSvgXml, type SvgNode } from "./svg-xml"

export interface CompiledSvg {
  /** The draw data (svg-data.ts). */
  data: string
  /** Element id → its op index: the parts a screen can change. */
  parts: Map<string, number>
  /** Whether the drawing uses currentColor (the Svg node's `color`). */
  usesCurrentColor: boolean
  /** The SVG's own size in dp: its width / height attributes, else the viewBox size. */
  width: number
  height: number
}

// ---- What is supported ---------------------------------------------------------------------------------------------

/** Presentation properties that children inherit (SVG 1.1), with their initial values. */
const INHERITED = [
  "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "clip-rule", "color", "visibility",
] as const
type InheritedName = (typeof INHERITED)[number]
const INITIAL: Record<InheritedName, string> = {
  fill: "black", "fill-opacity": "1", "fill-rule": "nonzero", stroke: "none", "stroke-width": "1",
  "stroke-linecap": "butt", "stroke-linejoin": "miter", "stroke-miterlimit": "4", "stroke-dasharray": "none",
  "stroke-dashoffset": "0", "stroke-opacity": "1", "clip-rule": "nonzero", color: "currentColor", visibility: "visible",
}
/** Properties that may also be written in style="...". */
const STYLE_PROPS = new Set<string>([...INHERITED, "opacity", "clip-path", "mask", "display", "stop-color", "stop-opacity"])
const COMMON = new Set<string>([...STYLE_PROPS, "id", "style", "transform", "class"])

/** Hints that don't change the picture (docs/svg.md §5 "Ignored on purpose"). Also any `data-*`, `aria-*`, `x:y`. */
const IGNORED = new Set([
  "version", "baseProfile", "shape-rendering", "text-rendering", "image-rendering", "color-interpolation",
  "color-interpolation-filters", "color-rendering", "isolation", "enable-background", "role", "focusable", "overflow",
  "xmlns", "font-family", "font-size", "font-weight", "font-style", "letter-spacing", "word-spacing",
  "mask-type", "data-name", "tabindex",
])
// unDraw illustrations carry `artist` and `source` (credits) on the root.
IGNORED.add("artist")
IGNORED.add("source")
const ignoredName = (n: string) => IGNORED.has(n) || n.startsWith("data-") || n.startsWith("aria-") || (n.includes(":") && n !== "xlink:href")

/** Element-specific attributes, on top of COMMON. */
const OWN: Record<string, string[]> = {
  svg: ["viewBox", "width", "height", "preserveAspectRatio", "x", "y"],
  g: [],
  path: ["d"],
  rect: ["x", "y", "width", "height", "rx", "ry"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  polyline: ["points"],
  polygon: ["points"],
  defs: [],
  linearGradient: ["x1", "y1", "x2", "y2", "gradientUnits", "gradientTransform", "spreadMethod", "href", "xlink:href"],
  radialGradient: ["cx", "cy", "r", "fx", "fy", "gradientUnits", "gradientTransform", "spreadMethod", "href", "xlink:href"],
  stop: ["offset"],
  clipPath: ["clipPathUnits"],
  mask: ["x", "y", "width", "height", "maskUnits", "maskContentUnits"],
  use: ["href", "xlink:href", "x", "y", "width", "height"],
  symbol: ["viewBox", "preserveAspectRatio"],
}
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"])
/** Dropped with everything inside them. */
const DROPPED = new Set(["title", "desc", "metadata"])

/** Refused elements, with the hint the build error gives. */
const REFUSED: Record<string, string> = {
  text: "SVG text isn't supported: convert the text to outlines in the design tool, or put a zn <Text> over the SVG in a <Stack> (real text is read by TalkBack and follows the font size)",
  image: "<image> isn't supported: put an <Image> and the SVG in a <Stack>",
  pattern: "<pattern> isn't supported: draw the repeats as shapes",
  filter: "filters (blur, drop shadow) aren't supported: use elevation / shadowColor on the element, or export the effect as a PNG",
  marker: "<marker> isn't supported: flatten the markers into shapes in the design tool",
  foreignObject: "<foreignObject> isn't supported",
  switch: "<switch> isn't supported: keep only the branch you need",
  animate: "SMIL animation isn't supported: animate parts with zn's animate (phase 2), or use a Lottie file",
  animateTransform: "SMIL animation isn't supported: animate parts with zn's animate (phase 2), or use a Lottie file",
  animateMotion: "SMIL animation isn't supported: animate parts with zn's animate (phase 2), or use a Lottie file",
  set: "SMIL animation isn't supported: animate parts with zn's animate (phase 2), or use a Lottie file",
  style: "<style> (CSS) isn't supported: inline the styles as attributes (svgo's inlineStyles, or the design tool's presentation-attributes export)",
}
const REFUSED_ATTRS: Record<string, string> = {
  "vector-effect": 'vector-effect isn\'t supported yet (the stroke would grow with the SVG): remove it and set the stroke width for the size you use',
  "paint-order": "paint-order isn't supported: flatten the stroke in the design tool",
  "mix-blend-mode": "mix-blend-mode isn't supported: flatten the effect in the design tool",
  filter: "filters aren't supported: export the effect as a PNG",
  marker: "markers aren't supported", "marker-start": "markers aren't supported", "marker-mid": "markers aren't supported",
  "marker-end": "markers aren't supported",
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
  return new SvgCompiler(root).run()
}

// ---- The compiler --------------------------------------------------------------------------------------------------

type Inherited = Record<InheritedName, string>

/** One op before simplifying: like DrawOp, plus the element id. */
type IOp =
  | { op: "group"; id?: string; opacity: number; clip: number; children: IOp[] }
  | (Extract<DrawOp, { op: "shape" }> & { id?: string })

class SvgCompiler {
  private ids = new Map<string, SvgNode>()
  private gradients: GradientDef[] = []
  private gradientKeys = new Map<string, number>()
  private clips: ClipDef[] = []
  private clipKeys = new Map<string, number>()
  private usesCurrent = false
  private vb: [number, number, number, number] = [0, 0, 0, 0]
  private useStack: SvgNode[] = []

  constructor(private root: SvgNode) {}

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

    // Number the ops (pre-order) and collect parts.
    const parts = new Map<string, number>()
    let index = 0
    const toDraw = (o: IOp): DrawOp => {
      const i = index++
      if (o.id !== undefined) parts.set(o.id, i)
      if (o.op === "group") return { op: "group", opacity: o.opacity, clip: o.clip, children: o.children.map(toDraw) }
      const { id: _id, ...shape } = o
      return shape
    }
    const drawOps = simplified.map(toDraw)

    const maxSide = Math.max(this.vb[2], this.vb[3])
    const decimals = Math.max(0, Math.min(4, Math.ceil(Math.log10(2_000 / maxSide) - 1e-9)))
    const data: DrawData = { viewBox: this.vb, aspect, gradients: this.gradients, clips: this.clips, ops: drawOps }
    return {
      data: writeDrawData(data, decimals),
      parts,
      usesCurrentColor: this.usesCurrent,
      width: w ?? this.vb[2],
      height: h ?? this.vb[3],
    }
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
    if (n.tag === "svg" && n !== this.root) this.fail(n.at, "a nested <svg> isn't supported: use a <g> with a transform")
    const own = OWN[n.tag]
    if (!own) this.fail(n.at, `<${n.tag}> isn't supported in zero-native SVGs (docs/svg.md §5)`)
    for (const [name, a] of n.attrs) {
      if (name in REFUSED_ATTRS) this.fail(a.at, REFUSED_ATTRS[name]!)
      if (COMMON.has(name) || own!.includes(name) || ignoredName(name)) continue
      this.fail(a.at, `attribute "${name}" isn't supported on <${n.tag}> (docs/svg.md §5)`)
    }
    const style = n.attrs.get("style")
    if (style) this.styleOf(n) // validates
    if (n.text.trim() !== "" && n.tag !== "stop") this.fail(n.at, `text inside <${n.tag}> isn't supported`)
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
    for (const k of INHERITED) {
      const p = this.prop(n, k)
      if (p && p.value !== "inherit") out[k] = p.value
    }
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
    if (DROPPED.has(n.tag) || n.tag.includes(":")) return null
    if (["defs", "linearGradient", "radialGradient", "clipPath", "mask", "symbol", "stop"].includes(n.tag)) {
      if (n.tag === "stop") this.fail(n.at, "<stop> belongs inside a gradient")
      return null
    }
    if (this.prop(n, "display")?.value === "none") return null
    const ctm = this.ctmOf(n, parentCtm)
    const inh = this.inherit(n, parentInh)

    if (n.tag === "g") return this.element(n, ctm, this.children(n, ctm, inh))
    if (n.tag === "use") return this.use(n, ctm, inh)
    if (SHAPES.has(n.tag)) return this.shape(n, ctm, inh)
    return this.fail(n.at, `<${n.tag}> can't be drawn here`)
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
  private element(n: SvgNode, ctm: Matrix, children: IOp[]): IOp {
    const id = n.attrs.get("id")?.value
    const opacity = this.opacity(n)
    const clips = this.clipsOf(n, ctm, null)
    let op: IOp = { op: "group", id, opacity, clip: clips.length > 0 ? clips[0]! : -1, children }
    // A clip and a mask on one element: two groups, the outer one with the second clip.
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
      strokeSpec = {
        width: strokeWidth * s,
        cap: cap as 0 | 1 | 2,
        join: join as 0 | 1 | 2,
        miter,
        dashes: this.dashes(inh["stroke-dasharray"], this.atOf(n, "stroke-dasharray")).map((d) => d * s),
        dashOffset: this.length(inh["stroke-dashoffset"], this.atOf(n, "stroke-dashoffset"), "stroke-dashoffset", "diag") * s,
      }
    }
    const shape: IOp = {
      op: "shape",
      id: n.attrs.get("id")?.value,
      fill,
      fillAlpha: this.alpha(inh["fill-opacity"], this.atOf(n, "fill-opacity"), "fill-opacity"),
      stroke: strokePaint,
      strokeAlpha: this.alpha(inh["stroke-opacity"], this.atOf(n, "stroke-opacity"), "stroke-opacity"),
      rule: this.choice(inh["fill-rule"], this.atOf(n, "fill-rule"), "fill-rule", ["nonzero", "evenodd"]) as 0 | 1,
      opacity: this.opacity(n),
      strokeSpec,
      matrix: keep,
      path,
    }
    const clips = this.clipsOf(n, ctm, bbox)
    let op: IOp = shape
    for (const c of clips) op = { op: "group", opacity: 1, clip: c, children: [op] }
    return op
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
      if (target!.tag !== "linearGradient" && target!.tag !== "radialGradient") {
        if (target!.tag === "pattern") this.fail(p.at, REFUSED.pattern!)
        this.fail(p.at, `"${url[1]}" is a <${target!.tag}>, not a gradient`)
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
    for (const s of stopsFrom?.children ?? []) {
      if (s.tag !== "stop") {
        if (DROPPED.has(s.tag) || s.tag.includes(":")) continue
        this.fail(s.at, `<${s.tag}> can't be inside a gradient`)
      }
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
      for (const [f, c] of [["fx", 0], ["fy", 1]] as const) {
        const a = attr(f)
        if (a && Math.abs(coordOf(f, "0", c === 0 ? "w" : "h") - coords[c]!) > 1e-9) {
          this.fail(a.at, `a focal point (${f}) different from the centre isn't supported: remove fx / fy`)
        }
      }
      if (coords[2]! <= 0) return { kind: "color", argb: stops[stops.length - 1]!.argb }
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
    return { kind: "gradient", index }
  }

  // ---- Clips and masks -------------------------------------------------------------------------------------------

  /** The clip numbers for [n]'s clip-path and mask (0, 1 or 2 of them). [bbox]: [n]'s geometry in its user space. */
  private clipsOf(n: SvgNode, ctm: Matrix, bbox: Bounds | null): number[] {
    const out: number[] = []
    for (const which of ["clip-path", "mask"] as const) {
      const p = this.prop(n, which)
      if (!p || p.value === "none") continue
      const m = /^url\(\s*['"]?#([^'")\s]+)['"]?\s*\)$/.exec(p.value)
      if (!m) this.fail(p.at, `${which} must be url(#id), got "${p.value}"`)
      const target = this.ids.get(m![1]!)
      if (!target) this.fail(p.at, `no element with id "${m![1]}"`)
      const want = which === "clip-path" ? "clipPath" : "mask"
      if (target!.tag !== want) this.fail(p.at, `"${m![1]}" is a <${target!.tag}>, not a <${want}>`)
      out.push(this.clip(target!, ctm, bbox, p.at, n))
    }
    return out
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
      if (isMask) this.whiteOnly(k, kInh, c)
      const geo = this.geometry(k)
      if (geo.length === 0) return
      const ruleName = isMask ? kInh["fill-rule"] : kInh["clip-rule"]
      const rule = this.choice(ruleName, k.at, isMask ? "fill-rule" : "clip-rule", ["nonzero", "evenodd"]) as 0 | 1
      paths.push({ rule, path: transformPath(geo, kmm) })
    }
    const baseInh = this.inherit(c, { ...INITIAL })
    for (const k of c.children) add(k, m, baseInh)
    // An empty clip hides everything: one empty path does that.
    const def: ClipDef = { paths: paths.length > 0 ? paths : [{ rule: 0, path: [] }] }
    const key = JSON.stringify(def)
    let index = this.clipKeys.get(key)
    if (index === undefined) {
      index = this.clips.push(def) - 1
      this.clipKeys.set(key, index)
    }
    return index
  }

  /** A mask is only supported when it is plain white, fully opaque shapes: then it is the same as a clip. */
  private whiteOnly(k: SvgNode, inh: Inherited, mask: SvgNode) {
    const hint = `only a mask of plain white shapes is supported (it works like a clip); flatten this mask in the design tool (mask at ${mask.at})`
    const fill = parseSvgColor(inh.fill)
    if (fill === null || (fill & 0xffffff) !== 0xffffff || fill >>> 24 !== 0xff) this.fail(k.at, hint)
    if (inh.stroke !== "none") this.fail(k.at, hint)
    if (this.alpha(inh["fill-opacity"], k.at, "fill-opacity") !== 1 || this.opacity(k) !== 1) this.fail(k.at, hint)
  }

  // ---- Simplify --------------------------------------------------------------------------------------------------

  /** docs/svg.md §6 step 4. Elements with an id are never merged away, so their op index is stable. */
  private simplify(ops: IOp[]): IOp[] {
    const out: IOp[] = []
    for (const o of ops) {
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
      if (o.id === undefined) {
        if (kids.length === 0) continue
        if (o.clip < 0 && o.opacity === 1) {
          out.push(...kids)
          continue
        }
        if (o.clip < 0 && kids.length === 1) {
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
