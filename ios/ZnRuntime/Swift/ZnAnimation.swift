// Animation on iOS (ARCHITECTURE §10, step 3.6), as android/runtime's ZnAnimation.kt. JS only ever sends target
// values; native animates to them with the element's own tween or spring (`animate`, registry 13). Same encoding:
// a tween "t<ms>e<easing>" or a spring "s<dampingRatio>,<stiffness>", then options after "~": "d" delay, "r" plays
// (-1 forever), "v" reverse, "g" repeat delay, "f" from, "k" keyframes, "m" keyframe times, "b" cubic-bezier,
// "z" an easing per keyframe segment, "w" waits for a tap on the Svg.
//
// Two kinds, as on Android:
// - A value that follows JS (a slot) animates to each new value: a SwiftUI animation scoped to that one modifier
//   (ZnLayer). The first value shows as it is.
// - A value that plays by itself (`from` or `keyframes`): ZnMotion, on a frame clock (one CADisplayLink for the app),
//   when the element appears, again on each new `replay`, and (with `from`) when the resting value changes. Time
//   runs only while not `paused`. A finite run stays where its last play ended.
// Animations off: Android jumps to the end (and shows a self-playing value at rest) when the phone's animations are
// off (developer options, "Remove animations"); iOS does the same when Reduce Motion is on (znAnimationsOff, the one
// place that reads it). Colours interpolate in sRGB (Compose: its own colour space).
import QuartzCore
import SwiftUI
import UIKit

/// The phone's animations are off: Reduce Motion, iOS's nearest to Android's "Remove animations" (Pavan,
/// 2026-11-21). Values jump to where they end; self-playing values show their resting value.
func znAnimationsOff() -> Bool { UIAccessibility.isReduceMotionEnabled }

// ZnEase, ZnCubicBezier and znEasing are in ZnMotionMath.swift (motion values use them too).

/// One `animate` timing (ZnTiming in ZnAnimation.kt).
final class ZnTiming {
    /// Tween length, or -1 for a spring.
    let ms: Int
    let easing: Int
    let damping: Double
    let stiffness: Double
    let delayMs: Int
    /// Plays in all; -1 forever.
    let plays: Int
    let reverse: Bool
    let repeatDelayMs: Int
    let from: String?
    let keyframes: [String]?
    let times: [Double]?
    let bezier: [Double]?
    let segments: [ZnEase]?
    let waitsForTap: Bool

    /// Plays by itself (when the element appears, and on replay), not when a value changes.
    var selfPlaying: Bool { from != nil || keyframes != nil }

    init(ms: Int, easing: Int, damping: Double, stiffness: Double, delayMs: Int, plays: Int, reverse: Bool,
         repeatDelayMs: Int, from: String?, keyframes: [String]?, times: [Double]?, bezier: [Double]?,
         segments: [ZnEase]?, waitsForTap: Bool) {
        self.ms = ms; self.easing = easing; self.damping = damping; self.stiffness = stiffness
        self.delayMs = delayMs; self.plays = plays; self.reverse = reverse; self.repeatDelayMs = repeatDelayMs
        self.from = from; self.keyframes = keyframes; self.times = times; self.bezier = bezier
        self.segments = segments; self.waitsForTap = waitsForTap
    }

    var curve: ZnEase { znEasing(easing, bezier) }

    static func parse(_ s: String) -> ZnTiming? {
        let pieces = s.split(separator: "~", omittingEmptySubsequences: false).map(String.init)
        let b = pieces[0]
        var delay = 0, plays = 1, gap = 0
        var reverse = false, tap = false
        var from: String?
        var keys: [String]?
        var times: [Double]?
        var bezier: [Double]?
        var segments: [ZnEase]?
        for o in pieces.dropFirst() where !o.isEmpty {
            let v = String(o.dropFirst())
            switch o.first! {
            case "d": guard let n = Int(v) else { return nil }; delay = n
            case "r": guard let n = Int(v) else { return nil }; plays = n
            case "v": reverse = true
            case "w": tap = true
            case "g": guard let n = Int(v) else { return nil }; gap = n
            case "f": from = v
            case "k": keys = v.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
            case "m":
                let t = v.split(separator: ":").compactMap { Double($0) }
                guard t.count == v.split(separator: ":").count else { return nil }
                times = t
            case "b":
                let n = v.split(separator: ":").compactMap { Double($0) }
                bezier = n.count == 4 ? n : nil
            case "z":
                var list: [ZnEase] = []
                for seg in v.split(separator: ":") {
                    let n = seg.split(separator: ",")
                    guard let id = Int(n[0]) else { return nil }
                    let bz = n.count == 5 ? n.dropFirst().compactMap { Double($0) } : nil
                    list.append(znEasing(id, bz))
                }
                segments = list
            default: break  // a later option: ignored (the bundle asks for the registry that knows it)
            }
        }
        if b.hasPrefix("t") {
            let body = b.dropFirst()
            let parts = body.split(separator: "e", maxSplits: 1)
            guard let ms = Int(parts.first ?? "") else { return nil }
            let easing = parts.count > 1 ? Int(parts[1]) ?? 0 : 0
            return ZnTiming(ms: ms, easing: easing, damping: 1, stiffness: 0, delayMs: delay, plays: plays,
                            reverse: reverse, repeatDelayMs: gap, from: from, keyframes: keys, times: times,
                            bezier: bezier, segments: segments, waitsForTap: tap)
        }
        if b.hasPrefix("s") {
            let parts = b.dropFirst().split(separator: ",")
            return ZnTiming(ms: -1, easing: 0, damping: parts.count > 0 ? Double(parts[0]) ?? 0.75 : 0.75,
                            stiffness: parts.count > 1 ? Double(parts[1]) ?? 400 : 400, delayMs: delay, plays: plays,
                            reverse: reverse, repeatDelayMs: gap, from: from, keyframes: keys, times: times,
                            bezier: bezier, segments: segments, waitsForTap: tap)
        }
        return nil
    }

    /// The SwiftUI animation for a value that follows JS: the same tween or spring, after the delay.
    var animation: Animation {
        if znAnimationsOff() { return .linear(duration: 0) }
        let base: Animation
        if ms < 0 {
            // Compose's spring(dampingRatio, stiffness), mass 1.
            base = .interpolatingSpring(mass: 1, stiffness: stiffness, damping: 2 * damping * stiffness.squareRoot())
        } else {
            let d = Double(max(ms, 0)) / 1000
            switch easing {
            case 1: base = .timingCurve(0, 0, 0.2, 1, duration: d)
            case 2: base = .timingCurve(0.4, 0, 1, 1, duration: d)
            case 3: base = .linear(duration: d)
            case 4 where bezier?.count == 4: base = .timingCurve(bezier![0], bezier![1], bezier![2], bezier![3], duration: d)
            case 5: base = .linear(duration: 0).delay(d)  // holds, then jumps at the end
            default: base = .timingCurve(0.4, 0, 0.2, 1, duration: d)
            }
        }
        return delayMs > 0 ? base.delay(Double(delayMs) / 1000) : base
    }

    /// One play's length in ms: the tween's, or how long the spring takes to settle.
    lazy var lengthMs: Double = {
        if ms >= 0 { return Double(ms) }
        var t = 0.0
        while t < 10_000 {  // settled: within 0.1 % of the distance, and staying there for 50 ms
            if (0..<50).allSatisfy({ abs(springProgress(t + Double($0)) - 1) < 0.001 }) { return t }
            t += 10
        }
        return 10_000
    }()

    /// Where a spring from 0 to 1 is after [ms] (damped harmonic oscillator, mass 1, starting at rest).
    func springProgress(_ ms: Double) -> Double {
        let t = ms / 1000
        let w0 = stiffness.squareRoot()
        let z = damping
        if z < 1 {
            let wd = w0 * (1 - z * z).squareRoot()
            return 1 - exp(-z * w0 * t) * (cos(wd * t) + z * w0 / wd * sin(wd * t))
        } else if z == 1 {
            return 1 - exp(-w0 * t) * (1 + w0 * t)
        } else {
            let s = (z * z - 1).squareRoot()
            let r1 = -w0 * (z - s), r2 = -w0 * (z + s)
            return 1 - (r2 * exp(r1 * t) - r1 * exp(r2 * t)) / (r2 - r1)
        }
    }

    /// One play at [ms] (0…lengthMs) through [values]: keyframes (each segment its own easing, else this curve), or
    /// from the first to the last with this tween or spring.
    func value(at ms: Double, _ values: [[Double]]) -> [Double] {
        guard let first = values.first, let last = values.last else { return [] }
        let length = lengthMs
        if keyframes != nil, values.count >= 2 {
            let f = length > 0 ? min(max(ms / length, 0), 1) : 1
            let n = values.count
            func at(_ i: Int) -> Double {
                // Rounded to whole ms, as the compiler writes them (Android rounds the same way).
                let raw = times.flatMap { $0.indices.contains(i) ? $0[i] : nil } ?? Double(i) / Double(n - 1)
                return length > 0 ? (raw * length).rounded() / length : raw
            }
            var i = 0
            while i < n - 2 && f >= at(i + 1) { i += 1 }
            let a = at(i), b = at(i + 1)
            let local = b > a ? min(max((f - a) / (b - a), 0), 1) : 1
            let e = segments.flatMap { $0.indices.contains(i) ? $0[i] : nil } ?? curve
            return znLerp(values[i], values[i + 1], e(local))
        }
        let p: Double
        if self.ms < 0 { p = springProgress(ms) } else { p = length > 0 ? curve(min(max(ms / length, 0), 1)) : 1 }
        return znLerp(first, last, p)
    }
}

func znLerp(_ a: [Double], _ b: [Double], _ t: Double) -> [Double] {
    guard a.count == b.count else { return t < 1 ? a : b }
    return zip(a, b).map { $0 + ($1 - $0) * t }
}

/// `animate`: per prop id, or "*" for every animatable prop of the element (ZnAnimate in ZnAnimation.kt).
final class ZnAnimate {
    private let byProp: [Int: ZnTiming]
    private let all: ZnTiming?

    init(byProp: [Int: ZnTiming], all: ZnTiming?) { self.byProp = byProp; self.all = all }

    func timing(_ prop: Int) -> ZnTiming? { byProp[prop] ?? all }
    /// Some prop has a loop or keyframes.
    var selfPlaying: Bool { byProp.values.contains { $0.selfPlaying } }

    static func parse(_ s: String) -> ZnAnimate {
        var byProp: [Int: ZnTiming] = [:]
        var all: ZnTiming?
        for part in s.split(separator: ";") {
            guard let eq = part.firstIndex(of: "="), eq != part.startIndex,
                  let t = ZnTiming.parse(String(part[part.index(after: eq)...])) else { continue }
            let key = part[..<eq]
            if key == "*" { all = t } else if let id = Int(key) { byProp[id] = t }
        }
        return ZnAnimate(byProp: byProp, all: all)
    }
}

/// The position at [playTime] of a run of [plays] plays (-1 forever) of [length] each, [gap] apart; with [reverse]
/// every second play runs backwards. After the last play: where it ended, and done (motionAt in ZnAnimation.kt).
func znMotionAt(_ playTime: Double, length: Double, gap: Double, plays: Int, reverse: Bool) -> (time: Double, done: Bool) {
    let cycle = length + gap
    if cycle <= 0 { return (reverse && plays >= 0 && (plays - 1) % 2 == 1 ? 0 : length, true) }
    let index = (playTime / cycle).rounded(.down)
    if plays >= 0 && index >= Double(plays) {
        let forward = !reverse || (plays - 1) % 2 == 0
        return (forward ? length : 0, true)
    }
    let within = min(playTime - index * cycle, length)
    let forward = !reverse || Int(index) % 2 == 0
    return (forward ? within : length - within, false)
}

/// A motion value: a number, or "#AARRGGBB" (backgroundColor) as [a, r, g, b] 0…1.
func znMotionValue(_ s: String) -> [Double]? {
    if s.count == 9, s.first == "#", let v = UInt32(s.dropFirst(), radix: 16) {
        return [Double(v >> 24 & 0xFF), Double(v >> 16 & 0xFF), Double(v >> 8 & 0xFF), Double(v & 0xFF)].map { $0 / 255 }
    }
    return Double(s).map { [$0] }
}

func znColorVector(_ c: ZnValue?) -> [Double]? {
    let argb: UInt32
    switch c {
    case .color(let v): argb = v
    case .number(let n): argb = UInt32(truncatingIfNeeded: Int64(n))
    default: return nil
    }
    return [Double(argb >> 24 & 0xFF), Double(argb >> 16 & 0xFF), Double(argb >> 8 & 0xFF), Double(argb & 0xFF)].map { $0 / 255 }
}

func znColorFromVector(_ v: [Double]) -> Color? {
    guard v.count == 4 else { return nil }
    return Color(.sRGB, red: v[1], green: v[2], blue: v[3], opacity: v[0])
}

// MARK: - Frame clock

/// One CADisplayLink for every motion on screen; it runs only while some motion is playing.
@MainActor
final class ZnFrameClock {
    static let shared = ZnFrameClock()
    private var link: CADisplayLink?
    private var players: [ObjectIdentifier: (CFTimeInterval) -> Bool] = [:]

    private final class Target: NSObject {
        @objc func tick(_ l: CADisplayLink) { MainActor.assumeIsolated { ZnFrameClock.shared.tick(l.targetTimestamp) } }
    }
    private let target = Target()

    /// [frame] gets each frame's time; it answers false when it no longer needs frames.
    func add(_ owner: AnyObject, _ frame: @escaping (CFTimeInterval) -> Bool) {
        players[ObjectIdentifier(owner)] = frame
        if link == nil {
            let l = CADisplayLink(target: target, selector: #selector(Target.tick(_:)))
            // Up to 120 Hz on ProMotion phones (with CADisableMinimumFrameDurationOnPhone in the app's Info.plist),
            // as Android follows the display's rate.
            l.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            l.add(to: .main, forMode: .common)
            link = l
        }
    }

    func remove(_ owner: AnyObject) {
        players[ObjectIdentifier(owner)] = nil
        if players.isEmpty { link?.invalidate(); link = nil }
    }

    private func tick(_ now: CFTimeInterval) {
        for (id, frame) in players where !frame(now) { players[id] = nil }
        if players.isEmpty { link?.invalidate(); link = nil }
    }
}

// MARK: - Self-playing values

/// The props of one element that play by themselves (`from` / `keyframes`), each on its own track. Owned by the
/// element's view (@State), so it lives as long as the element is on screen.
@MainActor
@Observable
final class ZnMotion {
    /// The value to show per prop now; absent: the resting value.
    private(set) var values: [Int: [Double]] = [:]

    @ObservationIgnored private var tracks: [Int: Track] = [:]
    @ObservationIgnored private var paused = false
    /// Tracks held by their own `paused` (an SvgPart's), apart from the whole motion's.
    @ObservationIgnored private var pausedKeys = Set<Int>()
    @ObservationIgnored private var last: CFTimeInterval = -1
    @ObservationIgnored private var running = false

    private struct Track {
        let timing: ZnTiming
        var points: [[Double]]
        var rest: [Double]
        var playTime: Double  // ms, from -delay
        var done = false
    }

    /// The element appeared, or `replay` changed: every track starts again. [rests]: each prop's resting value now.
    func start(_ timings: [Int: ZnTiming], rests: [Int: [Double]], paused: Bool) {
        self.paused = paused
        tracks = [:]
        if znAnimationsOff() { values = [:]; return }  // the resting values, as Android with animations off
        for (prop, t) in timings { if let r = rests[prop] { restart(prop, t, rest: r) } }
        values = tracks.mapValues { $0.timing.value(at: 0, $0.points) }
        run()
    }

    /// Only these tracks start again (one SvgPart's `replay`, or a tap for timings that wait for one).
    func start(keys: [Int: ZnTiming], rests: [Int: [Double]]) {
        for (k, t) in keys { if let r = rests[k] { restart(k, t, rest: r) } }
        for k in keys.keys { values[k] = tracks[k].map { $0.timing.value(at: 0, $0.points) } }
        run()
    }

    /// A value that follows JS: from where it is now to [to], with [timing]'s tween or spring (on the frame clock, for
    /// drawings that read values themselves, such as an Svg's parts). A new target mid-way starts from where it is.
    func follow(_ key: Int, from: [Double], to: [Double], timing: ZnTiming) {
        let now = values[key] ?? from
        tracks[key] = Track(timing: timing, points: [now, to], rest: to, playTime: -Double(timing.delayMs))
        values[key] = now
        run()
    }

    /// Holds or lets go of some tracks (an SvgPart's own `paused`).
    func setPaused(_ p: Bool, keys: Set<Int>) {
        if p { pausedKeys.formUnion(keys) } else { pausedKeys.subtract(keys) }
        last = -1
        if !p { run() }
    }

    /// A resting value changed: a `from` track plays again towards it (keyframes don't depend on it).
    func restChanged(_ prop: Int, to rest: [Double]) {
        guard let tr = tracks[prop], tr.timing.keyframes == nil, tr.rest != rest else { return }
        restart(prop, tr.timing, rest: rest)
        values[prop] = tracks[prop].map { $0.timing.value(at: 0, $0.points) }
        run()
    }

    func setPaused(_ p: Bool) {
        paused = p
        last = -1
        if !p { run() }
    }

    func stop() {
        ZnFrameClock.shared.remove(self)
        running = false
    }

    private func restart(_ prop: Int, _ t: ZnTiming, rest: [Double]) {
        let points: [[Double]]
        if let k = t.keyframes {
            let p = k.compactMap(znMotionValue)
            guard p.count >= 2 else { return }
            points = p
        } else {
            points = [t.from.flatMap(znMotionValue) ?? rest, rest]
        }
        tracks[prop] = Track(timing: t, points: points, rest: rest, playTime: -Double(t.delayMs))
    }

    private func run() {
        guard !running, !paused, tracks.contains(where: { !$0.value.done && !pausedKeys.contains($0.key) }) else { return }
        running = true
        last = -1
        ZnFrameClock.shared.add(self) { [weak self] now in
            guard let self else { return false }
            return MainActor.assumeIsolated { self.frame(now) }
        }
    }

    private func frame(_ now: CFTimeInterval) -> Bool {
        if paused { running = false; return false }
        let step = last < 0 ? 0 : (now - last) * 1000
        last = now
        var next = values
        var any = false
        for (prop, var tr) in tracks where !tr.done && !pausedKeys.contains(prop) {
            tr.playTime += step
            if tr.playTime >= 0 {
                let at = znMotionAt(tr.playTime, length: tr.timing.lengthMs, gap: Double(tr.timing.repeatDelayMs),
                                    plays: tr.timing.plays, reverse: tr.timing.reverse)
                next[prop] = tr.timing.value(at: at.time, tr.points)
                tr.done = at.done
            }
            tracks[prop] = tr
            any = any || !tr.done
        }
        values = next
        if !any { running = false }
        return any
    }
}

// MARK: - Enter / exit

/// `enter` / `exit`: the state the element enters from or leaves to ("opacity,translateX,translateY,scale|timing";
/// registry 24 adds ",rotateX,rotateY,scaleX,scaleY" for the flip and stretch presets).
final class ZnTransition {
    let opacity: Double, translateX: Double, translateY: Double, scale: Double
    /// Degrees of 3D turn, and a stretch on one axis (0, 0, 1, 1 in the 4-value form).
    let rotateX: Double, rotateY: Double, scaleX: Double, scaleY: Double
    let timing: ZnTiming

    init(_ v: [Double], _ timing: ZnTiming) {
        opacity = v[0]; translateX = v[1]; translateY = v[2]; scale = v[3]
        let deep = v.count == 8
        rotateX = deep ? v[4] : 0; rotateY = deep ? v[5] : 0
        scaleX = deep ? v[6] : 1; scaleY = deep ? v[7] : 1
        self.timing = timing
    }

    /// It turns in 3D (ZnNodeSpec.hasDepth counts it).
    var turns: Bool { rotateX != 0 || rotateY != 0 }

    static func parse(_ s: String) -> ZnTransition? {
        guard let bar = s.firstIndex(of: "|") else { return nil }
        let parts = s[..<bar].split(separator: ",", omittingEmptySubsequences: false)
        let v = parts.compactMap { Double($0) }
        guard v.count == parts.count, v.count == 4 || v.count == 8,
              let t = ZnTiming.parse(String(s[s.index(after: bar)...])) else { return nil }
        return ZnTransition(v, t)
    }
}

/// Enter: from the `enter` state to the element's own values, once, when it first appears. Exit (only an instance's
/// root: it is what JS removes): JS removed it, ZnStore keeps it (exiting) until this has played, then drops it.
/// Applied over the element's layer, so the two multiply as on Android (one graphicsLayer there). A leaving element
/// takes no taps.
struct ZnEnterExit: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @State private var inP: Double = 0
    @State private var outP: Double = 0

    private func inV(_ from: Double?, _ rest: Double) -> Double { from.map { $0 + (rest - $0) * inP } ?? rest }
    private func outV(_ to: Double?, _ rest: Double) -> Double { to.map { rest + ($0 - rest) * outP } ?? rest }

    func body(content: Content) -> some View {
        let enter = s.enter
        let exit = s.index == 0 ? s.exit : nil
        let exiting = exit != nil && inst.exiting.on
        // Android multiplies scale and the one-axis stretch into one scaleX / scaleY, and turns in 3D on the same layer.
        let sx = inV(enter?.scale, 1) * outV(exit?.scale, 1) * inV(enter?.scaleX, 1) * outV(exit?.scaleX, 1)
        let sy = inV(enter?.scale, 1) * outV(exit?.scale, 1) * inV(enter?.scaleY, 1) * outV(exit?.scaleY, 1)
        let turns = enter?.turns == true || exit?.turns == true
        content
            .scaleEffect(x: max(sx, 1e-4), y: max(sy, 1e-4), anchor: s.origin)
            .modifier(ZnDepthEffect(rotateX: turns ? inV(enter?.rotateX, 0) + outV(exit?.rotateX, 0) : 0,
                                    rotateY: turns ? inV(enter?.rotateY, 0) + outV(exit?.rotateY, 0) : 0,
                                    cameraDistance: s.cameraDistance, origin: s.origin))
            .offset(x: inV(enter?.translateX, 0) + outV(exit?.translateX, 0), y: inV(enter?.translateY, 0) + outV(exit?.translateY, 0))
            .opacity(inV(enter?.opacity, 1) * outV(exit?.opacity, 1))
            .allowsHitTesting(!exiting)
            .onAppear {
                if exit != nil { inst.hasExit = true }
                if let enter, inP == 0 { withAnimation(enter.timing.animation) { inP = 1 } }
            }
            .onChange(of: exiting, initial: true) { _, leaving in
                guard leaving, let exit else { return }
                let id = inst.id
                withAnimation(exit.timing.animation, completionCriteria: .logicallyComplete) { outP = 1 } completion: {
                    ZnApp.shared.store.finishExit(id)
                }
            }
    }
}
