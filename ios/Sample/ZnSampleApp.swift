// The sample app on iOS: the same bundle as android/sample (built by `bun run sample:js`), drawn by the iOS host.
// A UIKit app: the window's root is the back stack (ZnNavController); SwiftUI draws inside each screen. (With a
// SwiftUI App at the root, the navigation controller's edge swipe never began: 2026-11-08, A8.)
// Launch environment (simctl: SIMCTL_CHILD_<name>):
//   ZN_ROUTE         first route, alone (debug); ZN_PARAMS its params JSON (default {}). Without it the app starts as a
//                    real app: on the "/" route, with a link's screen on top when a link started it (zn://sample/...)
//   ZN_LINK          the link that starts the app, as if it opened it (tools/ios-sample.ts --link)
//   ZN_JS_DELAY_MS   start JS this much later, to see the skeleton on its own (debug)
//   ZN_COUNT_BODIES  1: log how many SwiftUI bodies each batch ran (debug)
import UIKit

@main
final class ZnAppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let env = ProcessInfo.processInfo.environment
        // Plugins first, before the bundle runs (docs/plugins.md).
        ZnPlugins.register(DeviceTestPlugin(), ScannerPlugin(), AuthPlugin(), DeviceInfoPlugin(), LocationPlugin(), FirebaseAppPlugin(), CrashlyticsPlugin(), AnalyticsPlugin(), LottiePlugin(), PdfPlugin(), WebViewPlugin(), ImageViewerPlugin(), DocumentScannerPlugin())
        _ = env
        return true
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
        let window = UIWindow(windowScene: scene)
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
