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

    func up(id: Int = 0, after ms: Int64 = 16) {
        t += ms
        let p = fingers[id]!
        var cs = [change(id, p, p, false, true)]
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
    _ = events(966)
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

do {  // one finger on a pinch: a scroll around it may take the touch
    let g = gesture(1048, #"{"kind":"pinch","values":{"scale":1049}}"#)
    let f = Finger(g)
    f.down(0, 0)
    check("one finger", f.s.mayClaim(fingers: 1), false)
    f.up()
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
