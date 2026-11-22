// Draws a parsed <Canvas> command list (ZnCanvasParse.swift) into a Core Graphics context, as android/runtime's
// ZnCanvas.kt drawCanvasOps / drawFx and ZnCanvasImage.kt drawCanvasImage. CoreGraphics, CoreText and ImageIO only (no
// UIKit view code), so the Mac tests (ios/tests/draw) draw the same lists into a bitmap and check pixels.
// - The context is y-down (UIKit's). Everything runs inside one save: a transform, a clip or a save left open by the
//   list never moves what is drawn after this canvas.
// - A list with a blend mode draws into its own transparency layer (Android's saveLayer): "clear" clears what this
//   canvas drew, not the screen behind it.
// - Shadows and blur: Core Graphics shadows are in base space (unaffected by the CTM), so the offset and blur are
//   moved through the canvas's transforms first, as Skia's shadow layer is in local space. A blur on a solid colour
//   is the shape's own shadow with the shape drawn out of sight (Android's BlurMaskFilter NORMAL). Blur radius r is
//   Skia's: sigma = 0.57735·r + 0.5 px, and a CG shadow blur of 2·sigma looks the same (as the Svg shadows).
//   A blur on a gradient (linear, radial, sweep) paints the shape into pixels of its own, blurs them with the Svg
//   filters' vImage blur (ZnSvgFilters.swift) and draws them back: the same sigma, in device pixels.
// - Numbers and colours that follow motion values are read here, on each draw (ZnCanvasParse.swift ZnCanvasNum).
import CoreGraphics
import CoreText
import Foundation
import ImageIO
#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// Draws [c] into [cg], whose user space is the canvas's own (points, y down, [size]). [base] is base space (where CG
/// shadows are) to device: nil for a UIKit view's context (base space is its user space at the start), identity for a
/// bitmap context.
func znDrawCanvas(_ cg: CGContext, _ c: ZnCanvasCommands, size: CGSize, base: CGAffineTransform? = nil) {
    guard !c.ops.isEmpty else { return }
    var d = ZnCanvasDrawer(cg: cg, base: base ?? cg.ctm, size: size, density: c.density)
    cg.saveGState()
    if c.needsLayer { cg.beginTransparencyLayer(in: CGRect(origin: .zero, size: size), auxiliaryInfo: nil) }
    d.run(c.ops)
    if c.needsLayer { cg.endTransparencyLayer() }
    cg.restoreGState()
}

private func znCanvasCGColor(_ argb: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat(argb >> 16 & 0xFF) / 255, green: CGFloat(argb >> 8 & 0xFF) / 255,
            blue: CGFloat(argb & 0xFF) / 255, alpha: CGFloat(argb >> 24 & 0xFF) / 255 * alpha)
}

/// UIFont.Weight / NSFont.Weight raw values for a CSS weight, at the nearest named step.
func znCanvasWeight(_ w: Int?) -> CGFloat {
    switch w ?? 400 {
    case ..<150: return -0.8   // ultraLight
    case ..<250: return -0.6   // thin
    case ..<350: return -0.4   // light
    case ..<450: return 0      // regular
    case ..<550: return 0.23   // medium
    case ..<650: return 0.3    // semibold
    case ..<750: return 0.4    // bold
    case ..<850: return 0.56   // heavy
    default: return 0.62       // black
    }
}

/// The system font at [size] points and [weight].
func znCanvasFont(_ size: CGFloat, _ weight: Int?) -> CTFont {
    let w = znCanvasWeight(weight)
    #if canImport(UIKit)
    return UIFont.systemFont(ofSize: size, weight: UIFont.Weight(rawValue: w)) as CTFont
    #elseif canImport(AppKit)
    return NSFont.systemFont(ofSize: size, weight: NSFont.Weight(rawValue: w)) as CTFont
    #else
    return CTFontCreateUIFontForLanguage(.system, size, nil)!
    #endif
}

/// A text op's line, laid out once.
private final class ZnCanvasLine {
    let line: CTLine
    let width: CGFloat
    init(_ line: CTLine, _ width: CGFloat) { self.line = line; self.width = width }
}

/// A paragraph's lines, laid out once: each with its x offset (alignment) and baseline from the paragraph's top.
private final class ZnCanvasLines {
    let lines: [(line: CTLine, dx: CGFloat, baseline: CGFloat)]
    init(_ lines: [(line: CTLine, dx: CGFloat, baseline: CGFloat)]) { self.lines = lines }
}

private func attributed(_ text: String, _ font: CTFont) -> CFAttributedString {
    // The colour is the context's fill colour: the laid-out text is kept when the colour changes.
    let attrs: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorFromContextAttributeName: true]
    return CFAttributedStringCreate(nil, text as CFString, attrs as CFDictionary)
}

private func lineWidth(_ line: CTLine) -> CGFloat {
    CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
}

/// Lays out a paragraph as Android's StaticLayout does (ZnCanvas.kt ParagraphOp): word wrap at [width], the font's
/// ascent + descent per line plus (lineHeight − that) when lineHeight is set, maxLines with "…" at the end of the last.
private func znCanvasParagraph(_ op: ZnCanvasOp.Paragraph) -> ZnCanvasLines {
    let font = znCanvasFont(op.fontSizePx, op.fontWeight)
    let ascent = CTFontGetAscent(font), descent = CTFontGetDescent(font)
    let step = op.lineHeight > 0 ? op.lineHeight : ascent + descent
    let str = attributed(op.text, font)
    let typesetter = CTTypesetterCreateWithAttributedString(str)
    let length = CFAttributedStringGetLength(str)
    let ns = op.text as NSString
    var out: [(line: CTLine, dx: CGFloat, baseline: CGFloat)] = []
    var start = 0
    while start < length && out.count < op.maxLines {
        let count = CTTypesetterSuggestLineBreak(typesetter, start, Double(op.width))
        if count <= 0 { break }
        var line: CTLine
        if out.count == op.maxLines - 1 && start + count < length {
            // The last line allowed and text is left: the rest on one line, cut with "…".
            let rest = ns.substring(from: start).replacingOccurrences(of: "\n", with: " ")
            let whole = CTLineCreateWithAttributedString(attributed(rest, font))
            let token = CTLineCreateWithAttributedString(attributed("…", font))
            line = CTLineCreateTruncatedLine(whole, Double(op.width), .end, token) ?? CTTypesetterCreateLine(typesetter, CFRange(location: start, length: count))
        } else {
            line = CTTypesetterCreateLine(typesetter, CFRange(location: start, length: count))
        }
        let w = lineWidth(line) - CGFloat(CTLineGetTrailingWhitespaceWidth(line))
        let dx = op.align == 1 ? (op.width - w) / 2 : op.align == 2 ? op.width - w : 0
        out.append((line, dx, ascent + CGFloat(out.count) * step))
        start += count
    }
    return ZnCanvasLines(out)
}

/// Decodes [data] at about [w] × [h] pixels (at least covering them, never above the picture's own size), upright.
/// The same rule as Coil's inexact size on Android (ZnCanvasImage.kt).
func znCanvasDecode(_ data: Data, _ w: Int, _ h: Int) -> CGImage? {
    guard let src = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(src) > 0 else { return nil }
    var maxSide = max(w, h)
    if let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
       let iw = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
       let ih = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue, iw > 0, ih > 0 {
        // EXIF turns swap the sides.
        let turned = ((props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1) >= 5
        let (pw, ph) = turned ? (ih, iw) : (iw, ih)
        let s = min(1, max(Double(w) / pw, Double(h) / ph))
        maxSide = Int((max(pw, ph) * s).rounded(.up))
    }
    let opts: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceThumbnailMaxPixelSize: max(1, min(maxSide, 4096)),
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceShouldCacheImmediately: true,
    ]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
}

private struct ZnCanvasDrawer {
    let cg: CGContext
    /// Base space to device (CG shadows are in base space).
    let base: CGAffineTransform
    let size: CGSize
    let density: CGFloat
    /// The canvas's own space (y down) to base space, at the start.
    let start: CGAffineTransform
    /// Device pixels per base unit: Skia's blur adds half a pixel.
    let pxPerBase: CGFloat

    init(cg: CGContext, base: CGAffineTransform, size: CGSize, density: CGFloat) {
        self.cg = cg
        self.base = base
        self.size = size
        self.density = density
        start = cg.ctm.concatenating(base.inverted())
        let p = sqrt(abs(base.a * base.d - base.b * base.c))
        pxPerBase = p > 0 && p.isFinite ? p : 1
    }

    mutating func run(_ ops: [ZnCanvasOp]) {
        var depth = 0
        for op in ops {
            switch op {
            case let o as ZnCanvasOp.Rect:
                let r = CGRect(x: o.x.value, y: o.y.value, width: o.w.value, height: o.h.value).standardized
                shape(CGPath(rect: r, transform: nil), o.paint)
            case let o as ZnCanvasOp.RoundRect:
                let r = CGRect(x: o.x.value, y: o.y.value, width: o.w.value, height: o.h.value).standardized
                shape(roundRect(r, o.r.value), o.paint)
            case let o as ZnCanvasOp.Circle:
                let r = max(o.r.value, 0)
                shape(CGPath(ellipseIn: CGRect(x: o.cx.value - r, y: o.cy.value - r, width: r * 2, height: r * 2), transform: nil), o.paint)
            case let o as ZnCanvasOp.Oval:
                let r = CGRect(x: o.x.value, y: o.y.value, width: o.w.value, height: o.h.value).standardized
                shape(CGPath(ellipseIn: r, transform: nil), o.paint)
            case let o as ZnCanvasOp.Line:
                let p = CGMutablePath()
                p.move(to: CGPoint(x: o.x1.value, y: o.y1.value))
                p.addLine(to: CGPoint(x: o.x2.value, y: o.y2.value))
                shape(p, o.paint, line: true)
            case let o as ZnCanvasOp.Arc:
                if let p = arc(o) { shape(p, o.paint) }
            case let o as ZnCanvasOp.PathOp:
                // Path data is in dp: drawn under scale(density). Its paint was built in dp too.
                guard let path = o.visible() else { continue }
                cg.saveGState()
                cg.scaleBy(x: density, y: density)
                shape(path, o.paint)
                cg.restoreGState()
            case let o as ZnCanvasOp.Text:
                text(o)
            case let o as ZnCanvasOp.Paragraph:
                paragraph(o)
            case let o as ZnCanvasOp.Image:
                if let img = o.image { image(o, img) }
            case is ZnCanvasOp.Save:
                cg.saveGState()
                depth += 1
            case is ZnCanvasOp.Restore:
                // Parse drops a restore without a save.
                if depth > 0 {
                    cg.restoreGState()
                    depth -= 1
                }
            case let o as ZnCanvasOp.Translate:
                cg.translateBy(x: o.dx.value, y: o.dy.value)
            case let o as ZnCanvasOp.Scale:
                cg.scaleBy(x: o.sx.value, y: o.sy.value)
            case let o as ZnCanvasOp.Rotate:
                let px = o.px.value, py = o.py.value
                cg.translateBy(x: px, y: py)
                cg.rotate(by: o.degrees.value * .pi / 180)
                cg.translateBy(x: -px, y: -py)
            case let o as ZnCanvasOp.ClipRect:
                let r = CGRect(x: o.x.value, y: o.y.value, width: o.w.value, height: o.h.value).standardized
                clip(CGPath(rect: r, transform: nil), evenOdd: false, difference: o.difference)
            case let o as ZnCanvasOp.ClipRoundRect:
                let r = CGRect(x: o.x.value, y: o.y.value, width: o.w.value, height: o.h.value).standardized
                clip(roundRect(r, o.r.value), evenOdd: false, difference: o.difference)
            case let o as ZnCanvasOp.ClipPath:
                clip(o.path, evenOdd: o.evenOdd, difference: o.difference)
            default:
                break
            }
        }
        // Saves the list left open.
        while depth > 0 {
            cg.restoreGState()
            depth -= 1
        }
    }

    /// A rounded rect with its radius clamped to fit (Core Graphics refuses a bigger one; Skia shrinks it too).
    private func roundRect(_ r: CGRect, _ radius: CGFloat) -> CGPath {
        let k = min(max(radius, 0), r.width / 2, r.height / 2)
        return CGPath(roundedRect: r, cornerWidth: k, cornerHeight: k, transform: nil)
    }

    /// Compose's drawArc: degrees from 3 o'clock, clockwise (y down); a full turn or more is the whole oval.
    private func arc(_ o: ZnCanvasOp.Arc) -> CGPath? {
        let r = CGRect(x: o.x.value, y: o.y.value, width: o.w.value, height: o.h.value).standardized
        let sweep = o.sweep.value
        guard sweep != 0, r.width > 0 || r.height > 0 else { return nil }
        if abs(sweep) >= 360 { return CGPath(ellipseIn: r, transform: nil) }
        let p = CGMutablePath()
        let t = CGAffineTransform(translationX: r.midX, y: r.midY).scaledBy(x: r.width / 2, y: r.height / 2)
        if o.useCenter { p.move(to: .zero, transform: t) }
        p.addRelativeArc(center: .zero, radius: 1, startAngle: o.start.value * .pi / 180, delta: sweep * .pi / 180, transform: t)
        if o.useCenter { p.closeSubpath() }
        return p
    }

    /// Intersect: the shape. Difference: everything showing now but the shape.
    private func clip(_ path: CGPath, evenOdd: Bool, difference: Bool) {
        let rule: CGPathFillRule = evenOdd ? .evenOdd : .winding
        guard difference else {
            cg.addPath(path)
            cg.clip(using: rule)
            return
        }
        let box = cg.boundingBoxOfClipPath.insetBy(dx: -1, dy: -1)
        if #available(iOS 16, macOS 13, *) {
            cg.addPath(CGPath(rect: box, transform: nil).subtracting(path, using: rule))
            cg.clip(using: .winding)
        } else {
            cg.addRect(box)
            cg.addPath(path)
            cg.clip(using: .evenOdd)
        }
    }

    /// Sets the stroke for [p] (a line always strokes with the paint's width) on [cg], this canvas's when left out.
    private func setStroke(_ p: ZnCanvasPaint, on other: CGContext? = nil) {
        let cg = other ?? self.cg
        cg.setLineWidth(p.width())
        cg.setLineCap(p.cap)
        cg.setLineJoin(p.join)
        cg.setMiterLimit(4)  // Compose's Stroke default
        if let dash = p.dash { cg.setLineDash(phase: 0, lengths: dash) }
    }

    /// One shape with its paint: colour or gradient, fill or stroke, opacity, blend mode, shadow and blur.
    private func shape(_ path: CGPath, _ p: ZnCanvasPaint, line: Bool = false) {
        let stroke = p.isStroke || line
        cg.saveGState()
        cg.setAlpha(p.alpha())
        cg.setBlendMode(p.blend)
        if stroke { setStroke(p) }
        if p.blur > 0 && p.gradient == nil {
            // A soft shape: only its blurred copy shows (and a shadow of it under, when it has one).
            if let s = p.shadow { shadowOnly(path, p, stroke: stroke, color: s.color, dx: s.dx, dy: s.dy, radius: s.blur) }
            shadowOnly(path, p, stroke: stroke, color: p.color.value, dx: 0, dy: 0, radius: p.blur)
        } else if p.blur > 0 {
            // A soft gradient: the shape drawn into pixels of its own, blurred there and drawn back.
            if let s = p.shadow { shadowOnly(path, p, stroke: stroke, color: s.color, dx: s.dx, dy: s.dy, radius: s.blur) }
            if !blurred(path, p, stroke: stroke) { fill(path, p, stroke: stroke) }
        } else if let s = p.shadow {
            let (o, b) = shadowNow(s.dx, s.dy, s.blur)
            cg.setShadow(offset: o, blur: b, color: znCanvasCGColor(s.color))
            if p.gradient != nil {
                // The painted layer casts the shadow, not each clip of the gradient.
                cg.beginTransparencyLayer(auxiliaryInfo: nil)
                fill(path, p, stroke: stroke)
                cg.endTransparencyLayer()
            } else {
                fill(path, p, stroke: stroke)
            }
        } else {
            fill(path, p, stroke: stroke)
        }
        cg.restoreGState()
    }

    /// Paints [path] with [p]'s colour or gradient (stroke settings already set) into [cg], this canvas's context when
    /// left out.
    private func fill(_ path: CGPath, _ p: ZnCanvasPaint, stroke: Bool, into other: CGContext? = nil) {
        let cg = other ?? self.cg
        guard p.gradient != nil, let g = p.cgGradient else {
            cg.addPath(path)
            if stroke {
                cg.setStrokeColor(znCanvasCGColor(p.color.value))
                cg.strokePath()
            } else {
                cg.setFillColor(znCanvasCGColor(p.color.value))
                cg.fillPath(using: p.evenOdd ? .evenOdd : .winding)
            }
            return
        }
        cg.saveGState()
        cg.addPath(path)
        if stroke {
            cg.replacePathWithStrokedPath()
            cg.clip(using: .winding)
        } else {
            cg.clip(using: p.evenOdd ? .evenOdd : .winding)
        }
        let clamp: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        switch p.gradient {
        case let .linear(start, end, _, _)?:
            cg.drawLinearGradient(g, start: start, end: end, options: clamp)
        case let .radial(center, radius, _, _)?:
            cg.drawRadialGradient(g, startCenter: center, startRadius: 0, endCenter: center, endRadius: radius, options: clamp)
        case let .sweep(center, _, _, startAngle)?:
            if #available(iOS 17, macOS 14, *) {
                // 0 is the +x axis, turning toward +y: from 3 o'clock, clockwise in this y-down space (SweepGradient).
                CGContextDrawConicGradient(cg, g, center, startAngle * .pi / 180)
            }
        case nil:
            break
        }
        cg.restoreGState()
    }

    /// Android's BlurMaskFilter on a gradient paint (it blurs what the shader paints): [path] painted at device
    /// resolution into pixels of its own (its box plus 3 sigma, cut to what can show), blurred there by
    /// ZnSvgFilterGraph.blur (vImage, on the CPU, as the Svg filters) and drawn back in place, with this paint's
    /// opacity and blend mode (set on [cg] already) and the canvas's clip. False when it can't be made: the shape then
    /// draws sharp.
    private func blurred(_ path: CGPath, _ p: ZnCanvasPaint, stroke: Bool) -> Bool {
        let m = cg.ctm  // this space to device pixels
        let u = sqrt(abs(m.a * m.d - m.b * m.c))
        guard u > 0, u.isFinite else { return false }
        // Skia's sigma for radius r (BlurMaskFilter's radius, in this space, so a scale makes it softer) in pixels:
        // 0.57735·r + 0.5, as the solid blur above.
        let sigma = 0.57735 * p.blur * u + 0.5
        let reach = stroke ? p.width() : 0
        let margin = ceil(3 * sigma) + 1
        let box = path.boundingBox.insetBy(dx: -reach, dy: -reach).applying(m).insetBy(dx: -margin, dy: -margin)
        // Only what can show: the clip (a view's dirty rect at least), plus what blurs into it.
        let shown = cg.boundingBoxOfClipPath.applying(m).insetBy(dx: -margin, dy: -margin)
        let area = box.intersection(shown).integral
        guard !area.isNull, area.minX.isFinite, area.minY.isFinite, area.width.isFinite, area.height.isFinite else { return false }
        if area.width < 1 || area.height < 1 { return true }  // nothing of it shows
        // A big shape is blurred at a lower resolution (the Svg filters' limits), then drawn back scaled up.
        var k: CGFloat = 1
        let n = area.width * area.height
        if n > CGFloat(ZnSvgFilterGraph.maxPixels) { k = sqrt(CGFloat(ZnSvgFilterGraph.maxPixels) / n) }
        k = min(k, CGFloat(ZnSvgFilterGraph.maxSide) / max(area.width, area.height))
        let w = Int(ceil(area.width * k)), h = Int(ceil(area.height * k))
        guard w > 0, h > 0, let off = ZnSvgFilterGraph.canvas(w, h) else { return false }
        off.interpolationQuality = .default
        // This space to the image's pixels: device pixels from the area's corner, times k.
        off.concatenate(m.concatenating(CGAffineTransform(translationX: -area.minX, y: -area.minY))
            .concatenating(CGAffineTransform(scaleX: k, y: k)))
        if stroke { setStroke(p, on: off) }
        fill(path, p, stroke: stroke, into: off)
        // In place, before makeImage (an image made earlier may share the bytes).
        guard ZnSvgFilterGraph.blur(off, sx: sigma * k, sy: sigma * k), let image = off.makeImage() else { return false }
        cg.saveGState()
        cg.concatenate(m.inverted())  // device pixels, y up as the image
        cg.interpolationQuality = k < 1 ? .medium : .none
        cg.draw(image, in: CGRect(x: area.minX, y: area.minY, width: CGFloat(w) / k, height: CGFloat(h) / k))
        cg.restoreGState()
        return true
    }

    /// A shadow's offset and blur in base space now: given in this space, so the canvas's scale and turn apply.
    private func shadowNow(_ dx: CGFloat, _ dy: CGFloat, _ radius: CGFloat) -> (CGSize, CGFloat) {
        let m = cg.ctm.concatenating(base.inverted())  // user space to base space
        let o = CGSize(width: dx, height: dy).applying(CGAffineTransform(a: m.a, b: m.b, c: m.c, d: m.d, tx: 0, ty: 0))
        let u = sqrt(abs(m.a * m.d - m.b * m.c))
        let sigma = 0.57735 * radius * u + 0.5 / pxPerBase
        return (o, 2 * sigma)
    }

    /// Only the shadow of [path] in [color] (offset dx, dy; blur radius): the shape itself is moved out of sight in base
    /// space and the shadow's offset brings it back.
    private func shadowOnly(_ path: CGPath, _ p: ZnCanvasPaint, stroke: Bool, color: UInt32, dx: CGFloat, dy: CGFloat, radius: CGFloat) {
        let m = cg.ctm.concatenating(base.inverted())  // user space to base space
        let (o, b) = shadowNow(dx, dy, radius)
        let reach = stroke ? p.width() : 0
        let shapeBox = path.boundingBox.insetBy(dx: -reach, dy: -reach).applying(m)
        let shown = CGRect(origin: .zero, size: size).applying(start)
        guard shapeBox.minX.isFinite, shapeBox.maxX.isFinite, shown.minX.isFinite else { return }
        let k = shapeBox.maxX - shown.minX + abs(o.width) + 4 * b + 16
        cg.saveGState()
        // A move of k to the left in base space, written in user space: m · T · m⁻¹.
        let shift = m.concatenating(CGAffineTransform(translationX: -k, y: 0)).concatenating(m.inverted())
        cg.concatenate(shift)
        cg.setShadow(offset: CGSize(width: o.width + k, height: o.height), blur: b, color: znCanvasCGColor(color))
        cg.addPath(path)
        cg.setFillColor(znCanvasCGColor(color))
        cg.setStrokeColor(znCanvasCGColor(color))
        if stroke { cg.strokePath() } else { cg.fillPath(using: p.evenOdd ? .evenOdd : .winding) }
        cg.restoreGState()
    }

    /// Android's drawText: [y] is the baseline; align moves the line by its width.
    private func text(_ o: ZnCanvasOp.Text) {
        let made: ZnCanvasLine
        if let m = o.made as? ZnCanvasLine {
            made = m
        } else {
            let line = CTLineCreateWithAttributedString(attributed(o.text, znCanvasFont(o.fontSize * density, o.fontWeight)))
            made = ZnCanvasLine(line, lineWidth(line))
            o.made = made
        }
        let x = o.x.value - made.width * (o.align == 1 ? 0.5 : o.align == 2 ? 1 : 0)
        cg.saveGState()
        cg.setFillColor(znCanvasCGColor(o.color.value))
        cg.textMatrix = CGAffineTransform(scaleX: 1, y: -1)  // upright glyphs in this y-down space
        cg.textPosition = CGPoint(x: x, y: o.y.value)
        CTLineDraw(made.line, cg)
        cg.restoreGState()
    }

    private func paragraph(_ o: ZnCanvasOp.Paragraph) {
        let made: ZnCanvasLines
        if let m = o.made as? ZnCanvasLines {
            made = m
        } else {
            made = znCanvasParagraph(o)
            o.made = made
        }
        let x = o.x.value, y = o.y.value
        cg.saveGState()
        cg.setFillColor(znCanvasCGColor(o.color.value))
        cg.textMatrix = CGAffineTransform(scaleX: 1, y: -1)
        for l in made.lines {
            cg.textPosition = CGPoint(x: x + l.dx, y: y + l.baseline)
            CTLineDraw(l.line, cg)
        }
        cg.restoreGState()
    }

    /// A loaded image with its fit, corner radius and opacity (ZnCanvasImage.kt drawCanvasImage).
    private func image(_ o: ZnCanvasOp.Image, _ img: CGImage) {
        let x = o.x.value, y = o.y.value, w = o.w.value, h = o.h.value
        let bw = CGFloat(img.width), bh = CGFloat(img.height)
        guard w > 0, h > 0, bw > 0, bh > 0 else { return }
        let box = CGRect(x: x, y: y, width: w, height: h)
        var shown = box     // what shows (the radius rounds it)
        var drawn = box     // where the whole picture goes
        switch o.fit {
        case znFitCover:    // the middle of the picture, cut to the box's shape
            let s = max(w / bw, h / bh)
            drawn = CGRect(x: x + (w - bw * s) / 2, y: y + (h - bh * s) / 2, width: bw * s, height: bh * s)
        case znFitContain:  // all of it, centred in the box
            let s = min(w / bw, h / bh)
            drawn = CGRect(x: x + (w - bw * s) / 2, y: y + (h - bh * s) / 2, width: bw * s, height: bh * s)
            shown = drawn
        default:            // fill: stretched
            break
        }
        cg.saveGState()
        let r = o.radius?.value ?? 0
        if r > 0 {
            cg.addPath(roundRect(shown, r))
            cg.clip()
        } else {
            cg.clip(to: shown)
        }
        cg.setAlpha(min(max(o.opacity.value, 0), 1))
        cg.interpolationQuality = .high
        // Upright in this y-down space.
        cg.translateBy(x: drawn.minX, y: drawn.maxY)
        cg.scaleBy(x: 1, y: -1)
        cg.draw(img, in: CGRect(origin: .zero, size: drawn.size))
        cg.restoreGState()
    }
}
