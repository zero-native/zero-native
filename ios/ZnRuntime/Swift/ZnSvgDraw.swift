// One SVG drawn with Core Graphics on iOS, a port of android/runtime's ZnSvgDrawing (ZnSvg.kt) and ZnSvgEffects.kt:
// viewBox → box (preserveAspectRatio), groups (opacity and mix-blend-mode layers, clips, masks, filters), shapes
// (fills and strokes in a colour, currentColor, a gradient or a pattern; dashes; paint-order; non-scaling strokes),
// text, and <SvgPart> overrides (paints, opacity, transforms around a pivot, stroke width, dash offset, trims, morphs,
// motion paths, animated gradient stops). Drawn into a SwiftUI Canvas's CGContext (ZnSvgView.swift).
//
// iOS differences:
// - Filters run whole (ZnSvgFilters.swift: the group drawn into an image of the filter's region, each primitive on
//   its pixels, 8 bits a channel), as Android 12+'s RenderEffect. A region over 4M pixels runs at a lower resolution
//   (Android has no such cap). Where it can't run, as on Android (a pattern tile, a region over 4096 px a side), the
//   group is drawn over the plain drop shadows the compiler found in its filter, every one of them, bottom first.
//   With two or more shadows the group is drawn once into an image the size of what shows, and each shadow is cast
//   from it; in a pattern tile, or when that image would be too big, each shadow is drawn with a copy of the group
//   (exact where the group is opaque, a little darker where it isn't).
// - Gradients that repeat or reflect (spreadMethod) repeat 10 times each way from their line, which covers any
//   shape they paint in practice. A focal radial gradient that repeats is drawn padded.
// - Non-scaling strokes are their width in points along the shape's scale; Android also redraws them on screen when
//   the way there stretches unevenly.
// - Trimmed curves are polylines of 24 steps per curve (ZnSvgGeometry.swift).
import CoreGraphics
import SwiftUI
import UIKit

/// One part's values for this frame (ZnSvgPart in ZnSvg.kt). Transforms are in viewBox units around the pivot.
struct ZnSvgPartNow {
    var fill: UInt32?
    var stroke: UInt32?
    var opacity: CGFloat = 1
    var rotate: CGFloat = 0
    var scaleX: CGFloat = 1, scaleY: CGFloat = 1
    var translateX: CGFloat = 0, translateY: CGFloat = 0
    var pivot = CGPoint.zero
    /// start, end, offset; nil when the part never cuts its line.
    var trim: (CGFloat, CGFloat, CGFloat)?
    var strokeWidth: CGFloat = .nan
    var dashOffset: CGFloat = .nan
    var scaleOutline = false
    var morph: ZnSvgMorph?
    var morphAt: CGFloat = -1
    var skewX: CGFloat = 0, skewY: CGFloat = 0
    var frame: CGAffineTransform?
    var motion: ZnSvgMotionPath?
    var motionAt: CGFloat = -1
    var trimCaps = false

    /// The part's transform (matrixInto in ZnSvg.kt), or nil when it leaves things where they are.
    func matrix(scale: Bool = true) -> CGAffineTransform? {
        let sx = scale ? scaleX : 1, sy = scale ? scaleY : 1
        let still = translateX == 0 && translateY == 0 && rotate == 0 && sx == 1 && sy == 1 && skewX == 0 && skewY == 0
        let moving = motion != nil && motionAt >= 0
        if still && !moving { return nil }
        var m = CGAffineTransform.identity
        func pre(_ t: CGAffineTransform) { m = t.concatenating(m) }  // Android's preConcat: t applies first
        if let motion, motionAt >= 0 { m = motion.transform(at: motionAt) }
        if still { return m }
        if let frame { pre(frame) }
        pre(CGAffineTransform(translationX: translateX + pivot.x, y: translateY + pivot.y))
        if rotate != 0 { pre(CGAffineTransform(rotationAngle: rotate * .pi / 180)) }
        if skewX != 0 { pre(CGAffineTransform(a: 1, b: 0, c: tan(skewX * .pi / 180), d: 1, tx: 0, ty: 0)) }
        if skewY != 0 { pre(CGAffineTransform(a: 1, b: tan(skewY * .pi / 180), c: 0, d: 1, tx: 0, ty: 0)) }
        if sx != 1 || sy != 1 { pre(CGAffineTransform(scaleX: sx, y: sy)) }
        pre(CGAffineTransform(translationX: -pivot.x, y: -pivot.y))
        if let frame { pre(frame.inverted()) }
        return m
    }

    var areaScale: CGFloat { sqrt(abs(scaleX * scaleY)) }
}

func znCGColor(_ argb: UInt32, alpha: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat(argb >> 16 & 0xFF) / 255, green: CGFloat(argb >> 8 & 0xFF) / 255,
            blue: CGFloat(argb & 0xFF) / 255, alpha: CGFloat(argb >> 24 & 0xFF) / 255 * alpha)
}

/// The parsed drawings, one per draw data string (main thread). Bad data is reported once and draws nothing.
@MainActor
enum ZnSvgCache {
    private static var drawings: [String: ZnSvgDrawing?] = [:]

    static func get(_ data: String) -> ZnSvgDrawing? {
        if let d = drawings[data] { return d }
        let d: ZnSvgDrawing?
        do { d = ZnSvgDrawing(try ZnSvgReader.read(data)) } catch {
            print("zn: bad SVG draw data, drawing nothing: \(error)")
            d = nil
        }
        drawings[data] = d
        return d
    }
}

final class ZnSvgDrawing {
    let data: ZnSvgData
    private let clips: [(CGPath, Bool)]
    private let lists: [OpList]  // 0: the SVG's own; 1…: patterns' and masks' contents
    private let blends: Bool

    init(_ d: ZnSvgData) {
        data = d
        clips = d.clips.map { c in
            // The union of the clip's paths (each with its own fill rule); one path keeps its rule.
            if c.paths.count == 1 { return (c.paths[0].path, c.paths[0].evenOdd) }
            var acc = c.paths[0].path
            for p in c.paths.dropFirst() { acc = acc.union(p.path, using: p.evenOdd ? .evenOdd : .winding) }
            return (acc, false)
        }
        lists = [OpList(d.main)] + d.contents.map(OpList.init)
        blends = ([d.main] + d.contents).contains { $0.ops.contains { if case .group(let g) = $0 { return g.blend != 0 } else { return false } } }
    }

    /// Per draw: the box, currentColor and the parts.
    private struct Frame {
        var cg: CGContext
        let current: UInt32
        let parts: [Int: ZnSvgPartNow]
        /// Points per viewBox unit (both axes as one number).
        var unit: CGFloat
        var bounds: CGRect
        var gradientColors: [Int: [UInt32]]
        /// The context's CTM before the drawing's own transforms: base space (where shadows are) to device pixels.
        var base: CGAffineTransform = .identity
        /// Drawing a pattern's tiles (up to 4000 of them): no filter images there, as on Android.
        var inPattern = false
    }

    /// Inherited down the groups: part paints, stroke width / dash offset, how much parts scale, and the trim.
    private struct State {
        var fill: UInt32?
        var stroke: UInt32?
        var width: CGFloat = .nan
        var dash: CGFloat = .nan
        var scale: CGFloat = 1
        var trim: [(CGFloat, CGFloat)]?
        var trimCaps = false
    }

    func draw(_ cg: CGContext, size: CGSize, current: UInt32, mirror: Bool, parts: [Int: ZnSvgPartNow]) {
        let w = size.width, h = size.height
        guard w > 0, h > 0 else { return }
        let d = data
        let sx: CGFloat, sy: CGFloat, align: Int
        if d.aspect == znSvgAspectNone {
            sx = w / d.vw; sy = h / d.vh; align = 0
        } else {
            let slice = d.aspect >= 9
            let s = slice ? max(w / d.vw, h / d.vh) : min(w / d.vw, h / d.vh)
            sx = s; sy = s; align = d.aspect % 9
        }
        let tx = (w - d.vw * sx) * CGFloat(align % 3) / 2 - d.vx * sx
        let ty = (h - d.vh * sy) * CGFloat(align / 3) / 2 - d.vy * sy
        let base = cg.ctm
        cg.saveGState()
        defer { cg.restoreGState() }
        if (9...17).contains(d.aspect) { cg.clip(to: CGRect(x: 0, y: 0, width: w, height: h)) }
        if mirror { cg.translateBy(x: w, y: 0); cg.scaleBy(x: -1, y: 1) }
        cg.translateBy(x: tx, y: ty)
        cg.scaleBy(x: sx, y: sy)
        let bounds = CGRect(x: -tx / sx, y: -ty / sy, width: w / sx, height: h / sy)
        var f = Frame(cg: cg, current: current, parts: parts, unit: sqrt(sx * sy), bounds: bounds, gradientColors: [:],
                      base: base)
        // Animated gradient stops: a part's fill recolours its stop.
        let links = d.stopLinks
        var k = 0
        while k + 2 < links.count {
            if let c = parts[links[k + 2]]?.fill {
                var colors = f.gradientColors[links[k]] ?? d.gradients[links[k]].colors
                colors[links[k + 1]] = c
                f.gradientColors[links[k]] = colors
            }
            k += 3
        }
        if blends { cg.beginTransparencyLayer(in: bounds, auxiliaryInfo: nil) }
        drawRange(&f, 0, 0, lists[0].ops.count, State(), parts: true)
        if blends { cg.endTransparencyLayer() }
    }

    // MARK: Ops

    /// Ops [from, to) of list [l]. [parts]: the SVG's own list (pattern and mask contents have no parts).
    private func drawRange(_ f: inout Frame, _ l: Int, _ from: Int, _ to: Int, _ state: State, parts: Bool) {
        let list = lists[l]
        let cg = f.cg
        var i = from
        while i < to {
            switch list.ops[i] {
            case .group(let g):
                let part = parts ? f.parts[g.part] : nil
                var opacity = min(max(g.opacity, 0), 1) * min(max(part?.opacity ?? 1, 0), 1)
                if opacity <= 0 { i = g.end + 1; continue }  // invisible: skip to after its "g"
                var s = state
                if let part {
                    if let c = part.fill { s.fill = c }
                    if let c = part.stroke { s.stroke = c }
                    if !part.strokeWidth.isNaN { s.width = part.strokeWidth }
                    if !part.dashOffset.isNaN { s.dash = part.dashOffset }
                    s.scale *= part.areaScale
                    if let t = part.trim {
                        // A group's trim treats all its pieces as one line, in draw order.
                        setTrim(&s, list, base: list.before[i], total: list.before[g.end] - list.before[i], t, caps: part.trimCaps, parent: state)
                    }
                }
                cg.saveGState()
                let layer = opacity < 1 || g.blend != 0
                if layer {
                    // Made before the part's transform, so the layer still covers the box when the part turns.
                    cg.setAlpha(opacity)
                    cg.setBlendMode(Self.blendModes[g.blend])
                    cg.beginTransparencyLayer(in: f.bounds, auxiliaryInfo: nil)
                    cg.setAlpha(1)
                    cg.setBlendMode(.normal)
                    opacity = 1
                }
                if let m = part?.matrix() { cg.concatenate(m) }
                if g.clip >= 0 { clip(cg, clips[g.clip]) }
                if g.mask >= 0 || g.filter >= 0 {
                    drawEffects(&f, l, i, g, s, parts: parts)
                } else {
                    drawRange(&f, l, i + 1, g.end, s, parts: parts)
                }
                if layer { cg.endTransparencyLayer() }
                cg.restoreGState()
                i = g.end + 1
                continue
            case .groupEnd:
                break
            case .shape(let op):
                let part = parts ? f.parts[op.part] : nil  // the shape's own part wins over a group's
                drawShape(&f, list, i, op, part, state)
            case .text(let op):
                let part = parts ? f.parts[op.part] : nil
                drawText(&f, op, part, state)
            }
            i += 1
        }
    }

    private func clip(_ cg: CGContext, _ c: (CGPath, Bool)) {
        cg.addPath(c.0)
        cg.clip(using: c.1 ? .evenOdd : .winding)
    }

    private func setTrim(_ s: inout State, _ list: OpList, base: CGFloat, total: CGFloat, _ t: (CGFloat, CGFloat, CGFloat),
                         caps: Bool, parent: State) {
        // A trim that shows the whole line cuts nothing: what the group shows stays.
        guard let rel = znTrimRanges(t.0, t.1, t.2, total) else { return }
        s.trimCaps = caps
        s.trim = znTrimIntersect(rel, base, parent.trim)
    }

    private func drawShape(_ f: inout Frame, _ list: OpList, _ at: Int, _ op: SvgShape, _ part: ZnSvgPartNow?, _ state: State) {
        let opacity = min(max(op.opacity, 0), 1) * min(max(part?.opacity ?? 1, 0), 1)
        guard opacity > 0 else { return }
        let fillC = part?.fill ?? state.fill
        let strokeC = part?.stroke ?? state.stroke
        let cg = f.cg
        let stroke = op.strokeKind != ZnSvgPaint.none ? strokeFor(f, list, op, part, state) : nil
        let hasFill = op.fillKind != ZnSvgPaint.none
        guard hasFill || stroke != nil else { return }
        var s = state
        if let t = part?.trim { setTrim(&s, list, base: list.before[at], total: list.length(op.index), t, caps: part!.trimCaps, parent: state) }
        var path: CGPath
        if let ranges = s.trim {
            guard let p = trimPath(list, at, op, ranges, caps: s.trimCaps) else { return }
            path = p
        } else {
            path = list.paths[op.index]
            // A morph (animated `d`) draws the path between two keyframes; the compiler never trims one.
            if let morph = part?.morph, let where_ = part?.morphAt, where_ >= 0 { path = morph.path(at: where_) }
        }
        // A part that scales its outline, not its stroke: the scale goes into the path, the rest onto the canvas.
        let outlined = part.map { $0.scaleOutline && op.matrix == nil && ($0.scaleX != 1 || $0.scaleY != 1) } ?? false
        if outlined, let p = part {
            var t = CGAffineTransform(translationX: p.pivot.x, y: p.pivot.y).scaledBy(x: p.scaleX, y: p.scaleY)
                .translatedBy(x: -p.pivot.x, y: -p.pivot.y)
            path = path.copy(using: &t) ?? path
        }
        let shapeScale = f.unit * state.scale * (part?.areaScale ?? 1) * list.matrixScale(op.index)
        cg.saveGState()
        defer { cg.restoreGState() }
        // Translucent with both a fill and a stroke: a layer, so the fill doesn't show through the stroke.
        let layer = opacity < 1 && hasFill && stroke != nil
        if layer {
            cg.setAlpha(opacity)
            cg.beginTransparencyLayer(in: f.bounds, auxiliaryInfo: nil)
            cg.setAlpha(1)
        }
        let alpha = layer ? 1 : opacity
        if let m = part?.matrix(scale: !outlined) { cg.concatenate(m) }
        if let m = op.matrix { cg.concatenate(m) }  // a shape matrix transforms the stroke too
        if let stroke, op.strokeFirst { paint(&f, path, op.strokeKind, op.stroke, strokeC, op.strokeAlpha * alpha, .stroke(stroke), shapeScale) }
        if hasFill { paint(&f, path, op.fillKind, op.fill, fillC, op.fillAlpha * alpha, .fill(op.evenOdd), shapeScale) }
        if let stroke, !op.strokeFirst { paint(&f, path, op.strokeKind, op.stroke, strokeC, op.strokeAlpha * alpha, .stroke(stroke), shapeScale) }
        if layer { cg.endTransparencyLayer() }
    }

    private struct StrokeNow {
        let spec: SvgStroke
        let width: CGFloat
        let phase: CGFloat
    }

    private enum Mode {
        case fill(Bool)  // even-odd
        case stroke(StrokeNow)
    }

    /// The stroke to draw, or nil (width 0 draws none): a part's width / dash offset (the shape's own part wins), or a
    /// non-scaling stroke's points turned into viewBox units.
    private func strokeFor(_ f: Frame, _ list: OpList, _ op: SvgShape, _ part: ZnSvgPartNow?, _ state: State) -> StrokeNow? {
        guard let spec = op.strokeSpec else { return nil }
        var w = state.width, phase = state.dash, scale = state.scale
        if let part {
            if !part.strokeWidth.isNaN { w = part.strokeWidth }
            if !part.dashOffset.isNaN { phase = part.dashOffset }
            if !part.scaleOutline { scale *= part.areaScale }
        }
        if w.isNaN {
            w = spec.width
            if spec.nonScaling {
                let px = f.unit * scale * list.matrixScale(op.index)
                if px > 0 { w /= px }
            }
        }
        if phase.isNaN { phase = spec.dashOffset }
        return w > 0 ? StrokeNow(spec: spec, width: w, phase: phase) : nil
    }

    private func paint(_ f: inout Frame, _ path: CGPath, _ kind: Int, _ value: UInt32, _ override: UInt32?, _ alpha: CGFloat,
                       _ mode: Mode, _ shapePx: CGFloat) {
        let a = min(max(alpha, 0), 1)
        guard a > 0 else { return }
        let cg = f.cg
        func setStroke(_ s: StrokeNow) {
            cg.setLineWidth(s.width)
            cg.setLineCap(s.spec.cap == 1 ? .round : s.spec.cap == 2 ? .square : .butt)
            cg.setLineJoin(s.spec.join == 1 ? .round : s.spec.join == 2 ? .bevel : .miter)
            cg.setMiterLimit(max(s.spec.miter, 1))
            if let d = s.spec.dashes { cg.setLineDash(phase: s.phase, lengths: d) } else { cg.setLineDash(phase: 0, lengths: []) }
        }
        let color: UInt32? = override ?? (kind == ZnSvgPaint.current ? f.current : kind == ZnSvgPaint.color ? value : nil)
        cg.saveGState()
        defer { cg.restoreGState() }
        cg.setAlpha(a)
        if let color {
            cg.addPath(path)
            switch mode {
            case .fill(let eo):
                cg.setFillColor(znCGColor(color))
                cg.fillPath(using: eo ? .evenOdd : .winding)
            case .stroke(let s):
                setStroke(s)
                cg.setStrokeColor(znCGColor(color))
                cg.strokePath()
            }
            return
        }
        // A gradient or a pattern: clip to the area painted, then fill it.
        cg.addPath(path)
        switch mode {
        case .fill(let eo): cg.clip(using: eo ? .evenOdd : .winding)
        case .stroke(let s):
            setStroke(s)
            cg.replacePathWithStrokedPath()
            cg.clip()
        }
        if kind == ZnSvgPaint.gradient {
            drawGradient(f, Int(value))
        } else if kind == ZnSvgPaint.pattern {
            drawPattern(&f, Int(value), path.boundingBoxOfPath, shapePx)
        }
    }

    // MARK: Gradients and patterns

    private func drawGradient(_ f: Frame, _ index: Int) {
        let g = data.gradients[index]
        let colors = f.gradientColors[index] ?? g.colors
        guard let last = colors.last else { return }
        let cg = f.cg
        let c = g.coords
        let solid = colors.count == 1 || (g.radial ? c[2] <= 0 : (c[0] == c[2] && c[1] == c[3]))
        if solid {
            cg.setFillColor(znCGColor(last))
            cg.fill(cg.boundingBoxOfClipPath)
            return
        }
        if let m = g.matrix { cg.concatenate(m) }
        let repeats = g.spread != 0 && !(g.radial && c.count == 6)
        let periods = repeats ? 10 : 0
        var locs: [CGFloat] = [], cols: [CGColor] = []
        // Repeat / reflect: the stops again for each period, over a line 2·periods + 1 times as long.
        let total = CGFloat(periods * (g.radial ? 1 : 2) + 1)
        let firstPeriod = g.radial ? 0 : -periods
        for p in firstPeriod...periods {
            let mirror = g.spread == 1 && p % 2 != 0
            for k in 0..<colors.count {
                let j = mirror ? colors.count - 1 - k : k
                let o = mirror ? 1 - g.offsets[j] : g.offsets[j]
                locs.append((CGFloat(p - firstPeriod) + o) / total)
                cols.append(znCGColor(colors[j]))
            }
        }
        guard let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: cols as CFArray, locations: locs) else { return }
        let opts: CGGradientDrawingOptions = [.drawsBeforeStartLocation, .drawsAfterEndLocation]
        if g.radial {
            let center = CGPoint(x: c[0], y: c[1])
            let focal = c.count == 6 ? CGPoint(x: c[3], y: c[4]) : center
            let fr = c.count == 6 ? c[5] : 0
            cg.drawRadialGradient(gradient, startCenter: focal, startRadius: fr, endCenter: center, endRadius: c[2] * total, options: opts)
        } else {
            let p0 = CGPoint(x: c[0], y: c[1]), p1 = CGPoint(x: c[2], y: c[3])
            let dx = p1.x - p0.x, dy = p1.y - p0.y
            let k = CGFloat(periods)
            cg.drawLinearGradient(gradient, start: CGPoint(x: p0.x - dx * k, y: p0.y - dy * k),
                                  end: CGPoint(x: p0.x + dx * (k + 1), y: p0.y + dy * (k + 1)), options: opts)
        }
    }

    /// Pattern [index] over [box] (the shape's bounds in its space): its tile drawn at each place it repeats.
    private func drawPattern(_ f: inout Frame, _ index: Int, _ box: CGRect, _ shapePx: CGFloat) {
        let p = data.patterns[index]
        let t = p.tile
        guard t[2] > 0, t[3] > 0 else { return }
        let cg = f.cg
        let m = p.matrix ?? .identity
        if p.matrix != nil { cg.concatenate(m) }
        let area = box.applying(m.inverted())
        let i0 = Int(floor((area.minX - t[0]) / t[2])), i1 = Int(ceil((area.maxX - t[0]) / t[2]))
        let j0 = Int(floor((area.minY - t[1]) / t[3])), j1 = Int(ceil((area.maxY - t[1]) / t[3]))
        guard (i1 - i0) * (j1 - j0) <= 4000 else { return }
        let keep = f.unit, keepIn = f.inPattern
        f.unit = shapePx * sqrt(abs(m.a * m.d - m.b * m.c))
        f.inPattern = true
        for i in i0..<max(i1, i0 + 1) {
            for j in j0..<max(j1, j0 + 1) {
                cg.saveGState()
                cg.translateBy(x: CGFloat(i) * t[2], y: CGFloat(j) * t[3])
                cg.clip(to: CGRect(x: t[0], y: t[1], width: t[2], height: t[3]))
                let l = 1 + p.content
                drawRange(&f, l, 0, lists[l].ops.count, State(), parts: false)
                cg.restoreGState()
            }
        }
        f.unit = keep
        f.inPattern = keepIn
    }

    // MARK: Effects

    private static let blendModes: [CGBlendMode] = [.normal, .multiply, .screen, .overlay, .darken, .lighten, .colorDodge,
                                                    .colorBurn, .hardLight, .softLight, .difference, .exclusion, .hue,
                                                    .saturation, .color, .luminosity]

    /// Group [g] (op [at] of list [l]) through its mask and / or filter.
    private func drawEffects(_ f: inout Frame, _ l: Int, _ at: Int, _ g: SvgGroup, _ s: State, parts: Bool) {
        let cg = f.cg
        if g.mask >= 0, let image = maskImage(&f, data.masks[g.mask]) {
            cg.clip(to: f.bounds, mask: image)
        }
        if g.filter >= 0, drawFiltered(&f, l, at, g, s, parts: parts) { return }
        let shadows = g.filter >= 0 ? data.filters[g.filter].shadows : []
        if shadows.count == 1 {
            // One drop shadow: set on the layer that holds the group, the cheap way.
            let k = shadowNow(f, shadows[0])
            cg.setShadow(offset: k.offset, blur: k.blur, color: k.color)
            cg.beginTransparencyLayer(in: f.bounds, auxiliaryInfo: nil)
            cg.setShadow(offset: .zero, blur: 0, color: nil)
            drawRange(&f, l, at + 1, g.end, s, parts: parts)
            cg.endTransparencyLayer()
        } else if shadows.count > 1 {
            drawShadows(&f, l, at, g, s, parts: parts, shadows.map { shadowNow(f, $0) })
        } else {
            drawRange(&f, l, at + 1, g.end, s, parts: parts)
        }
    }

    /// Group [g] through its whole filter (ZnSvgEffects.kt drawWithEffect): drawn into an image of the filter's region
    /// at the device pixels one unit of the group's space has now (screen scale, the SVG's scale, parts' scales), run
    /// through ZnSvgFilterGraph and drawn back in its place, so a part's turn or skew turns the result with it, as on
    /// Android (the image's place and the flips are ZnSvgFilterGraph's area, filtered and drawBack, checked on the Mac
    /// in ios/tests/svg). False when it can't run here (a pattern tile, a region over 4096 px a side, the graph
    /// failed): the caller draws the plain drop shadows then. Nothing has been drawn into [f] when it returns false.
    private func drawFiltered(_ f: inout Frame, _ l: Int, _ at: Int, _ g: SvgGroup, _ s: State, parts: Bool) -> Bool {
        guard !f.inPattern else { return false }
        let filter = data.filters[g.filter]
        guard let area = ZnSvgFilterGraph.area(filter.region, ctm: f.cg.userSpaceToDeviceSpaceTransform) else { return false }
        if area.w == 0 { return true }  // nothing shows
        let started = ZnSvgFilterTiming.on ? CFAbsoluteTimeGetCurrent() : 0
        let out = ZnSvgFilterGraph.filtered(filter, area) { off in
            var mf = f
            mf.cg = off
            mf.bounds = area.rect
            // A bitmap context's base space is its own pixels (y up): a shadow inside the group is cast there.
            mf.base = .identity
            drawRange(&mf, l, at + 1, g.end, s, parts: parts)
        }
        guard let out else { return false }
        ZnSvgFilterGraph.drawBack(f.cg, out, area)
        if ZnSvgFilterTiming.on { ZnSvgFilterTiming.add(CFAbsoluteTimeGetCurrent() - started, area) }
        return true
    }

    private struct ShadowNow {
        /// In base space (CGContext.setShadow's, unaffected by the CTM).
        let offset: CGSize
        let blur: CGFloat
        let color: CGColor
    }

    /// A filter shadow's offset and blur in base space: its dx / dy and stdDeviation are in the group's units, so the
    /// group's transforms now (scale, a part's turn) apply to them, as Android's filter does.
    private func shadowNow(_ f: Frame, _ sh: (dx: CGFloat, dy: CGFloat, std: CGFloat, color: UInt32)) -> ShadowNow {
        let m = f.cg.ctm.concatenating(f.base.inverted())  // user space to base space
        let o = CGSize(width: sh.dx, height: sh.dy).applying(CGAffineTransform(a: m.a, b: m.b, c: m.c, d: m.d, tx: 0, ty: 0))
        let u = sqrt(abs(m.a * m.d - m.b * m.c))
        return ShadowNow(offset: o, blur: sh.std * u * 2, color: znCGColor(sh.color))
    }

    /// Two or more drop shadows (Figma's stacked ones), bottom first, then the group once (ZnSvgEffects.kt's fallback).
    /// The group is drawn into an image of the device pixels that show (plus room for the shadows), and each shadow is
    /// cast by that image drawn just left of what shows, its offset moved back by as much: only the shadow lands.
    private func drawShadows(_ f: inout Frame, _ l: Int, _ at: Int, _ g: SvgGroup, _ s: State, parts: Bool, _ shadows: [ShadowNow]) {
        let cg = f.cg
        let ctm = cg.ctm
        let pxPerBase = sqrt(abs(f.base.a * f.base.d - f.base.b * f.base.c))
        let room = shadows.map { (abs($0.offset.width) + abs($0.offset.height) + $0.blur * 1.5) * pxPerBase }.max() ?? 0
        let shown = cg.boundingBoxOfClipPath.applying(ctm).integral
        let area = shown.insetBy(dx: -ceil(room), dy: -ceil(room))
        let w = Int(area.width), h = Int(area.height)
        guard !f.inPattern, pxPerBase > 0, w > 0, h > 0, w * h <= 4_000_000,
              let image = groupImage(&f, l, at, g, s, parts: parts, device: area, ctm: ctm) else {
            // In a pattern tile or too big: each shadow with its own copy of the group.
            for k in shadows {
                cg.saveGState()
                cg.setShadow(offset: k.offset, blur: k.blur, color: k.color)
                cg.beginTransparencyLayer(in: f.bounds, auxiliaryInfo: nil)
                cg.setShadow(offset: .zero, blur: 0, color: nil)
                drawRange(&f, l, at + 1, g.end, s, parts: parts)
                cg.endTransparencyLayer()
                cg.restoreGState()
            }
            return
        }
        cg.saveGState()
        cg.concatenate(ctm.inverted())  // device pixels
        let shift = area.maxX - shown.minX + 8  // the image, moved this far left, is all outside what shows
        // The shift back, in base space (the device's x axis there, whatever base's scale, flip or turn).
        let lin = CGAffineTransform(a: f.base.a, b: f.base.b, c: f.base.c, d: f.base.d, tx: 0, ty: 0)
        let back = CGSize(width: shift, height: 0).applying(lin.inverted())
        for k in shadows {
            cg.setShadow(offset: CGSize(width: k.offset.width + back.width, height: k.offset.height + back.height),
                         blur: k.blur, color: k.color)
            cg.draw(image, in: area.offsetBy(dx: -shift, dy: 0))
        }
        cg.restoreGState()
        drawRange(&f, l, at + 1, g.end, s, parts: parts)
    }

    /// The group's content drawn into an image of [device] (pixels of the context, with the CTM [ctm] it has now).
    private func groupImage(_ f: inout Frame, _ l: Int, _ at: Int, _ g: SvgGroup, _ s: State, parts: Bool,
                            device: CGRect, ctm: CGAffineTransform) -> CGImage? {
        let w = Int(device.width), h = Int(device.height)
        guard let img = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        img.translateBy(x: -device.minX, y: -device.minY)
        img.concatenate(ctm)
        var gf = f
        gf.cg = img
        // A bitmap context's base space is its own pixels (y up): a filter inside the group casts its shadow there.
        gf.base = .identity
        drawRange(&gf, l, at + 1, g.end, s, parts: parts)
        return img.makeImage()
    }

    /// The mask's content over the layer's box as a grey image: brightness (over black, so its alpha counts too) or
    /// alpha. Drawn at the screen's resolution for this box; nil when it can't be made.
    private func maskImage(_ f: inout Frame, _ mask: SvgMask) -> CGImage? {
        let b = f.bounds
        let ctm = f.cg.userSpaceToDeviceSpaceTransform
        let px = sqrt(abs(ctm.a * ctm.d - ctm.b * ctm.c))
        let w = Int(ceil(b.width * px)), h = Int(ceil(b.height * px))
        guard w > 0, h > 0, w * h <= 4_000_000,
              let rgba = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                   space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                   bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        // Not flipped: drawing the image back into the (y-down) view context flips it the right way up.
        rgba.scaleBy(x: CGFloat(w) / b.width, y: CGFloat(h) / b.height)
        rgba.translateBy(x: -b.minX, y: -b.minY)
        if mask.region >= 0 { clip(rgba, clips[mask.region]) }
        var mf = Frame(cg: rgba, current: f.current, parts: [:], unit: f.unit, bounds: b, gradientColors: f.gradientColors)
        // A mask in a pattern's tile: its filters stay plain drop shadows too, as Android (the tile has no filter node).
        mf.inPattern = f.inPattern
        let l = 1 + mask.content
        drawRange(&mf, l, 0, lists[l].ops.count, State(), parts: false)
        guard let src = rgba.data?.assumingMemoryBound(to: UInt8.self),
              let gray = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                   space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue),
              let dst = gray.data?.assumingMemoryBound(to: UInt8.self) else { return nil }
        for k in 0..<(w * h) {
            let r = Double(src[k * 4]), g = Double(src[k * 4 + 1]), bl = Double(src[k * 4 + 2]), a = src[k * 4 + 3]
            // Premultiplied over transparent = over black: the brightness already has the alpha in it.
            dst[k] = mask.luminance ? UInt8(min(255, 0.2125 * r + 0.7154 * g + 0.0721 * bl)) : a
        }
        return gray.makeImage()
    }

    // MARK: Text

    private func drawText(_ f: inout Frame, _ op: SvgText, _ part: ZnSvgPartNow?, _ state: State) {
        let opacity = min(max(part?.opacity ?? 1, 0), 1)
        guard opacity > 0 else { return }
        let fillO = part?.fill ?? state.fill, strokeO = part?.stroke ?? state.stroke
        let cg = f.cg
        cg.saveGState()
        defer { cg.restoreGState() }
        if let m = part?.matrix() { cg.concatenate(m) }
        if let m = op.matrix { cg.concatenate(m) }
        UIGraphicsPushContext(cg)
        defer { UIGraphicsPopContext() }
        func font(_ r: SvgTextRun) -> UIFont {
            let weight = UIFont.Weight(rawValue: CGFloat(r.weight - 400) / 500)
            var d = UIFont.systemFont(ofSize: r.size, weight: weight).fontDescriptor
            if r.family == 1, let s = d.withDesign(.serif) { d = s }
            if r.family == 2, let s = d.withDesign(.monospaced) { d = s }
            if r.italic, let s = d.withSymbolicTraits(.traitItalic) { d = s }
            return UIFont(descriptor: d, size: r.size)
        }
        func color(_ kind: Int, _ value: UInt32, _ override: UInt32?) -> UInt32? {
            if let override { return override }
            switch kind {
            case ZnSvgPaint.current: return f.current
            case ZnSvgPaint.color: return value
            case ZnSvgPaint.gradient: return (f.gradientColors[Int(value)] ?? data.gradients[Int(value)].colors).first
            default: return nil
            }
        }
        // The whole line's width first, for the anchor.
        var total: CGFloat = 0
        for r in op.runs { total += r.dx + NSAttributedString(string: r.text, attributes: [.font: font(r), .kern: r.spacing]).size().width }
        var x = op.x - total * CGFloat(op.anchor) / 2, y = op.y
        for r in op.runs {
            x += r.dx; y += r.dy
            let fnt = font(r)
            let base = y + (r.baseline == 1 ? (fnt.ascender + fnt.descender) / 2 : r.baseline == 2 ? fnt.ascender * 0.8 : 0)
            let a = opacity * r.opacity
            var attrs: [NSAttributedString.Key: Any] = [.font: fnt, .kern: r.spacing]
            let origin = CGPoint(x: x, y: base - fnt.ascender)
            if r.fillKind != ZnSvgPaint.none, let c = color(r.fillKind, r.fill, fillO) {
                attrs[.foregroundColor] = UIColor(cgColor: znCGColor(c, alpha: a * r.fillAlpha))
                NSAttributedString(string: r.text, attributes: attrs).draw(at: origin)
            }
            if r.strokeKind != ZnSvgPaint.none, let spec = r.strokeSpec, let c = color(r.strokeKind, r.stroke, strokeO) {
                attrs[.foregroundColor] = UIColor.clear
                attrs[.strokeColor] = UIColor(cgColor: znCGColor(c, alpha: a * r.strokeAlpha))
                attrs[.strokeWidth] = r.size > 0 ? spec.width / r.size * 100 : 0  // percent of the size; positive: stroke only
                NSAttributedString(string: r.text, attributes: attrs).draw(at: origin)
            }
            x += NSAttributedString(string: r.text, attributes: [.font: fnt, .kern: r.spacing]).size().width
        }
    }

    // MARK: Trims

    /// Shape [op] (op [at]) cut to [ranges] (line lengths from the start of the list's first shape), or nil when none
    /// of it shows.
    private func trimPath(_ list: OpList, _ at: Int, _ op: SvgShape, _ ranges: [(CGFloat, CGFloat)], caps: Bool) -> CGPath? {
        let measure = list.measure(op.index)
        let k = list.matrixScale(op.index)
        var c0 = list.before[at]
        let out = CGMutablePath()
        var any = false
        let lengths = measure.lengths
        for (ci, len) in lengths.enumerated() {
            let c1 = c0 + len * k
            for (a, b) in ranges {
                if a == b {
                    // A piece of length 0: its caps only (an SVG dash of length 0 with a round cap is a dot).
                    if caps && a >= c0 && (a < c1 || ci == lengths.count - 1), let (p, _) = measure.posTan(ci, (a - c0) / k) {
                        out.move(to: p)
                        out.addLine(to: p)
                        any = true
                    }
                    continue
                }
                let x0 = max(a, c0), x1 = min(b, c1)
                if x1 > x0 && measure.segment(ci, (x0 - c0) / k, (x1 - c0) / k, into: out) { any = true }
            }
            c0 = c1
        }
        return any ? out : nil
    }
}

/// One list of ops (the SVG's own, a pattern's or a mask's) with its paths, and line lengths for trims (made on the
/// first trimmed draw: measuring every path would slow down SVGs that never trim).
private final class OpList {
    let ops: [SvgOp]
    let paths: [CGPath]
    private let matrices: [CGAffineTransform?]
    private var measures: [Int: ZnPathMeasure] = [:]
    private var lengthsMade = false
    private var _before: [CGFloat] = []

    init(_ c: SvgContent) {
        ops = c.ops
        paths = c.paths
        var m = [CGAffineTransform?](repeating: nil, count: c.paths.count)
        for op in c.ops { if case .shape(let s) = op { m[s.index] = s.matrix } }
        matrices = m
    }

    /// How much shape [index]'s own matrix scales lengths (about), 1 without one.
    func matrixScale(_ index: Int) -> CGFloat {
        guard let m = matrices[index] else { return 1 }
        return sqrt(abs(m.a * m.d - m.b * m.c))
    }

    func measure(_ index: Int) -> ZnPathMeasure {
        if let m = measures[index] { return m }
        let m = ZnPathMeasure(paths[index])
        measures[index] = m
        return m
    }

    func length(_ index: Int) -> CGFloat { measure(index).lengths.reduce(0, +) * matrixScale(index) }

    /// The drawn length of all shapes before each op (a group's length is before[its end] - before[it]).
    var before: [CGFloat] {
        if !lengthsMade {
            lengthsMade = true
            var acc: CGFloat = 0
            _before = ops.map { op in
                let b = acc
                if case .shape(let s) = op { acc += length(s.index) }
                return b
            } + [0]
            _before[ops.count] = acc
        }
        return _before
    }
}
