// SVG draw data, format v1 (docs/svg.md §6.1): what the compiler writes for one SVG and the phone draws
// (android/runtime/.../ZnSvg.kt reads it). One ASCII string, tokens separated by one space, read in one pass.
//
//   data    = "Z1" vx vy vw vh aspect def* op*
//   def     = "LG" x1 y1 x2 y2 spread mat stops          linear gradient (numbered from 0 with the RGs, in order)
//           | "RG" cx cy r spread mat stops               radial gradient
//           | "RF" cx cy r fx fy fr spread mat stops      radial gradient with a focal circle (registry 13; numbered
//                                                         with the LGs and RGs)
//           | "SL" gradient stop part                     an animated stop (registry 13): stop number [stop] of
//                                                         gradient [gradient] takes the colour of SvgPart [part] (a
//                                                         part number after the ops'); written after the gradients,
//                                                         in gradient order
//           | "K" ("KP" rule path)+                      clip (numbered from 0, in order): the union of its paths
//           | "FL" x0 y0 x1 y1 n prim{n} m shadow{m}      filter (registry 13; numbered from 0): see "Filters" below
//           | "PT" x y w h mat op* "pt"                   pattern (registry 13; numbered from 0): one tile, x y w h in
//                                                         the pattern's space, mat: that space → the shape's space;
//                                                         the ops are in the pattern's space, cut to the tile
//           | "MK" type region op* "mk"                   mask (registry 13; numbered from 0): type 0 luminance,
//                                                         1 alpha; region: a clip number (in viewBox space) or -1;
//                                                         the ops are in viewBox space
//   op      = "G" opacity clip                            push a group: drawn in a layer when opacity < 1;
//                                                         clip = a clip number, or -1
//           | "X" opacity clip mask filter blend          push a group with effects (registry 13): mask and filter
//                                                         numbers or -1; blend: 0 normal, else mix-blend-mode (below)
//           | "g"                                         pop the group
//           | "S" fill fillAlpha stroke strokeAlpha rule opacity stroke? mat path    a shape
//           | "T" x y anchor mat n run{n}                 text (registry 13): one line from x y (in the matrix's
//                                                         space), anchor 0 start 1 middle 2 end for all its runs
//   run     = fill fillAlpha stroke strokeAlpha opacity stroke? size weight italic family spacing baseline dx dy text
//             size: font size; weight 100–900; italic 0 | 1; family 0 sans-serif 1 serif 2 monospace (the phone's
//             own fonts); spacing: letter spacing; baseline 0 alphabetic 1 central 2 hanging; dx dy: moves the pen
//             before the run (and for the runs after it); text: the characters, URI-encoded (no spaces)
//   stroke  = width cap join miter n dash{n} dashOffset   only when the shape's stroke paint is not "-"; a negative
//                                                         width: a non-scaling stroke, that many dp wide
//   mat     = "0" | "1" a b c d e f                       x' = a*x + c*y + e, y' = b*x + d*y + f (SVG's order)
//   stops   = n (offset color){n}                         offset 0–1, increasing
//   paint   = "-" (none) | "c" (currentColor) | color | "@" n (gradient n) | "%" n (pattern n, registry 13)
//   color   = "#" AARRGGBB (8 hex digits, upper case)
//   path    = SVG path data, then ";"                     one token, ends at the ";" (it may hold spaces)
//             Commands M m L l H h V v C c S s Q q T t A a Z z, minified as in SVG files ("M9.5 15.1l8.4-8.4z":
//             a "-" or a second "." starts a new number; a command letter may repeat implicitly). Read it with
//             Compose's PathParser (as Icon does). Arcs appear only where no transform changed their shape.
//   aspect  = 0–8: alignment (x + 3*y, x and y: 0 min, 1 mid, 2 max) with "meet"; 9–17: the same with "slice"
//             (the box is clipped); 18: "none" (stretch)
//   spread  = 0 pad | 1 reflect | 2 repeat; rule = 0 nonzero | 1 evenodd, plus 2 when the stroke is drawn before the
//             fill (paint-order, registry 13); cap = 0 butt | 1 round | 2 square;
//   join    = 0 miter | 1 round | 2 bevel
//   blend   = 1 multiply 2 screen 3 overlay 4 darken 5 lighten 6 color-dodge 7 color-burn 8 hard-light 9 soft-light
//             10 difference 11 exclusion 12 hue 13 saturation 14 color 15 luminosity
//
// Patterns and masks may hold groups, shapes and paints that use earlier patterns and masks: each one is written
// after the ones it uses. Their ops have no part indexes.
//
// Filters (registry 13): x0 y0 x1 y1 is the filter region in viewBox space. Each primitive's result is numbered from 0;
// `in` is an earlier result, -1 the group's own drawing (SourceGraphic) or -2 its alpha (SourceAlpha). The filter's
// output is the last primitive. Lengths are in viewBox units, colours #AARRGGBB, all in sRGB.
//   prim    = "b" in sx sy                                Gaussian blur (standard deviations)
//           | "o" in dx dy                                offset
//           | "f" color                                   flood (fills the region)
//           | "m" in v{20}                                colour matrix, 4 rows of 5 (SVG's order and units)
//           | "c" in in2 op                               composite: 0 over 1 in 2 out 3 atop 4 xor 5 plus
//                                                         6 in2 minus in (feComposite arithmetic k2=-1 k3=1)
//           | "B" in in2 blend                            blend (0 normal, else the blend list)
//           | "M" n in{n}                                 merge
//   shadow  = dx dy std color                             a plain drop shadow a phone draws under the group when it
//                                                         can't run the filter (Android below 12); m = 0: it draws the
//                                                         group without the filter
//
// Meaning:
// - Coordinates are in the viewBox's space. All transforms are already applied to the coordinates, except a matrix on
//   a shape: only a stroked shape under a non-uniform scale or a skew keeps one (its stroke must be transformed too).
//   Its gradient's matrix is then in the shape's own space. Clip paths are always in the viewBox's space.
// - A gradient's matrix maps its own coordinates to the viewBox's space (gradientTransform, object-relative units and
//   transforms already folded in). No matrix: the identity.
// - fillAlpha / strokeAlpha (0–1) multiply the paint (fill-opacity, stroke-opacity). opacity (0–1) is the whole
//   shape's: when it is below 1 and the shape has both a fill and a stroke, it is drawn in a layer, else it multiplies.
// - A shape draws its fill, then its stroke. Dash numbers are an even count of positive lengths (n = 0: solid).
// - Parts: every "G" and "S" op has an index, counted in order from 0. An <SvgPart part={i}> node overrides op i: its
//   fill / stroke replace every non-"-" fill / stroke paint inside it (an inner part wins over an outer one), and its
//   opacity multiplies the op's opacity.
// - currentColor is the Svg node's `color` (default black).
// - Numbers: decimal, optional "-", no exponent, at most 4 decimals.

export type Paint =
  | { kind: "none" }
  | { kind: "current" }
  | { kind: "color"; argb: number }
  | { kind: "gradient"; index: number }
  | { kind: "pattern"; index: number }

/** An affine matrix in SVG's order [a, b, c, d, e, f]. */
export type Matrix = [number, number, number, number, number, number]

/**
 * Absolute path commands inside the compiler (H / V / S / T are made explicit; the writer finds the short forms
 * again). "A": rx ry rotation large-arc sweep x y.
 */
export type PathCmd =
  | ["M", number, number]
  | ["L", number, number]
  | ["C", number, number, number, number, number, number]
  | ["Q", number, number, number, number]
  | ["A", number, number, number, number, number, number, number]
  | ["Z"]

export interface GradientDef {
  kind: "linear" | "radial"
  /** linear: x1 y1 x2 y2; radial: cx cy r, plus fx fy fr when the focal circle is not the centre ("RF"). */
  coords: number[]
  spread: 0 | 1 | 2
  matrix: Matrix | null
  stops: Array<{ offset: number; argb: number }>
}

export interface ClipDef {
  paths: Array<{ rule: 0 | 1; path: PathCmd[] }>
}

export interface StrokeSpec {
  width: number
  cap: 0 | 1 | 2
  join: 0 | 1 | 2
  miter: number
  dashes: number[]
  dashOffset: number
  /** vector-effect="non-scaling-stroke": [width] is in dp on screen (written as a negative width). */
  nonScaling?: boolean
}

/** One filter primitive (see "Filters" above). */
export type FilterPrim =
  | { p: "b"; in: number; sx: number; sy: number }
  | { p: "o"; in: number; dx: number; dy: number }
  | { p: "f"; argb: number }
  | { p: "m"; in: number; values: number[] }
  | { p: "c"; in: number; in2: number; op: number }
  | { p: "B"; in: number; in2: number; blend: number }
  | { p: "M"; ins: number[] }

export interface FilterDef {
  region: [number, number, number, number]
  prims: FilterPrim[]
  shadows: Array<{ dx: number; dy: number; std: number; argb: number }>
}

export interface PatternDef {
  /** The tile: x y w h in the pattern's space. */
  tile: [number, number, number, number]
  /** The pattern's space → the shape's space (the viewBox's, or the shape's own when it keeps a matrix). */
  matrix: Matrix | null
  ops: DrawOp[]
}

export interface MaskDef {
  luminance: boolean
  /** A clip number (the mask region, in viewBox space), or -1. */
  region: number
  ops: DrawOp[]
}

/** Patterns and masks, in the order they are written (each after the ones it uses). */
export type EffectDef = ({ kind: "pattern" } & PatternDef) | ({ kind: "mask" } & MaskDef)

/** One run of a text op: a piece of the line in one style. */
export interface TextRun {
  fill: Paint
  fillAlpha: number
  stroke: Paint
  strokeAlpha: number
  opacity: number
  strokeSpec: StrokeSpec | null
  size: number
  weight: number
  italic: boolean
  family: 0 | 1 | 2
  spacing: number
  baseline: 0 | 1 | 2
  dx: number
  dy: number
  text: string
}

export type DrawOp =
  | { op: "group"; opacity: number; clip: number; mask?: number; filter?: number; blend?: number; children: DrawOp[] }
  | { op: "text"; x: number; y: number; anchor: 0 | 1 | 2; matrix: Matrix | null; runs: TextRun[] }
  | {
      op: "shape"
      fill: Paint
      fillAlpha: number
      stroke: Paint
      strokeAlpha: number
      rule: 0 | 1
      /** paint-order: the stroke is drawn before the fill. */
      strokeFirst?: boolean
      opacity: number
      strokeSpec: StrokeSpec | null
      matrix: Matrix | null
      path: PathCmd[]
    }

export interface DrawData {
  viewBox: [number, number, number, number]
  aspect: number
  gradients: GradientDef[]
  clips: ClipDef[]
  filters?: FilterDef[]
  effects?: EffectDef[]
  /** Animated gradient stops (registry 13): [gradient, stop, part], sorted by gradient. */
  stopLinks?: Array<[number, number, number]>
  ops: DrawOp[]
}

/** [n] as the format writes it: rounded to [step] (a power of ten, at most 4 decimals), no "-0", no exponent. */
export function num(n: number, decimals = 4): string {
  if (!Number.isFinite(n)) throw new Error(`SVG number is not finite: ${n}`)
  const d = Math.max(0, Math.min(4, decimals))
  let s = n.toFixed(d)
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "")
  if (s === "-0" || s === "") s = "0"
  return s
}

/**
 * Minified SVG path data for [p]: each command relative or absolute, whichever is shorter; H / V / S / T where they
 * fit; repeated command letters left out. Relative steps are taken between *rounded* points, so rounding never adds
 * up along a long path. Arc flags keep a separator (some path readers don't accept "a1 1 0 01 5 5").
 */
export function writePath(p: PathCmd[], decimals: number): string {
  const r = (v: number) => Number(num(v, decimals))
  let out = ""
  let prevLetter = ""
  let lastChar = "" // the last character written, to know if a number needs a separator
  let lastHasDot = false
  // The point after the previous command, as the reader will compute it from what we write (rounded).
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  // The previous command's last control point (rounded), for S and T.
  let prevC: [number, number] | null = null
  let prevQ: [number, number] | null = null

  const fmt = (v: number) => {
    let s = num(v, decimals)
    if (s.startsWith("0.")) s = s.slice(1)
    else if (s.startsWith("-0.")) s = "-" + s.slice(2)
    return s
  }
  /**
   * The text for command [letter] with numbers [vs], written after what is already out: the letter is left out when
   * it repeats (not for M: repeated numbers after M mean lines); separators only where a reader needs one.
   */
  const piece = (letter: string, vs: number[]) => {
    const skip = letter === prevLetter && letter.toUpperCase() !== "M"
    let s = skip ? "" : letter
    let lc = skip ? lastChar : letter
    let dot = skip ? lastHasDot : false
    for (const v of vs) {
      const t = fmt(v)
      const needSep = /[0-9.]/.test(lc) && !(t.startsWith("-") || (t.startsWith(".") && dot))
      s += (needSep ? " " : "") + t
      lc = t[t.length - 1]!
      dot = t.includes(".")
    }
    return { s, lc, dot }
  }
  const emit = (letter: string, vs: number[]) => {
    const p = piece(letter, vs)
    out += p.s
    lastChar = p.lc
    lastHasDot = p.dot
    prevLetter = letter
  }
  /** Writes [abs] or [rel] (the same command), whichever is shorter. */
  const choose = (A: string, abs: number[], rel: number[]) => {
    const l = A.toLowerCase()
    if (piece(l, rel).s.length < piece(A, abs).s.length) emit(l, rel)
    else emit(A, abs)
  }
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

  for (const c of p) {
    switch (c[0]) {
      case "M": {
        const x = r(c[1])
        const y = r(c[2])
        // The first M of a path is always absolute (relative to 0,0 it is the same).
        // After z, always absolute: Android 9 and older (old Skia rMoveTo) take a relative m from the last point
        // drawn, not from the start of the closed shape as SVG says, so holes and parts moved (Infinix Hot 8).
        if (prevLetter === "z") emit("M", [x, y])
        else choose("M", [x, y], [x - cx, y - cy])
        cx = sx = x
        cy = sy = y
        prevC = prevQ = null
        // After M, the reader treats repeated numbers as lines; we always write the L letter again.
        break
      }
      case "L": {
        const x = r(c[1])
        const y = r(c[2])
        if (near(y, cy) && !near(x, cx)) choose("H", [x], [x - cx])
        else if (near(x, cx) && !near(y, cy)) choose("V", [y], [y - cy])
        else choose("L", [x, y], [x - cx, y - cy])
        cx = x
        cy = y
        prevC = prevQ = null
        break
      }
      case "C": {
        const [x1, y1, x2, y2, x, y] = [r(c[1]), r(c[2]), r(c[3]), r(c[4]), r(c[5]), r(c[6])]
        const reflect = prevC ? [2 * cx - prevC[0], 2 * cy - prevC[1]] : [cx, cy]
        if (near(r(reflect[0]!), x1) && near(r(reflect[1]!), y1)) {
          choose("S", [x2, y2, x, y], [x2 - cx, y2 - cy, x - cx, y - cy])
        } else {
          choose("C", [x1, y1, x2, y2, x, y], [x1 - cx, y1 - cy, x2 - cx, y2 - cy, x - cx, y - cy])
        }
        prevC = [x2, y2]
        prevQ = null
        cx = x
        cy = y
        break
      }
      case "Q": {
        const [x1, y1, x, y] = [r(c[1]), r(c[2]), r(c[3]), r(c[4])]
        const reflect = prevQ ? [2 * cx - prevQ[0], 2 * cy - prevQ[1]] : [cx, cy]
        if (prevQ && near(r(reflect[0]!), x1) && near(r(reflect[1]!), y1)) {
          choose("T", [x, y], [x - cx, y - cy])
        } else {
          choose("Q", [x1, y1, x, y], [x1 - cx, y1 - cy, x - cx, y - cy])
        }
        prevQ = [x1, y1]
        prevC = null
        cx = x
        cy = y
        break
      }
      case "A": {
        const [rx, ry, rot, large, sweep] = [r(c[1]), r(c[2]), Number(num(c[3], 3)), c[4], c[5]]
        const x = r(c[6])
        const y = r(c[7])
        // Flags written as separate numbers on purpose (see above).
        const abs = [rx, ry, rot, large, sweep, x, y]
        const rel = [rx, ry, rot, large, sweep, x - cx, y - cy]
        choose("A", abs, rel)
        cx = x
        cy = y
        prevC = prevQ = null
        break
      }
      case "Z":
        if (prevLetter !== "z") emit("z", [])
        cx = sx
        cy = sy
        prevC = prevQ = null
        break
    }
  }
  return out
}

const hex = (argb: number) => "#" + (argb >>> 0).toString(16).toUpperCase().padStart(8, "0")

function paint(p: Paint): string {
  switch (p.kind) {
    case "none":
      return "-"
    case "current":
      return "c"
    case "color":
      return hex(p.argb)
    case "gradient":
      return `@${p.index}`
    case "pattern":
      return `%${p.index}`
  }
}

/** Writes [d]. [decimals]: how many decimals coordinates keep (docs/svg.md §6 step 5); alphas keep 4. */
export function writeDrawData(d: DrawData, decimals: number): string {
  const out: string[] = []
  const n = (v: number) => out.push(num(v, decimals))
  const a = (v: number) => out.push(num(v, 4))
  const mat = (m: Matrix | null) => {
    if (!m) return void out.push("0")
    out.push("1")
    // a b c d keep 4 decimals (they scale); e f are coordinates.
    a(m[0]), a(m[1]), a(m[2]), a(m[3]), n(m[4]), n(m[5])
  }
  const path = (p: PathCmd[]) => out.push(writePath(p, decimals) + ";")
  out.push("Z1")
  d.viewBox.forEach(n)
  out.push(String(d.aspect))
  for (const g of d.gradients) {
    out.push(g.kind === "linear" ? "LG" : g.coords.length > 3 ? "RF" : "RG")
    g.coords.forEach(n)
    out.push(String(g.spread))
    mat(g.matrix)
    out.push(String(g.stops.length))
    for (const s of g.stops) {
      a(s.offset)
      out.push(hex(s.argb))
    }
  }
  for (const [g, s, p] of d.stopLinks ?? []) out.push("SL", String(g), String(s), String(p))
  for (const c of d.clips) {
    out.push("K")
    for (const p of c.paths) {
      out.push("KP", String(p.rule))
      path(p.path)
    }
  }
  for (const f of d.filters ?? []) {
    out.push("FL")
    f.region.forEach(n)
    out.push(String(f.prims.length))
    for (const p of f.prims) {
      out.push(p.p)
      switch (p.p) {
        case "b":
          out.push(String(p.in)), n(p.sx), n(p.sy)
          break
        case "o":
          out.push(String(p.in)), n(p.dx), n(p.dy)
          break
        case "f":
          out.push(hex(p.argb))
          break
        case "m":
          out.push(String(p.in))
          p.values.forEach(a)
          break
        case "c":
          out.push(String(p.in), String(p.in2), String(p.op))
          break
        case "B":
          out.push(String(p.in), String(p.in2), String(p.blend))
          break
        case "M":
          out.push(String(p.ins.length), ...p.ins.map(String))
          break
      }
    }
    out.push(String(f.shadows.length))
    for (const s of f.shadows) {
      n(s.dx), n(s.dy), n(s.std)
      out.push(hex(s.argb))
    }
  }
  const strokeOut = (s: StrokeSpec) => {
    n(s.nonScaling ? -s.width : s.width)
    out.push(String(s.cap), String(s.join))
    a(s.miter)
    out.push(String(s.dashes.length))
    s.dashes.forEach(n)
    n(s.dashOffset)
  }
  const op = (o: DrawOp) => {
    if (o.op === "text") {
      out.push("T")
      n(o.x), n(o.y)
      out.push(String(o.anchor))
      mat(o.matrix)
      out.push(String(o.runs.length))
      for (const r of o.runs) {
        out.push(paint(r.fill))
        a(r.fillAlpha)
        out.push(paint(r.stroke))
        a(r.strokeAlpha)
        a(r.opacity)
        if (r.stroke.kind !== "none") strokeOut(r.strokeSpec!)
        n(r.size)
        out.push(String(r.weight), r.italic ? "1" : "0", String(r.family))
        n(r.spacing)
        out.push(String(r.baseline))
        n(r.dx), n(r.dy)
        out.push(encodeURIComponent(r.text))
      }
      return
    }
    if (o.op === "group") {
      const fx = (o.mask ?? -1) >= 0 || (o.filter ?? -1) >= 0 || (o.blend ?? 0) !== 0
      out.push(fx ? "X" : "G")
      a(o.opacity)
      out.push(String(o.clip))
      if (fx) out.push(String(o.mask ?? -1), String(o.filter ?? -1), String(o.blend ?? 0))
      o.children.forEach(op)
      out.push("g")
      return
    }
    out.push("S", paint(o.fill))
    a(o.fillAlpha)
    out.push(paint(o.stroke))
    a(o.strokeAlpha)
    out.push(String(o.rule + (o.strokeFirst ? 2 : 0)))
    a(o.opacity)
    if (o.stroke.kind !== "none") strokeOut(o.strokeSpec!)
    mat(o.matrix)
    path(o.path)
  }
  for (const e of d.effects ?? []) {
    if (e.kind === "pattern") {
      out.push("PT")
      e.tile.forEach(n)
      mat(e.matrix)
      e.ops.forEach(op)
      out.push("pt")
    } else {
      out.push("MK", e.luminance ? "0" : "1", String(e.region))
      e.ops.forEach(op)
      out.push("mk")
    }
  }
  d.ops.forEach(op)
  return out.join(" ")
}
