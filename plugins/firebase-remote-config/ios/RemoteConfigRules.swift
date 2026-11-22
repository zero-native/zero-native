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

    /// A number as Android writes it: a whole one as an integer (Kotlin's Long), else as a decimal.
    static func number(_ d: Double) -> String {
        if d.isFinite && d == d.rounded() && abs(d) < 9e15 { return String(Int64(d)) }
        return "\(d)"
    }

    /// Milliseconds from JS to Firebase's whole seconds, never below 0.
    static func seconds(_ ms: Double) -> Int64 {
        guard ms.isFinite else { return 0 }
        return max(0, Int64(ms / 1000))
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
        return Int64((t.timeIntervalSince1970 * 1000).rounded())
    }
}
