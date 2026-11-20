// The update client on iOS (android/runtime ZnOta.kt, ZnBundles.kt, ZnOtaHealth.kt; docs/ota.md §3.5–3.6;
// docs/ota.md, docs/milestones-ios.md). The rules are ZnOtaRules.swift (tested on the Mac: `bun run ios:ota-test`); this
// file is the iOS side: files, network, timers, the app's life.
//
// Apps turn it on before ZnApp.start, after registering their plugins:
//
//     ZnOta.configure(ZnOta.Config(server: "https://updates.example.com", channel: "production",
//                                  publicKeys: [MAIN_KEY, BACKUP_KEY]))
//
// Then ZnApp.start runs the bundle `zn-ota/current` names when it passes every check, else the app's own bundle (the
// built-in one, in the app's resources with its zn-bundle.json). Same protocol and the same rules as Android:
// - a check a few seconds after the app comes on screen and on returns (at most every checkIntervalMs), never in the
//   background; POST /v1/check with the app's capabilities, then GET the zip;
// - a pointer counts only if signed, for this app and channel, with a seq above the highest one this phone accepted;
// - the bundle must be signed, fit this app (requires), be newer than the built-in one; every file's SHA is checked;
// - safety nets: a downloaded bundle is healthy after its first screens were up healthyAfterMs in the foreground; an
//   error before that blocks it and goes back to the last good bundle (or the built-in one); launches ended by a crash
//   block it (a crash mark makes it sure: one; otherwise two).
//
// iOS differences:
// - Files: Application Support/zn-ota, kept out of backups. The app build is "<version> (<build>)" and its install
//   time is the executable's date (Android: versionCode and lastUpdateTime).
// - How a launch ended: iOS keeps no exit records (Android's ApplicationExitInfo). A crash mark written by signal and
//   exception handlers says "crash" (sure); a launch that ended on screen with no mark counts as unsure.
// - No patches yet: the check says it reads none, so the server sends full zips.
// - Not yet (plan steps 5, 7): applying an update while the app runs (applyNow answers "not_started"), the launch
//   gate, rollback in place: a rollback makes the good bundle current and it runs from the next start.
import UIKit
#if SWIFT_PACKAGE
import ZnHost
#endif

// MARK: - Bundles: what runs (ZnBundles.kt)

public enum ZnBundles {
    /// The bundle this process runs. [dir] nil: the built-in bundle (the app's resources).
    struct Running: CustomStringConvertible {
        let info: ZnBundleRules.Info?
        let dir: URL?
        var builtIn: Bool { dir == nil }
        /// nil for the built-in bundle, else the bundle id.
        var key: String? { builtIn ? nil : info?.id }
        /// How reports name this bundle: `sample_12@1a2b3c4d5e6f` (id and the first 12 characters of its SHA).
        var label: String? { info.map { "\($0.id)@\($0.sha256.prefix(12))" } }
        var description: String { "\(info.map { "\($0)" } ?? "unnamed bundle") \(builtIn ? "built-in" : "from files")" }
    }

    /// The app's own bundle folder (set by ZnApp.start).
    nonisolated(unsafe) public private(set) static var builtInURL: URL = Bundle.main.resourceURL ?? Bundle.main.bundleURL
    nonisolated(unsafe) private static var builtInRead = false
    nonisolated(unsafe) private static var builtInInfo: ZnBundleRules.Info?
    nonisolated(unsafe) private(set) static var running: Running?
    private static let lock = NSLock()

    /// The app's own bundle info (its zn-bundle.json), or nil: OTA bundles are then off.
    static var builtIn: ZnBundleRules.Info? {
        lock.withLock {
            if !builtInRead {
                builtInRead = true
                let url = builtInURL.appendingPathComponent(ZnBundleRules.infoFile)
                do {
                    builtInInfo = try ZnBundleRules.parseInfo(String(contentsOf: url, encoding: .utf8))
                } catch {
                    print("zn-ota: bundle: no readable \(ZnBundleRules.infoFile) in the app (\(error)); OTA bundles are off")
                }
            }
            return builtInInfo
        }
    }

    /// The OTA folder: Application Support/zn-ota, not in backups (a restored bundle could be for another app build).
    static let otaDir: URL = {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        var dir = support.appendingPathComponent("zn-ota", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return dir
    }()

    static func folder(_ id: String) -> URL { otaDir.appendingPathComponent("bundles/\(id)", isDirectory: true) }
    static var currentFile: URL { otaDir.appendingPathComponent("current") }
    static func readCurrent() -> String? {
        ZnOtaFiles.readText(currentFile)?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    /// The folder to start from (main thread, ZnApp.start, once per process). [builtIn]: the app's own bundle folder.
    /// With OTA off this is [builtIn]. Never throws: whatever goes wrong, the built-in bundle runs.
    static func choose(builtIn url: URL) -> Running {
        builtInURL = url
        if let r = running { return r }
        let t0 = CACurrentMediaTime()
        let info = builtIn
        var pick = Running(info: info, dir: nil)
        if ZnOta.isConfigured, let info {
            do {
                let off = try ZnOtaHealth.atStart()
                if !off, let d = downloaded(info) { pick = d }
                ZnOtaHealth.guardOk()
            } catch {
                // Startup guard (docs/ota.md §3.6): the built-in bundle runs, and OTA is off in this process (twice in
                // a row: until the next app install).
                print("zn-ota: bundle: choosing failed, running the built-in bundle: \(error)")
                ZnOtaHealth.guardFailed(error)
                pick = Running(info: info, dir: nil)
            }
        }
        running = pick
        print("zn-ota: bundle: running \(pick) (\(pick.label ?? "no label")), chosen in \(String(format: "%.2f", (CACurrentMediaTime() - t0) * 1000)) ms")
        if ZnOta.isConfigured { ZnOtaHealth.onChosen(pick) }
        return pick
    }

    /// The downloaded bundle `current` names, if it may run; nil if not. A blocked one never runs, nor one that fails
    /// its checks: the last good bundle runs instead if it can (and becomes current), else the built-in one.
    private static func downloaded(_ builtIn: ZnBundleRules.Info) -> Running? {
        guard var id = readCurrent() else { return nil }
        if ZnOtaHealth.isBlocked(id) {
            let good = ZnOtaHealth.lastGood.flatMap { $0 != id && !ZnOtaHealth.isBlocked($0) ? $0 : nil }
            print("zn-ota: bundle: \(id) is blocked on this phone; running \(good ?? "the built-in bundle")")
            guard let good else {
                try? FileManager.default.removeItem(at: currentFile)
                return nil
            }
            try? ZnOtaFiles.writeAtomic(currentFile, good)
            id = good
        }
        let caps = ZnCapabilities.current()
        switch tryBundle(id, builtIn, caps) {
        case let .ok(info): return Running(info: info, dir: folder(id))
        case let .no(reason, superseded):
            if superseded {
                print("zn-ota: bundle: not running \(id): \(reason) (a store update came after it)")
                ZnOtaHealth.superseded(id, reason)
            } else {
                print("zn-ota: bundle: not running \(id): \(reason) (this app: \(caps))")
                ZnOtaHealth.unusable(id, reason)
            }
        }
        if ZnOtaHealth.lastGood == id { ZnOtaHealth.forgetGood(id) }
        if let good = ZnOtaHealth.lastGood, !ZnOtaHealth.isBlocked(good) {
            if case let .ok(info) = tryBundle(good, builtIn, caps) {
                print("zn-ota: bundle: running the last good bundle \(good) instead")
                try? ZnOtaFiles.writeAtomic(currentFile, good)
                return Running(info: info, dir: folder(good))
            }
            ZnOtaHealth.forgetGood(good)
        }
        print("zn-ota: bundle: running the built-in bundle")
        try? FileManager.default.removeItem(at: currentFile)
        return nil
    }

    /// What runs now, after a swap (ZnOta.swap).
    static func switchTo(_ r: Running) { running = r }

    /// What the next start would run (`current` now, with every check), never [exclude]. Client queue or main thread.
    static func candidate(exclude: String? = nil) -> Running {
        let info = builtIn
        guard let info, ZnOta.isConfigured, !ZnOtaHealth.offInProcess else { return Running(info: info, dir: nil) }
        if let exclude, readCurrent() == exclude {
            if let good = ZnOtaHealth.lastGood, good != exclude, !ZnOtaHealth.isBlocked(good) {
                try? ZnOtaFiles.writeAtomic(currentFile, good)
            } else {
                try? FileManager.default.removeItem(at: currentFile)
            }
        }
        return downloaded(info) ?? Running(info: info, dir: nil)
    }

    /// Every check on bundle [id], templates too (TemplateReader refuses ids this app doesn't know).
    static func tryBundle(_ id: String, _ builtIn: ZnBundleRules.Info, _ caps: ZnCapabilities) -> ZnBundleRules.Check {
        let v = ZnBundleRules.checkBundle(id, builtIn: builtIn, caps: caps, folder: folder)
        guard case let .ok(info) = v else { return v }
        if let problem = readTemplates(folder(id), info) { return .no(problem) }
        return v
    }

    /// Why a bundle's templates can't be drawn by this app, or nil. The safety net under the build's `requires`.
    static func readTemplates(_ dir: URL, _ info: ZnBundleRules.Info) -> String? {
        for name in info.files.keys where name.hasSuffix(".zn.ui") {
            do {
                _ = try TemplateReader.read(Data(contentsOf: dir.appendingPathComponent(name), options: .mappedIfSafe))
            } catch {
                return "its templates use something this app doesn't have (\(name): \(error))"
            }
        }
        return nil
    }

    /// Where `asset:<path>` loads from: the running bundle's copy when it lists one, else the app's own (an update
    /// ships only the images it changed or added).
    public static func assetURL(_ path: String) -> URL {
        if let r = running, let dir = r.dir, r.info?.files[path] != nil { return dir.appendingPathComponent(path) }
        return builtInURL.appendingPathComponent(path)
    }

    /// Installed bundles this app can still run, newest first. Blocked ones are not offered.
    static func kept(_ builtIn: ZnBundleRules.Info, _ caps: ZnCapabilities) -> [String] {
        let blocked = Set(ZnOtaHealth.blocked().map(\.0))
        let names = (try? FileManager.default.contentsOfDirectory(atPath: otaDir.appendingPathComponent("bundles").path)) ?? []
        return names.filter { !blocked.contains($0) }.compactMap { name -> ZnBundleRules.Info? in
            if case let .ok(info) = ZnBundleRules.checkBundle(name, builtIn: builtIn, caps: caps, folder: folder) { return info }
            return nil
        }.sorted { $0.serial > $1.serial }.map(\.id)
    }
}

extension ZnCapabilities {
    /// This app's capabilities now: modules registered later are not in it (apps register theirs before ZnApp.start).
    static func current() -> ZnCapabilities {
        ZnCapabilities(registry: Registry.version, bytecode: ZNHost.bytecodeVersion, hostApi: ZNHost.hostApiVersion,
                       hostApiOldest: ZNHost.hostApiOldest, modules: ZnModules.versions())
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - Safety nets' memory (ZnOtaHealth.kt)

enum ZnOtaHealth {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var state: ZnOtaHealthRules.State?
    nonisolated(unsafe) private static var file: URL?
    /// The bundle marked healthy in this process (nil: none).
    nonisolated(unsafe) static var healthyBundle: String?
    /// OTA is off in this process: the startup guard caught an error, or the fuse is blown.
    nonisolated(unsafe) private(set) static var offInProcess = false
    /// The first process since a new app install.
    nonisolated(unsafe) private(set) static var appChanged = false
    nonisolated(unsafe) private(set) static var inFront = false
    nonisolated(unsafe) private static var chosen: ZnBundles.Running?
    nonisolated(unsafe) private static var crashMarkFile: URL?

    private static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    private static func load() -> ZnOtaHealthRules.State {
        if let state { return state }
        guard let file else { return ZnOtaHealthRules.State() }  // before atStart: nothing known, nothing kept
        var s = ZnOtaHealthRules.State()
        if let text = ZnOtaFiles.readText(file) {
            do { s = try ZnOtaHealthRules.State.fromJson(text) } catch { print("zn-ota: health: health.json can't be read (\(error)); starting fresh") }
        }
        state = s
        return s
    }

    @discardableResult
    private static func edit<T>(sync: Bool = true, _ block: (ZnOtaHealthRules.State) -> T) -> T {
        lock.withLock {
            let s = load()
            let r = block(s)
            if let file { try? ZnOtaFiles.writeAtomic(file, s.toJson(), sync: sync) }
            return r
        }
    }

    private static func read<T>(_ block: (ZnOtaHealthRules.State) -> T) -> T { lock.withLock { block(load()) } }

    static func isBlocked(_ id: String) -> Bool { read { $0.isBlocked(id) } }
    static func blocked() -> [(String, String)] { read { $0.blocked } }
    static var lastGood: String? { read { $0.lastGood } }
    static func errorsRollBack(_ id: String) -> Bool { read { ZnOtaHealthRules.errorsRollBack($0, id) } }

    /// Events not yet delivered, oldest first; they are removed.
    static func takeEvents() -> [ZnOtaHealthRules.Event] {
        lock.withLock {
            let s = load()
            if s.events.isEmpty { return [] }
            let out = s.events
            s.events.removeAll()
            if let file { try? ZnOtaFiles.writeAtomic(file, s.toJson()) }
            return out
        }
    }

    /// The app build ("1.0 (5)") and when it was installed (the executable's date, ms).
    static var appBuild: (version: String, installed: Int64) {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = "\(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))"
        let exe = Bundle.main.executableURL ?? Bundle.main.bundleURL
        let date = (try? FileManager.default.attributesOfItem(atPath: exe.path))?[.modificationDate] as? Date
        return (version, Int64((date?.timeIntervalSince1970 ?? 0) * 1000))
    }

    /// Once per process, when the bundle is chosen: the app build check and the watchdog. True if OTA must stay off.
    static func atStart() throws -> Bool {
        let t0 = CACurrentMediaTime()
        let dir = ZnBundles.otaDir
        lock.withLock { file = dir.appendingPathComponent("health.json") }
        let markFile = dir.appendingPathComponent(crashMarkName)
        let mark = ZnOtaFiles.readText(markFile)
        if mark != nil { try? FileManager.default.removeItem(at: markFile) }
        crashMarkFile = markFile
        let build = appBuild
        let fuse = lock.withLock { () -> Bool in
            let s = load()
            let before = s.toJson()
            let blockedBefore = s.blocked.map { "\($0.0)=\($0.1)" }
            appChanged = ZnOtaHealthRules.atStart(s, appVersion: build.version, appUpdated: build.installed, now: now()) { since, pid in
                exitOf(since: since, pid: pid, mark: mark)
            }
            let after = s.toJson()
            if after != before, let file {
                try? ZnOtaFiles.writeAtomic(file, after, sync: s.blocked.map { "\($0.0)=\($0.1)" } != blockedBefore)
            }
            return ZnOtaHealthRules.fuseBlown(s)
        }
        if fuse {
            offInProcess = true
            print("zn-ota: health: OTA is off until the next app install (its start-up failed twice in a row)")
        }
        print("zn-ota: health: start checks in \(String(format: "%.2f", (CACurrentMediaTime() - t0) * 1000)) ms\(appChanged ? " (new app install)" : "")")
        ZnOta.deliverSoon()
        return fuse
    }

    static func guardOk() {
        if read({ $0.guardFails }) != 0 { edit(sync: false) { $0.guardFails = 0 } }
    }

    static func guardFailed(_ e: Error) {
        offInProcess = true
        edit { s in
            ZnOtaHealthRules.event(s, "init_failed", nil, "\(e)", now())
            if ZnOtaHealthRules.guardFailed(s) {
                ZnOtaHealthRules.event(s, "ota_off", nil, "OTA start-up failed twice in a row; off until the next app install", now())
            }
        }
        ZnOta.deliverSoon()
    }

    /// How process [pid], which left a pending launch at [since], ended. iOS keeps no exit records: the crash mark says
    /// "crash" for sure; a phone restart since then is not counted; anything else counts, unsure.
    private static func exitOf(since: Int64, pid: Int32, mark: String?) -> ZnOtaHealthRules.Exit {
        if ZnOtaHealthRules.isCrashOf(mark, pid: pid, since: since) {
            print("zn-ota: health: the last launch ended: crash (counted, from the crash mark)")
            return .counts("crash", sure: true)
        }
        if since < bootTimeMs() { return .ignored("the phone restarted") }
        print("zn-ota: health: the last launch ended while on screen (counted, iOS can't say why)")
        return .counts("ended while on screen (iOS can't say why)", sure: false)
    }

    private static func bootTimeMs() -> Int64 {
        var tv = timeval()
        var size = MemoryLayout<timeval>.size
        var mib: [Int32] = [CTL_KERN, KERN_BOOTTIME]
        guard sysctl(&mib, 2, &tv, &size, nil, 0) == 0 else { return 0 }
        return Int64(tv.tv_sec) * 1000 + Int64(tv.tv_usec) / 1000
    }

    // ---- The crash mark ----

    static let crashMarkName = "crash-mark"

    /// Leaves "<pid> <ms>" in the crash mark when the process crashes (a signal: Swift traps, bad memory, abort; or an
    /// uncaught Objective-C exception), then hands the crash to the handler that was there before (Crashlytics), so
    /// crash reports keep working. Only while a downloaded bundle runs (only its launches are judged), and
    /// [crashMarkDelay] after the start: crash reporters install theirs while the app starts, and one installed after
    /// ours warns it "will interfere" (Crashlytics, 2026-11-10). A crash before that counts as unsure. Only
    /// async-signal-safe calls in the signal path.
    static let crashMarkDelay: TimeInterval = 3
    private static func watchCrashes(_ markFile: URL) {
        guard !znCrashMarkInstalled else { return }
        znCrashMarkInstalled = true
        znCrashMarkPath = strdup(markFile.path)
        znCrashMarkPid = getpid()
        znPreviousExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler { e in
            znWriteCrashMark()
            znPreviousExceptionHandler?(e)
        }
        for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGFPE] {
            var action = sigaction()
            action.__sigaction_u.__sa_sigaction = { sig, info, context in
                znWriteCrashMark()
                guard sig > 0 && sig < 32 else { return }
                let old = znPreviousActions[Int(sig)]
                // The handler before ours (a crash reporter): called as the system would have.
                if old.sa_flags & SA_SIGINFO != 0, let f = old.__sigaction_u.__sa_sigaction { return f(sig, info, context) }
                if let h = old.__sigaction_u.__sa_handler, unsafeBitCast(h, to: Int.self) != 1 { return h(sig) }  // 1: SIG_IGN
                // None: the default back, then return; the fault happens again, or abort() raises again, and the
                // process ends as it would have.
                sigaction(sig, znPreviousActions + Int(sig), nil)
            }
            action.sa_flags = SA_SIGINFO
            sigemptyset(&action.sa_mask)
            var old = sigaction()
            sigaction(sig, &action, &old)
            znPreviousActions[Int(sig)] = old
        }
        print("zn-ota: health: crash mark on")
    }

    // ---- Launches (UI) ----

    static func onChosen(_ r: ZnBundles.Running) {
        chosen = r
        if !r.builtIn, let file = crashMarkFile {
            DispatchQueue.main.asyncAfter(deadline: .now() + crashMarkDelay) { watchCrashes(file) }
        }
        if inFront { markLaunch() }
    }

    static func onFront() {
        inFront = true
        markLaunch()
    }

    static func onBack() {
        inFront = false
        guard let id = chosen?.key else { return }
        if read({ $0.pending == id }) { edit(sync: false) { ZnOtaHealthRules.ended($0, id) } }
    }

    private static func markLaunch() {
        guard let r = chosen else { return }
        guard let id = r.key, !offInProcess else {
            if read({ $0.pending != nil }) { edit(sync: false) { $0.pending = nil } }
            return
        }
        if read({ $0.pending == id }) { return }
        edit(sync: false) { ZnOtaHealthRules.launch($0, id, now: now(), pid: getpid()) }
        print("zn-ota: health: launch of \(id) marked")
    }

    @discardableResult
    static func markHealthy(_ id: String) -> Bool {
        healthyBundle = id
        return edit { ZnOtaHealthRules.healthy($0, id) }
    }

    static func block(_ id: String, _ why: String, kind: String?, detail: String?, stack: String? = nil, sha: String? = nil) {
        edit { s in
            ZnOtaHealthRules.block(s, id, why)
            if let kind { ZnOtaHealthRules.event(s, kind, id, detail, now(), stack: stack, sha: sha) }
        }
    }

    /// [id] threw while starting: an unsure death, also for the last good bundle. True if now blocked.
    static func startFailed(_ id: String) -> Bool {
        edit(sync: false) { ZnOtaHealthRules.countDeath($0, id, "start failed", limit: ZnOtaHealthRules.watchdogLimit, now: now()) }
    }

    static func superseded(_ id: String, _ reason: String) {
        edit(sync: false) { ZnOtaHealthRules.superseded($0, id, reason, now: now()) }
    }

    static func unusable(_ id: String, _ reason: String) {
        edit(sync: false) { ZnOtaHealthRules.unusable($0, id, reason, now: now()) }
        ZnOta.deliverSoon()
    }

    static func forgetGood(_ id: String) {
        if read({ $0.lastGood == id }) { edit { $0.lastGood = nil } }
    }
}

// The crash mark's globals: set once, read in a signal handler (no Swift runtime work there).
nonisolated(unsafe) private var znCrashMarkInstalled = false
nonisolated(unsafe) private var znCrashMarkPath: UnsafeMutablePointer<CChar>?
nonisolated(unsafe) private var znCrashMarkPid: Int32 = 0
nonisolated(unsafe) private var znCrashMarkWritten = false
nonisolated(unsafe) private var znPreviousExceptionHandler: (@convention(c) (NSException) -> Void)?
nonisolated(unsafe) private let znPreviousActions: UnsafeMutablePointer<sigaction> = {
    let p = UnsafeMutablePointer<sigaction>.allocate(capacity: 32)
    p.initialize(repeating: sigaction(), count: 32)
    return p
}()

/// Writes "<pid> <ms>" to the crash mark with open / write / close only.
private func znWriteCrashMark() {
    guard !znCrashMarkWritten, let path = znCrashMarkPath else { return }
    znCrashMarkWritten = true
    var ts = timespec()
    clock_gettime(CLOCK_REALTIME, &ts)
    let ms = Int64(ts.tv_sec) * 1000 + Int64(ts.tv_nsec) / 1_000_000
    var buf = [UInt8](repeating: 0, count: 48)
    var n = 0
    func put(_ v: Int64) {
        var digits = [UInt8](repeating: 0, count: 20)
        var x = v, d = 0
        repeat { digits[d] = UInt8(48 + x % 10); x /= 10; d += 1 } while x > 0 && d < 20
        while d > 0 { d -= 1; buf[n] = digits[d]; n += 1 }
    }
    put(Int64(znCrashMarkPid))
    buf[n] = 32
    n += 1
    put(ms)
    let fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    if fd >= 0 {
        _ = buf.withUnsafeBytes { write(fd, $0.baseAddress, n) }
        close(fd)
    }
}

// MARK: - The client (ZnOta.kt)

/// One outcome of the update client: [kind] as sent to the server (docs/ota.md §3.7). [serious]: a safety net acted or
/// a signed file didn't check out.
public struct ZnOtaReport: CustomStringConvertible {
    public let kind: String
    public let bundle: String?
    public let detail: String?
    public let serious: Bool
    public let stack: String?
    public var description: String { "\(kind)\(bundle.map { " \($0)" } ?? "")\(detail.map { ": \($0)" } ?? "")" }
}

public final class ZnOta: @unchecked Sendable {
    public struct Config {
        /// The update server's base URL.
        public var server: String
        /// "production", "staging", ...
        public var channel: String
        /// Trusted public keys, base64 SPKI DER: the main key first, the offline backup key second.
        public var publicKeys: [String]
        /// Least time between two automatic checks (on returns). 0: a check on every return (at most one per minCheckGapMs).
        public var checkIntervalMs: Double = 5 * 60_000
        /// Two automatic checks are never closer than this. 0: no floor.
        public var minCheckGapMs: Double = 5_000
        /// Wait after the app comes on screen before the first check, so startup is never slowed.
        public var firstCheckDelayMs: Double = 3_000
        /// Wait before the check on a return from the background (Android: Config.returnCheckDelayMs, Pavan 2026-11-10:
        /// a 3 s wait made a store update screen come ~4 s after the return).
        public var returnCheckDelayMs: Double = 1_000
        /// A downloaded bundle is healthy once its first screens were up this long in the foreground. 0: only when JS
        /// calls `Updates.markHealthy()`.
        public var healthyAfterMs: Double = 4_000
        /// A downloaded bundle whose first screens aren't up this long after the app came on screen is rolled back.
        public var firstScreenTimeoutMs: Double = 10_000
        /// Hears every outcome on the main thread (an app's crash reporter).
        public var onReport: ((ZnOtaReport) -> Void)? = nil
        /// Runs on a JS error's text before it is stored or sent, after the built-in masks.
        public var redact: ((String) -> String)? = nil
        /// A release build may use an `http://` server only with this on (a test against a server on this Mac).
        public var allowHttpInRelease = false
        /// The launch gate (ZnOtaGate): at a cold start the check runs at once and the launch screen waits for its
        /// answer at most this long from the tap. 0: no gate (the first check comes firstCheckDelayMs later).
        public var launchDecisionMs: Double = 800
        /// A priority high update may hold the start this long from the tap (the update screen), critical this long.
        public var launchCapMs: Double = 4_000
        public var launchCapCriticalMs: Double = 5_800
        /// How the update screen looks.
        public var updateScreen = ZnUpdateScreen()

        public init(server: String, channel: String, publicKeys: [String]) {
            self.server = server
            self.channel = channel
            self.publicKeys = publicKeys
        }
    }

    public static let shared = ZnOta()
    nonisolated(unsafe) private(set) static var config: Config?
    static var isConfigured: Bool { config != nil }

    private static let keep = 4
    private static let maxOutcomes = 20
    private static let checkTimeout: TimeInterval = 30
    private static let maxCheckAnswer = 256 * 1024
    private static let downloadIdleTimeout: TimeInterval = 60
    /// An unzipped bundle is about 3× its zip; this leaves room. And an update never leaves less than 50 MB free.
    private static let unzipFactor: Int64 = 4
    private static let minFreeBytes: Int64 = 50 * 1024 * 1024
    private static let serious: Set<String> = [
        "error_rollback", "launch_crashed", "watchdog_block", "apply_failed", "init_failed", "ota_off", "signature", "zip_sha",
        "bundle_unusable",
    ]

    /// The client's own serial queue: one check at a time, file writes in order.
    private let worker = DispatchQueue(label: "zn-ota", qos: .utility)
    private let stateLock = NSLock()
    /// Guards phase, progress and holds (read by status() on any thread).
    private let fieldsLock = NSLock()
    private var phase = "off"
    private var progress = 0.0
    private var lastAutoCheck: CFTimeInterval = 0
    private var checkQueued = false
    private var appCleaned = false
    /// Open `Updates.hold` calls from JS (fieldsLock).
    private var holds: [ObjectIdentifier: ZnCall] = [:]
    // Main thread: the safety nets' timers and facts.
    private var inFront = false
    private var frontOnce = false
    private var wentBack = false
    private var screensAreUp = false
    private var healthyTimer: DispatchWorkItem?
    private var firstScreenTimer: DispatchWorkItem?
    /// Bundles rolled back in this process (main thread).
    private var rolledBack = Set<String>()

    /// The client's phase and download progress (the launch gate's bar).
    func phaseAndProgress() -> (String, Double) { fieldsLock.withLock { (phase, progress) } }

    /// The launch gate's outcome (gate_swap, gate_timeout) for the next check.
    func gateOutcome(_ kind: String, _ detail: String) {
        worker.async { [self] in record(kind, ZnBundles.readCurrent() ?? "built-in", detail, running: nil) }
    }

    /// Main thread, from ZnApp.start at a cold start: the launch gate checks now.
    @MainActor static func beginLaunchGate() {
        guard isConfigured, !ZnOtaHealth.offInProcess else { return }
        ZnOtaGate.beginCold {
            let s = shared
            s.lastAutoCheck = CACurrentMediaTime() * 1000
            s.frontOnce = true  // the first time in front doesn't check again
            s.worker.async { _ = s.runCheck() }
        }
    }

    /// JS holds updates (`Updates.hold`): a pending one waits for the next start.
    var isHeld: Bool { fieldsLock.withLock { !holds.isEmpty } }

    /// Turns the client on. Call once, before ZnApp.start, after the app's plugins are registered.
    public static func configure(_ c: Config) {
        precondition(!c.publicKeys.isEmpty, "ZnOta needs at least one public key")
        precondition(c.server.hasPrefix("https://") || c.server.hasPrefix("http://"), "ZnOta server must be an http(s) URL")
        precondition(c.channel.range(of: "^[a-z][a-z0-9-]{0,31}$", options: .regularExpression) != nil,
                     "ZnOta channel \"\(c.channel)\": use a-z, 0-9 and -")
        #if !DEBUG
        if c.server.hasPrefix("http://") && !c.allowHttpInRelease {
            print("zn-ota: OTA is off: a release build needs an https:// server, not \(c.server)")
            return
        }
        #endif
        config = c
        shared.fieldsLock.withLock { shared.phase = "idle" }
        ZnModules.register(Module())
        let nc = NotificationCenter.default
        // "In front" is active: a launch stops counting when the app goes inactive, not only to the background. A
        // swipe in the app switcher can end the app while it is only inactive; that must not count as a crash.
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in shared.onFront() }
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in shared.onBack() }
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { _ in
            shared.wentBack = true
            shared.onBack()
        }
        nc.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { _ in shared.onBack() }
        deliverSoon()
    }

    /// The OTA app id (the built-in bundle's) and the channel, or nil while OTA is off (the push plugin's topic).
    public static func appAndChannel() -> (app: String, channel: String)? {
        guard let c = config, let app = ZnBundles.builtIn?.app else { return nil }
        return (app, c.channel)
    }

    // MARK: Status (Updates.status / onStatus)

    func status() -> [String: Any] {
        guard let c = Self.config else { return ["enabled": false, "phase": "off"] }
        let fields = fieldsLock.withLock { (phase: phase, progress: progress, held: !holds.isEmpty) }
        let running = ZnBundles.running?.key
        let next = ZnBundles.readCurrent()
        let st = stateLock.withLock { loadState() }
        let blocked = Dictionary(ZnOtaHealth.blocked(), uniquingKeysWith: { _, b in b })
        return [
            "enabled": true, "phase": fields.phase, "progress": fields.progress, "channel": c.channel,
            "running": running ?? NSNull(), "builtIn": ZnBundles.builtIn?.id ?? NSNull(), "next": next ?? NSNull(),
            "pendingRestart": next != running, "nextPriority": next != running ? st.nextPriority : 0,
            "held": fields.held, "healthy": running == nil || ZnOtaHealth.healthyBundle == running,
            "lastGood": ZnOtaHealth.lastGood ?? NSNull(), "blocked": blocked, "otaOff": ZnOtaHealth.offInProcess,
            "lastCheckAt": st.lastCheckAt > 0 ? st.lastCheckAt : NSNull(),
            "lastResult": st.lastResult ?? NSNull(), "lastError": st.lastError ?? NSNull(),
            "store": st.storeAnswer(Self.storeKey).flatMap { try? ZnJSON.object(Data($0.utf8)) } ?? NSNull(),
        ]
    }

    private func setPhase(_ p: String, _ prog: Double = 0) {
        fieldsLock.withLock {
            phase = p
            progress = prog
        }
        emitStatus()
    }

    /// The main script is queued on the JS thread (fieldsLock): status events go only from then on, as Android's
    /// `ZnRuntime.isStarted`. An event posted earlier would run before the script and find no `__zn_onEvent`; one
    /// posted after it runs after the script, and JS drops it if nobody listens. Not JS's listener count: that comes
    /// through the main thread, which is busy building the first screens when the launch check often ends, so the
    /// launch check's event was lost (ZeroBill's forced store screen waited for the next check, 2026-11-11).
    private var jsQueued = false

    /// ZnApp, on the main thread, right before it posts the main script.
    static func mainScriptQueued() { shared.fieldsLock.withLock { shared.jsQueued = true } }

    private func emitStatus() {
        guard fieldsLock.withLock({ jsQueued }) else { return }
        let s = status()
        DispatchQueue.main.async { ZnModules.emit("Updates", "status", s, latestOnly: true) }
    }

    // MARK: Checks

    private func onFront() {
        guard !inFront else { return }
        inFront = true
        ZnOtaHealth.onFront()
        if !screensAreUp { armFirstScreen() } else { armHealthy() }
        // Checks at the first start and on returns from the background; not after a system alert or Control Center
        // (active again, never in the background).
        if !frontOnce || wentBack { maybeAutoCheck(returning: frontOnce) }
        frontOnce = true
        wentBack = false
    }

    private func onBack() {
        inFront = false
        stopTimers()
        ZnOtaHealth.onBack()
    }

    private func maybeAutoCheck(returning: Bool) {
        guard let c = Self.config else { return }
        let now = CACurrentMediaTime() * 1000
        if checkQueued || (lastAutoCheck != 0 && now - lastAutoCheck < max(c.checkIntervalMs, c.minCheckGapMs)) { return }
        lastAutoCheck = now
        checkQueued = true
        let delayMs = returning ? c.returnCheckDelayMs : c.firstCheckDelayMs
        DispatchQueue.main.asyncAfter(deadline: .now() + delayMs / 1000) { [self] in
            checkQueued = false  // main thread, as the rest of the auto-check facts
            worker.async { [self] in _ = runCheck() }
        }
    }

    /// Runs a check now (on the client's queue); [done] gets the result there.
    public func check(_ done: @escaping ([String: Any]) -> Void) {
        worker.async { [self] in done(runCheck()) }
    }

    /// One check, start to end. Never throws: problems become the result and an outcome for telemetry.
    private func runCheck() -> [String: Any] {
        guard let c = Self.config else { return ["action": "NONE", "reason": "OFF"] }
        if ZnOtaHealth.offInProcess { return ["action": "NONE", "reason": "OTA_OFF"] }
        let t0 = CACurrentMediaTime()
        deliver()
        let st = stateLock.withLock { loadState() }
        do {
            guard let builtIn = ZnBundles.builtIn else { throw ZnOtaError("setup", "the app has no zn-bundle.json") }
            setPhase("checking")
            if ZnOtaHealth.appChanged && !appCleaned {
                appCleaned = true
                cleanUpAfterNewApp(builtIn)
            }
            noteRunning(st)
            let answer = try post(c, builtIn, st)
            st.outcomes.removeAll()  // they reached the server
            keepStoreAnswer(st, answer)  // before act: a bundle problem must not lose the store answer
            let result = try act(c, builtIn, st, answer)
            st.lastCheckAt = Int64(Date().timeIntervalSince1970 * 1000)
            st.lastResult = "\(result["action"] ?? "") \(result["reason"] ?? "")"
            st.lastError = nil
            stateLock.withLock { saveState(st) }
            setPhase("idle")
            print("zn-ota: check \(c.channel): \(st.lastResult ?? "") in \(Int((CACurrentMediaTime() - t0) * 1000)) ms")
            ZnOtaGate.checkDone(ready: ZnBundles.readCurrent() != ZnBundles.running?.key, priority: st.nextPriority,
                                result: st.lastResult ?? "")
            return result
        } catch {
            let e = error as? ZnOtaError ?? ZnOtaError("failed", "\(error)")
            print("zn-ota: check failed (\(e.code)): \(e.message)")
            stateLock.withLock {
                // The same failure again (offline, every return) takes the last one's place, not a new one (#217)
                if let last = st.outcomes.last, last["bundle"] == nil, !Self.serious.contains(e.code),
                   last["kind"] as? String == e.code {
                    st.outcomes.removeLast()
                }
                outcome(st, e.code, nil, e.message)
                st.lastCheckAt = Int64(Date().timeIntervalSince1970 * 1000)
                st.lastError = "\(e.code): \(e.message)"
                saveState(st)
            }
            setPhase("failed")
            ZnOtaGate.checkDone(ready: false, priority: 0, result: "\(e.code): \(e.message)")
            return ["action": "NONE", "reason": "ERROR", "error": "\(e.code): \(e.message)"]
        }
    }

    /// The phone's request (docs/ota.md §3.4) and the server's answer.
    private func post(_ c: Config, _ builtIn: ZnBundleRules.Info, _ st: OtaState) throws -> [String: Any] {
        let running = ZnBundles.running
        let caps = ZnCapabilities.current()
        let runningJson: Any = running.flatMap { r in r.builtIn ? nil : r.info.map { ["id": $0.id, "sha256": $0.sha256] } } ?? NSNull()
        let body: [String: Any] = [
            "app": builtIn.app, "channel": c.channel, "installId": st.installId,
            "capabilities": ["registry": caps.registry, "bytecode": caps.bytecode, "hostApi": caps.hostApi,
                             "hostApiOldest": caps.hostApiOldest, "modules": caps.modules, "os": caps.os],
            "running": runningJson,
            "builtIn": ["id": builtIn.id, "serial": builtIn.serial, "sha256": builtIn.sha256],
            "kept": Array(ZnBundles.kept(builtIn, caps).prefix(16)),
            "seq": st.seq(c.channel),
            "outcomes": st.outcomes,
            "patches": [String](),  // no patch format on iOS yet: the server sends full zips
            "store": ["os": "ios", "version": Self.storeVersion],
        ]
        guard let url = URL(string: c.server.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/v1/check") else {
            throw ZnOtaError("setup", "bad server \(c.server)")
        }
        var request = URLRequest(url: url, timeoutInterval: Self.checkTimeout)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try Self.fetch(request, timeout: Self.checkTimeout)
        guard let http = response as? HTTPURLResponse else { throw ZnOtaError("server", "no HTTP answer") }
        guard (200..<300).contains(http.statusCode) else { throw ZnOtaError("server", "check answered HTTP \(http.statusCode)") }
        if data.count > Self.maxCheckAnswer { throw ZnOtaError("server", "check answer too big") }
        do { return try ZnJSON.object(data) } catch { throw ZnOtaError("server", "the check's answer isn't JSON") }
    }

    /// A blocking request on the client's queue, the whole call within [timeout].
    private static func fetch(_ request: URLRequest, timeout: TimeInterval) throws -> (Data, URLResponse) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForResource = timeout
        let session = URLSession(configuration: config)
        defer { session.finishTasksAndInvalidate() }
        let done = DispatchSemaphore(value: 0)
        var result: (Data?, URLResponse?, Error?)
        session.dataTask(with: request) { d, r, e in
            result = (d, r, e)
            done.signal()
        }.resume()
        if done.wait(timeout: .now() + timeout + 5) == .timedOut { throw ZnOtaError("server", "no full answer within \(Int(timeout)) s") }
        if let e = result.2 {
            if (e as NSError).code == NSURLErrorTimedOut { throw ZnOtaError("server", "no full answer within \(Int(timeout)) s") }
            throw ZnOtaError("server", e.localizedDescription)
        }
        return (result.0 ?? Data(), result.1 ?? URLResponse())
    }

    private static func priorityOf(_ p: ZnOtaSigned.Pointer?) -> Int {
        guard let p else { return 0 }
        if p.target == ZnOtaSignature.builtIn || p.priority == "critical" { return 2 }
        return p.priority == "high" ? 1 : 0
    }

    /// Does what the answer says, after checking everything signed. Returns { action, reason, bundle? }.
    private func act(_ c: Config, _ builtIn: ZnBundleRules.Info, _ st: OtaState, _ answer: [String: Any]) throws -> [String: Any] {
        let action = answer["action"] as? String ?? "NONE"
        let reason = answer["reason"] as? String ?? ""
        var result: [String: Any] = ["action": action, "reason": reason]
        let pointer = try (answer["pointer"] as? [String: Any]).map(ZnOtaSigned.parsePointer)
        let accepted = pointer.map { $0.app == builtIn.app && $0.channel == c.channel && $0.seq > st.seq(c.channel)
            && ZnOtaSigned.verify($0, c.publicKeys) } ?? false
        if let pointer, !accepted {
            outcome(st, "pointer_refused", pointer.target, "seq \(pointer.seq), phone has \(st.seq(c.channel))")
            return ["action": "NONE", "reason": "POINTER_REFUSED"]
        }
        switch action {
        case "NONE":
            if accepted, let p = pointer {
                // Nothing to download, but the signed pointer still says what must run next.
                let running = ZnBundles.running
                if p.target == ZnOtaSignature.builtIn || reason == "APK_NEWER" {
                    try? FileManager.default.removeItem(at: ZnBundles.currentFile)
                } else if reason == "UP_TO_DATE" {
                    if let id = running?.key { try ZnOtaFiles.writeAtomic(ZnBundles.currentFile, id) }
                    else { try? FileManager.default.removeItem(at: ZnBundles.currentFile) }
                }
                st.setSeq(c.channel, p.seq)
                st.nextPriority = Self.priorityOf(p)
            }
        case "BUILT_IN":
            guard let p = pointer else { throw ZnOtaError("pointer", "BUILT_IN without a signed pointer") }
            let serial = p.target.split(separator: "_").last.flatMap { Int($0) }
            if p.target != ZnOtaSignature.builtIn && (serial == nil || serial! > builtIn.serial) {
                throw ZnOtaError("pointer", "BUILT_IN, but the pointer names \(p.target)")
            }
            try? FileManager.default.removeItem(at: ZnBundles.currentFile)
            st.setSeq(c.channel, p.seq)
            st.nextPriority = Self.priorityOf(p)
            outcome(st, "switched", "built-in", reason)
        case "USE_LOCAL", "UPDATE":
            guard let p = pointer else { throw ZnOtaError("pointer", "\(action) without a signed pointer") }
            if let why = ZnOtaHealth.blocked().first(where: { $0.0 == p.target })?.1 {
                st.setSeq(c.channel, p.seq)
                outcome(st, "blocked", p.target, "the channel points to it, but it is blocked on this phone (\(why))")
                return ["action": "NONE", "reason": "BLOCKED", "bundle": p.target]
            }
            guard let mj = answer["bundle"] as? [String: Any] else { throw ZnOtaError("bundle", "\(action) without a bundle") }
            let m = try ZnOtaSigned.parseManifest(mj)
            if m.id != p.target || m.app != builtIn.app { throw ZnOtaError("bundle", "the bundle \(m.id) isn't what the pointer names (\(p.target))") }
            if !ZnOtaSigned.verify(m, c.publicKeys) { throw ZnOtaError("signature", "bad bundle signature on \(m.id)") }
            if m.serial <= builtIn.serial { throw ZnOtaError("bundle", "\(m.id) isn't newer than the app's own #\(builtIn.serial)") }
            if let why = ZnCapabilities.current().missing(m.requires) { throw ZnOtaError("incompatible", why) }
            var how: String?
            if action == "UPDATE" {
                ZnOtaGate.found(Self.priorityOf(p))
                how = try install(c, m)
            } else {
                try switchTo(builtIn, m)
            }
            st.setSeq(c.channel, p.seq)
            st.nextPriority = Self.priorityOf(p)
            outcome(st, action == "UPDATE" ? "downloaded" : "switched", m.id, how)
            result["bundle"] = m.id
            prune(builtIn)
        default:
            break
        }
        return result
    }

    private func switchTo(_ builtIn: ZnBundleRules.Info, _ m: ZnOtaSigned.Manifest) throws {
        guard case let .ok(info) = ZnBundleRules.checkBundle(m.id, builtIn: builtIn, caps: .current(), folder: ZnBundles.folder),
              info.sha256 == m.bundleSha256 else { throw ZnOtaError("local", "kept \(m.id) can't be used") }
        try ZnOtaFiles.writeAtomic(ZnBundles.currentFile, m.id)
    }

    // MARK: Download and install

    private var ota: URL { ZnBundles.otaDir }

    private func checkSpace(_ m: ZnOtaSigned.Manifest) throws {
        let partInfo = ota.appendingPathComponent("download.json")
        let same = (ZnOtaFiles.readText(partInfo).flatMap { try? ZnJSON.object(Data($0.utf8)) }?["sha256"] as? String) == m.zipSha256
        let have = same ? min(ZnBundleRules.fileSize(ota.appendingPathComponent("download.part")), m.zipSize) : 0
        let need = (m.zipSize - max(have, 0)) + m.zipSize * Self.unzipFactor + Self.minFreeBytes
        let values = try? ota.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        var free = values?.volumeAvailableCapacityForImportantUsage ?? Int64.max
        #if DEBUG
        // The test matrix's low-storage case (Android: debug.zn.ota_free_bytes). Debug builds only.
        if let s = ProcessInfo.processInfo.environment["ZN_OTA_FREE_BYTES"], let n = Int64(s) { free = n }
        #endif
        if free < need {
            throw ZnOtaError("no_space", "\(m.id) needs \(Self.mb(need)) MB free (with \(Self.mb(Self.minFreeBytes)) MB kept for the user), the phone has \(Self.mb(free)) MB")
        }
    }

    private static func mb(_ b: Int64) -> String { String(format: "%.1f", Double(b) / 1_048_576) }
    private static func kb(_ b: Int64) -> String { b < 10 * 1024 ? String(format: "%.1f KB", Double(b) / 1024) : "\((b + 512) / 1024) KB" }

    /// Downloads and installs [m] from its full zip. Returns how it came, for the `downloaded` outcome.
    private func install(_ c: Config, _ m: ZnOtaSigned.Manifest) throws -> String {
        if let r = ZnBundles.running, r.key == m.id { throw ZnOtaError("install", "\(m.id) is running already") }
        let fm = FileManager.default
        try fm.createDirectory(at: ota, withIntermediateDirectories: true)
        let tmp = ota.appendingPathComponent("tmp")
        let staged = tmp.appendingPathComponent(m.id)
        try checkSpace(m)
        let part = try download(c, m)
        setPhase("installing")
        try? fm.removeItem(at: tmp)
        do {
            try ZnOtaInstall.extract(zip: part, manifest: m, dest: staged)
        } catch let e as NSError where e.domain == NSCocoaErrorDomain && e.code == NSFileWriteOutOfSpaceError {
            try? fm.removeItem(at: tmp)
            for n in ["download.part", "download.json"] { try? fm.removeItem(at: ota.appendingPathComponent(n)) }
            throw ZnOtaError("no_space", "the phone ran out of space while installing \(m.id); its files were removed")
        }
        let dest = ZnBundles.folder(m.id)
        try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }  // an earlier copy of the same bytes
        do { try fm.moveItem(at: staged, to: dest) } catch { throw ZnOtaError("install", "can't move \(m.id) into place") }
        try ZnOtaFiles.writeAtomic(ZnBundles.currentFile, m.id)  // the last step: until here the old bundle stays current
        for n in ["download.part", "download.json"] { try? fm.removeItem(at: ota.appendingPathComponent(n)) }
        try? fm.removeItem(at: tmp)
        print("zn-ota: installed \(m.id) (full zip, \(Self.kb(m.zipSize))); it runs from the next start")
        return "full zip, \(Self.kb(m.zipSize))"
    }

    /// Downloads the zip to download.part, resuming a cut download of the same file (download.json remembers which).
    private func download(_ c: Config, _ m: ZnOtaSigned.Manifest) throws -> URL {
        let fm = FileManager.default
        let part = ota.appendingPathComponent("download.part")
        let partInfo = ota.appendingPathComponent("download.json")
        let same = (ZnOtaFiles.readText(partInfo).flatMap { try? ZnJSON.object(Data($0.utf8)) }?["sha256"] as? String) == m.zipSha256
        if !same || ZnBundleRules.fileSize(part) > m.zipSize {
            try? fm.removeItem(at: part)
            try ZnOtaFiles.writeAtomic(partInfo, ZnJSON.text(["sha256": m.zipSha256, "size": m.zipSize]) ?? "{}")
        }
        var have = max(ZnBundleRules.fileSize(part), 0)
        if have < m.zipSize {
            setPhase("downloading", Double(have) / Double(m.zipSize))
            guard let base = URL(string: c.server.hasSuffix("/") ? c.server : c.server + "/"),
                  let full = URL(string: m.url, relativeTo: base)?.absoluteURL else { throw ZnOtaError("bundle", "bad download url \(m.url)") }
            var request = URLRequest(url: full, timeoutInterval: Self.downloadIdleTimeout)
            if have > 0 {
                request.setValue("bytes=\(have)-", forHTTPHeaderField: "Range")
                print("zn-ota: resuming \(m.id) at \(have) of \(m.zipSize) bytes")
            }
            have = try ZnOtaDownload(part: part, have: have, size: m.zipSize) { [weak self] got in
                self?.setPhase("downloading", Double(got) / Double(m.zipSize))
            }.run(request)
        }
        if ZnBundleRules.fileSize(part) != m.zipSize || (try? ZnOtaFiles.sha256(part)) != m.zipSha256 {
            try? fm.removeItem(at: part)
            try? fm.removeItem(at: partInfo)
            throw ZnOtaError("zip_sha", "the downloaded zip doesn't match the signed manifest")
        }
        return part
    }

    /// Keeps the running bundle, the current one, the last good one and the newest [keep] others; deletes the rest.
    private func prune(_ builtIn: ZnBundleRules.Info) {
        let fm = FileManager.default
        let dir = ota.appendingPathComponent("bundles")
        let names = (try? fm.contentsOfDirectory(atPath: dir.path)) ?? []
        var keep = Set<String>()
        if let id = ZnBundles.running?.key { keep.insert(id) }
        if let id = ZnBundles.readCurrent() { keep.insert(id) }
        if let id = ZnOtaHealth.lastGood { keep.insert(id) }
        let usable = Set(ZnBundles.kept(builtIn, .current()))
        let newest = names.filter { usable.contains($0) && !keep.contains($0) }
            .sorted { (Int($0.split(separator: "_").last ?? "") ?? -1) > (Int($1.split(separator: "_").last ?? "") ?? -1) }
            .prefix(Self.keep)
        keep.formUnion(newest)
        for n in names where !keep.contains(n) {
            try? fm.removeItem(at: dir.appendingPathComponent(n))
            print("zn-ota: deleted \(usable.contains(n) ? "old" : "unusable or blocked") bundle \(n)")
        }
    }

    /// Once, at the first check after a new app install: bundles that no longer fit are deleted.
    private func cleanUpAfterNewApp(_ builtIn: ZnBundleRules.Info) {
        let fm = FileManager.default
        let fits = Set(ZnBundles.kept(builtIn, .current()))
        let running = ZnBundles.running?.key
        let current = ZnBundles.readCurrent()
        if let current, !fits.contains(current), current != running { try? fm.removeItem(at: ZnBundles.currentFile) }
        if let good = ZnOtaHealth.lastGood, !fits.contains(good) { ZnOtaHealth.forgetGood(good) }
        let dir = ota.appendingPathComponent("bundles")
        var deleted = 0
        for n in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] where !fits.contains(n) && n != running {
            try? fm.removeItem(at: dir.appendingPathComponent(n))
            deleted += 1
        }
        print("zn-ota: new app install: \(deleted) bundle(s) that no longer fit (or are blocked) deleted")
    }

    // MARK: State: install id, seq per channel, outcomes not yet sent

    final class OtaState {
        var installId = UUID().uuidString.lowercased()
        var seqs: [String: Int64] = [:]
        var outcomes: [[String: Any]] = []
        var lastRunning: String?
        var lastCheckAt: Int64 = 0
        var lastResult: String?
        var lastError: String?
        var nextPriority = 0
        /// The last store answer (ZnOtaStore.read: JSON text), the app build it was for, and when it came.
        var store: String?
        var storeFor = ""
        var storeAt: Int64 = 0

        func seq(_ channel: String) -> Int64 { seqs[channel] ?? 0 }
        func setSeq(_ channel: String, _ seq: Int64) { seqs[channel] = seq }

        /// The saved store answer with its time, only if it was for [build] (this app build).
        func storeAnswer(_ build: String) -> String? {
            guard let store, storeFor == build, var o = try? ZnJSON.object(Data(store.utf8)) else { return nil }
            o["at"] = storeAt
            return ZnJSON.text(o)
        }
    }

    private var stateFile: URL { ota.appendingPathComponent("state.json") }

    private func loadState() -> OtaState {
        let st = OtaState()
        guard let text = ZnOtaFiles.readText(stateFile), let j = try? ZnJSON.object(Data(text.utf8)) else { return st }
        if let id = j["installId"] as? String, !id.isEmpty { st.installId = id }
        st.seqs = (j["seq"] as? [String: NSNumber])?.mapValues(\.int64Value) ?? [:]
        st.outcomes = j["outcomes"] as? [[String: Any]] ?? []
        st.lastRunning = ZnJSON.nonEmpty(j["lastRunning"])
        st.lastCheckAt = (j["lastCheckAt"] as? NSNumber)?.int64Value ?? 0
        st.lastResult = ZnJSON.nonEmpty(j["lastResult"])
        st.lastError = ZnJSON.nonEmpty(j["lastError"])
        st.nextPriority = (j["nextPriority"] as? NSNumber)?.intValue ?? 0
        st.store = ZnJSON.nonEmpty(j["store"])
        st.storeFor = j["storeFor"] as? String ?? ""
        st.storeAt = (j["storeAt"] as? NSNumber)?.int64Value ?? 0
        return st
    }

    private func saveState(_ st: OtaState) {
        let j: [String: Any] = [
            "installId": st.installId, "seq": st.seqs, "outcomes": ZnOtaOutcomeRules.trim(st.outcomes, Self.maxOutcomes) { Self.serious.contains($0["kind"] as? String ?? "") },
            "lastRunning": st.lastRunning ?? "", "lastCheckAt": st.lastCheckAt, "lastResult": st.lastResult ?? "",
            "lastError": st.lastError ?? "", "nextPriority": st.nextPriority, "store": st.store ?? "",
            "storeFor": st.storeFor, "storeAt": st.storeAt,
        ]
        try? ZnOtaFiles.writeAtomic(stateFile, ZnJSON.text(j) ?? "{}")
    }

    /// The App Store version the store rules compare ("1.6.2").
    static var storeVersion: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0" }
    /// What a kept store answer is for: this app build (a store update must not ask again after it).
    static var storeKey: String { ZnOtaHealth.appBuild.version }

    private func keepStoreAnswer(_ st: OtaState, _ answer: [String: Any]) {
        guard answer.keys.contains("store") else { return }
        guard let s = ZnOtaStore.read(answer["store"]) else {
            print("zn-ota: check: a store answer this app can't read, keeping the last one")
            return
        }
        if s != st.store || st.storeFor != Self.storeKey { print("zn-ota: check: store answer \(s)") }
        st.store = s
        st.storeFor = Self.storeKey
        st.storeAt = Int64(Date().timeIntervalSince1970 * 1000)
    }

    /// This build's last store answer (for a store screen at launch).
    static func savedStoreUpdate() -> ZnStoreUpdate? {
        ZnOtaStore.update(shared.stateLock.withLock { shared.loadState() }.storeAnswer(storeKey))
    }

    /// Adds an outcome for the next check, and tells Config.onReport (main thread).
    private func outcome(_ st: OtaState, _ kind: String, _ bundle: String?, _ detail: String?,
                         atMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000), stack: String? = nil, sha: String? = nil) {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        var o: [String: Any] = ["kind": kind, "at": iso.string(from: Date(timeIntervalSince1970: Double(atMs) / 1000))]
        if let bundle { o["bundle"] = bundle }
        if let detail { o["detail"] = String(detail.prefix(300)) }
        if let stack { o["stack"] = String(stack.prefix(1500)) }
        if let sha { o["sha"] = sha }
        st.outcomes.append(o)
        let report = ZnOtaReport(kind: kind, bundle: bundle, detail: detail, serious: Self.serious.contains(kind), stack: stack)
        print("zn-ota: report: \(report)")
        if let hook = Self.config?.onReport { DispatchQueue.main.async { hook(report) } }
    }

    /// Client queue: an outcome (none if [kind] is nil); [running]: now what runs; [error]: shown as lastError.
    private func record(_ kind: String?, _ bundle: String?, _ detail: String?, running: String?, error: String? = nil,
                        stack: String? = nil, sha: String? = nil) {
        stateLock.withLock {
            let st = loadState()
            if let kind { outcome(st, kind, bundle, detail, stack: stack, sha: sha) }
            if let running { st.lastRunning = running }
            if let error { st.lastError = error }
            saveState(st)
        }
    }

    /// Reports, once, that a new bundle started running (installed earlier, run from this start).
    private func noteRunning(_ st: OtaState) {
        let r = ZnBundles.running
        let now = r.map { $0.builtIn ? "built-in \($0.info?.id ?? "")" : ($0.info?.id ?? "") }
        if now != st.lastRunning {
            if st.lastRunning != nil { outcome(st, "started", now, "was \(st.lastRunning!)") }
            st.lastRunning = now
        }
    }

    /// The safety nets' events become outcomes, on the client's queue. Any thread.
    static func deliverSoon() {
        guard isConfigured else { return }
        shared.worker.async { shared.deliver() }
    }

    private func deliver() {
        guard Self.isConfigured else { return }
        let events = ZnOtaHealth.takeEvents()
        if events.isEmpty { return }
        stateLock.withLock {
            let st = loadState()
            for e in events { outcome(st, e.kind, e.bundle, e.detail, atMs: e.atMs, stack: e.stack, sha: e.sha) }
            saveState(st)
        }
    }

    // MARK: Safety nets (main thread)

    private func stopTimers() {
        healthyTimer?.cancel()
        firstScreenTimer?.cancel()
        healthyTimer = nil
        firstScreenTimer = nil
    }

    private func armFirstScreen() {
        guard let c = Self.config, ZnBundles.running?.builtIn == false, c.firstScreenTimeoutMs > 0 else { return }
        firstScreenTimer?.cancel()
        let t = DispatchWorkItem { [self] in
            guard let id = ZnBundles.running?.key, !screensAreUp, inFront, !applying, !rollingBack,
                  ZnOtaHealth.healthyBundle != id else { return }
            let why = "the first screens weren't up after \(Int(c.firstScreenTimeoutMs)) ms"
            print("zn-ota: safety: \(why) (\(id))")
            if !ZnOtaHealth.errorsRollBack(id) {
                worker.async { [self] in record("error_screen", id, "\(why) (last good bundle: reported only)", running: nil) }
                return
            }
            MainActor.assumeIsolated { _ = rollBack(id, why) }  // a main-queue work item
        }
        firstScreenTimer = t
        DispatchQueue.main.asyncAfter(deadline: .now() + c.firstScreenTimeoutMs / 1000, execute: t)
    }

    private func armHealthy() {
        guard let c = Self.config, let id = ZnBundles.running?.key, c.healthyAfterMs > 0,
              ZnOtaHealth.healthyBundle != id, !ZnOtaHealth.isBlocked(id) else { return }
        healthyTimer?.cancel()
        let t = DispatchWorkItem { [self] in markHealthy() }
        healthyTimer = t
        DispatchQueue.main.asyncAfter(deadline: .now() + c.healthyAfterMs / 1000, execute: t)
    }

    /// Main thread, from ZnApp (JS sent NAV STARTED): the running bundle's first screens are built.
    @MainActor static func screensUp() {
        let s = shared
        guard isConfigured, !s.screensAreUp else { return }
        s.screensAreUp = true
        if s.coverView != nil { s.armUncover(0.05) }  // a swap's cover: the new screens are drawn by the next frame
        ZnOtaGate.screensUp()
        s.firstScreenTimer?.cancel()
        if s.inFront { s.armHealthy() }
    }

    /// Marks the running bundle healthy (`Updates.markHealthy()`, or healthyAfterMs after the first screens): it
    /// becomes where a later rollback goes, and its errors no longer roll back. Any thread.
    func markHealthy() {
        guard Self.isConfigured, let id = ZnBundles.running?.key else { return }
        if ZnOtaHealth.healthyBundle == id || ZnOtaHealth.isBlocked(id) { return }
        ZnOtaHealth.healthyBundle = id
        DispatchQueue.main.async { [self] in stopTimers() }
        worker.async { [self] in
            if ZnOtaHealth.markHealthy(id) { record("healthy", id, nil, running: nil) }
            print("zn-ota: safety: \(id) is healthy")
            emitStatus()
        }
    }

    /// Main thread, from ZnApp: JS failed to start, a screen failed while being built, or JS hung. On a downloaded
    /// bundle that isn't healthy yet this blocks it and makes the last good bundle current. Returns true if it rolled
    /// back in place (not yet on iOS: always false, and the error screen shows; the good bundle runs from the next start).
    @discardableResult
    @MainActor static func errorScreen(kind: String, where whereText: String, details: String) -> Bool {
        guard isConfigured else { return false }
        let s = shared
        if s.applying || s.rollingBack || ZnApp.shared.restarting { return false }  // a swap handles its own failures
        let running = ZnBundles.running
        let id = running?.key
        let what = s.safeText("\(kind) in \(whereText): \(details.split(separator: "\n").first ?? "")")
        let stack = jsTopFrames(details)
        let sha = running?.info?.sha256
        if let id, s.rolledBack.contains(id) { return false }  // once per process: later errors are the same bundle's
        guard let id, ZnOtaHealth.healthyBundle != id else {
            s.worker.async { s.record("error_screen", id ?? "built-in", what, running: nil, stack: stack, sha: sha) }
            return false
        }
        if !ZnOtaHealth.errorsRollBack(id) {
            if kind == "start" && ZnOtaHealth.startFailed(id) {
                return s.rollBack(id, what, stack: stack, sha: sha, blockAs: ZnOtaHealthRules.watchdog)
            }
            print("zn-ota: safety: \(id) is the last good bundle: \(what) (reported, not blocked)")
            s.worker.async { s.record("error_screen", id, "\(what) (last good bundle: reported only)", running: nil, stack: stack, sha: sha) }
            return false
        }
        return s.rollBack(id, what, stack: stack, sha: sha)
    }

    /// Blocks [id] and makes the last good bundle (or the built-in one) current, and runs it now in place (under a
    /// cover) when it can: JS isn't holding updates and no launch is open. Else from the next start. True if in place.
    @discardableResult
    @MainActor private func rollBack(_ id: String, _ why: String, stack: String? = nil, sha: String? = nil,
                          blockAs: String = ZnOtaHealthRules.error) -> Bool {
        rolledBack.insert(id)
        stopTimers()
        let inPlace = !isHeld && !ZnLaunch.isWaiting && Self.window() != nil
        let later = inPlace ? "" : " from the next start (\(isHeld ? "updates are held" : "the app can't swap now"))"
        if inPlace {
            rollingBack = true
            cover()
        }
        worker.async { [self] in
            let target = ZnBundles.candidate(exclude: id)
            ZnOtaHealth.block(id, blockAs, kind: "error_rollback",
                              detail: "\(why); going back to \(target.key ?? "the built-in bundle")\(later)", stack: stack, sha: sha)
            deliver()
            record(nil, nil, nil, running: nil, error: "error_rollback: \(id): \(why)")
            emitStatus()
            guard inPlace else { return }
            DispatchQueue.main.async { [self] in
                print("zn-ota: safety: rolling back from \(id) to \(target): \(why)")
                swap(to: target, fallback: nil, why: .rollBack) { r in print("zn-ota: safety: rollback done: \(r)") }
            }
        }
        return inPlace
    }

    // MARK: Apply in place (ZnOta.kt applyNow / swap)

    /// Main thread: an update or a rollback is replacing the JS runtime.
    private var applying = false
    private var rollingBack = false
    private var coverView: UIView?
    private var uncoverWork: DispatchWorkItem?
    private static let coverTimeout: TimeInterval = 3  // Android's COVER_TIMEOUT_MS

    enum Swap { case apply, rollBack, fallback }

    @MainActor public static func window() -> UIWindow? {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        return windows.first { $0.isKeyWindow } ?? windows.first
    }

    /// Main thread: a still picture of the screens now (else the screen's background) over everything, until the new
    /// screens are up (screensUp) or coverTimeout.
    @MainActor private func cover() {
        guard coverView == nil, let window = Self.window() else { return }
        let v = window.snapshotView(afterScreenUpdates: false) ?? UIView(frame: window.bounds)
        if v.backgroundColor == nil && v.subviews.isEmpty { v.backgroundColor = .systemBackground }
        v.frame = window.bounds
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        v.isUserInteractionEnabled = true  // touches stop here while the screens change
        window.addSubview(v)
        coverView = v
        armUncover(Self.coverTimeout)
    }

    @MainActor private func armUncover(_ after: TimeInterval) {
        uncoverWork?.cancel()
        let w = DispatchWorkItem { [self] in uncover() }
        uncoverWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + after, execute: w)
    }

    @MainActor private func uncover() {
        uncoverWork?.cancel()
        uncoverWork = nil
        guard let v = coverView else { return }
        coverView = nil
        UIView.animate(withDuration: 0.15, animations: { v.alpha = 0 }, completion: { _ in v.removeFromSuperview() })
    }

    /// Runs the bundle installed for the next start now, in this process: the JS runtime is replaced by a new one
    /// running it, and the screens that were open open again by route and params (their JS state fresh) under a
    /// cover. Refused while JS holds updates or a launch is open. If the new code throws while starting, it is blocked
    /// and the bundle that ran comes back the same way (outcome apply_failed). [done] on the main thread:
    /// `{ applied: true, bundle }` or `{ applied: false, reason: off|held|busy|not_started|nothing|failed, error? }`.
    public func applyNow(_ done: @escaping ([String: Any]) -> Void) {
        DispatchQueue.main.async { [self] in
            func no(_ reason: String, _ error: String? = nil) {
                var r: [String: Any] = ["applied": false, "reason": reason]
                if let error { r["error"] = error }
                done(r)
            }
            guard Self.isConfigured else { return no("off") }
            if isHeld || ZnLaunch.isWaiting { return no("held") }
            if applying || rollingBack || ZnApp.shared.restarting { return no("busy") }
            if !ZnApp.shared.firstScreensUp || Self.window() == nil { return no("not_started") }
            applying = true
            // On the client's queue: after any check in progress, so `current` is final.
            worker.async { [self] in
                let target = ZnBundles.candidate()
                DispatchQueue.main.async { [self] in
                    if target.key == ZnBundles.running?.key {
                        applying = false
                        return no("nothing")
                    }
                    if isHeld || ZnLaunch.isWaiting {
                        applying = false
                        return no("held")
                    }
                    swap(to: target, fallback: ZnBundles.running, why: .apply, done)
                }
            }
        }
    }

    /// Main thread: switches the process to [target] and replaces the JS runtime. If the new code throws while it
    /// starts, it is blocked on this phone and [fallback] runs the same way and becomes current instead.
    @MainActor private func swap(to target: ZnBundles.Running, fallback: ZnBundles.Running?, why: Swap,
                      _ done: @escaping ([String: Any]) -> Void) {
        let t0 = CACurrentMediaTime()
        cover()
        let from = ZnBundles.running
        stopTimers()
        screensAreUp = false
        fieldsLock.withLock { jsQueued = false }  // until the new runtime's main script is queued
        ZnBundles.switchTo(target)
        let id = target.key
        ZnApp.shared.restart(bundle: target.dir ?? ZnBundles.builtInURL, in: Self.window()) { [self] ok, error in
            let line = safeText(String(error.split(separator: "\n").first ?? ""))
            if !ok, let fallback {
                print("zn-ota: apply: \(target) threw while starting; running \(fallback) instead: \(line)")
                let stack = Self.jsTopFrames(error)
                worker.async { [self] in
                    let backId = fallback.key
                    if let backId { try? ZnOtaFiles.writeAtomic(ZnBundles.currentFile, backId) }
                    else { try? FileManager.default.removeItem(at: ZnBundles.currentFile) }
                    if let id { ZnOtaHealth.block(id, ZnOtaHealthRules.error, kind: nil, detail: nil) }
                    record("apply_failed", id ?? "built-in", "\(line); running \(backId ?? "built-in")", running: nil,
                           error: "apply_failed: \(id ?? "built-in") threw while starting: \(line)", stack: stack,
                           sha: target.info?.sha256)
                }
                return swap(to: fallback, fallback: nil, why: .fallback, done)
            }
            applying = false
            rollingBack = false
            ZnOtaHealth.onChosen(target)
            if !ok {
                // Nothing left to fall back to in place: the error screen shows.
                uncover()
                return done(["applied": false, "reason": "failed", "error": error])
            }
            if inFront { armFirstScreen() }
            let ms = Int((CACurrentMediaTime() - t0) * 1000)
            print("zn-ota: apply: now running \(target), in \(ms) ms")
            let now = target.builtIn ? "built-in \(target.info?.id ?? "")" : (id ?? "")
            switch why {
            case .apply:
                worker.async { [self] in record("applied", id ?? "built-in", "was \(from?.key ?? "built-in"), \(ms) ms", running: now) }
                done(["applied": true, "bundle": id ?? NSNull()])
            case .rollBack:
                worker.async { [self] in record(nil, nil, nil, running: now) }
                done(["applied": true, "bundle": id ?? NSNull()])
            case .fallback:
                worker.async { [self] in record(nil, nil, nil, running: now) }
                done(["applied": false, "reason": "failed",
                      "error": "the new bundle threw while starting; \(id ?? "the built-in bundle") runs instead"])
            }
            emitStatus()
        }
    }

    /// A JS error's text as it may be stored and sent: masked, then the app's own redact.
    private func safeText(_ text: String) -> String {
        let masked = ZnOtaHealthRules.mask(text)
        return Self.config?.redact?(masked) ?? masked
    }

    /// The top JS frames of an error's details (lines with "at "), at most 8, masked.
    private static func jsTopFrames(_ details: String) -> String? {
        let frames = details.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { $0.hasPrefix("at ") }.prefix(8)
        return frames.isEmpty ? nil : ZnOtaHealthRules.mask(frames.joined(separator: "\n"))
    }

    // MARK: JS: the built-in Updates module (packages/core/src/updates.ts)

    final class Module: ZnModuleBase, @unchecked Sendable {
        init() {
            super.init("Updates", version: 3)
            function("status") { call in call.resolve(ZnOta.shared.status()) }
            function("markHealthy") { call in
                ZnOta.shared.markHealthy()
                call.resolve()
            }
            function("check") { call in
                ZnOta.shared.check { result in
                    var r = result
                    r["status"] = ZnOta.shared.status()
                    call.resolve(r)
                }
            }
            // Answered only when it didn't apply: when it did, the JS that asked is gone (its runtime was replaced).
            function("applyNow", onMain: true) { call in
                ZnOta.shared.applyNow { r in if r["applied"] as? Bool != true { call.resolve(r) } }
            }
            // Never answered: the hold lasts until JS cancels the call.
            function("hold", onMain: true) { call in
                let key = ObjectIdentifier(call)
                let s = ZnOta.shared
                s.fieldsLock.withLock { s.holds[key] = call }
                call.onCancel { s.fieldsLock.withLock { s.holds[key] = nil } }
            }
        }
    }
}

/// A download to a file that resumes: appends on 206 with the expected Content-Range, starts again on 200, gives up
/// after [ZnOta]'s idle limit with no bytes (the part stays for the next check).
private final class ZnOtaDownload: NSObject, URLSessionDataDelegate {
    private let part: URL
    private var have: Int64
    private let size: Int64
    private let onProgress: (Int64) -> Void
    private var handle: FileHandle?
    private var failure: Error?
    private var lastReport: Int64 = 0
    private let done = DispatchSemaphore(value: 0)

    init(part: URL, have: Int64, size: Int64, onProgress: @escaping (Int64) -> Void) {
        self.part = part
        self.have = have
        self.size = size
        self.onProgress = onProgress
    }

    func run(_ request: URLRequest) throws -> Int64 {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = request.timeoutInterval  // the longest gap between bytes
        let session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        session.dataTask(with: request).resume()
        done.wait()
        session.finishTasksAndInvalidate()
        try? handle?.synchronize()
        try? handle?.close()
        if let failure { throw failure }
        return have
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let http = response as? HTTPURLResponse
        let code = http?.statusCode ?? 0
        let range = http?.value(forHTTPHeaderField: "Content-Range") ?? ""
        do {
            if code == 206 && range.hasPrefix("bytes \(have)-") {
                handle = try FileHandle(forWritingTo: part)
                try handle?.seekToEnd()
            } else if code == 200 {
                have = 0
                FileManager.default.createFile(atPath: part.path, contents: nil)
                handle = try FileHandle(forWritingTo: part)
            } else {
                throw ZnOtaError("download", "download answered HTTP \(code)")
            }
            completionHandler(.allow)
        } catch {
            failure = error
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        have += Int64(data.count)
        if have > size {
            failure = ZnOtaError("download", "the download is bigger than its \(size) bytes")
            dataTask.cancel()
            return
        }
        do { try handle?.write(contentsOf: data) } catch {
            failure = (error as NSError).code == NSFileWriteOutOfSpaceError
                ? ZnOtaError("no_space", "the phone ran out of space while downloading") : error
            dataTask.cancel()
            return
        }
        if have - lastReport >= 64 * 1024 {
            lastReport = have
            onProgress(have)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if failure == nil, let error {
            failure = (error as NSError).code == NSURLErrorTimedOut
                ? ZnOtaError("download", "no data for 60 s, at \(have) of \(size) bytes")
                : ZnOtaError("download", error.localizedDescription)
        }
        done.signal()
    }
}
