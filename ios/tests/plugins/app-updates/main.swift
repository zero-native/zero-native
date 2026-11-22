// The app-updates plugin's iOS rules on the Mac (plugins/app-updates/ios/AppUpdatesRules.swift): versions as the App
// Store's dotted numbers, the iOS a build needs, staleness, the lookup's URL and answer, isUpdateAvailable's shape
// (android's AppUpdatesPlugin.kt keys plus storeVersion and appStoreId), the cache, and the sheet's state rules
// (android's AppUpdatesRules.result / resume: a closed forced sheet opens again on the next return, not while busy).
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

typealias R = AppUpdatesRules

// Versions: number by number, a missing part is 0
check("1.6.10 > 1.6.9", R.newer("1.6.10", than: "1.6.9"), true)
check("1.6.9 < 1.6.10", R.newer("1.6.9", than: "1.6.10"), false)
check("1.6 == 1.6.0", R.compare("1.6", "1.6.0"), 0)
check("1.6.0 == 1.6", R.compare("1.6.0", "1.6"), 0)
check("same is not newer", R.newer("1.6.2", than: "1.6.2"), false)
check("2 > 1.9.9", R.newer("2", than: "1.9.9"), true)
check("1.10 > 1.9", R.newer("1.10", than: "1.9"), true)
check("0.1 < 1.6.2", R.newer("1.6.2", than: "0.1"), true)
check("leading digits", R.parts("2b3.4"), [2, 4])
check("junk part is 0", R.parts("1.x.3"), [1, 0, 3])
check("spaces", R.compare(" 1.2 ", "1.2"), 0)
check("empty", R.parts(""), [0])

// The iOS the store's build needs
check("os ok", R.osAllows("17.0", system: "17.0.0"), true)
check("os newer", R.osAllows("17.0", system: "18.2.1"), true)
check("os too old", R.osAllows("18.1", system: "17.5.1"), false)
check("no minimum", R.osAllows(nil, system: "17.0.0"), true)
check("empty minimum", R.osAllows(" ", system: "17.0.0"), true)

// Staleness: whole days since the release
do {
    let at = ISO8601DateFormatter().date(from: "2026-11-17T07:14:34Z")!
    check("same day", R.stalenessDays("2026-11-17T07:14:34Z", now: at.addingTimeInterval(3600)), 0)
    check("five days", R.stalenessDays("2026-11-17T07:14:34Z", now: at.addingTimeInterval(5 * 86_400 + 60)), 5)
    check("future", R.stalenessDays("2026-11-17T07:14:34Z", now: at.addingTimeInterval(-86_400)), 0)
    check("bad date", R.stalenessDays("yesterday", now: at), nil)
    check("no date", R.stalenessDays(nil, now: at), nil)
}

// The storefront and the lookup URL
check("region", R.country("IN"), "in")
check("no region", R.country(nil), "us")
check("number region", R.country("419"), "us")
check("by bundle", R.lookupURL(bundleId: "dev.zeronative.sample", appStoreId: nil, country: "in", minute: 7)?.absoluteString,
      "https://itunes.apple.com/lookup?bundleId=dev.zeronative.sample&country=in&_=7")
check("by id", R.lookupURL(bundleId: "dev.zeronative.sample", appStoreId: "123456789", country: "us", minute: 8)?.absoluteString,
      "https://itunes.apple.com/lookup?id=123456789&country=us&_=8")
check("bad id falls back to the bundle", R.lookupURL(bundleId: "a.b", appStoreId: "12&x=1", country: "us", minute: 1)?.absoluteString,
      "https://itunes.apple.com/lookup?bundleId=a.b&country=us&_=1")
check("bundle is escaped", R.lookupURL(bundleId: "a&b", appStoreId: nil, country: "us", minute: 1)?.absoluteString,
      "https://itunes.apple.com/lookup?bundleId=a%26b&country=us&_=1")
check("nothing to ask", R.lookupURL(bundleId: nil, appStoreId: nil, country: "us", minute: 1), nil)

// The lookup's answer
let sample = #"""
{"resultCount":1,"results":[{"trackId":6784262215,"version":"1.6.2","minimumOsVersion":"17.0",
"currentVersionReleaseDate":"2026-11-17T07:14:34Z","bundleId":"app.example"}]}
"""#
let info = R.StoreInfo(version: "1.6.2", trackId: 6_784_262_215, minimumOsVersion: "17.0", releaseDate: "2026-11-17T07:14:34Z")
check("parse", R.parse(Data(sample.utf8)), info)
check("no result", R.parse(Data(#"{"resultCount":0,"results":[]}"#.utf8)), nil)
check("no version", R.parse(Data(#"{"results":[{"trackId":1}]}"#.utf8)), nil)
check("no track", R.parse(Data(#"{"results":[{"version":"1.0"}]}"#.utf8)), nil)
check("not json", R.parse(Data("<html>".utf8)), nil)

// isUpdateAvailable's answer
do {
    let now = ISO8601DateFormatter().date(from: "2026-11-20T08:00:00Z")!
    func answer(_ i: R.StoreInfo?, _ current: String, _ system: String = "17.5.1") -> String {
        let o = R.availability(i, current: current, system: system, now: now)
        return String(data: try! JSONSerialization.data(withJSONObject: o, options: [.sortedKeys]), encoding: .utf8)!
    }
    check("newer in the store", answer(info, "1.6.1"),
          #"{"appStoreId":"6784262215","available":true,"flexibleAllowed":true,"immediateAllowed":true,"stalenessDays":3,"storeVersion":"1.6.2","versionCode":0}"#)
    check("up to date", answer(info, "1.6.2"),
          #"{"appStoreId":"6784262215","available":false,"flexibleAllowed":false,"immediateAllowed":false,"storeVersion":"1.6.2","versionCode":0}"#)
    check("ahead of the store (a TestFlight build)", R.availability(info, current: "1.7", system: "17.5", now: now)["available"] as? Bool, false)
    check("this iOS is too old", R.availability(info, current: "1.0", system: "16.7", now: now)["available"] as? Bool, false)
    check("no answer", answer(nil, "1.0"), #"{"available":false,"versionCode":0}"#)
}

// The cache: an hour, and never from the future
do {
    let t = Date(timeIntervalSince1970: 1_000_000)
    check("fresh", R.fresh(savedAt: t, now: t.addingTimeInterval(3599)), true)
    check("stale", R.fresh(savedAt: t, now: t.addingTimeInterval(3600)), false)
    check("clock went back", R.fresh(savedAt: t, now: t.addingTimeInterval(-1)), false)
}

// The sheet: its close as Play's answers, and the forced one again on the next return
check("optional closed", R.closedStatus(flexible: true), "declined")
check("forced closed", R.closedStatus(flexible: false), "canceled")
check("reopen forced", R.reopen(forcedPending: true, busy: false, open: false), true)
check("not while busy", R.reopen(forcedPending: true, busy: true, open: false), false)
check("not while open", R.reopen(forcedPending: true, busy: false, open: true), false)
check("not optional", R.reopen(forcedPending: false, busy: false, open: false), false)

print(failures == 0 ? "ios app-updates rules: \(count) checks passed" : "ios app-updates rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
