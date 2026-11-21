// iOS's motion engine on the Mac (ZnMotionMath.swift, ZnFormula.swift, ZnMotionEngine.swift, ZnDepth.swift): tools/ios-unit-test.ts
// builds this with them (sources.txt). The maths and formula cases are android/runtime's ZnMotionTest.kt, with the
// same numbers; the command, watch and follow cases drive the engine with a fake frame clock, as Android's
// coroutines would run them (ZnMotion.kt: animate, runSteps, watch, sendEvent, frames, ZnFollowSource).
import Foundation
import QuartzCore

/// ZnModules.swift's error (it needs the host, so it isn't built here).
struct ZnInvalidArgs: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

func near(_ name: String, _ got: Float, _ want: Float, _ tol: Float = 0, line: Int = #line) {
    count += 1
    if !(abs(got - want) <= tol) {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want) ± \(tol)")
    }
}

func truth(_ name: String, _ ok: Bool, line: Int = #line) { check(name, ok, true, line: line) }

func json(_ s: String) -> Any { try! JSONSerialization.jsonObject(with: Data(s.utf8), options: [.fragmentsAllowed]) }

func consts(_ v: Float...) -> [ZnFormulaInput] { v.map { .const($0) } }

func formula(_ code: String, _ inputs: [ZnFormulaInput] = [], _ tables: String? = nil) throws -> ZnFormula {
    try ZnFormula.compile(json(code) as! [Any], inputs, tables.map { json($0) as! [Any] })
}

func f(_ code: String, _ inputs: [ZnFormulaInput] = [], _ tables: String? = nil) -> ZnFormula { try! formula(code, inputs, tables) }

// MARK: - Formulas (ZnMotionTest.formulasRunLikeJs ... theVerifierRefusesBadFormulas)

// Math.abs(x) / 120 + 2 * k with x = -240, k = 3
near("abs / + *", f(#"["$0","abs",120,"/",2,"$1","*","+"]"#, consts(-240, 3)).eval(nil), 8)
// (a > 10 && !b) ? a : -a
let cond = #"["$0",10,">","$1","!","&&","$0","$0","neg","?"]"#
near("cond 20,0", f(cond, consts(20, 0)).eval(nil), 20)
near("cond 20,1", f(cond, consts(20, 1)).eval(nil), -20)
near("cond 5,0", f(cond, consts(5, 0)).eval(nil), -5)
near("atan2 JS order", f(#"["$0","$1","atan2"]"#, consts(1, 0)).eval(nil), Float.pi / 2, 1e-6)
near("clamp", f(#"[9,0,5,"clamp"]"#).eval(nil), 5)
near("hypot", f(#"[3,4,"hypot"]"#).eval(nil), 5)
near("min chain", f(#"[3,1,"min",2,"min"]"#).eval(nil), 1)
near("round -2.5", f(#"[-2.5,"round"]"#).eval(nil), -2)
near("round 2.5", f(#"[2.5,"round"]"#).eval(nil), 3)
near("5 / 0", f(#"[5,0,"/"]"#).eval(nil), 0)
near("5 % 0", f(#"[5,0,"%"]"#).eval(nil), 0)
near("-7 % 3 like JS", f(#"[-7,3,"%"]"#).eval(nil), -1)
near("|| gives a value", f(#"[0,7,"||"]"#).eval(nil), 7)
// sqrt(-1) is NaN: the source gives its last good value (0 at first), never NaN.
near("NaN keeps the last good value", ZnFormulaSource(id: 900, f(#"[-1,"sqrt"]"#)).read(nil), 0)

let site = ZnSite()
site.update(100, 50, 400, 800)
let room = f(#"["pw","sw","-"]"#)
truth("pw - sw uses the site", room.usesSite)
near("pw - sw", room.eval(site), 300)
near("pw - sw without a site", room.eval(nil), 0)

near("table", f(#"["$0","L0"]"#, consts(50), "[[[0,100],[0,1],0,0]]").eval(nil), 0.5)
let white: UInt32 = 0xFFFF_FFFF, black: UInt32 = 0xFF00_0000
let colour = f(#"["$0","C0"]"#, consts(0.5), "[[[0,1],[\(white),\(black)],0,1]]")
truth("colour formula", colour.isColor)
check("colour mix", colour.evalColor(nil), 0xFF7F_7F7F)
check("a colour formula's number", colour.eval(nil), 0)
// Android sends colours as signed Int32 (opaque black is -16777216): the same bits.
check("signed colour", f(#"["$0","C0"]"#, consts(1), "[[[0,1],[0,-16777216],0,1]]").evalColor(nil), 0xFF00_0000)

func refuses(_ code: String, _ why: String, _ inputs: [ZnFormulaInput] = [], tables: String? = nil, line: Int = #line) {
    count += 1
    do {
        _ = try formula(code, inputs, tables)
        failures += 1
        print("FAIL refuses \(code) (line \(line)): it compiled")
    } catch let e as ZnInvalidArgs {
        if !e.description.contains(why) {
            failures += 1
            print("FAIL refuses \(code) (line \(line)): \"\(e.description)\" should mention \"\(why)\"")
        }
    } catch {
        failures += 1
        print("FAIL refuses \(code) (line \(line)): \(error)")
    }
}
refuses(#"[1,"+"]"#, "needs 2 values")
refuses("[1,2]", "leaves 2 values")
refuses(#"["$3"]"#, "input 3 doesn't exist", consts(1))
refuses(#"[1,"eval"]"#, "can't use \"eval\"")
refuses("[" + Array(repeating: "1", count: 65).joined(separator: ",") + "]", "at most 64")
refuses("[" + Array(repeating: "1", count: 17).joined(separator: ",") + "]", "more than 16")
refuses(#"[1,"C0",1,"+"]"#, "last step", tables: "[[[0,1],[0,1],0,1]]")
refuses(#"[1,"L0"]"#, "inputs must go up", tables: "[[[1,0],[0,1],0,0]]")
refuses("[]", "empty")

// MARK: - Maths (interpolateExtrapolates, decelerationMatchesReanimated, number formats, drivers)

near("clamp end", znInterpolate(150, [0, 100], [0, 1], 0), 1)
near("extend", znInterpolate(150, [0, 100], [0, 1], 1), 1.5, 1e-6)
near("identity", znInterpolate(150, [0, 100], [0, 1], 2), 150)
near("middle segment", znInterpolate(75, [0, 50, 100], [0, 10, 0], 0), 5)
near("extend below", znInterpolate(-50, [0, 100], [0, 1], 1), -0.5, 1e-6)

// withDecay's 0.998 per ms: after 1 s the speed is 0.998^1000 of the start.
check("friction", abs(exp(-4.2 * Double(znFriction(0.998))) - pow(0.998, 1000)) < 1e-6, true)
near("friction out of range is 0.998's", znFriction(2), znFriction(0.998))

let rupees = ZnNumberFormat.parse(#"{"p":"₹"}"#)
check("₹0", rupees.format(0), "₹0")
check("₹999", rupees.format(999), "₹999")
check("₹1,000", rupees.format(1000), "₹1,000")
check("₹12,34,567", rupees.format(1_234_567), "₹12,34,567")
check("half away from zero", rupees.format(2.5), "₹3")
check("minus before prefix", rupees.format(-2.5), "-₹3")
check("no -₹0", rupees.format(-0.4), "₹0")
check("NaN", rupees.format(.nan), "₹0")
check("standard 2dp", ZnNumberFormat.parse(#"{"d":2,"g":"standard"}"#).format(1_234_567.5), "1,234,567.50")
check("none 1dp suffix", ZnNumberFormat.parse(#"{"d":1,"g":"none","s":" km"}"#).format(1234.46), "1234.5 km")
check("0.05", ZnNumberFormat.parse(#"{"d":2}"#).format(0.05), "0.05")
check("bad json", ZnNumberFormat.parse("not json").format(7.2), "7")

struct Line: ZnMotionDriver {
    let from: Float, to: Float, ms: Int64
    var durationNanos: Int64 { ms * 1_000_000 }
    func value(_ t: Int64) -> Float { from + (to - from) * Float(t) / Float(durationNanos) }
    func velocity(_ t: Int64) -> Float { (to - from) * 1e9 / Float(durationNanos) }
}
ZnMotionDrivers.register("test.line") { from, to, _, p in Line(from: from, to: to, ms: Int64(znJsonNumber(p["ms"]) ?? 100)) }
let lineSpec = try! ZnTimingSpec.parse(json(#"{"d":"test.line","p":{"ms":200}}"#) as? [String: Any])
let line = lineSpec.curve(from: 0, to: 10, velocity: 0)
near("driver half way", line.value(100_000_000), 5, 1e-4)
near("driver at the end", line.value(300_000_000), 10)
count += 1
if (try? ZnTimingSpec.parse(["d": "no.such"])) != nil { failures += 1; print("FAIL an unknown driver must throw") }

// Timing specs: the same defaults as ZnTimingSpec.parse.
let dflt = try! ZnTimingSpec.parse(nil)
check("default spring", [dflt.ratio, dflt.stiffness], [0.75, 400])
let tween = try! ZnTimingSpec.parse(["t": 300, "e": 3])
check("tween", [tween.ms, tween.easing], [300, 3])
check("tween clamp", (try! ZnTimingSpec.parse(["t": 99_000])).ms, 60_000)
let bad = try! ZnTimingSpec.parse(["r": -1, "k": Double.nan, "c": true])
check("bad spring numbers", [bad.ratio, bad.stiffness], [0.75, 400])
truth("overshoot clamp", bad.clamp)

// Tween: linear 300 ms from 0 to 30; the speed by a 1 ms step back; at the end, the target.
let lin = ZnTimingSpec(ms: 300, easing: 3, bezier: nil, ratio: 1, stiffness: 0, clamp: false).curve(from: 0, to: 30, velocity: 50)
near("tween at 150 ms", lin.value(150_000_000), 15, 1e-4)
near("tween speed", lin.velocity(150_000_000), 100, 0.05)
near("tween starts at rest", lin.velocity(0), 0)
near("tween end", lin.value(400_000_000), 30)

// MARK: - Springs (Compose's SpringSimulation and duration estimate)

func settleCheck(_ name: String, ratio: Float, k: Float, from: Float, to: Float, v0: Float, line: Int = #line) {
    let s = ZnSpringCurve(from: from, to: to, v0: v0, ratio: ratio, stiffness: k)
    let ms = s.durationNs / 1_000_000
    // Compose's estimate: after it, the spring stays within the threshold (0.01) of the target (give or take the
    // whole-ms rounding of the estimate)...
    var worst: Float = 0
    var t = ms
    while t < ms + 3000 { worst = max(worst, abs(s.sample(t * 1_000_000).0 - to)); t += 1 }
    truth("\(name): settled after \(ms) ms (worst \(worst))", worst <= 0.0105, line: line)
    // ...and not long before: a little earlier it is still outside it (no wildly long estimate).
    var outside = false
    t = max(0, ms - 40)
    while t < ms { if abs(s.sample(t * 1_000_000).0 - to) > 0.005 { outside = true }; t += 1 }
    truth("\(name): the estimate isn't long (\(ms) ms)", outside || ms == 0, line: line)
    // The velocity is the value's slope.
    let mid: Int64 = 50
    let slope = (s.sample((mid + 1) * 1_000_000).0 - s.sample((mid - 1) * 1_000_000).0) / 0.002
    near("\(name): velocity at 50 ms", s.sample(mid * 1_000_000).1, slope, max(1, abs(slope) * 0.02), line: line)
    near("\(name): starts where it is", s.sample(0).0, from, 1e-4, line: line)
    near("\(name): starts at its speed", s.sample(0).1, v0, 1e-3, line: line)
    check("\(name): the end is the target", s.value(s.durationNs), to, line: line)
}
settleCheck("default spring", ratio: 0.75, k: 400, from: 0, to: 300, v0: 0)
settleCheck("Reanimated defaults", ratio: 0.5, k: 100, from: 0, to: 1, v0: 0)
settleCheck("bouncy with a fling", ratio: 0.45, k: 400, from: 100, to: 0, v0: 2000)
settleCheck("critical", ratio: 1, k: 200, from: 0, to: 50, v0: 0)
settleCheck("critical against its speed", ratio: 1, k: 200, from: 0, to: 50, v0: -800)
settleCheck("overdamped", ratio: 2, k: 300, from: 10, to: -40, v0: 0)
settleCheck("overdamped with a push", ratio: 1.5, k: 300, from: 10, to: -40, v0: -500)
check("no move, no time", ZnSpringCurve(from: 5, to: 5, v0: 0, ratio: 0.75, stiffness: 400).durationNs, 0)
check("ratio 0 never ends", znSpringDurationMs(stiffness: 100, ratio: 0, velocity: 0, displacement: 1, delta: 1),
      Int64.max / 1_000_000)
// Whole ms, as Compose: 16.9 ms is read at 16 ms.
let sp = ZnSpringCurve(from: 0, to: 1, v0: 0, ratio: 0.75, stiffness: 400)
check("whole ms", sp.value(16_900_000), sp.value(16_000_000))

// Decay: friction 0.476 (0.998 per ms) from 1000 / s: speed 0.1 / s after ln(1e-4) / -2 s ≈ 4.6 s, gliding ~500.
let dc = ZnDecayCurve(from: 0, v0: 1000, multiplier: 0.476)
truth("decay length", abs(Double(dc.durationNs) / 1e9 - log(1e-4) / -1.9992) < 0.01)
near("decay glides v0 / -friction", dc.target, 1000 / 1.9992, 0.5)
near("decay speed after 1 s", dc.velocity(1_000_000_000), 1000 * exp(-1.9992), 0.05)
check("decay too slow to move", ZnDecayCurve(from: 3, v0: 0.05, multiplier: 0.476).durationNs, 0)

// MARK: - A 3D turn and enter / exit's values (ZnDepth.swift)

/// Android's turn, worked out on its own: HWUI's Sk3DView (y up, z away from the viewer, camera 72 × distance px
/// away) turns a point about -y by rotateY, then about x by rotateX (rotateX then rotateY, preConcatenated), then
/// projects it. [p]: from the origin, y down, in px.
func androidTurn(_ p: CGPoint, rx: Double, ry: Double, distance: Double) -> CGPoint {
    let ax = rx * .pi / 180, ay = ry * .pi / 180
    var (x, y, z) = (Double(p.x), -Double(p.y), 0.0)
    (x, z) = (x * cos(ay), x * sin(ay) + z * cos(ay))  // Rotate({0, -1, 0}, ry), z = 0
    (y, z) = (y * cos(ax) - z * sin(ax), y * sin(ax) + z * cos(ax))  // Rotate({1, 0, 0}, rx)
    let d = 72 * distance
    let k = d / (d + z)
    return CGPoint(x: x * k, y: -y * k)
}

/// Where [m] draws [p] (Core Animation's row vectors, z = 0).
func project(_ m: CATransform3D, _ p: CGPoint) -> CGPoint {
    let x = p.x * m.m11 + p.y * m.m21 + m.m41, y = p.x * m.m12 + p.y * m.m22 + m.m42
    let w = p.x * m.m14 + p.y * m.m24 + m.m44
    return CGPoint(x: x / w, y: y / w)
}

func nearPoint(_ name: String, _ got: CGPoint, _ want: CGPoint, line: Int = #line) {
    near(name + " x", Float(got.x), Float(want.x), 1e-3, line: line)
    near(name + " y", Float(got.y), Float(want.y), 1e-3, line: line)
}

let box = CGSize(width: 200, height: 100)
// 1 px a point, so the points here are Android's px; the origin is the centre.
func turned(_ rx: CGFloat, _ ry: CGFloat, _ p: CGPoint, distance: CGFloat = 8) -> CGPoint {
    project(znDepthMatrix(size: box, rotateX: rx, rotateY: ry, cameraDistance: distance, originX: 0.5, originY: 0.5,
                          scale: 1), p)
}
// A positive rotateX takes the top edge away (drawn narrower than the bottom), a positive rotateY the right edge.
let topW = turned(30, 0, CGPoint(x: 200, y: 0)).x - turned(30, 0, CGPoint(x: 0, y: 0)).x
let bottomW = turned(30, 0, CGPoint(x: 200, y: 100)).x - turned(30, 0, CGPoint(x: 0, y: 100)).x
truth("rotateX: the top edge is farther", topW < bottomW)
let leftH = turned(0, 30, CGPoint(x: 0, y: 100)).y - turned(0, 30, CGPoint(x: 0, y: 0)).y
let rightH = turned(0, 30, CGPoint(x: 200, y: 100)).y - turned(0, 30, CGPoint(x: 200, y: 0)).y
truth("rotateY: the right edge is farther", rightH < leftH)
nearPoint("no turn", turned(0, 0, CGPoint(x: 37, y: 81)), CGPoint(x: 37, y: 81))
// Every corner as Android draws it, one turn and both (where the order matters), and a nearer camera.
for (rx, ry, dist) in [(30.0, 0.0, 8.0), (0, -50, 8), (35, 50, 8), (-70, 20, 8), (40, -60, 3)] {
    for c in [CGPoint(x: 0, y: 0), CGPoint(x: 200, y: 0), CGPoint(x: 0, y: 100), CGPoint(x: 200, y: 100)] {
        let a = androidTurn(CGPoint(x: c.x - 100, y: c.y - 50), rx: rx, ry: ry, distance: dist)
        nearPoint("turn \(rx),\(ry) at \(c)", turned(rx, ry, c, distance: dist), CGPoint(x: a.x + 100, y: a.y + 50))
    }
}
// The camera is 72 × distance px away: at 3x, that many px is a third as many points.
let at3 = project(znDepthMatrix(size: CGSize(width: 200.0 / 3, height: 100.0 / 3), rotateX: 35, rotateY: 50,
                                cameraDistance: 8, originX: 0.5, originY: 0.5, scale: 3), CGPoint(x: 0, y: 0))
let px = androidTurn(CGPoint(x: -100, y: -50), rx: 35, ry: 50, distance: 8)
nearPoint("in points at 3x", CGPoint(x: at3.x * 3, y: at3.y * 3), CGPoint(x: px.x + 100, y: px.y + 50))
// About the origin: the top-left origin stays put.
let corner = znDepthMatrix(size: box, rotateX: 45, rotateY: 45, cameraDistance: 8, originX: 0, originY: 0, scale: 1)
nearPoint("the origin stays", project(corner, .zero), .zero)

check("enter: 4 values", znTransitionValues("0,0,24,0.9"), [0, 0, 24, 0.9])
check("enter: 8 values", znTransitionValues("0,0,0,1,90,0,1,1"), [0, 0, 0, 1, 90, 0, 1, 1])
check("enter: 5 values", znTransitionValues("0,0,0,1,90"), nil)
check("enter: an empty part", znTransitionValues("0,,0,1"), nil)
check("enter: nothing", znTransitionValues(""), nil)
check("enter: not a number", znTransitionValues("0,0,x,1"), nil)

// MARK: - The engine with a fake frame clock

final class FakeClock: ZnMotionClock {
    var frame: ((Double) -> Bool)?
    var t: Int64 = 1_000_000_000
    /// How far ahead of now a frame's time is (CADisplayLink's targetTimestamp: the next vsync).
    var lead: Int64 = 0
    func add(_ owner: AnyObject, _ f: @escaping (Double) -> Bool) { frame = f }
    func remove(_ owner: AnyObject) { frame = nil }
    /// Runs [n] frames of [ns] each (60 Hz by default); stops early when the engine needs no more.
    @discardableResult func run(_ n: Int, every ns: Int64 = 16_666_667) -> Int {
        var ran = 0
        for _ in 0..<n {
            guard let f = frame else { break }
            t += ns
            ran += 1
            if !f(Double(t + lead) / 1e9) { frame = nil }
        }
        return ran
    }
    var running: Bool { frame != nil }
}

let e = ZnMotionEngine.shared
let clock = FakeClock()
e.clock = clock
e.now = { clock.t }
var off = false
e.animationsOff = { off }
var delivered: [(String, () -> Any?)] = []
var sentNow: [(String, Any)] = []
e.emitLatest = { ev, b in delivered.append((ev, b)) }
e.emitNow = { ev, p in sentNow.append((ev, p)) }
var disposedIds: [Int] = []
e.disposeHooks.append { disposedIds.append($0) }

/// The JS thread gets to the queued deliveries: their payloads, in order.
func deliver() -> [(String, Any)] {
    let d = delivered
    delivered = []
    return d.compactMap { ev, b in b().map { (ev, $0) } }
}

func steps(_ s: String) -> [ZnStep] { (json(s) as! [[String: Any]]).map { try! ZnStep.parse($0) } }

// Reserved ids, and the generation counter.
count += 1
if (try? e.putValue(3, 0)) != nil { failures += 1; print("FAIL id 3 is a window value") }
let g0 = e.generation.n
let v1 = try! e.putValue(101, 0)
check("generation goes up", e.generation.n, g0 + 1)

// A tween: the first frame already moves; it ends on the frame that reaches 300 ms, with finished: true.
var result: Bool?
e.animate(v1, steps: steps(#"[{"to":30,"t":{"t":300,"e":3}}]"#)) { result = $0 }
truth("the clock runs", clock.running)
clock.run(1)
near("first frame moves one frame", v1.value, 30 * 16.666667 / 300, 0.01)
let frames = clock.run(100) + 1
check("ends at 300 ms (18 frames)", frames, 18)
check("finished", result, true)
check("at the target", v1.value, 30)
check("at rest", v1.velocity, 0)
truth("the clock stops when nothing moves", !clock.running)

// A sequence played twice, the second time backwards: it ends where it started.
let v2 = try! e.putValue(102, 5)
result = nil
e.animate(v2, steps: steps(#"[{"to":10,"t":{"t":100,"e":3}},{"set":20},{"to":0,"t":{"t":50,"e":3}}]"#), repeat: 2, reverse: true) {
    result = $0
}
clock.run(200)
check("sequence + reverse finished", result, true)
check("back at the start", v2.value, 5)

// Repeat forever is stopped by a new command, which ends it with finished: false first.
var first: Bool?, second: Bool?
e.animate(v2, steps: steps(#"[{"to":50,"t":{"t":100,"e":3}}]"#), repeat: -1) { first = $0 }
clock.run(30)
check("a forever loop is still going", first, nil)
e.animate(v2, steps: steps(#"[{"to":1,"t":{"t":50,"e":3}}]"#)) { second = $0 }
check("the old command says false", first, false)
clock.run(20)
check("the new one finished", second, true)
check("the new one's target", v2.value, 1)

// set() during an animation stops it.
result = nil
e.animate(v2, steps: steps(#"[{"to":100}]"#)) { result = $0 }
clock.run(3)
e.set(v2, 42, interrupt: false)
check("set stops the command", result, false)
check("set value", v2.value, 42)
clock.run(5)
check("and it stays", v2.value, 42)

// A spring keeps its speed into a new target (velocity hand-off).
e.animate(v2, steps: steps(#"[{"to":200}]"#)) { _ in }
clock.run(4)
let speed = v2.velocity
truth("moving", speed > 100)
e.animate(v2, steps: steps(#"[{"to":0}]"#)) { _ in }
check("the new command starts at the old speed", v2.velocity, speed)
clock.run(300)
near("then settles", v2.value, 0, 0.01)

// overshootClamp: stops the first time it reaches the target.
let v3 = try! e.putValue(103, 0)
var maxSeen: Float = 0
result = nil
e.animate(v3, steps: steps(#"[{"to":10,"t":{"r":0.3,"k":400,"c":true}}]"#)) { result = $0 }
for _ in 0..<100 { clock.run(1); maxSeen = max(maxSeen, v3.value) }
check("clamped spring", maxSeen, 10)
check("clamped spring finished", result, true)

// A delay is time inside the run: nothing moves until it has passed.
let v4 = try! e.putValue(104, 0)
result = nil
e.animate(v4, steps: steps(#"[{"to":10,"t":{"t":100,"e":3},"delay":200}]"#)) { result = $0 }
clock.run(11)  // 183 ms
check("still waiting", v4.value, 0)
clock.run(2)
truth("moving after the delay", v4.value > 0)
clock.run(20)
check("delay then tween", result, true)
// A frame's time is a frame ahead of now (the next vsync): the delay is still wall time, as Android's delay().
let v4b = try! e.putValue(106, 0)
clock.lead = 16_666_667
e.animate(v4b, steps: steps(#"[{"to":10,"t":{"t":100,"e":3},"delay":200}]"#)) { _ in }
clock.run(11)  // 183 ms: its frame says 200 ms
check("a frame ahead doesn't end the delay early", v4b.value, 0)
clock.run(1)
truth("moving after the delay", v4b.value > 0)
clock.run(20)
clock.lead = 0

// Decay: slows down; stops at hi.
let v5 = try! e.putValue(105, 0)
result = nil
e.animate(v5, steps: steps(#"[{"decay":{"v":3000,"f":0.476,"hi":400}}]"#)) { result = $0 }
clock.run(1)
check("decay's first frame only reads the time", v5.value, 0)
clock.run(400)
check("decay stopped at hi", v5.value, 400)
check("decay finished", result, true)
// Without a speed of its own, decay takes the value's.
v5.velocity = 0
result = nil
e.animate(v5, steps: steps(#"[{"decay":{"f":0.476}}]"#)) { result = $0 }
clock.run(3)
check("no speed, no glide", [result == true ? 1 : 0, Int(v5.value)], [1, 400])

// Animations off (Reduce Motion): there at once, and a forever loop plays once.
off = true
result = nil
e.animate(v4, steps: steps(#"[{"to":77,"delay":500},{"decay":{"v":900}}]"#), repeat: -1) { result = $0 }
check("off: done at once", result, true)
check("off: at the end", v4.value, 77)
off = false

// A held value drops a command unless it interrupts; then the hold is cancelled.
final class Finger: ZnMotionHolder {
    var cancelled = false
    func cancel() { cancelled = true }
}
let finger = Finger()
v4.heldBy = finger
result = nil
e.animate(v4, steps: steps(#"[{"to":1}]"#)) { result = $0 }
check("held: dropped", result, false)
e.set(v4, 9, interrupt: false)
check("held: set ignored", v4.value, 77)
e.animate(v4, steps: steps(#"[{"to":1,"t":{"t":0}}]"#), interrupt: true) { result = $0 }
truth("interrupt cancels the finger", finger.cancelled)
clock.run(2)
check("interrupt runs it", v4.value, 1)
var commanded = 0
v4.onCommand = { commanded += 1 }
e.set(v4, 3, interrupt: false)
check("onCommand", commanded, 1)

// MARK: Values to JS

_ = deliver()
let w = try! e.putValue(110, 4)
e.watch(110, true)
clock.run(1)
var got = deliver()
check("watch sends the value now", got.count, 1)
check("as values", got.first?.0, "values")
check("payload", got.first?.1 as? [String: Double], ["110": 4])
// Several changes while JS is busy: one delivery, the newest values.
w.value = 5
clock.run(1)
w.value = 6
let w2 = try! e.putValue(111, 0)
e.watch(111, true)
clock.run(1)
check("one delivery outstanding", delivered.count, 1)
got = deliver()
check("newest values merged", got.first?.1 as? [String: Double], ["110": 6, "111": 0])
// No change, nothing sent.
w.value = 6
clock.run(2)
check("an equal write sends nothing", delivered.count, 0)
// A gesture event goes after the values still waiting.
w2.value = 1
e.sendEvent(["g": 9, "t": "end"])
check("values first", delivered.count, 1)
check("then the event", sentNow.last?.0, "gesture")
got = deliver()
check("the value that moved", got.first?.1 as? [String: Double], ["111": 1])
e.watch(111, false)

// read() asks an element to write its box first.
let el = try! e.putElement(120, ["x": 121, "y": 122, "width": 123, "height": 124, "progress": 125])
el.refresh = { el.value("width")?.value = 88 }
check("read", e.read([123, 121, 999]), ["123": 88, "121": 0])
truth("non-box values come from the component", el.lambda("progress") != nil)

// Frames: one event outstanding, with the time and the step in ms.
_ = deliver()
e.frames(true)
clock.run(3)
check("one frame event outstanding", delivered.count, 1)
got = deliver()
truth("frame event", got.first?.0 == "frame")
clock.run(1)
got = deliver()
near("frame dt", Float((got.first?.1 as? [String: Double])?["dt"] ?? 0), 16.666667, 0.001)
e.frames(false)
clock.run(5)
_ = deliver()

// MARK: Formulas, maps, follow on real values

let a = try! e.putValue(130, 10)
try! e.put(131, ZnMapSource(id: 131, a, [0, 100], [0, 1], 0))
try! e.put(132, ZnFormulaSource(id: 132, f(#"["$0","$1","+"]"#, [.src(a), .src(e.find(131)!)])))
near("formula of a value and a map", e.find(132)!.read(nil), 10.1, 1e-5)
a.value = 50
near("follows its inputs", e.find(132)!.read(nil), 50.5, 1e-5)

let target = try! e.putValue(140, 0)
try! e.put(141, ZnFollowSource(id: 141, target, try! ZnTimingSpec.parse(["r": 1, "k": 300])))
clock.run(3)
truth("follow sleeps while it rests", !clock.running)
target.value = 100
clock.run(3)  // the frame that wakes it, the frame that reads the time, one step
let chase = e.find(141)!.read(nil)
truth("follow chases (\(chase))", chase > 0 && chase < 100)
clock.run(400)
check("follow arrives", e.find(141)!.read(nil), 100)
truth("and sleeps again", !clock.running)

// onDirty subscribers run on the frame after a value moved.
final class Owner {}
var owner: Owner? = Owner()
var dirtyRuns = 0
e.onDirty(owner!) { dirtyRuns += 1 }
target.value = 3
clock.run(2)
check("onDirty", dirtyRuns, 1)
owner = nil
target.value = 4
clock.run(2)
check("a gone owner's subscriber is dropped", dirtyRuns, 1)

// MARK: Disposal (aDisposedValueStaysAtItsLastValueForWhatStillDrawsIt)

let d = try! e.putValue(941, 0)
d.value = 42
let ref = "\u{0}m941", text = "\u{0}f941|{\"d\":0}"
near("ref", e.ref(ref)?.read(nil) ?? -1, 42)
check("text", e.text(text), "42")
result = nil
e.animate(d, steps: steps(#"[{"to":0}]"#)) { result = $0 }
e.dispose(941)
check("dispose stops its command", result, false)
truth("gone", e.find(941) == nil)
check("hooks hear it", disposedIds.last, 941)
near("still readable", e.ref(ref)?.read(nil) ?? -1, 42)
check("still shown", e.text(text), "42")
_ = try! e.putValue(941, 7)
near("a new value under the id wins", e.ref(ref)?.read(nil) ?? -1, 7)
check("and its text", e.text(text), "7")
check("not a reference", e.ref("12") == nil, true)
check("a missing id", e.ref("\u{0}m555") == nil, true)
check("a text of a missing id", e.text("\u{0}f556"), "")
check("not a text", e.text("plain"), nil)

// MARK: - Bindings: what a slot that may follow a motion value reads (ZnMotionBindRules.swift)

let bv = try! e.putValue(140, 30)
let bref = ZnValue.string("\u{0}m140")
check("a reference reads its value", znBoundNumber(bref, 1, site: nil), 30)
bv.value = 45
check("and follows it", znBoundNumber(bref, 1, site: nil), 45)
check("a number is itself", znBoundNumber(.number(0.5), 1, site: nil), 0.5)
check("NaN is the fixed value", znBoundNumber(.number(.nan), 1, site: nil), 1)
check("null is the fixed value", znBoundNumber(.null, 1, site: nil), 1)
check("a reference not made yet is the fixed value", znBoundNumber(.string("\u{0}m149"), 1, site: nil), 1)
check("a plain string is the fixed value", znBoundNumber(.string("12"), 1, site: nil), 1)
truth("a reference is one, made or not", znIsMotionRef(bref) && znIsMotionRef(.string("\u{0}m149")) && !znIsMotionRef(.number(1)))
check("a corner or size: a reference", znBoundNumberOrNil(bref), 45)
check("a corner or size: NaN is not written", znBoundNumberOrNil(.number(.infinity)), nil)
check("a corner or size: null is not written", znBoundNumberOrNil(.null), nil)
// A motion colour: mapColor's ARGB; a number source isn't a colour.
try! e.put(141, ZnColorMapSource(id: 141, bv, [0, 90], [0xFF00_0000, 0xFFFF_FFFF]))
check("a motion colour", znBoundColor(.string("\u{0}m141")), 0xFF7F_7F7F)
check("a number source is no colour", znBoundColor(bref), nil)
// self / parent sizes come from the site the node feeds (ZnMotionTest.selfAndParentSizesComeFromTheSite).
try! e.put(142, ZnFormulaSource(id: 142, f(#"["$0","pw","*","sw","/"]"#, [.src(bv)])))
let fill = ZnValue.string("\u{0}m142")
truth("a formula reading parent / self wants the site", znSiteUsed([.number(1), fill]))
truth("a plain value doesn't", !znSiteUsed([bref, .null]))
check("no site yet: sizes are 0 (x / 0 = 0)", znBoundNumber(fill, 1, site: nil), 0)
let fed = ZnSite()
fed.update(40, 12, 360, 20)
check("p × parent.width / self.width", znBoundNumber(fill, 1, site: fed), 45 * 360 / 40)
fed.update(40, 12, 180, 20)
check("a parent resize", znBoundNumber(fill, 1, site: fed), 45 * 180 / 40)
// A Text's string: a motion value as text, never its control characters.
check("a motion text", znShownString("\u{0}f140|{\"p\":\"₹\"}"), "₹45")
check("a motion text not made yet", znShownString("\u{0}f148|{}"), "")
check("plain text", znShownString("Pay ₹45"), "Pay ₹45")
// Blur: Skia's radius to sigma, in points.
check("no blur", znBlurSigma(0, scale: 3), 0)
check("blur 12 at 3x", Float(znBlurSigma(12, scale: 3)), Float(0.57735 * 12 + 0.5 / 3))
// One matrix for the whole layer: scale and rotate about the origin, the 3D turn, then the translation (HWUI).
func layer(_ p: CGPoint, sx: CGFloat = 1, sy: CGFloat = 1, rot: CGFloat = 0, rx: CGFloat = 0, ry: CGFloat = 0,
           tx: CGFloat = 0, ty: CGFloat = 0, ox: CGFloat = 0.5, oy: CGFloat = 0.5) -> CGPoint {
    project(znLayerMatrix(size: box, scaleX: sx, scaleY: sy, rotate: rot, rotateX: rx, rotateY: ry, cameraDistance: 8,
                          translateX: tx, translateY: ty, originX: ox, originY: oy, scale: 1), p)
}
nearPoint("identity", layer(CGPoint(x: 37, y: 81)), CGPoint(x: 37, y: 81))
nearPoint("translate", layer(CGPoint(x: 0, y: 0), tx: 10, ty: -5), CGPoint(x: 10, y: -5))
nearPoint("scaleX about the left edge", layer(CGPoint(x: 200, y: 0), sx: 0.5, ox: 0, oy: 0), CGPoint(x: 100, y: 0))
nearPoint("scale about the centre", layer(CGPoint(x: 0, y: 0), sx: 2, sy: 2), CGPoint(x: -100, y: -50))
// rotate 90 clockwise about the centre (100, 50): the top-left corner (-100, -50 from it) goes to (50, -100) from it.
nearPoint("rotate 90 clockwise", layer(CGPoint(x: 0, y: 0), rot: 90), CGPoint(x: 150, y: -50))
nearPoint("scale, then rotate, then translate", layer(CGPoint(x: 200, y: 50), sx: 2, rot: 90, tx: 7),
          CGPoint(x: 107, y: 250))
// With a turn: the same as the turn alone, then the translation.
let turnedCorner = turned(35, 50, CGPoint(x: 200, y: 0))
nearPoint("a turn, then the translation", layer(CGPoint(x: 200, y: 0), rx: 35, ry: 50, tx: 3, ty: 4),
          CGPoint(x: turnedCorner.x + 3, y: turnedCorner.y + 4))

// Reset: everything JS made goes; window values stay.
e.reset()
truth("reset drops values", e.find(130) == nil && e.find(941) == nil)
truth("window values stay", e.env(ZnMotionEngine.envWidth) != nil && e.find(1) != nil)
clock.run(5)
truth("nothing left to tick", !clock.running)

// A reset drops the window values' watches too: the new JS watches them again and gets their value now.
e.env(ZnMotionEngine.envWidth)!.set(390)
e.watch(ZnMotionEngine.envWidth, true)
clock.run(1)
_ = deliver()
e.reset()
e.watch(ZnMotionEngine.envWidth, true)
clock.run(1)
check("a watch after reset sends the window value now", deliver().first?.1 as? [String: Double], ["1": 390])
// Watched again without a change: sent again (a new reader).
e.watch(ZnMotionEngine.envWidth, true)
clock.run(1)
check("a second watch sends it again", deliver().first?.1 as? [String: Double], ["1": 390])
e.reset()
clock.run(5)
truth("nothing left to tick after the second reset", !clock.running)

print(failures == 0 ? "ios motion: \(count) checks passed" : "ios motion: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
