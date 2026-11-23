// iOS's gestures on the Mac (ZnGestureMath.swift, ZnVelocityTracker.swift, ZnGesture.swift, ZnGestureRecognizers.swift):
// tools/ios-unit-test.ts builds this with them (sources.txt). The option, release and link cases are android/runtime's
// ZnMotionTest.kt, with the same numbers (the fling projection is iOS's: UIScrollView's deceleration); the touch cases
// feed made-up finger streams to one node's touch session, as Android's pointer loop would see them, on the motion
// engine with a fake frame clock.
import Foundation

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

func json(_ s: String) -> [String: Any] { try! JSONSerialization.jsonObject(with: Data(s.utf8)) as! [String: Any] }

final class FakeClock: ZnMotionClock {
    var frame: ((Double) -> Bool)?
    var t: Int64 = 1_000_000_000
    func add(_ owner: AnyObject, _ f: @escaping (Double) -> Bool) { frame = f }
    func remove(_ owner: AnyObject) { frame = nil }
    func run(_ n: Int) {
        for _ in 0..<n {
            guard let f = frame else { break }
            t += 16_666_667
            if !f(Double(t) / 1e9) { frame = nil }
        }
    }
}

let e = ZnMotionEngine.shared
let clock = FakeClock()
e.clock = clock
e.now = { clock.t }
var sent: [[String: Any]] = []
e.emitNow = { ev, p in if ev == "gesture", let d = p as? [String: Any] { sent.append(d) } }
var haptics: [String] = []
ZnGestures.haptic = { k in if let k, k != "", k != "none" { haptics.append(k) } }

/// The event types gesture [g] sent since the last call, in order.
func events(_ g: Int) -> [String] {
    defer { sent = [] }
    return sent.filter { ($0["g"] as? Int) == g }.compactMap { $0["t"] as? String }
}

func lastEvent(_ g: Int, _ t: String) -> [String: Any]? { sent.last { ($0["g"] as? Int) == g && ($0["t"] as? String) == t } }

func gesture(_ id: Int, _ o: String) -> ZnGesture {
    var a = json(o)
    a["id"] = id
    try! ZnGestures.make(a)
    let g = ZnGestures.find(id)!
    g.placed(80, 60, 400, 800)
    return g
}

func group(_ id: Int, _ mode: String, _ of: [Int]) -> ZnGesture {
    try! ZnGestures.makeGroup(["id": id, "mode": mode, "of": of])
    return ZnGestures.find(id)!
}

/// A finger stream on one node: down, moves, up (window and node points are the same here).
final class Finger {
    let s: ZnGestureSession
    var t: Int64
    var fingers: [Int: (Float, Float)] = [:]
    init(_ g: ZnGesture, at t: Int64 = 10_000) {
        self.t = t
        s = ZnGestureSession(g, downAt: t)
    }

    private func send(_ changes: [ZnPointerChange], consumed: Bool = false) {
        // In the order the fingers landed, as the hub keeps them.
        var ev = ZnPointerEvent(changes: changes.sorted { $0.id < $1.id }, consumed: consumed)
        s.handle(&ev)
    }

    private func change(_ id: Int, _ to: (Float, Float), _ from: (Float, Float), _ down: Bool, _ was: Bool) -> ZnPointerChange {
        ZnPointerChange(id: id, x: to.0, y: to.1, px: from.0, py: from.1, wx: to.0, wy: to.1, pwx: from.0, pwy: from.1,
                        pressed: down, previousPressed: was, t: t)
    }

    func down(_ x: Float, _ y: Float, id: Int = 0, after ms: Int64 = 0) {
        t += ms
        fingers[id] = (x, y)
        send(fingers.map { k, p in change(k, p, p, true, k != id) })
    }

    /// Moves finger [id] by (dx, dy) in [steps] events of 16 ms.
    func move(_ dx: Float, _ dy: Float, id: Int = 0, steps: Int = 1, consumed: Bool = false) {
        for _ in 0..<steps {
            t += 16
            let from = fingers[id]!
            let to = (from.0 + dx / Float(steps), from.1 + dy / Float(steps))
            fingers[id] = to
            send(fingers.map { k, p in k == id ? change(k, to, from, true, true) : change(k, p, p, true, true) }, consumed: consumed)
        }
    }

    /// Moves two fingers at once.
    func move2(_ a: (Float, Float), _ b: (Float, Float)) {
        t += 16
        let fa = fingers[0]!, fb = fingers[1]!
        fingers[0] = a
        fingers[1] = b
        send([change(0, a, fa, true, true), change(1, b, fb, true, true)])
    }

    /// Lifts finger [id], [by] (dx, dy) from where it was (UIKit's up can carry the last bit of movement).
    func up(id: Int = 0, after ms: Int64 = 16, by d: (Float, Float) = (0, 0)) {
        t += ms
        let p = fingers[id]!
        var cs = [change(id, (p.0 + d.0, p.1 + d.1), p, false, true)]
        for (k, q) in fingers where k != id { cs.append(change(k, q, q, true, true)) }
        fingers[id] = nil
        send(cs)
    }

    func wait(_ ms: Int64) {
        t += ms
        s.tick(t)
    }
}

// MARK: - Options and release (ZnMotionTest.kt)

do {  // rubberBandGrowsSlowerThanTheFinger
    let a = ZnGestureMath.rubber(50, 200), b = ZnGestureMath.rubber(500, 200)
    truth("rubber 50 within", a >= 0 && a <= 50)
    truth("rubber 500 grows less", b < 200 && b > a)
}

do {  // specsResolveAgainstTheSite
    near("50%", try! ZnSpec.parse("50%")!.resolve(80, 400, nil), 160)
    near("50%self", try! ZnSpec.parse("50%self")!.resolve(80, 400, nil), 40)
    near("50%parent", try! ZnSpec.parse("50%parent")!.resolve(80, 400, nil), 200)
    near("number", try! ZnSpec.parse(12.5)!.resolve(80, 400, nil), 12.5)
    truth("50px throws", (try? ZnSpec.parse("50px")) == nil)
    truth("null is none", (try! ZnSpec.parse(NSNull())) == nil)
}

do {  // oneAxisReleasePicksTheAnchorByFlickOrDistance
    let g = gesture(800, #"{"kind":"pan","axis":"x","values":{"x":801,"y":802},"anchors":[{"id":"start","x":0},{"id":"paid","x":"100%"}],"release":{"threshold":{"velocity":400,"distance":40}}}"#)
    let flick = g.chooseTarget(30, 0, 900, 0, 0, 0)!
    check("flick right", flick.id, "paid")
    near("100% = 400 - 80", flick.x!, 320)
    check("slow past half", g.chooseTarget(200, 0, 50, 0, 0, 0)!.id, "paid")
    check("slow, short", g.chooseTarget(30, 0, 0, 0, 0, 0)!.id, "start")
    check("flick left", g.chooseTarget(300, 0, -900, 0, 320, 0)!.id, "start")
}

do {  // twoAxisReleasePicksTheNearestCornerAndMagnetsWin
    let g = gesture(810, #"{"kind":"pan","axis":"xy","values":{"x":811,"y":812},"anchors":[{"id":"tl","x":0,"y":0},{"id":"br","x":"100%","y":"100%"}],"magnets":[{"id":"bin","x":200,"y":700,"radius":60}]}"#)
    check("tl", g.chooseTarget(40, 60, 0, 0, 0, 0)!.id, "tl")
    let br = g.chooseTarget(300, 600, 0, 0, 0, 0)!
    check("br", br.id, "br")
    near("br y = 800 - 60", br.y!, 740)
    check("magnet wins", g.chooseTarget(210, 690, 0, 0, 0, 0)!.id, "bin")
}

do {  // noAnchorsMeansNoTarget
    let g = gesture(820, #"{"kind":"pan","axis":"xy","values":{"x":821,"y":822}}"#)
    truth("no anchors", g.chooseTarget(10, 10, 0, 0, 0, 0) == nil)
}

do {  // the projection is iOS's: a release with `project` goes where UIScrollView's normal deceleration would stop
    near("fling 1000 pt/s glides 499 pt", ZnGestureMath.flingDistance(1000), 499, 0.01)
    let g = gesture(825, #"{"kind":"pan","axis":"xy","values":{"x":826,"y":827},"anchors":[{"id":"l","x":-600,"y":0},{"id":"c","x":0,"y":0},{"id":"r","x":600,"y":0}],"release":{"project":true}}"#)
    check("a slow drag stays", g.chooseTarget(100, 0, 100, 0, 0, 0)!.id, "c")
    check("a flick right goes out", g.chooseTarget(100, 0, 1000, 0, 0, 0)!.id, "r")
    check("a flick left goes out", g.chooseTarget(-60, 0, -1000, 0, 0, 0)!.id, "l")
}

do {  // progressFollowsTheBoundsOfItsAxis
    let g = gesture(830, #"{"kind":"pan","axis":"x","values":{"x":831,"y":832,"progress":833},"bounds":{"x":[0,"100%"]}}"#)
    g.x!.value = 160
    near("progress", e.find(833)!.read(nil), 0.5, 1e-6)
}

do {  // requireToFailWaitsThenFailsOrGoes
    let other = gesture(870, #"{"kind":"tap"}"#)
    let g = gesture(871, #"{"kind":"pan","fails":[870]}"#)
    other.live = -1
    check("not touched", g.externalOk(), true)
    other.live = 0
    check("possible: wait", g.externalOk(), nil)
    other.live = 1
    check("active: fail", g.externalOk(), false)
    other.live = 2
    check("failed: go", g.externalOk(), true)
    other.live = -1
}

do {  // dropZonesUseTheElementBoxesInTheWindow
    let el = try! e.putElement(880, ["x": 881, "y": 882, "width": 883, "height": 884])
    el.value("x")!.value = 100
    el.value("y")!.value = 200
    el.value("width")!.value = 50
    el.value("height")!.value = 40
    let g = gesture(885, #"{"kind":"pan","zones":[880]}"#)
    check("inside", g.zoneAt(120, 220), 0)
    check("left of it", g.zoneAt(99, 220), -1)
    check("below it", g.zoneAt(120, 241), -1)
}

// MARK: - The velocity tracker (Compose's impulse strategy)

do {
    var vt = ZnVelocityTracker1D()
    for i in 0..<10 { vt.add(Int64(i * 16), Float(i) * 8) }  // 8 pt every 16 ms = 500 pt/s
    near("steady 500 pt/s", vt.velocity(), 500, 5)
    var stopped = ZnVelocityTracker1D()
    for i in 0..<5 { stopped.add(Int64(i * 16), Float(i) * 8) }
    stopped.add(64 + 60, 32)  // the finger rested 60 ms before lifting
    near("a pause before the lift: 0", stopped.velocity(), 0)
    var one = ZnVelocityTracker1D()
    one.add(0, 10)
    near("one sample: 0", one.velocity(), 0)
}

// MARK: - Pan

do {  // axis x: slop, then follows; the other axis fails it at the slop
    let g = gesture(900, #"{"kind":"pan","axis":"x","values":{"x":901,"y":902},"ev":["begin","start","update","end","finalize","settle"]}"#)
    let f = Finger(g)
    f.down(10, 10)
    check("begin first", events(900), ["begin"])
    f.move(6, 0)
    check("under the slop: possible", g.live, znPossible)
    f.move(6, 0)
    check("past the slop: active", g.live, znActive)
    check("start", events(900), ["start"])
    near("x starts where it was (no jump by the slop)", g.x!.value, 0)
    truth("it holds x", g.x!.heldBy != nil)
    truth("it claims the touch", f.s.claims)
    f.move(30, 5, steps: 3)
    near("x follows the finger", g.x!.value, 30)
    near("y doesn't move on an x pan", g.y!.value, 0)
    check("updates", events(900), ["update", "update", "update"])
    f.up()
    check("end, finalize, then settle", events(900), ["end", "finalize", "settle"])
    truth("over", f.s.over)
    truth("released", g.x!.heldBy == nil)

    let v = Finger(g)
    v.down(10, 10)
    v.move(2, 10)
    check("vertical first: fails", v.s.mayClaim(fingers: 1), false)
    v.up()
    check("no start when it failed", events(900).filter { $0 == "start" }, [])
}

do {  // bounds with the rubber band, release back inside, settle
    let g = gesture(910, #"{"kind":"pan","axis":"x","values":{"x":911,"y":912},"bounds":{"x":[0,100]},"ev":["end","settle"]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(10, 0)
    f.move(150, 0, steps: 5)
    truth("past the bound it moves less", g.x!.value > 100 && g.x!.value < 150)
    f.up(after: 100)
    clock.run(120)
    near("springs back inside", g.x!.value, 100, 0.01)
    check("end, then settle", events(910), ["end", "settle"])
}

do {  // anchors: a flick to the far one, the haptic, end's anchor, settle there; a JS command ends the rest
    haptics = []
    let g = gesture(920, #"{"kind":"pan","axis":"x","values":{"x":921,"y":922},"anchors":[{"id":"a","x":0},{"id":"b","x":200}],"haptic":{"snap":"medium","start":"light"},"ev":["end","settle"]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(10, 0)
    f.move(60, 0, steps: 4)
    f.up()
    let end = lastEvent(920, "end")!
    check("flicked to b", end["anchor"] as? String, "b")
    check("toX", end["toX"] as? Double, 200)
    check("haptics", haptics, ["light", "medium"])
    clock.run(120)
    near("rests on b", g.x!.value, 200, 0.01)
    check("settle on b", lastEvent(920, "settle")?["anchor"] as? String, "b")

    // A flick back toward a, then the finger rests 300 ms before it lifts (UIKit sends no moves meanwhile): no
    // speed, so the nearest anchor wins (b, from 140), not the flick's.
    let h = Finger(g)
    h.down(0, 0)
    h.move(-10, 0)
    h.move(-60, 0, steps: 4)
    h.up(after: 300)
    let still = lastEvent(920, "end")!
    check("held still before the lift: no speed", still["vx"] as? Double, 0)
    check("held still: the nearest anchor", still["anchor"] as? String, "b")
    clock.run(120)

    // A flick whose last movement comes with the lift itself (no move event first): the lift carries the speed.
    let l = Finger(g)
    l.down(0, 0)
    l.move(-10, 0)
    l.move(-15, 0)
    l.up(by: (-15, 0))
    let lift = lastEvent(920, "end")!
    near("the lift's movement is a speed (15 pt in 16 ms, as the move before)", Float((lift["vx"] as? Double) ?? 0), -937.5, 1)
    check("so the flick goes to a", lift["anchor"] as? String, "a")
    clock.run(120)
}

do {  // magnets pull and say when the finger goes in and out
    let g = gesture(930, #"{"kind":"pan","axis":"xy","values":{"x":931,"y":932},"magnets":[{"id":"bin","x":100,"y":0,"radius":40,"pull":0.5}],"ev":["magnet"]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(10, 0)
    f.move(70, 0)
    near("pulled toward the centre", g.x!.value, 73.75, 0.01)  // 70 + (100 - 70) × (1 - 30 / 40) × 0.5
    check("inside", lastEvent(930, "magnet")?["inside"] as? Bool, true)
    f.move(-60, 0)
    check("out again", lastEvent(930, "magnet")?["inside"] as? Bool, false)
    f.up()
    _ = events(930)
}

do {  // activeOffsetX: starts only past it; failOffsetY fails it
    let g = gesture(940, #"{"kind":"pan","values":{"x":941,"y":942},"activeOffsetX":[-20,20],"failOffsetY":[-5,5]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(15, 0)
    check("inside the active offset", g.live, znPossible)
    f.move(10, 0)
    check("past it", g.live, znActive)
    f.up()
    let h = Finger(g)
    h.down(0, 0)
    h.move(0, 6)
    check("past the fail offset", h.s.mayClaim(fingers: 1), false)
    h.up()
}

do {  // taken by someone else (a scroll started): a possible pan gives the touch up, cancelled
    let g = gesture(950, #"{"kind":"pan","axis":"x","values":{"x":951,"y":952},"ev":["begin","end"]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(4, 0, consumed: true)
    truth("taken: over", f.s.over)
    truth("cancelled", f.s.cancelled)
    check("only begin", events(950), ["begin"])
}

do {  // a JS command with interruptGesture cancels the touch: end cancelled
    let g = gesture(955, #"{"kind":"pan","axis":"x","values":{"x":956,"y":957},"ev":["end"]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(20, 0)
    e.set(g.x!, 5, interrupt: true)
    truth("over", f.s.over)
    check("end cancelled", lastEvent(955, "end")?["cancelled"] as? Bool, true)
    near("the command's value", g.x!.value, 5)
    _ = events(955)
}

do {  // snapTo: cancels the touch, moves to the anchor, answers finished
    let g = gesture(960, #"{"kind":"pan","axis":"x","values":{"x":961,"y":962},"anchors":[{"id":"start","x":0},{"id":"end","x":"100%"}]}"#)
    var answer: [String: Any]?
    try! ZnGestures.snapTo(["id": 960, "anchor": "end"]) { answer = $0 }
    clock.run(120)
    near("at the end (400 - 80)", g.x!.value, 320, 0.01)
    check("finished", answer?["finished"] as? Bool, true)
    truth("unknown anchor throws", (try? ZnGestures.snapTo(["id": 960, "anchor": "nope"]) { _ in }) == nil)
}

do {  // a release on an anchor rests there and follows it when it moves (the keyboard opens); a JS command ends that
    let kb = try! e.putValue(965, 0)
    let g = gesture(966, #"{"kind":"pan","axis":"y","values":{"x":967,"y":968},"anchors":[{"id":"top","y":0},{"id":"low","y":{"m":965}}]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(0, 20, steps: 2)
    f.up(after: 200)
    clock.run(120)
    check("rests on the anchor nearest", g.y!.value, 0)
    kb.value = -300
    clock.run(120)
    near("didn't follow: it rests on top, which didn't move", g.y!.value, 0, 0.01)
    let h = Finger(g)
    h.down(0, 0)
    h.move(0, -250, steps: 5)
    h.up(after: 200)
    clock.run(120)
    near("rests on low", g.y!.value, -300, 0.01)
    kb.value = -200
    clock.run(120)
    near("follows the anchor", g.y!.value, -200, 0.01)
    e.set(g.y!, 0, interrupt: false)
    kb.value = -100
    clock.run(120)
    near("a JS command ends the follow", g.y!.value, 0, 0.01)
    // The anchor moves while the release springs to it (the keyboard opens during the settle): once there, it goes
    // on to where the anchor is now (Android's snapshotFlow starts with the current point).
    let k = Finger(g)
    k.down(0, 0)
    k.move(0, -120, steps: 4)
    k.up(after: 200)
    clock.run(3)
    kb.value = -250
    clock.run(240)
    near("goes on to the anchor that moved during the settle", g.y!.value, -250, 0.01)
    _ = events(966)
}

do {  // a finger grabbing the card while it settles holds it: no spring to the old anchor pulls it away
    let g = gesture(1210, #"{"kind":"pan","values":{"x":1211,"y":1212},"anchors":[{"id":"a","x":0,"y":0},{"id":"b","x":300,"y":400}]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(60, 80, steps: 4)
    f.up(after: 200)
    clock.run(4)  // springing back to a
    let h = Finger(g)
    h.down(0, 0)
    h.move(20, 20, steps: 2)  // past the slop: the pan starts where the card is
    let gx = g.x!.value, gy = g.y!.value
    clock.run(60)  // the finger holds still
    near("x stays under the finger", g.x!.value, gx, 0.01)
    near("y stays under the finger", g.y!.value, gy, 0.01)
    h.move(10, 0)
    clock.run(10)
    near("x moves with the finger only", g.x!.value, gx + 10, 0.01)
    near("y still", g.y!.value, gy, 0.01)
    h.up(after: 200)
    clock.run(240)
    // A 1D slider grabbed mid-spring: the same.
    let s1 = gesture(1215, #"{"kind":"pan","axis":"x","values":{"x":1216,"y":1217},"anchors":[{"id":"start","x":0},{"id":"end","x":300}]}"#)
    let k = Finger(s1)
    k.down(0, 0)
    k.move(100, 0, steps: 4)
    k.up(after: 200)
    clock.run(4)
    let m = Finger(s1)
    m.down(0, 0)
    m.move(12, 0, steps: 2)
    let sx = s1.x!.value
    clock.run(60)
    near("the slider stays under the finger", s1.x!.value, sx, 0.01)
    m.up(after: 200)
    clock.run(240)
    // snapTo while a settle runs: both values go to the new anchor, and it doesn't rest on the old one.
    let n = Finger(g)
    n.down(0, 0)
    n.move(-40, -40, steps: 4)
    n.up(after: 200)
    clock.run(4)
    var answer: [String: Any]?
    try! ZnGestures.snapTo(["id": 1210, "anchor": "b"]) { answer = $0 }
    clock.run(240)
    near("snapTo x", g.x!.value, 300, 0.01)
    near("snapTo y", g.y!.value, 400, 0.01)
    check("snapTo finished", answer?["finished"] as? Bool, true)
    _ = events(1210)
    _ = events(1215)
}

do {  // crosses: each way once per crossing, with the haptic
    haptics = []
    let g = gesture(970, #"{"kind":"pan","axis":"x","values":{"x":971,"y":972},"cross":[50],"haptic":{"cross":"selection"},"ev":["cross"]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(10, 0)
    f.move(60, 0, steps: 3)
    f.move(-60, 0, steps: 3)
    f.up()
    let c = sent.filter { ($0["g"] as? Int) == 970 }.compactMap { $0["forward"] as? Bool }
    check("forward then back", c, [true, false])
    check("two haptics", haptics, ["selection", "selection"])
    _ = events(970)
}

do {  // activateAfterLongPress: moving first fails it; held long enough, it starts at the time
    let g = gesture(975, #"{"kind":"pan","values":{"x":976,"y":977},"activateAfterLongPress":300}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(20, 0)
    check("moved first: failed", f.s.mayClaim(fingers: 1), false)
    f.up()
    let h = Finger(g)
    h.down(0, 0)
    check("its deadline", h.s.wakeAt(h.t), h.t + 300)
    h.wait(300)
    check("held: active", g.live, znActive)
    h.move(30, 0)
    near("then follows", g.x!.value, 30)
    h.up()
}

// MARK: - Tap, double tap, long press, fling

do {
    let g = gesture(1000, #"{"kind":"tap","values":{"pressed":1001},"ev":["begin","end","finalize"]}"#)
    let f = Finger(g)
    f.down(5, 5)
    truth("a tap never claims", !f.s.mayClaim(fingers: 1))
    f.up(after: 80)
    check("tap", events(1000), ["begin", "end", "finalize"])
    truth("over", f.s.over)

    let slow = Finger(g)
    slow.down(5, 5)
    check("its deadline is maxDuration", slow.s.wakeAt(slow.t), slow.t + 500)
    slow.wait(500)
    truth("too long: over", slow.s.over)
    check("no end", events(1000), ["begin"])

    let far = Finger(g)
    far.down(5, 5)
    far.move(20, 0)
    far.up()
    check("moved past the slop: no end", events(1000), ["begin"])
}

do {  // a double tap: the second tap within maxDelay; too late: none
    let g = gesture(1010, #"{"kind":"tap","taps":2,"ev":["end"]}"#)
    let f = Finger(g)
    f.down(5, 5)
    f.up(after: 50)
    truth("waits for the next tap", !f.s.over)
    f.down(6, 5, after: 100)
    f.up(after: 50)
    check("double tap", events(1010), ["end"])
    truth("over", f.s.over)

    let late = Finger(g)
    late.down(5, 5)
    late.up(after: 50)
    late.wait(300)
    truth("the gap passed: over", late.s.over)
    check("no end", events(1010), [])
}

do {  // Gesture.exclusive(doubleTap, tap): a single tap fires only after the double tap's gap; a double tap only that
    let dbl = gesture(1020, #"{"kind":"tap","taps":2,"ev":["end"]}"#)
    let one = gesture(1021, #"{"kind":"tap","ev":["end"]}"#)
    let ex = group(1022, "exclusive", [1020, 1021])
    let f = Finger(ex)
    f.down(5, 5)
    f.up(after: 50)
    check("nothing yet", sent.count, 0)
    f.wait(300)
    check("the single tap, after the gap", events(1021), ["end"])
    check("not the double", events(1020), [])
    let d = Finger(ex)
    d.down(5, 5)
    d.up(after: 50)
    d.down(5, 5, after: 80)
    d.up(after: 50)
    let order = sent.compactMap { $0["g"] as? Int }
    check("only the double tap", order, [1020])
    sent = []
    _ = dbl; _ = one
}

do {  // Gesture.race(pan, longPress): the first to start wins, the other fails
    let pan = gesture(1030, #"{"kind":"pan","values":{"x":1031,"y":1032},"ev":["start"]}"#)
    let lp = gesture(1033, #"{"kind":"longPress","values":{"pressed":1034,"held":1035},"ev":["start","end"]}"#)
    let race = group(1036, "race", [1030, 1033])
    let f = Finger(race)
    f.down(0, 0)
    f.move(20, 0)
    check("pan won", pan.live, znActive)
    check("long press failed", lp.live, znFailed)
    f.up()
    let h = Finger(race)
    h.down(0, 0)
    h.wait(500)
    check("long press won", lp.live, znActive)
    check("pan failed", pan.live, znFailed)
    h.up()
    check("long press end", lastEvent(1033, "end")?["cancelled"] as? Bool, false)
    sent = []
}

do {  // Gesture.simultaneous(pinch, pan): both run; the pinch scales by the spread
    let pinch = gesture(1040, #"{"kind":"pinch","values":{"scale":1041,"focalX":1042,"focalY":1043},"ev":["start","end"]}"#)
    let pan = gesture(1044, #"{"kind":"pan","values":{"x":1045,"y":1046}}"#)
    let sim = group(1047, "simultaneous", [1040, 1044])
    let f = Finger(sim)
    f.down(100, 100, id: 0)
    f.down(200, 100, id: 1)
    check("two fingers: may claim", f.s.mayClaim(fingers: 2), true)
    f.move2((90, 100), (210, 100))
    f.move2((60, 120), (260, 120))
    check("pinch active", pinch.live, znActive)
    check("pan active too", pan.live, znActive)
    near("scale = 200 / 120 of where it started", pinch.scale!.value, 200 / 120, 0.001)
    near("focal x", pinch.focalX!.value, 160)
    f.up(id: 1)
    f.up(id: 0)
    check("pinch end", lastEvent(1040, "end")?["cancelled"] as? Bool, false)
    sent = []
}

do {  // one finger on a pinch: a scroll around it may take the touch once the finger passed the slop (Android: the
    // scroll's own slop); before that a second finger may still land and the pinch takes the touch
    let g = gesture(1048, #"{"kind":"pinch","values":{"scale":1049}}"#)
    let f = Finger(g)
    f.down(0, 0)
    check("one finger, still: may claim", f.s.mayClaim(fingers: 1), true)
    f.move(5, 0)
    check("one finger, 5 pt: may claim", f.s.mayClaim(fingers: 1), true)
    f.move(5, 0)
    check("one finger past the slop: the scroll may go", f.s.mayClaim(fingers: 1), false)
    f.up()
    let h = Finger(g)
    h.down(100, 100, id: 0)
    h.move(3, 2)
    h.down(200, 100, id: 1)
    check("the second finger lands before the slop", h.s.mayClaim(fingers: 2), true)
    h.move2((100, 100), (240, 100))
    check("the pinch takes it", g.live, znActive)
    truth("and claims", h.s.claims)
    h.up(id: 1)
    h.up(id: 0)
    check("no fingers: none", h.s.mayClaim(fingers: 0), false)
    sent = []
}

do {  // rotation: the angle's sign follows the fingers (clockwise on screen is positive, y down)
    let g = gesture(1050, #"{"kind":"rotate","values":{"angle":1051}}"#)
    let f = Finger(g)
    f.down(100, 100, id: 0)
    f.down(200, 100, id: 1)
    f.move2((100, 100), (200, 110))
    f.move2((100, 100), (200, 200))
    check("active", g.live, znActive)
    near("45° clockwise", g.angle!.value, 45, 0.01)
    f.up(id: 1)
    f.up(id: 0)
    sent = []
}

do {  // long press: held 0 → 1 over minDuration, then start; moving first fails it
    haptics = []
    let g = gesture(1060, #"{"kind":"longPress","minDuration":400,"values":{"pressed":1061,"held":1062},"ev":["begin","start","end"]}"#)
    let f = Finger(g)
    f.down(0, 0)
    clock.run(12)  // 200 ms
    near("held halfway", g.held!.value, 0.5, 0.05)
    f.wait(400)
    check("started (begin twice, as Android: the touch and the long press)", events(1060), ["begin", "begin", "start"])
    check("the heavy haptic", haptics, ["heavy"])
    f.up()
    check("end", events(1060), ["end"])
    let m = Finger(g)
    m.down(0, 0)
    m.move(20, 0)
    m.wait(400)
    check("moved: no start", events(1060), ["begin", "begin"])
    m.up()
}

do {  // fling: fast enough and in a wanted direction
    let g = gesture(1070, #"{"kind":"fling","directions":["left"],"ev":["end"]}"#)
    let f = Finger(g)
    f.down(200, 0)
    f.move(-200, 0, steps: 10)
    f.up(after: 8)
    check("left", lastEvent(1070, "end")?["direction"] as? String, "left")
    sent = []
    let r = Finger(g)
    r.down(0, 0)
    r.move(200, 0, steps: 10)
    r.up(after: 8)
    check("right isn't wanted", events(1070), [])
    let slow = Finger(g)
    slow.down(200, 0)
    slow.move(-30, 0, steps: 10)
    slow.up(after: 8)
    check("too slow", events(1070), [])
}

// MARK: - Links between elements

do {  // requireToFail: a pan waits while the other element's tap is possible, goes when it fails
    let tap = gesture(1100, #"{"kind":"tap","taps":2}"#)
    let pan = gesture(1101, #"{"kind":"pan","values":{"x":1102,"y":1103},"fails":[1100],"ev":["start"]}"#)
    let t = Finger(tap)
    t.down(0, 0)
    let p = Finger(pan)
    p.down(0, 0)
    p.move(30, 0)
    check("waits for the tap", pan.live, znPossible)
    check("it polls each frame", p.s.wakeAt(p.t), p.t + 16)
    t.move(30, 0)  // the tap fails (moved)
    p.wait(16)
    check("then goes", pan.live, znActive)
    t.up()
    p.up()
    sent = []
}

do {  // manualActivation: starts only when JS says
    let g = gesture(1110, #"{"kind":"pan","values":{"x":1111,"y":1112},"manual":true,"ev":["start"]}"#)
    let f = Finger(g)
    f.down(0, 0)
    f.move(40, 0)
    check("its own conditions don't start it", g.live, znPossible)
    ZnGestures.setState(["id": 1110, "s": "activate"])
    f.wait(16)
    check("JS activated it", g.live, znActive)
    f.up()
    let h = Finger(g)
    h.down(0, 0)
    ZnGestures.setState(["id": 1110, "s": "fail"])
    h.wait(16)
    truth("JS failed it", h.s.over)
    sent = []
}

do {  // simultaneousWith: a linked gesture on another element doesn't take the touch from this one
    let a = gesture(1120, #"{"kind":"pan","values":{"x":1121,"y":1122},"with":[1123]}"#)
    let b = gesture(1123, #"{"kind":"pan","values":{"x":1124,"y":1125}}"#)
    let fa = Finger(a), fb = Finger(b)
    fa.down(0, 0)
    fb.down(0, 0)
    fb.move(20, 0)
    fa.move(20, 0, consumed: true)
    check("b active", b.live, znActive)
    check("a too, though b used the event", a.live, znActive)
    truth("a doesn't claim it from b", !fa.s.claims)
    fa.up()
    fb.up()
    sent = []
}

// MARK: - useZoom (ZnZoom.swift; the maths: android/runtime's ZnZoomTest.kt, the same numbers)

do {  // fittedIsContain
    let a = ZnZoomMath.fitted(300, 300, 4 / 3), b = ZnZoomMath.fitted(300, 300, 0.5)
    near("4:3 w", a.0, 300); near("4:3 h", a.1, 225)
    near("1:2 w", b.0, 150); near("1:2 h", b.1, 300)
    near("no aspect", ZnZoomMath.fitted(300, 300, 0).1, 300)
    near("NaN aspect", ZnZoomMath.fitted(300, 300, .nan).0, 300)
}

do {  // rangeIsHalfTheOverflow
    near("1x", ZnZoomMath.range(300, 1, 300), 0)
    near("2x", ZnZoomMath.range(300, 2, 300), 150)
    near("smaller than the box", ZnZoomMath.range(100, 2, 300), 0)
}

do {  // theSpotUnderTheFingersStays
    let t = ZnZoomMath.around(1, 0, 250, 150, 2)
    near("around 250 to 2x", t, -100, 0.001)
    near("drawn where it was", 150 + (250 - 150) * 2 + t, 250, 0.001)
    let p: Float = 150 + (100 - 150 - (-100)) / 2
    let t3 = ZnZoomMath.around(2, -100, 100, 150, 3)
    near("2x to 3x around 100", 150 + (p - 150) * 3 + t3, 100, 0.001)
}

do {  // doubleTapZoomsInThereThenOut
    let a = ZnZoomMath.doubleTap(1, 0, 0, 250, 150, 300, 300, 300, 300, 1, 2.5)
    near("in: 2.5x", a.0, 2.5); near("in: tx", a.1, -150, 0.001); near("in: ty", a.2, 0, 0.001)
    near("at the edge: clamped", ZnZoomMath.doubleTap(1, 0, 0, 300, 150, 300, 300, 300, 300, 1, 2.5).1, -225, 0.001)
    let out = ZnZoomMath.doubleTap(2.5, -150, 0, 10, 10, 300, 300, 300, 300, 1, 2.5)
    truth("zoomed in: back out", out.0 == 1 && out.1 == 0 && out.2 == 0)
}

do {  // rubberBandsGiveLessThanTheFinger
    let past = ZnZoomMath.rubberT(260, 150, 300)
    truth("t past the edge gives less", past > 150 && past < 260)
    near("t inside", ZnZoomMath.rubberT(100, 150, 300), 100)
    let under = ZnZoomMath.rubberS(0.5, 1, 4), over = ZnZoomMath.rubberS(6, 1, 4)
    truth("scale under", under < 1 && under > 0.5)
    truth("scale over", over > 4 && over < 6)
}

do {  // toBoxUndoesTheLayer
    near("toBox", ZnZoomMath.toBox(200, 150, 2, -100), 150)
}

/// A zoom on a 300 x 300 element (the content fills it).
func zoom(_ id: Int, _ extra: String = "") -> ZnGesture {
    let g = gesture(id, #"{"kind":"zoom","values":{"scale":\#(id + 1),"scale.v":1,"x":\#(id + 2),"y":\#(id + 3)},"min":1,"max":4,"ev":["begin","start","end","finalize","settle"]\#(extra)}"#)
    g.placed(300, 300, 400, 800)
    return g
}

do {  // not zoomed, one finger: the zoom gives the touch up at the slop (the Carousel turns the page)
    let g = zoom(1300)
    let f = Finger(g)
    f.down(150, 150)
    f.move(5, 0)
    check("still possible under the slop", g.live, znPossible)
    truth("the scroll waits for it", f.s.mayClaim(fingers: 1))
    f.move(20, 0)
    check("failed past the slop", g.live, znFailed)
    truth("no claim", !f.s.claims)
    f.up()
    sent = []
}

do {  // a pinch scales around the fingers; zoomed, one finger drags inside the edges; at the edge it gives up
    let g = zoom(1310)
    let f = Finger(g)
    f.down(220, 150, id: 0)
    f.down(280, 150, id: 1)
    f.move2((200, 150), (300, 150))
    check("pinch started", g.live, znActive)
    truth("it takes the touch", f.s.claims)
    f.move2((150, 150), (350, 150))  // spread 100 → 200 around x = 250
    near("2x", g.scale!.value, 2, 0.001)
    near("the spot under the fingers stays", g.x!.value, -100, 0.001)
    near("y", g.y!.value, 0, 0.001)
    _ = events(1310)
    f.up(id: 1)
    f.up(id: 0)
    check("lift: end, finalize, settle", events(1310), ["end", "finalize", "settle"])
    // Zoomed: one finger drags it (inside ±150).
    let d = Finger(g)
    d.down(150, 150)
    d.move(30, 0, steps: 3)
    check("drag started", g.live, znActive)
    d.move(30, 0)
    near("x follows the finger (from the move after the one that started it)", g.x!.value, -50, 0.001)
    d.up(after: 400)  // held still, then lifted: no fling
    clock.run(60)
    near("rests where it was let go", g.x!.value, -50, 0.001)
    // At the right edge, dragging right: the parent's turn.
    g.x!.value = 150
    let edge = Finger(g)
    edge.down(150, 150)
    edge.move(20, 0)
    check("at the edge it fails", g.live, znFailed)
    edge.up()
    sent = []
}

do {  // past max: back to max at the lift; a fling stops at the edge
    let g = zoom(1320)
    let f = Finger(g)
    f.down(140, 150, id: 0)
    f.down(160, 150, id: 1)
    f.move2((130, 150), (170, 150))
    f.move2((50, 150), (250, 150))  // 40 → 200: 5x, past max 4
    truth("rubber past max", g.scale!.value > 4 && g.scale!.value < 5)
    f.up(id: 1)
    f.up(id: 0)
    clock.run(60)
    near("back to max", g.scale!.value, 4, 0.001)
    truth("inside the edges", abs(g.x!.value) <= ZnZoomMath.range(300, 4, 300) + 0.001)
    sent = []
    g.x!.value = 0
    let fl = Finger(g)
    fl.down(150, 150)
    fl.move(-30, 0, steps: 2)
    fl.move(-90, 0, steps: 3)
    fl.up(after: 16, by: (-30, 0))
    clock.run(240)
    near("a fling stops at the edge", g.x!.value, -450, 0.01)
    truth("settle after the fling", events(1320).contains("settle"))
}

do {  // useZoom's double tap (a tap gesture with `zoom`): in around the tapped spot, then out; no JS in between
    let z = zoom(1330)
    _ = gesture(1335, #"{"kind":"tap","values":{},"taps":2,"zoom":1330}"#)
    let both = group(1336, "simultaneous", [1330, 1335])
    both.placed(300, 300, 400, 800)
    let f = Finger(both)
    f.down(250, 150)
    f.up(after: 60)
    f.down(250, 150, after: 100)
    f.up(after: 60)
    clock.run(30)
    near("in to 2.5x", z.scale!.value, 2.5, 0.001)
    near("around the tap, inside the edge", z.x!.value, -150, 0.001)
    check("end and settle (no finger lift of its own)", events(1330).filter { $0 == "end" || $0 == "settle" }, ["end", "settle"])
    let g2 = Finger(both)
    g2.down(10, 10)
    g2.up(after: 60)
    g2.down(10, 10, after: 100)
    g2.up(after: 60)
    clock.run(30)
    near("out to 1x", z.scale!.value, 1, 0.001)
    near("centred", z.x!.value, 0, 0.001)
    sent = []
}

do {  // a finger right after a double tap, while the zoom is still on its way in: it drags the photo, at the goal
    let z = zoom(1350)
    _ = gesture(1355, #"{"kind":"tap","values":{},"taps":2,"zoom":1350}"#)
    let both = group(1356, "simultaneous", [1350, 1355])
    both.placed(300, 300, 400, 800)
    let f = Finger(both)
    f.down(150, 150)
    f.up(after: 60)
    f.down(150, 150, after: 100)
    f.up(after: 60)
    clock.run(2)
    truth("still on its way in (scale drawn near 1)", z.scale!.value < 1.5 && z.zoomGoal != nil)
    let d = Finger(both)
    d.down(150, 150, after: 1)
    d.move(-20, 0)
    check("past the slop mid-zoom: it takes the touch (by the goal, 2.5x)", z.live, znActive)
    truth("and claims it before the Carousel's pan", d.s.claims)
    truth("the tween ended", z.zoomGoal == nil)
    near("at the goal's scale", z.scale!.value, 2.5, 0.001)
    d.move(-20, 0)
    near("the finger drags it from the goal", z.x!.value, -20, 0.001)
    d.up(after: 400)
    clock.run(60)
    // Zooming back out: a finger then decides by the goal (1x): the parent's.
    let out = Finger(both)
    out.down(150, 150, after: 1000)
    out.up(after: 60)
    out.down(150, 150, after: 100)
    out.up(after: 60)
    clock.run(2)
    truth("on its way out", z.scale!.value > 1.5)
    let p = Finger(both)
    p.down(150, 150, after: 1)
    p.move(-20, 0)
    check("going to 1x: the parent's", z.live, znFailed)
    p.up()
    clock.run(30)
    // VoiceOver's zoom in / out say so in their end.
    _ = events(1350)
    sent = []
    z.zoomInAtCentre()
    clock.run(30)
    truth("zoom in's end says accessibility", lastEvent(1350, "end")?["accessibility"] as? Bool == true)
    sent = []
    z.zoomOutForA11y()
    clock.run(30)
    near("zoomed out", z.scale!.value, 1, 0.001)
    truth("zoom out's end says accessibility", lastEvent(1350, "end")?["accessibility"] as? Bool == true)
    sent = []
    try! ZnGestures.zoomTo(["id": 1350, "s": 2]) { _ in }
    clock.run(30)
    truth("zoomTo's end doesn't", lastEvent(1350, "end")?["accessibility"] == nil)
    sent = []
}

do {  // zoomTo (and reset): clamped scale and edges, {finished}; fingers on a transformed node map to its box
    let z = zoom(1340)
    var got: [String: Any]?
    try! ZnGestures.zoomTo(["id": 1340, "s": 9, "x": 300, "y": 150]) { got = $0 }
    clock.run(30)
    near("clamped to max", z.scale!.value, 4, 0.001)
    near("inside the edge", z.x!.value, -450, 0.001)
    check("finished", got?["finished"] as? Bool, true)
    try! ZnGestures.zoomTo(["id": 1340, "s": 1]) { got = $0 }
    clock.run(30)
    near("reset", z.scale!.value, 1, 0.001)
    truth("not a zoom throws", (try? ZnGestures.zoomTo(["id": 1310_000]) { _ in }) == nil)
    z.layerNow = { (2, 2, -100, 0) }
    let (bx, by) = z.zoomBox(200, 150)
    near("box x", bx, 150); near("box y", by, 150)
    z.layerNow = { nil }  // its screen's instance has gone
    let (gx, _) = z.zoomBox(200, 150)
    near("no layer: the point as it is", gx, 200)
    sent = []
}

// MARK: - Sheet progress (ZnSheetMath, ZnSheet.swift)

do {
    near("closed: at its rest bottom", ZnSheetMath.progress(top: 800, restBottom: 800, tallest: 600), 0)
    near("half way up", ZnSheetMath.progress(top: 500, restBottom: 800, tallest: 600), 0.5)
    near("at the tallest detent", ZnSheetMath.progress(top: 200, restBottom: 800, tallest: 600), 1)
    near("pulled past it: 1", ZnSheetMath.progress(top: 100, restBottom: 800, tallest: 600), 1)
    near("slid below its rest: 0", ZnSheetMath.progress(top: 900, restBottom: 800, tallest: 600), 0)
    near("no detent yet: 0", ZnSheetMath.progress(top: 100, restBottom: 800, tallest: 0), 0)
}

// MARK: - Groups and disposal

do {
    truth("unknown kind throws", (try? ZnGestures.make(["id": 1200, "kind": "swipe"])) == nil)
    truth("an empty group throws", (try? ZnGestures.makeGroup(["id": 1201, "of": []])) == nil)
    truth("a missing member throws", (try? ZnGestures.makeGroup(["id": 1202, "of": [99999]])) == nil)
    let g = gesture(1210, #"{"kind":"pan","values":{"x":1211,"y":1212}}"#)
    let f = Finger(g)
    f.down(0, 0)
    ZnGestures.dispose(1210)
    truth("disposed: the touch ends", f.s.over)
    truth("its values go", e.find(1211) == nil)
    truth("it is gone", ZnGestures.find(1210) == nil)
}

print("gestures: \(count) checks, \(failures) failed")
exit(failures == 0 ? 0 : 1)
