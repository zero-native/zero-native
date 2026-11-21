// The messaging plugin's iOS side (plugins/firebase-messaging, as android/.../PushPlugin.kt, PushModule.kt,
// ZnMessagingService.kt and Opens.kt): FCM's token and topics, messages as the JS task "push.message", new tokens as
// "push.token", and taps on the notifications iOS showed from a push (`opened`, `getInitialNotification`).
// docs/milestones-ios.md Phase 3.
//
// The app turns off Firebase's app delegate proxy (Info.plist FirebaseAppDelegateProxyEnabled = NO) and forwards three
// app delegate calls itself, so nothing is swizzled:
//
//   func application(_ a: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
//       FirebaseMessagingPlugin.apnsToken(token)
//   }
//   func application(_ a: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
//       FirebaseMessagingPlugin.apnsFailed(error)
//   }
//   func application(_ a: UIApplication, didReceiveRemoteNotification info: [AnyHashable: Any],
//                    fetchCompletionHandler done: @escaping (UIBackgroundFetchResult) -> Void) {
//       FirebaseMessagingPlugin.remoteNotification(info, done)
//   }
//
// It also needs the push entitlement (aps-environment) and the remote-notification background mode.
//
// iOS differences from Android:
// - iOS shows a push with an alert itself while the app is behind or closed (the server's `apns` block), with no app
//   code. JS hears of it later, once per message id: at the next start or return to the front `push.message` runs with
//   `shown: true` and `shownAt` (from the service extension's notes with an App Group, else from the notification
//   centre's list), and a tap (`opened`), a swipe (`push.dismissed`, the notifications plugin's onDismiss) or a button
//   (`push.action`, onAction) reach JS as for the app's own notifications. Whether iOS could show it (permission, Focus)
//   isn't known per push: `Notifications.getNotificationSettings` says what the user allows.
//   While the app is in front, `push.message` runs (with `notification` set) and iOS shows nothing (`foreground`), so
//   the app shows its own, as on Android.
// - Data-only messages (content-available) reach the app only while it runs, or as a background wake that iOS rations
//   and never gives after the user closed the app. iOS's fetchCompletionHandler is answered once, within 25 s, even when
//   JS is slow or not running (ZnTasks' answerByMs, and a cap here): a handler never called makes iOS end the app and
//   wake it less. JS doesn't start for a background launch yet (§3): the message is kept and `push.message` runs at the
//   next start (or when the app opens), with its `sentAt`, so JS can tell it is late.
// - `zn_ota=check` messages run core's OTA check natively (OtaPush.swift), as Android's OTA check job, within iOS's
//   limits for background pushes.
import Foundation
import UIKit
import UserNotifications
#if SWIFT_PACKAGE
import ZnRuntime
import ZnPluginFirebaseApp
import ZnPluginNotifications
#endif
// In the Swift package the SDK is a declared dependency (ios/packages/firebase/Package.swift): without it, stop the build
// instead of building a plugin that quietly does nothing. The CMake builds may leave the SDK out on purpose.
#if SWIFT_PACKAGE && !(canImport(FirebaseMessaging))
#error("ZnPluginFirebaseMessaging needs FirebaseMessaging: check ios/packages/firebase/Package.swift")
#endif
#if canImport(FirebaseMessaging)
import FirebaseMessaging
#endif

/// The plugin's choices with no iOS in them (PushRules.kt).
enum PushRules {
    static let messageTask = "push.message", tokenTask = "push.token", dismissTask = "push.dismissed", actionTask = "push.action"
    /// The service extension's notes of pushes iOS showed (ZnServiceRules.deliveredKey).
    static let deliveredKey = "zn.push.delivered"
    static let provider = "fcm"
    /// The task's time (Android: PushEvents.MESSAGE_TIMEOUT_MS). iOS gives a background wake about 30 s.
    static let messageTimeoutMs = 15_000
    /// iOS's fetchCompletionHandler is answered by then (as OTA pushes, OtaPushRules.answerByMs), JS done or not.
    static let answerByMs = 25_000
    /// The plugin's own cap on that answer, should nothing else answer (a path with no task).
    static let answerCapMs = 27_000
    /// The APNs token comes back in a moment; with no network or no push entitlement it never does.
    static let apnsWaitMs = 10_000
    static let otaKey = "zn_ota", otaCheck = "check"

    /// FCM's own rule for topic names.
    static func validTopic(_ topic: String) -> Bool { topic.range(of: #"^[a-zA-Z0-9\-_.~%]{1,900}$"#, options: .regularExpression) != nil }

    /// FCM's id for a message (in every push it sends).
    static func messageId(_ info: [AnyHashable: Any]) -> String? { info["gcm.message_id"] as? String }

    /// The message's own data: APNs' and FCM's keys (aps, gcm.*, google.*, fcm_options, from, collapse_key) left out.
    static func data(_ info: [AnyHashable: Any]) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in info {
            guard let key = k as? String, let value = v as? String else { continue }
            if key == "aps" || key == "fcm_options" || key == "from" || key == "collapse_key" { continue }
            if key.hasPrefix("gcm.") || key.hasPrefix("google.") { continue }
            out[key] = value
        }
        return out
    }

    /// The alert's title and body from `aps.alert` (a string is the body alone); nil with no alert.
    static func alert(_ info: [AnyHashable: Any]) -> (title: String?, body: String?)? {
        let alert = (info["aps"] as? [String: Any])?["alert"]
        if let s = alert as? String { return (nil, s) }
        guard let d = alert as? [String: Any] else { return nil }
        let title = d["title"] as? String, body = d["body"] as? String
        return title == nil && body == nil ? nil : (title, body)
    }

    /// When FCM sent it (google.c.a.ts, seconds, with analytics on), else [now], ms since 1970.
    static func sentAt(_ info: [AnyHashable: Any], now: Int64) -> Int64 {
        if let s = info["google.c.a.ts"] as? String, let t = Int64(s) { return t * 1000 }
        return now
    }

    /// What FCM's token errors mean for the app (TokenReason in src/index.ts).
    static func tokenReason(_ message: String?) -> String {
        guard let m = message?.lowercased() else { return "failed" }
        if m.contains("network") || m.contains("timed out") || m.contains("offline") || m.contains("internet") { return "not_now" }
        return "failed"
    }

    /// The message JS gets (PushMessage in plugins/notifications/src/index.ts).
    static func message(_ info: [AnyHashable: Any], inFront: Bool, notification: (title: String?, body: String?)?,
                        now: Int64) -> [String: Any] {
        let notice: Any = notification.map { ["title": $0.title as Any? ?? NSNull(), "body": $0.body as Any? ?? NSNull()] } ?? NSNull()
        return [
            "provider": provider,
            "messageId": messageId(info) as Any? ?? NSNull(),
            "from": (info["from"] as? String) as Any? ?? NSNull(),
            "sentAt": sentAt(info, now: now),
            // APNs doesn't tell the app its priority
            "priority": "unknown", "originalPriority": "unknown",
            "inFront": inFront,
            "data": data(info),
            "notification": notice,
        ]
    }

    /// A tap on a notification iOS showed from a push (OpenedMessage in src/index.ts).
    static func opened(_ info: [AnyHashable: Any], now: Int64) -> [String: Any] {
        [
            "messageId": messageId(info) ?? "",
            "from": (info["from"] as? String) as Any? ?? NSNull(),
            "sentAt": sentAt(info, now: now),
            "data": data(info),
        ]
    }
}

/// Add it with `ZnPlugins.register(..., FirebaseMessagingPlugin())`. It adds NotificationsPlugin itself (as on Android),
/// so an app that lists only this plugin keeps its notifications.
/// `foreground`: what iOS shows of a push while the app is in front. None by default: `push.message` runs and the app
/// shows its own (with its tap rules), as on Android.
/// `otaCheck`: a `zn_ota=check` message runs core's OTA check natively, and the app joins the OTA server's topic
/// `zn-ota-<app>-<channel>` (OtaPush.swift; Android: PushPlugin(otaCheck)). False: the kept topic is left.
public struct FirebaseMessagingPlugin: ZnPlugin {
    public init(foreground: UNNotificationPresentationOptions = [], otaCheck: Bool = true) {
        self.foreground = foreground
        self.otaCheck = otaCheck
    }

    public var foreground: UNNotificationPresentationOptions = []
    public var otaCheck = true

    public func register(_ r: ZnPluginRegistry) {
        r.requireHostApi(8)
        NotificationsPlugin().register(r)  // does nothing when the app listed it already
        let on = ZnFirebase.start()
        let module = FirebaseMessagingModule.shared
        module.start(on: on, foreground: foreground)
        module.startDelivered()
        r.module(module)
        MainActor.assumeIsolated {
            OtaPush.enabled = otaCheck
            OtaPush.registerTask()  // before the launch ends (iOS's rule)
        }
    }

    // The app delegate's calls (the file's header).
    @MainActor public static func apnsToken(_ token: Data) { FirebaseMessagingModule.shared.apnsToken(token) }
    @MainActor public static func apnsFailed(_ error: Error) { FirebaseMessagingModule.shared.apnsFailed(error) }
    @MainActor public static func remoteNotification(_ info: [AnyHashable: Any], _ done: @escaping (UIBackgroundFetchResult) -> Void) {
        FirebaseMessagingModule.shared.remoteNotification(info, done)
    }
}

/// The "FirebaseMessaging" module. With Firebase off (no SDK or no GoogleService-Info.plist) every call answers
/// "unavailable" / false, and taps still reach JS.
final class FirebaseMessagingModule: ZnModuleBase, @unchecked Sendable {
    static let shared = FirebaseMessagingModule()
    private let lock = NSLock()
    private var on = false
    private var foreground: UNNotificationPresentationOptions = []
    /// Waiting for the APNs token: each gets nil (have it) or a TokenReason.
    private var apnsWaiters: [(String?) -> Void] = []
    private var apnsError: String?
    /// A tap that came before JS had loaded: `getInitialNotification`, once.
    private var initial: [String: Any]?
    /// Recent message ids, kept across starts: a push can reach willPresent, the app delegate, the service extension's
    /// note and the notification centre's list.
    private lazy var seen: [String] = UserDefaults.standard.stringArray(forKey: Self.seenKey) ?? []
    private static let seenKey = "zn.push.seen", maxSeen = 200
    /// The token whose `push.token` task is running.
    private var tokenRunning: String?
    private let delegate = Delegate()
    private static let lastTokenKey = "zn.push.lastToken"

    private init() {
        super.init("FirebaseMessaging", version: 2)
        function("status") { $0.resolve(["available": self.on]) }
        function("getToken") { call in self.token { call.resolve($0) } }
        function("deleteToken") { call in
            guard self.on else { return call.resolve(false) }
            #if canImport(FirebaseMessaging)
            Messaging.messaging().deleteToken { error in
                if error == nil { UserDefaults.standard.removeObject(forKey: Self.lastTokenKey) }
                call.resolve(error == nil)
            }
            #else
            call.resolve(false)
            #endif
        }
        function("subscribe") { call in self.topic(call, subscribe: true) }
        function("unsubscribe") { call in self.topic(call, subscribe: false) }
        function("getInitialNotification", onMain: true) { call in
            call.resolve(self.lock.withLock { () -> Any? in defer { self.initial = nil }; return self.initial })
        }
        function("setAutoInitEnabled") { call in
            let value = call.args["on"] as? Bool ?? false
            #if canImport(FirebaseMessaging)
            if self.on { Messaging.messaging().isAutoInitEnabled = value }
            #endif
            call.resolve(self.on)
        }
        function("isAutoInitEnabled") { call in
            #if canImport(FirebaseMessaging)
            call.resolve(self.on && Messaging.messaging().isAutoInitEnabled)
            #else
            call.resolve(false)
            #endif
        }
    }

    @MainActor func start(on: Bool, foreground: UNNotificationPresentationOptions) {
        self.on = on
        self.foreground = foreground
        delegate.module = self
        ZnNotificationCenter.shared.remote = delegate
        if !on { print("zn-push: Firebase is off, so push is off (taps on notifications still reach JS)") }
        #if canImport(FirebaseMessaging)
        guard on else { return }
        Messaging.messaging().delegate = delegate
        // With auto init FCM makes its token at the first start; it needs the APNs token for that.
        if Messaging.messaging().isAutoInitEnabled { UIApplication.shared.registerForRemoteNotifications() }
        #endif
    }

    /// Before Firebase's check: pushes iOS showed while the app was behind or closed reach JS on any app.
    @MainActor func startDelivered() {
        takeDelivered()
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.takeDelivered() }
        }
    }

    // MARK: pushes iOS showed (the service extension's notes)

    /// The App Group the service extension writes to (Info.plist `ZnAppGroup`), if the app has one.
    private static var deliveredStore: UserDefaults? {
        (Bundle.main.object(forInfoDictionaryKey: "ZnAppGroup") as? String).flatMap { UserDefaults(suiteName: $0) }
    }

    /// Runs `push.message` (`shown: true`) for each push iOS showed that JS hasn't heard of: first the service
    /// extension's notes (with an App Group: every one, with the time), then the ones still in the notification centre
    /// (no extension needed; the ones the user already cleared are missed). Each is kept until JS has run it.
    @MainActor private func takeDelivered() {
        var count = 0
        if let store = Self.deliveredStore, let list = store.array(forKey: PushRules.deliveredKey) as? [[String: Any]], !list.isEmpty {
            store.removeObject(forKey: PushRules.deliveredKey)
            for e in list {
                var info: [AnyHashable: Any] = e["data"] as? [String: String] ?? [:]
                if let id = e["id"] as? String { info["gcm.message_id"] = id }
                if let from = e["from"] as? String { info["from"] = from }
                if shown(info, title: e["title"] as? String, body: e["body"] as? String, at: (e["at"] as? NSNumber)?.int64Value ?? Self.now) {
                    count += 1
                }
            }
        }
        UNUserNotificationCenter.current().getDeliveredNotifications { list in
            DispatchQueue.main.async {
                var more = 0
                for n in list where !ZnNotificationCenter.isOwn(n) && PushRules.messageId(n.request.content.userInfo) != nil {
                    if self.shown(n) { more += 1 }
                }
                if count + more > 0 { print("zn-push: \(count + more) push(es) iOS showed, sent to JS") }
            }
        }
    }

    /// `push.message` with `shown: true` for a push iOS showed, once per message id (also across starts). False if JS had it.
    @MainActor @discardableResult private func shown(_ info: [AnyHashable: Any], title: String?, body: String?, at: Int64) -> Bool {
        guard PushRules.data(info)[PushRules.otaKey] != PushRules.otaCheck, first(info) else { return false }
        var message = PushRules.message(info, inFront: false, notification: (title: title, body: body), now: at)
        message["shown"] = true
        message["shownAt"] = at
        ZnTasks.shared.run(PushRules.messageTask, message, timeoutMs: PushRules.messageTimeoutMs, keep: true)
        return true
    }

    @MainActor @discardableResult private func shown(_ n: UNNotification) -> Bool {
        let c = n.request.content
        return shown(c.userInfo, title: c.title.isEmpty ? nil : c.title, body: c.body.isEmpty ? nil : c.body,
                     at: Int64(n.date.timeIntervalSince1970 * 1000))
    }

    /// A push in front was noted by the extension too, but iOS didn't show it (the app does): its note goes.
    private func dropDelivered(_ id: String?) {
        guard let id, let store = Self.deliveredStore,
              var list = store.array(forKey: PushRules.deliveredKey) as? [[String: Any]] else { return }
        let before = list.count
        list.removeAll { $0["id"] as? String == id }
        if list.count != before { store.set(list, forKey: PushRules.deliveredKey) }
    }

    // MARK: the token

    private func token(_ done: @escaping ([String: Any]) -> Void) {
        func none(_ reason: String) -> [String: Any] { ["token": NSNull(), "reason": reason] }
        guard on else { return done(none("unavailable")) }
        #if canImport(FirebaseMessaging)
        apns { reason in
            if let reason { return done(none(reason)) }
            Messaging.messaging().token { token, error in
                if let token, !token.isEmpty { return done(["token": token, "reason": NSNull()]) }
                let reason = PushRules.tokenReason(error?.localizedDescription)
                print("zn-push: no FCM token (\(reason)): \(error?.localizedDescription ?? "-")")
                done(none(reason))
            }
        }
        #else
        done(none("unavailable"))
        #endif
    }

    /// Calls back once FCM has the APNs token (nil), or with a reason after a failure or [PushRules.apnsWaitMs].
    private func apns(_ done: @escaping (String?) -> Void) {
        #if canImport(FirebaseMessaging)
        if Messaging.messaging().apnsToken != nil { return done(nil) }
        #endif
        var once = false
        let finish: (String?) -> Void = { [weak self] r in
            guard let self, self.lock.withLock({ () -> Bool in defer { once = true }; return !once }) else { return }
            done(r)
        }
        lock.withLock { apnsWaiters.append(finish) }
        DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(PushRules.apnsWaitMs)) {
            guard !self.lock.withLock({ once }) else { return }  // the token came in time
            let reason = self.lock.withLock { self.apnsError } ?? "not_now"
            print("zn-push: no APNs token after \(PushRules.apnsWaitMs) ms (\(reason))")
            finish(reason)
        }
    }

    @MainActor func apnsToken(_ token: Data) {
        print("zn-push: APNs token received")  // never the token itself
        #if canImport(FirebaseMessaging)
        if on { Messaging.messaging().apnsToken = token }  // FCM tells sandbox from production by the app's profile
        #endif
        // A topic FCM refused before APNs answered (a fresh install) can be joined now
        if on { DispatchQueue.main.async { OtaPush.syncTopic(firebaseOn: true) } }
        let waiters = lock.withLock { () -> [(String?) -> Void] in defer { apnsWaiters = []; apnsError = nil }; return apnsWaiters }
        waiters.forEach { $0(nil) }
    }

    @MainActor func apnsFailed(_ error: Error) {
        // No aps-environment entitlement, or no network for APNs: a simulator without push says so here too
        print("zn-push: APNs registration failed: \(error.localizedDescription)")
        let reason = PushRules.tokenReason(error.localizedDescription)
        let waiters = lock.withLock { () -> [(String?) -> Void] in defer { apnsWaiters = []; apnsError = reason }; return apnsWaiters }
        waiters.forEach { $0(reason) }
    }

    /// A new FCM token (FCM says it at every start): `push.token` when it changed since the last one JS took.
    fileprivate func newToken(_ token: String) {
        // FCM says its token at every start once APNs answered: only then can it join a topic
        if !token.isEmpty { DispatchQueue.main.async { OtaPush.syncTopic(firebaseOn: true) } }
        guard !token.isEmpty, UserDefaults.standard.string(forKey: Self.lastTokenKey) != token else { return }
        // FCM can say the same token twice at a start, before the first task has answered
        guard lock.withLock({ () -> Bool in defer { tokenRunning = token }; return tokenRunning != token }) else { return }
        ZnTasks.shared.run(PushRules.tokenTask, ["token": token, "provider": PushRules.provider],
                           timeoutMs: PushRules.messageTimeoutMs) { outcome in
            if case .done = outcome { UserDefaults.standard.set(token, forKey: Self.lastTokenKey) }
            self.lock.withLock { if self.tokenRunning == token { self.tokenRunning = nil } }
        }
    }

    private func topic(_ call: ZnCall, subscribe: Bool) {
        let topic = call.args["topic"] as? String ?? ""
        guard PushRules.validTopic(topic) else { return call.reject("invalid_args", "\"\(topic)\" is not a valid FCM topic name") }
        guard on else { return call.resolve(false) }
        #if canImport(FirebaseMessaging)
        // FCM waits for its token before it subscribes; with no APNs token that is never, so the call has a limit
        var once = false
        let finish: (Bool) -> Void = { ok in
            guard self.lock.withLock({ () -> Bool in defer { once = true }; return !once }) else { return }
            call.resolve(ok)
        }
        let done: (Error?) -> Void = { error in
            if let error { print("zn-push: \(subscribe ? "subscribe" : "unsubscribe") \(topic) failed: \(error.localizedDescription)") }
            finish(error == nil)
        }
        apns { reason in
            if reason != nil { return finish(false) }
            if subscribe { Messaging.messaging().subscribe(toTopic: topic, completion: done) }
            else { Messaging.messaging().unsubscribe(fromTopic: topic, completion: done) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { finish(false) }
        #else
        call.resolve(false)
        #endif
    }

    // MARK: messages and taps

    private static var now: Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    /// True the first time this message id is seen (messages with no id always pass).
    private func first(_ info: [AnyHashable: Any]) -> Bool {
        guard let id = PushRules.messageId(info) else { return true }
        return lock.withLock {
            if seen.contains(id) { return false }
            seen.append(id)
            if seen.count > Self.maxSeen { seen.removeFirst(seen.count - Self.maxSeen) }
            UserDefaults.standard.set(seen, forKey: Self.seenKey)
            return true
        }
    }

    /// Runs `push.message` for a push (once per message id); [done] after the task, or at [answerAt] (CACurrentMediaTime
    /// seconds: FCM's own call here can take a second). [keep]: saved until JS has run it, also across starts.
    private func deliver(_ info: [AnyHashable: Any], inFront: Bool, notification: (title: String?, body: String?)?,
                         keep: Bool = false, answerAt: CFTimeInterval? = nil, done: @escaping (Bool) -> Void = { _ in }) {
        #if canImport(FirebaseMessaging)
        if on { Messaging.messaging().appDidReceiveMessage(info) }  // FCM's delivery analytics
        #endif
        let data = PushRules.data(info)
        guard first(info) else { return done(false) }
        if data[PushRules.otaKey] == PushRules.otaCheck {
            // Not for JS: core's OTA check (OtaPush.swift)
            return DispatchQueue.main.async { OtaPush.message(data, id: PushRules.messageId(info), done: done) }
        }
        let message = PushRules.message(info, inFront: inFront, notification: notification, now: Self.now)
        ZnTasks.shared.run(PushRules.messageTask, message, timeoutMs: PushRules.messageTimeoutMs, keep: keep,
                           answerByMs: answerAt.map { max(0, Int(($0 - CACurrentMediaTime()) * 1000)) }) { outcome in
            if case .done = outcome { done(true) } else { done(false) }
        }
    }

    /// A push the app delegate got: a data message (content-available), or one iOS also shows. iOS's [done] is called
    /// once, within PushRules.answerByMs (called twice it crashes; never called, iOS ends the app and wakes it less).
    @MainActor func remoteNotification(_ info: [AnyHashable: Any], _ done: @escaping (UIBackgroundFetchResult) -> Void) {
        let inFront = UIApplication.shared.applicationState == .active
        let t0 = CACurrentMediaTime()
        print("zn-push: a push for the app (\(inFront ? "in front" : "behind"), JS \(ZnTasks.shared.isLoaded ? "up" : "not up yet"))")
        // The cap, should nothing below answer: cancelled once iOS is answered, so it doesn't hold [done] for 27 s
        var cap: DispatchSourceTimer?
        let answer = ZnOnce<(UIBackgroundFetchResult, String)> { r in
            let (result, why) = r
            print("zn-push: answered iOS (\(result == .newData ? "new data" : "no data"), \(why)) after \(Int((CACurrentMediaTime() - t0) * 1000)) ms")
            cap?.cancel()
            cap = nil
            done(result)
        }
        cap = ZnDeadline.main(at: .now() + .milliseconds(PushRules.answerCapMs)) { answer((.noData, "no answer in time")) }
        // JS isn't running (a background launch, or not yet up) or the app is behind: kept, so a process iOS ends
        // before JS runs it doesn't lose it
        let keep = !inFront || !ZnTasks.shared.isLoaded
        deliver(info, inFront: inFront, notification: PushRules.alert(info), keep: keep,
                answerAt: t0 + Double(PushRules.answerByMs) / 1000) { ran in
            DispatchQueue.main.async { answer(ran ? (.newData, "JS ran it") : (.noData, ZnTasks.shared.isLoaded ? "not run" : "JS isn't up")) }
        }
    }

    /// A push iOS is about to show while the app is in front.
    @MainActor fileprivate func willPresent(_ n: UNNotification) -> UNNotificationPresentationOptions {
        let c = n.request.content
        let notice = c.title.isEmpty && c.body.isEmpty ? nil : (title: c.title.isEmpty ? nil : c.title, body: c.body.isEmpty ? nil : c.body)
        dropDelivered(PushRules.messageId(c.userInfo))
        deliver(c.userInfo, inFront: true, notification: notice ?? PushRules.alert(c.userInfo))
        return foreground
    }

    /// A tap, a swipe or a button on a notification iOS showed from a push.
    @MainActor fileprivate func didReceive(_ response: UNNotificationResponse) {
        let info = response.notification.request.content.userInfo
        #if canImport(FirebaseMessaging)
        if on { Messaging.messaging().appDidReceiveMessage(info) }
        #endif
        // iOS showed it: JS hears that first, if no other way told it yet (no service extension, or not noted)
        shown(response.notification)
        let id = PushRules.messageId(info) ?? response.notification.request.identifier
        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier:
            break
        case UNNotificationDismissActionIdentifier:
            // A swipe (its category has the dismiss action: the service extension's default, zn.default): the
            // notifications plugin's onDismiss, as for the app's own. Kept until JS runs it (iOS may start the app in
            // the background for it; JS runs it at the next start).
            print("zn-push: a push swiped away, sent to JS")
            ZnTasks.shared.run(PushRules.dismissTask, ["id": id, "data": PushRules.data(info), "provider": PushRules.provider],
                               timeoutMs: 8_000, keep: true)
            return
        default:
            // A button of the push's category (`aps.category`, one the app set with setNotificationCategories):
            // the notifications plugin's onAction. A button marked foreground has opened the app too.
            var event: [String: Any] = ["id": id, "actionId": response.actionIdentifier, "data": PushRules.data(info),
                                        "provider": PushRules.provider]
            if let text = (response as? UNTextInputNotificationResponse)?.userText { event["input"] = text }
            print("zn-push: a button on a push, sent to JS")
            ZnTasks.shared.run(PushRules.actionTask, event, timeoutMs: 8_000, keep: true)
            return
        }
        let message = PushRules.opened(info, now: Self.now)
        if ZnTasks.shared.isLoaded {
            emit("opened", message)
        } else {
            lock.withLock { initial = message }
        }
    }

    /// The NSObject side: FCM's and the notification center's delegates.
    final class Delegate: NSObject, ZnNotificationCenter.Remote {
        weak var module: FirebaseMessagingModule?
        func willPresent(_ notification: UNNotification) -> UNNotificationPresentationOptions {
            MainActor.assumeIsolated { module?.willPresent(notification) ?? [] }
        }
        func didReceive(_ response: UNNotificationResponse) {
            MainActor.assumeIsolated { module?.didReceive(response) }
        }
    }
}

#if canImport(FirebaseMessaging)
extension FirebaseMessagingModule.Delegate: MessagingDelegate {
    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        if let fcmToken { module?.newToken(fcmToken) }
    }
}
#endif
