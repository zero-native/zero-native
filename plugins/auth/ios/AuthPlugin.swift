// The auth plugin's iOS side (plugins/auth, as android/.../AuthModule.kt). iOS has none of what the Android side wraps:
// no phone number sheet (Play services), no SMS Retriever and no app hash (an app can't read SMS on iOS). So every
// call answers the way Android does when Play services is missing, and the app's fallback (the user types) runs:
// - phoneHint: not launched, reason "unavailable";
// - listenOtp: rejected "unavailable" (JS turns it into { code: null, reason: "unavailable" });
// - stopOtp: true; appHash: "".
// What iOS gives instead needs no plugin: OtpInput offers the code from Messages above the keyboard (`.oneTimeCode`),
// and a phone field marked as a phone number gets the user's own number from AutoFill. The module still exists, so a
// bundle that needs "Auth" v1 runs here.
import Foundation

struct AuthPlugin: ZnPlugin {
    func register(_ r: ZnPluginRegistry) {
        r.module(AuthModule())
    }
}

final class AuthModule: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("Auth", version: 1)
        function("phoneHint") { call in call.resolve(["launched": false, "reason": "unavailable"]) }
        function("listenOtp") { call in call.reject("unavailable", "iOS apps can't read SMS; OtpInput offers the code from Messages") }
        function("stopOtp") { call in call.resolve(true) }
        function("appHash") { call in call.resolve("") }
    }
}
