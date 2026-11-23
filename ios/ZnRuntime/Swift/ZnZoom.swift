// useZoom() on iOS (core motion.ts; Android: ZnZoom.kt, ZnGesture.kt zoomContent / zoomBox / zoomAnimate /
// zoomDoubleTap / ZoomRec and the Motion function zoomTo). One native gesture with pinch around the fingers, drag inside
// the content's edges, a fling that stops at the edges, rubber bands and double tap (useZoom's tap gesture with `zoom`
// in its options: ZnTapRec). Not a UIScrollView zoom (docs/motion.md §14): scale, x and y are zn motion values that the
// app puts on its content, `transform: [{ translateX: zoom.x }, { translateY: zoom.y }, { scale: zoom.scale }]`.
//
// Everything is in points (= dp), in the element's own box (not moved by the zoom): the element is drawn at
// `c + (p - c) * scale + t`, where c is its centre and t is (x, y). Fingers come in the node's probe (inside its layer);
// zoomBox turns them back into the box with the node's own layer values (the identity when the transform is on a
// child, the usual way).
//
// One finger leaves the touch to the parent (a Carousel or paging List turns the page, a pan drags the screen down)
// when the content isn't zoomed, or when it drags sideways toward an edge the zoomed content already touches: the
// recognizer fails at the slop, so the hub's claim fails and the scroll that waited for it goes.
//
// Foundation only, so the Mac suite (ios/tests/gestures) runs it with Android's ZnZoomTest numbers.
import Foundation

/// The maths, pure (Android: ZnZoomMath, with the same rules and numbers).
enum ZnZoomMath {
    /// The content's size in a box of [w] × [h]: fitted inside it ("contain") for an [aspect] (w / h) > 0, else the box.
    static func fitted(_ w: Float, _ h: Float, _ aspect: Float) -> (Float, Float) {
        if !(aspect > 0) || !aspect.isFinite || w <= 0 || h <= 0 { return (w, h) }
        return w / h > aspect ? (h * aspect, h) : (w, w / aspect)
    }

    /// How far t may go each way on one axis: half of what the zoomed content is larger than the box (0 if smaller).
    static func range(_ content: Float, _ scale: Float, _ box: Float) -> Float { max(0, (content * scale - box) / 2) }

    /// t on one axis after the scale goes from [s] to [sNew] while the point [q] of the box stays under the fingers.
    /// [c]: the box centre. The content point under q is `c + (q - c - t) / s`; it must stay at q.
    static func around(_ s: Float, _ t: Float, _ q: Float, _ c: Float, _ sNew: Float) -> Float {
        if s == 0 { return t }
        let p = c + (q - c - t) / s
        return q - c - (p - c) * sNew
    }

    /// [t] held inside ±[r].
    static func clamp(_ t: Float, _ r: Float) -> Float { min(r, max(-r, t)) }

    /// [t] past ±[r] moves less and less (the rubber band); [dim] the box size along this axis.
    static func rubberT(_ t: Float, _ r: Float, _ dim: Float) -> Float {
        if t > r { return r + ZnGestureMath.rubber(t - r, dim) }
        if t < -r { return -r - ZnGestureMath.rubber(-r - t, dim) }
        return t
    }

    /// A scale past [lo] / [hi] moves less and less (half the pan's band, as the pinch's).
    static func rubberS(_ s: Float, _ lo: Float, _ hi: Float) -> Float {
        if s < lo { return lo - ZnGestureMath.rubber(lo - s, 1) * 0.5 }
        if s > hi { return hi + ZnGestureMath.rubber(s - hi, hi) * 0.5 }
        return s
    }

    /// Where a double tap at ([qx], [qy]) goes: zoomed in (above [lo] by 1%) → back to [lo] at the centre; else to
    /// [target] around the tapped point, kept inside the edges. Returns (scale, tx, ty).
    static func doubleTap(_ s: Float, _ tx: Float, _ ty: Float, _ qx: Float, _ qy: Float,
                          _ w: Float, _ h: Float, _ cw: Float, _ ch: Float, _ lo: Float, _ target: Float) -> (Float, Float, Float) {
        if s > lo * 1.01 { return (lo, 0, 0) }
        return zoomTo(s, tx, ty, qx, qy, w, h, cw, ch, target)
    }

    /// To [sNew] around ([qx], [qy]), then kept inside the edges. Returns (scale, tx, ty).
    static func zoomTo(_ s: Float, _ tx: Float, _ ty: Float, _ qx: Float, _ qy: Float,
                       _ w: Float, _ h: Float, _ cw: Float, _ ch: Float, _ sNew: Float) -> (Float, Float, Float) {
        let nx = around(s, tx, qx, w / 2, sNew)
        let ny = around(s, ty, qy, h / 2, sNew)
        return (sNew, clamp(nx, range(cw, sNew, w)), clamp(ny, range(ch, sNew, h)))
    }

    /// A point of the element (local, inside its own transform) in the box: `c + (p - c) * scale + t`.
    static func toBox(_ p: Float, _ c: Float, _ scale: Float, _ t: Float) -> Float { c + (p - c) * scale + t }
}

extension ZnGesture {
    /// A zoom moved by a double tap, zoomTo or a release past its limits: the three values in one tween (280 ms).
    static let zoomTween = ZnTimingSpec(ms: 280, easing: 0, bezier: nil, ratio: 1, stiffness: 0, clamp: false)

    /// The content's size (points) in the element now.
    func zoomContent() -> (Float, Float) { ZnZoomMath.fitted(selfW, selfH, zoomAspect?.resolve(0, 0, site) ?? 0) }

    /// A point of the element (local points, inside the node's own layer) in its box (not moved by the zoom).
    func zoomBox(_ lx: Float, _ ly: Float) -> (Float, Float) {
        guard let layer = layerNow?() ?? nil else { return (lx, ly) }
        let sx = layer.0.isFinite && layer.0 != 0 ? layer.0 : 1
        let sy = layer.1.isFinite && layer.1 != 0 ? layer.1 : 1
        return (ZnZoomMath.toBox(lx, selfW / 2, sx, layer.2), ZnZoomMath.toBox(ly, selfH / 2, sy, layer.3))
    }

    /// Animates the zoom to ([s], [tx], [ty]): one tween for the three, so the point zoomed around stays put on the
    /// way; "settle" when it rests. [sendEnd]: also "end" then (a zoom from JS, a double tap or VoiceOver, which have
    /// no finger lift; a pinch released past a limit sends its own "end" at the lift). [accessibility]: that "end" says
    /// so (VoiceOver's zoom in / out, as its tap and anchor actions). [resolve] gets {finished}.
    func zoomAnimate(_ s: Float, _ tx: Float, _ ty: Float, _ spec: ZnTimingSpec = zoomTween, sendEnd: Bool = true,
                     accessibility: Bool = false, _ resolve: (([String: Any]) -> Void)? = nil) {
        let parts: [(ZnMotionValue, Float)] = [(scale, s), (x, tx), (y, ty)].compactMap { v, to in v.map { ($0, to) } }
        var open = parts.count
        var finished = true
        // The tween before this one ends first (its "end" says cancelled), then this one's goal holds until it rests.
        for (v, _) in parts { v.interrupt() }
        zoomSeq += 1
        let seq = zoomSeq
        zoomGoal = parts.isEmpty ? nil : (s, tx, ty)
        let done = { [weak self] in
            guard let self else { return }
            if self.zoomSeq == seq { self.zoomGoal = nil }
            let at: [String: Any] = ["scale": Double(self.scale?.value ?? 1), "x": Double(self.x?.value ?? 0), "y": Double(self.y?.value ?? 0)]
            if sendEnd {
                var end = at
                end["cancelled"] = !finished
                if accessibility { end["accessibility"] = true }
                self.send("end", end)
            }
            self.send("settle", at)
            resolve?(["finished": finished])
        }
        if parts.isEmpty { return done() }
        for (v, to) in parts {
            v.velocity = 0
            move(v, to: to, spec) { ok in
                if !ok { finished = false }
                open -= 1
                if open == 0 { done() }
            }
        }
    }

    /// A double tap at ([bx], [by]) in the box: zoom in there, or back out.
    func zoomDoubleTap(_ bx: Float, _ by: Float) {
        guard zoomDouble > 0 else { return }
        let (cw, ch) = zoomContent()
        let (s, tx, ty) = ZnZoomMath.doubleTap(scale?.value ?? 1, x?.value ?? 0, y?.value ?? 0, bx, by, selfW, selfH, cw, ch,
                                               zoomMin, min(max(zoomDouble, zoomMin), zoomMax))
        zoomAnimate(s, tx, ty)
    }

    /// Zoom in at the centre (VoiceOver's "zoom in": its users can't pinch): to the double tap's scale, else the most.
    func zoomInAtCentre() {
        let (cw, ch) = zoomContent()
        let to = min(max(zoomDouble > 0 ? zoomDouble : zoomMax, zoomMin), zoomMax)
        let (s, tx, ty) = ZnZoomMath.zoomTo(scale?.value ?? 1, x?.value ?? 0, y?.value ?? 0, selfW / 2, selfH / 2, selfW, selfH, cw, ch, to)
        zoomAnimate(s, tx, ty, accessibility: true)
    }

    /// VoiceOver's "zoom out": back to the least scale, centred.
    func zoomOutForA11y() { zoomAnimate(zoomMin, 0, 0, accessibility: true) }
}

extension ZnGestures {
    /// useZoom's zoomTo / reset: {"id", "s": scale, "x"?, "y"? (the point to zoom around, points in the element;
    /// default its centre), "t"?: timing}. Kept inside the edges. A touch in progress is cancelled (as snapTo).
    /// Answers {finished}.
    static func zoomTo(_ args: [String: Any], _ resolve: @escaping ([String: Any]) -> Void) throws {
        let id = Int(znJsonNumber(args["id"]) ?? -1)
        guard let g = find(id)?.leaves.first(where: { $0.kind == ZnGesture.zoom }) else {
            throw ZnInvalidArgs("gesture \(id) is not a useZoom")
        }
        g.touch?.cancel()
        let (cw, ch) = g.zoomContent()
        let want = znJsonNumber(args["s"]).map { Float($0) } ?? 1
        let s = want.isFinite ? min(max(want, g.zoomMin), g.zoomMax) : g.zoomMin
        let qx = znJsonNumber(args["x"]).map { Float($0) } ?? g.selfW / 2
        let qy = znJsonNumber(args["y"]).map { Float($0) } ?? g.selfH / 2
        let (ns, tx, ty) = ZnZoomMath.zoomTo(g.scale?.value ?? 1, g.x?.value ?? 0, g.y?.value ?? 0, qx, qy, g.selfW, g.selfH, cw, ch, s)
        let spec = try (args["t"] as? [String: Any]).map { try ZnTimingSpec.parse($0) } ?? ZnGesture.zoomTween
        g.zoomAnimate(ns, tx, ty, spec, resolve)
    }
}

/// useZoom's recognizer (Android: ZoomRec): pinch around the fingers, drag inside the content's edges, fling that
/// stops at the edges, rubber bands. Works in the element's box, so the fingers stay on the same spot of the picture.
final class ZnZoomRec: ZnRecognizer {
    private var rawS: Float = 1  // before the rubber band
    private var rawX: Float = 0, rawY: Float = 0
    private var movedX: Float = 0, movedY: Float = 0  // before it starts
    private var spreadMoved: Float = 0
    private var lastQx: Float = 0, lastQy: Float = 0  // the fingers' centre in the box
    private var lastCount = 0
    private var vt = ZnVelocityTracker()

    override func onEvent(_ e: ZnPointerEvent) {
        let w = g.selfW, h = g.selfH
        // The lift is a speed sample (UIKit sends no moves for a still finger: one held and then lifted has no speed).
        if state == znActive, e.changes.contains(where: { !$0.pressed && $0.previousPressed }) {
            vt.add(e.time, g.x?.value ?? 0, g.y?.value ?? 0)
        }
        // Fingers down in both this event and the one before (one that just landed or lifted moves nothing).
        var n = 0
        var x0: Float = 0, y0: Float = 0, x1: Float = 0, y1: Float = 0
        var a = (Float(0), Float(0), Float(0), Float(0)), b = a  // the first two, for the spread
        for c in e.changes where c.pressed && c.previousPressed {
            let (px0, py0) = g.zoomBox(c.px, c.py)
            let (px1, py1) = g.zoomBox(c.x, c.y)
            if n == 0 { a = (px0, py0, px1, py1) }
            if n == 1 { b = (px0, py0, px1, py1) }
            x0 += px0; y0 += py0; x1 += px1; y1 += py1
            n += 1
        }
        if n == 0 { return }
        let fn = Float(n)
        x0 /= fn; y0 /= fn; x1 /= fn; y1 /= fn
        var k: Float = 1
        if n >= 2 {
            let d0 = hypot(a.0 - b.0, a.1 - b.1)
            let d1 = hypot(a.2 - b.2, a.3 - b.3)
            spreadMoved += abs(d1 - d0)
            if d0 > 1 { k = d1 / d0 }
        }
        if state == znPossible {
            if wants { return }
            movedX += x1 - x0
            movedY += y1 - y0
            let slop = ZnGestureMath.slop
            if n >= 2 {
                if spreadMoved > slop || hypot(movedX, movedY) > slop { wants = true }
                return
            }
            if hypot(movedX, movedY) <= slop { return }
            // A double tap (or zoomTo) still on its way decides by where it goes: read halfway, a zoom in would still
            // look "not zoomed" and the Carousel would turn the page under a photo that is zooming in. (Waiting for
            // the tween doesn't work: UIKit's paging scroll doesn't wait that long for the hub's claim.)
            let goal = g.zoomGoal
            let s = goal?.s ?? g.scale?.value ?? 1
            // Not zoomed: one finger belongs to the parent (next photo, drag down to close).
            if s <= g.zoomMin * 1.01 {
                ZnGestures.trace?("\(g.id) zoom: not zoomed, one finger: the parent's")
                return fail()
            }
            // Zoomed, at the edge it drags toward: the parent turns the page.
            if abs(movedX) > abs(movedY) {
                let r = ZnZoomMath.range(g.zoomContent().0, s, w)
                let t = goal?.x ?? g.x?.value ?? 0
                if (movedX > 0 && t >= r - 0.5) || (movedX < 0 && t <= -r + 0.5) {
                    ZnGestures.trace?("\(g.id) zoom: at the edge it drags toward: the parent's")
                    return fail()
                }
            }
            wants = true
            return
        }
        guard state == znActive else { return }
        if n != lastCount {
            // A finger landed or lifted: the speed so far was a pinch, not a drag.
            vt.reset()
            lastCount = n
        }
        let nS = rawS * k
        rawX = ZnZoomMath.around(rawS, rawX, x0, w / 2, nS) + (x1 - x0)
        rawY = ZnZoomMath.around(rawS, rawY, y0, h / 2, nS) + (y1 - y0)
        rawS = nS
        lastQx = x1
        lastQy = y1
        let s = g.rubber ? ZnZoomMath.rubberS(rawS, g.zoomMin, g.zoomMax) : min(max(rawS, g.zoomMin), g.zoomMax)
        let (cw, ch) = g.zoomContent()
        let rx = ZnZoomMath.range(cw, s, w), ry = ZnZoomMath.range(ch, s, h)
        let tx = g.rubber ? ZnZoomMath.rubberT(rawX, rx, w) : ZnZoomMath.clamp(rawX, rx)
        let ty = g.rubber ? ZnZoomMath.rubberT(rawY, ry, h) : ZnZoomMath.clamp(rawY, ry)
        g.scale?.value = s
        g.x?.value = tx
        g.y?.value = ty
        vt.add(e.time, tx, ty)
        if g.events.contains("update") { g.send("update", ["scale": Double(s), "x": Double(tx), "y": Double(ty)]) }
    }

    override func activate() {
        let values = [g.scale, g.x, g.y].compactMap { $0 }
        let goal = g.zoomGoal
        for v in values { v.heldBy = g.touch }
        for v in values { v.interrupt() }
        // A zoom tween under way (it decided at the slop): the fingers take it from where it was going.
        if let goal {
            g.scale?.value = goal.s
            g.x?.value = goal.x
            g.y?.value = goal.y
        }
        rawS = g.scale?.value ?? 1
        rawX = g.x?.value ?? 0
        rawY = g.y?.value ?? 0
        lastQx = g.selfW / 2
        lastQy = g.selfH / 2
        lastCount = 0
        vt.reset()
        g.send("start", ["scale": Double(rawS)])
    }

    override func finish(_ cancelled: Bool) {
        for v in [g.scale, g.x, g.y] { if let v, v.heldBy === g.touch { v.heldBy = nil } }
        guard state == znActive else { return }
        state = znDone
        let w = g.selfW, h = g.selfH
        let s = g.scale?.value ?? 1, tx = g.x?.value ?? 0, ty = g.y?.value ?? 0
        let (cw, ch) = g.zoomContent()
        let inS = min(max(s, g.zoomMin), g.zoomMax)
        let end: [String: Any] = ["scale": Double(s), "x": Double(tx), "y": Double(ty), "cancelled": cancelled]
        var settleNow: (() -> Void)?
        defer { settleNow?() }  // after "finalize", as Android's coroutine answers
        if inS != s || cancelled {
            // Pinched past a limit: back inside it, around where the fingers were, and inside the edges. "end" now, at
            // the lift; "settle" once it is back inside.
            let (ns, nx, ny) = ZnZoomMath.zoomTo(s, tx, ty, lastQx, lastQy, w, h, cw, ch, inS)
            g.send("end", end)
            g.zoomAnimate(ns, nx, ny, sendEnd: false)
        } else {
            let vel = lastCount <= 1 ? vt.velocity() : (x: Float(0), y: Float(0))
            let zoomed = s > g.zoomMin * 1.01
            let friction = znFriction(znJsonNumber(g.release["deceleration"]) ?? 0.998)
            let spring = (try? ZnTimingSpec.parse(g.release["spring"] as? [String: Any])) ?? .spring
            g.send("end", end)
            var open = 0
            var started = false
            let g = g
            let settled = {
                g.send("settle", ["scale": Double(g.scale?.value ?? 1), "x": Double(g.x?.value ?? 0), "y": Double(g.y?.value ?? 0)])
            }
            func go(_ v: ZnMotionValue?, _ t: Float, _ r: Float, _ speed: Float) {
                guard let v else { return }
                let inside = ZnZoomMath.clamp(t, r)
                let step: ZnStep
                if inside != t || !zoomed {
                    // Past an edge (the rubber band), or not zoomed: back inside.
                    v.velocity = 0
                    step = .to(zoomed ? inside : 0, spring, delayMs: 0)
                } else if abs(speed) > 50 {
                    // A fling: slows down and stops at the edge.
                    step = .decay(v: speed, f: friction, lo: -r, hi: r, delayMs: 0)
                } else {
                    return
                }
                open += 1
                g.move(v, [step]) { _ in
                    open -= 1
                    if open == 0 && started { settled() }
                }
            }
            go(g.x, tx, ZnZoomMath.range(cw, s, w), vel.x)
            go(g.y, ty, ZnZoomMath.range(ch, s, h), vel.y)
            started = true
            // Nothing to move (or done at once): "settle" right after "finalize".
            if open == 0 { settleNow = settled }
        }
        g.send("finalize")
    }
}
