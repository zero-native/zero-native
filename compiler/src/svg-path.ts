// SVG geometry at build time (docs/svg.md §6): path data, basic shapes, transforms, exact bounding boxes. Everything
// becomes absolute M / L / C / Z commands, so the phone (and iOS later) never sees arcs, quadratics or relative moves.
import type { Matrix, PathCmd } from "./svg-data"

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

/** a × b: the transform that applies [b] first, then [a] (SVG: transform="a b"). */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

export function isIdentity(m: Matrix): boolean {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0
}

/**
 * The scale factor when [m] keeps shapes' proportions (a uniform scale, rotation, mirror, move), else null. Only then
 * can a stroke be drawn after the transform is applied to the coordinates: its width just scales by the factor.
 */
export function similarityScale(m: Matrix): number | null {
  const sx = Math.hypot(m[0], m[1])
  const sy = Math.hypot(m[2], m[3])
  const dot = m[0] * m[2] + m[1] * m[3]
  const tol = 1e-9 * Math.max(1, sx * sy)
  if (Math.abs(sx - sy) > 1e-9 * Math.max(1, sx) || Math.abs(dot) > tol) return null
  return sx
}

export function applyToPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/**
 * Applies [m] to every point. Exact: an affine map keeps lines, quadratic and cubic Béziers what they are. An arc
 * stays an arc when [m] only moves, scales it evenly or turns it (or scales an unturned ellipse on its axes);
 * otherwise it becomes cubic curves first.
 */
export function transformPath(path: PathCmd[], m: Matrix): PathCmd[] {
  if (isIdentity(m)) return path
  const out: PathCmd[] = []
  forEachSegment(path, (c, x0, y0) => {
    if (c[0] === "Z") return void out.push(c)
    if (c[0] === "A") {
      const arc = transformArc(c, m)
      if (arc) return void out.push(arc)
      for (const k of arcToCubics(x0, y0, c[1], c[2], c[3], c[4], c[5], c[6], c[7])) out.push(transformPath([k], m)[0]!)
      return
    }
    const pts: number[] = []
    for (let i = 1; i < c.length; i += 2) pts.push(...applyToPoint(m, c[i] as number, c[i + 1] as number))
    out.push([c[0], ...pts] as PathCmd)
  })
  return out
}

/** The arc after [m], when it is still an arc with the same flags; else null. */
function transformArc(c: Extract<PathCmd, ["A", ...number[]]>, m: Matrix): PathCmd | null {
  const [, rx, ry, rot, large, sweep, x, y] = c
  const [nx, ny] = applyToPoint(m, x, y)
  const det = m[0] * m[3] - m[1] * m[2]
  if (det <= 0) return null // a mirror flips the sweep; rare, so curves are simpler
  const s = similarityScale(m)
  if (s !== null) return ["A", rx * s, ry * s, rot + (Math.atan2(m[1], m[0]) * 180) / Math.PI, large, sweep, nx, ny]
  if (m[1] === 0 && m[2] === 0) {
    const turned = ((rot % 180) + 180) % 180
    if (turned === 0) return ["A", rx * m[0], ry * m[3], rot, large, sweep, nx, ny]
    if (turned === 90) return ["A", rx * m[3], ry * m[0], rot, large, sweep, nx, ny]
  }
  return null
}

/** Calls [f] for each command with the point it starts from. */
export function forEachSegment(path: PathCmd[], f: (c: PathCmd, x0: number, y0: number) => void) {
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  for (const c of path) {
    f(c, x, y)
    if (c[0] === "Z") {
      x = sx
      y = sy
    } else {
      x = c[c.length - 2] as number
      y = c[c.length - 1] as number
      if (c[0] === "M") {
        sx = x
        sy = y
      }
    }
  }
}

// ---- transform="..." ----------------------------------------------------------------------------------------------

/** Parses a transform list. Throws a plain message (the caller adds where). */
export function parseTransform(s: string): Matrix {
  let m = IDENTITY
  const re = /\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)\s*,?/gy
  let pos = 0
  const src = s.trim()
  re.lastIndex = 0
  while (pos < src.length) {
    re.lastIndex = pos
    const hit = re.exec(src)
    if (!hit) throw new Error(`can't read transform "${s}"`)
    pos = re.lastIndex
    const args = numberList(hit[2], `transform ${hit[1]}`)
    const n = args.length
    const bad = () => {
      throw new Error(`transform ${hit[1]}(...) has ${n} numbers`)
    }
    let t: Matrix
    switch (hit[1]) {
      case "matrix":
        if (n !== 6) bad()
        t = args as Matrix
        break
      case "translate":
        if (n !== 1 && n !== 2) bad()
        t = [1, 0, 0, 1, args[0], args[1] ?? 0]
        break
      case "scale":
        if (n !== 1 && n !== 2) bad()
        t = [args[0], 0, 0, args[1] ?? args[0], 0, 0]
        break
      case "rotate": {
        if (n !== 1 && n !== 3) bad()
        const r = (args[0] * Math.PI) / 180
        const cos = Math.cos(r)
        const sin = Math.sin(r)
        t = [cos, sin, -sin, cos, 0, 0]
        if (n === 3) t = multiply(multiply([1, 0, 0, 1, args[1], args[2]], t), [1, 0, 0, 1, -args[1], -args[2]])
        break
      }
      case "skewX":
        if (n !== 1) bad()
        t = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0]
        break
      default:
        if (n !== 1) bad()
        t = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0]
    }
    m = multiply(m, t)
  }
  return m
}

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y

/** "1, 2 -3.5e2" → numbers. Throws on anything else. */
export function numberList(s: string, what: string): number[] {
  const out: number[] = []
  let i = 0
  const skip = () => {
    while (i < s.length && /[\s,]/.test(s[i]!)) i++
  }
  skip()
  while (i < s.length) {
    NUMBER.lastIndex = i
    const m = NUMBER.exec(s)
    if (!m) throw new Error(`${what}: can't read "${s.slice(i, i + 12)}" as a number`)
    out.push(Number(m[0]))
    i = NUMBER.lastIndex
    skip()
  }
  return out
}

// ---- path data (d="...") ------------------------------------------------------------------------------------------

const ARGS: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }

/** SVG path data → absolute M L C Z. Arcs become cubic curves; H / V become lines; Q / T / S become cubics. */
export function parsePathData(d: string): PathCmd[] {
  const out: PathCmd[] = []
  let i = 0
  const len = d.length
  const ws = () => {
    while (i < len && (d[i] === " " || d[i] === "," || d[i] === "\n" || d[i] === "\r" || d[i] === "\t")) i++
  }
  const readNumber = (): number => {
    ws()
    NUMBER.lastIndex = i
    const m = NUMBER.exec(d)
    if (!m) throw new Error(`path data: expected a number at "${d.slice(i, i + 12)}"`)
    i = NUMBER.lastIndex
    return Number(m[0])
  }
  // Arc flags are one digit each and may be written without a separator ("a1 1 0 01 10 10").
  const readFlag = (): number => {
    ws()
    const ch = d[i]
    if (ch !== "0" && ch !== "1") throw new Error(`path data: an arc flag must be 0 or 1 at "${d.slice(i, i + 12)}"`)
    i++
    return ch === "1" ? 1 : 0
  }
  const startsNumber = () => {
    ws()
    return i < len && /[0-9.+-]/.test(d[i]!)
  }

  let x = 0
  let y = 0
  let startX = 0
  let startY = 0
  // The previous command's second control point, for S (cubic) and T (quadratic) reflections.
  let lastC: [number, number] | null = null
  let lastQ: [number, number] | null = null
  let cmd = ""
  ws()
  if (i < len && d[i] !== "M" && d[i] !== "m") throw new Error("path data must start with M or m")
  while (true) {
    ws()
    if (i >= len) break
    const ch = d[i]!
    if (/[a-zA-Z]/.test(ch)) {
      if (!(ch.toUpperCase() in ARGS)) throw new Error(`path data: unknown command "${ch}"`)
      cmd = ch
      i++
    } else if (!cmd || cmd === "Z" || cmd === "z") {
      throw new Error(`path data: unexpected "${d.slice(i, i + 12)}"`)
    }
    let rel = cmd === cmd.toLowerCase()
    let up = cmd.toUpperCase()
    do {
      // After a moveto, cmd is now a lineto.
      rel = cmd === cmd.toLowerCase()
      up = cmd.toUpperCase()
      let nextC: [number, number] | null = null
      let nextQ: [number, number] | null = null
      switch (up) {
        case "M": {
          const nx = readNumber() + (rel ? x : 0)
          const ny = readNumber() + (rel ? y : 0)
          out.push(["M", nx, ny])
          x = startX = nx
          y = startY = ny
          // Coordinates after a moveto are implicit linetos.
          cmd = rel ? "l" : "L"
          break
        }
        case "L": {
          const nx = readNumber() + (rel ? x : 0)
          const ny = readNumber() + (rel ? y : 0)
          out.push(["L", nx, ny])
          x = nx
          y = ny
          break
        }
        case "H": {
          x = readNumber() + (rel ? x : 0)
          out.push(["L", x, y])
          break
        }
        case "V": {
          y = readNumber() + (rel ? y : 0)
          out.push(["L", x, y])
          break
        }
        case "C": {
          const v = [readNumber(), readNumber(), readNumber(), readNumber(), readNumber(), readNumber()]
          if (rel) for (let k = 0; k < 6; k += 2) (v[k]! += x), (v[k + 1]! += y)
          out.push(["C", v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!])
          nextC = [v[2]!, v[3]!]
          x = v[4]!
          y = v[5]!
          break
        }
        case "S": {
          const v = [readNumber(), readNumber(), readNumber(), readNumber()]
          if (rel) for (let k = 0; k < 4; k += 2) (v[k]! += x), (v[k + 1]! += y)
          const c1: [number, number] = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y]
          out.push(["C", c1[0], c1[1], v[0]!, v[1]!, v[2]!, v[3]!])
          nextC = [v[0]!, v[1]!]
          x = v[2]!
          y = v[3]!
          break
        }
        case "Q": {
          const v = [readNumber(), readNumber(), readNumber(), readNumber()]
          if (rel) for (let k = 0; k < 4; k += 2) (v[k]! += x), (v[k + 1]! += y)
          out.push(["Q", v[0]!, v[1]!, v[2]!, v[3]!])
          nextQ = [v[0]!, v[1]!]
          x = v[2]!
          y = v[3]!
          break
        }
        case "T": {
          const nx = readNumber() + (rel ? x : 0)
          const ny = readNumber() + (rel ? y : 0)
          const q: [number, number] = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y]
          out.push(["Q", q[0], q[1], nx, ny])
          nextQ = q
          x = nx
          y = ny
          break
        }
        case "A": {
          const rx = readNumber()
          const ry = readNumber()
          const rot = readNumber()
          const large = readFlag()
          const sweep = readFlag()
          const nx = readNumber() + (rel ? x : 0)
          const ny = readNumber() + (rel ? y : 0)
          if (x === nx && y === ny) {
            // SVG: an arc to the same point draws nothing.
          } else if (rx === 0 || ry === 0) out.push(["L", nx, ny])
          else out.push(["A", Math.abs(rx), Math.abs(ry), rot, large, sweep, nx, ny])
          x = nx
          y = ny
          break
        }
        case "Z": {
          out.push(["Z"])
          x = startX
          y = startY
          break
        }
      }
      lastC = nextC
      lastQ = nextQ
    } while (up !== "Z" && startsNumber())
  }
  return out
}

function quadToCubic(x0: number, y0: number, qx: number, qy: number, x: number, y: number): PathCmd {
  return ["C", x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y]
}

/** An SVG arc as cubic curves, at most 90° each (SVG 1.1 implementation notes F.6.5 / F.6.6). */
export function arcToCubics(
  x1: number, y1: number, rxIn: number, ryIn: number, angle: number, large: number, sweep: number, x2: number, y2: number,
): PathCmd[] {
  if (x1 === x2 && y1 === y2) return []
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0) return [["L", x2, y2]]
  const phi = (angle * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const xp = cos * dx + sin * dy
  const yp = -sin * dx + cos * dy
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lambda > 1) {
    const s = Math.sqrt(lambda)
    rx *= s
    ry *= s
  }
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp
  const den = rx * rx * yp * yp + ry * ry * xp * xp
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
  const cxp = (coef * rx * yp) / ry
  const cyp = (-coef * ry * xp) / rx
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const theta1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry)
  let delta = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  if (sweep && delta < 0) delta += 2 * Math.PI
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9))
  const step = delta / segments
  const t = (4 / 3) * Math.tan(step / 4)
  const map = (ux: number, uy: number): [number, number] => [cx + rx * cos * ux - ry * sin * uy, cy + rx * sin * ux + ry * cos * uy]
  const out: PathCmd[] = []
  let a = theta1
  for (let k = 0; k < segments; k++) {
    const b = a + step
    const [c1x, c1y] = map(Math.cos(a) - t * Math.sin(a), Math.sin(a) + t * Math.cos(a))
    const [c2x, c2y] = map(Math.cos(b) + t * Math.sin(b), Math.sin(b) - t * Math.cos(b))
    const [ex, ey] = k === segments - 1 ? [x2, y2] : map(Math.cos(b), Math.sin(b))
    out.push(["C", c1x, c1y, c2x, c2y, ex, ey])
    a = b
  }
  return out
}

// ---- basic shapes -------------------------------------------------------------------------------------------------

/** An ellipse as two half arcs, starting at its right end and going clockwise (as SVG draws a circle). */
export function ellipsePath(cx: number, cy: number, rx: number, ry: number): PathCmd[] {
  return [["M", cx + rx, cy], ["A", rx, ry, 0, 0, 1, cx - rx, cy], ["A", rx, ry, 0, 0, 1, cx + rx, cy], ["Z"]]
}

/** A rectangle; rx / ry already resolved (SVG's auto rules) and clamped to half the sides. Rounded corners are arcs. */
export function rectPath(x: number, y: number, w: number, h: number, rx: number, ry: number): PathCmd[] {
  if (rx <= 0 || ry <= 0) return [["M", x, y], ["L", x + w, y], ["L", x + w, y + h], ["L", x, y + h], ["Z"]]
  const r = x + w
  const b = y + h
  const out: PathCmd[] = [["M", x + rx, y]]
  if (r - rx > x + rx) out.push(["L", r - rx, y])
  out.push(["A", rx, ry, 0, 0, 1, r, y + ry])
  if (b - ry > y + ry) out.push(["L", r, b - ry])
  out.push(["A", rx, ry, 0, 0, 1, r - rx, b])
  if (x + rx < r - rx) out.push(["L", x + rx, b])
  out.push(["A", rx, ry, 0, 0, 1, x, b - ry])
  if (y + ry < b - ry) out.push(["L", x, y + ry])
  out.push(["A", rx, ry, 0, 0, 1, x + rx, y], ["Z"])
  return out
}

export function polyPath(points: number[], close: boolean): PathCmd[] {
  const out: PathCmd[] = []
  for (let k = 0; k + 1 < points.length; k += 2) out.push([k === 0 ? "M" : "L", points[k]!, points[k + 1]!])
  if (close && out.length > 0) out.push(["Z"])
  return out
}

// ---- bounding box -------------------------------------------------------------------------------------------------

/** The exact bounding box of the geometry [minX, minY, maxX, maxY] (curve extremes, not control points), or null. */
export function pathBBox(path: PathCmd[]): [number, number, number, number] | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = (x: number, y: number) => {
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  const cubic = (x: number, y: number, c: number[]) => {
    for (const t of cubicExtrema(x, c[0]!, c[2]!, c[4]!)) add(cubicAt(x, c[0]!, c[2]!, c[4]!, t), cubicAt(y, c[1]!, c[3]!, c[5]!, t))
    for (const t of cubicExtrema(y, c[1]!, c[3]!, c[5]!)) add(cubicAt(x, c[0]!, c[2]!, c[4]!, t), cubicAt(y, c[1]!, c[3]!, c[5]!, t))
    add(c[4]!, c[5]!)
  }
  forEachSegment(path, (c, x, y) => {
    if (c[0] === "M" || c[0] === "L") add(c[1], c[2])
    else if (c[0] === "C") cubic(x, y, c.slice(1) as number[])
    else if (c[0] === "Q") cubic(x, y, (quadToCubic(x, y, c[1], c[2], c[3], c[4]) as number[]).slice(1))
    else if (c[0] === "A") {
      let px = x
      let py = y
      for (const k of arcToCubics(x, y, c[1], c[2], c[3], c[4], c[5], c[6], c[7])) {
        if (k[0] === "C") cubic(px, py, k.slice(1) as number[])
        else if (k[0] === "L") add(k[1], k[2])
        px = k[k.length - 2] as number
        py = k[k.length - 1] as number
      }
    }
  })
  return minX === Infinity ? null : [minX, minY, maxX, maxY]
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

/** Values of t in (0, 1) where one coordinate of a cubic has a zero derivative. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const out: number[] = []
  const keep = (t: number) => t > 0 && t < 1 && out.push(t)
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) keep(-c / b)
    return out
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return out
  const r = Math.sqrt(disc)
  keep((-b + r) / (2 * a))
  keep((-b - r) / (2 * a))
  return out
}
