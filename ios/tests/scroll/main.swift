// A <Scroll>'s plain rules (ZnScrollSnap.swift, ZnScrollCommand.swift), on the Mac: tools/ios-unit-test.ts builds this
// with sources.txt. The cases follow android/runtime's ZnScrollExtras.kt (ZnSnap.pick and parse, ZnScrollWants,
// znSendScroll, ZnScrollCommands) and ZnKeyboardScroll.kt, worked out by hand from the Kotlin (dp = pt, d = 1).
import Foundation

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

func snap(_ text: String) -> ZnSnap { ZnSnap.parse(text)! }

// Parsing the snap string (core scrollSnap).
let all = snap("p1;i80;a1;o0,120;s0;e0;m1;d0.99")
check("all: paging", all.paging, true)
check("all: interval", all.interval, 80)
check("all: align", all.align, 1)
check("all: offsets", all.offsets, [0, 120])
check("all: toStart", all.toStart, false)
check("all: toEnd", all.toEnd, false)
check("all: one at a time", all.oneAtATime, true)
check("all: deceleration", all.deceleration, 0.99)
check("no text", ZnSnap.parse(nil), nil)
check("empty text", ZnSnap.parse(""), nil)
check("defaults", snap("i10"), ZnSnap(paging: false, interval: 10, align: 0, offsets: [], toStart: true, toEnd: true,
                                       oneAtATime: false, deceleration: 0))
check("negative interval", snap("i-3").interval, 0)
check("bad offsets left out", snap("o1,x,3").offsets, [1, 3])
check("offsets sorted", snap("o3,1,2").offsets, [1, 2, 3])
check("deceleration 1.5", snap("d1.5").deceleration, 0)
check("deceleration 1", snap("d1").deceleration, 0)
check("deceleration 0", snap("d0").deceleration, 0)
check("align end", snap("a2").align, 2)
check("snaps: interval", snap("i80").snaps, true)
check("snaps: paging", snap("p1").snaps, true)
check("snaps: offsets", snap("o5").snaps, true)
check("snaps: deceleration only", snap("d0.99").snaps, false)

// decelerationRate: core's number is iOS's own; "normal" (0.998) when not written or not below it.
check("rate not written", ZnSnap.decelerationRate(nil), 0.998)
check("rate fast", ZnSnap.decelerationRate(snap("d0.99")), 0.99)
check("rate above normal", ZnSnap.decelerationRate(snap("d0.999")), 0.998)
check("rate with no d", ZnSnap.decelerationRate(snap("i80")), 0.998)

// pick: an interval of 80 in a 300 viewport, max 1000.
let i80 = snap("i80")
check("interval start: nearest", i80.pick(start: 0, projected: 130, velocity: 1000, viewport: 300, max: 1000), 160)
check("interval start: back", i80.pick(start: 0, projected: 110, velocity: 1000, viewport: 300, max: 1000), 80)
// center: shift (300 - 80) / 2 = 110, so the points are 50, 130, 210, ...
let center = snap("i80;a1")
check("interval center 130", center.pick(start: 0, projected: 130, velocity: 1000, viewport: 300, max: 1000), 130)
check("interval center 100", center.pick(start: 0, projected: 100, velocity: 1000, viewport: 300, max: 1000), 130)
check("interval center 85", center.pick(start: 0, projected: 85, velocity: 1000, viewport: 300, max: 1000), 50)
check("interval center 20 (snapToStart)", center.pick(start: 0, projected: 20, velocity: 100, viewport: 300, max: 1000), 0)
// end: shift 220, so the points are 20, 100, 180, ...
check("interval end", snap("i80;a2").pick(start: 0, projected: 100, velocity: 1000, viewport: 300, max: 1000), 100)
check("interval clamped to max", i80.pick(start: 900, projected: 1300, velocity: 3000, viewport: 300, max: 1000), 1000)
check("interval clamped to 0", i80.pick(start: 40, projected: -200, velocity: -3000, viewport: 300, max: 1000), 0)

// Paging: one page at a time, the viewport is the step; slow let-go: the nearest page.
let paging = snap("p1")
check("paging slow", paging.pick(start: 0, projected: 50, velocity: 300, viewport: 300, max: 900), 0)
check("paging slow past half", paging.pick(start: 0, projected: 200, velocity: 300, viewport: 300, max: 900), 300)
check("paging fast forward", paging.pick(start: 0, projected: 50, velocity: 500, viewport: 300, max: 900), 300)
check("paging fast back", paging.pick(start: 300, projected: 250, velocity: -500, viewport: 300, max: 900), 0)
check("paging long fling: one page", paging.pick(start: 0, projected: 2000, velocity: 3000, viewport: 300, max: 900), 300)
check("paging at the end", paging.pick(start: 900, projected: 1200, velocity: 3000, viewport: 300, max: 900), 900)
check("paging ignores align", snap("p1;a1").pick(start: 0, projected: 50, velocity: 500, viewport: 300, max: 900), 300)

// disableIntervalMomentum: one interval at a time.
check("m1 forward", snap("i100;m1").pick(start: 0, projected: 450, velocity: 2000, viewport: 300, max: 1000), 100)
check("m1 back", snap("i100;m1").pick(start: 500, projected: 100, velocity: -2000, viewport: 300, max: 1000), 400)

// Offsets (the scroll lab's sections), with snapToEnd off: free past the last one.
let sections = snap("o0,320,640,960,1280;e0")
check("offsets nearest", sections.pick(start: 0, projected: 500, velocity: 2000, viewport: 400, max: 1500), 640)
check("offsets back", sections.pick(start: 700, projected: 450, velocity: -900, viewport: 400, max: 1500), 320)
check("offsets past last, from last", sections.pick(start: 1280, projected: 1450, velocity: 900, viewport: 400, max: 1500), 1450)
check("offsets past last, clamped", sections.pick(start: 1300, projected: 1600, velocity: 900, viewport: 400, max: 1500), 1500)
check("offsets past last, from before", sections.pick(start: 1000, projected: 1450, velocity: 900, viewport: 400, max: 1500), 1280)
check("offsets snapToStart off", snap("o100,400;s0").pick(start: 50, projected: 20, velocity: -300, viewport: 400, max: 1000), 20)
check("offsets snapToStart on", snap("o100,400").pick(start: 50, projected: 20, velocity: -300, viewport: 400, max: 1000), 100)
check("offsets beyond max", snap("o0,2000").pick(start: 0, projected: 900, velocity: 900, viewport: 400, max: 1000), 1000)
check("no snap rules: clamped", snap("d0.99").pick(start: 0, projected: -50, velocity: -100, viewport: 400, max: 1000), 0)

// Events JS wants (the compiler's scrollEvents) and onScroll's throttle.
let w = ZnScrollWants.parse("t16;s;b;e;mb;me")!
check("wants all", w, ZnScrollWants(throttleMs: 16, scroll: true, beginDrag: true, endDrag: true, momentumBegin: true,
                                   momentumEnd: true))
check("throttle clamped", ZnScrollWants.parse("t99999;s")!.throttleMs, 10_000)
check("throttle negative", ZnScrollWants.parse("t-5;s")!.throttleMs, 0)
check("no throttle", ZnScrollWants.parse("s")!.throttleMs, 0)
check("bad throttle", ZnScrollWants.parse("tx;mb")!.throttleMs, 0)
check("momentum only", ZnScrollWants.parse("tx;mb")!.momentum, true)
check("momentum not scroll", ZnScrollWants.parse("tx;mb")!.scroll, false)
check("wants none", ZnScrollWants.parse(nil), nil)
check("wants any", ZnScrollWants.parse("b")!.any, true)
let t100 = ZnScrollWants.parse("t100;s")!
check("throttle wait", t100.wait(nowMs: 1000, lastSentMs: 950), 50)
check("throttle past", t100.wait(nowMs: 1000, lastSentMs: 800), 0)
check("no throttle wait", ZnScrollWants.parse("s")!.wait(nowMs: 1000, lastSentMs: 999), 0)

// The event JSON (znSendScroll): offsets and sizes along the axis; velocity only when not 0.
let v = ZnScrollMetrics(offset: 120.5, max: 1000, viewport: 400, cross: 361)
check("json vertical", v.json("s", horizontal: false),
      #"{"k":"s","x":0,"y":120.5,"cw":361,"ch":1400,"w":361,"h":400}"#)
check("json vertical momentum", v.json("mb", horizontal: false, velocity: 1800),
      #"{"k":"mb","x":0,"y":120.5,"cw":361,"ch":1400,"w":361,"h":400,"vx":0,"vy":1800}"#)
let h = ZnScrollMetrics(offset: 10, max: 1000, viewport: 400, cross: 120)
check("json horizontal", h.json("mb", horizontal: true, velocity: -250),
      #"{"k":"mb","x":10,"y":0,"cw":1400,"ch":120,"w":400,"h":120,"vx":-250,"vy":0}"#)
check("json not finite", ZnScrollMetrics(offset: .nan, max: 0, viewport: 0, cross: 0).json("e", horizontal: false),
      #"{"k":"e","x":0,"y":0,"cw":0,"ch":0,"w":0,"h":0}"#)

// A UIScrollView's numbers: the inset counts, a bounce reads as the edge.
check("bounce at top", ZnScrollMetrics.along(offset: -30, inset: 0, insetEnd: 0, content: 1000, viewport: 400, cross: 300).offset, 0)
check("bounce at end", ZnScrollMetrics.along(offset: 700, inset: 0, insetEnd: 0, content: 1000, viewport: 400, cross: 300).offset, 600)
let inset = ZnScrollMetrics.along(offset: 50, inset: 10, insetEnd: 20, content: 1000, viewport: 400, cross: 300)
check("inset offset", inset.offset, 60)
check("inset max", inset.max, 630)
check("short content", ZnScrollMetrics.along(offset: 0, inset: 0, insetEnd: 0, content: 100, viewport: 400, cross: 300).max, 0)

// <Scroll ref> commands: where each goes along the axis.
func target(_ text: String, horizontal: Bool = false, max: Double = 1000) -> Double? {
    ZnScrollCommand(text)?.scrollTarget(horizontal: horizontal, max: max)
}
check("to: y", target("to:5:1:640:3"), 640)
check("to: x when horizontal", target("to:5:1:640:3", horizontal: true), 5)
check("end", target("end:0:1:0:4"), 1000)
check("end of a short scroll", target("end:0:1:0:4", max: 0), 0)
check("offset below 0", target("offset:-20:0:0:5"), 0)
check("offset past the end", target("offset:5000:0:0:6"), 1000)
check("index: not a Scroll's", target("index:3:1:0:7"), nil)
check("other word", target("jump:3:1:0:7"), nil)
check("not finite", target("to:NaN:1:inf:8"), 0)
check("bad seq", ZnScrollCommand("to:1:1:1:x") == nil, true)
check("not animated", ZnScrollCommand("to:0:0:100:9")?.animated, false)
check("seq once", ZnScrollCommand("to:0:1:100:9")!.isNew(after: 9), false)

// keyboardDismissMode.
check("on-drag", ZnKeyboardDismiss.of("on-drag", vertical: true), .onDrag)
check("interactive vertical", ZnKeyboardDismiss.of("interactive", vertical: true), .interactive)
check("interactive horizontal", ZnKeyboardDismiss.of("interactive", vertical: false), .onDrag)
check("none", ZnKeyboardDismiss.of("none", vertical: true), .none)
check("not written", ZnKeyboardDismiss.of(nil, vertical: true), .none)

print(failures == 0 ? "ios scroll rules: \(count) checks passed" : "ios scroll rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
