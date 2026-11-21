// SVG path data ("M 0 0 L 10 0 Z") → CGMutablePath, for <Canvas> path and clipPath commands (ZnCanvasParse.swift).
// Android parses with Compose's PathParser (ZnCanvas.kt). A copy of <Icon>'s parser (SvgPathParser in ZnIcon.swift),
// kept apart so icons are not touched: this one builds a CGPath (CoreGraphics only, so the Mac tests build it) and
// says when the data is bad, so the command is skipped with a warning, as Compose's parser throwing is on Android.
// - Supports M L H V C S Q T A Z, absolute and relative, with implicit repeats. Arcs become cubic curves.
// - A relative move after Z starts from the closed shape's start (SVG's rule; Android gets the same with
//   znAbsoluteMovesAfterClose, ZnSvg.kt).
// - Bad: an unknown letter or something that is not a number where one belongs. Numbers missing at the very end are
//   dropped quietly (the path so far draws), as Compose does.
import CoreGraphics
import Foundation

enum ZnPathData {
    /// The path, and false when the data has something in it that isn't path data.
    static func parse(_ d: String) -> (path: CGMutablePath, ok: Bool) {
        let path = CGMutablePath()
        var tokens = Tokens(Array(d.utf8))
        var cur = CGPoint.zero, start = CGPoint.zero
        var lastCtrl: CGPoint? = nil
        var lastCmd: UInt8 = 0
        var cmd: UInt8 = 0
        // CG needs a current point before a line or curve: data that starts with one starts at 0, 0 (as Compose).
        func begin() { if path.isEmpty { path.move(to: cur) } }
        while let c = tokens.nextCommand(current: cmd) {
            cmd = c
            let rel = c >= 97  // lowercase
            func pt() -> CGPoint? {
                guard let x = tokens.number(), let y = tokens.number() else { return nil }
                return rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            }
            switch c | 0x20 {  // lowercase
            case UInt8(ascii: "m"):
                guard let p = pt() else { return (path, tokens.atEnd) }
                path.move(to: p); cur = p; start = p
                cmd = rel ? UInt8(ascii: "l") : UInt8(ascii: "L")  // following pairs are line-tos
                lastCtrl = nil
            case UInt8(ascii: "l"):
                guard let p = pt() else { return (path, tokens.atEnd) }
                begin(); path.addLine(to: p); cur = p; lastCtrl = nil
            case UInt8(ascii: "h"):
                guard let x = tokens.number() else { return (path, tokens.atEnd) }
                begin(); cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur); lastCtrl = nil
            case UInt8(ascii: "v"):
                guard let y = tokens.number() else { return (path, tokens.atEnd) }
                begin(); cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur); lastCtrl = nil
            case UInt8(ascii: "c"):
                guard let c1 = pt(), let c2 = pt(), let p = pt() else { return (path, tokens.atEnd) }
                begin(); path.addCurve(to: p, control1: c1, control2: c2); cur = p; lastCtrl = c2
            case UInt8(ascii: "s"):
                let c1 = reflect(lastCtrl, about: cur, if: [UInt8(ascii: "c"), UInt8(ascii: "s")].contains(lastCmd | 0x20))
                guard let c2 = pt(), let p = pt() else { return (path, tokens.atEnd) }
                begin(); path.addCurve(to: p, control1: c1, control2: c2); cur = p; lastCtrl = c2
            case UInt8(ascii: "q"):
                guard let q = pt(), let p = pt() else { return (path, tokens.atEnd) }
                begin(); path.addQuadCurve(to: p, control: q); cur = p; lastCtrl = q
            case UInt8(ascii: "t"):
                let q = reflect(lastCtrl, about: cur, if: [UInt8(ascii: "q"), UInt8(ascii: "t")].contains(lastCmd | 0x20))
                guard let p = pt() else { return (path, tokens.atEnd) }
                begin(); path.addQuadCurve(to: p, control: q); cur = p; lastCtrl = q
            case UInt8(ascii: "a"):
                guard let rx = tokens.number(), let ry = tokens.number(), let rot = tokens.number(),
                      let large = tokens.flag(), let sweep = tokens.flag(), let p = pt() else { return (path, tokens.atEnd) }
                begin()
                addArc(path, from: cur, to: p, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                cur = p; lastCtrl = nil
            case UInt8(ascii: "z"):
                if !path.isEmpty { path.closeSubpath() }
                cur = start; lastCtrl = nil
                // Z takes no numbers: Compose drops any that follow. (Without this the loop below would repeat Z
                // forever on "Z 5", since a repeated Z reads nothing.)
                while tokens.number() != nil {}
            default:
                return (path, false)  // a letter that isn't a path command
            }
            lastCmd = c
        }
        // Stopped before the end: something that is neither a command nor a number.
        return (path, tokens.atEnd)
    }

    private static func reflect(_ ctrl: CGPoint?, about p: CGPoint, if ok: Bool) -> CGPoint {
        guard ok, let c = ctrl else { return p }
        return CGPoint(x: 2 * p.x - c.x, y: 2 * p.y - c.y)
    }

    /// SVG elliptical arc (endpoint form) as cubic curves (SVG spec, appendix B.2.4).
    private static func addArc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, rx rxIn: CGFloat, ry ryIn: CGFloat,
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
        var coef = den > 0 ? sqrt(max(0, num / den)) : 0
        if large == sweep { coef = -coef }
        let cx1 = coef * rx * y1 / ry, cy1 = -coef * ry * x1 / rx
        let cx = cosPhi * cx1 - sinPhi * cy1 + (p0.x + p1.x) / 2
        let cy = sinPhi * cx1 + cosPhi * cy1 + (p0.y + p1.y) / 2
        func angle(_ ux: CGFloat, _ uy: CGFloat, _ vx: CGFloat, _ vy: CGFloat) -> CGFloat {
            atan2(ux * vy - uy * vx, ux * vx + uy * vy)
        }
        let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi } else if sweep && delta < 0 { delta += 2 * .pi }
        guard delta.isFinite, cx.isFinite, cy.isFinite else { path.addLine(to: p1); return }
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
            while i < b.count, b[i] == 32 || b[i] == 44 || b[i] == 9 || b[i] == 10 || b[i] == 13 || b[i] == 12 { i += 1 }
        }

        /// True when only separators are left.
        var atEnd: Bool {
            mutating get { skip(); return i >= b.count }
        }

        /// The next command letter, or the current one again when numbers follow (implicit repeat).
        mutating func nextCommand(current: UInt8) -> UInt8? {
            skip()
            guard i < b.count else { return nil }
            let c = b[i]
            if (c >= 65 && c <= 90) || (c >= 97 && c <= 122) { i += 1; return c }
            // Z never repeats: what follows it here is neither a number nor a letter, so the data stops (bad).
            return current == 0 || current | 0x20 == 122 ? nil : current
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
            if digits, i < b.count, b[i] == 101 || b[i] == 69 {  // exponent
                var j = i + 1
                if j < b.count, b[j] == 43 || b[j] == 45 { j += 1 }
                if j < b.count, b[j] >= 48 && b[j] <= 57 {
                    while j < b.count, b[j] >= 48 && b[j] <= 57 { j += 1 }
                    i = j
                }
            }
            guard digits, let v = Double(String(decoding: b[s..<i], as: UTF8.self)), v.isFinite else { i = s; return nil }
            return CGFloat(v)
        }
    }
}
