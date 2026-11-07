// <Icon>: SVG path data from the template ("minX minY width height|d"), drawn natively. Port of ZnIcon in
// android/runtime's ZnTemplate.kt; Android parses the path with Compose's PathParser, here with our own parser.
import SwiftUI

struct ZnIconData {
    let minX: CGFloat, minY: CGFloat, width: CGFloat, height: CGFloat
    let path: Path

    static func parse(_ spec: String) -> ZnIconData? {
        guard let bar = spec.firstIndex(of: "|") else { return nil }
        let box = spec[..<bar].split(whereSeparator: { $0 == " " || $0 == "," }).compactMap { Double($0) }
        guard box.count == 4, box[2] > 0, box[3] > 0 else { return nil }
        return ZnIconData(minX: box[0], minY: box[1], width: box[2], height: box[3],
                          path: SvgPathParser.parse(String(spec[spec.index(after: bar)...])))
    }
}

/// SVG path data → Path. Supports M L H V C S Q T A Z, absolute and relative. Arcs become cubic curves.
enum SvgPathParser {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var tokens = Tokens(Array(d.utf8))
        var cur = CGPoint.zero, start = CGPoint.zero
        var lastCtrl: CGPoint? = nil
        var lastCmd: UInt8 = 0
        var cmd: UInt8 = 0
        while let c = tokens.nextCommand(current: cmd) {
            cmd = c
            let rel = c >= 97  // lowercase
            func pt() -> CGPoint? {
                guard let x = tokens.number(), let y = tokens.number() else { return nil }
                return rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            }
            switch c | 0x20 {  // lowercase
            case UInt8(ascii: "m"):
                guard let p = pt() else { return path }
                path.move(to: p); cur = p; start = p
                cmd = rel ? UInt8(ascii: "l") : UInt8(ascii: "L")  // following pairs are line-tos
                lastCtrl = nil
            case UInt8(ascii: "l"):
                guard let p = pt() else { return path }
                path.addLine(to: p); cur = p; lastCtrl = nil
            case UInt8(ascii: "h"):
                guard let x = tokens.number() else { return path }
                cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur); lastCtrl = nil
            case UInt8(ascii: "v"):
                guard let y = tokens.number() else { return path }
                cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur); lastCtrl = nil
            case UInt8(ascii: "c"):
                guard let c1 = pt(), let c2 = pt(), let p = pt() else { return path }
                path.addCurve(to: p, control1: c1, control2: c2); cur = p; lastCtrl = c2
            case UInt8(ascii: "s"):
                let c1 = reflect(lastCtrl, about: cur, if: [UInt8(ascii: "c"), UInt8(ascii: "s")].contains(lastCmd | 0x20))
                guard let c2 = pt(), let p = pt() else { return path }
                path.addCurve(to: p, control1: c1, control2: c2); cur = p; lastCtrl = c2
            case UInt8(ascii: "q"):
                guard let q = pt(), let p = pt() else { return path }
                path.addQuadCurve(to: p, control: q); cur = p; lastCtrl = q
            case UInt8(ascii: "t"):
                let q = reflect(lastCtrl, about: cur, if: [UInt8(ascii: "q"), UInt8(ascii: "t")].contains(lastCmd | 0x20))
                guard let p = pt() else { return path }
                path.addQuadCurve(to: p, control: q); cur = p; lastCtrl = q
            case UInt8(ascii: "a"):
                guard let rx = tokens.number(), let ry = tokens.number(), let rot = tokens.number(),
                      let large = tokens.flag(), let sweep = tokens.flag(), let p = pt() else { return path }
                addArc(&path, from: cur, to: p, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                cur = p; lastCtrl = nil
            case UInt8(ascii: "z"):
                path.closeSubpath(); cur = start; lastCtrl = nil
            default:
                return path
            }
            lastCmd = c
        }
        return path
    }

    private static func reflect(_ ctrl: CGPoint?, about p: CGPoint, if ok: Bool) -> CGPoint {
        guard ok, let c = ctrl else { return p }
        return CGPoint(x: 2 * p.x - c.x, y: 2 * p.y - c.y)
    }

    /// SVG elliptical arc (endpoint form) as cubic curves (SVG spec, appendix B.2.4).
    private static func addArc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat,
                               rotation: CGFloat, large: Bool, sweep: Bool) {
        var rx = abs(rxIn), ry = abs(ryIn)
        if rx == 0 || ry == 0 || p0 == p1 { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180, cosPhi = cos(phi), sinPhi = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosPhi * dx + sinPhi * dy, y1 = -sinPhi * dx + cosPhi * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = sqrt(max(0, num / den))
        if large == sweep { coef = -coef }
        let cx1 = coef * rx * y1 / ry, cy1 = -coef * ry * x1 / rx
        let cx = cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2
        let cy = sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            return a
        }
        let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi } else if sweep && delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / CGFloat(segments)
        let t = 4 / 3 * tan(step / 4)
        var a1 = theta1
        func point(_ a: CGFloat) -> CGPoint {
            CGPoint(x: cx + rx * cos(a) * cosPhi - ry * sin(a) * sinPhi, y: cy + rx * cos(a) * sinPhi + ry * sin(a) * cosPhi)
        }
        func deriv(_ a: CGFloat) -> CGPoint {
            CGPoint(x: -rx * sin(a) * cosPhi - ry * cos(a) * sinPhi, y: -rx * sin(a) * sinPhi + ry * cos(a) * cosPhi)
        }
        for _ in 0..<segments {
            let a2 = a1 + step
            let s = point(a1), e = point(a2), d1 = deriv(a1), d2 = deriv(a2)
            path.addCurve(to: e, control1: CGPoint(x: s.x + t * d1.x, y: s.y + t * d1.y),
                          control2: CGPoint(x: e.x - t * d2.x, y: e.y - t * d2.y))
            a1 = a2
        }
    }

    private struct Tokens {
        let b: [UInt8]
        var i = 0
        init(_ b: [UInt8]) { self.b = b }

        mutating func skip() {
            while i < b.count, b[i] == 32 || b[i] == 44 || b[i] == 9 || b[i] == 10 || b[i] == 13 { i += 1 }
        }

        /// The next command letter, or the current one again when numbers follow (implicit repeat).
        mutating func nextCommand(current: UInt8) -> UInt8? {
            skip()
            guard i < b.count else { return nil }
            let c = b[i]
            if (c >= 65 && c <= 90) || (c >= 97 && c <= 122) { i += 1; return c }
            return current == 0 ? nil : current
        }

        mutating func flag() -> Bool? {
            skip()
            guard i < b.count, b[i] == 48 || b[i] == 49 else { return nil }
            defer { i += 1 }
            return b[i] == 49
        }

        mutating func number() -> CGFloat? {
            skip()
            let s = i
            if i < b.count, b[i] == 43 || b[i] == 45 { i += 1 }
            var dot = false, digits = false
            while i < b.count {
                let c = b[i]
                if c >= 48 && c <= 57 { digits = true; i += 1 }
                else if c == 46 && !dot { dot = true; i += 1 }
                else { break }
            }
            if i < b.count, b[i] == 101 || b[i] == 69 {  // exponent
                i += 1
                if i < b.count, b[i] == 43 || b[i] == 45 { i += 1 }
                while i < b.count, b[i] >= 48 && b[i] <= 57 { i += 1 }
            }
            guard digits, let v = Double(String(decoding: b[s..<i], as: UTF8.self)) else { i = s; return nil }
            return CGFloat(v)
        }
    }
}
