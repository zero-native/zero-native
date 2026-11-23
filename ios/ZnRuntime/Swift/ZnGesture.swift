// Gestures on iOS (Android: ZnGesture.kt; docs/gestures-and-motion-v1.md §2.3). A gesture is an object JS made (core
// motion.ts usePan, usePinch, ...); a node takes it with `gesture={g}`. Under the finger everything is native: the
// values it moves, the release (snap points, fling projection, magnets, decay) and haptics. JS hears events once each,
// in order, and only the ones it asked for. Combined gestures (Gesture.simultaneous / exclusive / race) share one touch
// session per node.
//
// This file is the model (what a gesture moves and how it releases); the recognizers and the per-touch session are in
// ZnGestureRecognizers.swift, the touches come from ZnGestureHub.swift. Foundation and Observation only, so the Mac
// suite (ios/tests/gestures) runs it as it is. Main thread only, as on Android.
import Foundation
import Observation

/// Goes up each time a gesture is made: a node whose gesture id missed reads it, so it draws again once the gesture
/// arrives (the "gesture" call and the template batch that uses its id reach the main thread by different paths).
@Observable
final class ZnGestureGeneration {
    fileprivate(set) var n = 0
}

enum ZnGestures {
    nonisolated(unsafe) private static var all: [Int: ZnGesture] = [:]
    nonisolated(unsafe) static let generation = ZnGestureGeneration()
    /// Plays a haptic named in a gesture's options (ZnHaptics.swift sets it; the Mac suite records them).
    nonisolated(unsafe) static var haptic: (String?) -> Void = { _ in }
    /// The time now in ms, on the touches' time base (UITouch.timestamp: seconds since boot).
    nonisolated(unsafe) static var now: () -> Int64 = { Int64(ProcessInfo.processInfo.systemUptime * 1000) }
    /// Each event a gesture would send, as a line (ZN_GESTURE_LOG=1 in a Debug build).
    nonisolated(unsafe) static var trace: ((String) -> Void)?

    static let manualNone = 0, manualActivate = 1, manualFail = 2

    static func find(_ id: Int) -> ZnGesture? { all[id] }

    /// [id]'s gesture, or nil; a miss reads the generation, so a SwiftUI reader draws again when gestures arrive.
    static func findObserved(_ id: Int) -> ZnGesture? {
        if let g = all[id] { return g }
        _ = generation.n
        return nil
    }

    static func dispose(_ id: Int) {
        all.removeValue(forKey: id)?.dispose()
    }

    /// The JS that made the gestures is gone.
    static func reset() {
        let gone = all
        all = [:]
        for g in gone.values { g.dispose() }
    }

    /// Is [a] linked with [b] by simultaneousWith (either side named the other)?
    static func simultaneous(_ a: ZnGesture, _ b: ZnGesture) -> Bool { b.simWith.contains(a.id) || a.simWith.contains(b.id) }

    /// Every gesture (for links between elements: their `live` state in the touch now).
    static func live() -> Dictionary<Int, ZnGesture>.Values { all.values }

    // MARK: The Motion module's gesture functions (ZnGestureHub.swift registers them)

    /// {"id", "kind": "pan"|"pinch"|"rotate"|"tap"|"longPress"|"fling"|"zoom", "values": {name: id}, ...options}
    static func make(_ args: [String: Any]) throws {
        guard let id = znJsonNumber(args["id"]).map({ Int($0) }) else { throw ZnInvalidArgs("\"id\" is missing") }
        all.removeValue(forKey: id)?.dispose()
        all[id] = try ZnGesture.make(id, args)
        generation.n += 1
    }

    /// {"id", "mode": "simultaneous"|"exclusive"|"race", "of": [ids]}
    static func makeGroup(_ args: [String: Any]) throws {
        guard let id = znJsonNumber(args["id"]).map({ Int($0) }) else { throw ZnInvalidArgs("\"id\" is missing") }
        let of = (args["of"] as? [Any]) ?? []
        let members: [ZnGesture] = try of.map { x in
            let m = Int(znJsonNumber(x) ?? -1)
            guard let g = all[m] else { throw ZnInvalidArgs("gesture \(m) doesn't exist") }
            return g
        }
        if members.isEmpty { throw ZnInvalidArgs("a gesture group needs gestures") }
        let mode: Int
        switch args["mode"] as? String {
        case "simultaneous": mode = ZnGesture.simultaneous
        case "exclusive": mode = ZnGesture.exclusive
        default: mode = ZnGesture.race
        }
        all.removeValue(forKey: id)?.dispose()
        all[id] = ZnGesture.group(id, mode, members)
        generation.n += 1
    }

    /// {"id", "s": "activate" | "fail"}: for a gesture made with manualActivation, JS decides when it starts. Applies
    /// to the touch in progress (it waits for JS's answer).
    static func setState(_ args: [String: Any]) {
        guard let id = znJsonNumber(args["id"]).map({ Int($0) }), let g = all[id] else { return }
        let want = args["s"] as? String == "activate" ? manualActivate : manualFail
        for leaf in g.leaves { leaf.manualWant = want }
    }

    /// {"id", "anchor": anchor id, "t": timing}: answers {finished}.
    static func snapTo(_ args: [String: Any], _ resolve: @escaping ([String: Any]) -> Void) throws {
        let id = Int(znJsonNumber(args["id"]) ?? -1)
        guard let g = all[id] else { throw ZnInvalidArgs("no gesture \(id)") }
        try g.snapTo(args["anchor"] as? String ?? "", try ZnTimingSpec.parse(args["t"] as? [String: Any]), resolve)
    }
}

/// One touch on a gesture's node (one finger-down to all-up, or longer for multi-tap). Holds the values the finger
/// moves (heldBy): a JS command with interruptGesture cancels it.
final class ZnGestureTouch: ZnMotionHolder {
    private(set) var cancelled = false
    /// Ends the touch's session now (the hub sets it; Android's loop sees the flag at its next event or deadline).
    var onCancel: (() -> Void)?

    func cancel() {
        guard !cancelled else { return }
        cancelled = true
        let f = onCancel
        onCancel = nil
        f?()
    }
}

/// One gesture, or a group of them ([members], [mode]). Holds what it moves and how it releases; the per-touch state
/// lives in the recognizers made for each touch.
final class ZnGesture {
    static let pan = 1, pinch = 2, rotate = 3, tap = 4, longPress = 5, fling = 6, group = 7, zoom = 8
    static let simultaneous = 1, exclusive = 2, race = 3
    static let axisX = 1, axisY = 2, axisXY = 3

    let id: Int
    let kind: Int
    let o: [String: Any]
    let members: [ZnGesture]
    let mode: Int
    private let engine: ZnMotionEngine

    let site = ZnSite()
    let events: Set<String>

    // Values it moves (JS made the ids; native owns them). Nil when the kind doesn't have it.
    private(set) var x: ZnMotionValue?
    private(set) var y: ZnMotionValue?
    private(set) var scale: ZnMotionValue?
    private(set) var focalX: ZnMotionValue?
    private(set) var focalY: ZnMotionValue?
    private(set) var angle: ZnMotionValue?
    private(set) var pressed: ZnMotionValue?
    private(set) var held: ZnMotionValue?
    /// Where the finger is in the element (points): for a dial (atan2 of it) or a chart crosshair.
    private(set) var touchX: ZnMotionValue?
    private(set) var touchY: ZnMotionValue?

    let axis: Int
    private(set) var boundsX: (ZnSpec, ZnSpec)?
    private(set) var boundsY: (ZnSpec, ZnSpec)?
    let rubber: Bool
    private(set) var anchors: [ZnAnchor] = []
    private(set) var magnets: [ZnMagnet] = []
    let release: [String: Any]
    let haptic: [String: Any]
    let crosses: [Float]
    let withParent: String
    let a11yLabel: String?

    // useZoom (kind "zoom"; the maths and its recognizer: ZnZoom.swift).
    let zoomMin: Float
    let zoomMax: Float
    /// The scale a double tap zooms to (0: a double tap does nothing).
    let zoomDouble: Float
    /// The content's shape (width / height), fitted inside the element; nil or 0: the content fills the element.
    private(set) var zoomAspect: ZnSpec?
    /// The node's own layer now (scale x, scale y, translate x, translate y; its probe sets it): a zoom on an element
    /// that also carries the zoom's transform maps the fingers back into its box (ZnZoomMath.toBox). Nil: no layer.
    var layerNow: (() -> (Float, Float, Float, Float)?)?
    /// The probe that set [layerNow] (only it clears it when it goes).
    weak var layerOwner: AnyObject?
    /// Where a zoom tween (double tap, zoomTo, VoiceOver) is going, while it runs: a finger that lands then decides
    /// "zoomed or not" by it, not by the scale drawn halfway, and drags from there (ZnZoomRec).
    var zoomGoal: (s: Float, x: Float, y: Float)?
    var zoomSeq = 0

    /// The touch in progress (a JS command with interruptGesture cancels it).
    var touch: ZnGestureTouch?

    // Links with gestures on other elements (RNGH's requireExternalGestureToFail / simultaneousWithExternalGesture /
    // manualActivation).
    /// It starts only once these have failed (or aren't touched); if one starts, this fails.
    let requireFail: [Int]
    /// These may run with it although they are on other elements (neither takes the touch from the other).
    let simWith: [Int]
    /// JS decides when it starts: Gesture.activate(g) / Gesture.fail(g) (it still follows the finger once started).
    let manual: Bool
    var manualWant = ZnGestures.manualNone
    /// Its recognizer's state in the touch now (-1: not touched), for the links above.
    var live = -1

    /// Drop zones: useElementMotion() ids whose boxes the finger may be over; the one it is over.
    let dropZones: [Int]
    var zone = -1

    var selfW: Float { site.selfW }
    var selfH: Float { site.selfH }

    private init(id: Int, kind: Int, o: [String: Any], members: [ZnGesture], mode: Int, engine: ZnMotionEngine) throws {
        self.id = id; self.kind = kind; self.o = o; self.members = members; self.mode = mode; self.engine = engine
        events = Set((o["ev"] as? [Any])?.compactMap { $0 as? String } ?? [])
        switch o["axis"] as? String {
        case "x": axis = Self.axisX
        case "y": axis = Self.axisY
        default: axis = Self.axisXY
        }
        rubber = o["rubber"].map { znJsonBool($0) } ?? true
        release = o["release"] as? [String: Any] ?? [:]
        haptic = o["haptic"] as? [String: Any] ?? [:]
        crosses = znJsonFloats(o["cross"])
        withParent = o["withParent"] as? String ?? ""
        a11yLabel = (o["a11yLabel"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        requireFail = Self.ints(o["fails"])
        simWith = Self.ints(o["with"])
        manual = znJsonBool(o["manual"])
        dropZones = Self.ints(o["zones"])
        let zMin = Float(znJsonNumber(o["min"]) ?? 1)
        zoomMin = zMin.isFinite && zMin > 0 ? zMin : 1
        let zMax = Float(znJsonNumber(o["max"]) ?? 4)
        zoomMax = zMax.isFinite && zMax >= zoomMin ? zMax : Swift.max(zoomMin, 4)
        let dt = Float(znJsonNumber(o["doubleTap"]) ?? 2.5)
        zoomDouble = dt.isFinite && dt > 0 ? dt : 0
        x = try valueOf("x")
        y = try valueOf("y")
        scale = try valueOf("scale", 1)
        focalX = try valueOf("focalX")
        focalY = try valueOf("focalY")
        angle = try valueOf("angle")
        pressed = try valueOf("pressed")
        held = try valueOf("held")
        touchX = try valueOf("touchX")
        touchY = try valueOf("touchY")
        boundsX = try boundsOf("x")
        boundsY = try boundsOf("y")
        if kind == Self.zoom, let a = o["aspect"], !(a is NSNull) { zoomAspect = try ZnSpec.parse(a, engine) }
        anchors = try ((o["anchors"] as? [Any]) ?? []).enumerated().map { i, a in
            let e = a as? [String: Any] ?? [:]
            return ZnAnchor(id: (e["id"] as? String) ?? String(i), x: try ZnSpec.parse(e["x"], engine), y: try ZnSpec.parse(e["y"], engine))
        }
        magnets = try ((o["magnets"] as? [Any]) ?? []).map { a in
            let e = a as? [String: Any] ?? [:]
            guard let mid = e["id"] as? String else { throw ZnInvalidArgs("magnet needs an id") }
            guard let mx = try ZnSpec.parse(e["x"], engine) else { throw ZnInvalidArgs("magnet needs x") }
            guard let my = try ZnSpec.parse(e["y"], engine) else { throw ZnInvalidArgs("magnet needs y") }
            return ZnMagnet(id: mid, x: mx, y: my, radius: max(1, Float(znJsonNumber(e["radius"]) ?? 80)),
                            pull: min(max(Float(znJsonNumber(e["pull"]) ?? 0.5), 0), 1))
        }
    }

    static func make(_ id: Int, _ o: [String: Any], _ engine: ZnMotionEngine = .shared) throws -> ZnGesture {
        let kind: Int
        switch o["kind"] as? String {
        case "pan": kind = pan
        case "pinch": kind = pinch
        case "rotate": kind = rotate
        case "tap": kind = tap
        case "longPress": kind = longPress
        case "fling": kind = fling
        case "zoom": kind = zoom
        default: throw ZnInvalidArgs("unknown gesture kind \"\(o["kind"] as? String ?? "")\"")
        }
        let g = try ZnGesture(id: id, kind: kind, o: o, members: [], mode: 0, engine: engine)
        // Sources JS reads from the gesture: progress along the axis, and each magnet's closeness.
        if let ids = o["values"] as? [String: Any], let p = znJsonNumber(ids["progress"]) {
            try engine.put(Int(p), ZnProgressSource(id: Int(p), g))
        }
        for (i, a) in ((o["magnets"] as? [Any]) ?? []).enumerated() {
            if let e = a as? [String: Any], let src = znJsonNumber(e["src"]), i < g.magnets.count {
                try engine.put(Int(src), ZnMagnetSource(id: Int(src), g, g.magnets[i]))
            }
        }
        return g
    }

    static func group(_ id: Int, _ mode: Int, _ members: [ZnGesture], _ engine: ZnMotionEngine = .shared) -> ZnGesture {
        // (no options: nothing in it can throw)
        try! ZnGesture(id: id, kind: group, o: [:], members: members, mode: mode, engine: engine)
    }

    private static func ints(_ v: Any?) -> [Int] { ((v as? [Any]) ?? []).map { Int(znJsonNumber($0) ?? 0) } }

    private func valueOf(_ name: String, _ initial: Float = 0) throws -> ZnMotionValue? {
        guard let ids = o["values"] as? [String: Any], let n = znJsonNumber(ids[name]) else { return nil }
        let vid = Int(n)
        if let v = engine.find(vid) as? ZnMotionValue { return v }
        return try engine.putValue(vid, Float(znJsonNumber(ids["\(name).v"]) ?? Double(initial)))
    }

    private func boundsOf(_ axis: String) throws -> (ZnSpec, ZnSpec)? {
        guard let a = (o["bounds"] as? [String: Any])?[axis] as? [Any], a.count >= 2,
              let lo = try ZnSpec.parse(a[0], engine), let hi = try ZnSpec.parse(a[1], engine) else { return nil }
        return (lo, hi)
    }

    func lo(_ onX: Bool) -> Float? { (onX ? boundsX : boundsY).map { resolve($0.0, onX) } }
    func hi(_ onX: Bool) -> Float? { (onX ? boundsX : boundsY).map { resolve($0.1, onX) } }

    func resolve(_ s: ZnSpec, _ onX: Bool) -> Float {
        onX ? s.resolve(site.selfW, site.parentW, site) : s.resolve(site.selfH, site.parentH, site)
    }

    /// Every gesture in this one (itself, or a group's members, in order).
    var leaves: [ZnGesture] { kind == Self.group ? members.flatMap { $0.leaves } : [self] }

    /// The node's own size and its parent's (points), from where it is drawn. Every leaf of a group gets them.
    func placed(_ w: Float, _ h: Float, _ pw: Float, _ ph: Float) {
        site.update(w, h, pw, ph)
        for leaf in leaves where leaf !== self { leaf.site.update(w, h, pw, ph) }
        for leaf in leaves { leaf.followAnchor() }
    }

    func dispose() {
        touch?.cancel()
        detach()
        if kind == Self.group { return }  // members are their own objects (JS disposes them)
        // The values belong to the gesture: JS disposed it, so they go too. (JS holds no other handle on them.)
        for v in [x, y, scale, focalX, focalY, angle, pressed, held, touchX, touchY] { if let v { engine.dispose(v.id) } }
    }

    func send(_ type: String, _ data: [String: Any] = [:]) {
        ZnGestures.trace?("\(id) \(type)\(events.contains(type) ? "" : " (not asked for)") \(data)")
        guard events.contains(type) else { return }
        var d = data
        d["g"] = id
        d["t"] = type
        engine.sendEvent(d)
    }

    func play(_ name: String, _ fallback: String? = nil) {
        ZnGestures.haptic((haptic[name] as? String) ?? fallback)
    }

    /// May this gesture start now, as far as gestures on other elements go? nil: wait (one it must outlast is still
    /// possible); false: it must fail (one it must outlast started).
    func externalOk() -> Bool? {
        for id in requireFail {
            guard let other = ZnGestures.find(id) else { continue }
            for leaf in other.leaves {
                if leaf.live == 1 || leaf.live == 3 { return false }  // ACTIVE / DONE
                if leaf.live == 0 { return nil }  // POSSIBLE
            }
        }
        return true
    }

    /// The drop zone (index in [dropZones]) at window point ([wx], [wy]) in points, or -1.
    func zoneAt(_ wx: Float, _ wy: Float) -> Int {
        for (i, zid) in dropZones.enumerated() {
            guard let e = engine.element(zid), let x = e.value("x")?.value, let y = e.value("y")?.value,
                  let w = e.value("width")?.value, let h = e.value("height")?.value else { continue }
            if wx >= x && wx <= x + w && wy >= y && wy <= y + h { return i }
        }
        return -1
    }

    // MARK: Moving its own values

    /// Moves [v] the way Android's ZnValue.animate does: not a JS command (a gesture resting on an anchor keeps
    /// following it), and past a finger's hold.
    func move(_ v: ZnMotionValue, _ steps: [ZnStep], _ done: @escaping (Bool) -> Void = { _ in }) {
        let command = v.onCommand, holder = v.heldBy
        v.onCommand = nil
        v.heldBy = nil
        engine.animate(v, steps: steps, done: done)
        v.onCommand = command
        if v.heldBy == nil, !((holder as? ZnGestureTouch)?.cancelled ?? false) { v.heldBy = holder }
    }

    func move(_ v: ZnMotionValue, to: Float, _ t: ZnTimingSpec, _ done: @escaping (Bool) -> Void = { _ in }) {
        move(v, [.to(to, t, delayMs: 0)], done)
    }

    // MARK: Resting on an anchor

    /// After a release that ended on an anchor, the gesture rests there and follows the anchor if it moves (the
    /// keyboard opens, the phone turns): a floating video stays above the keyboard with no JS. Ends at the next
    /// touch, snapTo, or a JS command to its values.
    private var attached: ZnAnchor?
    private var attachedAt: (Float?, Float?)?

    func detach() {
        guard attached != nil else { return }
        attached = nil
        attachedAt = nil
        engine.removeOnDirty(self)
        for v in [x, y] { v?.onCommand = nil }
    }

    func attach(_ anchorId: String) {
        detach()
        guard let a = anchors.first(where: { $0.id == anchorId }) else { return }
        attached = a
        // The anchor's coordinates may be motion values (env.keyboardHeight): look again whenever one moved, and when
        // the node or its parent is resized (placed).
        engine.onDirty(self) { [weak self] in self?.followAnchor() }
        // A JS command to x or y ends it.
        for v in [x, y] { v?.onCommand = { [weak self] in self?.detach() } }
        // And once now (Android's snapshotFlow starts with the current point): the anchor may have moved while the
        // release went to it (the keyboard opened during the settle), so it goes on to where the anchor is now.
        followAnchor()
    }

    /// The anchor it rests on moved: spring there (as Android's snapshotFlow, only when the point changed).
    func followAnchor() {
        guard let a = attached else { return }
        let now = anchorPoint(a)
        if let at = attachedAt, at.0 == now.0, at.1 == now.1 { return }
        attachedAt = now
        let spring = (try? ZnTimingSpec.parse(release["spring"] as? [String: Any])) ?? .spring
        for (v, to) in [(x, now.0), (y, now.1)] {
            guard let v, let to, v.heldBy == nil, abs(v.value - to) >= 0.5 else { continue }
            move(v, to: to, spring)
        }
    }

    // MARK: Release (pan)

    /// Where a release ends (points): the anchor and its point, or nil (no anchors: stay, or decay).
    struct Target {
        let id: String
        let x: Float?, y: Float?
    }

    func anchorPoint(_ a: ZnAnchor) -> (Float?, Float?) {
        (axis != Self.axisY ? a.x.map { resolve($0, true) } : nil, axis != Self.axisX ? a.y.map { resolve($0, false) } : nil)
    }

    /// Chooses where a release at ([px], [py]) with velocity ([vx], [vy]) (points, points a second) ends.
    func chooseTarget(_ px: Float, _ py: Float, _ vx: Float, _ vy: Float, _ startX: Float, _ startY: Float) -> Target? {
        // Released inside a magnet: it wins.
        for m in magnets {
            let cx = resolve(m.x, true), cy = resolve(m.y, false)
            if hypot(px - cx, py - cy) <= m.radius { return Target(id: m.id, x: cx, y: cy) }
        }
        if anchors.isEmpty { return nil }
        let project = znJsonBool(release["project"])
        if project || axis == Self.axisXY {
            // Where a fling would stop (the platform's own curve), then the nearest anchor to that point.
            let tx = project ? px + ZnGestureMath.flingDistance(vx) : px
            let ty = project ? py + ZnGestureMath.flingDistance(vy) : py
            let best = anchors.min { a, b in
                let (ax, ay) = anchorPoint(a), (bx, by) = anchorPoint(b)
                return hypot((ax ?? tx) - tx, (ay ?? ty) - ty) < hypot((bx ?? tx) - tx, (by ?? ty) - ty)
            }
            return best.map { a in let p = anchorPoint(a); return Target(id: a.id, x: p.0, y: p.1) }
        }
        // One axis: a fast enough flick goes to the next anchor its way; else the nearest one, unless it moved less
        // than threshold.distance from where it started (then back there).
        let onX = axis == Self.axisX
        let pos = onX ? px : py, v = onX ? vx : vy, start = onX ? startX : startY
        let points: [(ZnAnchor, Float)] = anchors.map { a in let p = anchorPoint(a); return (a, (onX ? p.0 : p.1) ?? pos) }
        let th = release["threshold"] as? [String: Any]
        let minV = Float(znJsonNumber(th?["velocity"]) ?? 400)
        let minD = Float(znJsonNumber(th?["distance"]) ?? -1)
        func nearest(_ to: Float, _ list: [(ZnAnchor, Float)]) -> (ZnAnchor, Float)? { list.min { abs($0.1 - to) < abs($1.1 - to) } }
        let chosen: (ZnAnchor, Float)?
        if abs(v) >= minV {
            let ahead = points.filter { v > 0 ? $0.1 > pos + 0.5 : $0.1 < pos - 0.5 }
            chosen = nearest(pos, ahead) ?? nearest(pos, points)
        } else if minD >= 0 && abs(pos - start) < minD {
            chosen = nearest(start, points)
        } else {
            chosen = nearest(pos, points)
        }
        guard let c = chosen else { return nil }
        return Target(id: c.0.id, x: onX ? c.1 : nil, y: onX ? nil : c.1)
    }

    /// Springs (or decays) after a release; calls back with the anchor it went to.
    func settle(_ t: Target?, _ vx: Float, _ vy: Float, _ done: ((String?) -> Void)? = nil) {
        let spring = (try? ZnTimingSpec.parse(release["spring"] as? [String: Any])) ?? .spring
        let decay = znJsonBool(release["decay"])
        var open = 0
        var allStarted = false
        var allOk = true
        let finished = { [weak self] in
            guard let self else { return }
            // Rests on the anchor only when it got there: a run cut short (a finger grabbed it, snapTo) means someone
            // else moves it now, and following the old anchor would pull it away from them.
            if allOk, let t, self.anchors.contains(where: { $0.id == t.id }) { self.attach(t.id) }
            done?(t?.id)
        }
        func go(_ v: ZnMotionValue?, _ onX: Bool, _ to: Float?, _ vel: Float) {
            guard let v else { return }
            v.velocity = vel
            let lo = lo(onX), hi = hi(onX)
            let step: ZnStep?
            if let to {
                step = .to(to, spring, delayMs: 0)
            } else if decay {
                step = .decay(v: vel, f: znFriction(znJsonNumber(release["deceleration"]) ?? 0.998), lo: lo, hi: hi, delayMs: 0)
            } else {
                // Rubber-banded past a bound: back inside.
                let cur = v.value
                let inside: Float? = lo.flatMap { cur < $0 ? $0 : nil } ?? hi.flatMap { cur > $0 ? $0 : nil }
                step = inside.map { .to($0, spring, delayMs: 0) }
            }
            guard let step else { return }
            open += 1
            move(v, [step]) { ok in
                if !ok { allOk = false }
                open -= 1
                if open == 0 && allStarted { finished() }
            }
        }
        go(x, true, t?.x, vx)
        go(y, false, t?.y, vy)
        allStarted = true
        if open == 0 { finished() }
    }

    /// JS asked to go to an anchor (a failed payment springs the slider back).
    func snapTo(_ anchorId: String, _ spec: ZnTimingSpec, _ resolve: @escaping ([String: Any]) -> Void) throws {
        var found: (ZnGesture, ZnAnchor)?
        for g in leaves { if let a = g.anchors.first(where: { $0.id == anchorId }) { found = (g, a); break } }
        if found == nil {
            for g in leaves { if let m = g.magnets.first(where: { $0.id == anchorId }) { found = (g, ZnAnchor(id: m.id, x: m.x, y: m.y)); break } }
        }
        guard let (g, a) = found else { throw ZnInvalidArgs("gesture \(id) has no anchor \"\(anchorId)\"") }
        g.touch?.cancel()
        g.detach()
        let (ax, ay) = g.anchorPoint(a)
        var values: [(ZnMotionValue, Float)] = []
        if let ax, let v = g.x { values.append((v, ax)) }
        if let ay, let v = g.y { values.append((v, ay)) }
        if values.isEmpty { return resolve(["finished": true]) }
        var open = values.count
        var finished = true
        for (v, to) in values {
            v.interrupt()
            g.move(v, to: to, spec) { ok in
                if !ok { finished = false }
                open -= 1
                if open == 0 { resolve(["finished": finished]) }
            }
        }
    }
}

/// `pan.progress`: 0 → 1 between the bounds of its axis (x for "x" and "xy", y for "y").
final class ZnProgressSource: ZnSource {
    private let g: ZnGesture
    init(id: Int, _ g: ZnGesture) { self.g = g; super.init(id: id) }

    override func read(_ site: ZnSite?) -> Float {
        let onX = g.axis != ZnGesture.axisY
        guard let v = (onX ? g.x : g.y)?.read(site) else { return 0 }
        let lo = g.lo(onX) ?? 0
        guard let hi = g.hi(onX), hi != lo else { return 0 }
        return (v - lo) / (hi - lo)
    }
}

/// `pan.magnet(id)`: 0 far away → 1 at the centre.
final class ZnMagnetSource: ZnSource {
    private let g: ZnGesture
    private let m: ZnMagnet
    init(id: Int, _ g: ZnGesture, _ m: ZnMagnet) { self.g = g; self.m = m; super.init(id: id) }

    override func read(_ site: ZnSite?) -> Float {
        let px = g.x?.read(site) ?? 0, py = g.y?.read(site) ?? 0
        let d = hypot(px - g.resolve(m.x, true), py - g.resolve(m.y, false))
        return min(max(1 - d / m.radius, 0), 1)
    }
}
