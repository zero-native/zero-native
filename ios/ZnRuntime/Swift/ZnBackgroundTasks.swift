// Background tasks (BGTaskScheduler) that run a JS task (`defineTask` in JS, ZnTasks here): the iOS way to do what an
// Android plugin does with a WorkManager job that calls ZnBackground.run (OTA push's OtaCheckJob). Android has no runtime
// helper for it; here it is one call, as the expiration and setTaskCompleted wiring is easy to get wrong.
//
//   // application(_:didFinishLaunchingWithOptions:), before it returns (iOS's rule):
//   ZnBackgroundTasks.register("com.example.sync", jsTask: "sync") { ZnBackgroundTasks.refresh("com.example.sync", in: 3600) }
//   ZnBackgroundTasks.schedule(ZnBackgroundTasks.refresh("com.example.sync", in: 3600))
//
// The identifier must be in Info.plist `BGTaskSchedulerPermittedIdentifiers`, with `fetch` (refresh tasks) or
// `processing` (processing tasks) in `UIBackgroundModes`. When iOS runs it, JS starts with no window if it isn't running
// (ZnApp.prepare), the JS task runs, and the BGTask ends with success when the task answers "done". When iOS ends the
// time first, the JS task's `signal` is aborted and the BGTask ends as failed.
//
// Know: iOS decides when a task runs (often hours after the earliest date, less often for an app the user rarely opens),
// never after the user swiped the app away, and never on the simulator by itself (Xcode's debugger can start one:
// `e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"<id>"]`). Don't rely on
// the timing: do the work again at the next start too.
import BackgroundTasks
import UIKit

public enum ZnBackgroundTasks {
    /// What a registered identifier runs.
    private struct Handler {
        let jsTask: String, data: Any?, timeoutMs: Int, reschedule: (() -> BGTaskRequest?)?
    }

    /// Main thread: registered identifiers, and whether launching has finished (registering after it throws in iOS).
    nonisolated(unsafe) private static var registered: [String: Handler] = [:]
    nonisolated(unsafe) private static var launchEnded = false
    nonisolated(unsafe) private static var watching = false

    /// Registers [identifier]: when iOS runs it, JS task [jsTask] runs with [data], at most [timeoutMs] (a refresh task
    /// has about 30 s in all). [reschedule]: the next request, submitted as the task starts (a refresh task runs once
    /// per request). Call it in `application(_:didFinishLaunchingWithOptions:)`, before it returns. False (and a log)
    /// when the identifier isn't in Info.plist, is registered already, or launching has finished.
    @MainActor @discardableResult
    public static func register(_ identifier: String, jsTask: String, data: Any? = nil, timeoutMs: Int = 25_000,
                                reschedule: (() -> BGTaskRequest?)? = nil) -> Bool {
        watchLaunch()
        let permitted = Bundle.main.object(forInfoDictionaryKey: "BGTaskSchedulerPermittedIdentifiers") as? [String] ?? []
        guard permitted.contains(identifier) else {
            print("zn: background task \(identifier) isn't in Info.plist BGTaskSchedulerPermittedIdentifiers: not registered")
            return false
        }
        // iOS throws (and the app ends) for a handler registered after launching or registered twice.
        guard !launchEnded, UIApplication.shared.connectedScenes.isEmpty else {
            print("zn: background task \(identifier): register it in application(_:didFinishLaunchingWithOptions:), before the app has launched")
            assertionFailure("ZnBackgroundTasks.register(\(identifier)) after launch")
            return false
        }
        guard registered[identifier] == nil else {
            print("zn: background task \(identifier) is registered already")
            return false
        }
        let handler = Handler(jsTask: jsTask, data: data, timeoutMs: timeoutMs, reschedule: reschedule)
        let ok = BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main) { task in
            MainActor.assumeIsolated {
                run(task.identifier, handler, onExpire: { task.expirationHandler = $0 }, complete: { task.setTaskCompleted(success: $0) })
            }
        }
        if ok { registered[identifier] = handler }
        print("zn: background task \(identifier) → JS task \(jsTask): \(ok ? "registered" : "refused by iOS")")
        return ok
    }

    /// Submits [request] (a refresh or processing request for a registered identifier). False, with the reason in the
    /// log, when iOS refuses: the simulator, Background App Refresh off, too many requests. A new request replaces the
    /// one waiting for the same identifier.
    @discardableResult
    public static func schedule(_ request: BGTaskRequest) -> Bool {
        do {
            try BGTaskScheduler.shared.submit(request)
            let when = request.earliestBeginDate.map { " at \($0) or later" } ?? ""
            print("zn: background task \(request.identifier) scheduled\(when) (iOS decides when)")
            return true
        } catch {
            print("zn: background task \(request.identifier) not scheduled: \(Self.reason(error))")
            return false
        }
    }

    /// A refresh request for [identifier], due no earlier than [seconds] from now.
    public static func refresh(_ identifier: String, in seconds: TimeInterval) -> BGAppRefreshTaskRequest {
        let r = BGAppRefreshTaskRequest(identifier: identifier)
        r.earliestBeginDate = Date(timeIntervalSinceNow: seconds)
        return r
    }

    /// Runs registered [identifier] now, as iOS would, with a stand-in for the BGTask: for labs and tests, as the
    /// simulator refuses every request, so Xcode's `_simulateLaunchForTaskWithIdentifier` finds nothing to run there.
    /// What it returns ends the stand-in's time, as iOS would (`_simulateExpirationForTaskWithIdentifier`). nil when
    /// [identifier] isn't registered. Main thread.
    @MainActor @discardableResult
    public static func simulateLaunch(_ identifier: String) -> (() -> Void)? {
        guard let handler = registered[identifier] else {
            print("zn: background task \(identifier) isn't registered: nothing to launch")
            return nil
        }
        var expiration: (() -> Void)?
        print("zn: background task \(identifier): a simulated launch")
        run(identifier, handler, onExpire: { expiration = $0 }, complete: { ok in
            print("zn: background task \(identifier): setTaskCompleted(success: \(ok)) (simulated)")
        })
        return { expiration?() }
    }

    /// [onExpire] hands over the BGTask's expiration handler; [complete] is its setTaskCompleted (called once).
    @MainActor private static func run(_ id: String, _ handler: Handler, onExpire: (@escaping () -> Void) -> Void,
                                       complete: @escaping (Bool) -> Void) {
        let jsTask = handler.jsTask
        print("zn: background task \(id): running JS task \(jsTask)")
        if let next = handler.reschedule?() { schedule(next) }
        var finished = false
        let finish = { (ok: Bool, why: String) in
            guard !finished else { return }
            finished = true
            print("zn: background task \(id): \(why)")
            complete(ok)
        }
        var handle: ZnTasks.Handle?
        onExpire {
            // At once: iOS wants the task ended when its time is up (launch handlers run on .main, so this is too).
            let end = {
                guard !finished else { return }
                print("zn: background task \(id): iOS ends its time; JS task \(jsTask) is aborted")
                if let handle { ZnTasks.shared.expire(handle) }  // only this run; its answer (timed_out) ends the BGTask
                finish(false, "ended by iOS")  // and if it had ended already, or wasn't queued yet
            }
            if Thread.isMainThread { end() } else { DispatchQueue.main.async(execute: end) }
        }
        // The BGTask is the background time: ZnTasks holds none of its own.
        handle = ZnTasks.shared.run(jsTask, handler.data, timeoutMs: handler.timeoutMs, holdsBackgroundTime: false) { outcome in
            finish(outcome == .done, "JS task \(jsTask): \(outcome.rawValue)")
        }
    }

    /// Launching ends (UIApplication's notification comes after didFinishLaunching returns). From the first of
    /// ZnPlugins.register, ZnApp.prepare and register, so a register after a background launch (no scene, so the scene
    /// check can't tell) is caught too, in an app that calls either at launch, as every zn app does.
    @MainActor static func watchLaunch() {
        guard !watching else { return }
        watching = true
        NotificationCenter.default.addObserver(forName: UIApplication.didFinishLaunchingNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { launchEnded = true }
        }
    }

    private static func reason(_ error: Error) -> String {
        guard let e = error as? BGTaskScheduler.Error else { return error.localizedDescription }
        switch e.code {
        case .unavailable: return "unavailable (the simulator, or Background App Refresh is off)"
        case .tooManyPendingTaskRequests: return "too many requests waiting"
        case .notPermitted: return "not permitted (Info.plist: BGTaskSchedulerPermittedIdentifiers and UIBackgroundModes)"
        @unknown default: return "error \(e.code.rawValue)"
        }
    }
}
