// iOS's SVG filter graph (ZnSvgFilters.swift) on the Mac: tools/ios-unit-test.ts builds this with that file alone. The
// cases follow android/runtime's ZnSvgFilterGraph (ZnSvgEffects.kt): inputs, blur sigma, offsets, flood, colour
// matrices on unpremultiplied colour, composites with src = in and dst = in2, blends, merge order, the region's pixels
// and its caps. Pixels are probed in images whose first row is the top, as ZnSvgDraw.swift makes them.
import CoreGraphics
import Foundation

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

func near(_ name: String, _ got: Double, _ want: Double, _ tol: Double, line: Int = #line) {
    count += 1
    if !(abs(got - want) <= tol) {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want) ± \(tol)")
    }
}

func yes(_ name: String, _ ok: Bool, line: Int = #line) {
    count += 1
    if !ok {
        failures += 1
        print("FAIL \(name) (line \(line))")
    }
}

/// An image w × h drawn with y down (first row the top), as the filtered group is drawn.
func image(_ w: Int, _ h: Int, _ draw: (CGContext) -> Void) -> CGImage {
    let cg = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: ZnSvgFilterGraph.srgb,
                       bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    cg.translateBy(x: 0, y: CGFloat(h))
    cg.scaleBy(x: 1, y: -1)
    cg.setShouldAntialias(false)
    draw(cg)
    return cg.makeImage()!
}

func fill(_ cg: CGContext, _ r: CGRect, _ argb: UInt32) {
    cg.setFillColor(CGColor(srgbRed: CGFloat(argb >> 16 & 0xFF) / 255, green: CGFloat(argb >> 8 & 0xFF) / 255,
                            blue: CGFloat(argb & 0xFF) / 255, alpha: CGFloat(argb >> 24 & 0xFF) / 255))
    cg.fill(r)
}

/// Premultiplied RGBA bytes, first row the top.
struct Pixels {
    let w: Int, h: Int
    let p: [UInt8]
    init(_ i: CGImage) {
        w = i.width; h = i.height
        var b = [UInt8](repeating: 0, count: w * h * 4)
        let cg = CGContext(data: &b, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: ZnSvgFilterGraph.srgb,
                           bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        cg.draw(i, in: CGRect(x: 0, y: 0, width: w, height: h))
        p = b
    }
    func at(_ x: Int, _ y: Int) -> [Int] { (0..<4).map { Int(p[(y * w + x) * 4 + $0]) } }
    func a(_ x: Int, _ y: Int) -> Int { at(x, y)[3] }
    var totalAlpha: Int { stride(from: 3, to: p.count, by: 4).reduce(0) { $0 + Int(p[$1]) } }
}

func prim(_ k: Character, _ inputs: [Int] = [-1], _ values: [CGFloat] = [], mode: Int = 0, color: UInt32 = 0) -> SvgFilterPrim {
    SvgFilterPrim(kind: k, inputs: inputs, values: values, mode: mode, color: color)
}

func run(_ prims: [SvgFilterPrim], _ src: CGImage, px: CGFloat = 1) -> Pixels? {
    let f = SvgFilter(region: [0, 0, CGFloat(src.width), CGFloat(src.height)], prims: prims, shadows: [])
    return ZnSvgFilterGraph.run(f, source: src, px: px).map(Pixels.init)
}

let identity: [CGFloat] = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]
let gooey: [CGFloat] = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 18, -7]
// feColorMatrix type="saturate" values="0" (SVG's luminance weights).
let grey: [CGFloat] = [0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0.2126, 0.7152, 0.0722, 0, 0, 0, 0, 0, 1, 0]

// MARK: The region in pixels

check("area rounds out", ZnSvgFilterGraph.area([-2.4, 1.2, 10.1, 9], px: 3),
      ZnSvgFilterArea(left: -8, top: 3, w: 39, h: 24, px: 3))
check("area empty", ZnSvgFilterGraph.area([4, 4, 4, 10], px: 3)?.w, 0)
check("area no scale", ZnSvgFilterGraph.area([0, 0, 10, 10], px: 0), nil)
check("area 5000 px a side falls back", ZnSvgFilterGraph.area([0, 0, 2500, 10], px: 2), nil)
check("area 4096 px a side is kept", ZnSvgFilterGraph.area([0, 0, 2048, 100], px: 2)?.w, 4096)
if let big = ZnSvgFilterGraph.area([0, 0, 1500, 1500], px: 2) {
    yes("area over 4M px is cut down", big.w * big.h <= ZnSvgFilterGraph.maxPixels)
    yes("area over 4M px keeps most of it", big.w * big.h > ZnSvgFilterGraph.maxPixels * 99 / 100)
    near("area cut down: same place", Double(big.rect.width), 1500, 1)
} else { yes("area over 4M px", false) }
near("android sigma keeps a big one", Double(ZnSvgFilterGraph.androidSigma(3)), 3, 1e-4)
near("android sigma: at least half a pixel", Double(ZnSvgFilterGraph.androidSigma(0.1)), 0.5058, 1e-3)

// MARK: Sources

let dot = image(20, 20) { fill($0, CGRect(x: 5, y: 4, width: 1, height: 1), 0xFFFF0000) }

// SourceGraphic through: the same pixels, the right way up.
if let o = run([prim("M", [-1])], dot) {
    check("source kept", o.at(5, 4), [255, 0, 0, 255])
    check("source not flipped", o.a(5, 15), 0)
}
// SourceAlpha: black with the alpha.
let halfRed = image(4, 4) { fill($0, CGRect(x: 0, y: 0, width: 4, height: 4), 0x80FF0000) }
if let o = run([prim("M", [-2])], halfRed) {
    let p = o.at(1, 1)
    check("SourceAlpha black", [p[0], p[1], p[2]], [0, 0, 0])
    near("SourceAlpha alpha", Double(p[3]), 128, 1)
}

// MARK: Offset

// dx 3 dy 2 at 2 px a unit: 6 right, 4 down.
if let o = run([prim("o", [-1], [3, 2])], dot, px: 2) {
    check("offset moves", o.a(11, 8), 255)
    check("offset leaves", o.a(5, 4), 0)
}

// MARK: Blur

let line = image(41, 9) { fill($0, CGRect(x: 20, y: 0, width: 1, height: 9), 0xFF000000) }
func spread(_ o: Pixels, row: Int) -> (total: Double, sigma: Double) {
    var t = 0.0, m2 = 0.0
    for x in 0..<o.w { let a = Double(o.a(x, row)); t += a; m2 += a * Double((x - 20) * (x - 20)) }
    return (t, (m2 / max(t, 1)).squareRoot())
}
if let o = run([prim("b", [-1], [2, 2])], line) {
    let s = spread(o, row: 4)
    near("blur keeps the alpha", s.total, 255, 12)
    near("blur sigma is stdDeviation × px", s.sigma, 2, 0.25)
    yes("blur reaches about 6 px", o.a(26, 4) > 0 && o.a(31, 4) == 0)
}
if let o = run([prim("b", [-1], [1.5, 1.5])], line, px: 2) {
    near("blur sigma at 2 px a unit", spread(o, row: 4).sigma, 3, 0.3)
}
// One side only (stdDeviation="4 0"): soft across, sharp down (Android's half pixel down).
let square = image(40, 40) { fill($0, CGRect(x: 16, y: 10, width: 8, height: 8), 0xFF0000FF) }
if let o = run([prim("b", [-1], [4, 0])], square) {
    yes("directional blur spreads across", o.a(12, 14) > 20 && o.a(27, 14) > 20)
    yes("directional blur stays sharp down", o.a(20, 7) == 0 && o.a(20, 21) == 0)
    yes("directional blur keeps its place", o.a(20, 10) > 150 && o.a(20, 17) > 150 && o.a(20, 9) < 40 && o.a(20, 18) < 40)
}
// Down only, past the kernel's 8 px (box passes).
let tall = image(40, 120) { fill($0, CGRect(x: 16, y: 56, width: 8, height: 8), 0xFF0000FF) }
if let o = run([prim("b", [-1], [0, 12])], tall) {
    yes("big directional blur spreads down", o.a(20, 40) > 0 && o.a(20, 80) > 0 && o.a(20, 40) == o.a(20, 79))
    yes("big directional blur stays sharp across", o.a(14, 60) == 0 && o.a(25, 60) == 0)
    near("big directional blur keeps the alpha", Double(o.totalAlpha), 64 * 255, 64 * 255 * 0.05)
}
// Different sides, both blurred.
if let o = run([prim("b", [-1], [1, 3])], square) {
    yes("uneven blur: more down than across", o.a(20, 7) > o.a(13, 14))
}
// 0 0: no blur.
if let o = run([prim("b", [-1], [0, 0])], dot) { check("blur 0 0 is the input", o.at(5, 4), [255, 0, 0, 255]) }

// MARK: Flood

if let o = run([prim("f", [], color: 0x59FF0000)], dot) {
    let p = o.at(10, 10)
    near("flood alpha 35%", Double(p[3]), 89, 1)
    near("flood colour premultiplied once", Double(p[0]), 89, 1)
    check("flood fills the region", o.a(0, 19), 89)
}

// MARK: Colour matrix

let red = image(4, 4) { fill($0, CGRect(x: 0, y: 0, width: 4, height: 4), 0xFFFF0000) }
if let o = run([prim("m", [-1], grey)], red) {
    let p = o.at(1, 1)
    yes("greyscale r = g = b", p[0] == p[1] && p[1] == p[2])
    near("greyscale red's grey", Double(p[0]), 54, 2)
}
if let o = run([prim("m", [-1], identity)], halfRed) {
    near("identity matrix keeps half red", Double(o.at(1, 1)[0]), 128, 1)
}
// The gooey alpha matrix on half-transparent red: alpha 18 × 0.5 − 7 = 2, kept at 1; red stays red (unpremultiplied).
if let o = run([prim("m", [-1], gooey)], halfRed) { check("gooey matrix: half red becomes red", o.at(1, 1), [255, 0, 0, 255]) }
let faint = image(4, 4) { fill($0, CGRect(x: 0, y: 0, width: 4, height: 4), 0x1A00FF00) }
if let o = run([prim("m", [-1], gooey)], faint) { check("gooey matrix: faint becomes clear", o.a(1, 1), 0) }
// Two dots close together, blurred then through the gooey matrix: they join.
let pair = image(30, 12) { cg in
    cg.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
    cg.fillEllipse(in: CGRect(x: 4, y: 2, width: 8, height: 8))
    cg.fillEllipse(in: CGRect(x: 15, y: 2, width: 8, height: 8))
}
if let o = run([prim("b", [-1], [2, 2]), prim("m", [0], gooey), prim("B", [-1, 1], mode: 0)], pair) {
    yes("gooey dots join", o.a(13, 6) > 40 && o.a(14, 6) > 200)
    check("gooey keeps the dots", o.a(8, 6), 255)
    check("gooey leaves the corners", o.a(0, 0), 0)
}

// MARK: Composite (src = in, dst = in2)

let left = image(10, 4) { fill($0, CGRect(x: 0, y: 0, width: 6, height: 4), 0xFFFF0000) }   // red x 0…5
// A filter over the left image that first makes blue at x 4…9 from it, then puts the two together.
func both(_ last: SvgFilterPrim) -> Pixels? {
    let f = SvgFilter(region: [0, 0, 10, 4], prims: [
        prim("o", [-1], [4, 0]),                 // 0: red moved to x 4…9 (the right half's place)
        prim("f", [], color: 0xFF0000FF),        // 1: blue everywhere
        prim("c", [1, 0], mode: 1),              // 2: blue in 0 = blue at x 4…9
        last,                                     // 3: in = -1 (red at 0…5), in2 = 2 (blue at 4…9)
    ], shadows: [])
    return ZnSvgFilterGraph.run(f, source: left, px: 1).map(Pixels.init)
}
if let o = both(prim("c", [-1, 2], mode: 1)) {
    check("in: red only where blue is", o.at(4, 1), [255, 0, 0, 255])
    check("in: nothing where blue isn't", o.a(1, 1), 0)
    check("in: blue doesn't show", o.a(8, 1), 0)
}
if let o = both(prim("c", [-1, 2], mode: 4)) {
    check("xor clears the overlap", o.a(4, 1), 0)
    check("xor keeps red", o.at(1, 1), [255, 0, 0, 255])
    check("xor keeps blue", o.at(8, 1), [0, 0, 255, 255])
}
if let o = both(prim("c", [-1, 2], mode: 6)) {
    check("op 6: in2 minus in, overlap gone", o.a(4, 1), 0)
    check("op 6: blue left", o.at(8, 1), [0, 0, 255, 255])
    check("op 6: no red", o.a(1, 1), 0)
}
if let o = both(prim("c", [-1, 2], mode: 2)) {
    check("out: red where blue isn't", o.at(1, 1), [255, 0, 0, 255])
    check("out: none where blue is", o.a(4, 1), 0)
}
if let o = both(prim("c", [-1, 2], mode: 3)) {
    check("atop: red over blue", o.at(4, 1), [255, 0, 0, 255])
    check("atop: blue stays", o.at(8, 1), [0, 0, 255, 255])
    check("atop: no red outside blue", o.a(1, 1), 0)
}
if let o = both(prim("c", [-1, 2], mode: 5)) {
    check("plus adds", o.at(4, 1), [255, 0, 255, 255])
}
if let o = both(prim("c", [-1, 2], mode: 0)) {
    check("over: red on top", o.at(4, 1), [255, 0, 0, 255])
}

// MARK: Blend (src = in, dst = in2) and merge

if let o = both(prim("B", [-1, 2], mode: 1)) {
    check("multiply red × blue = black", o.at(4, 1), [0, 0, 0, 255])
    check("multiply keeps red outside", o.at(1, 1), [255, 0, 0, 255])
}
if let o = both(prim("B", [-1, 2], mode: 2)) { check("screen red, blue = magenta", o.at(4, 1), [255, 0, 255, 255]) }
if let o = both(prim("B", [-1, 2], mode: 5)) { check("lighten", o.at(4, 1), [255, 0, 255, 255]) }
if let o = both(prim("B", [-1, 2], mode: 4)) { check("darken", o.at(4, 1), [0, 0, 0, 255]) }
// Multiply with half-transparent red over white: W3C's cs·(1−ab) + cb·(1−as) + as·ab·B = (255, 128, 128).
let white = image(4, 4) { fill($0, CGRect(x: 0, y: 0, width: 4, height: 4), 0xFFFFFFFF) }
if let o = ZnSvgFilterGraph.run(SvgFilter(region: [0, 0, 4, 4], prims: [
    prim("f", [], color: 0x80FF0000), prim("B", [0, -1], mode: 1),
], shadows: []), source: white, px: 1).map(Pixels.init) {
    let p = o.at(1, 1)
    near("multiply half red on white: red", Double(p[0]), 255, 1)
    near("multiply half red on white: green", Double(p[1]), 127, 2)
    check("multiply half red on white: opaque", p[3], 255)
}
// Merge: the last input on top.
if let o = both(prim("M", [2, -1])) { check("merge: last on top", o.at(4, 1), [255, 0, 0, 255]) }
if let o = both(prim("M", [-1, 2])) { check("merge: last on top (blue)", o.at(4, 1), [0, 0, 255, 255]) }
// Non-linear maths, as Android: half-transparent white merged over black is 128 (linear light would give 188).
let black = image(4, 4) { fill($0, CGRect(x: 0, y: 0, width: 4, height: 4), 0xFF000000) }
if let o = ZnSvgFilterGraph.run(SvgFilter(region: [0, 0, 4, 4], prims: [
    prim("f", [], color: 0x80FFFFFF), prim("M", [-1, 0]),
], shadows: []), source: black, px: 1).map(Pixels.init) {
    near("sRGB maths, not linear", Double(o.at(1, 1)[0]), 128, 2)
}

// MARK: A drop shadow as the compiler writes feDropShadow

// alpha → blur → offset → flood → in → merge [shadow, source]: a square's shadow below it.
let card = image(40, 40) { fill($0, CGRect(x: 10, y: 8, width: 16, height: 12), 0xFFFFFFFF) }
if let o = run([prim("b", [-2], [1, 1]), prim("o", [0], [0, 6]), prim("f", [], color: 0x800F172A),
                prim("c", [2, 1], mode: 1), prim("M", [3, -1])], card) {
    check("shadow: card on top", o.at(18, 12), [255, 255, 255, 255])
    near("shadow below the card", Double(o.a(18, 23)), 128, 4)
    check("shadow not above", o.a(18, 5), 0)
}

// MARK: Bad graphs: nil, so the caller falls back

check("bad input", run([prim("o", [3], [1, 1])], dot) == nil, true)
check("bad composite", run([prim("c", [-1, -1], mode: 9)], dot) == nil, true)
check("no primitives", ZnSvgFilterGraph.run(SvgFilter(region: [0, 0, 1, 1], prims: [], shadows: []), source: dot, px: 1) == nil, true)

// MARK: Time (a 48 pt gooey loader at 3×: about 160 × 160 px)

let big = image(160, 160) { cg in
    cg.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
    cg.fillEllipse(in: CGRect(x: 10, y: 50, width: 60, height: 60))
    cg.fillEllipse(in: CGRect(x: 80, y: 50, width: 60, height: 60))
}
let gooeyFilter = SvgFilter(region: [0, 0, 160, 160], prims: [prim("b", [-1], [3, 3]), prim("m", [0], gooey), prim("B", [-1, 1])], shadows: [])
_ = ZnSvgFilterGraph.run(gooeyFilter, source: big, px: 1)
let t0 = Date()
for _ in 0..<50 { _ = ZnSvgFilterGraph.run(gooeyFilter, source: big, px: 1) }
let ms = Date().timeIntervalSince(t0) * 1000 / 50
print("gooey 160 × 160 px on this Mac: \(String(format: "%.2f", ms)) ms a run")
yes("gooey runs within 20 ms on the Mac", ms < 20)

print(failures == 0 ? "ios svg filters: \(count) checks passed" : "ios svg filters: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
