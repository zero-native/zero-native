// <Svg> on iOS (docs/svg.md §8), as android/runtime's ZnSvg composable: a view that draws the parsed draw data
// (ZnSvgDraw.swift), with `color` as currentColor and its <SvgPart> children's values (znSvgParts in ZnSvg.kt): each
// value is the template's, a slot's, or animated (ZnAnimation.swift). On iOS every part animation runs on the frame
// clock (ZnMotion), as the Canvas reads the values itself: those that follow JS (a tween or spring to each new
// value) as well as those that play by themselves (from / keyframes; SMIL and CSS animations from .svg files).
// Timings that wait for a tap (SMIL begin="click") start on a tap on the Svg, and again on each tap; the tap is
// only counted, so a Pressable around the Svg still gets it.
import SwiftUI

struct ZnSvgView: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec

    @State private var motion = ZnMotion()
    @State private var taps = 0
    @Environment(\.layoutDirection) private var direction

    /// The animatable values of a part, keyed part position × 32 + this.
    private enum K: Int, CaseIterable {
        case fill, stroke, opacity, rotate, scale, scaleX, scaleY, translateX, translateY, trimStart, trimEnd, trimOffset
        case strokeWidth, dashOffset, morphAt, skewX, skewY, motionAt

        var prop: Int {
            typealias P = Registry.Prop
            switch self {
            case .fill: return P.fill
            case .stroke: return P.stroke
            case .opacity: return P.opacity
            case .rotate: return P.rotate
            case .scale: return P.scale
            case .scaleX: return P.scaleX
            case .scaleY: return P.scaleY
            case .translateX: return P.translateX
            case .translateY: return P.translateY
            case .trimStart: return P.trimStart
            case .trimEnd: return P.trimEnd
            case .trimOffset: return P.trimOffset
            case .strokeWidth: return P.strokeWidth
            case .dashOffset: return P.dashOffset
            case .morphAt: return P.morphAt
            case .skewX: return P.skewX
            case .skewY: return P.skewY
            case .motionAt: return P.motionAt
            }
        }
    }

    private static func key(_ i: Int, _ k: K) -> Int { i * 32 + k.rawValue }

    /// The SvgPart children, by part index.
    private var parts: [ZnNodeSpec] {
        s.children.map { t.nodes[$0] }.filter { $0.type == Registry.Component.svgPart && $0.part >= 0 }.sorted { $0.part < $1.part }
    }

    /// A part value's resting value now: the slot's, else the template's (nil: no override / not set).
    @MainActor private func rest(_ p: ZnNodeSpec, _ k: K) -> [Double]? {
        func n(_ slot: Int, _ v: CGFloat) -> [Double]? {
            let x = slot >= 0 ? inst.slot(slot).value.number ?? Double(v) : Double(v)
            return x.isNaN ? nil : [x]
        }
        func c(_ slot: Int, _ v: UInt32?) -> [Double]? {
            if slot >= 0, let x = znColorVector(inst.slot(slot).value) { return x }
            return v.flatMap { znColorVector(.color($0)) }
        }
        switch k {
        case .fill: return c(p.fillSlot, p.fill)
        case .stroke: return c(p.strokeSlot, p.stroke)
        case .opacity: return n(p.opacitySlot, CGFloat(p.opacity))
        case .rotate: return n(p.rotateSlot, p.rotate)
        case .scale: return n(p.scaleSlot, p.scaleBase)
        case .scaleX: return n(p.scaleXSlot, p.scaleXOnly)
        case .scaleY: return n(p.scaleYSlot, p.scaleYOnly)
        case .translateX: return n(p.translateXSlot, p.translateX)
        case .translateY: return n(p.translateYSlot, p.translateY)
        case .trimStart: return n(p.trimStartSlot, p.trimStart)
        case .trimEnd: return n(p.trimEndSlot, p.trimEnd)
        case .trimOffset: return n(p.trimOffsetSlot, p.trimOffset)
        case .strokeWidth: return n(p.strokeWidthSlot, p.strokeWidth)
        case .dashOffset: return n(p.dashOffsetSlot, p.dashOffset)
        case .morphAt: return n(-1, p.morphAt)
        case .skewX: return n(-1, p.skewX)
        case .skewY: return n(-1, p.skewY)
        case .motionAt: return n(-1, p.motionAt)
        }
    }

    private struct Plan {
        var rests: [Int: [Double]] = [:]
        var playing: [Int: ZnTiming] = [:]  // play by themselves
        var following: [Int: ZnTiming] = [:]  // follow JS
        var waiting = Set<Int>()  // wait for a tap
        var keysOfPart: [[Int]] = []
    }

    @MainActor private func plan(_ specs: [ZnNodeSpec]) -> Plan {
        var pl = Plan()
        for (i, p) in specs.enumerated() {
            var keys: [Int] = []
            for k in K.allCases {
                let key = Self.key(i, k)
                let timing = p.animate?.timing(k.prop)
                var r = rest(p, k)
                // A colour animation needs a colour to start from: transparent when the part has none.
                if r == nil, (k == .fill || k == .stroke), timing?.selfPlaying == true { r = [0, 0, 0, 0] }
                if let r { pl.rests[key] = r }
                if let timing {
                    if timing.selfPlaying { pl.playing[key] = timing } else { pl.following[key] = timing }
                    if timing.waitsForTap { pl.waiting.insert(key) }
                }
                keys.append(key)
            }
            pl.keysOfPart.append(keys)
        }
        return pl
    }

    @MainActor private func now(_ specs: [ZnNodeSpec], _ pl: Plan) -> [Int: ZnSvgPartNow] {
        var out: [Int: ZnSvgPartNow] = [:]
        for (i, p) in specs.enumerated() {
            // Waiting for its first tap: the resting value.
            func v(_ k: K) -> [Double]? {
                let key = Self.key(i, k)
                if pl.waiting.contains(key) && taps == 0 { return pl.rests[key] }
                return motion.values[key] ?? pl.rests[key]
            }
            func x(_ k: K, _ d: CGFloat) -> CGFloat { v(k)?.first.map { CGFloat($0) } ?? d }
            func argb(_ k: K) -> UInt32? {
                guard let c = v(k), c.count == 4 else { return nil }
                let b = c.map { UInt32(min(max($0, 0), 1) * 255 + 0.5) }
                return b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]
            }
            var n = ZnSvgPartNow()
            n.fill = argb(.fill)
            n.stroke = argb(.stroke)
            n.opacity = x(.opacity, 1)
            n.rotate = x(.rotate, 0)
            n.scaleX = x(.scale, 1) * x(.scaleX, 1)
            n.scaleY = x(.scale, 1) * x(.scaleY, 1)
            n.translateX = x(.translateX, 0)
            n.translateY = x(.translateY, 0)
            n.pivot = CGPoint(x: p.pivotX, y: p.pivotY)
            if p.hasTrim { n.trim = (x(.trimStart, 0), x(.trimEnd, 1), x(.trimOffset, 0)) }
            n.strokeWidth = x(.strokeWidth, .nan)
            n.dashOffset = x(.dashOffset, .nan)
            n.scaleOutline = p.scaleOutline
            n.morph = p.morph.flatMap(ZnSvgParsed.morph)
            n.morphAt = x(.morphAt, -1)
            n.skewX = x(.skewX, 0)
            n.skewY = x(.skewY, 0)
            n.frame = p.frame.flatMap(ZnSvgParsed.frame)
            n.motion = p.motionPath.flatMap(ZnSvgParsed.motion)
            n.motionAt = x(.motionAt, -1)
            n.trimCaps = p.trimCaps
            out[p.part] = n
        }
        return out
    }

    var body: some View {
        let specs = parts
        let pl = plan(specs)
        let current = (s.colorSlot >= 0 ? znColorVectorARGB(inst.slot(s.colorSlot).value) : nil)
            ?? s.props[Registry.Prop.color].flatMap(znColorVectorARGB) ?? 0xFF00_0000
        let svgPaused = s.pausedSlot >= 0 ? inst.slot(s.pausedSlot).value == .bool(true) : s.paused
        let svgReplay = s.replaySlot >= 0 ? inst.slot(s.replaySlot).value : .null
        let partPaused = specs.map { p in svgPaused || (p.pausedSlot >= 0 ? inst.slot(p.pausedSlot).value == .bool(true) : p.paused) }
        let partReplay = specs.map { p in p.replaySlot >= 0 ? inst.slot(p.replaySlot).value : .null }
        let values = now(specs, pl)
        let mirror = s.autoMirror && direction == .rightToLeft
        let data = s.svg
        let sizedByStack = s.absolute && ((s.hasPosStart && s.hasPosEnd) || (s.hasPosTop && s.hasPosBottom))
        let unsized = !s.hasWidth && !s.hasHeight && !s.hasAspectRatio && !sizedByStack
        ZnSvgCanvas(drawing: data.flatMap(ZnSvgCache.get), current: current, mirror: mirror, parts: values,
                    onTap: pl.waiting.isEmpty ? nil : {
            taps += 1
            let started = pl.playing.filter { pl.waiting.contains($0.key) }
            print("zn t=\(ZnDebug.ms()) svg: tap \(taps) starts \(started.count) animation(s)")
            motion.start(keys: started, rests: pl.rests)
        })
        .frame(width: unsized ? 24 : nil, height: unsized ? 24 : nil)
        .modifier(ZnAspect(ratio: s.aspectRatioNow(inst)))
        .onAppear {
            motion.start(pl.playing.filter { !pl.waiting.contains($0.key) }, rests: pl.rests, paused: false)
            for (i, keys) in pl.keysOfPart.enumerated() where partPaused[i] { motion.setPaused(true, keys: Set(keys)) }
        }
        .onDisappear { motion.stop() }
        .onChange(of: pl.rests) { old, new in
            for (key, timing) in pl.following {
                guard let to = new[key], old[key] != to else { continue }
                motion.follow(key, from: old[key] ?? to, to: to, timing: timing)
            }
            for (key, to) in new where pl.playing[key] != nil && old[key] != to { motion.restChanged(key, to: to) }
        }
        .onChange(of: partPaused) { old, new in
            for (i, p) in new.enumerated() where i < old.count && old[i] != p { motion.setPaused(p, keys: Set(pl.keysOfPart[i])) }
        }
        .onChange(of: partReplay) { old, new in
            for (i, r) in new.enumerated() where i < old.count && old[i] != r {
                let keys = Set(pl.keysOfPart[i])
                motion.start(keys: pl.playing.filter { keys.contains($0.key) && !(pl.waiting.contains($0.key) && taps == 0) }, rests: pl.rests)
            }
        }
        .onChange(of: svgReplay) {
            motion.start(keys: pl.playing.filter { !(pl.waiting.contains($0.key) && taps == 0) }, rests: pl.rests)
        }
    }
}

private struct ZnAspect: ViewModifier {
    let ratio: CGFloat?
    func body(content: Content) -> some View {
        if let ratio { content.aspectRatio(ratio, contentMode: .fit) } else { content }
    }
}

/// A colour value as ARGB.
func znColorVectorARGB(_ v: ZnValue) -> UInt32? {
    switch v {
    case .color(let c): return c
    case .number(let n): return UInt32(truncatingIfNeeded: Int64(n))
    default: return nil
    }
}

/// Part strings parsed once (main thread).
@MainActor
enum ZnSvgParsed {
    private static var morphs: [String: ZnSvgMorph?] = [:]
    private static var motions: [String: ZnSvgMotionPath?] = [:]
    private static var frames: [String: CGAffineTransform?] = [:]

    static func morph(_ s: String) -> ZnSvgMorph? {
        if let m = morphs[s] { return m }
        let m = ZnSvgMorph.parse(s)
        morphs[s] = m
        return m
    }

    static func motion(_ s: String) -> ZnSvgMotionPath? {
        if let m = motions[s] { return m }
        let m = ZnSvgMotionPath.parse(s)
        motions[s] = m
        return m
    }

    static func frame(_ s: String) -> CGAffineTransform? {
        if let m = frames[s] { return m }
        let m = znSvgFrame(s)
        frames[s] = m
        return m
    }
}


/// Draws the SVG with Core Graphics in a plain UIView (draw(_:), redrawn on each change). Not a SwiftUI Canvas: a
/// Canvas whose content is only Core Graphics drawing, and whose first frame drew nothing, didn't show its later
/// frames (2026-11-08: the Wifi loader, all its parts at opacity 0 at first, stayed blank).
struct ZnSvgCanvas: UIViewRepresentable {
    let drawing: ZnSvgDrawing?
    let current: UInt32
    let mirror: Bool
    let parts: [Int: ZnSvgPartNow]
    /// Timings that wait for a tap: a tap inside the Svg (ZnSvgTaps).
    let onTap: (() -> Void)?

    final class View: UIView {
        var onTap: (() -> Void)? {
            didSet { if onTap == nil { ZnSvgTaps.shared.remove(self) } else { ZnSvgTaps.shared.add(self) } }
        }
        var drawing: ZnSvgDrawing?
        var current: UInt32 = 0xFF00_0000
        var mirror = false
        var parts: [Int: ZnSvgPartNow] = [:]

        override func draw(_ rect: CGRect) {
            guard let drawing, let cg = UIGraphicsGetCurrentContext() else { return }
            drawing.draw(cg, size: bounds.size, current: current, mirror: mirror, parts: parts)
        }
    }

    func makeUIView(context: Context) -> View {
        let v = View()
        v.isOpaque = false
        v.backgroundColor = .clear
        v.contentMode = .redraw
        v.isUserInteractionEnabled = false
        return v
    }

    func updateUIView(_ v: View, context: Context) {
        v.drawing = drawing
        v.current = current
        v.mirror = mirror
        v.parts = parts
        v.onTap = onTap
        v.setNeedsDisplay()
    }
}

/// Taps on Svgs whose animations wait for one (SMIL begin="click"): counted, never taken. A Pressable is a UIKit view
/// over its content, so the Svg under it never gets the touch: one tap recognizer on the window sees every tap
/// without cancelling or delaying any touch, and tells the Svgs it landed in.
@MainActor
final class ZnSvgTaps: NSObject, UIGestureRecognizerDelegate {
    static let shared = ZnSvgTaps()
    private var views: [ObjectIdentifier: WeakView] = [:]
    private weak var window: UIWindow?
    private final class WeakView { weak var view: ZnSvgCanvas.View?; init(_ v: ZnSvgCanvas.View) { view = v } }

    func add(_ v: ZnSvgCanvas.View) {
        views[ObjectIdentifier(v)] = WeakView(v)
        install()
    }

    func remove(_ v: ZnSvgCanvas.View) { views[ObjectIdentifier(v)] = nil }

    private func install() {
        guard window == nil, let w = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .flatMap(\.windows).first(where: \.isKeyWindow) else { return }
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
        tap.cancelsTouchesInView = false
        tap.delaysTouchesBegan = false
        tap.delaysTouchesEnded = false
        tap.delegate = self
        w.addGestureRecognizer(tap)
        window = w
    }

    @objc private func tapped(_ g: UITapGestureRecognizer) {
        views = views.filter { $0.value.view != nil }
        for v in views.values.compactMap(\.view) where v.window != nil {
            if v.bounds.contains(g.location(in: v)) { v.onTap?() }
        }
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
