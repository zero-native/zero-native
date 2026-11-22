// iOS OTA rules on the Mac (tools/ios-unit-test.ts builds this with ZnOtaRules.swift and ZnOtaInstall.swift, from
// sources.txt). The same cases as Android's JVM tests, so the two copies of the rules can't drift apart silently:
// ZnOtaHealthTest, ZnBundlesTest, ZnOtaStoreTest, ZnOtaSignatureTest, ZnOtaInstallTest (ZnBsPatch.swift too).
// The patch cases are ZnBsPatchTest, ZnOtaInstallPatchTest and ZnOtaPatchContractTest: Android's fixtures (made by
// tools/ota/bsdiff.ts), more shapes and a patch zip made by the server's own code (setup.ts).
// Arguments (args.txt): <ota-signature-fixture.json> <folder from setup.ts> <android ota-patch fixtures>
import Compression
import CryptoKit
import Foundation

var failures = 0
var count = 0
var current = ""

func test(_ name: String, _ body: () throws -> Void) {
    current = name
    count += 1
    do { try body() } catch { fail("threw \(error)") }
}

func fail(_ why: String, line: Int = #line) {
    failures += 1
    print("FAIL \(current) (line \(line)): \(why)")
}

func eq<T: Equatable>(_ a: T, _ b: T, _ what: String = "", line: Int = #line) {
    if a != b { fail("\(what) expected \(b), got \(a)", line: line) }
}

func yes(_ v: Bool, _ what: String = "", line: Int = #line) { if !v { fail("expected true: \(what)", line: line) } }
func no(_ v: Bool, _ what: String = "", line: Int = #line) { if v { fail("expected false: \(what)", line: line) } }

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: ota-tests <signature fixture> <zip fixture dir>"); exit(2) }

// MARK: Health (ZnOtaHealthTest.kt)

typealias H = ZnOtaHealthRules
let crash: (Int64, Int32) -> H.Exit = { _, _ in .counts("ended while on screen", sure: false) }
let sureCrash: (Int64, Int32) -> H.Exit = { _, _ in .counts("crash", sure: true) }
let stopped: (Int64, Int32) -> H.Exit = { _, _ in .ignored("exit reason 10") }
let nothingPending: (Int64, Int32) -> H.Exit = { _, _ in fail("nothing is pending"); return .ignored("") }
func fresh() -> H.State {
    let s = H.State()
    H.atStart(s, appVersion: "1", appUpdated: 100, now: 0, exit: nothingPending)
    return s
}
func launchThatDies(_ s: H.State, _ bundle: String, _ exit: (Int64, Int32) -> H.Exit, at: Int64 = 2_000) {
    H.launch(s, bundle, now: at - 1_000, pid: 4242)
    H.atStart(s, appVersion: "1", appUpdated: 100, now: at, exit: exit)
}
let hour: Int64 = 60 * 60 * 1000
func blocked(_ s: H.State) -> [String: String] { Dictionary(uniqueKeysWithValues: s.blocked) }

test("twoUnsureDeathsBlockTheBundle") {
    let s = fresh()
    launchThatDies(s, "app_5", crash)
    eq(s.crashTimes.count, 1)
    no(s.isBlocked("app_5"))
    launchThatDies(s, "app_5", crash)
    eq(blocked(s)["app_5"], H.watchdog)
    eq(s.crashTimes.count, 0)
    eq(s.events.map(\.kind), ["launch_crashed", "launch_crashed", "watchdog_block"])
}
test("thePendingLaunchIsJudgedByItsOwnProcess") {
    let s = fresh()
    H.launch(s, "app_5", now: 1_000, pid: 777)
    var asked: (Int64, Int32)?
    H.atStart(s, appVersion: "1", appUpdated: 100, now: 2_000) { since, pid in asked = (since, pid); return .counts("crash", sure: false) }
    eq(asked?.0, 1_000)
    eq(asked?.1, 777)
}
test("oneSureCrashBlocksAtOnce") {
    let s = fresh()
    launchThatDies(s, "app_5", sureCrash)
    eq(blocked(s)["app_5"], H.watchdog)
    eq(s.crashTimes.count, 0)
    eq(s.events.map(\.kind), ["launch_crashed", "watchdog_block"])
    eq(s.events[0].detail, "crash (1 of 1)")
    eq(s.events[1].detail, "a launch ended by a crash; last: crash")
}
test("theLastGoodBundleTakesThreeDeathsEvenWhenSure") {
    let s = fresh()
    H.healthy(s, "app_5")
    launchThatDies(s, "app_5", sureCrash)
    eq(s.events.last?.detail, "crash (1 of 3)")
    launchThatDies(s, "app_5", crash)
    yes(s.blocked.isEmpty)
    launchThatDies(s, "app_5", sureCrash)
    eq(blocked(s)["app_5"], H.watchdog)
    eq(s.lastGood, nil)
}
test("errorsOfTheLastGoodBundleAreOnlyReported") {
    let s = fresh()
    yes(H.errorsRollBack(s, "app_5"))
    H.healthy(s, "app_5")
    no(H.errorsRollBack(s, "app_5"))
    yes(H.errorsRollBack(s, "app_6"))
    H.healthy(s, "app_6")
    yes(H.errorsRollBack(s, "app_5"))
    H.block(s, "app_6", H.watchdog)
    yes(H.errorsRollBack(s, "app_6"))
}
test("aSureCrashAfterAnUnsureOneBlocks") {
    let s = fresh()
    launchThatDies(s, "app_5", crash)
    yes(s.blocked.isEmpty)
    launchThatDies(s, "app_5", sureCrash)
    eq(blocked(s)["app_5"], H.watchdog)
    eq(s.events.last?.detail, "2 launches in 24 h ended by a crash or a freeze; last: crash")
}
test("theBackgroundDoesNotClearTheCount") {
    let s = fresh()
    H.healthy(s, "app_5")
    for i in 0..<3 {
        yes(s.blocked.isEmpty)
        H.launch(s, "app_5", now: 3_000 + Int64(i), pid: 4242)
        H.ended(s, "app_5")
        eq(s.pending, nil)
        launchThatDies(s, "app_5", sureCrash, at: 5_000 + Int64(i))
    }
    eq(blocked(s)["app_5"], H.watchdog)
}
test("deathsOlderThanADayAreDropped") {
    let s = fresh()
    H.healthy(s, "app_5")
    launchThatDies(s, "app_5", sureCrash, at: 2_000)
    launchThatDies(s, "app_5", sureCrash, at: 2_000 + 5 * hour)
    launchThatDies(s, "app_5", sureCrash, at: 2_000 + 25 * hour)
    eq(s.crashTimes.count, 2)
    yes(s.blocked.isEmpty)
    launchThatDies(s, "app_5", sureCrash, at: 2_000 + 26 * hour)
    eq(blocked(s)["app_5"], H.watchdog)
}
test("deathsInTheFutureAreDropped") {
    let s = fresh()
    launchThatDies(s, "app_5", crash, at: 100 * hour)
    launchThatDies(s, "app_5", crash, at: 2_000)
    eq(s.crashTimes, [2_000])
    yes(s.blocked.isEmpty)
}
test("aDeathAfterTheBackgroundIsNotCounted") {
    let s = fresh()
    H.launch(s, "app_5", now: 1_000, pid: 4242)
    H.ended(s, "app_5")
    H.atStart(s, appVersion: "1", appUpdated: 100, now: 2_000, exit: nothingPending)
    eq(s.crashTimes.count, 0)
}
test("aStartFailureCountsAsAnUnsureDeathOfTheLastGoodBundle") {
    let s = fresh()
    H.healthy(s, "app_5")
    no(H.countDeath(s, "app_5", "start failed", limit: H.watchdogLimit, now: 1_000))
    yes(H.countDeath(s, "app_5", "start failed", limit: H.watchdogLimit, now: 2_000))
    eq(blocked(s)["app_5"], H.watchdog)
    eq(s.lastGood, nil)
}
test("aCrashMarkMustNameTheProcessAndComeAfterTheLaunch") {
    yes(H.isCrashOf("777 5000", pid: 777, since: 1_000))
    no(H.isCrashOf("778 5000", pid: 777, since: 1_000))
    no(H.isCrashOf("777 500", pid: 777, since: 1_000))
    no(H.isCrashOf(nil, pid: 777, since: 1_000))
    no(H.isCrashOf("broken", pid: 777, since: 1_000))
}
test("exitsThatAreNotTheBundlesFaultAreNotCounted") {
    let s = fresh()
    launchThatDies(s, "app_5", crash)
    launchThatDies(s, "app_5", stopped)
    eq(s.crashTimes.count, 1)
    eq(s.pending, nil)
    launchThatDies(s, "app_5", crash)
    eq(blocked(s)["app_5"], H.watchdog)
}
test("aCrashOfAnotherBundleStartsTheCountAgain") {
    let s = fresh()
    launchThatDies(s, "app_5", crash)
    launchThatDies(s, "app_6", crash)
    eq(s.crashBundle, "app_6")
    eq(s.crashTimes.count, 1)
    yes(s.blocked.isEmpty)
}
test("healthyMakesTheLastGoodBundleButTheVisitStaysWatched") {
    let s = fresh()
    launchThatDies(s, "app_5", crash)
    H.launch(s, "app_5", now: 3_000, pid: 4242)
    yes(H.healthy(s, "app_5"))
    no(H.healthy(s, "app_5"))
    eq(s.lastGood, "app_5")
    eq(s.pending, "app_5")
    eq(s.crashTimes.count, 1)
}
test("aBlockedBundleNeverBecomesLastGood") {
    let s = fresh()
    H.block(s, "app_5", H.watchdog)
    no(H.healthy(s, "app_5"))
    eq(s.lastGood, nil)
}
test("blockingForgetsTheBundleAsLastGoodAndErrorBlocksStay") {
    let s = fresh()
    H.healthy(s, "app_5")
    H.block(s, "app_5", H.error)
    eq(s.lastGood, nil)
    H.block(s, "app_5", H.watchdog)
    eq(blocked(s)["app_5"], H.error)
}
test("aNewAppBuildClearsWatchdogBlocksNotErrorBlocks") {
    let s = fresh()
    H.block(s, "app_5", H.watchdog)
    H.block(s, "app_6", H.error)
    s.guardFails = 2
    launchThatDies(s, "app_7", crash)
    H.launch(s, "app_7", now: 3_000, pid: 4242)
    no(H.atStart(s, appVersion: "1", appUpdated: 100, now: 4_000, exit: stopped))
    yes(H.atStart(s, appVersion: "1", appUpdated: 200, now: 5_000, exit: { _, _ in fail("a new install forgets what was pending"); return .ignored("") }))
    eq(blocked(s), ["app_6": H.error])
    eq(s.crashTimes.count, 0)
    eq(s.guardFails, 0)
    eq(s.events.last?.kind, "apk_changed")
}
test("theFirstStartEverIsNotANewAppBuild") {
    let s = H.State()
    no(H.atStart(s, appVersion: "7", appUpdated: 100, now: 0, exit: nothingPending))
    eq(s.appVersion, "7")
    yes(s.events.isEmpty)
}
test("twoFailedStartUpsBlowTheFuse") {
    let s = fresh()
    no(H.guardFailed(s))
    yes(H.guardFailed(s))
    yes(H.fuseBlown(s))
}
test("blockedAndEventsAreBounded") {
    let s = fresh()
    for i in 0..<(H.maxBlocked + 3) { H.block(s, "app_\(i)", H.error) }
    eq(s.blocked.count, H.maxBlocked)
    no(s.isBlocked("app_0"))
    for i in 0..<(H.maxEvents + 5) { H.event(s, "e\(i)", nil, nil, Int64(i)) }
    eq(s.events.count, H.maxEvents)
    eq(s.events.first?.kind, "e5")
}
test("anUnusableBundleIsReportedOnce") {
    let s = fresh()
    H.unusable(s, "app_5", "no zn-bundle.json", now: 1_000)
    H.unusable(s, "app_5", "no zn-bundle.json", now: 2_000)
    eq(s.events.map(\.kind), ["bundle_unusable"])
    H.atStart(s, appVersion: "1", appUpdated: 200, now: 3_000, exit: nothingPending)
    H.unusable(s, "app_5", "no zn-bundle.json", now: 4_000)
    eq(s.events.filter { $0.kind == "bundle_unusable" }.count, 2)
}
test("aBundleOlderThanTheAppIsAnInfoEventOnce") {
    let s = fresh()
    H.superseded(s, "app_14", "the built-in bundle #15 is the same or newer", now: 1_000)
    H.superseded(s, "app_14", "the built-in bundle #15 is the same or newer", now: 2_000)
    eq(s.events.map(\.kind), ["bundle_superseded"])
}
test("maskHidesPrivateData") {
    eq(H.mask("pay failed for 9876543210"), "pay failed for ***")
    eq(H.mask("call 98765 43210 now"), "call *** now")
    eq(H.mask("card 4111-1111-1111-1111"), "card ***")
    eq(H.mask("rahul@okaxis declined"), "***@*** declined")
    eq(H.mask("mail a.b+c@mail.example.com bounced"), "mail ***@*** bounced")
    eq(H.mask("GET https://api.example.com/v1/pay?pa=a@b&am=100 failed"), "GET https://api.example.com/v1/pay?*** failed")
    eq(H.mask("upi://pay?pa=x@y&am=1.00&tr=123456"), "upi://pay?***")
    eq(H.mask("/v1/pay?id=7 500"), "/v1/pay?*** 500")
    eq(H.mask("Authorization: Bearer abc.def-123"), "Authorization: Bearer ***")
}
test("maskKeepsOrdinaryErrors") {
    for text in ["screen in Home: Cannot read property 'amount' of undefined", "amount 500 at 12:30 is too big",
                 "start in main.js:12345:678: boom", "Why did this fail? Nobody knows"] {
        eq(H.mask(text), text)
    }
}
test("maskStopsAtItsLimit") { eq(H.mask(String(repeating: "x", count: 5_000)).count, 1024) }
test("theStateSurvivesTheFile") {
    let s = fresh()
    H.block(s, "app_9", H.watchdog)
    H.block(s, "app_3", H.error)
    H.healthy(s, "app_4")
    H.launch(s, "app_8", now: 42, pid: 4242)
    s.crashBundle = "app_8"
    s.crashTimes += [10, 20]
    s.unusable.append("app_2")
    H.event(s, "x", "app_8", "why", 7)
    H.event(s, "error_rollback", "app_8", "screen in Home", 8, stack: "at Home (main.js:20:5)", sha: String(repeating: "ab", count: 32))
    let back = try H.State.fromJson(s.toJson())
    eq(back.blocked.map(\.0), ["app_9", "app_3"])
    eq(back.lastGood, "app_4")
    eq(back.pending, "app_8")
    eq(back.pendingSince, 42)
    eq(back.pendingPid, 4242)
    eq(back.crashBundle, "app_8")
    eq(back.crashTimes, [10, 20])
    eq(back.unusable, ["app_2"])
    eq(back.events[0].kind, "x")
    eq(back.events[0].bundle, "app_8")
    eq(back.events[0].detail, "why")
    eq(back.events[0].atMs, 7)
    eq(back.events[0].stack, nil)
    eq(back.events[1].stack, "at Home (main.js:20:5)")
    eq(back.events[1].sha, String(repeating: "ab", count: 32))
    eq(back.appVersion, "1")
}

// MARK: Bundles (ZnBundlesTest.kt)

let root = FileManager.default.temporaryDirectory.appendingPathComponent("zn-bundles-\(getpid())")
try? FileManager.default.removeItem(at: root)
let builtIn = ZnBundleRules.Info(app: "sample", serial: 3, id: "sample_3", sha256: "x",
                                 files: ["main.hbc": 4, "main.zn.ui": 2, "main.zn.ui.json": 2], requires: nil)
var caps = ZnCapabilities(registry: 9, bytecode: 99, hostApi: 2, hostApiOldest: 1, modules: ["Device": 2, "Keyboard": 1])
let needsLittle = #"{"registry":8,"bytecode":99,"hostApi":1,"modules":{"Device":1}}"#
let codeFiles = ["main.hbc": "code", "main.zn.ui": "ui", "main.zn.ui.json": "{}"]

func bundle(_ id: String, files: [String: String] = codeFiles, edit: (inout [String: String]) -> Void = { _ in }) {
    let dir = root.appendingPathComponent(id)
    try! FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for (name, text) in files {
        let f = dir.appendingPathComponent(name)
        try! FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! text.write(to: f, atomically: true, encoding: .utf8)
    }
    var fields: [String: String] = [  // raw JSON values
        "format": "1", "app": "\"sample\"", "serial": String(id.split(separator: "_").last!), "id": "\"\(id)\"",
        "sha256": "\"y\"", "requires": needsLittle,
    ]
    edit(&fields)
    let list = files.map { "\"\($0.key)\":{\"size\":\($0.value.utf8.count),\"sha256\":\"z\"}" }.joined(separator: ",")
    let head = fields.map { "\"\($0.key)\":\($0.value)" }.joined(separator: ",")
    try! "{\(head),\"files\":{\(list)}}".write(to: dir.appendingPathComponent("zn-bundle.json"), atomically: true, encoding: .utf8)
}
func check(_ id: String) -> ZnBundleRules.Check {
    ZnBundleRules.checkBundle(id, builtIn: builtIn, caps: caps) { root.appendingPathComponent($0) }
}
func refused(_ id: String, _ part: String, line: Int = #line) {
    switch check(id) {
    case .ok: fail("\(id) should not run", line: line)
    case let .no(reason, _): if !reason.contains(part) { fail("\"\(reason)\" should mention \"\(part)\"", line: line) }
    }
}

test("aNewerCompleteBundleRuns") {
    bundle("sample_4", files: codeFiles.merging(["images/a.png": "png"]) { a, _ in a })
    guard case let .ok(info) = check("sample_4") else { return fail("should run") }
    eq(info.serial, 4)
    eq(info.files["images/a.png"], 3)
}
test("theBuiltInBundleWinsWhenItIsTheSameOrNewer") {
    bundle("sample_3")
    guard case let .no(_, superseded) = check("sample_3") else { return fail("should not run") }
    yes(superseded)
}
test("badIdsAreRefusedBeforeTouchingFiles") {
    for id in ["../sample_4", "sample", "Sample_4", "sample_4/..", ""] { refused(id, "not a bundle id") }
}
test("aMissingFolderOrInfoFileIsRefused") { refused("sample_40", "no zn-bundle.json") }
test("anotherAppsBundleIsRefused") {
    bundle("other_5") { $0["app"] = "\"other\"" }
    refused("other_5", "for app \"other\"")
}
test("anInfoFileForAnotherIdIsRefused") {
    bundle("sample_6") { $0["id"] = "\"sample_7\"" }
    refused("sample_6", "says sample_7")
}
test("anUnknownFormatIsRefused") {
    bundle("sample_8") { $0["format"] = "2" }
    refused("sample_8", "can't be read")
}
test("aBundleWithoutTheBuiltInCodeFilesIsRefused") {
    bundle("sample_9", files: ["main.hbc": "code", "main.zn.ui": "ui"])
    refused("sample_9", "it has no main.zn.ui.json")
}
test("aMissingOrCutFileIsRefused") {
    bundle("sample_10")
    try FileManager.default.removeItem(at: root.appendingPathComponent("sample_10/main.zn.ui"))
    refused("sample_10", "main.zn.ui is missing")
    bundle("sample_11")
    try "cod".write(to: root.appendingPathComponent("sample_11/main.hbc"), atomically: true, encoding: .utf8)
    refused("sample_11", "main.hbc is 3 bytes")
}
test("filePathsCantLeaveTheBundleFolder") {
    for bad in ["../x", "/etc/x", "a//b", "a/../b", "a\\b"] {
        do {
            _ = try ZnBundleRules.parseInfo(#"{"format":1,"app":"a","serial":1,"id":"a_1","sha256":"s","files":{"\#(bad.replacingOccurrences(of: "\\", with: "\\\\"))":{"size":1}}}"#)
            fail("\(bad) should be refused")
        } catch {}
    }
}
test("aBundleThatListsNoNeedsIsRefused") {
    bundle("sample_12") { $0["requires"] = nil }
    refused("sample_12", "doesn't say what it needs")
}
test("aBundleNeedingANewerRegistryIsRefused") {
    bundle("sample_13") { $0["requires"] = #"{"registry":10,"bytecode":99,"hostApi":1,"modules":{}}"# }
    refused("sample_13", "registry v10")
}
test("aBundleForAnotherBytecodeFormatIsRefused") {
    bundle("sample_14") { $0["requires"] = #"{"registry":8,"bytecode":98,"hostApi":1,"modules":{}}"# }
    refused("sample_14", "format 98")
}
test("theHostApiMustBeInTheAppsRange") {
    bundle("sample_15") { $0["requires"] = #"{"registry":8,"bytecode":99,"hostApi":3,"modules":{}}"# }
    refused("sample_15", "host API v3")
    caps = ZnCapabilities(registry: 9, bytecode: 99, hostApi: 4, hostApiOldest: 2, modules: caps.modules)
    bundle("sample_16") { $0["requires"] = #"{"registry":8,"bytecode":99,"hostApi":1,"modules":{}}"# }
    refused("sample_16", "built for host API v1")
    caps = ZnCapabilities(registry: 9, bytecode: 99, hostApi: 2, hostApiOldest: 1, modules: caps.modules)
}
test("anOlderAppWithoutAModuleIgnoresTheBundle") {
    bundle("sample_17") { $0["requires"] = #"{"registry":8,"bytecode":99,"hostApi":1,"modules":{"Camera":1}}"# }
    refused("sample_17", "native module Camera")
    bundle("sample_18") { $0["requires"] = #"{"registry":8,"bytecode":99,"hostApi":1,"modules":{"Device":3}}"# }
    refused("sample_18", "Device v3, this app has v2")
}
test("onlyThisOsPartCounts") {
    // docs/ota-requires-per-os.md: an Android-only module never stops iOS; an iOS-only one does when missing
    bundle("sample_19") { $0["requires"] = #"{"registry":8,"bytecode":99,"hostApi":1,"modules":{},"os":{"android":{"AdId":1}}}"# }
    if case .no(let why, _) = check("sample_19") { fail("sample_19 should run: \(why)") }
    bundle("sample_20") { $0["requires"] = #"{"registry":8,"bytecode":99,"hostApi":1,"modules":{},"os":{"ios":{"Haptics":1}}}"# }
    refused("sample_20", "native module Haptics")
    let android = ZnCapabilities(registry: 9, bytecode: 99, hostApi: 2, hostApiOldest: 1, modules: ["Device": 2], os: "android")
    eq(android.missing(ZnBundleRules.Requires(registry: 8, bytecode: 99, hostApi: 1, modules: [:], os: ["ios": ["Haptics": 1]])), nil)
    eq(android.missing(ZnBundleRules.Requires(registry: 8, bytecode: 99, hostApi: 1, modules: [:], os: ["android": ["AdId": 1]])),
       "it needs native module AdId, this app doesn't have it")
}

// MARK: Store answer (ZnOtaStoreTest.kt)

test("storeAnswers") {
    eq(ZnOtaStore.read(["update": NSNull()]), #"{"update":null}"#)
    eq(ZnOtaStore.update(ZnOtaStore.read(["update": NSNull()])) == nil, true)
    let ios = ZnOtaStore.read(["update": ["version": "1.6.2", "critical": 2, "title": "New"], "appStoreId": "123"])
    eq(ios, #"{"appStoreId":"123","update":{"critical":2,"title":"New","version":"1.6.2"}}"#)
    let u = ZnOtaStore.update(ios)
    eq(u?.version, "1.6.2")
    eq(u?.forced, true)
    eq(u?.title, "New")
    eq(ZnOtaStore.update(ZnOtaStore.read(["update": ["version": 175, "critical": 1]]))?.version, "175")
    eq(ZnOtaStore.read(["update": ["version": "1.6.2", "critical": 3]]), nil)
    eq(ZnOtaStore.read(["update": ["version": "", "critical": 1]]), nil)
    eq(ZnOtaStore.read(["update": ["version": "1", "critical": true]]), nil)
    eq(ZnOtaStore.read("nope"), nil)
    let long = String(repeating: "a", count: 500)
    eq(ZnOtaStore.update(ZnOtaStore.read(["update": ["version": "2", "critical": 1, "message": long]]))?.message?.count, 300)
}

// MARK: Signatures (ZnOtaSignatureTest.kt): the CLI's fixture

let f = try! ZnJSON.object(Data(contentsOf: URL(fileURLWithPath: args[1])))
let mainKey = f["publicKey"] as! String
let otherKey = f["otherPublicKey"] as! String
func req(_ o: [String: Any]) -> ZnBundleRules.Requires { try! ZnBundleRules.parseRequires(o["requires"] as! [String: Any]) }

test("bundleTextAndSignatureMatchTheCli") {
    let b = f["bundle"] as! [String: Any]
    eq(ZnOtaSignature.requiresLine(req(b)), f["requiresLine"] as! String)
    let text = ZnOtaSignature.bundleText(app: b["app"] as! String, id: b["id"] as! String, serial: b["serial"] as! Int,
                                         bundleSha256: b["bundleSha256"] as! String, requires: req(b),
                                         zipSha256: b["zipSha256"] as! String, zipSize: (b["zipSize"] as! NSNumber).int64Value)
    eq(text, b["text"] as! String)
    eq(ZnOtaSignature.verify(text, signature: b["signature"] as! String, publicKeys: [mainKey]), 0)
    eq(ZnOtaSignature.verify(text, signature: b["signature"] as! String, publicKeys: [otherKey, mainKey]), 1)
}
test("perOsNeedsMatchTheCli") {
    let b = f["bundleOs"] as! [String: Any]
    let r = req(b)
    eq(ZnOtaSignature.requiresLine(r), f["requiresLineOs"] as! String)
    func text(_ r: ZnBundleRules.Requires) -> String {
        ZnOtaSignature.bundleText(app: b["app"] as! String, id: b["id"] as! String, serial: b["serial"] as! Int,
                                  bundleSha256: b["bundleSha256"] as! String, requires: r,
                                  zipSha256: b["zipSha256"] as! String, zipSize: (b["zipSize"] as! NSNumber).int64Value)
    }
    eq(text(r), b["text"] as! String)
    eq(ZnOtaSignature.verify(text(r), signature: b["signature"] as! String, publicKeys: [mainKey]), 0)
    // An app built before per-OS needs drops the OS parts: another text, and the signature fails
    let old = ZnBundleRules.Requires(registry: r.registry, bytecode: r.bytecode, hostApi: r.hostApi, modules: r.modules)
    eq(ZnOtaSignature.verify(text(old), signature: b["signature"] as! String, publicKeys: [mainKey]), -1)
}
test("pointerAndKillSwitchMatchTheCli") {
    for name in ["pointer", "kill"] {
        let p = f[name] as! [String: Any]
        let text = ZnOtaSignature.pointerText(app: p["app"] as! String, channel: p["channel"] as! String,
                                              seq: (p["seq"] as! NSNumber).int64Value, target: p["target"] as! String)
        eq(text, p["text"] as! String)
        eq(ZnOtaSignature.verify(text, signature: p["signature"] as! String, publicKeys: [mainKey]), 0, name)
    }
    eq((f["kill"] as! [String: Any])["target"] as! String, ZnOtaSignature.builtIn)
}
test("anythingChangedOrSignedByAnotherKeyIsRefused") {
    let p = f["pointer"] as! [String: Any]
    let sig = p["signature"] as! String
    let text = p["text"] as! String
    eq(ZnOtaSignature.verify(text, signature: sig, publicKeys: [otherKey]), -1)
    eq(ZnOtaSignature.verify(text.replacingOccurrences(of: "\n7\n", with: "\n6\n"), signature: sig, publicKeys: [mainKey]), -1)
    eq(ZnOtaSignature.verify(text.replacingOccurrences(of: "production", with: "staging"), signature: sig, publicKeys: [mainKey]), -1)
    eq(ZnOtaSignature.verify(text, signature: "not base64!", publicKeys: [mainKey]), -1)
    eq(ZnOtaSignature.verify(text, signature: sig, publicKeys: ["AAAA"]), -1)
}
test("base64DecodesLikeTheStandard") {
    eq(ZnOtaSignature.decodeBase64("aGk/"), Data("hi?".utf8))
    eq(ZnOtaSignature.decodeBase64("aGk="), Data("hi".utf8))
    eq(ZnOtaSignature.decodeBase64("aA=="), Data("h".utf8))
    eq(ZnOtaSignature.decodeBase64(""), Data())
}

// MARK: Install (ZnOtaInstallTest.kt): a zip made as the CLI makes one

let fx = URL(fileURLWithPath: args[2])
let manifestJson = try! ZnJSON.object(Data(contentsOf: fx.appendingPathComponent("manifest.json")))
let manifest = try! ZnOtaSigned.parseManifest(manifestJson)
let zipURL = fx.appendingPathComponent("bundle.zip")

test("aGoodBundleInstallsWithEveryFile") {
    eq(try ZnOtaFiles.sha256(zipURL), manifest.zipSha256, "zip sha")
    let dest = root.appendingPathComponent("installed/sample_12")
    try ZnOtaInstall.extract(zip: zipURL, manifest: manifest, dest: dest)
    for name in ["main.hbc", "main.zn.ui", "main.zn.ui.json", "images/a.png", "zn-bundle.json"] {
        eq(try Data(contentsOf: dest.appendingPathComponent(name)), try Data(contentsOf: fx.appendingPathComponent("bundle/\(name)")), name)
    }
    let b = ZnBundleRules.Info(app: "sample", serial: 3, id: "sample_3", sha256: "x",
                               files: ["main.hbc": 1, "main.zn.ui": 1, "main.zn.ui.json": 1], requires: nil)
    guard case .ok = ZnBundleRules.checkBundle("sample_12", builtIn: b, caps: caps, folder: { root.appendingPathComponent("installed/\($0)") }) else {
        return fail("the installed bundle should pass its checks")
    }
}
test("anExistingFolderIsNotOverwritten") {
    let dest = root.appendingPathComponent("installed/sample_12")
    do { try ZnOtaInstall.extract(zip: zipURL, manifest: manifest, dest: dest); fail("should refuse") } catch let e as ZnOtaError { eq(e.code, "install") }
}
test("aZipForAnotherBundleOrWithOtherNeedsIsRefused") {
    var j = manifestJson
    j["id"] = "sample_13"
    do { try ZnOtaInstall.extract(zip: zipURL, manifest: try ZnOtaSigned.parseManifest(j), dest: root.appendingPathComponent("x1")); fail("id") } catch {}
    j = manifestJson
    j["requires"] = ["registry": 8, "bytecode": 99, "hostApi": 2, "modules": ["Device": 2]]
    do { try ZnOtaInstall.extract(zip: zipURL, manifest: try ZnOtaSigned.parseManifest(j), dest: root.appendingPathComponent("x2")); fail("needs") } catch {}
    j = manifestJson
    j["bundleSha256"] = String(repeating: "0", count: 64)
    do { try ZnOtaInstall.extract(zip: zipURL, manifest: try ZnOtaSigned.parseManifest(j), dest: root.appendingPathComponent("x3")); fail("sha") } catch let e as ZnOtaError {
        yes(e.message.contains("signed bundle SHA-256"), e.message)
    }
}
test("aChangedByteInsideTheZipIsRefused") {
    var bytes = [UInt8](try Data(contentsOf: zipURL))
    // A byte in the middle of the stored data of the last-written big entry (the zip's first half is main.hbc's data).
    bytes[bytes.count / 3] ^= 0xFF
    let bad = root.appendingPathComponent("bad.zip")
    try Data(bytes).write(to: bad)
    do { try ZnOtaInstall.extract(zip: bad, manifest: manifest, dest: root.appendingPathComponent("x4")); fail("should refuse") } catch {}
}
test("atomicWritesLeaveTheNewTextAndNoTempFile") {
    let file = root.appendingPathComponent("w/current")
    try ZnOtaFiles.writeAtomic(file, "sample_4")
    try ZnOtaFiles.writeAtomic(file, "sample_5")
    eq(ZnOtaFiles.readText(file), "sample_5")
    eq(try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path), ["current"])
}
// #217: failed checks must not push serious outcomes out (Android: ZnOtaOutcomesTest)
test("aCrashSurvives25FailedChecks") {
    let items = ["!launch_crashed"] + (0..<25).map { "failed\($0)" }
    let kept = ZnOtaOutcomeRules.trim(items, 20) { $0.hasPrefix("!") }
    eq(kept.count, 20)
    eq(kept.first, "!launch_crashed")
    eq(kept.last, "failed24")
    eq(ZnOtaOutcomeRules.trim(["!crash", "f1", "f2", "f3", "!rollback", "f4"], 4) { $0.hasPrefix("!") }, ["!crash", "f3", "!rollback", "f4"])
    eq(ZnOtaOutcomeRules.trim((0..<25).map { "!s\($0)" }, 20) { $0.hasPrefix("!") }, (5..<25).map { "!s\($0)" })
}

// MARK: Patches (ZnBsPatchTest.kt): what tools/ota/bsdiff.ts makes, and every cut or changed patch refused

let pfx = URL(fileURLWithPath: args[3])
func res(_ name: String) -> Data { try! Data(contentsOf: pfx.appendingPathComponent(name)) }
let patchFixture = try! ZnJSON.object(res("fixture.json"))
let oldHbc = res("old.hbc")
let newHbc = res("new.hbc")
let hbcPatch = res("main.patch")
func sha(_ d: Data) -> String { ZnOtaFiles.hex(SHA256.hash(data: d)) }
func fixtureOf(_ key: String) -> [String: Any] { patchFixture[key] as! [String: Any] }

/// A patch made by hand: header, then the (add, copy, seek) triples, then diff and extra bytes.
func patchOf(_ newSize: Int64, _ controls: [[Int64]], diff: [UInt8] = [], extra: [UInt8] = [], count: Int64? = nil) -> Data {
    var d = Data("ZNBSDIF1".utf8)
    func put(_ v: Int64) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    put(newSize)
    put(count ?? Int64(controls.count))
    for c in controls { c.forEach(put) }
    d.append(contentsOf: diff)
    d.append(contentsOf: extra)
    return d
}
func long(_ d: Data, _ at: Int) -> Int64 {
    var v: UInt64 = 0
    for i in (0..<8).reversed() { v = v << 8 | UInt64(d[d.startIndex + at + i]) }
    return Int64(bitPattern: v)
}
func patchRefused(_ old: Data, _ p: Data, _ size: Int64, _ part: String, line: Int = #line) {
    do {
        _ = try ZnBsPatch.apply(old: old, patch: p, expectSize: size)
        fail("should refuse (\(part))", line: line)
    } catch let e as ZnOtaError {
        eq(e.code, "patch", line: line)
        yes(e.message.contains(part), "\"\(e.message)\" should mention \"\(part)\"", line: line)
    } catch {
        fail("threw \(error)", line: line)
    }
}
/// Where a patch's data ends: header, controls, then the sum of add and the sum of copy.
func dataEnd(_ p: Data) -> Int {
    let controls = Int(long(p, 16))
    var end = 24 + controls * 24
    for c in 0..<controls { end += Int(long(p, 24 + c * 24) + long(p, 32 + c * 24)) }
    return end
}
/// A small fixed-seed random number maker (xorshift64), so a failure happens again on the next run.
struct Rand {
    var s: UInt64
    mutating func next(_ n: Int) -> Int {
        s ^= s << 13
        s ^= s >> 7
        s ^= s << 17
        return Int(s % UInt64(n))
    }
}

test("theFixtureIsWhatTheScriptSays") {
    eq(sha(oldHbc), fixtureOf("old")["sha256"] as! String)
    eq(sha(newHbc), fixtureOf("new")["sha256"] as! String)
    eq(hbcPatch.count, fixtureOf("patch")["size"] as! Int)
    yes((fixtureOf("patch")["controls"] as! Int) >= 3, "the fixture should have seeks")
}
test("aPatchMadeByTheTsCodeMakesTheNewFile") {
    eq(try ZnBsPatch.apply(old: oldHbc, patch: hbcPatch, expectSize: Int64(newHbc.count)), newHbc)
}
test("aPatchFromAnEmptyFileMakesTheNewFile") {
    let text = fixtureOf("fromEmpty")["text"] as! String
    let made = try ZnBsPatch.apply(old: Data(), patch: res("from-empty.patch"), expectSize: Int64(Data(text.utf8).count))
    eq(String(decoding: made, as: UTF8.self), text)
}
test("handMadePatchesWork") {
    // add 3 (old + diff), copy 2 from extra, seek back 3 so the next add reads old from the start again.
    let p = patchOf(7, [[3, 2, -3], [2, 0, 0]], diff: [1, 1, 1, 0, 0], extra: Array("xy".utf8))
    eq(String(decoding: try ZnBsPatch.apply(old: Data("abcd".utf8), patch: p, expectSize: 7), as: UTF8.self), "bcdxyab")
    // Reads outside the old file count as 0: a seek far past the end gives the diff bytes themselves.
    let q = patchOf(2, [[0, 0, 1000], [2, 0, 0]], diff: Array("hi".utf8))
    eq(String(decoding: try ZnBsPatch.apply(old: Data("abcd".utf8), patch: q, expectSize: 2), as: UTF8.self), "hi")
    eq(try ZnBsPatch.apply(old: Data(), patch: patchOf(0, []), expectSize: 0).count, 0)
    // A read that starts before the old file and runs into it (a negative old position).
    let r = patchOf(4, [[0, 0, -2], [4, 0, 0]], diff: [65, 65, 1, 1])
    eq(String(decoding: try ZnBsPatch.apply(old: Data("abcd".utf8), patch: r, expectSize: 4), as: UTF8.self), "AAbc")
}
test("aWrongMagicOrSizeIsRefused") {
    var bad = hbcPatch
    bad[bad.startIndex] = UInt8(ascii: "X")
    patchRefused(oldHbc, bad, Int64(newHbc.count), "not a ZNBSDIFF1 patch")
    patchRefused(oldHbc, hbcPatch.prefix(10), Int64(newHbc.count), "not a ZNBSDIFF1 patch")
    patchRefused(oldHbc, hbcPatch, Int64(newHbc.count + 1), "expected \(newHbc.count + 1)")
    patchRefused(oldHbc, patchOf(-1, []), -1, "makes -1 bytes")
    patchRefused(oldHbc, patchOf(Int64.max, []), Int64.max, "too big")
}
test("aCutPatchIsAlwaysRefused") {
    // Every length shorter than its data, around the header, the controls, and the diff and extra parts.
    let end = dataEnd(hbcPatch)
    yes(end <= hbcPatch.count)
    var rnd = Rand(s: 42)
    let cuts = Array(0..<600) + Array((end - 600)..<end) + (0..<200).map { _ in rnd.next(end) }
    for n in cuts {
        do {
            _ = try ZnBsPatch.apply(old: oldHbc, patch: hbcPatch.prefix(n), expectSize: Int64(newHbc.count))
            fail("a patch cut to \(n) bytes should be refused")
        } catch is ZnOtaError {
        } catch {
            fail("threw \(error)")
        }
    }
}
test("bytesAfterTheExtraPartAreNotRead") {
    eq(hbcPatch.count, dataEnd(hbcPatch))
    eq(try ZnBsPatch.apply(old: oldHbc, patch: hbcPatch + Data(count: 8), expectSize: Int64(newHbc.count)), newHbc)
    eq(try ZnBsPatch.apply(old: oldHbc, patch: hbcPatch + Data(repeating: 7, count: 5), expectSize: Int64(newHbc.count)), newHbc)
}
test("badControlsAreRefused") {
    let s: Int64 = 4
    patchRefused(oldHbc, patchOf(s, [], count: 1_000_000), s, "bad control count")
    patchRefused(oldHbc, patchOf(s, [], count: -1), s, "bad control count")
    patchRefused(oldHbc, patchOf(s, [], count: Int64.max), s, "bad control count")
    patchRefused(oldHbc, patchOf(s, [[-1, 5, 0]], extra: [UInt8](repeating: 0, count: 5)), s, "bad diff length")
    patchRefused(oldHbc, patchOf(s, [[Int64.max, 0, 0]]), s, "bad diff length")
    patchRefused(oldHbc, patchOf(s, [[2, 0, 0], [Int64.max - 1, 0, 0]], diff: [0, 0]), s, "bad diff length")
    patchRefused(oldHbc, patchOf(s, [[0, -1, 0]]), s, "past the new size")
    patchRefused(oldHbc, patchOf(s, [[0, Int64.max, 0]]), s, "past the new size")
    patchRefused(oldHbc, patchOf(s, [[5, 0, 0]], diff: [UInt8](repeating: 0, count: 5)), s, "past the new size")
    patchRefused(oldHbc, patchOf(s, [[2, 3, 0]], diff: [0, 0], extra: [0, 0, 0]), s, "past the new size")
    patchRefused(oldHbc, patchOf(s, [[0, 4, 0]], extra: [0, 0, 0]), s, "past the patch")
    patchRefused(oldHbc, patchOf(s, [[0, 2, 0]]), s, "past the patch")
    // Ends short of newSize: 2 of 4 bytes.
    patchRefused(oldHbc, patchOf(s, [[0, 2, 0]], extra: [0, 0]), s, "made 2 of 4 bytes")
}
test("aSeekThatOverflowsIsRefused") {
    patchRefused(oldHbc, patchOf(2, [[0, 0, Int64.max], [0, 0, 1], [2, 0, 0]], diff: [0, 0]), 2, "out of range")
    patchRefused(oldHbc, patchOf(2, [[0, 0, Int64.min], [0, 0, -1], [2, 0, 0]], diff: [0, 0]), 2, "out of range")
    // At the edge but not over: still works (old reads count as 0 there).
    let p = patchOf(2, [[0, 0, Int64.max - 2], [2, 0, 0]], diff: Array("ok".utf8))
    eq(String(decoding: try ZnBsPatch.apply(old: oldHbc, patch: p, expectSize: 2), as: UTF8.self), "ok")
    // add itself moves the old position: MAX - 1 + add 2 overflows.
    patchRefused(oldHbc, patchOf(2, [[0, 0, Int64.max - 1], [2, 0, 0]], diff: [0, 0]), 2, "out of range")
    // Far negative and then an add: reads count as 0, no overflow.
    let q = patchOf(2, [[0, 0, Int64.min + 5], [2, 0, 0]], diff: Array("no".utf8))
    eq(String(decoding: try ZnBsPatch.apply(old: oldHbc, patch: q, expectSize: 2), as: UTF8.self), "no")
}
test("aChangedPatchFailsOrMakesAnotherFileNeverACrash") {
    // Random changes in the header and controls: a ZnOtaError, or a file of the right size (that the SHA check then
    // refuses). Never a trap (Swift stops the program on an overflow or an index out of range).
    var rnd = Rand(s: 7)
    for _ in 0..<3_000 {
        var p = hbcPatch
        for _ in 0..<(1 + rnd.next(4)) { p[p.startIndex + rnd.next(24 + 26 * 24)] = UInt8(rnd.next(256)) }
        do {
            eq(try ZnBsPatch.apply(old: oldHbc, patch: p, expectSize: Int64(newHbc.count)).count, newHbc.count)
        } catch is ZnOtaError {
        }
    }
    // Numbers at the edges in every control field.
    let edges: [Int64] = [0, 1, -1, Int64.max, Int64.min, Int64.max - 1, Int64.min + 1, 1 << 32, -(1 << 32), 12_100, 12_748]
    for c in 0..<26 {
        for f in 0..<3 {
            for v in edges {
                var p = hbcPatch
                withUnsafeBytes(of: v.littleEndian) { p.replaceSubrange((24 + c * 24 + f * 8)..<(32 + c * 24 + f * 8), with: $0) }
                _ = try? ZnBsPatch.apply(old: oldHbc, patch: p, expectSize: Int64(newHbc.count))
            }
        }
    }
    // One changed diff byte: the patch still applies, but the file differs, so the SHA check catches it.
    var p = hbcPatch
    p[24 + 26 * 24 + 5] &+= 1
    no(sha(try ZnBsPatch.apply(old: oldHbc, patch: p, expectSize: Int64(newHbc.count))) == sha(newHbc))
}

// The shapes setup.ts made with bsdiff.ts makePatch (same, from and to empty, all new, edits, a 1.6 MB file).
let patchCases = fx.appendingPathComponent("patches/cases")
test("everyPatchTheServerMakesGivesTheSameBytes") {
    let list = try JSONSerialization.jsonObject(with: Data(contentsOf: fx.appendingPathComponent("patches/cases.json"))) as! [[String: Any]]
    yes(list.count >= 30, "\(list.count) cases")
    for c in list {
        let name = c["name"] as! String
        let dir = patchCases.appendingPathComponent(name)
        let old = try Data(contentsOf: dir.appendingPathComponent("old"))
        let patch = try Data(contentsOf: dir.appendingPathComponent("patch"))
        let t0 = Date()
        let made = try ZnBsPatch.apply(old: old, patch: patch, expectSize: Int64(c["newSize"] as! Int))
        if name == "big" { print("  bsdiff: 1.6 MB file made in \(Int(Date().timeIntervalSince(t0) * 1000)) ms") }
        eq(sha(made), c["newSha"] as! String, name)
        eq(made, try Data(contentsOf: dir.appendingPathComponent("new")), name)
    }
}

// MARK: Building from a patch zip (ZnOtaInstallPatchTest.kt, ZnOtaPatchContractTest.kt)

/// CRC-32 (zip's), for the test zips.
let crcTable: [UInt32] = (0..<256).map { n in
    var c = UInt32(n)
    for _ in 0..<8 { c = c & 1 != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
    return c
}
func crc32(_ d: Data) -> UInt32 { ~d.reduce(~UInt32(0)) { crcTable[Int(($0 ^ UInt32($1)) & 0xff)] ^ ($0 >> 8) } }
/// Raw deflate (Compression's ZLIB is RFC 1951), or nil when it doesn't get smaller.
func deflated(_ d: Data) -> Data? {
    if d.isEmpty { return nil }
    let cap = d.count + 4096
    var dst = [UInt8](repeating: 0, count: cap)
    let n = d.withUnsafeBytes { compression_encode_buffer(&dst, cap, $0.bindMemory(to: UInt8.self).baseAddress!, d.count, nil, COMPRESSION_ZLIB) }
    return n == 0 || n >= d.count ? nil : Data(dst[0..<n])
}
/// A zip as the server's fflate or java.util.zip writes one: each entry deflated, or stored when that is smaller.
func writeZip(_ entries: [(String, Data)], to url: URL) {
    var out = Data()
    var dir = Data()
    func u16(_ v: Int, _ d: inout Data) { d.append(UInt8(v & 0xff)); d.append(UInt8(v >> 8 & 0xff)) }
    func u32(_ v: UInt32, _ d: inout Data) { for i in 0..<4 { d.append(UInt8(v >> UInt32(8 * i) & 0xff)) } }
    for (name, data) in entries {
        let z = deflated(data)
        let method = z == nil ? 0 : 8
        let body = z ?? data
        let n = Data(name.utf8)
        let crc = crc32(data)
        let offset = out.count
        u32(0x0403_4b50, &out); u16(20, &out); u16(0, &out); u16(method, &out); u16(0, &out); u16(0x21, &out)
        u32(crc, &out); u32(UInt32(body.count), &out); u32(UInt32(data.count), &out); u16(n.count, &out); u16(0, &out)
        out.append(n)
        out.append(body)
        u32(0x0201_4b50, &dir); u16(20, &dir); u16(20, &dir); u16(0, &dir); u16(method, &dir); u16(0, &dir); u16(0x21, &dir)
        u32(crc, &dir); u32(UInt32(body.count), &dir); u32(UInt32(data.count), &dir); u16(n.count, &dir)
        u16(0, &dir); u16(0, &dir); u16(0, &dir); u16(0, &dir); u32(0, &dir); u32(UInt32(offset), &dir)
        dir.append(n)
    }
    let dirOffset = out.count
    out.append(dir)
    u32(0x0605_4b50, &out); u16(0, &out); u16(0, &out); u16(entries.count, &out); u16(entries.count, &out)
    u32(UInt32(dir.count), &out); u32(UInt32(dirOffset), &out); u16(0, &out)
    try! out.write(to: url)
}

let proot = root.appendingPathComponent("patch")
var serialNo = 0
func nextId() -> Int {
    serialNo += 1
    return serialNo
}
let preq = try! ZnBundleRules.parseRequires(["registry": 8, "bytecode": 99, "hostApi": 2, "modules": ["Fetch": 1]])
func listedOf(_ files: [String: Data]) -> [String: (size: Int64, sha: String)] { files.mapValues { (Int64($0.count), sha($0)) } }
/// The base bundle sample_11 on the phone.
let baseFiles = ["main.hbc": oldHbc, "main.zn.ui": Data("ui".utf8), "images/a.png": Data("png".utf8)]
let baseSha = ZnOtaFiles.bundleSha256(listedOf(baseFiles))
/// The new bundle sample_12: main.hbc patched, main.zn.ui the same, images/b.png new.
let newFiles = ["main.hbc": newHbc, "main.zn.ui": Data("ui".utf8), "images/b.png": Data("new png".utf8)]
let newSha = ZnOtaFiles.bundleSha256(listedOf(newFiles))
let pmanifest = ZnOtaSigned.Manifest(app: "sample", id: "sample_12", serial: 12, bundleSha256: newSha, requires: preq,
                                     zipSha256: String(repeating: "z", count: 64), zipSize: 1, url: "/x", signature: "sig")

func pinfo(_ files: [String: Data] = newFiles, sha: String = newSha) -> [String: Any] {
    ["format": 1, "app": "sample", "serial": 12, "id": "sample_12", "sha256": sha,
     "requires": ["registry": 8, "bytecode": 99, "hostApi": 2, "modules": ["Fetch": 1]],
     "files": listedOf(files).mapValues { ["size": $0.size, "sha256": $0.sha] as [String: Any] }, "builtAt": "t"]
}
func patchJson() -> [String: Any] {
    ["format": "znbsdiff1",
     "from": ["id": "sample_11", "sha256": baseSha],
     "to": ["id": "sample_12", "sha256": newSha],
     "files": ["main.hbc": ["patch": "p/main.hbc", "base": "main.hbc"],
               "main.zn.ui": ["copy": "main.zn.ui"],
               "images/b.png": ["zip": "f/images/b.png"]]]
}
func json(_ o: Any) -> Data { try! JSONSerialization.data(withJSONObject: o) }
/// Changes one file's way in zn-patch.json.
func setFile(_ p: inout [String: Any], _ name: String, _ spec: [String: Any]?) {
    var files = p["files"] as! [String: Any]
    files[name] = spec
    p["files"] = files
}
/// A patch zip as the server makes it; [patch], [info] and [edit] change what goes in.
func patchZip(patch: (inout [String: Any]) -> Void = { _ in }, info: [String: Any] = pinfo(),
              edit: (inout [(String, Data)]) -> Void = { _ in }) -> URL {
    var p = patchJson()
    patch(&p)
    var entries: [(String, Data)] = [
        (ZnOtaInstall.patchFile, json(p)), (ZnBundleRules.infoFile, json(info)),
        ("p/main.hbc", hbcPatch), ("f/images/b.png", Data("new png".utf8)),
    ]
    edit(&entries)
    try! FileManager.default.createDirectory(at: proot, withIntermediateDirectories: true)
    let url = proot.appendingPathComponent("p-\(nextId()).zip")
    writeZip(entries, to: url)
    return url
}
func setEntry(_ e: inout [(String, Data)], _ name: String, _ data: Data?) {
    e.removeAll { $0.0 == name }
    if let data { e.append((name, data)) }
}
/// The base bundle's files in a folder, opened by name as ZnOta's patchBase does.
func baseOf(_ files: [String: Data]) -> (String) -> URL? {
    let dir = proot.appendingPathComponent("base-\(nextId())")
    for (name, data) in files {
        let f = dir.appendingPathComponent(name)
        try! FileManager.default.createDirectory(at: f.deletingLastPathComponent(), withIntermediateDirectories: true)
        try! data.write(to: f)
    }
    return { files[$0] != nil ? dir.appendingPathComponent($0) : nil }
}
@discardableResult
func build(_ zip: URL, base: [String: Data] = baseFiles, fromId: String = "sample_11", fromSha: String = baseSha) throws -> URL {
    let dest = proot.appendingPathComponent("dest-\(nextId())")
    try ZnOtaInstall.buildFromPatch(patchZip: zip, manifest: pmanifest, fromId: fromId, fromSha256: fromSha, base: baseOf(base), dest: dest)
    return dest
}
func buildRefused(_ zip: URL, _ part: String, base: [String: Data] = baseFiles, fromId: String = "sample_11",
                  fromSha: String = baseSha, line: Int = #line) {
    do {
        try build(zip, base: base, fromId: fromId, fromSha: fromSha)
        fail("should refuse (\(part))", line: line)
    } catch let e as ZnOtaError {
        eq(e.code, "patch", line: line)
        yes(e.message.contains(part), "\"\(e.message)\" should mention \"\(part)\"", line: line)
    } catch {
        fail("threw \(error)", line: line)
    }
}
let pcaps = ZnCapabilities(registry: 8, bytecode: 99, hostApi: 2, hostApiOldest: 1, modules: ["Fetch": 1])
let pbuiltIn = ZnBundleRules.Info(app: "sample", serial: 0, id: "sample_0", sha256: "x", files: ["main.hbc": 1], requires: preq)

test("aGoodPatchMakesEveryFile") {
    let dest = try build(patchZip())
    eq(try Data(contentsOf: dest.appendingPathComponent("main.hbc")), newHbc)
    eq(ZnOtaFiles.readText(dest.appendingPathComponent("main.zn.ui")), "ui")
    eq(ZnOtaFiles.readText(dest.appendingPathComponent("images/b.png")), "new png")
    no(FileManager.default.fileExists(atPath: dest.appendingPathComponent("images/a.png").path), "the old image isn't in the new bundle")
    let info = try ZnBundleRules.parseInfo(ZnOtaFiles.readText(dest.appendingPathComponent(ZnBundleRules.infoFile))!)
    eq(info.id, "sample_12")
    eq(info.sha256, newSha)
    // The folder passes the same check a downloaded bundle gets at start.
    guard case .ok = ZnBundleRules.checkBundle("sample_12", builtIn: pbuiltIn, caps: pcaps, folder: { _ in dest }) else {
        return fail("the built bundle should pass its checks")
    }
}
test("aWrongBaseIsRefused") {
    // A copied file that differs, a patched file whose old bytes differ, a base file that is missing.
    buildRefused(patchZip(), "main.zn.ui doesn't match its SHA-256", base: baseFiles.merging(["main.zn.ui": Data("UI".utf8)]) { $1 })
    var changed = oldHbc
    changed[0] &+= 1
    buildRefused(patchZip(), "main.hbc doesn't match its SHA-256", base: baseFiles.merging(["main.hbc": changed]) { $1 })
    buildRefused(patchZip(), "has no main.hbc", base: baseFiles.filter { $0.key != "main.hbc" })
    // Another id with the same SHA is the same files (an Android and an iOS store build of the same JS): it builds.
    try build(patchZip(), fromId: "sample_10")
    buildRefused(patchZip(), "another SHA-256 than the base sample_11", fromSha: String(repeating: "0", count: 64))
}
test("aPatchForAnotherBundleIsRefused") {
    buildRefused(patchZip(patch: { $0["to"] = ["id": "sample_13", "sha256": newSha] }), "the manifest says sample_12")
    buildRefused(patchZip(patch: { $0["to"] = ["id": "sample_12", "sha256": String(repeating: "0", count: 64)] }), "the manifest says sample_12")
    buildRefused(patchZip(patch: { $0["format"] = "bsdiff40" }), "format \"bsdiff40\"")
    var other = pinfo()
    other["id"] = "sample_11"
    other["serial"] = 11
    buildRefused(patchZip(info: other), "the manifest says sample/sample_12")
    var needs = pinfo()
    needs["requires"] = ["registry": 9, "bytecode": 99, "hostApi": 2, "modules": ["Fetch": 1]]
    buildRefused(patchZip(info: needs), "needs differ")
}
test("aWrongShaIsRefused") {
    // The listed (signed) SHA of a file isn't what the zip holds: same size, other bytes.
    buildRefused(patchZip(edit: { setEntry(&$0, "f/images/b.png", Data("other p".utf8)) }), "images/b.png doesn't match its SHA-256")
    // A file list that isn't the signed one: refused before any file is made (iOS; Android finds it at the end).
    var bad = pinfo()
    var files = bad["files"] as! [String: Any]
    files["images/b.png"] = ["size": 7, "sha256": sha(Data("other p".utf8))]
    bad["files"] = files
    buildRefused(patchZip(info: bad), "don't match the signed bundle SHA-256")
    // Every file checks out, but zn-bundle.json's bundle SHA claims another bundle.
    buildRefused(patchZip(info: pinfo(sha: String(repeating: "0", count: 64))), "don't match the signed bundle SHA-256")
    // The files of another bundle with their own true SHAs: the bundle SHA no longer matches the manifest.
    let otherFiles = newFiles.merging(["images/b.png": Data("other png".utf8)]) { $1 }
    buildRefused(patchZip(info: pinfo(otherFiles, sha: newSha), edit: { setEntry(&$0, "f/images/b.png", Data("other png".utf8)) }),
                 "don't match the signed bundle SHA-256")
    // A listed size far bigger than any file (a hostile list): refused before anything is read or made.
    files["main.hbc"] = ["size": 1 << 40, "sha256": sha(newHbc)]
    bad["files"] = files
    buildRefused(patchZip(info: bad), "don't match the signed bundle SHA-256")
}
test("znPatchJsonMustCoverExactlyTheListedFiles") {
    buildRefused(patchZip(patch: { setFile(&$0, "extra.js", ["zip": "f/images/b.png"]) }), "has extra.js")
    buildRefused(patchZip(patch: { setFile(&$0, "main.zn.ui", nil) }), "doesn't say how to make main.zn.ui")
    buildRefused(patchZip(patch: { setFile(&$0, "main.zn.ui", ["copy": "main.zn.ui", "zip": "f/images/b.png"]) }), "needs one of copy, patch or zip")
    buildRefused(patchZip(patch: { setFile(&$0, "main.zn.ui", [:]) }), "needs one of copy, patch or zip")
    buildRefused(patchZip(patch: { setFile(&$0, "main.zn.ui", ["copy": 5]) }), "bad path")
    buildRefused(patchZip(patch: { p in
        var files = p["files"] as! [String: Any]
        files["main.zn.ui"] = "copy"
        p["files"] = files
    }), "main.zn.ui isn't an object")
    buildRefused(patchZip(edit: { setEntry(&$0, "f/images/b.png", nil) }), "the patch zip has no f/images/b.png")
    buildRefused(patchZip(edit: { setEntry(&$0, ZnOtaInstall.patchFile, nil) }), "has no zn-patch.json")
    buildRefused(patchZip(edit: { setEntry(&$0, ZnBundleRules.infoFile, nil) }), "has no zn-bundle.json")
    buildRefused(patchZip(edit: { setEntry(&$0, ZnOtaInstall.patchFile, Data("{not json".utf8)) }), "bad zn-patch.json")
    buildRefused(patchZip(patch: { $0["files"] = nil }), "has no files")
}
test("pathTricksAreRefused") {
    for t in ["../main.hbc", "/etc/passwd", "a//b", "..\\x", ""] {
        buildRefused(patchZip(patch: { setFile(&$0, "main.zn.ui", ["copy": t]) }), "bad path")
        buildRefused(patchZip(patch: { setFile(&$0, "images/b.png", ["zip": t]) }), "bad path")
        buildRefused(patchZip(patch: { setFile(&$0, "main.hbc", ["patch": "p/main.hbc", "base": t]) }), "bad path")
        buildRefused(patchZip(patch: { setFile(&$0, "main.hbc", ["patch": t, "base": "main.hbc"]) }), "bad path")
    }
    // A new file outside the bundle folder: zn-bundle.json's own rules refuse it before anything is written.
    var evil = pinfo()
    var files = evil["files"] as! [String: Any]
    files["../evil.so"] = ["size": 1, "sha256": "x"]
    evil["files"] = files
    buildRefused(patchZip(info: evil), "bad file path")
    no(FileManager.default.fileExists(atPath: proot.appendingPathComponent("evil.so").path))
}
test("aPatchEntryOverItsLimitIsStopped") {
    // main.zn.ui is 2 bytes: its patch may unpack to at most 2 × 2 + 1 MiB. Zeros deflate to almost nothing.
    let toPatch: (inout [String: Any]) -> Void = { setFile(&$0, "main.zn.ui", ["patch": "p/main.zn.ui", "base": "main.zn.ui"]) }
    let zip = patchZip(patch: toPatch, edit: { setEntry(&$0, "p/main.zn.ui", Data(count: 2 * 2 + (1 << 20) + 1)) })
    yes(ZnBundleRules.fileSize(zip) < 20_000, "the zip stays small")
    buildRefused(zip, "bigger than its limit of \(2 * 2 + (1 << 20)) bytes")
    // Just at the limit it is read, and refused by the patch checks instead.
    buildRefused(patchZip(patch: toPatch, edit: { setEntry(&$0, "p/main.zn.ui", Data(count: 2 * 2 + (1 << 20))) }), "not a ZNBSDIFF1 patch")
}
test("aWholeFileBiggerThanListedIsStoppedEarly") {
    buildRefused(patchZip(edit: { setEntry(&$0, "f/images/b.png", Data(count: 100_000)) }), "bigger than its listed 7 bytes")
}
test("aCutOrChangedPatchEntryIsRefused") {
    buildRefused(patchZip(edit: { setEntry(&$0, "p/main.hbc", hbcPatch.prefix(hbcPatch.count - 20)) }), "the patch for main.hbc")
    // A changed diff byte still applies, but makes a file whose SHA is wrong.
    var changed = hbcPatch
    changed[24 + 26 * 24 + 5] &+= 1
    buildRefused(patchZip(edit: { setEntry(&$0, "p/main.hbc", changed) }), "main.hbc doesn't match its SHA-256")
}
test("aBadZipOrAnExistingFolderIsRefused") {
    let notZip = proot.appendingPathComponent("not.zip")
    try Data("not a zip".utf8).write(to: notZip)
    buildRefused(notZip, "can't be read")
    let dest = proot.appendingPathComponent("exists")
    try FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
    do {
        try ZnOtaInstall.buildFromPatch(patchZip: patchZip(), manifest: pmanifest, fromId: "sample_11", fromSha256: baseSha,
                                        base: baseOf(baseFiles), dest: dest)
        fail("should refuse an existing folder")
    } catch let e as ZnOtaError {
        eq(e.code, "install")
    }
}
// ZnOtaPatchContractTest: the patch zip server/src/patches.ts buildPatchZip made (setup.ts) builds the new bundle.
test("thePatchZipTheServerMakesBuildsTheNewBundle") {
    let c = fx.appendingPathComponent("patches/contract")
    let m = try ZnOtaSigned.parseManifest(try ZnJSON.object(Data(contentsOf: c.appendingPathComponent("manifest.json"))))
    let baseInfo = try ZnBundleRules.parseInfo(ZnOtaFiles.readText(c.appendingPathComponent("base/zn-bundle.json"))!)
    let ways = try ZnJSON.object(Data(contentsOf: c.appendingPathComponent("files.json")))
    let used = ways.values.compactMap { way in (way as? [String: Any])?.keys.first { key in key != "base" } }
    eq(Set(used), ["copy", "patch", "zip"], "every way is used")
    let dest = proot.appendingPathComponent("contract")
    try ZnOtaInstall.buildFromPatch(patchZip: c.appendingPathComponent("patch.zip"), manifest: m, fromId: baseInfo.id,
                                    fromSha256: baseInfo.sha256,
                                    base: { baseInfo.files[$0] != nil ? c.appendingPathComponent("base/\($0)") : nil }, dest: dest)
    let newInfo = try ZnBundleRules.parseInfo(ZnOtaFiles.readText(c.appendingPathComponent("new/zn-bundle.json"))!)
    for name in Array(newInfo.files.keys) + [ZnBundleRules.infoFile] {
        eq(try Data(contentsOf: dest.appendingPathComponent(name)), try Data(contentsOf: c.appendingPathComponent("new/\(name)")), name)
    }
    let made = try FileManager.default.subpathsOfDirectory(atPath: dest.path).filter { ZnBundleRules.isFile(dest.appendingPathComponent($0)) }
    eq(Set(made), Set(Array(newInfo.files.keys) + [ZnBundleRules.infoFile]), "only the new bundle's files")
    let b = ZnBundleRules.Info(app: "sample", serial: 3, id: "sample_3", sha256: "x", files: ["main.hbc": 1], requires: nil)
    let ccaps = ZnCapabilities(registry: 8, bytecode: 99, hostApi: 2, hostApiOldest: 1, modules: ["Device": 1])
    guard case .ok = ZnBundleRules.checkBundle("sample_12", builtIn: b, caps: ccaps, folder: { _ in dest }) else {
        return fail("the built bundle should pass its checks")
    }
    // The same patch zip on a base whose main.hbc lost a byte: refused, never a wrong bundle.
    var cut = try Data(contentsOf: c.appendingPathComponent("base/main.hbc"))
    cut.removeLast()
    let badBase = proot.appendingPathComponent("contract-base")
    try FileManager.default.createDirectory(at: badBase, withIntermediateDirectories: true)
    try cut.write(to: badBase.appendingPathComponent("main.hbc"))
    do {
        try ZnOtaInstall.buildFromPatch(patchZip: c.appendingPathComponent("patch.zip"), manifest: m, fromId: baseInfo.id,
                                        fromSha256: baseInfo.sha256, base: { name in
                                            name == "main.hbc" ? badBase.appendingPathComponent(name) : c.appendingPathComponent("base/\(name)")
                                        }, dest: proot.appendingPathComponent("contract-bad"))
        fail("a changed base should be refused")
    } catch let e as ZnOtaError {
        eq(e.code, "patch")
    }
}

try? FileManager.default.removeItem(at: root)
print(failures == 0 ? "ok: \(count) tests" : "\(failures) failure(s) in \(count) tests")
exit(failures == 0 ? 0 : 1)
