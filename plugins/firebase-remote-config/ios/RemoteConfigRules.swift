// The Remote Config plugin's choices with no Firebase in them (Android: RemoteConfigRules in RemoteConfigPlugin.kt), so
// the Mac tests can check them (ios/tests/remote-config). Firebase's own enums come in as their numbers.
import Foundation

enum RemoteConfigRules {
    /// The defaults as text, the way Android's Firebase keeps them, so a value reads the same on both: strings as they
    /// are, booleans "true" / "false" (iOS's Firebase would make a boolean "1"), whole numbers without ".0", other
    /// numbers as decimals, a JS object or array as its JSON text. Nulls (and anything else) are left out.
    static func defaults(_ raw: [String: Any]) -> [String: String] {
        var out: [String: String] = [:]
        for (key, v) in raw {
            if let s = v as? String { out[key] = s; continue }
            if let n = v as? NSNumber {
                if CFGetTypeID(n) == CFBooleanGetTypeID() { out[key] = n.boolValue ? "true" : "false"; continue }
                out[key] = number(n.doubleValue)
                continue
            }
            if v is [Any] || v is [String: Any],
               let data = try? JSONSerialization.data(withJSONObject: v, options: [.sortedKeys, .withoutEscapingSlashes]),
               let text = String(data: data, encoding: .utf8) {
                out[key] = text
            }
        }
        return out
    }

    /// A number as Android's Firebase keeps it. JSON gives Android a whole number in Long's range as a Long, written as
    /// JS wrote it (its shortest digits, then zeros: 2^60 is "1152921504606847000"); anything else is a Double, written
    /// as Java's Double.toString does ("1.5", "1.23456785E7", "1.0E21", "1.0E-5").
    static func number(_ d: Double) -> String {
        guard d.isFinite else { return d.isNaN ? "NaN" : (d < 0 ? "-Infinity" : "Infinity") }
        if d == 0 { return "0" }
        let (digits, point) = shortest(abs(d))  // abs(d) is 0.<digits> × 10^point
        let sign = d < 0 ? "-" : ""
        if d == d.rounded() && d >= -9.223372036854775808e18 && d < 9.223372036854775808e18 {
            return sign + digits + String(repeating: "0", count: max(0, point - digits.count))
        }
        let a = abs(d)
        if a >= 1e-3 && a < 1e7 {
            if point <= 0 { return sign + "0." + String(repeating: "0", count: -point) + digits }
            if point >= digits.count { return sign + digits + String(repeating: "0", count: point - digits.count) + ".0" }
            return sign + digits.prefix(point) + "." + digits.dropFirst(point)
        }
        let rest = digits.dropFirst()
        return sign + digits.prefix(1) + "." + (rest.isEmpty ? "0" : rest) + "E\(point - 1)"
    }

    /// A positive number's shortest digits (Swift's, the same as JS's and Java's) and where the point goes.
    private static func shortest(_ d: Double) -> (digits: String, point: Int) {
        var text = "\(d)", exp = 0
        if let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exp = Int(text[text.index(after: e)...]) ?? 0
            text = String(text[..<e])
        }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        let whole = String(parts[0]), frac = parts.count > 1 ? String(parts[1]) : ""
        var digits = whole + frac, point = whole.count + exp
        while digits.count > 1 && digits.first == "0" { digits.removeFirst(); point -= 1 }
        while digits.count > 1 && digits.last == "0" { digits.removeLast() }
        return (digits, point)
    }

    /// Milliseconds from JS to Firebase's whole seconds, never below 0; past Int64, Int64's largest (as Kotlin's
    /// toLong()).
    static func seconds(_ ms: Double) -> Int64 {
        let s = ms / 1000
        if s.isNaN || s <= 0 { return 0 }
        return s >= 9.223372036854775807e18 ? Int64.max : Int64(s)
    }

    /// RemoteConfigSource: 0 remote, 1 default, 2 static (no value at all).
    static func source(_ value: Int) -> String {
        switch value {
        case 0: return "remote"
        case 1: return "default"
        default: return "static"
        }
    }

    /// RemoteConfigFetchStatus: 0 none yet, 1 success, 2 failure, 3 throttled.
    static func fetchStatus(_ value: Int) -> String {
        switch value {
        case 1: return "success"
        case 2: return "failure"
        case 3: return "throttled"
        default: return "no_fetch_yet"
        }
    }

    static let errorDomain = "com.google.remoteconfig.ErrorDomain"
    static let updateErrorDomain = "com.google.remoteconfig.update.ErrorDomain"
    /// RemoteConfigError.throttled.
    static let throttledCode = 8002

    /// Why a fetch failed: too many fetches, no network (a URL error, also as the underlying error), or other.
    static func reason(_ error: Error?) -> String {
        guard let e = error as NSError? else { return "failed" }
        if e.domain == errorDomain && e.code == throttledCode { return "throttled" }
        let under = e.userInfo[NSUnderlyingErrorKey] as? NSError
        if e.domain == NSURLErrorDomain || under?.domain == NSURLErrorDomain { return "no_network" }
        if e.localizedDescription.range(of: "network", options: .caseInsensitive) != nil { return "no_network" }
        return "failed"
    }

    /// A real-time update error as Android names it (FirebaseRemoteConfigException.Code, lower case).
    static func updateError(_ error: Error) -> String {
        let e = error as NSError
        guard e.domain == updateErrorDomain else { return "unknown" }
        switch e.code {
        case 8001: return "config_update_stream_error"
        case 8002: return "config_update_not_fetched"
        case 8003: return "config_update_message_invalid"
        case 8004: return "config_update_unavailable"
        default: return "unknown"
        }
    }

    /// The answer with no Firebase (Android's off()).
    static func off() -> [String: Any] {
        ["available": false, "ok": false, "reason": "unavailable", "changed": false, "values": [String: Any](),
         "lastFetchStatus": "no_fetch_yet", "fetchTimeMillis": -1]
    }

    /// The answer of fetch / activate / getAll: every key with its text and source, and the last fetch.
    static func result(ok: Bool, reason: String?, changed: Bool, values: [String: (value: String, source: Int)],
                       lastFetchStatus: Int, fetchTime: Date?) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in values { out[k] = ["value": v.value, "source": source(v.source)] }
        return ["available": true, "ok": ok, "reason": reason ?? NSNull(), "changed": changed, "values": out,
                "lastFetchStatus": fetchStatus(lastFetchStatus),
                "fetchTimeMillis": fetchMillis(fetchTime)]
    }

    /// When the last fetch was, ms since 1970; -1 for never (iOS's Firebase says 1970 itself then).
    static func fetchMillis(_ t: Date?) -> Int64 {
        guard let t, t.timeIntervalSince1970 > 0 else { return -1 }
        let ms = (t.timeIntervalSince1970 * 1000).rounded()
        return ms.isFinite && ms < 9.223372036854775807e18 ? Int64(ms) : Int64.max
    }
}
