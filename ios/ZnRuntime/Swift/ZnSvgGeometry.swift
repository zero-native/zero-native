// Geometry for SVG parts on iOS: what Android's PathMeasure gives (lengths per contour, a piece between two lengths,
// the point and direction at a length), from the path flattened into short lines; and the part helpers ported from
// android/runtime's ZnSvg.kt: trims (znTrimRanges / znTrimIntersect), morphs, motion paths, frames, the part matrix.
// Pieces cut from a curve are polylines of 24 steps per curve: at the sizes SVGs are drawn this is not visible.
import CoreGraphics
import Foundation

/// A path as contours of points, with the length up to each point.
struct ZnPathMeasure {
    struct Contour {
        var points: [CGPoint] = []
        var at: [CGFloat] = []  // length from the contour's start to each point
        var closed = false
        var length: CGFloat { at.last ?? 0 }
    }
    private(set) var contours: [Contour] = []

    init(_ path: CGPath) {
        var cur = Contour()
        var last = CGPoint.zero, start = CGPoint.zero
        func add(_ p: CGPoint) {
            let d = cur.points.isEmpty ? 0 : hypot(p.x - last.x, p.y - last.y)
            cur.points.append(p)
            cur.at.append((cur.at.last ?? 0) + d)
            last = p
        }
        func flush() {
            if cur.points.count > 1 { contours.append(cur) }
            cur = Contour()
        }
        let steps = 24
        path.applyWithBlock { el in
            let e = el.pointee
            switch e.type {
            case .moveToPoint:
                flush()
                start = e.points[0]
                add(start)
            case .addLineToPoint:
                if cur.points.isEmpty { add(last) }
                add(e.points[0])
            case .addQuadCurveToPoint:
                if cur.points.isEmpty { add(last) }
                let p0 = last, c = e.points[0], p1 = e.points[1]
                for k in 1...steps { add(Self.quad(p0, c, p1, CGFloat(k) / CGFloat(steps))) }
            case .addCurveToPoint:
                if cur.points.isEmpty { add(last) }
                let p0 = last, c1 = e.points[0], c2 = e.points[1], p1 = e.points[2]
                for k in 1...steps { add(Self.cubic(p0, c1, c2, p1, CGFloat(k) / CGFloat(steps))) }
            case .closeSubpath:
                if !cur.points.isEmpty {
                    add(start)
                    cur.closed = true
                }
                flush()
                last = start
            @unknown default:
                break
            }
        }
        flush()
    }

    private static func quad(_ p0: CGPoint, _ c: CGPoint, _ p1: CGPoint, _ t: CGFloat) -> CGPoint {
        let u: CGFloat = 1 - t
        let a: CGFloat = u * u, b: CGFloat = 2 * u * t, d: CGFloat = t * t
        let x: CGFloat = a * p0.x + b * c.x + d * p1.x
        let y: CGFloat = a * p0.y + b * c.y + d * p1.y
        return CGPoint(x: x, y: y)
    }

    private static func cubic(_ p0: CGPoint, _ c1: CGPoint, _ c2: CGPoint, _ p1: CGPoint, _ t: CGFloat) -> CGPoint {
        let u: CGFloat = 1 - t
        let a: CGFloat = u * u * u, b: CGFloat = 3 * u * u * t, c: CGFloat = 3 * u * t * t, d: CGFloat = t * t * t
        let x: CGFloat = a * p0.x + b * c1.x + c * c2.x + d * p1.x
        let y: CGFloat = a * p0.y + b * c1.y + c * c2.y + d * p1.y
        return CGPoint(x: x, y: y)
    }

    var lengths: [CGFloat] { contours.map(\.length) }

    /// The point and direction (radians) at [d] along contour [c].
    func posTan(_ c: Int, _ d: CGFloat) -> (CGPoint, CGFloat)? {
        guard contours.indices.contains(c) else { return nil }
        let k = contours[c]
        let d = min(max(d, 0), k.length)
        var i = 1
        while i < k.points.count - 1 && k.at[i] < d { i += 1 }
        let a = k.points[i - 1], b = k.points[i]
        let seg = k.at[i] - k.at[i - 1]
        let t = seg > 0 ? (d - k.at[i - 1]) / seg : 0
        return (CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t), atan2(b.y - a.y, b.x - a.x))
    }

    /// The piece of contour [c] between lengths [d0] and [d1], added to [out] (a new contour).
    func segment(_ c: Int, _ d0: CGFloat, _ d1: CGFloat, into out: CGMutablePath) -> Bool {
        guard contours.indices.contains(c), d1 > d0 else { return false }
        let k = contours[c]
        guard let (p0, _) = posTan(c, d0), let (p1, _) = posTan(c, d1) else { return false }
        out.move(to: p0)
        for i in 0..<k.points.count where k.at[i] > d0 && k.at[i] < d1 { out.addLine(to: k.points[i]) }
        out.addLine(to: p1)
        return true
    }
}

/// The visible piece of a line [total] long for trims start / end / offset (fractions): [a1, b1, a2, b2], a2 < 0 for
/// one range; nil when nothing is cut (as znTrimRanges in ZnSvg.kt).
func znTrimRanges(_ start: CGFloat, _ end: CGFloat, _ offset: CGFloat, _ total: CGFloat) -> [CGFloat]? {
    var s = min(max(start, 0), 1), e = min(max(end, 0), 1)
    if s > e { swap(&s, &e) }
    let span = e - s
    if span >= 1 || total <= 0 { return nil }
    var o = (s + offset).truncatingRemainder(dividingBy: 1)
    if o < 0 { o += 1 }
    let a = o * total
    let b = a + span * total
    return [a, min(b, total), b > total ? 0 : -1, b - total]
}

/// The pieces of [rel] (from znTrimRanges) moved by [base], cut to [parent]'s ranges (nil: nothing to cut to). At most 4.
func znTrimIntersect(_ rel: [CGFloat], _ base: CGFloat, _ parent: [(CGFloat, CGFloat)]?) -> [(CGFloat, CGFloat)] {
    var out: [(CGFloat, CGFloat)] = []
    for i in 0..<(rel[2] < 0 ? 1 : 2) {
        let a = rel[i * 2] + base, b = rel[i * 2 + 1] + base
        guard let parent else { out.append((a, b)); continue }
        for (p, q) in parent {
            let lo = max(a, p), hi = min(b, q)
            let keep = a == b ? (a >= p && a <= q) : hi > lo
            if keep && out.count < 4 { out.append((lo, a == b ? a : hi)) }
        }
    }
    return out
}

/// A morph's keyframe paths ("MCCZ|x y ...|x y ..."): the same commands (M L C Z) in every keyframe.
struct ZnSvgMorph {
    let commands: [Character]
    let keyframes: [[CGFloat]]

    static func parse(_ s: String) -> ZnSvgMorph? {
        let parts = s.split(separator: "|", omittingEmptySubsequences: false)
        guard let head = parts.first else { return nil }
        let commands = Array(head)
        var count = 0
        for c in commands {
            switch c { case "M", "L": count += 2; case "C": count += 6; case "Z": break; default: return nil }
        }
        let keys = parts.dropFirst().map { k in k.split(separator: " ").map { CGFloat(Double($0) ?? .nan) } }
        guard !keys.isEmpty, keys.allSatisfy({ $0.count == count && !$0.contains(where: \.isNaN) }) else {
            print("zn: bad SVG morph data, drawing the shape's own path")
            return nil
        }
        return ZnSvgMorph(commands: commands, keyframes: keys)
    }

    /// The path at [at] (0 = the first keyframe, 1.5 = half way from the second to the third).
    func path(at: CGFloat) -> CGPath {
        let last = keyframes.count - 1
        let c = min(max(at, 0), CGFloat(last))
        let i = min(Int(c), max(last - 1, 0))
        let f = last == 0 ? 0 : c - CGFloat(i)
        let a = keyframes[i], b = keyframes[min(i + 1, last)]
        let v = zip(a, b).map { $0 + ($1 - $0) * f }
        return Self.build(commands, v)
    }

    static func build(_ commands: [Character], _ v: [CGFloat]) -> CGMutablePath {
        let p = CGMutablePath()
        var k = 0
        for c in commands {
            switch c {
            case "M": p.move(to: CGPoint(x: v[k], y: v[k + 1])); k += 2
            case "L": p.addLine(to: CGPoint(x: v[k], y: v[k + 1])); k += 2
            case "C":
                p.addCurve(to: CGPoint(x: v[k + 4], y: v[k + 5]), control1: CGPoint(x: v[k], y: v[k + 1]),
                           control2: CGPoint(x: v[k + 2], y: v[k + 3]))
                k += 6
            case "Z": p.closeSubpath()
            default: break
            }
        }
        return p
    }
}

/// A path a part moves along ("ox oy angle mode;MCZ;x y ..."): at `at` (0–1 of its length) the part moves by
/// (point − origin) and turns around the origin: mode 0 by angle, 1 by the path's direction minus angle, 2 plus 180.
struct ZnSvgMotionPath {
    let ox: CGFloat, oy: CGFloat, angle: CGFloat, mode: Int
    let measure: ZnPathMeasure
    let start: CGPoint

    static func parse(_ s: String) -> ZnSvgMotionPath? {
        let parts = s.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        let head = parts[0].trimmingCharacters(in: .whitespaces).split(separator: " ").map { CGFloat(Double($0) ?? .nan) }
        guard head.count == 4, !head.contains(where: \.isNaN), parts.count == 3,
              let shape = ZnSvgMorph.parse("\(parts[1])|\(parts[2])"), shape.commands.first == "M" else {
            print("zn: bad SVG motion path, the part stays where it is")
            return nil
        }
        let v = shape.keyframes[0]
        return ZnSvgMotionPath(ox: head[0], oy: head[1], angle: head[2], mode: Int(head[3]),
                               measure: ZnPathMeasure(ZnSvgMorph.build(shape.commands, v)), start: CGPoint(x: v[0], y: v[1]))
    }

    /// Android's preTranslate / preRotate for position [at], as a transform applied first.
    func transform(at: CGFloat) -> CGAffineTransform {
        let lengths = measure.lengths
        var d = min(max(at, 0), 1) * lengths.reduce(0, +)
        var i = 0
        while i < lengths.count - 1 && d > lengths[i] { d -= lengths[i]; i += 1 }
        var pos = start
        var dir: CGFloat = 0
        if let (p, a) = measure.posTan(i, d) { pos = p; dir = a * 180 / .pi }
        var m = CGAffineTransform(translationX: pos.x - ox, y: pos.y - oy)
        let r: CGFloat = mode == 1 ? dir - angle : mode == 2 ? dir - angle + 180 : angle
        if r != 0 {
            let turn = CGAffineTransform(translationX: ox, y: oy).rotated(by: r * .pi / 180).translatedBy(x: -ox, y: -oy)
            m = turn.concatenating(m)
        }
        return m
    }
}

/// SvgPart `frame` ("a b c d e f"): the part's transform happens in this space (frame · transform · frame⁻¹).
func znSvgFrame(_ s: String) -> CGAffineTransform? {
    let n = s.trimmingCharacters(in: .whitespaces).split(separator: " ").compactMap { Double($0) }.map { CGFloat($0) }
    guard n.count == 6 else { print("zn: bad SVG part frame \"\(s)\""); return nil }
    let m = CGAffineTransform(a: n[0], b: n[1], c: n[2], d: n[3], tx: n[4], ty: n[5])
    guard abs(m.a * m.d - m.b * m.c) > 1e-9 else { print("zn: SVG part frame can't be undone"); return nil }
    return m
}
