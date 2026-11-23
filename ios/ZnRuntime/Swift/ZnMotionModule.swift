// The built-in `Motion` module (Android: ZnMotion.kt's module part; JS: core motion.ts). JS gives every object an id;
// the engine (ZnMotionEngine.swift) keeps them until JS disposes them. Every function runs on the main thread, and
// most need no answer (core's `send`, call id 0); `animate` and `read` answer.
//
// Registered in every build (2026-11-24, motion-ota-gate): "Motion" v1 means the engine, as on Android, and the host
// API is 10 (core/include/zn/engine.h). iOS hosts at 9 or less had a stub of the same name and number that answered
// every call "unavailable"; the update server gives them no bundle that uses Motion (docs/ota.md §3.2, "Motion on
// older iOS apps"). tools/test/motion-coverage.test.ts fails if Android's Motion module has a function this one lacks.
//
// Also here: the app's side of the engine (its frame clock, Reduce Motion, events to JS) and the read helpers a
// renderer uses for a slot that may hold a motion reference.
import QuartzCore
import SwiftUI
#if SWIFT_PACKAGE
import ZnHost
#endif

/// The Motion module for this build: the engine. Only a Debug build started with ZN_MOTION_ENGINE=0 gets
/// ZnMotionOff, to compare a screen's cost without the engine; a Release build can't turn it off.
@MainActor func znMotionModuleForThisBuild() -> ZnModule {
    #if DEBUG
    if ProcessInfo.processInfo.environment["ZN_MOTION_ENGINE"] == "0" { return ZnMotionOff() }
    #endif
    return ZnMotionModule.shared
}

#if DEBUG
/// The engine turned off (ZN_MOTION_ENGINE=0, Debug only): the stub of older iOS hosts, so nothing moves and every
/// call answers "unavailable". Core treats an unavailable animate, snapTo or zoomTo as finished at once and says so
/// once in the log, so a screen that waits for one (the TSX image viewer's close) still goes on.
final class ZnMotionOff: ZnModuleBase, @unchecked Sendable {
    init() { super.init("Motion", version: 1) }
}
#endif

/// ZnFrameClock as the engine's clock.
private final class ZnMotionFrameClock: ZnMotionClock {
    func add(_ owner: AnyObject, _ frame: @escaping (Double) -> Bool) {
        MainActor.assumeIsolated { ZnFrameClock.shared.add(owner, frame) }
    }
    func remove(_ owner: AnyObject) {
        MainActor.assumeIsolated { ZnFrameClock.shared.remove(owner) }
    }
}

final class ZnMotionModule: ZnModuleBase, @unchecked Sendable {
    /// One for the app: it wires the engine once (registerBuiltIns may run again).
    @MainActor static let shared = ZnMotionModule()
    private let engine = ZnMotionEngine.shared

    @MainActor private init() {
        super.init("Motion", version: 1)
        let e = engine
        e.clock = ZnMotionFrameClock()
        e.now = { Int64(CACurrentMediaTime() * 1e9) }  // CADisplayLink's time base
        e.animationsOff = znAnimationsOff
        e.emitLatest = { event, build in ZnModules.emitLatest("Motion", event, build) }
        e.emitNow = { event, payload in ZnModules.emit("Motion", event, payload, latestOnly: false) }
        e.disposeHooks.append { ZnGestures.dispose($0) }
        e.resetHooks.append { ZnGestures.reset() }
        e.disposeHooks.append { id in MainActor.assumeIsolated { ZnTilt.shared.remove(id) } }
        e.resetHooks.append { MainActor.assumeIsolated { ZnTilt.shared.reset() } }

        function("value", onMain: true) { c in
            let v = Float(try c.double("v"))
            try e.putValue(try c.int("id"), v.isFinite ? v : 0)
            c.resolve()
        }
        function("map", onMain: true) { c in
            let ins = znJsonFloats(c.args["in"]), outs = znJsonFloats(c.args["out"])
            if ins.count != outs.count || ins.count < 2 { throw ZnInvalidArgs("map needs 2 or more inputs and as many outputs") }
            try Self.checkRising(ins)
            let id = try c.int("id")
            try e.put(id, ZnMapSource(id: id, try e.source(try c.int("src")), ins, outs, try c.intOrNil("ex") ?? 0))
            c.resolve()
        }
        function("mapColor", onMain: true) { c in
            let ins = znJsonFloats(c.args["in"])
            let outs: [Any] = (c.args["out"] as? [Any]) ?? []
            let colors = outs.map { znArgb($0) }
            if ins.count != colors.count || ins.isEmpty { throw ZnInvalidArgs("mapColor needs as many colours as inputs") }
            try Self.checkRising(ins)
            let id = try c.int("id")
            try e.put(id, ZnColorMapSource(id: id, try e.source(try c.int("src")), ins, colors))
            c.resolve()
        }
        function("formula", onMain: true) { c in
            let id = try c.int("id")
            let srcs = (c.args["srcs"] as? [Any]) ?? []
            let inputs: [ZnFormulaInput] = try srcs.enumerated().map { i, s in
                if let n = znJsonNumber(s) { return .const(Float(n)) }
                if let o = s as? [String: Any], let m = znJsonNumber(o["m"]) { return .src(try e.source(Int(m))) }
                throw ZnInvalidArgs("formula input \(i) is not a number or a motion value")
            }
            guard let code = c.args["code"] as? [Any] else { throw ZnInvalidArgs("\"code\" is missing") }
            try e.put(id, ZnFormulaSource(id: id, try ZnFormula.compile(code, inputs, c.args["tables"] as? [Any])))
            c.resolve()
        }
        function("follow", onMain: true) { c in
            let id = try c.int("id")
            let t = try ZnTimingSpec.parse(c.args["t"] as? [String: Any])
            try e.put(id, ZnFollowSource(id: id, try e.source(try c.int("src")), t))
            c.resolve()
        }
        function("dispose", onMain: true) { c in
            for id in (c.args["ids"] as? [Any]) ?? [] { if let n = znJsonNumber(id) { e.dispose(Int(n)) } }
            c.resolve()
        }
        function("set", onMain: true) { c in
            e.set(try e.value(try c.int("id")), Float(try c.double("v")), interrupt: try c.boolOrNil("interrupt") ?? false)
            c.resolve()
        }
        function("stop", onMain: true) { c in
            try e.value(try c.int("id")).interrupt()
            c.resolve()
        }
        // {"id", "steps": [...], "repeat": n (-1 forever), "reverse", "interrupt"}: answers {finished}.
        function("animate", onMain: true) { c in
            let v = try e.value(try c.int("id"))
            let steps = try ((c.args["steps"] as? [Any]) ?? []).map { s in
                guard let o = s as? [String: Any] else { throw ZnInvalidArgs("a motion step is not an object") }
                return try ZnStep.parse(o)
            }
            e.animate(v, steps: steps, repeat: try c.intOrNil("repeat") ?? 1, reverse: try c.boolOrNil("reverse") ?? false,
                      interrupt: try c.boolOrNil("interrupt") ?? false) { c.resolve(["finished": $0]) }
        }
        function("watch", onMain: true) { c in
            e.watch(try c.int("id"), try c.boolOrNil("on") ?? true)
            c.resolve()
        }
        // {"id", "values": {name: id}}: an element's values (useElementMotion).
        function("element", onMain: true) { c in
            var names: [String: Int] = [:]
            for (k, v) in (c.args["values"] as? [String: Any]) ?? [:] { if let n = znJsonNumber(v) { names[k] = Int(n) } }
            try e.putElement(try c.int("id"), names)
            c.resolve()
        }
        // {"id": element, "src": motion id | absent}: m.follow(v); no src stops.
        function("elementFollow", onMain: true) { c in
            guard let el = e.element(try c.int("id")) else { return c.resolve() }
            el.follow.source = try c.intOrNil("src").map { try e.source($0) }
            c.resolve()
        }
        // {"id", "x", "y", "on"}: useTilt() (ZnTilt.swift): x / y follow how the phone leans while on.
        function("tilt", onMain: true) { c in
            let id = try c.int("id")
            if try c.boolOrNil("on") ?? true {
                let x = try e.putValue(try c.int("x"), 0), y = try e.putValue(try c.int("y"), 0)
                MainActor.assumeIsolated { ZnTilt.shared.add(id, x, y) }
            } else {
                MainActor.assumeIsolated { ZnTilt.shared.remove(id) }
            }
            c.resolve()
        }
        // {"ids": [...]}: the values now (measure()).
        function("read", onMain: true) { c in
            let ids = ((c.args["ids"] as? [Any]) ?? []).compactMap { znJsonNumber($0).map { Int($0) } }
            c.resolve(e.read(ids))
        }
        // {"on": bool}: a "frame" event each frame while JS has useFrame callbacks.
        function("frames", onMain: true) { c in
            e.frames(try c.boolOrNil("on") ?? false)
            c.resolve()
        }
        ZnGestures.install(self)
    }

    /// Lets the gestures add their functions to this module (one "Motion" module for the whole feature).
    func addFunction(_ method: String, _ body: @escaping (ZnCall) throws -> Void) {
        function(method, onMain: true, body)
    }

    private static func checkRising(_ ins: [Float]) throws {
        for i in 1..<max(1, ins.count) where ins[i] < ins[i - 1] {
            throw ZnInvalidArgs("map inputs must go up: \(ins.map { "\($0)" }.joined(separator: ", "))")
        }
    }
}

// MARK: - Reading a slot that may follow a motion value

extension ZnInstance {
    /// A layer number now: a slot holding a motion reference reads its source (so SwiftUI redraws the reader when it
    /// moves), else the slot's finite number, else [fixed] (ZnMotionBindRules.swift).
    func layerNumber(_ slot: Int, _ fixed: CGFloat, site: ZnSite? = nil) -> CGFloat {
        guard slot >= 0 else { return fixed }
        return znBoundNumber(self.slot(slot).value, fixed, site: site)
    }

    /// A colour slot that follows a motion colour (mapColor, a colour formula), now; nil when it doesn't.
    func motionColor(_ slot: Int, site: ZnSite? = nil) -> Color? {
        guard slot >= 0, let s = self.slot(slot).value.string, s.hasPrefix(ZnMotionEngine.refPrefix),
              let src = ZnMotionEngine.shared.ref(s), src.isColor else { return nil }
        let c = src.readColor(site)
        return Color(.sRGB, red: Double(c >> 16 & 0xFF) / 255, green: Double(c >> 8 & 0xFF) / 255,
                     blue: Double(c & 0xFF) / 255, opacity: Double(c >> 24 & 0xFF) / 255)
    }
}
