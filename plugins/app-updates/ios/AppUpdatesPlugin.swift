// The app-updates plugin's iOS side (plugins/app-updates, as android/.../AppUpdatesPlugin.kt). NOT BUILT ON A MAC YET
// (written on Windows, 2026-11-09): check it compiles with the sample before relying on it.
//
// Apple has no in-app update API, so the zn-updates server's store rule is the truth on iOS (storeAnswer in JS: it comes with the OTA check; iOS OTA is not built yet), and the
// app shows its own screens (a forced full-screen screen, an optional sheet). This module only:
// - isUpdateAvailable: { available: false } (there is no Play to ask);
// - start / complete: { ok: false, unavailable: true };
// - setBusy: accepted and ignored (nothing native to hold back);
// - openStore { appStoreId }: opens the App Store page itself (itms-apps://apps.apple.com/app/id<appStoreId>);
//   { opened: false } without an id.
// The module still exists, so a bundle that needs "AppUpdates" v1 runs here.
import UIKit

struct AppUpdatesPlugin: ZnPlugin {
    func register(_ r: ZnPluginRegistry) {
        r.module(AppUpdatesModule())
    }
}

final class AppUpdatesModule: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("AppUpdates", version: 1)
        function("isUpdateAvailable") { call in call.resolve(["available": false]) }
        function("start") { call in call.resolve(["ok": false, "unavailable": true]) }
        function("complete") { call in call.resolve(["ok": false, "unavailable": true]) }
        function("setBusy") { call in call.resolve(nil) }
        function("openStore", onMain: true) { call in
            let id: String? = try? call.stringOrNil("appStoreId")
            guard let id, !id.isEmpty, id.allSatisfy(\.isNumber),
                  let url = URL(string: "itms-apps://apps.apple.com/app/id\(id)") else {
                return call.resolve(["opened": false])
            }
            UIApplication.shared.open(url, options: [:]) { opened in call.resolve(["opened": opened]) }
        }
    }
}
