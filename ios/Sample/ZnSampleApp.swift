// The sample app on iOS: the same bundle as android/sample (built by `bun run sample:js`), drawn by the iOS host.
// A UIKit app: the window's root is the back stack (ZnNavController); SwiftUI draws inside each screen. (With a
// SwiftUI App at the root, the navigation controller's edge swipe never began: 2026-11-08, A8.)
// Launch environment (simctl: SIMCTL_CHILD_<name>):
//   ZN_ROUTE         first route (default "amount"); ZN_PARAMS its params JSON (default {"merchantId":"m1"})
//   ZN_JS_DELAY_MS   start JS this much later, to see the skeleton on its own (debug)
//   ZN_COUNT_BODIES  1: log how many SwiftUI bodies each batch ran (debug)
import UIKit

@main
final class ZnAppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let env = ProcessInfo.processInfo.environment
        // Plugins first, before the bundle runs (docs/plugins.md).
        ZnPlugins.register(DeviceTestPlugin(), ScannerPlugin())
        ZnApp.shared.start(bundle: Bundle.main.resourceURL!,
                           routeName: env["ZN_ROUTE"] ?? "amount",
                           params: env["ZN_PARAMS"] ?? "{\"merchantId\":\"m1\"}")
        return true
    }

}

// Named in Info.plist (UISceneConfigurations), so a scene session the system kept from an earlier build uses it too.

final class ZnSceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        print("zn: scene connects")
        let window = UIWindow(windowScene: scene)
        window.rootViewController = ZnApp.shared.makeRootViewController()
        window.makeKeyAndVisible()
        print("zn: window shown with \(type(of: window.rootViewController!))")
        self.window = window
    }
}
