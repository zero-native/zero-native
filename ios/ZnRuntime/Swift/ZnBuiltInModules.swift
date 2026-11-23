// The small built-in modules on iOS, each the counterpart of an android/runtime module with the same name, methods
// and answers (the JS side is shared: packages/core/src/os.ts, netinfo.ts, secure-store.ts, clipboard.ts).
import Foundation
import Network
import Security
import UIKit
#if SWIFT_PACKAGE
import ZnHost
#endif

/// The app's frontmost view controller, to present system sheets from. Main thread.
@MainActor
public func znTopController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    var top = scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
}

/// "18.0" or "18.0.1", from any thread (UIDevice wants the main thread).
func znIosVersion() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return v.patchVersion > 0 ? "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)" : "\(v.majorVersion).\(v.minorVersion)"
}

// MARK: - Os (ZnOs.kt)

/// Small things about the phone. `info` keeps Android's keys (android "" and sdk 0 here) and adds `ios`, the iOS version.
public final class ZnOs: ZnModuleBase, @unchecked Sendable {
    /// Any app's link opens, as in RN's Linking.openURL (Pavan's call, 2026-11-08; second-opinions 185, as ZnOs.kt). Refused:
    /// text with no valid scheme (RFC 3986), and `intent:`, `file:`, `javascript:` (Android's three; on iOS they open
    /// nothing useful, and a file: link must not leave from an OTA bundle).
    static let blocked: Set<String> = ["intent", "file", "javascript"]
    static func allows(_ raw: String) -> URL? {
        guard raw.range(of: "^[A-Za-z][A-Za-z0-9+.-]*:", options: .regularExpression) != nil,
              let url = URL(string: raw), let scheme = url.scheme?.lowercased(), !blocked.contains(scheme) else { return nil }
        return url
    }

    /// The device model ("iPhone17,3"); on the simulator, the model it simulates.
    public static var model: String {
        if let sim = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return sim }
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    init() {
        super.init("Os", version: 2)
        function("info") { call in
            let b = Bundle.main
            let language = Locale.preferredLanguages.first ?? "en"
            call.resolve([
                "appVersion": b.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                "appBuild": Int(b.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0,
                "packageName": b.bundleIdentifier ?? "",
                "android": "", "sdk": 0,
                "ios": znIosVersion(),
                "model": Self.model, "manufacturer": "Apple",
                "rtl": Locale.Language(identifier: language).characterDirection == .rightToLeft,
            ])
        }
        function("haptic", onMain: true) { call in
            switch try call.string("kind") {
            case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
            case let kind: throw ZnInvalidArgs("unknown haptic \"\(kind)\"")
            }
            call.resolve(true)
        }
        function("openSettings", onMain: true) { call in
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return call.resolve(false) }
            UIApplication.shared.open(url) { call.resolve($0) }
        }
        function("share", onMain: true) { call in
            let text = try call.string("text")
            guard let top = MainActor.assumeIsolated({ znTopController() }) else { return call.reject("no_activity", "no screen to share from") }
            let sheet = UIActivityViewController(activityItems: [text], applicationActivities: nil)
            if let subject = try call.stringOrNil("subject") { sheet.setValue(subject, forKey: "subject") }  // email subject
            sheet.popoverPresentationController?.sourceView = top.view  // iPad
            top.present(sheet, animated: true)
            call.resolve(true)
        }
        function("openUrl", onMain: true) { call in
            guard let url = Self.allows(try call.string("url")) else {
                return call.reject("not_allowed", "openUrl takes a link with a scheme; intent:, file: and javascript: are refused")
            }
            UIApplication.shared.open(url) { ok in ok ? call.resolve(true) : call.reject("no_app", "no app can open this") }
        }
        // As in RN: http(s) always answer; any other scheme answers true only if the app lists it in its Info.plist's
        // LSApplicationQueriesSchemes (iOS answers false otherwise, even when an app could open it).
        function("canOpenUrl", onMain: true) { call in
            guard let url = Self.allows(try call.string("url")) else { return call.resolve(false) }
            call.resolve(UIApplication.shared.canOpenURL(url))
        }
    }
}

// MARK: - NetInfo (ZnNetInfo.kt)

/// `@react-native-community/netinfo`'s state from NWPathMonitor. iOS has no "validated" flag like Android's:
/// `isInternetReachable` is true when the path is satisfied (it has a route out), as RN's iOS default before its
/// own reachability request.
final class ZnNetInfo: ZnModuleBase, @unchecked Sendable {
    private let queue = DispatchQueue(label: "zn-netinfo")
    private var watcher: NWPathMonitor?  // queue only
    private var sent: String?
    private var pending: DispatchWorkItem?

    static func state(_ p: NWPath) -> [String: Any] {
        guard p.status == .satisfied else {
            return ["type": "none", "isConnected": false, "isInternetReachable": false, "details": NSNull()]
        }
        let type = p.usesInterfaceType(.wifi) ? "wifi" : p.usesInterfaceType(.cellular) ? "cellular"
            : p.usesInterfaceType(.wiredEthernet) ? "ethernet" : "other"
        return ["type": type, "isConnected": true, "isInternetReachable": true,
                "details": ["isConnectionExpensive": p.isExpensive]]
    }

    init() {
        super.init("NetInfo", version: 1)
        // A monitor's first update is the state now.
        function("fetch") { call in
            let m = NWPathMonitor()
            m.pathUpdateHandler = { path in
                m.cancel()
                call.resolve(Self.state(path))
            }
            m.start(queue: self.queue)
        }
    }

    override func onListenerCount(_ event: String, _ count: Int) {
        guard event == "change" else { return }
        queue.async { count > 0 ? self.watch() : self.unwatch() }
    }

    private func watch() {
        guard watcher == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in self?.settle(path) }
        watcher = m
        m.start(queue: queue)
    }

    private func unwatch() {
        watcher?.cancel()
        watcher = nil
        pending?.cancel()
        sent = nil  // a new listener hears the state again
    }

    /// A change comes as a burst of updates (as on Android): send once it settles, 250 ms.
    private func settle(_ path: NWPath) {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.watcher != nil else { return }
            let state = Self.state(path)
            let text = ZnModules.json(state)
            guard text != self.sent else { return }
            self.sent = text
            self.emit("change", state, latestOnly: true)
        }
        pending = work
        queue.asyncAfter(deadline: .now() + 0.25, execute: work)
    }
}

// MARK: - SecureStore (ZnSecureStore.kt)

/// Small secrets in the Keychain: one generic-password item per key, readable after the first unlock, never synced or
/// moved to another device. Keychain items outlive the app on iOS (Android's Keystore data doesn't): the first start
/// after an install deletes what an earlier install left, so a reinstall signs out on both platforms.
/// "The phone is locked" (errSecInteractionNotAllowed, before the first unlock) is "temporarily_unavailable".
final class ZnSecureStore: ZnModuleBase, @unchecked Sendable {
    static let maxKey = 256
    static let maxValue = 64 * 1024  // UTF-16 units, as Android's String.length
    private let lock = NSLock()
    private var checkedInstall = false
    private var service: String { (Bundle.main.bundleIdentifier ?? "app") + ".zn-secure" }

    private func base(_ key: String?) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        if let key { q[kSecAttrAccount as String] = key }
        return q
    }

    private func key(_ call: ZnCall) throws -> String {
        let key = try call.stringOrNil("key") ?? ""
        guard !key.isEmpty, key.utf16.count <= Self.maxKey else {
            throw ZnInvalidArgs("SecureStore: key must be a non-empty string of at most \(Self.maxKey) characters")
        }
        return key
    }

    /// Once per process: an install that is new (no marker in UserDefaults, which an uninstall deletes) clears the
    /// items an earlier install of the app left in the Keychain.
    private func forgetEarlierInstall() {
        lock.withLock {
            guard !checkedInstall else { return }
            checkedInstall = true
            let marker = "zn.secureStore.installed"
            guard !UserDefaults.standard.bool(forKey: marker) else { return }
            let status = SecItemDelete(base(nil) as CFDictionary)
            if status == errSecSuccess { ZnDebug.log.info("SecureStore: cleared what an earlier install left") }
            UserDefaults.standard.set(true, forKey: marker)
        }
    }

    private func notNow(_ status: OSStatus) -> Bool { status == errSecInteractionNotAllowed }

    init() {
        super.init("SecureStore", version: 1)
        function("get") { call in
            let key = try self.key(call)
            self.forgetEarlierInstall()
            var q = self.base(key)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: CFTypeRef?
            let status = SecItemCopyMatching(q as CFDictionary, &out)
            switch status {
            case errSecSuccess: call.resolve((out as? Data).flatMap { String(data: $0, encoding: .utf8) })
            case errSecItemNotFound: call.resolve(nil)
            case _ where self.notNow(status):
                call.reject("temporarily_unavailable", "SecureStore.get: can't read \"\(key)\" now (the phone is locked); it is kept, try again")
            default: call.reject("failed", "SecureStore.get: Keychain error \(status)")
            }
        }
        function("set") { call in
            let key = try self.key(call)
            guard let value = try call.stringOrNil("value"), value.utf16.count <= Self.maxValue else {
                throw ZnInvalidArgs("SecureStore.set: value must be a string of at most \(Self.maxValue) characters")
            }
            self.forgetEarlierInstall()
            let data = Data(value.utf8)
            var status = SecItemUpdate(self.base(key) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
            if status == errSecItemNotFound {
                var add = self.base(key)
                add[kSecValueData as String] = data
                add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                status = SecItemAdd(add as CFDictionary, nil)
            }
            switch status {
            case errSecSuccess: call.resolve()
            case _ where self.notNow(status):
                call.reject("temporarily_unavailable", "SecureStore.set: can't save \"\(key)\" now (the phone is locked); the old value is kept, try again")
            default: call.reject("failed", "SecureStore.set: Keychain error \(status)")
            }
        }
        function("delete") { call in
            let key = try self.key(call)
            self.forgetEarlierInstall()
            let status = SecItemDelete(self.base(key) as CFDictionary)
            if status == errSecSuccess || status == errSecItemNotFound { return call.resolve() }
            if self.notNow(status) { return call.reject("temporarily_unavailable", "SecureStore.delete: the phone is locked; try again") }
            call.reject("failed", "SecureStore.delete: Keychain error \(status)")
        }
    }
}

// MARK: - Clipboard (ZnClipboard.kt)

/// Plain text on the general pasteboard. iOS 16+ asks the user before an app reads what another app copied
/// ("Allow Paste"): getString waits for that answer; hasString never asks.
final class ZnClipboard: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("Clipboard", version: 1)
        function("setString", onMain: true) { call in
            UIPasteboard.general.string = try call.string("text")
            call.resolve()
        }
        function("getString", onMain: true) { call in call.resolve(UIPasteboard.general.string ?? "") }
        function("hasString", onMain: true) { call in call.resolve(UIPasteboard.general.hasStrings) }
    }
}

// MARK: - Updates (ZnOta.kt Module), until iOS has OTA

/// An app that never called `ZnOta.configure` (ZnOta.swift): Updates answers exactly as Android does then, so JS sees
/// "updates are off" instead of a missing module (`Updates.status()` would reject,
/// and a `void Updates.status()` would be reported as an async error).
/// - status: `{ enabled: false, phase: "off" }`; check: `{ action: "NONE", reason: "OFF", status }`;
/// - applyNow: `{ applied: false, reason: "off" }`; markHealthy: done; hold: never answered, dropped when JS releases it.
final class ZnUpdatesOff: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("Updates", version: 3)
        function("status") { call in call.resolve(["enabled": false, "phase": "off"]) }
        function("markHealthy") { call in call.resolve() }
        // `status` too, as the JS type says (Android leaves it out when off: A15).
        function("check") { call in call.resolve(["action": "NONE", "reason": "OFF", "status": ["enabled": false, "phase": "off"]]) }
        function("applyNow") { call in call.resolve(["applied": false, "reason": "off"]) }
        function("hold") { call in call.onCancel {} }  // as Android: answered only by JS cancelling it
    }
}

// MARK: - Tasks (ZnBackground.kt)

/// Runs a JS task with no screen (docs/plugins.md §6): `defineTask("sync", async (data, signal) => ...)` in JS, and
/// `ZnTasks.shared.run("sync", data) { outcome in ... }` from a plugin (the notifications plugin's dismiss and button
/// events, the messaging plugin's messages and tokens). As Android's ZnBackground: a queue until JS has loaded, a time
/// limit, one answer per task. JS starts with no window (ZnApp.prepare, which the app calls at launch; run() calls it
/// too if the app didn't), so a task in a background launch runs at once; one run with `keep: true` is also saved, so
/// it runs at the app's next start if this process ends first. `answerByMs` is Android's time limit (from run(),
/// queued or not), for a plugin that must answer iOS in time (a background push's fetchCompletionHandler).
/// Background time: while a task waits or runs, ZnTasks holds a UIApplication background task, so iOS doesn't suspend
/// the app halfway (Android: the plugin's own service or goAsync). When iOS ends that time, the tasks are answered as
/// at their answer-by time: aborted, dropped, or answered and kept for the next start. A plugin with its own
/// background time (a BGTask) passes `holdsBackgroundTime: false`.
public final class ZnTasks: ZnModuleBase, @unchecked Sendable {
    public enum Outcome: String { case done, failed, noTask = "no_task", timedOut = "timed_out" }

    public static let shared = ZnTasks()
    private static let appEventTask: UInt16 = 13  // ZnAppEvent.TASK on Android
    private static let keptKey = "zn.tasks.kept"
    private static let maxKept = 50

    private struct Task {
        let name: String
        let data: Any?
        let timeoutMs: Int
        let keptId: String?
        /// nil once answered early: its answer-by time passed while it waited for JS, and it is kept for JS.
        var onDone: ((Outcome) -> Void)?
        var timeout: DispatchWorkItem?
        var answerBy: DispatchSourceTimer?
        /// It keeps the app awake (background time) until it ends.
        var holds = true
        /// Restored from an earlier process (nobody waits for its answer): it holds background time once JS has it,
        /// not while it waits for JS that may never start in this process (an app that doesn't call ZnApp.prepare).
        var holdsWhenSent = false
    }

    // All main thread.
    private var tasks: [String: Task] = [:]
    private var queued: [String] = []
    private var loaded = false
    private var nextId = 0
    /// The background time held for the open tasks (one for all of them), or .invalid.
    private var backgroundTime: UIBackgroundTaskIdentifier = .invalid

    /// Main thread: JS has loaded and gets tasks (and events) now.
    public var isLoaded: Bool { loaded }

    private init() {
        super.init("Tasks", version: 1)
        function("done", onMain: true) { call in
            let outcome: Outcome = switch try call.stringOrNil("outcome") {
            case "done": .done
            case "no_task": .noTask
            default: .failed
            }
            self.finish(try call.string("id"), outcome)
            call.resolve(true)
        }
        // Saved tasks from an earlier process: queued now, sent when JS has loaded
        DispatchQueue.main.async { self.restoreKept() }
    }

    /// Runs task [name] with [data] (a JSON value). [onDone] is called once, on the main thread. The [timeoutMs] limit
    /// starts when JS gets the task: then JS's `signal` is aborted and the outcome is timedOut. [keep]: saved until JS has
    /// run it, also across app starts (events a user made: a dismiss, a button).
    /// [answerByMs]: [onDone] comes at the latest this long after this call, also while the task waits for JS (JS
    /// doesn't run in a background launch): timedOut. One not kept is then aborted if JS was running it, or dropped
    /// if it waited, as on Android. A kept task still runs once JS is up (this process or the next start), and one JS
    /// is already running goes on to its own [timeoutMs]. [holdsBackgroundTime] false: the caller keeps the app awake
    /// itself. JS starts now if nothing started it yet (ZnApp.prepare). Any thread.
    /// It returns this task's handle, for expire(_:).
    @discardableResult
    public func run(_ name: String, _ data: Any? = nil, timeoutMs: Int = 30_000, keep: Bool = false, answerByMs: Int? = nil,
                    holdsBackgroundTime: Bool = true, onDone: @escaping (Outcome) -> Void = { _ in }) -> Handle {
        let answerAt = answerByMs.map { DispatchTime.now() + .milliseconds(max(0, $0)) }  // from now, not from the main thread's turn
        let handle = Handle()
        DispatchQueue.main.async {
            let keptId = keep ? self.saveKept(name, data, timeoutMs) : nil
            var task = Task(name: name, data: data, timeoutMs: timeoutMs, keptId: keptId, onDone: onDone)
            task.holds = holdsBackgroundTime
            let id = self.enqueue(task)
            handle.id = id
            if let answerAt, let ms = answerByMs { self.answerBy(id, at: answerAt, ms: ms) }
            if handle.expireAsked { self.expire(id, why: "the caller's background time ended") }  // before it was queued
            MainActor.assumeIsolated {
                // An app that doesn't call ZnApp.prepare at launch: a plugin's wake (a push, a button) starts JS here.
                // Once per process: a restart (an update applied in place) brings its own runtime up.
                if !ZnApp.shared.everPrepared {
                    print("zn: task \(name): JS isn't running; starting it with no window")
                    ZnApp.shared.prepare(bundle: ZnBundles.builtInURL)
                }
            }
        }
        return handle
    }

    @discardableResult private func enqueue(_ task: Task) -> String {
        nextId += 1
        let id = "\(nextId)"
        tasks[id] = task
        if task.holds { holdBackgroundTime() }
        if loaded { send(id) } else { queued.append(id) }
        return id
    }

    // MARK: Background time

    private func holdBackgroundTime() {
        guard backgroundTime == .invalid else { return }
        backgroundTime = MainActor.assumeIsolated {
            UIApplication.shared.beginBackgroundTask(withName: "zn-task") { [weak self] in
                MainActor.assumeIsolated { self?.backgroundTimeEnds() }
            }
        }
    }

    /// After a task ended: no task that holds is left (waiting or running), so the time goes back.
    private func releaseBackgroundTimeIfDone() {
        guard backgroundTime != .invalid, !tasks.values.contains(where: \.holds) else { return }
        endBackgroundTime()
    }

    private func endBackgroundTime() {
        let id = backgroundTime
        backgroundTime = .invalid
        guard id != .invalid else { return }
        MainActor.assumeIsolated { UIApplication.shared.endBackgroundTask(id) }
    }

    /// iOS ends the background time (about 30 s in all): every open task is answered now, as at its answer-by time.
    private func backgroundTimeEnds() {
        let open = tasks.keys.sorted { Int($0) ?? 0 < Int($1) ?? 0 }
        if !open.isEmpty { print("zn: tasks: iOS ends the background time; answering \(open.count) open task(s) now") }
        for id in open { expire(id, why: "the background time ended") }
        // Those still open were answered and are kept: they no longer hold, so a later task's time goes back when it ends.
        for id in tasks.keys {
            tasks[id]?.holds = false
            tasks[id]?.holdsWhenSent = false
        }
        endBackgroundTime()
    }

    /// Main thread: task [id] must be answered at [at] ([ms] after run, for the log).
    private func answerBy(_ id: String, at: DispatchTime, ms: Int) {
        guard tasks[id] != nil else { return }  // answered already (JS was quick, or it couldn't be sent)
        tasks[id]?.answerBy = ZnDeadline.main(at: at) { [weak self] in self?.answerByPassed(id, ms) }  // on time (not asyncAfter)
    }

    private func answerByPassed(_ id: String, _ ms: Int) { expire(id, why: "within \(ms) ms") }

    /// One run() call's task, for expire(_:).
    public final class Handle: @unchecked Sendable {
        // Main thread: the task's id once run() queued it, and whether expire came first.
        fileprivate var id: String?
        fileprivate var expireAsked = false
    }

    /// A caller with its own background time (a BGTask, ZnBackgroundTasks) whose time ends: the task of [handle] is
    /// answered now, as at its answer-by time (aborted if JS runs it, dropped if it waits, answered and kept if kept).
    /// Only that task: another run of the same JS task goes on. On the main thread it is answered before this returns.
    public func expire(_ handle: Handle) {
        let go = {
            guard let id = handle.id else { handle.expireAsked = true; return }  // run() hasn't queued it yet
            self.expire(id, why: "the caller's background time ended")
        }
        if Thread.isMainThread { go() } else { DispatchQueue.main.async(execute: go) }
    }

    /// Task [id] must be answered now ([why]: its answer-by time, or iOS ended the background time).
    private func expire(_ id: String, why: String) {
        guard var task = tasks[id] else { return }
        let waiting = queued.contains(id)
        switch ZnTaskRules.answerBy(queued: waiting, kept: task.keptId != nil) {
        case .abort:
            ZNHost.shared.dispatchEvent(0, event: Self.appEventTask, string: ZnModules.json(["id": id, "abort": true]) ?? "{}")
            finish(id, .timedOut)
        case .drop:
            print("zn: task \(task.name): JS didn't get it (\(why))")
            finish(id, .timedOut)
        case .answerAndKeep:
            // Answered now (the plugin answers iOS); the saved copy stays, so JS still runs it (or goes on running it,
            // until it ends or its own time limit passes)
            guard task.onDone != nil else { return }  // answered already
            let kept = waiting ? "JS didn't get it (\(why)); kept, it runs when JS is up"
                : "JS still running it (\(why)); kept, it goes on until its own limit"
            print("zn: task \(task.name): \(Outcome.timedOut.rawValue) (\(kept))")
            let done = task.onDone
            task.onDone = nil
            task.answerBy?.cancel()
            task.answerBy = nil
            tasks[id] = task
            done?(.timedOut)
        }
    }

    /// ZnApp: main.hbc has run (startApp installed the task listener). Queued tasks go now.
    @MainActor func jsLoaded() {
        loaded = true
        let ids = queued
        queued = []
        ids.forEach(send)
    }

    /// ZnApp: JS is being replaced (an OTA restart). Tasks it was running are answered as failed; new ones wait.
    @MainActor func jsStopped() {
        loaded = false
        for (id, t) in tasks where !queued.contains(id) && t.keptId == nil { finish(id, .failed) }
        // A kept task JS hadn't answered runs again on the new JS
        for (id, t) in tasks where !queued.contains(id) && t.keptId != nil {
            t.timeout?.cancel()
            queued.append(id)
        }
    }

    private func send(_ id: String) {
        guard var task = tasks[id] else { return }
        var message: [String: Any] = ["id": id, "name": task.name, "data": task.data ?? NSNull()]
        if JSONSerialization.isValidJSONObject(message) == false { message["data"] = NSNull() }
        guard let json = ZnModules.json(message) else { return finish(id, .failed) }
        let timeout = DispatchWorkItem { [weak self] in
            ZNHost.shared.dispatchEvent(0, event: Self.appEventTask, string: ZnModules.json(["id": id, "abort": true]) ?? "{}")
            self?.finish(id, .timedOut)
        }
        task.timeout = timeout
        if task.holdsWhenSent {
            task.holdsWhenSent = false
            task.holds = true
            holdBackgroundTime()
        }
        tasks[id] = task
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(task.timeoutMs), execute: timeout)
        ZNHost.shared.dispatchEvent(0, event: Self.appEventTask, string: json)
    }

    private func finish(_ id: String, _ outcome: Outcome) {
        guard let task = tasks.removeValue(forKey: id) else { return }  // timed out already, or a late answer
        queued.removeAll { $0 == id }
        task.timeout?.cancel()
        task.answerBy?.cancel()
        if let kept = task.keptId { dropKept(kept) }
        defer { releaseBackgroundTimeIfDone() }
        guard let onDone = task.onDone else {
            return print("zn: task \(task.name): \(outcome.rawValue) (answered earlier, at its answer-by time)")
        }
        print("zn: task \(task.name): \(outcome.rawValue)")
        onDone(outcome)
    }

    // MARK: Kept tasks (UserDefaults: a list of { id, name, json, timeoutMs })
    // The data is kept as JSON text: a property list can't hold null (NSNull), which task data often has.

    private func keptList() -> [[String: Any]] {
        UserDefaults.standard.array(forKey: Self.keptKey) as? [[String: Any]] ?? []
    }

    private func saveKept(_ name: String, _ data: Any?, _ timeoutMs: Int) -> String {
        let id = UUID().uuidString
        var entry: [String: Any] = ["id": id, "name": name, "timeoutMs": timeoutMs]
        if let data, JSONSerialization.isValidJSONObject(["d": data]),
           let json = try? JSONSerialization.data(withJSONObject: ["d": data]) {
            entry["json"] = String(decoding: json, as: UTF8.self)
        }
        var list = keptList()
        list.append(entry)
        if list.count > Self.maxKept { list.removeFirst(list.count - Self.maxKept) }  // the oldest go first
        UserDefaults.standard.set(list, forKey: Self.keptKey)
        return id
    }

    private func dropKept(_ id: String) {
        UserDefaults.standard.set(keptList().filter { $0["id"] as? String != id }, forKey: Self.keptKey)
    }

    private func restoreKept() {
        for entry in keptList() {
            guard let id = entry["id"] as? String, let name = entry["name"] as? String else { continue }
            // "data": kept before 2026-11-10 (no nulls in it)
            let data = (entry["json"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }?["d"]
                ?? entry["data"]
            enqueue(Task(name: name, data: data, timeoutMs: entry["timeoutMs"] as? Int ?? 30_000, keptId: id,
                         onDone: { _ in }, timeout: nil, holds: false, holdsWhenSent: true))
        }
    }
}

/// Native motion (Android: ZnMotion.kt, values driven on the UI thread) isn't on iOS yet (milestones-ios.md, Phase 4).
/// Core imports it, so every bundle lists Motion v1 in its needs, though an app that never calls it (ZeroBill) doesn't
/// need it. Registered so such bundles (and OTA updates of them) run; every call answers "unavailable", as for a
/// missing method. A bundle that does use Motion must not ship to iOS until Phase 4.
final class ZnMotionNone: ZnModuleBase, @unchecked Sendable {
    init() { super.init("Motion", version: 1) }
}
