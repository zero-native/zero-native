// iOS OTA rules on the Mac (tools/ios-ota-test.ts builds this with ZnOtaRules.swift and ZnOtaInstall.swift). The same
// cases as Android's JVM tests, so the two copies of the rules can't drift apart silently:
// ZnOtaHealthTest, ZnBundlesTest, ZnOtaStoreTest, ZnOtaSignatureTest, ZnOtaInstallTest.
// Arguments: <ota-signature-fixture.json> <folder from make-fixture.ts>
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

try? FileManager.default.removeItem(at: root)
print(failures == 0 ? "ok: \(count) tests" : "\(failures) failure(s) in \(count) tests")
exit(failures == 0 ? 0 : 1)
