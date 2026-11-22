// The recognizers, the arbiter and one node's touch session (Android: ZnGesture.kt PanRec ... FlingRec, ZnArbiter, and
// the pointer loop of Modifier.znGesture). Fed with ZnPointerEvent, Compose's PointerEvent in points: the hub
// (ZnGestureHub.swift) makes them from UITouches, the Mac suite (ios/tests/gestures) from made-up touch streams.
// Foundation only. Main thread only.
//
// One difference from Android: a pan moves by the finger's movement in the window (Android: in the node, turned back
// by the node's own scale and rotation into its parent). The two are the same unless an ancestor is scaled or turned.
import Foundation

/// One finger in an event: its place in the node (points, [x], [y]) and in the window ([wx], [wy]), now and in the
/// event before, whether it is down now and was before, and the event's time (ms since boot).
struct ZnPointerChange {
    let id: Int
    var x: Float, y: Float, px: Float, py: Float
    var wx: Float, wy: Float, pwx: Float, pwy: Float
    var pressed: Bool, previousPressed: Bool
    var t: Int64
}

/// What every recognizer of a node sees at once. [consumed]: a gesture of an inner node (or one before it in the
/// order), or someone else (a scroll that started), used this event: a consuming recognizer that hasn't started gives
/// up the touch.
struct ZnPointerEvent {
    var changes: [ZnPointerChange]
    var consumed = false

    var time: Int64 { changes.map(\.t).max() ?? 0 }
    var nonePressed: Bool { !changes.contains { $0.pressed } }
    var pressedCount: Int { changes.filter(\.pressed).count }

    /// The centre of the fingers down both now and before, in the window, now or ([previous]) before.
    func centroid(previous: Bool) -> (Float, Float)? {
        var x: Float = 0, y: Float = 0, n: Float = 0
        for c in changes where c.pressed && c.previousPressed {
            x += previous ? c.pwx : c.wx
            y += previous ? c.pwy : c.wy
            n += 1
        }
        return n == 0 ? nil : (x / n, y / n)
    }
}

let znPossible = 0, znActive = 1, znFailed = 2, znDone = 3

class ZnRecognizer {
    let g: ZnGesture
    var state = znPossible
    /// It met its conditions and waits for the arbiter (exclusive: until the ones before it fail).
    var wants = false
    /// Continuous gestures take the touch once active (the parent scroll stops).
    var consumes: Bool { true }
    /// Ends when the fingers lift (pan, pinch, rotate, long press); tap and fling are decided at the lift.
    var continuous: Bool { true }
    /// Still waiting for more touches (a double tap between its taps).
    var waitsForMore: Bool { false }

    init(_ g: ZnGesture) { self.g = g }

    /// Uptime ms when it needs [tick], or Int64.max.
    func deadline() -> Int64 { .max }
    func onEvent(_ e: ZnPointerEvent) {}
    func tick(_ now: Int64) {}
    /// The arbiter made it active.
    func activate() {}
    /// The touch ended (all fingers up) or was cancelled / taken by someone else.
    func finish(_ cancelled: Bool) {}

    func fail() {
        if state == znPossible { state = znFailed }
        wants = false
    }
}

private func outside(_ r: [Float]?, _ v: Float) -> Bool {
    guard let r else { return false }
    return (!r[0].isNaN && v < r[0]) || (!r[1].isNaN && v > r[1])
}

/// Pan (RNGH Pan): x / y follow the finger, with bounds, rubber edges, magnets; releases to anchors or decays.
final class ZnPanRec: ZnRecognizer {
    private let downAt: Int64
    private var tx: Float = 0, ty: Float = 0  // total movement since down, for activation
    private var rawX: Float = 0, rawY: Float = 0  // before bounds / magnets
    private var startX: Float = 0, startY: Float = 0
    private var vt = ZnVelocityTracker()
    private var trackX: Float = 0, trackY: Float = 0  // points travelled, for the velocity tracker
    private var crossedSide: [Bool]
    private let longPressMs: Int64
    private let minPointers: Int, maxPointers: Int
    private let minDist: Float
    private let failX: [Float]?, failY: [Float]?, activeX: [Float]?, activeY: [Float]?

    init(_ g: ZnGesture, downAt: Int64) {
        self.downAt = downAt
        longPressMs = Int64(znJsonNumber(g.o["activateAfterLongPress"]) ?? 0)
        minPointers = Int(znJsonNumber(g.o["minPointers"]) ?? 1)
        maxPointers = Int(znJsonNumber(g.o["maxPointers"]) ?? 10)
        minDist = Float(znJsonNumber(g.o["minDistance"]) ?? -1)
        func range(_ name: String) -> [Float]? {
            guard let a = g.o[name] as? [Any] else { return nil }
            return [0, 1].map { i in i < a.count ? Float(znJsonNumber(a[i]) ?? .nan) : .nan }
        }
        failX = range("failOffsetX"); failY = range("failOffsetY")
        activeX = range("activeOffsetX"); activeY = range("activeOffsetY")
        // Which side of each threshold it starts on.
        let pos = g.axis == ZnGesture.axisY ? g.y?.value ?? 0 : g.x?.value ?? 0
        crossedSide = g.crosses.map { pos >= $0 }
        super.init(g)
    }

    override func deadline() -> Int64 { longPressMs > 0 && state == znPossible && !wants ? downAt + longPressMs : .max }

    override func tick(_ now: Int64) {
        if longPressMs > 0 && state == znPossible && now >= downAt + longPressMs { wants = true }
    }

    override func onEvent(_ e: ZnPointerEvent) {
        let now = e.centroid(previous: false), before = e.centroid(previous: true)
        let count = e.pressedCount
        // The finger's place in the element, also before the pan starts (a dial turns from the first touch).
        if let c = e.changes.first(where: \.pressed) {
            g.touchX?.value = c.x
            g.touchY?.value = c.y
        }
        if state == znPossible && count > maxPointers { return fail() }
        if let now, let before {
            let dx = now.0 - before.0, dy = now.1 - before.1
            tx += dx
            ty += dy
            if state == znActive { move(dx, dy, e) }
        }
        if state != znPossible || wants { return }
        if count < minPointers { return }
        let slop = minDist >= 0 ? minDist : ZnGestureMath.slop
        if longPressMs > 0 {
            // Long press first: moving before the time is up means it was a scroll or a swipe, not this.
            if hypot(tx, ty) > slop { fail() }
            return
        }
        if outside(failX, tx) || outside(failY, ty) { return fail() }
        if activeX != nil || activeY != nil {
            if outside(activeX, tx) || outside(activeY, ty) { wants = true }
            return
        }
        switch g.axis {
        case ZnGesture.axisX: if abs(tx) > slop && abs(tx) > abs(ty) { wants = true } else if abs(ty) > slop { fail() }
        case ZnGesture.axisY: if abs(ty) > slop && abs(ty) > abs(tx) { wants = true } else if abs(tx) > slop { fail() }
        default: if hypot(tx, ty) > slop { wants = true }
        }
    }

    override func activate() {
        g.detach()
        // The finger takes the values where they are (an animation running on them stops; JS's promise says
        // finished: false). Movement counts from here, so nothing jumps by the touch slop.
        for v in [g.x, g.y] {
            guard let v else { continue }
            v.interrupt()
            v.heldBy = g.touch
        }
        startX = g.x?.value ?? 0
        startY = g.y?.value ?? 0
        rawX = startX
        rawY = startY
        trackX = 0
        trackY = 0
        if longPressMs > 0 { g.play("longPress", "medium") }
        g.play("start")
        g.send("start", ["x": Double(startX), "y": Double(startY)])
    }

    private func bounded(_ raw: Float, _ onX: Bool) -> Float {
        let lo = g.lo(onX), hi = g.hi(onX)
        let dim = onX ? g.selfW : g.selfH
        if let lo, raw < lo { return g.rubber ? lo - ZnGestureMath.rubber(lo - raw, dim) : lo }
        if let hi, raw > hi { return g.rubber ? hi + ZnGestureMath.rubber(raw - hi, dim) : hi }
        return raw
    }

    private func move(_ dx: Float, _ dy: Float, _ e: ZnPointerEvent) {
        if g.axis != ZnGesture.axisY { rawX += dx }
        if g.axis != ZnGesture.axisX { rawY += dy }
        trackX += dx
        trackY += dy
        vt.add(e.time, trackX, trackY)
        var sx = bounded(rawX, true), sy = bounded(rawY, false)
        // Magnets pull it toward their centre, more the closer it is.
        for m in g.magnets {
            let cx = g.resolve(m.x, true), cy = g.resolve(m.y, false)
            let dist = hypot(sx - cx, sy - cy)
            let inside = dist <= m.radius
            if inside {
                let s = (1 - dist / m.radius) * m.pull
                sx += (cx - sx) * s
                sy += (cy - sy) * s
            }
            if inside != m.inside {
                m.inside = inside
                if inside { g.play("magnet", "light") }
                g.send("magnet", ["id": m.id, "inside": inside])
            }
        }
        g.x?.value = sx
        g.y?.value = sy
        // Thresholds crossed on the axis (onCross), each way once per crossing.
        let pos = g.axis == ZnGesture.axisY ? sy : sx
        for (i, at) in g.crosses.enumerated() {
            let past = pos >= at
            if past != crossedSide[i] {
                crossedSide[i] = past
                g.play("cross")
                g.send("cross", ["at": Double(at), "forward": past])
            }
        }
        if g.events.contains("update") { g.send("update", ["x": Double(sx), "y": Double(sy)]) }
        // Drop zones: which one the finger is over, in the window (the boxes come from useElementMotion).
        if !g.dropZones.isEmpty, let c = e.changes.first(where: \.pressed) {
            let z = g.zoneAt(c.wx, c.wy)
            if z != g.zone {
                g.zone = z
                if z >= 0 { g.play("zone", "light") }
                g.send("zone", ["zone": z >= 0 ? z as Any : NSNull()])
            }
        }
    }

    override func finish(_ cancelled: Bool) {
        for v in [g.x, g.y] { if let v, v.heldBy === g.touch { v.heldBy = nil } }
        guard state == znActive else { return }
        state = znDone
        let vel = vt.velocity()
        let vx = g.axis == ZnGesture.axisY ? 0 : vel.x
        let vy = g.axis == ZnGesture.axisX ? 0 : vel.y
        let px = g.x?.value ?? 0, py = g.y?.value ?? 0
        for m in g.magnets { m.inside = false }
        if cancelled {
            g.send("end", ["x": Double(px), "y": Double(py), "cancelled": true])
            g.send("finalize")
            return
        }
        let target = g.chooseTarget(px, py, vx, vy, startX, startY)
        if target != nil { g.play("snap") }
        var end: [String: Any] = ["x": Double(px), "y": Double(py), "vx": Double(vx), "vy": Double(vy), "cancelled": false]
        if !g.dropZones.isEmpty { end["zone"] = g.zone >= 0 ? g.zone as Any : NSNull() }
        if let t = target {
            end["anchor"] = t.id
            if let x = t.x { end["toX"] = Double(x) }
            if let y = t.y { end["toY"] = Double(y) }
        }
        g.send("end", end)
        // Android's settle answers from a coroutine, so "settle" always comes after "finalize", even with nothing to move.
        g.send("finalize")
        let g = g
        g.settle(target, vx, vy) { anchor in g.send("settle", ["anchor": anchor as Any? ?? NSNull()]) }
    }
}

/// Pinch (RNGH Pinch): scale from the finger spread, focal point; springs back inside min / max on release.
final class ZnPinchRec: ZnRecognizer {
    private var dist0: Float = 0
    private var s0: Float = 1
    private let min: Float, max: Float
    var lastEvent: ZnPointerEvent?

    override init(_ g: ZnGesture) {
        min = Float(znJsonNumber(g.o["min"]) ?? 0)
        max = Float(znJsonNumber(g.o["max"]) ?? Double(Float.greatestFiniteMagnitude))
        super.init(g)
    }

    private func pressed(_ e: ZnPointerEvent) -> [ZnPointerChange] { e.changes.filter(\.pressed) }

    private func spread(_ e: ZnPointerEvent) -> Float? {
        let p = pressed(e)
        guard p.count >= 2 else { return nil }
        return hypot(p[0].x - p[1].x, p[0].y - p[1].y)
    }

    override func onEvent(_ e: ZnPointerEvent) {
        guard let d = spread(e) else { dist0 = 0; return }
        if dist0 == 0 {
            dist0 = d
            s0 = g.scale?.value ?? 1
            return
        }
        if state == znPossible && !wants && abs(d - dist0) > ZnGestureMath.slop { wants = true }
        guard state == znActive else { return }
        var s = s0 * d / dist0
        if s < min { s = min - ZnGestureMath.rubber(min - s, 1) * 0.5 }
        if s > max { s = max + ZnGestureMath.rubber(s - max, max) * 0.5 }
        g.scale?.value = s
        let p = pressed(e)
        g.focalX?.value = (p[0].x + p[1].x) / 2
        g.focalY?.value = (p[0].y + p[1].y) / 2
        if g.events.contains("update") { g.send("update", ["scale": Double(s)]) }
    }

    override func activate() {
        if let v = g.scale {
            v.interrupt()
            v.heldBy = g.touch
            s0 = v.value
        }
        if let e = lastEvent, let d = spread(e) { dist0 = d }
        g.send("start")
    }

    override func finish(_ cancelled: Bool) {
        if let v = g.scale, v.heldBy === g.touch { v.heldBy = nil }
        guard state == znActive else { return }
        state = znDone
        let s = g.scale?.value ?? 1
        g.send("end", ["scale": Double(s), "cancelled": cancelled])
        let back: Float? = s < min ? min : s > max ? max : nil
        if let back, let v = g.scale { g.move(v, to: back, .spring) }
        g.send("finalize")
    }
}

/// Rotation (RNGH Rotation): degrees the two fingers turned.
final class ZnRotateRec: ZnRecognizer {
    private var a0 = Float.nan
    private var v0: Float = 0

    private func angleOf(_ e: ZnPointerEvent) -> Float? {
        let p = e.changes.filter(\.pressed)
        guard p.count >= 2 else { return nil }
        return atan2(p[1].y - p[0].y, p[1].x - p[0].x) * 180 / .pi
    }

    override func onEvent(_ e: ZnPointerEvent) {
        guard let a = angleOf(e) else { a0 = .nan; return }
        if a0.isNaN {
            a0 = a
            v0 = g.angle?.value ?? 0
            return
        }
        var delta = a - a0
        while delta > 180 { delta -= 360 }
        while delta < -180 { delta += 360 }
        if state == znPossible && !wants && abs(delta) > 4 { wants = true }
        guard state == znActive else { return }
        g.angle?.value = v0 + delta
        if g.events.contains("update") { g.send("update", ["angle": Double(v0 + delta)]) }
    }

    override func activate() {
        if let v = g.angle {
            v.interrupt()
            v.heldBy = g.touch
        }
        g.send("start")
    }

    override func finish(_ cancelled: Bool) {
        if let v = g.angle, v.heldBy === g.touch { v.heldBy = nil }
        guard state == znActive else { return }
        state = znDone
        g.send("end", ["angle": Double(g.angle?.value ?? 0), "cancelled": cancelled])
        g.send("finalize")
    }
}

/// `pressed` springs (damping 1, stiffness 1500): a tap's and a long press's finger down.
private let znPressSpring = ZnTimingSpec(ms: -1, easing: 0, bezier: nil, ratio: 1, stiffness: 1500, clamp: false)

/// Tap (RNGH Tap): [taps] taps, each short and still, close enough in time. Discrete: fires once, at the last up.
final class ZnTapRec: ZnRecognizer {
    private let taps: Int
    private let maxDuration: Int64, maxDelay: Int64
    private let maxDist: Float
    private var count = 0
    private var downAt: Int64 = 0, upAt: Int64 = 0
    private var moved: Float = 0
    private var down = false
    private var x: Float = 0, y: Float = 0

    override init(_ g: ZnGesture) {
        taps = Swift.max(1, Int(znJsonNumber(g.o["taps"]) ?? 1))
        maxDuration = Int64(znJsonNumber(g.o["maxDuration"]) ?? 500)
        maxDelay = Int64(znJsonNumber(g.o["maxDelay"]) ?? 300)
        maxDist = Float(znJsonNumber(g.o["maxDistance"]) ?? -1)
        super.init(g)
    }

    override var consumes: Bool { false }
    override var continuous: Bool { false }
    override var waitsForMore: Bool { state == znPossible && !down && count >= 1 && count < taps }

    override func deadline() -> Int64 {
        if state != znPossible || wants { return .max }
        if down { return downAt + maxDuration }
        if count > 0 { return upAt + maxDelay }
        return .max
    }

    override func tick(_ now: Int64) {
        if now >= deadline() {
            press(false)
            fail()
        }
    }

    private func press(_ on: Bool) {
        guard let p = g.pressed else { return }
        p.interrupt()
        g.move(p, to: on ? 1 : 0, znPressSpring)
    }

    override func onEvent(_ e: ZnPointerEvent) {
        guard state == znPossible, !wants, let c = e.changes.first else { return }
        if e.pressedCount > 1 {
            press(false)
            return fail()
        }
        if c.pressed && !c.previousPressed {
            down = true
            downAt = c.t
            moved = 0
            x = c.x
            y = c.y
            press(true)
        } else if c.pressed {
            moved += hypot(c.x - c.px, c.y - c.py)
            if moved > (maxDist >= 0 ? maxDist : ZnGestureMath.slop) {
                press(false)
                fail()
            }
        } else if c.previousPressed {
            down = false
            upAt = c.t
            press(false)
            if upAt - downAt > maxDuration { return fail() }
            count += 1
            if count >= taps { wants = true }
        }
    }

    override func activate() {
        state = znDone
        g.play("start")
        // (useZoom's own double tap, `zoom` in its options, moves the zoom here: gesture-zoom.)
        g.send("end", ["x": Double(x), "y": Double(y), "cancelled": false])
        g.send("finalize")
    }

    override func finish(_ cancelled: Bool) {
        if state == znPossible && down { press(false) }
    }
}

/// Long press (RNGH LongPress): held still for [minDuration]; `held` goes 0 → 1 meanwhile, `pressed` while down.
final class ZnLongPressRec: ZnRecognizer {
    private let downAt: Int64
    private let minDuration: Int64
    private let maxDist: Float
    private var moved: Float = 0
    private var started = false

    init(_ g: ZnGesture, downAt: Int64) {
        self.downAt = downAt
        minDuration = Int64(znJsonNumber(g.o["minDuration"]) ?? 500)
        maxDist = Float(znJsonNumber(g.o["maxDistance"]) ?? -1)
        super.init(g)
    }

    override func deadline() -> Int64 { state == znPossible && !wants ? downAt + minDuration : .max }

    override func tick(_ now: Int64) {
        if state == znPossible && now >= downAt + minDuration { wants = true }
    }

    private func begin() {
        guard !started else { return }
        started = true
        if let p = g.pressed { p.interrupt(); g.move(p, to: 1, znPressSpring) }
        if let h = g.held {
            h.interrupt()
            h.value = 0
            g.move(h, to: 1, ZnTimingSpec(ms: Int(minDuration), easing: 3, bezier: nil, ratio: 1, stiffness: 0, clamp: false))
        }
        g.send("begin")
    }

    private func release() {
        if let p = g.pressed {
            p.interrupt()
            g.move(p, to: 0, ZnTimingSpec(ms: -1, easing: 0, bezier: nil, ratio: 0.8, stiffness: 800, clamp: false))
        }
        if let h = g.held {
            h.interrupt()
            if state != znActive { g.move(h, to: 0, ZnTimingSpec(ms: 150, easing: 0, bezier: nil, ratio: 1, stiffness: 0, clamp: false)) }
        }
    }

    override func onEvent(_ e: ZnPointerEvent) {
        begin()
        guard state == znPossible, !wants else { return }
        for c in e.changes where c.pressed && c.previousPressed { moved += hypot(c.x - c.px, c.y - c.py) }
        if moved > (maxDist >= 0 ? maxDist : ZnGestureMath.slop) || e.nonePressed {
            release()
            fail()
        }
    }

    override func activate() {
        g.play("start", "heavy")
        g.send("start")
    }

    override func finish(_ cancelled: Bool) {
        release()
        guard state == znActive else { return }
        state = znDone
        g.send("end", ["cancelled": cancelled])
        g.send("finalize")
    }
}

/// Fling (RNGH Fling): a quick swipe in one of [directions]; fires once at the up.
final class ZnFlingRec: ZnRecognizer {
    private var vt = ZnVelocityTracker()
    private let dirs: Set<String>
    private let minVelocity: Float
    private var dir: String?

    override init(_ g: ZnGesture) {
        dirs = (g.o["directions"] as? [Any]).map { Set($0.compactMap { $0 as? String }) } ?? ["left", "right", "up", "down"]
        minVelocity = Float(znJsonNumber(g.o["minVelocity"]) ?? 800)
        super.init(g)
    }

    override var consumes: Bool { false }
    override var continuous: Bool { false }

    override func onEvent(_ e: ZnPointerEvent) {
        guard state == znPossible, !wants, let c = e.changes.first else { return }
        vt.add(c.t, c.x, c.y)
        guard !c.pressed && c.previousPressed else { return }
        let v = vt.velocity()
        let horizontal = abs(v.x) > abs(v.y)
        let d = horizontal ? (v.x > 0 ? "right" : "left") : (v.y > 0 ? "down" : "up")
        let speed = horizontal ? abs(v.x) : abs(v.y)
        if speed >= minVelocity && dirs.contains(d) {
            dir = d
            wants = true
        } else {
            fail()
        }
    }

    override func activate() {
        state = znDone
        g.send("end", ["direction": dir as Any? ?? NSNull(), "cancelled": false])
        g.send("finalize")
    }
}

/// useZoom's recognizer comes with gesture-zoom (ZnZoom.swift). Until then a zoom leaves every touch to its parent (a
/// Carousel turns the page), as Android's does with one finger when not zoomed.
final class ZnZoomRecPending: ZnRecognizer {
    override func onEvent(_ e: ZnPointerEvent) { fail() }
}

/// A recognizer for one touch of [g] (a leaf). The zoom's comes from gesture-zoom when it lands.
nonisolated(unsafe) var znZoomRecognizer: (ZnGesture) -> ZnRecognizer = { ZnZoomRecPending($0) }

func znRecognizer(_ g: ZnGesture, downAt: Int64) -> ZnRecognizer {
    switch g.kind {
    case ZnGesture.pan: return ZnPanRec(g, downAt: downAt)
    case ZnGesture.pinch: return ZnPinchRec(g)
    case ZnGesture.rotate: return ZnRotateRec(g)
    case ZnGesture.tap: return ZnTapRec(g)
    case ZnGesture.longPress: return ZnLongPressRec(g, downAt: downAt)
    case ZnGesture.zoom: return znZoomRecognizer(g)
    default: return ZnFlingRec(g)
    }
}

/// The arbiter for one node: which recognizers may become active (docs §2.3 composition). A plain gesture is a group
/// of one. Groups nest: simultaneous inside exclusive, and so on; each level applies its own rule.
final class ZnArbiter {
    private final class Node {
        let g: ZnGesture
        let rec: ZnRecognizer?
        let kids: [Node]
        init(_ g: ZnGesture, _ rec: ZnRecognizer?, _ kids: [Node]) { self.g = g; self.rec = rec; self.kids = kids }
    }

    private let tree: Node
    let recs: [ZnRecognizer]

    init(_ root: ZnGesture, downAt: Int64) {
        func build(_ g: ZnGesture) -> Node {
            g.kind == ZnGesture.group ? Node(g, nil, g.members.map(build)) : Node(g, znRecognizer(g, downAt: downAt), [])
        }
        tree = build(root)
        recs = Self.flatten(tree)
    }

    private static func flatten(_ n: Node) -> [ZnRecognizer] { n.rec.map { [$0] } ?? n.kids.flatMap(flatten) }

    /// Activates whoever may; returns those activated now.
    func resolve() -> [ZnRecognizer] {
        var out: [ZnRecognizer] = []
        resolve(tree, &out)
        return out
    }

    private func failed(_ n: Node) -> Bool { Self.flatten(n).allSatisfy { $0.state == znFailed } }
    private func active(_ n: Node) -> Bool { Self.flatten(n).contains { $0.state == znActive || $0.state == znDone } }
    private func wants(_ n: Node) -> Bool { Self.flatten(n).contains { $0.wants } }
    private func failAll(_ n: Node) { for r in Self.flatten(n) where r.state == znPossible { r.fail() } }

    private func resolve(_ n: Node, _ out: inout [ZnRecognizer]) {
        if let r = n.rec {
            if n.g.manual && r.state == znPossible {
                // JS decides: its own conditions don't start it.
                switch n.g.manualWant {
                case ZnGestures.manualActivate: r.wants = true
                case ZnGestures.manualFail: r.fail(); return
                default: r.wants = false
                }
            }
            if r.wants && r.state == znPossible {
                switch n.g.externalOk() {
                case .some(false): r.fail(); return
                case .none: return  // waits for the other element's gesture to fail
                case .some(true): break
                }
            }
            if r.wants && r.state == znPossible {
                r.state = znActive
                r.wants = false
                out.append(r)
            }
            return
        }
        switch n.g.mode {
        case ZnGesture.simultaneous:
            for k in n.kids { resolve(k, &out) }
        case ZnGesture.race:
            if let winner = n.kids.first(where: active) ?? n.kids.first(where: wants) {
                resolve(winner, &out)
                for k in n.kids where k !== winner { failAll(k) }
            }
        default:  // exclusive: in order, one may start only when every one before it has failed
            for k in n.kids {
                if active(k) {
                    for o in n.kids where o !== k { failAll(o) }
                    return
                }
                if wants(k) {
                    resolve(k, &out)
                    if active(k) { for o in n.kids where o !== k { failAll(o) } }
                    return
                }
                if !failed(k) { return }
            }
        }
    }
}

/// One node's touch: from a finger down on it until every finger is up and no recognizer waits for more (Android's
/// pointer loop in Modifier.znGesture, turned inside out: the hub calls [handle] for each event and [tick] at
/// [wakeAt]). Ends once ([over]).
final class ZnGestureSession {
    let g: ZnGesture
    let leaves: [ZnGesture]
    let arbiter: ZnArbiter
    let touch = ZnGestureTouch()
    /// withParent "block": it sees each event before the nodes around it (Compose's Initial pass).
    let blocks: Bool
    /// withParent "simultaneous": it never takes the touch from the scroll it is in.
    let shareTouch: Bool
    private(set) var over = false
    private(set) var cancelled = false
    private var takenByOther = false
    /// Its consuming recognizer took the touch in the last event (the hub then takes it from UIKit).
    private(set) var claims = false
    /// Called once when it ends (the hub drops it).
    var onEnd: ((ZnGestureSession) -> Void)?

    init(_ g: ZnGesture, downAt: Int64) {
        self.g = g
        leaves = g.leaves
        blocks = leaves.contains { $0.withParent == "block" }
        shareTouch = leaves.contains { $0.withParent == "simultaneous" }
        for leaf in leaves {
            leaf.touch = touch
            leaf.manualWant = ZnGestures.manualNone
            leaf.zone = -1
        }
        arbiter = ZnArbiter(g, downAt: downAt)
        // A cancelled touch ends now (the hub puts its own bookkeeping around this).
        touch.onCancel = { [weak self] in self?.end() }
        for leaf in leaves { leaf.send("begin") }
    }

    /// A consuming recognizer may still take the touch (or has) with [fingers] down: the scroll around it waits for it
    /// to give up. A pinch or a rotation needs two fingers to start, so with one a scroll around it may go (on Android
    /// the scroll would take it at its own slop).
    func mayClaim(fingers: Int) -> Bool {
        guard !over, !shareTouch else { return false }
        return arbiter.recs.contains { r in
            guard r.consumes else { return false }
            if r.state == znActive { return true }
            guard r.state == znPossible else { return false }
            return !(r is ZnPinchRec || r is ZnRotateRec) || fingers >= 2
        }
    }

    /// When it needs [tick] (ms since boot), or nil: a deadline (long press time, double-tap gap), or the next frame
    /// while a recognizer waits for JS (manualActivation) or for another element's gesture.
    func wakeAt(_ now: Int64) -> Int64? {
        guard !over else { return nil }
        let possible = arbiter.recs.filter { $0.state == znPossible }
        var next = possible.map { $0.deadline() }.min() ?? .max
        if possible.contains(where: { $0.g.manual || !$0.g.requireFail.isEmpty }) { next = min(next, now + 16) }
        return next == .max ? nil : next
    }

    private func partner(_ touched: Bool) -> Bool {
        leaves.contains { leaf in
            ZnGestures.live().contains { o in
                o !== leaf && (touched ? o.live >= 0 && o.live != znFailed : o.live == znActive) && ZnGestures.simultaneous(leaf, o)
            }
        }
    }

    private func updateLive() { for r in arbiter.recs { r.g.live = r.state } }

    /// One event. Marks [e] consumed when a consuming recognizer of this node holds the touch.
    func handle(_ e: inout ZnPointerEvent) {
        guard !over else { return }
        if touch.cancelled { return end() }
        // Someone else (a scroll, an inner node) used this event before us: we lose the touch.
        let anyActive = arbiter.recs.contains { $0.state == znActive }
        // A gesture on another element linked by simultaneousWith took it: we keep going too.
        if !anyActive && !partner(false) && e.consumed && arbiter.recs.contains(where: { $0.consumes && $0.state == znPossible }) {
            for r in arbiter.recs where r.consumes { r.fail() }
            if arbiter.recs.allSatisfy({ $0.state == znFailed }) {
                takenByOther = true
                return end()
            }
        }
        for r in arbiter.recs {
            if let p = r as? ZnPinchRec { p.lastEvent = e }
            if r.state == znPossible || r.state == znActive { r.onEvent(e) }
        }
        for r in arbiter.resolve() { r.activate() }
        updateLive()
        // Don't take the touch from a linked gesture (simultaneousWith) that is in it too.
        claims = !shareTouch && !partner(true) && arbiter.recs.contains { $0.state == znActive && $0.consumes }
        if claims { e.consumed = true }
        if e.nonePressed {
            // All fingers up: continuous gestures end (release, snap, decay); discrete ones may fire now, or wait (a
            // double tap between its taps, a single tap behind it in an exclusive group).
            for r in arbiter.recs where r.continuous {
                if r.state == znActive { r.finish(false) } else if r.state == znPossible && !r.wants { r.fail() }
            }
            for r in arbiter.resolve() { r.activate() }
            updateLive()
            if !arbiter.recs.contains(where: { $0.state == znPossible && ($0.wants || $0.waitsForMore) }) { return end() }
        }
    }

    /// A deadline or a poll came.
    func tick(_ now: Int64) {
        guard !over else { return }
        for r in arbiter.recs where r.state == znPossible { r.tick(now) }
        for r in arbiter.resolve() { r.activate() }
        updateLive()
        if !arbiter.recs.contains(where: { $0.state == znActive || $0.state == znPossible }) || touch.cancelled { end() }
    }

    /// Ends it now ([cancel]: the touch was cancelled: the system took it, or the node went away).
    func end(cancel: Bool = false) {
        guard !over else { return }
        over = true
        claims = false
        cancelled = touch.cancelled || takenByOther || cancel
        for r in arbiter.recs where r.state == znActive || r.state == znPossible { r.finish(cancelled) }
        for leaf in leaves {
            if leaf.touch === touch { leaf.touch = nil }
            leaf.live = -1
        }
        touch.onCancel = nil
        let f = onEnd
        onEnd = nil
        f?(self)
    }
}
