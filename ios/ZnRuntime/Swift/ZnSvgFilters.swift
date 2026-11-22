// SVG filters on iOS (registry 13, docs/svg.md §17): a filter's primitives run on the region's pixels, a port of
// android/runtime's ZnSvgFilterGraph (ZnSvgEffects.kt). ZnSvgDraw.swift draws the filtered group into an image the size
// of the filter's region at the screen's resolution, runs it through here and draws what comes out in its place.
//
// Each result is an 8-bit premultiplied sRGB image of the region. Blurs and colour matrices are Accelerate's (vImage);
// offsets, floods, composites, blends and merges are Core Graphics drawing with its blend modes (the PDF / W3C
// formulas, as Skia's). Not Core Image: on the simulator it took 10 to 30 ms for a 48 pt loader (under 1 ms on a Mac),
// and these are native code that is as fast in a debug build.
//
// As on Android, the maths is on the stored (non-linear) sRGB values, not SVG's default linearRGB: Android's
// RenderEffect works that way, and the two phones should look the same. Blurs have transparent edges (Android's DECAL).
// CoreGraphics and Accelerate only, so the Mac unit suite (ios/tests/svg) builds it.
import Accelerate
import CoreGraphics
import Foundation

/// A filter: region x0 y0 x1 y1 (viewBox), its primitives, and the plain drop shadows the compiler found in it
/// (dx dy std, colour; bottom first), drawn instead where the filter can't run (a pattern tile, a region too big).
struct SvgFilter {
    let region: [CGFloat]
    let prims: [SvgFilterPrim]
    let shadows: [(dx: CGFloat, dy: CGFloat, std: CGFloat, color: UInt32)]
}

/// One primitive. kind: "b" blur (values: std x, y), "o" offset (dx, dy), "f" flood (color), "m" colour matrix
/// (20 values, SVG's order, offsets 0–1), "c" composite (mode: over, in, out, atop, xor, 5 plus, 6 in2 minus in),
/// "B" blend (mode 0–15), "M" merge. inputs: -1 SourceGraphic, -2 SourceAlpha, else an earlier primitive's result.
struct SvgFilterPrim {
    let kind: Character
    let inputs: [Int]
    let values: [CGFloat]
    let mode: Int
    let color: UInt32
}

/// Where a filter's region lands in pixels: the image is w × h, its top left at (left, top) pixels, at px pixels per
/// unit of the group's space (lower than asked when the region would be too many pixels).
struct ZnSvgFilterArea: Equatable {
    let left: CGFloat, top: CGFloat
    let w: Int, h: Int
    let px: CGFloat

    /// The image's place in the group's space.
    var rect: CGRect { CGRect(x: left / px, y: top / px, width: CGFloat(w) / px, height: CGFloat(h) / px) }
}

enum ZnSvgFilterGraph {
    /// A region bigger than this (pixels per side) isn't filtered: the plain drop shadows instead (Android's
    /// MAX_NODE_PX).
    static let maxSide = 4096
    /// A region of more pixels than this is filtered at a lower resolution, so one image is never over 16 MB (Android
    /// keeps its node on the GPU; here every result is a bitmap).
    static let maxPixels = 4_000_000

    static let srgb = CGColorSpace(name: CGColorSpace.sRGB)!

    /// Pixels per unit of the group's space for a context whose user-to-device transform is [ctm] (the screen's scale,
    /// the SVG's, parts' scales; a turn, skew or mirror doesn't change it).
    static func scale(_ ctm: CGAffineTransform) -> CGFloat { sqrt(abs(ctm.a * ctm.d - ctm.b * ctm.c)) }

    /// The region [r] for a context whose user-to-device transform is [ctm]. With no turn or skew, its pixels sit on
    /// the device's own, so what comes out is drawn back without being resampled (a drop-shadow icon is as sharp as
    /// one drawn straight); otherwise as Android rounds it.
    static func area(_ r: [CGFloat], ctm: CGAffineTransform) -> ZnSvgFilterArea? {
        let px = scale(ctm)
        var shift = CGPoint.zero
        if ctm.b == 0, ctm.c == 0, abs(abs(ctm.a) - px) < px * 1e-6, ctm.tx.isFinite, ctm.ty.isFinite {
            // A pixel's edge u (pixels from the group's origin, u = x · px) is on the device's where u + shift is whole.
            func frac(_ v: CGFloat) -> CGFloat { v - floor(v) }
            shift = CGPoint(x: frac(ctm.a < 0 ? -ctm.tx : ctm.tx), y: frac(ctm.d < 0 ? -ctm.ty : ctm.ty))
        }
        return area(r, px: px, shift: shift)
    }

    /// The region [r] (x0 y0 x1 y1) at [px] pixels per unit, as Android rounds it (left and top down, right and
    /// bottom up), on a grid moved by [shift] pixels. w == 0: nothing shows. nil: too big a side, or no scale (the
    /// caller falls back).
    static func area(_ r: [CGFloat], px: CGFloat, shift: CGPoint = .zero) -> ZnSvgFilterArea? {
        guard r.count == 4, px > 0, px.isFinite, r.allSatisfy(\.isFinite) else { return nil }
        func make(_ s: CGFloat, _ o: CGPoint) -> (CGFloat, CGFloat, CGFloat, CGFloat) {
            let left = floor(r[0] * s + o.x), top = floor(r[1] * s + o.y)
            return (left - o.x, top - o.y, ceil(r[2] * s + o.x) - left, ceil(r[3] * s + o.y) - top)
        }
        var s = px
        var (left, top, w, h) = make(s, shift)
        if w <= 0 || h <= 0 { return ZnSvgFilterArea(left: 0, top: 0, w: 0, h: 0, px: px) }
        if w > CGFloat(maxSide) || h > CGFloat(maxSide) { return nil }
        if w * h > CGFloat(maxPixels) {
            // Resampled anyway: no grid to keep to.
            s *= sqrt(CGFloat(maxPixels) / (w * h)) * 0.999
            (left, top, w, h) = make(s, .zero)
            if w <= 0 || h <= 0 { return ZnSvgFilterArea(left: 0, top: 0, w: 0, h: 0, px: s) }
        }
        return ZnSvgFilterArea(left: left, top: top, w: Int(w), h: Int(h), px: s)
    }

    /// [draw] (the group, in its own y-down space) drawn into an image of [area] and run through [f]: what comes out,
    /// its first row the region's top, or nil when it can't be made (nothing is drawn anywhere else then).
    static func filtered(_ f: SvgFilter, _ area: ZnSvgFilterArea, draw: (CGContext) -> Void) -> CGImage? {
        guard area.w > 0, area.h > 0,
              let off = CGContext(data: nil, width: area.w, height: area.h, bitsPerComponent: 8, bytesPerRow: area.w * 4,
                                  space: srgb, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // y down as the view's context (UIKit text draws the right way up), the region's top left at the corner.
        off.translateBy(x: 0, y: CGFloat(area.h))
        off.scaleBy(x: 1, y: -1)
        off.scaleBy(x: area.px, y: area.px)
        off.translateBy(x: -area.left / area.px, y: -area.top / area.px)
        draw(off)
        guard let src = off.makeImage() else { return nil }
        let g0 = ZnSvgFilterTiming.on ? CFAbsoluteTimeGetCurrent() : 0
        let out = run(f, source: src, px: area.px)
        if ZnSvgFilterTiming.on { ZnSvgFilterTiming.graph += CFAbsoluteTimeGetCurrent() - g0 }
        return out
    }

    /// [image] (from filtered) drawn into [cg] in its place in the group's (y-down) space: flipped back, so its first
    /// row is the region's top. The group's transforms (a turn, skew, mirror) carry it.
    static func drawBack(_ cg: CGContext, _ image: CGImage, _ area: ZnSvgFilterArea) {
        let rect = area.rect
        cg.saveGState()
        cg.translateBy(x: 0, y: rect.minY + rect.maxY)
        cg.scaleBy(x: 1, y: -1)
        cg.draw(image, in: rect)
        cg.restoreGState()
    }

    /// The blur Android gives standard deviation [sigma] (pixels): it asks for a radius, whose sigma is
    /// 0.57735 r + 0.5 and whose radius is at least 0.01, so a blur is never under about half a pixel.
    static func androidSigma(_ sigma: CGFloat) -> CGFloat {
        let r = max((sigma - 0.5) / 0.57735, 0.01)
        return 0.57735 * r + 0.5
    }

    /// An empty w × h image to draw a result into: premultiplied RGBA, sRGB, y up (Core Graphics' own), so its first
    /// row is the top.
    static func canvas(_ w: Int, _ h: Int) -> CGContext? {
        guard let cg = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: srgb,
                                 bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        cg.clear(CGRect(x: 0, y: 0, width: w, height: h))
        cg.interpolationQuality = .none
        return cg
    }

    /// Filter [f] over [source] (the group drawn over the region: w × h pixels, its first row the top), at [px]
    /// pixels per unit of the group's space. The result is the same size and way up; nil when it can't be made.
    static func run(_ f: SvgFilter, source: CGImage, px: CGFloat) -> CGImage? {
        let n = f.prims.count
        let w = source.width, h = source.height
        guard n > 0, w > 0, h > 0 else { return nil }
        let full = CGRect(x: 0, y: 0, width: w, height: h)
        // Each result is let go after the last primitive that reads it, so a long graph holds only a few images.
        var lastRead = [Int](repeating: -1, count: n)
        for (k, p) in f.prims.enumerated() { for i in p.inputs where i >= 0 && i < k { lastRead[i] = k } }
        var results = [CGImage?](repeating: nil, count: n)
        var alphaImage: CGImage?
        func input(_ i: Int) -> CGImage? {
            if i == -1 { return source }
            if i == -2 {
                if alphaImage == nil { alphaImage = sourceAlpha(source, full) }
                return alphaImage
            }
            return i >= 0 && i < n ? results[i] : nil
        }
        for (k, p) in f.prims.enumerated() {
            let out: CGImage?
            switch p.kind {
            case "b":
                guard let i = input(p.inputs.first ?? -1), p.values.count >= 2 else { return nil }
                out = blurred(i, sx: max(p.values[0], 0) * px, sy: max(p.values[1], 0) * px)
            case "o":
                guard let i = input(p.inputs.first ?? -1), p.values.count >= 2, let cg = canvas(w, h) else { return nil }
                // SVG's y runs down; this canvas's runs up.
                cg.interpolationQuality = .low
                cg.draw(i, in: full.offsetBy(dx: p.values[0] * px, dy: -p.values[1] * px))
                out = cg.makeImage()
            case "f":
                guard let cg = canvas(w, h) else { return nil }
                cg.setFillColor(color(p.color))
                cg.fill(full)
                out = cg.makeImage()
            case "m":
                guard let i = input(p.inputs.first ?? -1), p.values.count == 20 else { return nil }
                out = matrix(i, p.values)
            case "c", "B":
                let modes = p.kind == "c" ? composites : blends
                guard p.inputs.count == 2, p.mode >= 0, p.mode < modes.count, let a = input(p.inputs[0]),
                      let b = input(p.inputs[1]), let cg = canvas(w, h) else { return nil }
                // in2 underneath, then in with the mode (Android: dst = in2, src = in).
                cg.draw(b, in: full)
                cg.setBlendMode(modes[p.mode])
                cg.draw(a, in: full)
                out = cg.makeImage()
            case "M":
                guard let cg = canvas(w, h) else { return nil }
                for j in p.inputs {
                    guard let i = input(j) else { return nil }
                    cg.draw(i, in: full)
                }
                out = cg.makeImage()
            default:
                out = source
            }
            guard let out else { return nil }
            results[k] = out
            for j in p.inputs where j >= 0 && j < k && lastRead[j] == k { results[j] = nil }
        }
        return results[n - 1]
    }

    // MARK: Primitives

    /// feComposite operators (src = in over dst = in2): over, in, out, atop, xor, plus (clamped at 1, as Android's
    /// PLUS), and 6, in2 minus in (Figma's inner shadow).
    private static let composites: [CGBlendMode] = [.normal, .sourceIn, .sourceOut, .sourceAtop, .xor, .plusLighter,
                                                    .destinationOut]
    private static let blends: [CGBlendMode] = [.normal, .multiply, .screen, .overlay, .darken, .lighten, .colorDodge,
                                                .colorBurn, .hardLight, .softLight, .difference, .exclusion, .hue,
                                                .saturation, .color, .luminosity]

    private static func color(_ argb: UInt32) -> CGColor {
        CGColor(srgbRed: CGFloat(argb >> 16 & 0xFF) / 255, green: CGFloat(argb >> 8 & 0xFF) / 255,
                blue: CGFloat(argb & 0xFF) / 255, alpha: CGFloat(argb >> 24 & 0xFF) / 255)
    }

    /// SourceAlpha: black with the source's alpha.
    private static func sourceAlpha(_ source: CGImage, _ full: CGRect) -> CGImage? {
        guard let cg = canvas(source.width, source.height) else { return nil }
        cg.draw(source, in: full)
        cg.setBlendMode(.sourceIn)
        cg.setFillColor(CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 1))
        cg.fill(full)
        return cg.makeImage()
    }

    /// feColorMatrix on unpremultiplied colour, as SVG and Android's ColorMatrixColorFilter, each value kept within
    /// 0…1 (the gooey matrix's alpha "18 −7" goes far past 1).
    private static func matrix(_ i: CGImage, _ v: [CGFloat]) -> CGImage? {
        let w = i.width, h = i.height
        guard let cg = canvas(w, h), let data = cg.data else { return nil }
        cg.draw(i, in: CGRect(x: 0, y: 0, width: w, height: h))
        var scratch = [UInt8](repeating: 0, count: w * h * 4)
        // vImage's matrix: out[c] = (Σ in[r] · m[r · 4 + c] + bias[c]) / divisor, in whole numbers. The divisor is
        // as big as the biggest value allows (4096 at most), for the finest steps.
        let coef = (0..<4).flatMap { r in (0..<4).map { c in v[c * 5 + r] } }
        let biggest = max(coef.map(abs).max() ?? 0, 1e-6)
        var divisor: Int32 = 4096
        while divisor > 1 && biggest * CGFloat(divisor) > 32767 { divisor /= 2 }
        // The compiler doesn't bound the values (saturate(50000), a 40000 in a matrix, an offset of 5000). Ones that
        // don't fit vImage's 16-bit coefficients, or an offset past 2^29 (vImage sums 4 × 255 × 32767 plus it in 32
        // bits), take the slow way in floating point, as Android's float matrix: exact, never a crash.
        let fits = v.allSatisfy(\.isFinite) && biggest * CGFloat(divisor) <= 32767
            && (0..<4).allSatisfy { abs(v[$0 * 5 + 4] * 255 * CGFloat(divisor)) <= 536_870_912 }
        return scratch.withUnsafeMutableBytes { s -> CGImage? in
            var a = vImage_Buffer(data: data, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 4)
            var b = vImage_Buffer(data: s.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: w * 4)
            let flags = vImage_Flags(kvImageNoFlags)
            guard vImageUnpremultiplyData_RGBA8888(&a, &a, flags) == kvImageNoError else { return nil }
            if fits {
                let m = coef.map { Int16(($0 * CGFloat(divisor)).rounded()) }
                let bias = (0..<4).map { c in Int32((v[c * 5 + 4] * 255 * CGFloat(divisor)).rounded()) }
                guard vImageMatrixMultiply_ARGB8888(&a, &b, m, divisor, nil, bias, flags) == kvImageNoError else { return nil }
            } else {
                // Not a number counts as 0, an infinity as a billion.
                let f = v.map { $0.isNaN ? 0 : Double(min(max($0, -1e9), 1e9)) }
                let from = data.assumingMemoryBound(to: UInt8.self), to = s.baseAddress!.assumingMemoryBound(to: UInt8.self)
                for k in stride(from: 0, to: w * h * 4, by: 4) {
                    let x = (0..<4).map { Double(from[k + $0]) / 255 }
                    for c in 0..<4 {
                        let o = f[c * 5] * x[0] + f[c * 5 + 1] * x[1] + f[c * 5 + 2] * x[2] + f[c * 5 + 3] * x[3] + f[c * 5 + 4]
                        to[k + c] = UInt8(min(max(o, 0), 1) * 255 + 0.5)
                    }
                }
            }
            guard vImagePremultiplyData_RGBA8888(&b, &a, flags) == kvImageNoError else { return nil }
            return cg.makeImage()
        }
    }

    /// feGaussianBlur in pixels. Both 0: the input as it is. Otherwise each side is at least Android's half pixel.
    private static func blurred(_ i: CGImage, sx: CGFloat, sy: CGFloat) -> CGImage? {
        if sx <= 0 && sy <= 0 { return i }
        guard let cg = canvas(i.width, i.height) else { return nil }
        cg.draw(i, in: CGRect(x: 0, y: 0, width: i.width, height: i.height))
        guard blur(cg, sx: androidSigma(sx), sy: androidSigma(sy)) else { return nil }
        return cg.makeImage()
    }

    /// Blurs [cg]'s pixels (8 bits a channel, 4 channels, premultiplied) in place by [sx] across and [sy] down, with
    /// transparent edges. A side under 2 px: a Gaussian kernel; from 2 px: three box passes of about the same spread
    /// (as SVG's own recipe). Also for the Canvas's blurred gradients. False when vImage fails.
    /// [sx] and [sy] are the standard deviations in pixels as they are (feGaussianBlur adds Android's half-pixel
    /// minimum first, androidSigma). It writes cg.data directly: blur before cg.makeImage(), as an image made earlier
    /// may share those bytes and change with them.
    static func blur(_ cg: CGContext, sx: CGFloat, sy: CGFloat) -> Bool {
        guard let data = cg.data, cg.bitsPerPixel == 32, cg.bitsPerComponent == 8 else { return false }
        let w = cg.width, h = cg.height, rowBytes = cg.bytesPerRow
        var scratch = [UInt8](repeating: 0, count: rowBytes * h)
        return scratch.withUnsafeMutableBytes { s -> Bool in
            let bufs = [vImage_Buffer(data: data, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: rowBytes),
                        vImage_Buffer(data: s.baseAddress, height: vImagePixelCount(h), width: vImagePixelCount(w), rowBytes: rowBytes)]
            var at = 0  // the buffer holding the pixels now
            var clear: [UInt8] = [0, 0, 0, 0]
            let flags = vImage_Flags(kvImageBackgroundColorFill)
            for (sigma, across) in [(sx, true), (sy, false)] where sigma > 0 {
                func pass(_ make: (inout vImage_Buffer, inout vImage_Buffer) -> vImage_Error) -> Bool {
                    var from = bufs[at], to = bufs[1 - at]
                    guard make(&from, &to) == kvImageNoError else { return false }
                    at = 1 - at
                    return true
                }
                if sigma < 2 {
                    let half = max(1, Int(ceil(sigma * 3)))
                    let weights = (-half...half).map { k in Int16((exp(-CGFloat(k * k) / (2 * sigma * sigma)) * 4096).rounded()) }
                    let sum = weights.reduce(Int32(0)) { $0 + Int32($1) }
                    let n = UInt32(weights.count)
                    guard pass({ vImageConvolve_ARGB8888(&$0, &$1, nil, 0, 0, weights, across ? 1 : n, across ? n : 1, sum, &clear, flags) })
                    else { return false }
                } else {
                    for d in boxes(sigma) {
                        let k = UInt32(d)
                        guard pass({ vImageBoxConvolve_ARGB8888(&$0, &$1, nil, 0, 0, across ? 1 : k, across ? k : 1, &clear, flags) })
                        else { return false }
                    }
                }
            }
            if at == 1 { memcpy(data, s.baseAddress!, rowBytes * h) }
            return true
        }
    }

    /// Three odd box widths whose passes together spread as a Gaussian of [sigma] (Kutskir's "boxes for Gauss").
    static func boxes(_ sigma: CGFloat) -> [Int] {
        let ideal = (12 * sigma * sigma / 3 + 1).squareRoot()
        var lo = Int(ideal.rounded(.down))
        if lo % 2 == 0 { lo -= 1 }
        lo = max(lo, 1)
        let l = CGFloat(lo)
        let small = Int(((12 * sigma * sigma - 3 * l * l - 12 * l - 9) / (-4 * l - 4)).rounded())
        return (0..<3).map { $0 < small ? lo : lo + 2 }
    }
}

/// How long filtered groups take to draw (the group into its image, the graph, the image back), printed every 120
/// draws when the app runs with ZN_SVG_FILTER_TIMING=1 (main thread only).
enum ZnSvgFilterTiming {
    static let on = ProcessInfo.processInfo.environment["ZN_SVG_FILTER_TIMING"] == "1"
    nonisolated(unsafe) private static var runs = 0
    nonisolated(unsafe) private static var total: Double = 0
    nonisolated(unsafe) private static var worst: Double = 0
    nonisolated(unsafe) private static var pixels = 0
    /// Of the total, the time in the graph.
    nonisolated(unsafe) static var graph: Double = 0

    static func add(_ seconds: Double, _ a: ZnSvgFilterArea) {
        runs += 1
        total += seconds
        worst = max(worst, seconds)
        pixels = max(pixels, a.w * a.h)
        guard runs == 120 else { return }
        print(String(format: "zn: svg filters: 120 draws, %.2f ms each on average (%.2f ms in the graph), %.2f ms the slowest, up to %d px",
                     total / 120 * 1000, graph / 120 * 1000, worst * 1000, pixels))
        runs = 0; total = 0; worst = 0; pixels = 0; graph = 0
    }
}
