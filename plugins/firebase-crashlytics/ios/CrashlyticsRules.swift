// The Crashlytics plugin's rules with no iOS in them (CrashlyticsRules.kt), tested on the Mac (ios/tests/push).
import Foundation

/// The plugin's choices with no iOS in them (CrashlyticsRules.kt).
enum CrashlyticsRules {
    static let keyBundle = "zn_bundle", keyBundleId = "zn_bundle_id", keyBuiltIn = "zn_built_in", keyHostApi = "zn_host_api"
    static let keyRoute = "zn_route", keyJsKind = "zn_js_kind"
    /** JS errors sent per process (an error in a loop would send hundreds). */
    static let maxJsErrors = 30
    static let maxLogChars = 4_000
    static let maxKeyChars = 1_024

    /// A recorded error's text: Hermes' stack starts with "Error: message" already.
    static func details(_ name: String?, _ message: String, _ stack: String?) -> String {
        let s = stack ?? ""
        if !s.isEmpty && s.contains(message) { return s }
        let head = (name ?? "").isEmpty ? message : "\(name!): \(message)"
        return s.isEmpty ? head : "\(head)\n\(s)"
    }

    /// `sample_12@1a2b3c4d5e6f` → `sample_12`.
    static func bundleId(_ label: String) -> String {
        String(label.split(separator: "@", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
    }

    static func routeLog(_ from: String?, _ to: String?) -> String { "nav: \(from ?? "-") -> \(to ?? "-")" }

    static func otaLog(_ kind: String, _ bundle: String?, _ detail: String?) -> String {
        "ota: \(kind)\(bundle.map { " \($0)" } ?? "")\(detail.map { ": \($0)" } ?? "")"
    }

    /// A serious OTA outcome as a non-fatal (Android's ZnOtaEventException: "OTA <kind> <bundle>: <detail>").
    static let otaName = "OTA event"
    static func otaReason(_ kind: String, _ bundle: String?, _ detail: String?) -> String {
        "OTA " + otaLog(kind, bundle, detail).dropFirst("ota: ".count)
    }

    /// A JS error's reason, as Android's ZnJsError text: `[sample_12@1a2b3c4d5e6f] kind in where: first line`.
    static func jsReason(_ label: String?, _ kind: String, _ whereText: String, _ first: String) -> String {
        "[\(label ?? "built-in")] \(kind) in \(whereText): \(first)"
    }

    /// Hermes frames, `at fn (file:line:col)` or `at file:line:col`, as (function, file, line). Native frames are left out.
    static func frames(_ details: String) -> [(String, String, Int)] {
        let re = try! NSRegularExpression(pattern: #"^\s*at (?:(.+?) \()?([^\s()]+):(\d+):\d+\)?\s*$"#)
        return details.split(separator: "\n").compactMap { line in
            let s = String(line)
            guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
            func g(_ i: Int) -> String? { Range(m.range(at: i), in: s).map { String(s[$0]) } }
            let file = (g(2) ?? "").split(separator: "/").last.map(String.init) ?? ""
            return ((g(1) ?? "").isEmpty ? "<anonymous>" : g(1)!, file, Int(g(3) ?? "") ?? 0)
        }
    }
}
