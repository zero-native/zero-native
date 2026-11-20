// The app's iOS shell. A UIKit app: the window's root is the back stack (ZnNavController); SwiftUI draws inside each
// screen. The bundle (main.hbc, main.zn.ui, ...) is in the app's resources (bun run app:js:ios).
import UIKit
#if canImport(ZnRuntime)  // the Swift package host (zn new --ios packages); the CMake host compiles zero-native in
import ZnRuntime
#endif

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Plugins first, before the bundle runs: ZnPlugins.register(LocationPlugin()) (docs/plugins.md).
        // OTA updates stay off until you call ZnOta.configure here (docs/ota.md): the app's own bundle runs.
        return true
    }
}

// Named in Info.plist (UISceneConfigurations).
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        // The app starts here, where the link that opened it is known (a URL, or a universal link's web page).
        let link = options.urlContexts.first?.url
            ?? options.userActivities.first { $0.activityType == NSUserActivityTypeBrowsingWeb }?.webpageURL
        // After iOS itself ended the app (never after the user closed it), the screens come back (restorationActivity).
        ZnApp.shared.start(bundle: Bundle.main.resourceURL!, routeName: nil, params: "{}", link: link,
                           restoring: session.stateRestorationActivity)
        let window = UIWindow(windowScene: scene)
        window.rootViewController = ZnApp.shared.makeRootViewController()
        window.makeKeyAndVisible()
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
