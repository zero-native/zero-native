// SVG draw data on iOS (docs/svg.md §8): the compiler's format v1 (compiler/src/svg-data.ts) read into plain data,
// a port of android/runtime's ZnSvg.kt reader (SvgScanner): same tokens, same checks, same errors. Path data goes
// through SvgPathParser (ZnIcon.swift). Drawing is ZnSvgDraw.swift.
import CoreGraphics
import Foundation
import SwiftUI

enum ZnSvgPaint {
    static let none = 0, current = 1, color = 2, gradient = 3, pattern = 4
}

/// aspect = 18: preserveAspectRatio="none" (stretch).
let znSvgAspectNone = 18

/// A gradient. coords: x1 y1 x2 y2 (linear), cx cy r (radial), or cx cy r fx fy fr (radial with a focal circle).
/// matrix: a b c d e f, or nil (identity). spread: 0 pad, 1 reflect, 2 repeat.
struct SvgGradient {
    let radial: Bool
    let coords: [CGFloat]
    let spread: Int
    let matrix: CGAffineTransform?
    let offsets: [CGFloat]
    let colors: [UInt32]
}

/// A clip: the union of its paths, each with its own fill rule.
struct SvgClip {
    let paths: [(path: CGPath, evenOdd: Bool)]
}

/// Ops drawn by a pattern or a mask, with their own shapes' paths.
struct SvgContent {
    let ops: [SvgOp]
    let paths: [CGPath]
}

/// tile: x y w h in its space; matrix: that space → the shape's.
struct SvgPattern {
    let tile: [CGFloat]
    let matrix: CGAffineTransform?
    let content: Int
}

struct SvgMask {
    let luminance: Bool
    let region: Int
    let content: Int
}

// SvgFilter and SvgFilterPrim (a filter, its primitives and its plain drop shadows) are in ZnSvgFilters.swift, with
// the graph that runs them (the Mac unit suite builds that file alone).

/// dashes: nil when solid. nonScaling: width is in points, whatever the SVG's size.
struct SvgStroke {
    let width: CGFloat
    let cap: Int
    let join: Int
    let miter: CGFloat
    let dashes: [CGFloat]?
    let dashOffset: CGFloat
    let nonScaling: Bool
}

struct SvgShape {
    let part: Int
    let index: Int
    let fillKind: Int, fill: UInt32, fillAlpha: CGFloat
    let strokeKind: Int, stroke: UInt32, strokeAlpha: CGFloat
    let evenOdd: Bool
    let opacity: CGFloat
    let strokeSpec: SvgStroke?
    let matrix: CGAffineTransform?
    let strokeFirst: Bool
}

struct SvgGroup {
    let part: Int
    let opacity: CGFloat
    let clip: Int, mask: Int, filter: Int, blend: Int
    var end = -1
}

struct SvgTextRun {
    let fillKind: Int, fill: UInt32, fillAlpha: CGFloat
    let strokeKind: Int, stroke: UInt32, strokeAlpha: CGFloat
    let opacity: CGFloat
    let strokeSpec: SvgStroke?
    let size: CGFloat
    let weight: Int
    let italic: Bool
    let family: Int
    let spacing: CGFloat
    let baseline: Int
    let dx: CGFloat, dy: CGFloat
    let text: String
}

struct SvgText {
    let part: Int
    let x: CGFloat, y: CGFloat
    let anchor: Int
    let matrix: CGAffineTransform?
    let runs: [SvgTextRun]
}

enum SvgOp {
    case group(SvgGroup)
    case groupEnd
    case shape(SvgShape)
    case text(SvgText)
}

struct ZnSvgData {
    let vx: CGFloat, vy: CGFloat, vw: CGFloat, vh: CGFloat
    let aspect: Int
    let gradients: [SvgGradient]
    let clips: [SvgClip]
    let main: SvgContent
    let filters: [SvgFilter]
    let patterns: [SvgPattern]
    let masks: [SvgMask]
    let contents: [SvgContent]
    /// Animated gradient stops, as (gradient, stop, part) triples in gradient order ("SL").
    let stopLinks: [Int]
}

struct ZnSvgFormatError: Error, CustomStringConvertible {
    let description: String
}

/// Reads format v1 in one pass. Tokens are separated by exactly one space; path data runs to ";".
struct ZnSvgReader {
    private let s: [UInt8]
    private var i = 0
    private var n: Int { s.count }
    private var paintKind = ZnSvgPaint.none
    private var paintValue: UInt32 = 0
    private var gradients: [SvgGradient] = []
    private var clips: [SvgClip] = []
    private var filters: [SvgFilter] = []
    private var patterns: [SvgPattern] = []
    private var masks: [SvgMask] = []
    private var contents: [SvgContent] = []
    private var stopLinks: [Int] = []

    private init(_ text: String) { s = Array(text.utf8) }

    static func read(_ text: String) throws -> ZnSvgData {
        var r = ZnSvgReader(text)
        return try r.read()
    }

    private mutating func read() throws -> ZnSvgData {
        if n == 0 { try fail("empty draw data") }
        if !word2("Z", "1") { try fail("draw data must start with Z1 (format v1)") }
        let vx = try number(), vy = try number(), vw = try number(), vh = try number()
        if vw <= 0 || vh <= 0 { try fail("viewBox width and height must be above 0") }
        let aspect = try int(0, znSvgAspectNone, "aspect")
        while i < n {
            if word2("L", "G") { gradients.append(try gradient(4)) }
            else if word2("R", "G") { gradients.append(try gradient(3)) }
            else if word2("R", "F") { gradients.append(try gradient(6)) }
            else if word2("S", "L") {
                let lastG = stopLinks.count >= 3 ? stopLinks[stopLinks.count - 3] : -1
                let g = try int(max(0, lastG), gradients.count - 1, "stop link gradient")
                stopLinks.append(g)
                stopLinks.append(try int(0, gradients[g].colors.count - 1, "stop link stop"))
                stopLinks.append(try int(0, Int(Int32.max), "stop link part"))
            }
            else if word("K") { clips.append(try clip()) }
            else if word2("F", "L") { filters.append(try filter()) }
            else if word2("P", "T") {
                let tile = [try number(), try number(), try number(), try number()]
                let matrix = try self.matrix()
                contents.append(try ops("p", "t"))
                patterns.append(SvgPattern(tile: tile, matrix: matrix, content: contents.count - 1))
            }
            else if word2("M", "K") {
                let luminance = try int(0, 1, "mask type") == 0
                let region = try int(-1, clips.count - 1, "mask region")
                contents.append(try ops("m", "k"))
                masks.append(SvgMask(luminance: luminance, region: region, content: contents.count - 1))
            }
            else { break }
        }
        let main = try ops(nil, nil)
        return ZnSvgData(vx: vx, vy: vy, vw: vw, vh: vh, aspect: aspect, gradients: gradients, clips: clips, main: main,
                         filters: filters, patterns: patterns, masks: masks, contents: contents, stopLinks: stopLinks)
    }

    private mutating func ops(_ end0: Character?, _ end1: Character?) throws -> SvgContent {
        var ops: [SvgOp] = []
        var paths: [CGPath] = []
        var open: [Int] = []
        var part = 0
        func group(_ effects: Bool, _ me: inout ZnSvgReader) throws {
            let opacity = try me.number()
            let clip = try me.int(-1, me.clips.count - 1, "clip")
            let mask = effects ? try me.int(-1, me.masks.count - 1, "mask") : -1
            let filter = effects ? try me.int(-1, me.filters.count - 1, "filter") : -1
            let blend = effects ? try me.int(0, 15, "blend") : 0
            open.append(ops.count)
            ops.append(.group(SvgGroup(part: part, opacity: opacity, clip: clip, mask: mask, filter: filter, blend: blend)))
            part += 1
        }
        while i < n {
            if let e0 = end0, let e1 = end1, open.isEmpty, word2(e0, e1) { return SvgContent(ops: ops, paths: paths) }
            if word("G") { try group(false, &self) }
            else if word("X") { try group(true, &self) }
            else if word("g") {
                guard let g = open.popLast() else { try fail("g without a G") }
                if case .group(var grp) = ops[g] { grp.end = ops.count; ops[g] = .group(grp) }
                ops.append(.groupEnd)
            }
            else if word("S") { ops.append(.shape(try shape(part, &paths))); part += 1 }
            else if word("T") { ops.append(.text(try text(part))); part += 1 }
            else { try fail("unknown token") }
        }
        if !open.isEmpty { try fail("\(open.count) G without a g") }
        if let e0 = end0, let e1 = end1 { try fail("\(e0)\(e1) missing") }
        return SvgContent(ops: ops, paths: paths)
    }

    private mutating func filter() throws -> SvgFilter {
        let region = [try number(), try number(), try number(), try number()]
        let count = try int(1, n - i, "primitive count")
        var prims: [SvgFilterPrim] = []
        for k in 0..<count {
            func input(_ me: inout ZnSvgReader) throws -> Int { try me.int(-2, k - 1, "filter input") }
            if word("b") { prims.append(SvgFilterPrim(kind: "b", inputs: [try input(&self)], values: [try number(), try number()], mode: 0, color: 0)) }
            else if word("o") { prims.append(SvgFilterPrim(kind: "o", inputs: [try input(&self)], values: [try number(), try number()], mode: 0, color: 0)) }
            else if word("f") { prims.append(SvgFilterPrim(kind: "f", inputs: [], values: [], mode: 0, color: try color())) }
            else if word("m") {
                let inp = try input(&self)
                var v: [CGFloat] = []
                for _ in 0..<20 { v.append(try number()) }
                prims.append(SvgFilterPrim(kind: "m", inputs: [inp], values: v, mode: 0, color: 0))
            }
            else if word("c") { prims.append(SvgFilterPrim(kind: "c", inputs: [try input(&self), try input(&self)], values: [], mode: try int(0, 6, "composite"), color: 0)) }
            else if word("B") { prims.append(SvgFilterPrim(kind: "B", inputs: [try input(&self), try input(&self)], values: [], mode: try int(0, 15, "blend"), color: 0)) }
            else if word("M") {
                let m = try int(1, n - i, "merge count")
                var ins: [Int] = []
                for _ in 0..<m { ins.append(try input(&self)) }
                prims.append(SvgFilterPrim(kind: "M", inputs: ins, values: [], mode: 0, color: 0))
            }
            else { try fail("unknown filter primitive") }
        }
        let m = try int(0, n - i, "shadow count")
        var shadows: [(CGFloat, CGFloat, CGFloat, UInt32)] = []
        for _ in 0..<m { shadows.append((try number(), try number(), try number(), try color())) }
        return SvgFilter(region: region, prims: prims, shadows: shadows.map { (dx: $0.0, dy: $0.1, std: $0.2, color: $0.3) })
    }

    private mutating func gradient(_ coords: Int) throws -> SvgGradient {
        var c: [CGFloat] = []
        for _ in 0..<coords { c.append(try number()) }
        let spread = try int(0, 2, "spread")
        let matrix = try self.matrix()
        let count = try int(0, n - i, "stop count")
        var offsets: [CGFloat] = [], colors: [UInt32] = []
        var last: CGFloat = 0
        for _ in 0..<count {
            // As SVG: an offset below an earlier one takes the earlier one's value.
            let o = max(min(max(try number(), 0), 1), last)
            offsets.append(o)
            last = o
            colors.append(try color())
        }
        return SvgGradient(radial: coords != 4, coords: c, spread: spread, matrix: matrix, offsets: offsets, colors: colors)
    }

    private mutating func clip() throws -> SvgClip {
        var paths: [(CGPath, Bool)] = []
        while word2("K", "P") {
            let rule = try int(0, 1, "rule")
            paths.append((try path(), rule == 1))
        }
        if paths.isEmpty { try fail("K needs at least one KP") }
        return SvgClip(paths: paths.map { (path: $0.0, evenOdd: $0.1) })
    }

    private mutating func shape(_ part: Int, _ paths: inout [CGPath]) throws -> SvgShape {
        try paint()
        let fk = paintKind, fv = paintValue
        let fa = try number()
        try paint()
        let sk = paintKind, sv = paintValue
        let sa = try number()
        let rule = try int(0, 3, "rule")  // + 2: paint-order, the stroke first
        let opacity = try number()
        let spec = sk != ZnSvgPaint.none ? try strokeSpec() : nil
        let matrix = try self.matrix()
        let index = paths.count
        paths.append(try path())
        return SvgShape(part: part, index: index, fillKind: fk, fill: fv, fillAlpha: fa, strokeKind: sk, stroke: sv,
                        strokeAlpha: sa, evenOdd: rule & 1 == 1, opacity: opacity, strokeSpec: spec, matrix: matrix,
                        strokeFirst: rule >= 2)
    }

    private mutating func text(_ part: Int) throws -> SvgText {
        let x = try number(), y = try number()
        let anchor = try int(0, 2, "text anchor")
        let matrix = try self.matrix()
        let count = try int(1, n - i, "run count")
        var runs: [SvgTextRun] = []
        for _ in 0..<count {
            try paint()
            let fk = paintKind, fv = paintValue
            let fa = try number()
            try paint()
            let sk = paintKind, sv = paintValue
            let sa = try number()
            let opacity = try number()
            let spec = sk != ZnSvgPaint.none ? try strokeSpec() : nil
            let size = try number()
            let weight = try int(1, 1000, "font weight")
            let italic = try int(0, 1, "italic") == 1
            let family = try int(0, 2, "font family")
            let spacing = try number()
            let baseline = try int(0, 2, "baseline")
            let dx = try number(), dy = try number()
            runs.append(SvgTextRun(fillKind: fk, fill: fv, fillAlpha: fa, strokeKind: sk, stroke: sv, strokeAlpha: sa,
                                   opacity: opacity, strokeSpec: spec, size: size, weight: weight, italic: italic,
                                   family: family, spacing: spacing, baseline: baseline, dx: dx, dy: dy, text: try textToken()))
        }
        return SvgText(part: part, x: x, y: y, anchor: anchor, matrix: matrix, runs: runs)
    }

    /// A URI-encoded text token (no spaces inside).
    private mutating func textToken() throws -> String {
        let start = i
        while i < n && s[i] != 32 { i += 1 }
        if i == start { try fail("expected text") }
        let raw = String(decoding: s[start..<i], as: UTF8.self)
        try separator()
        guard let t = raw.removingPercentEncoding else { try fail("bad text encoding", start) }
        return t
    }

    private mutating func strokeSpec() throws -> SvgStroke {
        // A negative width is a non-scaling stroke (vector-effect="non-scaling-stroke").
        let signed = try number()
        let cap = try int(0, 2, "cap")
        let join = try int(0, 2, "join")
        let miter = try number()
        let count = try int(0, n - i, "dash count")
        if count % 2 != 0 { try fail("dash count must be even") }
        var dashes: [CGFloat]?
        if count > 0 {
            var d: [CGFloat] = []
            for _ in 0..<count {
                let v = try number()
                if v < 0 { try fail("negative dash") }
                d.append(v)
            }
            if d.reduce(0, +) > 0 { dashes = d }  // all zero: solid, as SVG says
        }
        let offset = try number()
        return SvgStroke(width: abs(signed), cap: cap, join: join, miter: miter, dashes: dashes, dashOffset: offset,
                         nonScaling: signed < 0)
    }

    private mutating func matrix() throws -> CGAffineTransform? {
        if try int(0, 1, "matrix flag") == 0 { return nil }
        var m: [CGFloat] = []
        for _ in 0..<6 { m.append(try number()) }
        return CGAffineTransform(a: m[0], b: m[1], c: m[2], d: m[3], tx: m[4], ty: m[5])
    }

    /// SVG path data up to ";" (it may hold spaces; may be empty).
    private mutating func path() throws -> CGPath {
        if i >= n { try fail("expected path data") }
        let start = i
        guard let end = s[i...].firstIndex(of: 59) else { try fail("path data without its ;") }
        i = end + 1
        try endOfToken("expected a space after ;")
        return SvgPathParser.parse(String(decoding: s[start..<end], as: UTF8.self)).cgPath
    }

    /// "-" none, "c" currentColor, "#AARRGGBB", "@n" gradient n, "%n" pattern n.
    private mutating func paint() throws {
        if word("-") { paintKind = ZnSvgPaint.none; paintValue = 0 }
        else if word("c") { paintKind = ZnSvgPaint.current; paintValue = 0 }
        else if i < n && s[i] == 35 { paintKind = ZnSvgPaint.color; paintValue = try color() }
        else if i < n && s[i] == 64 {
            i += 1
            paintKind = ZnSvgPaint.gradient
            paintValue = UInt32(try int(0, gradients.count - 1, "gradient"))
        }
        else if i < n && s[i] == 37 {
            i += 1
            paintKind = ZnSvgPaint.pattern
            paintValue = UInt32(try int(0, patterns.count - 1, "pattern"))
        }
        else { try fail("expected a paint") }
    }

    /// "#AARRGGBB".
    private mutating func color() throws -> UInt32 {
        if i + 9 > n || s[i] != 35 { try fail("expected a colour #AARRGGBB") }
        var v: UInt32 = 0
        for k in 1...8 {
            let c = s[i + k]
            let h: UInt32
            switch c {
            case 48...57: h = UInt32(c - 48)
            case 65...70: h = UInt32(c - 55)
            case 97...102: h = UInt32(c - 87)
            default: try fail("bad colour")
            }
            v = v << 4 | h
        }
        i += 9
        try endOfToken("bad colour")
        return v
    }

    /// A decimal number: optional "-", digits, optional "." and digits. No exponent.
    private mutating func number() throws -> CGFloat {
        let start = i
        let neg = i < n && s[i] == 45
        if neg { i += 1 }
        var v = 0.0
        var digits = 0
        while i < n, s[i] >= 48, s[i] <= 57 { v = v * 10 + Double(s[i] - 48); digits += 1; i += 1 }
        if digits == 0 { try fail("bad number", start) }
        if i < n && s[i] == 46 {
            i += 1
            var scale = 1.0, fd = 0
            while i < n, s[i] >= 48, s[i] <= 57 {
                if fd < 15 { scale /= 10; v += Double(s[i] - 48) * scale }
                fd += 1
                i += 1
            }
            if fd == 0 { try fail("bad number", start) }
        }
        try endOfToken("bad number", start)
        return CGFloat(neg ? -v : v)
    }

    /// A whole number in min...max.
    private mutating func int(_ min: Int, _ max: Int, _ what: String) throws -> Int {
        let start = i
        let neg = i < n && s[i] == 45
        if neg { i += 1 }
        var v = 0, digits = 0
        while i < n, s[i] >= 48, s[i] <= 57 {
            v = v * 10 + Int(s[i] - 48)
            if v > Int(Int32.max) { try fail("\(what): number too big", start) }
            digits += 1
            i += 1
        }
        if digits == 0 { try fail("\(what): expected a whole number", start) }
        try endOfToken("\(what): expected a whole number", start)
        let r = neg ? -v : v
        if r < min || r > max { try fail("\(what) \(r) is out of range \(min)..\(max)", start) }
        return r
    }

    private mutating func word(_ c: Character) -> Bool {
        let b = c.asciiValue!
        if i >= n || s[i] != b || (i + 1 < n && s[i + 1] != 32) { return false }
        i += 1
        return (try? separator()) != nil
    }

    private mutating func word2(_ a: Character, _ b: Character) -> Bool {
        if i + 1 >= n || s[i] != a.asciiValue! || s[i + 1] != b.asciiValue! || (i + 2 < n && s[i + 2] != 32) { return false }
        i += 2
        return (try? separator()) != nil
    }

    private mutating func endOfToken(_ message: String, _ start: Int? = nil) throws {
        if i < n && s[i] != 32 { try fail(message, start ?? i) }
        try separator()
    }

    /// Moves past the one space after a token. More spaces, or a space at the end, are an error.
    private mutating func separator() throws {
        if i >= n { return }
        i += 1
        if i >= n || s[i] == 32 { try fail("extra space") }
    }

    private func fail(_ message: String, _ at: Int? = nil) throws -> Never {
        throw ZnSvgFormatError(description: "\(message) (at char \(at ?? i))")
    }
}
