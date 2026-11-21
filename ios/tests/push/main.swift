// The push and crash-report rules with no iOS in them, on the Mac: tools/ios-unit-test.ts builds this with
// ZnTaskRules.swift (ZnOnce, a task's answer-by time) and the Crashlytics plugin's CrashlyticsRules.swift (sources.txt).
// The Crashlytics cases follow android's CrashlyticsRulesTest.kt; the answer-by ones ZnBackground.kt (a queued task's
// time limit drops it).
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

// ZnOnce: iOS's fetchCompletionHandler, answered by the task, a cap and a late JS answer, runs once.
do {
    var calls: [String] = []
    let once = ZnOnce<String> { calls.append($0) }
    check("not done before", once.done, false)
    check("first call runs", once("task"), true)
    check("second call doesn't", once("cap"), false)
    check("third call doesn't", once("late"), false)
    check("only the first", calls, ["task"])
    check("done after", once.done, true)
}
do {
    // Many threads at once (the task's answer on main, a cap, FCM's thread): still one call
    let lock = NSLock()
    var calls = 0
    let once = ZnOnce<Int> { _ in lock.withLock { calls += 1 } }
    var ran = 0
    let ranLock = NSLock()
    DispatchQueue.concurrentPerform(iterations: 64) { i in
        if once(i) { ranLock.withLock { ran += 1 } }
    }
    check("one call from 64 threads", calls, 1)
    check("one of them says it ran", ran, 1)
}
do {
    // A tuple, as the plugin's (result, why)
    var got: [String] = []
    let once = ZnOnce<(Int, String)> { r in got.append("\(r.0) \(r.1)") }
    once((1, "JS ran it"))
    once((0, "no answer in time"))
    check("tuple once", got, ["1 JS ran it"])
}

// ZnDeadline: on time, and not at all once cancelled (a task answered before its answer-by time).
do {
    let t0 = DispatchTime.now()
    var firedAfterMs = -1
    var cancelledRan = false
    ZnDeadline.main(at: t0 + .milliseconds(300)) {
        firedAfterMs = Int((DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1_000_000)
    }
    let stopped = ZnDeadline.main(at: t0 + .milliseconds(200)) { cancelledRan = true }
    stopped.cancel()
    let limit = Date().addingTimeInterval(1.5)
    while firedAfterMs < 0 && Date() < limit { RunLoop.main.run(until: Date().addingTimeInterval(0.02)) }
    check("deadline fired", firedAfterMs >= 300, true)
    // A loaded CI Mac can be slow to run the loop; 1 s still catches asyncAfter-sized lateness on the real 25 s
    check("deadline on time (\(firedAfterMs) ms)", firedAfterMs < 1300, true)
    check("cancelled deadline doesn't run", cancelledRan, false)
}

// A task's answer-by time: running in JS → aborted; waiting → dropped; kept → answered now, and JS still runs it
// (one JS is already running goes on to its own limit: aborting it would lose the saved copy).
check("answer-by, running", ZnTaskRules.answerBy(queued: false, kept: false), .abort)
check("answer-by, running and kept", ZnTaskRules.answerBy(queued: false, kept: true), .answerAndKeep)
check("answer-by, waiting", ZnTaskRules.answerBy(queued: true, kept: false), .drop)
check("answer-by, waiting and kept", ZnTaskRules.answerBy(queued: true, kept: true), .answerAndKeep)

// Crashlytics: the bundle keys and the reasons (CrashlyticsRulesTest.kt).
check("bundle id", CrashlyticsRules.bundleId("sample_12@1a2b3c4d5e6f"), "sample_12")
check("bundle id, no sha", CrashlyticsRules.bundleId("sample_0"), "sample_0")
check("bundle id, empty", CrashlyticsRules.bundleId(""), "")
check("route log first", CrashlyticsRules.routeLog(nil, "home"), "nav: - -> home")
check("route log", CrashlyticsRules.routeLog("home", "pay"), "nav: home -> pay")
check("ota log", CrashlyticsRules.otaLog("error_rollback", "sample_3", "error screen"), "ota: error_rollback sample_3: error screen")
check("ota log bare", CrashlyticsRules.otaLog("checked", nil, nil), "ota: checked")
check("ota reason", CrashlyticsRules.otaReason("watchdog_block", "sample_3", "2 crashes"), "OTA watchdog_block sample_3: 2 crashes")
check("ota reason bare", CrashlyticsRules.otaReason("apply_failed", nil, nil), "OTA apply_failed")
check("js reason", CrashlyticsRules.jsReason("sample_12@1a2b3c4d5e6f", "uncaught", "onPress", "TypeError: x"),
      "[sample_12@1a2b3c4d5e6f] uncaught in onPress: TypeError: x")
check("js reason, no bundle chosen", CrashlyticsRules.jsReason(nil, "task", "push.message", "Error: y"),
      "[built-in] task in push.message: Error: y")
check("details keep a Hermes stack", CrashlyticsRules.details("TypeError", "boom", "TypeError: boom\n    at f (main.js:1:2)"),
      "TypeError: boom\n    at f (main.js:1:2)")
check("details name first", CrashlyticsRules.details("TypeError", "boom", nil), "TypeError: boom")

print(failures == 0 ? "ios push rules: \(count) checks passed" : "ios push rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
