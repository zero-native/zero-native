// The sample app on iOS: the same bundle as android/sample (built by `bun run sample:js`), drawn by the iOS host.
// A UIKit app: the window's root is the back stack (ZnNavController); SwiftUI draws inside each screen. (With a
// SwiftUI App at the root, the navigation controller's edge swipe never began: 2026-11-08, A8.)
// Launch environment (simctl: SIMCTL_CHILD_<name>):
//   ZN_ROUTE         first route, alone (debug); ZN_PARAMS its params JSON (default {}). Without it the app starts as a
//                    real app: on the "/" route, with a link's screen on top when a link started it (zn://sample/...)
//   ZN_LINK          the link that starts the app, as if it opened it (tools/ios-sample.ts --link)
//   ZN_JS_DELAY_MS   start JS this much later, to see the skeleton on its own (debug)
//   ZN_COUNT_BODIES  1: log how many SwiftUI bodies each batch ran (debug)
//   ZN_OTA_KEY       the OTA public key to trust instead of the sample's (debug: a test store with its own key)
//   ZN_OTA_HEALTHY_MS  a downloaded bundle is healthy this long after its first screens (debug; default 4000)
//   ZN_ANIM_SPEED    the window's animation speed, e.g. 0.1: every animation 10x slower, to tap during one (debug)
//   ZN_TOUCH_LOG     1: log each touch that begins, with the view it hits (debug)
import UIKit
import notify
#if canImport(ZnRuntime)  // an app on the Swift package; the CMake build compiles everything into the app
import ZnRuntime
import ZnPluginAndroidPlayAuth
import ZnPluginAppUpdates
import ZnPluginDeviceInfo
import ZnPluginDocumentScanner
import ZnPluginFirebaseAnalytics
import ZnPluginFirebaseApp
import ZnPluginFirebaseCrashlytics
import ZnPluginFirebaseMessaging
import ZnPluginImageViewer
import ZnPluginLocation
import ZnPluginLottie
import ZnPluginNotifications
import ZnPluginPdf
import ZnPluginScanner
import ZnPluginWebView
#endif

@main
final class ZnAppDelegate: UIResponder, UIApplicationDelegate {
    /// The sample's OTA public key (android/sample SampleApp.kt SAMPLE_OTA_KEY).
    static let sampleOtaKey =
        "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyDRVX10DZWMDeefhkH4saosxvE6AwYffTsDANIEemGkrKcGD/8Cj5SEzM0NZVjWHWl0Y1hTlsVxJQBdqxIvfxw=="

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let env = ProcessInfo.processInfo.environment
        // Plugins first, before the bundle runs (docs/plugins.md).
        ZnPlugins.register(DeviceTestPlugin(), ScannerPlugin(), AuthPlugin(), DeviceInfoPlugin(), LocationPlugin(), FirebaseAppPlugin(), CrashlyticsPlugin(), AnalyticsPlugin(), LottiePlugin(), PdfPlugin(), WebViewPlugin(), ImageViewerPlugin(), DocumentScannerPlugin(), AppUpdatesPlugin(), NotificationsPlugin(), FirebaseMessagingPlugin())
        _ = env
        // OTA updates from the update server on this computer (`bun run updates:server`, or `bun run ota serve`; the
        // simulator reaches it at localhost), staging channel, signed with the sample's key (the private key stays in
        // ~/.zero-native/keys). As android/sample's SampleApp.kt. A real app uses its HTTPS server and a main + backup key.
        var key = Self.sampleOtaKey
        #if DEBUG
        if let test = env["ZN_OTA_KEY"], !test.isEmpty { key = test }  // debug: a test key's public half (a test store)
        #endif
        var ota = ZnOta.Config(server: "http://localhost:8790", channel: "staging", publicKeys: [key])
        #if DEBUG
        if let ms = env["ZN_OTA_HEALTHY_MS"].flatMap(Double.init) { ota.healthyAfterMs = ms }  // debug: tests' crash window
        #endif
        ota.allowHttpInRelease = true  // the sample's release build talks to the same local server
        ota.onReport = { r in print("zn-sample: onReport \(r) (serious=\(r.serious))") }
        ZnOta.configure(ota)
        #if DEBUG
        // Tests: `xcrun simctl spawn <device> notifyutil -p dev.zeronative.sample.ota.apply` runs Updates.applyNow,
        // `... .ota.check` Updates.check, `... .restart` replaces the JS runtime on the same bundle (as an applyNow).
        var token: Int32 = 0
        notify_register_dispatch("dev.zeronative.sample.ota.apply", &token, .main) { _ in
            ZnOta.shared.applyNow { print("zn-sample: applyNow → \($0)") }
        }
        notify_register_dispatch("dev.zeronative.sample.ota.check", &token, .main) { _ in
            ZnOta.shared.check { print("zn-sample: check → \($0)") }
        }
        notify_register_dispatch("dev.zeronative.sample.restart", &token, .main) { _ in
            MainActor.assumeIsolated {
                ZnApp.shared.restart(bundle: ZnBundles.builtInURL, in: ZnOta.window()) { print("zn-sample: restart → \($0) \($1)") }
            }
        }
        // `... notifyutil -s dev.zeronative.sample.push.data 40000 && ... notifyutil -p dev.zeronative.sample.push.data`
        // hands the app delegate's push call a data-only push (PushLab's lab=slow, ms = the state), as a background wake
        // does: simctl push's background pushes don't reach the app delegate on the iOS 26 simulator.
        var pushToken: Int32 = 0
        notify_register_dispatch("dev.zeronative.sample.push.data", &pushToken, .main) { t in
            var ms: UInt64 = 0
            notify_get_state(t, &ms)
            let info: [AnyHashable: Any] = ["aps": ["content-available": 1], "gcm.message_id": "hook-\(Int(Date().timeIntervalSince1970 * 1000))",
                                            "lab": "slow", "ms": "\(ms)"]
            var calls = 0
            MainActor.assumeIsolated {
                FirebaseMessagingPlugin.remoteNotification(info) { r in
                    calls += 1
                    print("zn-sample: fetchCompletionHandler(\(r.rawValue)) call \(calls)")
                }
            }
        }
        #endif
        return true
    }

    // Push (plugins/firebase-messaging): Info.plist turns Firebase's app delegate proxy off, so these three are forwarded.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken token: Data) {
        FirebaseMessagingPlugin.apnsToken(token)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        FirebaseMessagingPlugin.apnsFailed(error)
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification info: [AnyHashable: Any],
                     fetchCompletionHandler done: @escaping (UIBackgroundFetchResult) -> Void) {
        FirebaseMessagingPlugin.remoteNotification(info, done)
    }
}

// Named in Info.plist (UISceneConfigurations), so a scene session the system kept from an earlier build uses it too.

final class ZnSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        print("zn: scene connects")
        // The app starts here, where the link that opened it is known (a URL, or a universal link's web page).
        let env = ProcessInfo.processInfo.environment
        let link = options.urlContexts.first?.url
            ?? options.userActivities.first { $0.activityType == NSUserActivityTypeBrowsingWeb }?.webpageURL
            ?? env["ZN_LINK"].flatMap(URL.init(string:))  // debug: ios-sample.ts --link, a cold start with its console
        // After iOS itself ended the app (never after the user closed it), the screens come back (restorationActivity).
        ZnApp.shared.start(bundle: Bundle.main.resourceURL!, routeName: env["ZN_ROUTE"], params: env["ZN_PARAMS"] ?? "{}", link: link,
                           restoring: session.stateRestorationActivity)
        let window: UIWindow = env["ZN_TOUCH_LOG"] == "1" ? ZnTouchLogWindow(windowScene: scene) : UIWindow(windowScene: scene)
        if let speed = env["ZN_ANIM_SPEED"].flatMap(Float.init), speed > 0 { window.layer.speed = speed }
        window.rootViewController = ZnApp.shared.makeRootViewController()
        window.makeKeyAndVisible()
        // Off by default, so the first frame stays the template skeleton; ios-sample.ts --splash-hold 1000 keeps a
        // launch-screen cover until JS built the first screens (and Splash.holdUntil's work), at most that long.
        if let hold = env["ZN_SPLASH_HOLD_MS"].flatMap(Double.init), hold > 0 { ZnSplash.holdUntilReady(window, capMs: hold) }
        print("zn: window shown with \(type(of: window.rootViewController!))")
        self.window = window
    }

    /// Asked as the app goes to the background: what to reopen if iOS ends the app while it is there.
    func stateRestorationActivity(for scene: UIScene) -> NSUserActivity? { ZnApp.shared.restorationActivity() }

    /// A link while the app runs.
    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        contexts.forEach { ZnApp.shared.openLink($0.url) }
    }

    /// A universal link while the app runs.
    func scene(_ scene: UIScene, continue activity: NSUserActivity) {
        if activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL { ZnApp.shared.openLink(url) }
    }
}

/// ZN_TOUCH_LOG=1 (debug): each touch that begins, with the view it hits, so a lost tap shows where it went.
final class ZnTouchLogWindow: UIWindow {
    override func sendEvent(_ event: UIEvent) {
        for t in event.allTouches ?? [] where t.phase == .began {
            let p = t.location(in: self)
            let hit = hitTest(p, with: event).map { String(describing: type(of: $0)) } ?? "nothing"
            print("zn t=\(ZnDebug.ms()) touch: began at \(Int(p.x)),\(Int(p.y)) on \(hit)")
        }
        super.sendEvent(event)
    }
}
