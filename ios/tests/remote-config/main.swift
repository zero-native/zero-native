// The Remote Config plugin's rules with no Firebase in them, on the Mac: tools/ios-unit-test.ts builds this with
// plugins/firebase-remote-config/ios/RemoteConfigRules.swift (sources.txt). The cases follow android's
// RemoteConfigRulesTest.kt, plus what iOS adds: defaults as Android's text, iOS's enum numbers, its error domains.
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

// Defaults keep strings, numbers and booleans (as Android's text), leave nulls out; objects and arrays as JSON text.
do {
    let json = #"{"s":"x","i":3,"d":1.5,"b":true,"f":false,"n":null,"o":{"b":1,"a":"/"},"l":[1,"two"],"z":0,"neg":-2}"#
    let raw = try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    let d = RemoteConfigRules.defaults(raw)
    check("string", d["s"], "x")
    check("whole number", d["i"], "3")
    check("decimal", d["d"], "1.5")
    check("true, not 1", d["b"], "true")
    check("false, not 0", d["f"], "false")
    check("null left out", d["n"], nil)
    check("object as JSON", d["o"], #"{"a":"/","b":1}"#)
    check("array as JSON", d["l"], #"[1,"two"]"#)
    check("zero", d["z"], "0")
    check("negative", d["neg"], "-2")
    check("count", d.count, 9)
}
check("big whole number", RemoteConfigRules.number(1e15), "1000000000000000")
check("small decimal", RemoteConfigRules.number(0.1), "0.1")
// As Android: JSON makes a whole number in Long's range a Long (JS's digits), anything else a Double (Java's text).
check("whole past 2^53, JS's digits", RemoteConfigRules.number(1152921504606846976), "1152921504606847000")
check("whole 9e15", RemoteConfigRules.number(9e15), "9000000000000000")
check("negative whole", RemoteConfigRules.number(-9e15), "-9000000000000000")
check("past Long", RemoteConfigRules.number(1e21), "1.0E21")
check("past Long, digits", RemoteConfigRules.number(1.5e19), "1.5E19")
check("decimal at 1e7", RemoteConfigRules.number(12345678.5), "1.23456785E7")
check("decimal under 1e7", RemoteConfigRules.number(1234567.5), "1234567.5")
check("0.001", RemoteConfigRules.number(0.001), "0.001")
check("under 0.001", RemoteConfigRules.number(0.0001), "1.0E-4")
check("tiny", RemoteConfigRules.number(-1.5e-7), "-1.5E-7")
check("negative decimal", RemoteConfigRules.number(-2.25), "-2.25")
check("minus zero", RemoteConfigRules.number(-0.0), "0")

// Sources, fetch status and seconds by iOS's Firebase numbers (RemoteConfigSource, RemoteConfigFetchStatus).
check("source remote", RemoteConfigRules.source(0), "remote")
check("source default", RemoteConfigRules.source(1), "default")
check("source static", RemoteConfigRules.source(2), "static")
check("never fetched", RemoteConfigRules.fetchStatus(0), "no_fetch_yet")
check("success", RemoteConfigRules.fetchStatus(1), "success")
check("failure", RemoteConfigRules.fetchStatus(2), "failure")
check("throttled", RemoteConfigRules.fetchStatus(3), "throttled")
check("12 hours", RemoteConfigRules.seconds(43_200_000), 43_200)
check("never below 0", RemoteConfigRules.seconds(-5), 0)
check("NaN", RemoteConfigRules.seconds(.nan), 0)
check("huge, no crash", RemoteConfigRules.seconds(1e30), Int64.max)
check("infinity, as Kotlin", RemoteConfigRules.seconds(.infinity), Int64.max)
check("minus infinity", RemoteConfigRules.seconds(-.infinity), 0)
check("fetch time far away, no crash", RemoteConfigRules.fetchMillis(Date(timeIntervalSince1970: 1e300)), Int64.max)

// Fetch failures by kind.
check("no error", RemoteConfigRules.reason(nil), "failed")
check("other", RemoteConfigRules.reason(NSError(domain: "x", code: 1)), "failed")
check("throttled error", RemoteConfigRules.reason(NSError(domain: RemoteConfigRules.errorDomain, code: 8002)), "throttled")
check("internal error", RemoteConfigRules.reason(NSError(domain: RemoteConfigRules.errorDomain, code: 8003)), "failed")
check("offline", RemoteConfigRules.reason(NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)), "no_network")
check("offline underneath", RemoteConfigRules.reason(NSError(domain: RemoteConfigRules.errorDomain, code: 8003,
    userInfo: [NSUnderlyingErrorKey: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)])), "no_network")
check("network in the text", RemoteConfigRules.reason(NSError(domain: RemoteConfigRules.errorDomain, code: 8001,
    userInfo: [NSLocalizedDescriptionKey: "The Network connection was lost"])), "no_network")

// Real-time errors by Android's names.
let ud = RemoteConfigRules.updateErrorDomain
check("stream", RemoteConfigRules.updateError(NSError(domain: ud, code: 8001)), "config_update_stream_error")
check("not fetched", RemoteConfigRules.updateError(NSError(domain: ud, code: 8002)), "config_update_not_fetched")
check("invalid", RemoteConfigRules.updateError(NSError(domain: ud, code: 8003)), "config_update_message_invalid")
check("unavailable", RemoteConfigRules.updateError(NSError(domain: ud, code: 8004)), "config_update_unavailable")
check("other domain", RemoteConfigRules.updateError(NSError(domain: "x", code: 8001)), "unknown")

// The answers JS reads (Android's result() and off()).
do {
    let off = RemoteConfigRules.off()
    check("off available", off["available"] as? Bool, false)
    check("off reason", off["reason"] as? String, "unavailable")
    check("off time", off["fetchTimeMillis"] as? Int, -1)
    check("off status", off["lastFetchStatus"] as? String, "no_fetch_yet")
    check("off values", (off["values"] as? [String: Any])?.count, 0)

    let r = RemoteConfigRules.result(ok: false, reason: "throttled", changed: false,
                                     values: ["greeting": ("hi", 0), "limit": ("50", 1)], lastFetchStatus: 3,
                                     fetchTime: Date(timeIntervalSince1970: 1_700_000_000.25))
    let values = r["values"] as? [String: [String: String]]
    check("value", values?["greeting"]?["value"], "hi")
    check("value source", values?["greeting"]?["source"], "remote")
    check("default source", values?["limit"]?["source"], "default")
    check("reason", r["reason"] as? String, "throttled")
    check("status", r["lastFetchStatus"] as? String, "throttled")
    check("time in ms", r["fetchTimeMillis"] as? Int64, 1_700_000_000_250)
    let ok = RemoteConfigRules.result(ok: true, reason: nil, changed: true, values: [:], lastFetchStatus: 1, fetchTime: nil)
    check("ok reason is null", ok["reason"] is NSNull, true)
    check("changed", ok["changed"] as? Bool, true)
    check("JSON-ready", JSONSerialization.isValidJSONObject(r), true)
}
check("never fetched is -1", RemoteConfigRules.fetchMillis(Date(timeIntervalSince1970: 0)), -1)
check("no date is -1", RemoteConfigRules.fetchMillis(nil), -1)

print(failures == 0 ? "ios remote config rules: \(count) checks passed" : "ios remote config rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
