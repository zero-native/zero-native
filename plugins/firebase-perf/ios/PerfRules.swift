// The Performance plugin's choices with no Firebase in them (Android: PerfRules in PerfPlugin.kt), so the Mac tests can
// check them (ios/tests/perf).
import Foundation

enum PerfRules {
    static let attrBundle = "zn_bundle"
    static let metricFrames = "frames"
    static let metricSlow = "frames_slow"
    static let metricFrozen = "frames_frozen"
    static let maxName = 100
    static let maxAttributeName = 40
    static let maxAttributeValue = 100
    static let maxOpenTraces = 64
    /// iOS's frames are the gaps between display refreshes (a CADisplayLink), so the slow line is Firebase iOS's own:
    /// under 59 frames a second (a 60 Hz screen's 16.7 ms frames are fine). Frozen: longer than 700 ms, as Android.
    static let slowSeconds = 1.0 / 59.0
    static let frozenSeconds = 0.7

    enum Frame: Equatable { case ok, slow, frozen }

    /// One frame: frozen, else slow, else fine (a frozen frame isn't counted as slow too, as on Android).
    static func frameKind(_ seconds: Double) -> Frame {
        if seconds > frozenSeconds { return .frozen }
        if seconds > slowSeconds { return .slow }
        return .ok
    }

    /// Firebase's rules for trace and metric names: 1..100 characters, no space at either end, no leading `_`.
    static func nameProblem(_ name: String) -> String? {
        if name.isEmpty { return "the name is empty" }
        if name.count > maxName { return "\"\(name)\" is longer than \(maxName) characters" }
        if name != name.trimmingCharacters(in: .whitespacesAndNewlines) { return "\"\(name)\" starts or ends with a space" }
        if name.hasPrefix("_") { return "\"\(name)\" starts with _ (Firebase keeps those)" }
        return nil
    }

    /// Attribute names: 1..40 letters, digits and _, starting with a letter; not firebase_ / google_ / ga_.
    static func attributeProblem(_ name: String) -> String? {
        if name.range(of: "^[A-Za-z][A-Za-z0-9_]{0,39}$", options: .regularExpression) == nil {
            return "attribute \"\(name)\": 1 to 40 letters, digits and _, starting with a letter"
        }
        if ["firebase_", "google_", "ga_"].contains(where: name.hasPrefix) { return "attribute \"\(name)\" starts with a prefix Firebase keeps" }
        return nil
    }

    /// A metric from JS: whole numbers only, cut toward zero and kept in Int64 (Kotlin's toLong()); NaN is 0.
    static func metricValue(_ d: Double) -> Int64 {
        if d.isNaN { return 0 }
        if d >= 9.223372036854775807e18 { return .max }
        if d <= -9.223372036854775808e18 { return .min }
        return Int64(d.rounded(.towardZero))
    }

    static func attributeValue(_ value: String) -> String { String(value.prefix(maxAttributeValue)) }

    /// A screen trace's name: `screen_<route>`.
    static func screenTrace(_ route: String) -> String { String("screen_\(route)".prefix(maxName)) }

    /// What Firebase sees of a request: no query, no fragment and no user or password (they may hold tokens or personal
    /// data). Firebase iOS trims its own automatic traces the same way; this is for traces the plugin makes itself.
    static func defaultUrl(_ url: URL) -> String {
        guard var c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        c.query = nil
        c.fragment = nil
        c.user = nil
        c.password = nil
        return c.url?.absoluteString ?? url.absoluteString
    }

    /// The methods Firebase's network traces know, in the order of its HTTPMethod (Android's HttpMethod). Another
    /// (PROPPATCH, REPORT) gets no trace: nil.
    static let httpMethods = ["GET", "PUT", "POST", "DELETE", "HEAD", "PATCH", "OPTIONS", "TRACE", "CONNECT"]

    static func httpMethod(_ method: String) -> Int? { httpMethods.firstIndex(of: method.uppercased()) }

    /// The URL a network trace gets: the app's `url` (it answers nil: the request isn't traced), else defaultUrl. Only
    /// http(s) with a host, as Firebase refuses the rest.
    static func traceUrl(_ url: URL, _ pick: ((URL) -> String?)?) -> URL? {
        let name = pick.map { $0(url) } ?? defaultUrl(url)
        guard let name, let out = URL(string: name), let scheme = out.scheme?.lowercased(), scheme == "http" || scheme == "https",
              out.host?.isEmpty == false else { return nil }
        return out
    }
}
