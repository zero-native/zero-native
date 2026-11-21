// OTA checks started by push on iOS (Android: OtaCheckJob.kt, OtaTopic): the OTA server sends a data message
// `zn_ota=check` (with `zn_ota_delay_ms`, the longest random wait) to the topic `zn-ota-<app>-<channel>`, and the phone
// runs core's normal check (ZnOta.check) natively, with no JS. Like a check at a start it only downloads and installs:
// the new bundle runs from the next cold start (or `Updates.applyNow()`).
//
// iOS is not Android here:
// - The push must wake the app: the server's `apns` block for it is a background push (`apns-push-type: background`,
//   `apns-priority: 5`, `aps.content-available: 1`). iOS throttles those (a few an hour) and never delivers them to an
//   app the user swiped away in the app switcher; the next start checks as always.
// - A woken app has about 30 s. A random wait up to `inlineMs` runs inside that time (the check gets a background task
//   while it lasts). A longer wait becomes a background refresh task (BGTaskScheduler) due after the wait, if the app
//   declared it: Info.plist `BGTaskSchedulerPermittedIdentifiers` with `dev.zeronative.ota-check`, and `fetch` in
//   `UIBackgroundModes`. iOS decides when it runs (often later than asked). Without it, nothing is scheduled: the next
//   start or return checks anyway.
// - No retries after a failed check (Android: WorkManager, 3 runs): the next start or return checks.
import BackgroundTasks
import Foundation
import UIKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif
#if canImport(FirebaseMessaging)
@preconcurrency import FirebaseMessaging
#endif

/// The rules with no iOS in them (PushRules.kt's OTA part).
enum OtaPushRules {
    static let delayKey = "zn_ota_delay_ms"
    /// A message can't ask for a longer wait than this (one day).
    static let maxDelayMs: Int64 = 24 * 60 * 60 * 1000
    /// A wait up to this runs in the woken app's ~30 s; the check itself must fit in what is left.
    static let inlineMs: Int64 = 10_000
    /// The woken app answers iOS by then, even if the check goes on (under its background task).
    static let answerByMs: Int64 = 25_000
    static let taskId = "dev.zeronative.ota-check"

    /// The message's longest wait: whole ms, clamped to 0 ... maxDelayMs; missing or not a number is 0.
    static func maxDelayMs(_ data: [String: String]) -> Int64 {
        guard let v = data[delayKey].flatMap({ Int64($0.trimmingCharacters(in: .whitespaces)) }) else { return 0 }
        return min(max(v, 0), maxDelayMs)
    }

    /// This phone's wait: random in 0 ... [maxMs], so phones don't all ask at once.
    static func delayMs(_ maxMs: Int64, random: (ClosedRange<Int64>) -> Int64 = { Int64.random(in: $0) }) -> Int64 {
        maxMs <= 0 ? 0 : random(0...min(maxMs, maxDelayMs))
    }

    /// `zn-ota-<app>-<channel>`, or nil if it breaks FCM's topic rule.
    static func topic(app: String, channel: String) -> String? {
        let t = "zn-ota-\(app)-\(channel)"
        return !app.isEmpty && !channel.isEmpty && PushRules.validTopic(t) ? t : nil
    }

    /// The kept topic to unsubscribe once [now] is subscribed: the old one if it changed.
    static func topicToDrop(old: String?, now: String) -> String? { old == now ? nil : old }
}

/// The topic and the checks. Main thread.
@MainActor enum OtaPush {
    private static let topicKey = "zn.push.otaTopic"
    private static var taskRegistered = false
    private static var topicSynced = false
    private static var topicRetries = 0
    static var enabled = true

    /// Before the app finishes launching (iOS's rule for background tasks): the refresh task's handler, if declared.
    static func registerTask() {
        let ids = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String] ?? []
        guard !taskRegistered, ids.contains(OtaPushRules.taskId) else { return }
        taskRegistered = BGTaskScheduler.shared.register(forTaskWithIdentifier: OtaPushRules.taskId, using: .main) { task in
            MainActor.assumeIsolated { runTask(task) }
        }
    }

    /// Once per process, when FCM has its token and when APNs answers (FCM can't join a topic before APNs answered, and
    /// on a fresh install FCM can say its token first; a failed try is tried again at the next of the two): the topic for this app and channel (FCM ignores a repeat), the old one dropped. OTA pushes off: the kept
    /// topic is dropped. OTA off (ZnOta not configured): nothing changes.
    static func syncTopic(firebaseOn: Bool) {
        #if canImport(FirebaseMessaging)
        guard firebaseOn, !topicSynced else { return }
        topicSynced = true
        let key = topicKey  // the completions below run outside the main actor's view (each reads UserDefaults itself)
        let old = UserDefaults.standard.string(forKey: key)
        let m = Messaging.messaging()
        guard enabled else {
            if let old {
                m.unsubscribe(fromTopic: old) { error in
                    if error == nil { UserDefaults.standard.removeObject(forKey: key) }
                    print("zn-push: OTA pushes off: unsubscribe from \(old) \(error == nil ? "done" : "failed")")
                }
            }
            return
        }
        guard let (app, channel) = ZnOta.appAndChannel() else {
            print("zn-push: no OTA topic: OTA is off in this app (ZnOta not configured)")
            return
        }
        guard let topic = OtaPushRules.topic(app: app, channel: channel) else {
            print("zn-push: no OTA topic: \"zn-ota-\(app)-\(channel)\" is not a valid FCM topic name")
            return
        }
        m.subscribe(toTopic: topic) { error in
            if let error {
                // Often "No APNS token specified": FCM had its token before APNs answered. Tried again when APNs
                // answers (or FCM's token comes again), else at the next start.
                print("zn-push: subscribe to the OTA topic \(topic) failed (tried again later): \(error.localizedDescription)")
                DispatchQueue.main.async {
                    MainActor.assumeIsolated {
                        topicSynced = false
                        // APNs may have answered while this try was out: one more try of its own, 2 s later
                        guard Messaging.messaging().apnsToken != nil, topicRetries < 2 else { return }
                        topicRetries += 1
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { syncTopic(firebaseOn: true) }
                    }
                }
                return
            }
            guard old != topic else { return }
            UserDefaults.standard.set(topic, forKey: key)
            print("zn-push: subscribed to the OTA topic \(topic)\(old.map { " (was \($0))" } ?? "")")
            if let drop = OtaPushRules.topicToDrop(old: old, now: topic) {
                Messaging.messaging().unsubscribe(fromTopic: drop) { e in print("zn-push: unsubscribe from the old OTA topic \(drop) \(e == nil ? "done" : "failed")") }
            }
        }
        #endif
    }

    /// A `zn_ota=check` message. [done] once, with whether a check ran.
    static func message(_ data: [String: String], id: String?, done: @escaping (Bool) -> Void) {
        let label = id ?? "-"
        guard enabled else { return done(false) }
        guard ZnOta.appAndChannel() != nil else {
            print("zn-push: message \(label): OTA check asked, but OTA is off in this app")
            return done(false)
        }
        let maxMs = OtaPushRules.maxDelayMs(data)
        let delay = OtaPushRules.delayMs(maxMs)
        if delay <= OtaPushRules.inlineMs {
            print("zn-push: message \(label): OTA check in \(delay) ms (random in 0..\(maxMs) ms)")
            return checkNow(after: delay, done: done)
        }
        guard taskRegistered else {
            print("zn-push: message \(label): OTA check asked with a wait of \(delay) ms; no background task declared, the next start checks")
            return done(false)
        }
        BGTaskScheduler.shared.getPendingTaskRequests { pending in
            DispatchQueue.main.async {
                // One at a time (Android: KEEP): a second push while one waits changes nothing
                if pending.contains(where: { $0.identifier == OtaPushRules.taskId }) {
                    print("zn-push: message \(label): OTA check asked; one is already scheduled, kept as it is")
                    return done(false)
                }
                let request = BGAppRefreshTaskRequest(identifier: OtaPushRules.taskId)
                request.earliestBeginDate = Date(timeIntervalSinceNow: Double(delay) / 1000)
                do {
                    try BGTaskScheduler.shared.submit(request)
                    print("zn-push: message \(label): OTA check scheduled in \(delay) ms or later (iOS decides)")
                } catch {
                    print("zn-push: message \(label): can't schedule the OTA check (\(error.localizedDescription)); the next start checks")
                }
                done(false)
            }
        }
    }

    /// The check in the woken app's time: [done] when it ends or at answerByMs, whichever comes first.
    private static func checkNow(after delay: Int64, done: @escaping (Bool) -> Void) {
        var answered = false
        func answer(_ ran: Bool) {
            guard !answered else { return }
            answered = true
            done(ran)
        }
        var bg = UIBackgroundTaskIdentifier.invalid
        func endBg() {
            guard bg != .invalid else { return }
            UIApplication.shared.endBackgroundTask(bg)
            bg = .invalid
        }
        bg = UIApplication.shared.beginBackgroundTask(withName: "zn-ota-push-check") {
            MainActor.assumeIsolated {
                print("zn-push: OTA check: iOS's background time ran out; a cut download resumes at the next check")
                answer(false)
                endBg()
            }
        }
        // On time (a plain asyncAfter this long can run seconds late, past the plugin's 27 s cap)
        let answerBy = ZnDeadline.main(at: .now() + .milliseconds(Int(OtaPushRules.answerByMs))) { answer(false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + Double(delay) / 1000) {
            ZnOta.shared.check { r in
                DispatchQueue.main.async {
                    log(r)
                    answerBy.cancel()
                    answer(true)
                    endBg()
                }
            }
        }
    }

    private static func runTask(_ task: BGTask) {
        var finished = false
        task.expirationHandler = {
            DispatchQueue.main.async {
                guard !finished else { return }
                finished = true
                print("zn-push: OTA check task: iOS ended it; the next start checks")
                task.setTaskCompleted(success: false)
            }
        }
        print("zn-push: OTA check task: running")
        ZnOta.shared.check { r in
            DispatchQueue.main.async {
                log(r)
                guard !finished else { return }
                finished = true
                task.setTaskCompleted(success: true)
            }
        }
    }

    private static func log(_ r: [String: Any]) {
        let bundle = (r["bundle"] as? String).map { " \($0)" } ?? ""
        let error = (r["error"] as? String).map { " (\($0))" } ?? ""
        print("zn-push: OTA check: \(r["action"] as? String ?? "?") \(r["reason"] as? String ?? "")\(bundle)\(error)")
    }
}
