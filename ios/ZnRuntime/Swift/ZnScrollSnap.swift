// The plain rules of a <Scroll>'s extras (registry 24), a port of android/runtime's ZnScrollExtras.kt: the snap rules
// (ZnSnap), the events JS wants (ZnScrollWants), the event JSON (ZnScrollMetrics), onScroll's throttle, where a scroll
// command goes, and keyboardDismissMode. Foundation only, so ios/tests/scroll builds it on the Mac with the same cases
// as Android. Units are pt (= dp): Android's density d is 1 here.
import Foundation

/// The snap rules, from the compiler's `snap` string (core scrollSnap): "p1;i80;a1;o0,120,400;s0;e0;m1;d0.99".
/// p paging, i interval, a alignment (0 start, 1 center, 2 end), o offsets, s / e snapToStart / snapToEnd (default on),
/// m disableIntervalMomentum, d decelerationRate (iOS's own scale: kept speed per ms).
struct ZnSnap: Equatable {
    var paging = false
    var interval: Double = 0
    var align = 0
    var offsets: [Double] = []
    var toStart = true
    var toEnd = true
    var oneAtATime = false
    /// 0: not written ("normal").
    var deceleration: Double = 0

    var snaps: Bool { paging || interval > 0 || !offsets.isEmpty }

    /// nil for no text (no snap prop written).
    static func parse(_ text: String?) -> ZnSnap? {
        guard let text, !text.isEmpty else { return nil }
        var s = ZnSnap()
        func number(_ v: Substring) -> Double? { Double(v).flatMap { $0.isFinite ? $0 : nil } }
        for part in text.split(separator: ";", omittingEmptySubsequences: true) {
            let v = part.dropFirst()
            switch part.first {
            case "p": s.paging = v == "1"
            case "i": s.interval = number(v).flatMap { $0 > 0 ? $0 : nil } ?? 0
            case "a": s.align = Int(v) ?? 0
            case "o": s.offsets = v.split(separator: ",", omittingEmptySubsequences: false).compactMap { number($0) }.sorted()
            case "s": s.toStart = v != "0"
            case "e": s.toEnd = v != "0"
            case "m": s.oneAtATime = v == "1"
            case "d": s.deceleration = number(v).flatMap { $0 > 0 && $0 < 1 ? $0 : nil } ?? 0
            default: break
            }
        }
        return s
    }

    /// Where a fling from [start] that would coast to [projected] with [velocity] (pt/s, + toward the end) stops.
    /// Snap points are clamped to 0...max.
    func pick(start: Double, projected: Double, velocity: Double, viewport: Double, max: Double) -> Double {
        let free = Swift.min(Swift.max(projected, 0), max)
        if !snaps { return free }
        let points = points(start: start, projected: projected, viewport: viewport, max: max)
        guard let first = points.first, let last = points.last else { return free }
        // snapToStart / snapToEnd off: free scrolling before the first point and after the last one (RN).
        if !toStart && !offsets.isEmpty && projected < first && start <= first { return free }
        if !toEnd && !offsets.isEmpty && projected > last && start >= last { return free }
        if oneAtATime || paging {
            // One step at most: the next point the way it was flung, or the nearest when it was let go slowly.
            if abs(velocity) < 400 { return points.min { abs($0 - projected) < abs($1 - projected) } ?? start }
            return velocity > 0 ? points.first { $0 > start + 1 } ?? last : points.last { $0 < start - 1 } ?? first
        }
        return points.min { abs($0 - projected) < abs($1 - projected) } ?? projected
    }

    /// The snap points near start...projected, sorted.
    private func points(start: Double, projected: Double, viewport: Double, max: Double) -> [Double] {
        func clamp(_ v: Double) -> Double { Swift.min(Swift.max(v, 0), max) }
        var out: [Double] = []
        if !offsets.isEmpty {
            out = offsets.map(clamp)
        } else {
            let step = paging ? viewport : interval
            guard step > 0 else { return [] }
            // RN's snapToAlignment with an interval: the item's start, centre or end lines up with the viewport's.
            let shift = paging ? 0 : (align == 1 ? (viewport - step) / 2 : align == 2 ? viewport - step : 0)
            let lo = Swift.min(start, projected) - 2 * step
            let hi = Swift.max(start, projected) + 2 * step
            var k = ((lo + shift) / step).rounded(.down)
            while true {
                let p = k * step - shift
                if p > hi { break }
                if p >= -0.5 && p <= max + 0.5 { out.append(clamp(p)) }
                k += 1
            }
            if toStart { out.append(0) }
            if toEnd { out.append(max) }
        }
        var seen = Set<Double>()
        return out.filter { seen.insert($0).inserted }.sorted()
    }

    /// The UIScrollView decelerationRate for these rules: core's number as it is (it is already iOS's scale), else
    /// "normal" (0.998), as Android keeps the platform's own curve for 0 and from 0.998.
    static func decelerationRate(_ snap: ZnSnap?) -> Double {
        let d = snap?.deceleration ?? 0
        return d > 0 && d < 0.998 ? d : 0.998
    }
}

/// The events JS has handlers for, from the compiler's `scrollEvents` string: "t16;s;b;e;mb;me".
struct ZnScrollWants: Equatable {
    var throttleMs = 0
    var scroll = false
    var beginDrag = false
    var endDrag = false
    var momentumBegin = false
    var momentumEnd = false

    var any: Bool { scroll || beginDrag || endDrag || momentumBegin || momentumEnd }
    var momentum: Bool { momentumBegin || momentumEnd }

    static func parse(_ text: String?) -> ZnScrollWants? {
        guard let text, !text.isEmpty else { return nil }
        let parts = text.split(separator: ";", omittingEmptySubsequences: false).map(String.init)
        var w = ZnScrollWants()
        if let t = parts.first(where: { $0.hasPrefix("t") }).flatMap({ Int($0.dropFirst()) }) {
            w.throttleMs = Swift.min(Swift.max(t, 0), 10_000)
        }
        w.scroll = parts.contains("s")
        w.beginDrag = parts.contains("b")
        w.endDrag = parts.contains("e")
        w.momentumBegin = parts.contains("mb")
        w.momentumEnd = parts.contains("me")
        return w
    }

    /// onScroll's throttle (Android's ZnScrollEvents): how long to wait before sending the newest position, given when
    /// the last one went. 0: send now. A wait is one trailing send, so the last position always arrives.
    func wait(nowMs: Double, lastSentMs: Double) -> Double {
        Swift.max(0, Double(throttleMs) - (nowMs - lastSentMs))
    }
}

/// Where a scroll is along its axis, as Android's ZnScrollPos: offset 0...max, viewport and the other axis's size.
struct ZnScrollMetrics: Equatable {
    var offset: Double
    var max: Double
    var viewport: Double
    var cross: Double

    var content: Double { max + viewport }

    /// From a UIScrollView's numbers along the axis: the offset counts from the content's start (the inset added) and
    /// is clamped to 0...max, so a bounce reads as the edge (Android has no bounce).
    static func along(offset: Double, inset start: Double, insetEnd end: Double, content: Double, viewport: Double,
                      cross: Double) -> ZnScrollMetrics {
        let max = Swift.max(0, content + start + end - viewport)
        return ZnScrollMetrics(offset: Swift.min(Swift.max(offset + start, 0), max), max: max, viewport: viewport,
                               cross: cross)
    }

    /// One scroll event for JS (core scrollEvent), as znSendScroll: kind k ("s", "b", "e", "mb", "me"), offsets and
    /// sizes in dp, velocity in dp/s only when not 0.
    func json(_ k: String, horizontal: Bool, velocity: Double = 0) -> String {
        func n(_ v: Double) -> String {
            guard v.isFinite else { return "0" }
            return v == v.rounded() && abs(v) < 1e15 ? String(Int64(v)) : String(v)
        }
        var out = "{\"k\":\"\(k)\""
        out += ",\"x\":\(n(horizontal ? offset : 0)),\"y\":\(n(horizontal ? 0 : offset))"
        out += ",\"cw\":\(n(horizontal ? content : cross)),\"ch\":\(n(horizontal ? cross : content))"
        out += ",\"w\":\(n(horizontal ? viewport : cross)),\"h\":\(n(horizontal ? cross : viewport))"
        if velocity != 0 { out += ",\"vx\":\(n(horizontal ? velocity : 0)),\"vy\":\(n(horizontal ? 0 : velocity))" }
        return out + "}"
    }
}

extension ZnScrollCommand {
    /// Where a <Scroll ref> command takes the scroll along its axis (0...max), as Android's ZnScrollCommands: to and
    /// offset go to their number (not below 0), end to max. nil for index and other words (nothing moves).
    func scrollTarget(horizontal: Bool, max: Double) -> Double? {
        if action == .end { return Swift.max(0, max) }
        guard let o = axisOffset(horizontal: horizontal) else { return nil }
        return Swift.min(Swift.max(o, 0), Swift.max(0, max))
    }
}

/// RN's keyboardDismissMode on a <Scroll> (Android's znKeyboardDismiss): "on-drag" closes the keyboard on the first
/// drag; "interactive" lets it follow the finger on a vertical scroll, and is on-drag on a horizontal one.
enum ZnKeyboardDismiss: Equatable {
    case none, onDrag, interactive

    static func of(_ mode: String?, vertical: Bool) -> ZnKeyboardDismiss {
        switch mode {
        case "on-drag": return .onDrag
        case "interactive": return vertical ? .interactive : .onDrag
        default: return .none
        }
    }
}
