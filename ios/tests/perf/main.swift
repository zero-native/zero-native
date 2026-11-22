// The Performance plugin's rules with no Firebase in them, on the Mac: tools/ios-unit-test.ts builds this with
// plugins/firebase-perf/ios/PerfRules.swift (sources.txt). The cases follow android's PerfRulesTest.kt; frames are in
// seconds here (a CADisplayLink's gaps), with Firebase iOS's slow line.
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

// Frames: slow under 59 a second, frozen past 700 ms (frozen isn't also slow, as on Android).
check("120 Hz", PerfRules.frameKind(1.0 / 120), .ok)
check("60 Hz", PerfRules.frameKind(1.0 / 60), .ok)
check("12 ms", PerfRules.frameKind(0.012), .ok)
check("17 ms", PerfRules.frameKind(0.017), .slow)
check("a missed 60 Hz frame", PerfRules.frameKind(2.0 / 60), .slow)
check("700 ms", PerfRules.frameKind(0.7), .slow)
check("701 ms", PerfRules.frameKind(0.701), .frozen)

// Trace names and attribute names follow Firebase's rules.
check("good name", PerfRules.nameProblem("checkout_load"), nil)
check("empty", PerfRules.nameProblem("") != nil, true)
check("leading _", PerfRules.nameProblem("_app_start") != nil, true)
check("leading space", PerfRules.nameProblem(" pay") != nil, true)
check("trailing space", PerfRules.nameProblem("pay ") != nil, true)
check("101 characters", PerfRules.nameProblem(String(repeating: "x", count: 101)) != nil, true)
check("100 characters", PerfRules.nameProblem(String(repeating: "x", count: 100)), nil)
check("good attribute", PerfRules.attributeProblem("plan"), nil)
check("digit first", PerfRules.attributeProblem("1plan") != nil, true)
check("firebase_", PerfRules.attributeProblem("firebase_x") != nil, true)
check("google_", PerfRules.attributeProblem("google_x") != nil, true)
check("ga_", PerfRules.attributeProblem("ga_x") != nil, true)
check("41 characters", PerfRules.attributeProblem("a" + String(repeating: "b", count: 40)) != nil, true)
check("40 characters", PerfRules.attributeProblem("a" + String(repeating: "b", count: 39)), nil)
check("dash", PerfRules.attributeProblem("a-b") != nil, true)
check("value cut to 100", PerfRules.attributeValue(String(repeating: "v", count: 150)).count, 100)
check("screen trace", PerfRules.screenTrace("home"), "screen_home")
check("screen trace cut", PerfRules.screenTrace(String(repeating: "r", count: 200)).count, 100)

// Metrics are whole numbers (Kotlin's toLong()).
check("cut toward zero", PerfRules.metricValue(2.9), 2)
check("negative toward zero", PerfRules.metricValue(-2.9), -2)
check("NaN", PerfRules.metricValue(.nan), 0)
check("too big", PerfRules.metricValue(1e30), Int64.max)
check("too small", PerfRules.metricValue(-.infinity), Int64.min)

// Firebase sees no query, no fragment and no user or password.
check("query and fragment", PerfRules.defaultUrl(URL(string: "https://api.example.com/v1/pay/123?token=abc&phone=9#x")!),
      "https://api.example.com/v1/pay/123")
check("user and password", PerfRules.defaultUrl(URL(string: "https://me:secret@api.example.com/a")!), "https://api.example.com/a")
check("port kept", PerfRules.defaultUrl(URL(string: "http://127.0.0.1:8080/x?y=1")!), "http://127.0.0.1:8080/x")

print(failures == 0 ? "ios perf rules: \(count) checks passed" : "ios perf rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
