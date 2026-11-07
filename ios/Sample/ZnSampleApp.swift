// The sample app on iOS: the same bundle as android/sample (built by `bun run sample:js`), drawn by the iOS host.
// Launch environment (simctl: SIMCTL_CHILD_<name>):
//   ZN_ROUTE         first route (default "amount"); ZN_PARAMS its params JSON (default {"merchantId":"m1"})
//   ZN_JS_DELAY_MS   start JS this much later, to see the skeleton on its own (debug)
//   ZN_COUNT_BODIES  1: log how many SwiftUI bodies each batch ran (debug)
import SwiftUI

@main
struct ZnSampleApp: App {
    init() {
        let env = ProcessInfo.processInfo.environment
        ZnApp.shared.start(bundle: Bundle.main.resourceURL!,
                           routeName: env["ZN_ROUTE"] ?? "amount",
                           params: env["ZN_PARAMS"] ?? "{\"merchantId\":\"m1\"}")
    }

    var body: some Scene {
        WindowGroup {
            ZnRootView(app: ZnApp.shared)
        }
    }
}
