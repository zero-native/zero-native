// Impressions' rules on the Mac (tools/ios-unit-test.ts builds this with ZnImpressionsCore.swift), on a fake clock: the
// cases of Android's ZnImpressions.kt (threshold 0.35 clamped to 0.01...1, minMs, only on the top screen while in
// front, once per visit, 500 ms batches, a flush when going to the back, release, reset for a reload).
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

/// A fake clock and timer list, the top screen, and what went to JS.
final class World {
    var now = 0.0
    var top: UInt32 = 1
    var timers: [(at: Double, f: () -> Void)] = []
    var sent: [(UInt32, [String])] = []
    lazy var core = ZnImpressionsCore(
        now: { [unowned self] in now },
        isTop: { [unowned self] in $0 == top },
        schedule: { [unowned self] ms, f in timers.append((now + ms, f)) },
        emit: { [unowned self] e, keys in sent.append((e, keys)) })

    /// Moves the clock on, running the timers that are due, in order.
    func advance(_ ms: Double) {
        let end = now + ms
        while let i = timers.indices.filter({ timers[$0].at <= end }).min(by: { timers[$0].at < timers[$1].at }) {
            let t = timers.remove(at: i)
            now = t.at
            t.f()
        }
        now = end
    }

    var keys: [String] { sent.flatMap(\.1) }
}

// The default threshold is 0.35: 0.34 doesn't count, 0.35 does; nothing goes before the 500 ms batch.
do {
    let w = World()
    w.core.configure(1, "{}")
    check("tracking", w.core.tracking(1), true)
    check("not tracking another", w.core.tracking(2), false)
    w.core.report(1, "a", 0.34)
    w.core.report(1, "b", 0.35)
    check("b counted", w.core.done(1, "b"), true)
    check("a not counted", w.core.done(1, "a"), false)
    w.advance(499)
    check("nothing before 500 ms", w.sent.count, 0)
    w.advance(1)
    check("batch at 500 ms", w.keys, ["b"])
    check("batch entry", w.sent.first?.0, 1)
    // Once per visit: b again counts nothing.
    w.core.report(1, "b", 1)
    w.advance(1000)
    check("once per visit", w.keys, ["b"])
    // A screen that doesn't track: done (nothing to measure).
    check("untracked is done", w.core.done(9, "x"), true)
}

// threshold and minMs from JSON, clamped as Android: 0 → 0.01, 5 → 1, a negative minMs → 0.
do {
    let w = World()
    w.core.configure(1, "{\"threshold\":0}")
    w.core.report(1, "tiny", 0.01)
    check("threshold 0 is 0.01", w.core.done(1, "tiny"), true)
    w.core.configure(1, "{\"threshold\":5}")
    w.core.report(1, "almost", 0.999)
    check("threshold 5 is 1", w.core.done(1, "almost"), false)
    w.core.report(1, "all", 1)
    check("threshold 1, all visible", w.core.done(1, "all"), true)
    w.core.configure(1, "{\"threshold\":0.5,\"minMs\":-3}")
    w.core.report(1, "now", 0.5)
    check("negative minMs counts at once", w.core.done(1, "now"), true)
    w.core.configure(1, "not json")
    w.core.report(1, "d", 0.35)
    check("bad JSON: the defaults", w.core.done(1, "d"), true)
    // A second configure (the screen built again) starts the counts again.
    w.core.configure(1, "{}")
    check("configure again forgets", w.core.done(1, "d"), false)
}

// minMs: visible that long, with no move in between (the timer looks again); leaving resets the wait.
do {
    let w = World()
    w.core.configure(1, "{\"minMs\":1000}")
    w.core.report(1, "a", 0.8)
    w.advance(999)
    check("not before minMs", w.core.done(1, "a"), false)
    w.advance(1)
    check("at minMs, no move", w.core.done(1, "a"), true)
    w.core.report(1, "b", 0.8)
    w.advance(600)
    w.core.report(1, "b", 0.1)  // scrolled away
    w.advance(500)
    w.core.report(1, "b", 0.9)  // back: the wait starts again
    w.advance(900)
    check("left in between: waits again", w.core.done(1, "b"), false)
    w.advance(100)
    check("then counts", w.core.done(1, "b"), true)
    w.advance(500)
    check("both sent", w.keys.sorted(), ["a", "b"])
}

// Only on the top screen: a screen below counts nothing; when it is on top again, what is visible counts.
do {
    let w = World()
    w.core.configure(1, "{}")
    w.top = 2
    w.core.report(1, "a", 1)
    check("not on top", w.core.done(1, "a"), false)
    w.top = 1
    w.core.refresh()
    check("on top again: counts", w.core.done(1, "a"), true)
    // A key that left (0) before the screen came back doesn't count.
    w.top = 2
    w.core.report(1, "b", 1)
    w.core.report(1, "b", 0)
    w.top = 1
    w.core.refresh()
    check("left before coming back", w.core.done(1, "b"), false)
}

// In front only: nothing counts in the back; going to the back sends what was counted at once; back in front, what is
// visible counts.
do {
    let w = World()
    w.core.configure(1, "{}")
    w.core.report(1, "a", 1)
    w.core.resumed = false
    check("flushed when going", w.keys, ["a"])
    w.core.report(1, "b", 1)
    check("nothing in the back", w.core.done(1, "b"), false)
    w.core.resumed = true
    check("back in front: counts", w.core.done(1, "b"), true)
    w.advance(500)
    check("then sent", w.keys, ["a", "b"])
}

// minMs waits only while active: going to the back stops the wait.
do {
    let w = World()
    w.core.configure(1, "{\"minMs\":300}")
    w.core.report(1, "a", 1)
    w.advance(100)
    w.core.resumed = false
    w.advance(500)
    check("went to the back while waiting", w.core.done(1, "a"), false)
    w.core.resumed = true
    w.advance(300)
    check("waits again in front", w.core.done(1, "a"), true)
}

// Release sends what the screen counted and forgets it; resetForReload drops everything unsent.
do {
    let w = World()
    w.core.configure(1, "{}")
    w.core.configure(2, "{}")
    w.core.report(1, "a", 1)
    w.top = 2
    w.core.report(2, "x", 1)
    w.core.release(2)
    check("release flushes every screen, in order", w.sent.map(\.0), [1, 2])
    check("released: not tracking", w.core.tracking(2), false)
    w.core.report(2, "y", 1)
    w.advance(1000)
    check("a released screen sends nothing", w.keys, ["a", "x"])
    w.top = 1
    w.core.report(1, "c", 1)
    w.core.resetForReload()
    w.advance(1000)
    check("reset drops unsent keys", w.keys, ["a", "x"])
    check("reset: not tracking", w.core.tracking(1), false)
}

// Many keys in one batch keep the order they counted in.
do {
    let w = World()
    w.top = 7
    w.core.configure(7, "{\"threshold\":0.5}")
    for k in ["k1", "k2", "k3"] { w.core.report(7, k, 0.6) }
    w.advance(500)
    check("one batch, in order", w.sent.count, 1)
    check("keys in order", w.keys, ["k1", "k2", "k3"])
}

print(failures == 0 ? "ios impressions rules: \(count) checks passed" : "ios impressions rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
