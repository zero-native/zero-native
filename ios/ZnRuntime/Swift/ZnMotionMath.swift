// The maths of motion values (Android: ZnMotion.kt and Compose's animation-core), Foundation only, so the Mac unit
// suite (ios/tests/motion) builds it on its own. Float, as Android: the same numbers reach the same tests.
// - Easings by the compiler's id (also the `animate` prop's, ZnAnimation.swift).
// - ZnTimingSpec: how a value moves ({t,e,b} a tween, {r,k,c} a spring, {d,p} a plugin's driver).
// - Curves: a spring with a starting speed (Compose's SpringSimulation, and its duration estimate so a promise
//   resolves on the same frame as on Android), a tween, a decay (Compose's exponential decay), a plugin driver.
// - znInterpolate / znMixColors (map, mapColor, formula tables), znFriction, ZnNumberFormat (v.format()).
import Foundation

// MARK: - Easing

/// An easing curve, 0…1 → 0…1.
typealias ZnEase = (Double) -> Double

/// A CSS cubic-bezier: x(u) solved for u by Newton steps, then bisection if they stall.
struct ZnCubicBezier {
    let x1: Double, y1: Double, x2: Double, y2: Double

    private func bez(_ u: Double, _ a: Double, _ b: Double) -> Double {
        let v = 1 - u
        return 3 * v * v * u * a + 3 * v * u * u * b + u * u * u
    }

    func callAsFunction(_ t: Double) -> Double {
        if t <= 0 { return 0 }
        if t >= 1 { return 1 }
        var u = t
        for _ in 0..<8 {
            let x = bez(u, x1, x2) - t
            if abs(x) < 1e-6 { return bez(u, y1, y2) }
            let v = 1 - u
            let d = 3 * v * v * x1 + 6 * v * u * (x2 - x1) + 3 * u * u * (1 - x2)
            if abs(d) < 1e-6 { break }
            u -= x / d
        }
        var lo = 0.0, hi = 1.0
        u = t
        for _ in 0..<30 {
            let x = bez(u, x1, x2)
            if abs(x - t) < 1e-6 { break }
            if x < t { lo = u } else { hi = u }
            u = (lo + hi) / 2
        }
        return bez(u, y1, y2)
    }
}

/// An easing by the compiler's id (`EASINGS` in compile.ts), with Compose's curves: 0 standard (FastOutSlowIn),
/// 1 ease-out (LinearOutSlowIn), 2 ease-in (FastOutLinearIn), 3 linear, 4 the given bezier, 5 a step (holds, then
/// jumps at the very end).
func znEasing(_ id: Int, _ bezier: [Double]?) -> ZnEase {
    switch id {
    case 1: let c = ZnCubicBezier(x1: 0, y1: 0, x2: 0.2, y2: 1); return { c($0) }
    case 2: let c = ZnCubicBezier(x1: 0.4, y1: 0, x2: 1, y2: 1); return { c($0) }
    case 3: return { $0 }
    case 4 where bezier?.count == 4:
        let b = bezier!
        let c = ZnCubicBezier(x1: b[0], y1: b[1], x2: b[2], y2: b[3])
        return { c($0) }
    case 5: return { $0 < 1 ? 0 : 1 }
    default: let c = ZnCubicBezier(x1: 0.4, y1: 0, x2: 0.2, y2: 1); return { c($0) }  // 4 without a bezier too
    }
}

// MARK: - JSON helpers

/// A JSON number (not a boolean), or nil.
func znJsonNumber(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
    return n.doubleValue
}

func znJsonBool(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { return false }
    return n.boolValue
}

/// A JSON array of numbers as floats (anything else, or not finite, is 0), as ZnMotion.floats.
func znJsonFloats(_ v: Any?) -> [Float] {
    guard let a = v as? [Any] else { return [] }
    return a.map { x in
        let f = Float(znJsonNumber(x) ?? 0)
        return f.isFinite ? f : 0
    }
}

// MARK: - Curves

/// One run from where a value is to where it goes: pure functions of the time since it started (ns).
protocol ZnMotionCurve {
    var durationNs: Int64 { get }
    func value(_ ns: Int64) -> Float
    /// Units per second.
    func velocity(_ ns: Int64) -> Float
}

/// A plugin's custom curve (Android: ZnMotionApi.Driver). Pure functions of time, called each frame: no allocation.
protocol ZnMotionDriver {
    var durationNanos: Int64 { get }
    func value(_ timeNanos: Int64) -> Float
    func velocity(_ timeNanos: Int64) -> Float
}

/// Makes a driver for one `v.to(x, { driver, params })`: where it starts, where it goes, its speed, JS's params.
typealias ZnMotionDriverFactory = (_ from: Float, _ to: Float, _ velocity: Float, _ params: [String: Any]) -> ZnMotionDriver

/// The drivers plugins registered (Android: ZnMotionApi.registerDriver), by "plugin.name". Main thread.
enum ZnMotionDrivers {
    nonisolated(unsafe) private static var all: [String: ZnMotionDriverFactory] = [:]
    static func register(_ name: String, _ factory: @escaping ZnMotionDriverFactory) { all[name] = factory }
    static func find(_ name: String) -> ZnMotionDriverFactory? { all[name] }
}

/// A plugin driver as a curve (ZnDriverAnimation): at its end it is at the target; a value that isn't finite is too.
struct ZnDriverCurve: ZnMotionCurve {
    let d: ZnMotionDriver
    let target: Float
    var durationNs: Int64 { max(0, d.durationNanos) }
    func value(_ ns: Int64) -> Float {
        if ns >= durationNs { return target }
        let v = d.value(ns)
        return v.isFinite ? v : target
    }
    func velocity(_ ns: Int64) -> Float {
        if ns >= durationNs { return 0 }
        let v = d.velocity(ns)
        return v.isFinite ? v : 0
    }
}

/// A tween (Compose's FloatTweenSpec): time over the length, eased, between the two; its speed by a 1 ms step back.
struct ZnTweenCurve: ZnMotionCurve {
    let from: Float, to: Float, ms: Int
    let ease: ZnEase
    var durationNs: Int64 { Int64(ms) * 1_000_000 }

    private func at(_ ns: Int64) -> Float {
        let t = min(max(ns, 0), durationNs)
        let raw: Float = ms == 0 ? 1 : Float(t) / Float(durationNs)
        let f = Float(ease(Double(raw)))
        return from * (1 - f) + to * f
    }

    func value(_ ns: Int64) -> Float { ns >= durationNs ? to : at(ns) }

    func velocity(_ ns: Int64) -> Float {
        let t = min(max(ns, 0), durationNs)
        if t == 0 { return 0 }  // a tween starts at rest (Android passes 0 as its start velocity)
        return (at(t) - at(t - 1_000_000)) * 1000
    }
}

/// A damped spring from [from] to [to] starting at [v0] (Compose's SpringSimulation, mass 1), evaluated at whole ms as
/// Compose does. It ends when Compose's estimate says it is within [threshold] (0.01 for commands, 0.001 for follow).
struct ZnSpringCurve: ZnMotionCurve {
    let from: Float, to: Float, v0: Float
    let ratio: Float, stiffness: Float
    let durationNs: Int64

    init(from: Float, to: Float, v0: Float, ratio: Float, stiffness: Float, threshold: Float = 0.01) {
        self.from = from; self.to = to; self.v0 = v0; self.ratio = ratio; self.stiffness = stiffness
        let ms = znSpringDurationMs(stiffness: stiffness, ratio: ratio, velocity: v0 / threshold,
                                    displacement: (from - to) / threshold, delta: 1)
        durationNs = ms >= Int64.max / 1_000_000 ? Int64.max : ms * 1_000_000
    }

    /// (value, velocity) after [ns] (whole ms, as Compose's FloatSpringSpec).
    func sample(_ ns: Int64) -> (Float, Float) {
        let ms = ns / 1_000_000
        let x0 = Double(from - to)
        let v = Double(v0)
        let dt = Double(ms) / 1000.0
        let z = Double(ratio)
        let w = Double(stiffness).squareRoot()
        let r = -z * w
        var x: Double, vel: Double
        if z > 1 {
            let s = w * (z * z - 1).squareRoot()
            let gp = r + s, gm = r - s
            let b = (gm * x0 - v) / (gm - gp)
            let a = x0 - b
            x = a * exp(gm * dt) + b * exp(gp * dt)
            vel = a * gm * exp(gm * dt) + b * gp * exp(gp * dt)
        } else if z == 1 {
            let a = x0
            let b = v + w * x0
            let n = -w * dt
            x = (a + b * dt) * exp(n)
            vel = (a + b * dt) * exp(n) * -w + b * exp(n)
        } else {
            let wd = w * (1 - z * z).squareRoot()
            let cosC = x0
            let sinC = (1 / wd) * (-r * x0 + v)
            let d = wd * dt
            x = exp(r * dt) * (cosC * cos(d) + sinC * sin(d))
            vel = x * r + exp(r * dt) * (-wd * cosC * sin(d) + wd * sinC * cos(d))
        }
        return (Float(x + Double(to)), Float(vel))
    }

    func value(_ ns: Int64) -> Float { ns >= durationNs ? to : sample(ns).0 }
    func velocity(_ ns: Int64) -> Float { ns >= durationNs ? 0 : sample(ns).1 }
}

/// Compose's SpringEstimation.estimateAnimationDurationMillis: how long until the spring stays within [delta] of the
/// target, displacement and velocity given in units of the threshold.
func znSpringDurationMs(stiffness: Float, ratio: Float, velocity: Float, displacement: Float, delta: Float) -> Int64 {
    if ratio == 0 { return Int64.max / 1_000_000 }
    let k = Double(stiffness), z = Double(ratio)
    let dc = 2 * z * k.squareRoot()
    let partial = dc * dc - 4 * k
    let pr = partial < 0 ? 0 : partial.squareRoot()
    let pi = partial < 0 ? (-partial).squareRoot() : 0
    let r1 = (-dc + pr) * 0.5, i1 = pi * 0.5, r2 = (-dc - pr) * 0.5
    let p = Double(displacement), v = Double(velocity), d = Double(delta)
    if p == 0 && v == 0 { return 0 }
    let v0 = p < 0 ? -v : v
    let p0 = abs(p)
    let sec: Double
    if z > 1 {
        sec = znSpringOverDamped(r1, r2, p0, v0, d)
    } else if z < 1 {
        let c2 = (v0 - r1 * p0) / i1
        let c = (p0 * p0 + c2 * c2).squareRoot()
        sec = log(d / c) / r1
    } else {
        sec = znSpringCriticallyDamped(r1, p0, v0, d)
    }
    let ms = sec * 1000
    if !ms.isFinite { return ms > 0 ? Int64.max / 1_000_000 : 0 }
    return max(0, Int64(ms))
}

private func znNewton(_ x: Double, _ f: (Double) -> Double, _ fp: (Double) -> Double) -> Double { x - f(x) / fp(x) }

private func znSpringCriticallyDamped(_ r: Double, _ p0: Double, _ v0: Double, _ delta: Double) -> Double {
    let c1 = p0
    let c2 = v0 - r * c1
    let t1 = log(abs(delta / c1)) / r
    let guess = log(abs(delta / c2))
    var tt = guess
    for _ in 0...5 { tt = guess - log(abs(tt / r)) }
    let t2 = tt / r
    var t = !t1.isFinite ? t2 : !t2.isFinite ? t1 : max(t1, t2)
    let tInf = -(r * c1 + c2) / (r * c2)
    let xInf = (c1 + c2 * tInf) * exp(r * tInf)
    let signed: Double
    if tInf.isNaN || tInf <= 0 {
        signed = -delta
    } else if tInf > 0 && -xInf < delta {
        if c2 < 0 && c1 > 0 { t = 0 }
        signed = -delta
    } else {
        t = -(2 / r) - (c1 / c2)
        signed = delta
    }
    var step = Double.greatestFiniteMagnitude
    var n = 0
    while step > 0.001 && n < 100 {
        n += 1
        let last = t
        t = znNewton(t, { (c1 + c2 * $0) * exp(r * $0) + signed }, { (c2 * (r * $0 + 1) + c1 * r) * exp(r * $0) })
        step = abs(last - t)
    }
    return t
}

private func znSpringOverDamped(_ r1: Double, _ r2: Double, _ p0: Double, _ v0: Double, _ delta: Double) -> Double {
    let c2 = (r1 * p0 - v0) / (r1 - r2)
    let c1 = p0 - c2
    let t1 = log(abs(delta / c1)) / r1
    let t2 = log(abs(delta / c2)) / r2
    var t = !t1.isFinite ? t2 : !t2.isFinite ? t1 : max(t1, t2)
    let tInf = log((c1 * r1) / (-c2 * r2)) / (r2 - r1)
    let xInf = c1 * exp(r1 * tInf) + c2 * exp(r2 * tInf)
    let signed: Double
    if tInf.isNaN || tInf <= 0 {
        signed = -delta
    } else if tInf > 0 && -xInf < delta {
        if c2 > 0 && c1 < 0 { t = 0 }
        signed = -delta
    } else {
        t = log(-(c2 * r2 * r2) / (c1 * r1 * r1)) / (r1 - r2)
        signed = delta
    }
    let f: (Double) -> Double = { c1 * exp(r1 * $0) + c2 * exp(r2 * $0) + signed }
    let fp: (Double) -> Double = { c1 * r1 * exp(r1 * $0) + c2 * r2 * exp(r2 * $0) }
    if abs(fp(t)) < 0.0001 { return t }
    var step = Double.greatestFiniteMagnitude
    var n = 0
    while step > 0.001 && n < 100 {
        n += 1
        let last = t
        t = znNewton(t, f, fp)
        step = abs(last - t)
    }
    return t
}

/// Slowing down from [v0] (Compose's FloatExponentialDecaySpec with friction 4.2 × [multiplier], whole ms): it ends
/// when the speed is under 0.1 a second, at the place it glides to.
struct ZnDecayCurve: ZnMotionCurve {
    let from: Float, v0: Float
    let friction: Float
    let durationNs: Int64
    let target: Float

    init(from: Float, v0: Float, multiplier: Float) {
        self.from = from; self.v0 = v0
        friction = -4.2 * max(0.0001, multiplier)
        let threshold: Float = 0.1
        if abs(v0) <= threshold {
            durationNs = 0
            target = from
        } else {
            let sec = log(threshold / abs(v0)) / friction
            durationNs = max(0, Int64(sec * 1000)) * 1_000_000
            let t = Double(log(abs(threshold / v0)) / friction * 1000)
            target = from - v0 / friction + v0 / friction * Float(exp(Double(friction) * t / 1000))
        }
    }

    func value(_ ns: Int64) -> Float {
        if ns >= durationNs { return target }
        let ms = Float(ns / 1_000_000)
        return from - v0 / friction + v0 / friction * exp(friction * ms / 1000)
    }

    func velocity(_ ns: Int64) -> Float {
        if ns >= durationNs { return 0 }
        let ms = Float(ns / 1_000_000)
        return v0 * exp((ms / 1000) * friction)
    }
}

// MARK: - Timing

/// How a value moves to a target (ZnTimingSpec in ZnMotion.kt). [ms] ≥ 0: a tween with [easing] ([bezier] for 4);
/// else a spring with [ratio] and [stiffness]. [clamp]: a spring stops at the target the first time it gets there
/// (Reanimated overshootClamp). [driver]: a plugin's curve with JS's [params].
struct ZnTimingSpec {
    let ms: Int, easing: Int, bezier: [Double]?
    let ratio: Float, stiffness: Float, clamp: Bool
    var driver: ZnMotionDriverFactory? = nil
    var params: [String: Any]? = nil

    /// The default spring (as `animate="spring"`).
    static let spring = ZnTimingSpec(ms: -1, easing: 0, bezier: nil, ratio: 0.75, stiffness: 400, clamp: false)

    func curve(from: Float, to: Float, velocity: Float) -> ZnMotionCurve {
        if let driver { return ZnDriverCurve(d: driver(from, to, velocity, params ?? [:]), target: to) }
        if ms >= 0 { return ZnTweenCurve(from: from, to: to, ms: ms, ease: znEasing(easing, bezier)) }
        return ZnSpringCurve(from: from, to: to, v0: velocity, ratio: ratio, stiffness: stiffness)
    }

    /// {"t":ms,"e":easing,"b":[x1,y1,x2,y2]} | {"r":dampingRatio,"k":stiffness,"c":true} | {"d":driver,"p":params}.
    static func parse(_ o: [String: Any]?) throws -> ZnTimingSpec {
        guard let o else { return spring }
        if o["d"] != nil {
            let name = o["d"] as? String ?? ""
            guard let f = ZnMotionDrivers.find(name) else {
                throw ZnInvalidArgs("no motion driver \"\(name)\" in this app (its plugin is missing)")
            }
            return ZnTimingSpec(ms: -1, easing: 0, bezier: nil, ratio: 1, stiffness: 0, clamp: false, driver: f,
                                params: o["p"] as? [String: Any])
        }
        if o["t"] != nil {
            let b = (o["b"] as? [Any]).map { a in (0..<4).map { a.indices.contains($0) ? znJsonNumber(a[$0]) ?? 0 : 0 } }
            let t = znJsonNumber(o["t"]).map { Int(max(0, min(60_000, $0))) } ?? 250
            return ZnTimingSpec(ms: t, easing: znJsonNumber(o["e"]).map { Int($0) } ?? 0, bezier: b, ratio: 1,
                                stiffness: 0, clamp: false)
        }
        let r = znJsonNumber(o["r"]).map { Float($0) }.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 0.75
        let k = znJsonNumber(o["k"]).map { Float($0) }.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 400
        return ZnTimingSpec(ms: -1, easing: 0, bezier: nil, ratio: r, stiffness: k, clamp: znJsonBool(o["c"]))
    }
}

/// follow(): one frame of a spring that chases a target, keeping its speed (ZnFollowSource's frame). A duration or a
/// driver becomes a critically damped spring that settles in about that time. Rests within 0.001.
struct ZnFollowStepper {
    let ratio: Float, stiffness: Float
    static let rest: Float = 0.001

    init(_ t: ZnTimingSpec) {
        if t.ms >= 0 || t.driver != nil {
            let sec = Float(t.ms > 0 ? t.ms : 300) / 1000
            let w = 6.6 / sec
            ratio = 1; stiffness = w * w
        } else {
            ratio = t.ratio; stiffness = t.stiffness
        }
    }

    /// The value and speed [dtNs] later, and whether it came to rest at the target.
    func step(value: Float, velocity: Float, target: Float, dtNs: Int64) -> (value: Float, velocity: Float, rests: Bool) {
        let c = ZnSpringCurve(from: value, to: target, v0: velocity, ratio: ratio, stiffness: stiffness, threshold: Self.rest)
        let v = c.value(dtNs), vel = c.velocity(dtNs)
        if abs(v - target) < Self.rest && abs(vel) < Self.rest * 10 { return (target, 0, true) }
        return (v, vel, false)
    }
}

/// Reanimated's withDecay `deceleration` (velocity kept per ms, 0.998) → Compose's exponential decay friction.
func znFriction(_ deceleration: Double) -> Float {
    let d = deceleration.isFinite && deceleration > 0.9 && deceleration < 1 ? deceleration : 0.998
    return Float(-1000 * log(d) / 4.2)
}

// MARK: - Interpolation

/// Piecewise straight lines through ([ins], [outs]). [ex]: 0 clamp (hold the end values), 1 extend (keep the end
/// slopes), 2 identity (outside the inputs the output is the input).
func znInterpolate(_ x: Float, _ ins: [Float], _ outs: [Float], _ ex: Int) -> Float {
    let n = ins.count
    if n == 0 { return x }
    if n == 1 { return outs[0] }
    if x <= ins[0] || x >= ins[n - 1] {
        let low = x <= ins[0]
        switch ex {
        case 0: return low ? outs[0] : outs[n - 1]
        case 2: return x
        default: break
        }
        let i = low ? 0 : n - 2
        return znSegment(x, ins[i], ins[i + 1], outs[i], outs[i + 1])
    }
    var i = 0
    while i < n - 2 && x > ins[i + 1] { i += 1 }
    return znSegment(x, ins[i], ins[i + 1], outs[i], outs[i + 1])
}

private func znSegment(_ x: Float, _ x0: Float, _ x1: Float, _ y0: Float, _ y1: Float) -> Float {
    let span = x1 - x0
    if span == 0 { return y0 }
    return y0 + (y1 - y0) * (x - x0) / span
}

/// ARGB colours mixed channel by channel along [ins] (clamped at the ends).
func znMixColors(_ x: Float, _ ins: [Float], _ colors: [UInt32]) -> UInt32 {
    let n = ins.count
    if n == 0 || colors.count < n { return 0 }
    if n == 1 || x <= ins[0] { return colors[0] }
    if x >= ins[n - 1] { return colors[n - 1] }
    var i = 0
    while i < n - 2 && x > ins[i + 1] { i += 1 }
    let span = ins[i + 1] - ins[i]
    let t = span == 0 ? 0 : (x - ins[i]) / span
    return znMixArgb(colors[i], colors[i + 1], t)
}

func znMixArgb(_ a: UInt32, _ b: UInt32, _ t: Float) -> UInt32 {
    func ch(_ shift: UInt32) -> UInt32 {
        let x = Float((a >> shift) & 0xFF), y = Float((b >> shift) & 0xFF)
        let m = x + (y - x) * t
        let i = m.isFinite ? Int(m) : 0  // toward zero, as Kotlin's toInt
        return UInt32(min(max(i, 0), 255)) << shift
    }
    return ch(24) | ch(16) | ch(8) | ch(0)
}

/// A JSON colour number (ARGB, maybe written as a negative Int32 by Android-minded code) as ARGB bits.
func znArgb(_ v: Any?) -> UInt32 {
    guard let d = znJsonNumber(v), d.isFinite else { return 0 }
    return UInt32(truncatingIfNeeded: Int64(d))
}

// MARK: - Number format

/// A number shown as text, without locale objects per frame (plan D5): decimals 0–2, grouping "en-IN" (12,34,567),
/// "standard" (1,234,567) or "none", a prefix (₹) and suffix. The minus sign goes before the prefix: -₹1,234.
struct ZnNumberFormat {
    let decimals: Int, grouping: Int, prefix: String, suffix: String
    static let indian = 1, standard = 2, none = 0

    func format(_ v: Float) -> String {
        if !v.isFinite { return prefix + "0" + suffix }
        let scale: Int64 = decimals == 1 ? 10 : decimals == 2 ? 100 : 1
        // Half away from zero, as people round money.
        let scaled = Int64((abs(Double(v)) * Double(scale) + 0.5).rounded(.down))
        let whole = scaled / scale, frac = scaled % scale
        var s = ""
        if v < 0 && scaled != 0 { s += "-" }
        s += prefix
        s += group(String(whole))
        if decimals > 0 {
            s += "."
            let f = String(frac)
            s += String(repeating: "0", count: max(0, decimals - f.count)) + f
        }
        return s + suffix
    }

    private func group(_ d: String) -> String {
        if grouping == Self.none || d.count <= 3 { return d }
        let chars = Array(d)
        let last3 = String(chars[(chars.count - 3)...])
        let rest = Array(chars[..<(chars.count - 3)])
        let size = grouping == Self.indian ? 2 : 3
        var parts: [String] = []
        var end = rest.count
        while end > 0 {
            let start = max(0, end - size)
            parts.insert(String(rest[start..<end]), at: 0)
            end = start
        }
        return parts.joined(separator: ",") + "," + last3
    }

    /// {"d": decimals, "g": "en-IN" | "standard" | "none", "p": prefix, "s": suffix}; bad JSON gives the defaults.
    static func parse(_ json: String?) -> ZnNumberFormat {
        let o = json.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
        let g: Int
        switch o["g"] as? String ?? "en-IN" {
        case "none": g = none
        case "standard": g = standard
        default: g = indian
        }
        let d = znJsonNumber(o["d"]).map { Int($0) } ?? 0
        return ZnNumberFormat(decimals: min(max(d, 0), 2), grouping: g, prefix: o["p"] as? String ?? "",
                              suffix: o["s"] as? String ?? "")
    }
}
