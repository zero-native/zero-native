// The small built-in modules on iOS, each the counterpart of an android/runtime module with the same name, methods
// and answers (the JS side is shared: packages/core/src/os.ts, netinfo.ts, secure-store.ts, clipboard.ts).
import Foundation
import Network
import Security
import UIKit

/// The app's frontmost view controller, to present system sheets from. Main thread.
@MainActor
func znTopController() -> UIViewController? {
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
final class ZnOs: ZnModuleBase, @unchecked Sendable {
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
    static var model: String {
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
/// limit, one answer per task. iOS starts JS when the window opens, so a task that comes while JS isn't running waits;
/// one run with `keep: true` is also saved, so it runs at the app's next start if this process ends first
/// (docs/ios-notifications-plan.md §3). It doesn't keep the process alive: the plugin's own background time does.
final class ZnTasks: ZnModuleBase, @unchecked Sendable {
    enum Outcome: String { case done, failed, noTask = "no_task", timedOut = "timed_out" }

    static let shared = ZnTasks()
    private static let appEventTask: UInt16 = 13  // ZnAppEvent.TASK on Android
    private static let keptKey = "zn.tasks.kept"
    private static let maxKept = 50

    private struct Task {
        let name: String
        let data: Any?
        let timeoutMs: Int
        let keptId: String?
        let onDone: (Outcome) -> Void
        var timeout: DispatchWorkItem?
    }

    // All main thread.
    private var tasks: [String: Task] = [:]
    private var queued: [String] = []
    private var loaded = false
    private var nextId = 0

    /// Main thread: JS has loaded and gets tasks (and events) now.
    var isLoaded: Bool { loaded }

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
    /// run it, also across app starts (events a user made: a dismiss, a button). Any thread.
    func run(_ name: String, _ data: Any? = nil, timeoutMs: Int = 30_000, keep: Bool = false, onDone: @escaping (Outcome) -> Void = { _ in }) {
        DispatchQueue.main.async {
            let keptId = keep ? self.saveKept(name, data, timeoutMs) : nil
            self.enqueue(Task(name: name, data: data, timeoutMs: timeoutMs, keptId: keptId, onDone: onDone))
        }
    }

    private func enqueue(_ task: Task) {
        nextId += 1
        let id = "\(nextId)"
        tasks[id] = task
        if loaded { send(id) } else { queued.append(id) }
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
        tasks[id] = task
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(task.timeoutMs), execute: timeout)
        ZNHost.shared.dispatchEvent(0, event: Self.appEventTask, string: json)
    }

    private func finish(_ id: String, _ outcome: Outcome) {
        guard let task = tasks.removeValue(forKey: id) else { return }  // timed out already, or a late answer
        queued.removeAll { $0 == id }
        task.timeout?.cancel()
        if let kept = task.keptId { dropKept(kept) }
        print("zn: task \(task.name): \(outcome.rawValue)")
        task.onDone(outcome)
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
                         onDone: { _ in }, timeout: nil))
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
