// Motion values on iOS (Android: ZnMotion.kt; docs/gestures-and-motion-v1.md §2.1, §2.2, §2.4). Numbers owned by
// native and moved on the main thread: by a finger (gestures), by an animation JS asked for, or by a formula of other
// values. A binding reads them where it draws (a leaf modifier reads a ZnCell, which is @Observable), so a moving value
// redraws only that modifier, never the subtree. JS only creates them, sends commands, and reads them (at most once
// per frame, and only the ones it watches).
//
// A slot that follows a value holds "\u{0}m<id>" (core motion.ts); a Text slot that shows one as text holds
// "\u{0}f<id>|<format json>". Foundation and Observation only: the frame clock, the JS side and the setting that turns
// animations off come in from ZnMotionModule.swift, so the Mac unit suite (ios/tests/motion) runs this file as it is.
// Main thread only, as on Android.
//
// The parts later work hooks into (critic concern 7): sources (ZnSource, ZnCell) with put / find / ref and a
// generation counter; animate / decay with a completion; heldBy / onCommand for gestures; sendEvent, which sends the
// values still waiting first; onDirty subscribers (a value moved this frame); onFrame subscribers (plugins);
// element(id) with its refresh hook (measure); disposal and reset hooks (gestures, tilt); ZnMotionDrivers.
import Foundation
import Observation

// MARK: - Cells and sources

/// One number a binding reads. Writes that change nothing (or aren't finite) are skipped: Observation notifies on
/// every assignment, so this keeps idle bindings quiet. Every real change tells the engine (watch, follow, onDirty).
@Observable
final class ZnCell {
    private(set) var v: Float

    init(_ v: Float) { self.v = v.isFinite ? v : 0 }

    func write(_ x: Float) {
        guard x.isFinite, x != v else { return }
        v = x
        ZnMotionEngine.shared.markDirty()
    }
}

/// The sizes a formula's `self` / `parent` read (points): the node it is bound on, or the node of the gesture that
/// uses it.
@Observable
final class ZnSite {
    private(set) var selfW: Float = 0
    private(set) var selfH: Float = 0
    private(set) var parentW: Float = 0
    private(set) var parentH: Float = 0

    func update(_ w: Float, _ h: Float, _ pw: Float, _ ph: Float) {
        if selfW != w { selfW = w }
        if selfH != h { selfH = h }
        if parentW != pw { parentW = pw }
        if parentH != ph { parentH = ph }
    }
}

/// Something a binding can follow, read where it draws so SwiftUI tracks the cells it reads.
class ZnSource {
    let id: Int
    init(id: Int) { self.id = id }
    /// The number now. Never NaN or infinite: a source that can't say gives its last good value.
    func read(_ site: ZnSite?) -> Float { 0 }
    /// ARGB, for colour sources ([isColor]).
    func readColor(_ site: ZnSite?) -> UInt32 { 0 }
    var isColor: Bool { false }
    /// Uses `self` / `parent` (only formulas).
    var usesSite: Bool { false }
    func dispose() {}
}

/// What holds a value under a finger (a gesture's touch): a command to the value cancels it when it may.
protocol ZnMotionHolder: AnyObject {
    func cancel()
}

/// A value JS made with useMotion (or a gesture's x, y, scale...).
final class ZnMotionValue: ZnSource {
    let cell: ZnCell
    /// Units per second of the animation that moves it now, or that moved it last (for velocity hand-off).
    var velocity: Float = 0
    /// The command that moves it now (its completion still open).
    var run: ZnRun?
    var seq = 0
    /// The gesture whose finger holds this value, or nil.
    weak var heldBy: ZnMotionHolder?
    /// Called when JS sends it a command (a gesture resting on an anchor stops following it).
    var onCommand: (() -> Void)?
    /// A plugin's value: its work stops when JS drops it.
    var onDispose: (() -> Void)?

    init(id: Int, _ initial: Float) {
        cell = ZnCell(initial)
        super.init(id: id)
    }

    var value: Float {
        get { cell.v }
        set { cell.write(newValue) }
    }

    override func read(_ site: ZnSite?) -> Float { cell.v }

    /// Stops what moves it; its completion says finished: false. Keeps the velocity it had.
    func interrupt() {
        let r = run
        run = nil
        r?.finish(false)
    }

    override func dispose() {
        interrupt()
        if let d = onDispose {
            onDispose = nil
            d()
        }
    }
}

/// A value a native component gives while it is shown (a Scroll's offset, a Carousel's page): the component sets
/// [reader] (a read of its own observed state), and calls ZnMotionEngine.shared.markDirty() when it moves. Keeps the
/// last value when the component goes away.
final class ZnLambdaSource: ZnSource {
    var reader: (() -> Float)? {
        didSet { given.write(given.v + 1) }  // (a write marks the engine dirty)
    }
    /// Read by read(), so a binding that read this before its component gave a reader (or after it took it back) draws
    /// again when that changes: the reader itself isn't observed (Android's reader is a MutableState).
    private let given = ZnCell(0)
    private var last: Float = 0
    override func read(_ site: ZnSite?) -> Float {
        _ = given.v
        guard let r = reader else { return last }
        let v = r()
        if v.isFinite { last = v }
        return last
    }
}

/// A window value (§2.2): width, height, insets, keyboard. Written by the screen host (motion-env).
final class ZnEnvValue: ZnSource {
    let cell = ZnCell(0)
    override func read(_ site: ZnSite?) -> Float { cell.v }
    func set(_ v: Float) { cell.write(v) }
}

/// `v.map([in], [out], { extrapolate })`: piecewise straight lines.
final class ZnMapSource: ZnSource {
    private let src: ZnSource, ins: [Float], outs: [Float], ex: Int
    init(id: Int, _ src: ZnSource, _ ins: [Float], _ outs: [Float], _ ex: Int) {
        self.src = src; self.ins = ins; self.outs = outs; self.ex = ex
        super.init(id: id)
    }
    override func read(_ site: ZnSite?) -> Float { znInterpolate(src.read(site), ins, outs, ex) }
    override var usesSite: Bool { src.usesSite }
}

/// `v.mapColor([in], [colours])`: ARGB mixed along the input.
final class ZnColorMapSource: ZnSource {
    private let src: ZnSource, ins: [Float], colors: [UInt32]
    init(id: Int, _ src: ZnSource, _ ins: [Float], _ colors: [UInt32]) {
        self.src = src; self.ins = ins; self.colors = colors
        super.init(id: id)
    }
    override var isColor: Bool { true }
    override var usesSite: Bool { src.usesSite }
    override func read(_ site: ZnSite?) -> Float { src.read(site) }
    override func readColor(_ site: ZnSite?) -> UInt32 { znMixColors(src.read(site), ins, colors) }
}

/// `derive(() => ...)`: a formula of other sources (ZnFormula.swift). Keeps its last finite value.
final class ZnFormulaSource: ZnSource {
    private let f: ZnFormula
    private var last: Float = 0
    init(id: Int, _ f: ZnFormula) {
        self.f = f
        super.init(id: id)
    }
    override var isColor: Bool { f.isColor }
    override var usesSite: Bool { f.usesSite }
    override func read(_ site: ZnSite?) -> Float {
        let v = f.eval(site)
        if v.isFinite { last = v }
        return last
    }
    override func readColor(_ site: ZnSite?) -> UInt32 { f.evalColor(site) }
}

/// `follow(source, spring)`: chases [src] with spring physics frame by frame, keeping its speed when the target moves.
/// Asleep while it rests where the source is; the engine wakes it when a value moves.
final class ZnFollowSource: ZnSource {
    private let src: ZnSource
    private let v: ZnMotionValue
    private let stepper: ZnFollowStepper
    private(set) var awake = false
    private var last: Int64?

    init(id: Int, _ src: ZnSource, _ timing: ZnTimingSpec) {
        self.src = src
        v = ZnMotionValue(id: -id, src.read(nil))
        stepper = ZnFollowStepper(timing)
        super.init(id: id)
    }

    override func read(_ site: ZnSite?) -> Float { v.read(site) }

    /// A value moved somewhere: wake up if the source is away from where this rests.
    func check() {
        guard !awake else { return }
        if abs(src.read(nil) - v.value) > ZnFollowStepper.rest || abs(v.velocity) > ZnFollowStepper.rest {
            awake = true
            last = nil
        }
    }

    /// One frame. The first frame after waking only reads the time, as Android's.
    func frame(_ now: Int64) {
        guard awake else { return }
        guard let l = last else { last = now; return }
        let dt = min(max(now - l, 0), 50_000_000)  // a long pause (a busy main thread) doesn't jump
        last = now
        let target = src.read(nil)
        guard target.isFinite else { return }
        let r = stepper.step(value: v.value, velocity: v.velocity, target: target, dtNs: dt)
        v.value = r.value
        v.velocity = r.velocity
        if r.rests { awake = false }
    }
}

/// useElementMotion() (core motion.ts): the values an element gives through `motion={m}`. x, y, width, height (its
/// box in the window, points) are written when it is placed; the rest are read from the component (ZnLambdaSource).
final class ZnElementMotion {
    let id: Int
    let values: [String: ZnSource]
    /// m.follow(v): the value the element's scroll position follows, or nil.
    let follow = ZnObservedSource()
    /// Set by the element's view: writes its box now (before a measure() read, so it isn't a frame old).
    var refresh: (() -> Void)?

    init(id: Int, values: [String: ZnSource]) { self.id = id; self.values = values }
    func value(_ name: String) -> ZnMotionValue? { values[name] as? ZnMotionValue }
    func lambda(_ name: String) -> ZnLambdaSource? { values[name] as? ZnLambdaSource }
}

/// A source a view watches (an element's follow).
@Observable
final class ZnObservedSource {
    var source: ZnSource?
}

/// Goes up each time a source is made: a binding whose reference missed reads it, so it draws again once the source
/// arrives (a module call and the template batch that uses its id reach the main thread by different paths).
@Observable
final class ZnMotionGeneration {
    fileprivate(set) var n = 0
}

/// The frame clock the engine runs on (ZnFrameClock in the app, a fake in tests). [frame] gets each frame's time in
/// seconds and answers false when it needs no more frames.
protocol ZnMotionClock: AnyObject {
    func add(_ owner: AnyObject, _ frame: @escaping (Double) -> Bool)
    func remove(_ owner: AnyObject)
}

// MARK: - Commands

/// One step of a command (core motion.ts stepJson).
enum ZnStep {
    case to(Float, ZnTimingSpec, delayMs: Int)
    case decay(v: Float?, f: Float, lo: Float?, hi: Float?, delayMs: Int)
    case set(Float, delayMs: Int)

    var delayMs: Int {
        switch self {
        case .to(_, _, let d), .decay(_, _, _, _, let d), .set(_, let d): return d
        }
    }

    /// {"to":x,"t":timing,"delay":ms} | {"decay":{"v","f","lo","hi"},"delay"} | {"set":x,"delay"}.
    static func parse(_ o: [String: Any]) throws -> ZnStep {
        let delay = Int(znJsonNumber(o["delay"]) ?? 0)
        if o["set"] != nil { return .set(Float(znJsonNumber(o["set"]) ?? 0), delayMs: delay) }
        if let d = o["decay"] as? [String: Any] {
            let v = znJsonNumber(d["v"]).map { Float($0) }
            return .decay(v: v, f: Float(znJsonNumber(d["f"]) ?? 0.476), lo: znJsonNumber(d["lo"]).map { Float($0) },
                          hi: znJsonNumber(d["hi"]).map { Float($0) }, delayMs: delay)
        }
        guard let to = znJsonNumber(o["to"]) else { throw ZnInvalidArgs("a motion step needs \"to\", \"decay\" or \"set\"") }
        return .to(Float(to), try ZnTimingSpec.parse(o["t"] as? [String: Any]), delayMs: delay)
    }

    /// Where the step leaves the value, given where it started (for playing backwards).
    func end(after at: Float) -> Float {
        switch self {
        case .to(let x, _, _), .set(let x, _): return x
        case .decay: return at
        }
    }
}

/// A command running on a value: its steps, played [plays] times (-1 forever), every second play backwards with
/// [reverse]. Stepped by the engine's frame; a delay is time inside the run. Ends once with its completion.
final class ZnRun {
    private unowned let engine: ZnMotionEngine
    let v: ZnMotionValue
    private let steps: [ZnStep]
    private let plays: Int
    private let reverse: Bool
    private let start: Float
    private var play = 0
    private var order: [(ZnStep, Float?)] = []
    private var index = 0
    private var phase: Phase = .begin
    private var done: ((Bool) -> Void)?
    private(set) var ended = false

    private enum Phase {
        case begin
        case wait(Int64)
        case ready
        case curve(ZnMotionCurve, Int64?, from: Float, clampAt: Float?)
        case decay(ZnDecayCurve?, Int64?, v0: Float, f: Float, lo: Float?, hi: Float?)
    }

    static let frameNs: Int64 = 16_666_667

    init(engine: ZnMotionEngine, v: ZnMotionValue, steps: [ZnStep], repeat plays: Int, reverse: Bool,
         done: @escaping (Bool) -> Void) {
        self.engine = engine; self.v = v; self.steps = steps; self.reverse = reverse; self.done = done
        // A forever loop with animations off would spin: one play, then stop where it ends.
        self.plays = engine.animationsOff() && plays != 1 ? 1 : plays
        start = v.value
        order = playOrder(backwards: false)
    }

    /// One play's steps; backwards: in reverse, each going to where the step before it ended (the first: the start).
    private func playOrder(backwards: Bool) -> [(ZnStep, Float?)] {
        guard backwards else { return steps.map { ($0, nil) } }
        var ends: [Float] = []
        var at = start
        for s in steps {
            at = s.end(after: at)
            ends.append(at)
        }
        return steps.indices.reversed().map { i in (steps[i], i == 0 ? start : ends[i - 1]) }
    }

    /// Ends the run once: its completion says [finished].
    func finish(_ finished: Bool) {
        guard !ended else { return }
        ended = true
        if v.run === self { v.run = nil }
        let d = done
        done = nil
        d?(finished)
    }

    /// Moves it on. [now]: the frame's time (ns); [tick]: called from a frame (a curve moves only then). Instant work
    /// (a set, a step's start, a whole command with animations off) happens at once.
    func step(_ now: Int64, tick: Bool) {
        var canMove = tick
        while !ended {
            switch phase {
            case .begin:
                if index >= order.count {
                    play += 1
                    if steps.isEmpty || (plays >= 0 && play >= plays) { return finish(true) }
                    order = playOrder(backwards: reverse && play % 2 == 1)
                    index = 0
                    continue
                }
                // A delay is wall time (engine.now), as Android's delay(): a frame's time is the display's next
                // vsync, up to a frame ahead, so comparing against it would end delays a frame early.
                let d = order[index].0.delayMs
                phase = d > 0 && !engine.animationsOff() ? .wait(engine.now() + Int64(d) * 1_000_000) : .ready
            case .wait(let until):
                guard canMove, engine.now() >= until else { return }
                phase = .ready
            case .ready:
                let (s, over) = order[index]
                switch s {
                case .set(let x, _):
                    v.velocity = 0
                    v.value = over ?? x
                    next()
                case .decay(let v0, let f, let lo, let hi, _):
                    if let over {
                        // Backwards, a decay goes back with the default spring.
                        if !beginTo(over, .spring) { return finish(false) }
                    } else if engine.animationsOff() {
                        v.velocity = 0
                        next()
                    } else {
                        phase = .decay(nil, nil, v0: v0 ?? v.velocity, f: f, lo: lo, hi: hi)
                    }
                case .to(let x, let t, _):
                    if !beginTo(over ?? x, t) { return finish(false) }
                }
            case .curve(let c, let started, let from, let clampAt):
                guard canMove else { return }
                let s0 = started ?? now - Self.frameNs  // the first frame already moves
                let t = now - s0
                let x = c.value(t)
                v.velocity = c.velocity(t)
                var end: Bool
                if let clampAt, (x - clampAt) * (from - clampAt) <= 0 {
                    v.value = clampAt
                    end = true
                } else {
                    v.value = x
                    end = t >= c.durationNs
                }
                if end {
                    v.velocity = 0
                    next()
                    canMove = false  // the next curve starts on the next frame
                } else {
                    phase = .curve(c, s0, from: from, clampAt: clampAt)
                    return
                }
            case .decay(let c, let started, let v0, let f, let lo, let hi):
                guard canMove else { return }
                guard let c, let s0 = started else {
                    // The first frame only reads the time, as Android's decay.
                    phase = .decay(ZnDecayCurve(from: v.value, v0: v0, multiplier: f), now, v0: v0, f: f, lo: lo, hi: hi)
                    return
                }
                let t = now - s0
                var x = c.value(t)
                v.velocity = c.velocity(t)
                var stop = t >= c.durationNs
                if let lo, x < lo { x = lo; stop = true }
                if let hi, x > hi { x = hi; stop = true }
                v.value = x
                if stop {
                    v.velocity = 0
                    next()
                    canMove = false
                } else {
                    return
                }
            }
        }
    }

    /// Starts moving to [to]; false when [to] isn't a number. With animations off it is there at once.
    private func beginTo(_ to: Float, _ t: ZnTimingSpec) -> Bool {
        guard to.isFinite else { return false }
        if engine.animationsOff() {
            v.value = to
            v.velocity = 0
            next()
            return true
        }
        phase = .curve(t.curve(from: v.value, to: to, velocity: v.velocity), nil, from: v.value,
                       clampAt: t.clamp ? to : nil)
        return true
    }

    private func next() {
        index += 1
        phase = .begin
    }
}

// MARK: - The engine

/// Every motion source JS made, by id (JS gives each an id; native keeps it until JS disposes it). Ids 1–15 are the
/// window values (§2.2).
final class ZnMotionEngine {
    nonisolated(unsafe) static let shared = ZnMotionEngine()

    static let envWidth = 1, envHeight = 2, envInsetTop = 3, envInsetBottom = 4, envInsetStart = 5, envInsetEnd = 6,
        envKeyboard = 7, envKeyboardTarget = 8, envLast = 15
    static let refPrefix = "\u{0}m"
    static let textPrefix = "\u{0}f"

    // What the app plugs in (ZnMotionModule.swift; tests set their own).
    /// The frame clock; nil: nothing moves by time (a command waits).
    var clock: ZnMotionClock?
    /// The time now (ns), on the clock's time base.
    var now: () -> Int64 = { Int64(DispatchTime.now().uptimeNanoseconds) }
    /// True when animations are off (Android: "Remove animations"; iOS: Reduce Motion): values jump to where they end.
    var animationsOff: () -> Bool = { false }
    /// Sends a module event whose payload is made on the JS thread when it gets there (nil: nothing is sent).
    var emitLatest: (_ event: String, _ build: @escaping () -> Any?) -> Void = { _, _ in }
    /// Sends a module event as it is, in order with the others.
    var emitNow: (_ event: String, _ payload: Any) -> Void = { _, _ in }
    /// Run when an id is disposed (gestures, tilt drop theirs) and on reset.
    var disposeHooks: [(Int) -> Void] = []
    var resetHooks: [() -> Void] = []

    private(set) var sources: [Int: ZnSource] = [:]
    private var env: [Int: ZnEnvValue] = [:]
    /// Slot text → its source, so a read doesn't parse the id each frame.
    private var refs: [String: ZnSource] = [:]
    private var texts: [String: TextRef] = [:]
    private var elements: [Int: ZnElementMotion] = [:]
    private var follows: [Int: ZnFollowSource] = [:]
    private var runs: [ObjectIdentifier: ZnRun] = [:]
    let generation = ZnMotionGeneration()

    /// Watched sources (JS reads them) → the last value sent.
    private var watched: [Int: (src: ZnSource, last: Float)] = [:]
    // Values waiting for the JS thread, and whether a delivery is queued: read there, so under the lock.
    private let lock = NSLock()
    private var pending: [Int: Float] = [:]
    private var pendingQueued = false
    private var frameQueued = false

    private var framesOn = false
    private var lastFrame: Int64 = 0
    private var dirty = false
    private var ticking = false
    private var dirtySubs: [ObjectIdentifier: (owner: Weak, fn: () -> Void)] = [:]
    private var frameSubs: [ObjectIdentifier: (owner: Weak, fn: (Int64) -> Bool)] = [:]

    private final class Weak {
        weak var o: AnyObject?
        init(_ o: AnyObject) { self.o = o }
    }

    private final class TextRef {
        let id: Int
        let format: ZnNumberFormat
        var src: ZnSource?
        init(_ id: Int, _ f: ZnNumberFormat) { self.id = id; format = f }
    }

    init() {
        for i in 1...Self.envLast {
            let e = ZnEnvValue(id: i)
            env[i] = e
            sources[i] = e
        }
    }

    // MARK: Sources

    /// Makes [s] the source under its id (a new one under an old id replaces it). Throws for the window ids.
    func put(_ id: Int, _ s: ZnSource) throws {
        if id <= Self.envLast { throw ZnInvalidArgs("motion id \(id) is reserved") }
        if let old = sources.removeValue(forKey: id) {
            old.dispose()
            follows[id] = nil
        }
        sources[id] = s
        if let f = s as? ZnFollowSource {
            follows[id] = f
            f.check()
            if f.awake { ensureTicking() }
        }
        generation.n += 1
    }

    func find(_ id: Int) -> ZnSource? { sources[id] }

    func source(_ id: Int) throws -> ZnSource {
        guard let s = sources[id] else { throw ZnInvalidArgs("no motion value \(id) (made after it was used, or disposed)") }
        return s
    }

    func value(_ id: Int) throws -> ZnMotionValue {
        guard let v = sources[id] as? ZnMotionValue else { throw ZnInvalidArgs("motion \(id) is not a value you can move") }
        return v
    }

    /// A value under [id] (JS's own, a gesture's, a plugin's).
    @discardableResult
    func putValue(_ id: Int, _ initial: Float) throws -> ZnMotionValue {
        let v = ZnMotionValue(id: id, initial)
        try put(id, v)
        return v
    }

    func env(_ id: Int) -> ZnEnvValue? { env[id] }

    func element(_ id: Int) -> ZnElementMotion? { elements[id] }

    /// Makes element motion [id] with these value ids (x, y, width, height: values; the rest read from the component).
    @discardableResult
    func putElement(_ id: Int, _ names: [String: Int]) throws -> ZnElementMotion {
        var values: [String: ZnSource] = [:]
        for (name, vid) in names {
            let s: ZnSource = ["x", "y", "width", "height"].contains(name) ? ZnMotionValue(id: vid, 0) : ZnLambdaSource(id: vid)
            try put(vid, s)
            values[name] = s
        }
        let e = ZnElementMotion(id: id, values: values)
        elements[id] = e
        return e
    }

    /// JS dropped [id] (its owner went away). Its last value stays readable through [ref] (see there).
    func dispose(_ id: Int) {
        if id <= Self.envLast { return }
        elements[id] = nil
        watched[id] = nil
        follows[id] = nil
        sources.removeValue(forKey: id)?.dispose()
        for h in disposeHooks { h(id) }
    }

    /// The JS that made these is gone (a reload, an OTA applied in place). Its watches go too, the window values'
    /// included: the new JS starts its window values at 0 and watches them again, so it must get their value now.
    func reset() {
        for id in Array(sources.keys) where id > Self.envLast { dispose(id) }
        watched = [:]
        refs = [:]
        texts = [:]
        elements = [:]
        frames(false)
        lock.withLock { pending = [:] }
        for h in resetHooks { h() }
    }

    // MARK: Slots that follow a source

    /// A slot holds a reference to a motion source.
    static func isRef(_ v: Any?) -> Bool { (v as? String)?.hasPrefix(refPrefix) == true }

    /// The source a slot value refers to, or nil (not a reference, or not made yet). JS drops a screen's values when
    /// it pops, but the screen is still drawn for its exit: a disposed source stays readable at its last value, so its
    /// bindings don't jump to 0. A new source under the same id wins. A miss reads [generation], so the reader draws
    /// again when sources arrive.
    func ref(_ v: Any?) -> ZnSource? {
        guard let s = v as? String, s.hasPrefix(Self.refPrefix) else { return nil }
        if let cached = refs[s] {
            let live = sources[cached.id]
            if live === cached || live == nil { return cached }
        }
        guard let id = Int(s.dropFirst(Self.refPrefix.count)), let src = sources[id] else {
            _ = generation.n
            return nil
        }
        refs[s] = src
        return src
    }

    /// A Text slot's string: a motion value shown as text (`v.format(...)`), formatted from its value now. Nil when
    /// [v] isn't one. A disposed value keeps showing its last number.
    func text(_ v: String) -> String? {
        guard v.hasPrefix(Self.textPrefix) else { return nil }
        let t: TextRef
        if let have = texts[v] {
            t = have
        } else {
            let body = v.dropFirst(Self.textPrefix.count)
            let bar = body.firstIndex(of: "|")
            guard let id = Int(bar.map { body[..<$0] } ?? body) else { return "" }
            t = TextRef(id, ZnNumberFormat.parse(bar.map { String(body[body.index(after: $0)...]) }))
            texts[v] = t
        }
        let live = sources[t.id]
        if let live { t.src = live }
        guard let s = live ?? t.src else {
            _ = generation.n
            return ""
        }
        return t.format.format(s.read(nil))
    }

    // MARK: Commands

    /// Runs [steps] on [v] (Android's animate). A value a finger holds drops the command (finished: false) unless
    /// [interrupt]. A new command ends the one before it first (finished: false), so chained `.then()`s never run out
    /// of order. [done] runs once: finished true at the end, false when stopped.
    func animate(_ v: ZnMotionValue, steps: [ZnStep], repeat plays: Int = 1, reverse: Bool = false,
                 interrupt: Bool = false, done: @escaping (Bool) -> Void) {
        if v.heldBy != nil {
            guard interrupt else { return done(false) }
            v.heldBy?.cancel()
            v.heldBy = nil
        }
        v.onCommand?()
        v.interrupt()
        v.seq += 1
        let r = ZnRun(engine: self, v: v, steps: steps, repeat: plays, reverse: reverse, done: done)
        v.run = r
        runs[ObjectIdentifier(r)] = r
        r.step(now(), tick: false)
        if r.ended { runs[ObjectIdentifier(r)] = nil } else { ensureTicking() }
    }

    /// Moves [v] to [to] with [timing] (a gesture's release, a plugin).
    func animate(_ v: ZnMotionValue, to: Float, timing: ZnTimingSpec = .spring, delayMs: Int = 0,
                 done: @escaping (Bool) -> Void = { _ in }) {
        animate(v, steps: [.to(to, timing, delayMs: delayMs)], done: done)
    }

    /// Slows [v] down from [v0] (or its own velocity) with [friction] (znFriction); stops at [lo] / [hi].
    func decay(_ v: ZnMotionValue, v0: Float? = nil, friction: Float = 0.476, lo: Float? = nil, hi: Float? = nil,
               done: @escaping (Bool) -> Void = { _ in }) {
        animate(v, steps: [.decay(v: v0, f: friction, lo: lo, hi: hi, delayMs: 0)], done: done)
    }

    /// `v.set(x)`: jumps there and stops any animation. A held value ignores it unless [interrupt].
    func set(_ v: ZnMotionValue, _ x: Float, interrupt: Bool) {
        if v.heldBy != nil && !interrupt { return }
        v.heldBy?.cancel()
        v.heldBy = nil
        v.onCommand?()
        v.interrupt()
        v.velocity = 0
        v.value = x
    }

    // MARK: Values to JS

    /// JS reads [id]: send it each time it changes (once per frame at most, newest only), starting with its value now
    /// (also when it was already watched: a new reader always gets the value now).
    func watch(_ id: Int, _ on: Bool) {
        guard on else { watched[id] = nil; return }
        guard let s = sources[id] else { return }
        watched[id] = (s, .nan)
        markDirty()
    }

    /// {id: value} now (measure()). An element whose values are asked for writes its box first.
    func read(_ ids: [Int]) -> [String: Double] {
        let asked = Set(ids)
        for e in elements.values where e.refresh != nil && e.values.values.contains(where: { asked.contains($0.id) }) {
            e.refresh?()
        }
        var out: [String: Double] = [:]
        for id in ids { if let s = sources[id] { out[String(id)] = Double(s.read(nil)) } }
        return out
    }

    /// A gesture event (each one once, in order), after any values still waiting, so JS reads them first.
    func sendEvent(_ payload: [String: Any]) {
        collectWatched()
        emitNow("gesture", payload)
    }

    /// A "frame" event each frame while JS has useFrame callbacks (coalesced: never queued up).
    func frames(_ on: Bool) {
        framesOn = on
        lastFrame = 0
        if on { ensureTicking() }
    }

    // MARK: Frames and change

    /// A value changed: on the next frame, watched values go to JS, sleeping follows look, onDirty subscribers run.
    func markDirty() {
        guard !dirty else { return }
        dirty = true
        ensureTicking()
    }

    /// [fn] runs on the frame after any motion value changed, while [owner] lives.
    func onDirty(_ owner: AnyObject, _ fn: @escaping () -> Void) {
        dirtySubs[ObjectIdentifier(owner)] = (Weak(owner), fn)
    }

    func removeOnDirty(_ owner: AnyObject) { dirtySubs[ObjectIdentifier(owner)] = nil }

    /// [fn] gets each frame's time (ns) until it answers false or [owner] goes (plugins' physics).
    func onFrame(_ owner: AnyObject, _ fn: @escaping (Int64) -> Bool) {
        frameSubs[ObjectIdentifier(owner)] = (Weak(owner), fn)
        ensureTicking()
    }

    func removeOnFrame(_ owner: AnyObject) { frameSubs[ObjectIdentifier(owner)] = nil }

    private func ensureTicking() {
        guard !ticking, let clock else { return }
        ticking = true
        clock.add(self) { [unowned self] t in self.tick(Int64(t * 1e9)) }
    }

    /// One frame: commands, follows, plugins' frames, then what changed (to JS, subscribers), then the frame event.
    /// False when nothing needs another frame.
    func tick(_ now: Int64) -> Bool {
        for r in Array(runs.values) {
            r.step(now, tick: true)
            if r.ended { runs[ObjectIdentifier(r)] = nil }
        }
        for f in follows.values { f.frame(now) }
        for (k, s) in frameSubs {
            if s.owner.o == nil || !s.fn(now) { frameSubs[k] = nil }
        }
        if dirty {
            dirty = false
            for f in follows.values { f.check() }
            collectWatched()
            for (k, s) in dirtySubs {
                if s.owner.o == nil { dirtySubs[k] = nil } else { s.fn() }
            }
        }
        if framesOn { sendFrame(now) }
        let more = !runs.isEmpty || follows.values.contains { $0.awake } || !frameSubs.isEmpty || framesOn || dirty
        if !more { ticking = false }
        return more
    }

    /// Watched values that changed go into [pending]; one delivery is queued at a time, and it takes every value that
    /// changed by the time the JS thread gets to it.
    private func collectWatched() {
        var changed: [Int: Float] = [:]
        for (id, w) in watched {
            let v = w.src.read(nil)
            if v != w.last {
                changed[id] = v
                watched[id] = (w.src, v)
            }
        }
        if changed.isEmpty { return }
        let first: Bool = lock.withLock {
            pending.merge(changed) { $1 }
            defer { pendingQueued = true }
            return !pendingQueued
        }
        guard first else { return }
        emitLatest("values") { [self] in
            let out: [String: Double] = lock.withLock {
                defer { pending = [:]; pendingQueued = false }
                var o: [String: Double] = [:]
                for (k, x) in pending { o[String(k)] = Double(x) }
                return o
            }
            // (a reload in between: reset() cleared pending, so this sends nothing)
            return out.isEmpty ? nil : out
        }
    }

    private func sendFrame(_ now: Int64) {
        let dt = lastFrame == 0 ? 0 : now - lastFrame
        lastFrame = now
        let first: Bool = lock.withLock {
            defer { frameQueued = true }
            return !frameQueued
        }
        guard first else { return }
        let t = Double(now) / 1_000_000, d = Double(dt) / 1_000_000
        emitLatest("frame") { [self] in
            lock.withLock { frameQueued = false }
            return ["t": t, "dt": d]
        }
    }
}
