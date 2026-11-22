// The webview's rules with no WebKit in them (android/.../WebViewRules.kt), so a Mac unit suite checks them
// (ios/tests/plugins/webview: bun run tools/ios-unit-test.ts plugins/webview). Foundation only.
import Foundation

/// The rules (WebViewRules.kt), apart from WebKit.
enum WebViewRules {
    static let maxMessageChars = 64 * 1024
    static let maxUrlChars = 8 * 1024
    static let leaveGapMs = 800.0
    /// An upload answer above this is a page's trick, not a pick.
    static let maxUploadCount = 1000
    static let never: Set<String> = ["intent", "android-app", "javascript", "file", "content", "data", "blob", "about", "filesystem", "chrome", "view-source"]
    static let frameOnly: Set<String> = ["about", "data", "blob"]

    struct Url { let scheme: String; let host: String?; let port: Int }

    private static func letter(_ c: Character) -> Bool { c.isASCII && c.isLetter }
    private static func digit(_ c: Character) -> Bool { ("0"..."9").contains(c) }

    /// Strict on purpose: a backslash, a space or an `@` in the host part is refused.
    static func parseUrl(_ raw: String) -> Url? {
        if raw.count > maxUrlChars || raw.unicodeScalars.contains(where: { $0.value <= 0x20 || $0 == "\\" || $0.value == 0x7f }) { return nil }
        guard let colon = raw.firstIndex(of: ":"), colon != raw.startIndex else { return nil }
        let scheme = raw[..<colon].lowercased()
        guard let first = scheme.first, letter(first), scheme.allSatisfy({ letter($0) || digit($0) || "+-.".contains($0) }) else { return nil }
        let rest = raw[raw.index(after: colon)...]
        guard rest.hasPrefix("//") else { return Url(scheme: scheme, host: nil, port: -1) }
        let authority = rest.dropFirst(2).prefix { !"/?#".contains($0) }
        if authority.contains("@") { return Url(scheme: scheme, host: nil, port: -1) }
        let hp = authority.lowercased()
        let portAt = hp.lastIndex(of: ":")
        let host = portAt.map { String(hp[..<$0]) } ?? hp
        var port = -1
        if let at = portAt {
            let text = hp[hp.index(after: at)...]
            if !text.isEmpty {
                guard text.allSatisfy(digit), let p = Int(text), (1...65535).contains(p) else { return nil }
                port = p
            }
        }
        if host.isEmpty || !host.allSatisfy({ letter($0) || digit($0) || ".-_".contains($0) }) { return Url(scheme: scheme, host: nil, port: -1) }
        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) { port = -1 }
        return Url(scheme: scheme, host: host, port: port)
    }

    struct HostRule {
        let scheme: String, host: String, port: Int, wild: Bool
        func matches(_ u: Url) -> Bool {
            guard let h = u.host else { return false }
            return u.scheme == scheme && u.port == port && (wild ? h.hasSuffix(".\(host)") : h == host)
        }
    }

    static func hostRule(_ raw: String, localHttp: Bool) -> HostRule? {
        let text = raw.trimmingCharacters(in: .whitespaces).lowercased()
        let parts = text.components(separatedBy: "://")
        let scheme = parts.count > 1 ? parts[0] : "https"
        let rest = parts.count > 1 ? parts.dropFirst().joined(separator: "://") : text
        let wild = rest.hasPrefix("*.")
        let plain = wild ? String(rest.dropFirst(2)) : rest
        if plain.contains(where: { "/?#*".contains($0) }) { return nil }
        guard let url = parseUrl("\(scheme)://\(plain)"), let host = url.host else { return nil }
        switch scheme {
        case "https": break
        case "http": if !localHttp || wild || !["localhost", "127.0.0.1"].contains(host) { return nil }
        default: return nil
        }
        if wild && (!host.contains(".") || (host.split(separator: ".").last ?? "").allSatisfy(digit)) { return nil }
        return HostRule(scheme: scheme, host: host, port: url.port, wild: wild)
    }

    struct Policy {
        let hosts: [HostRule]
        let leaveSchemes: Set<String>
        let refused: [String]
        func allowsPage(_ url: String?) -> Bool {
            guard let url, let u = parseUrl(url) else { return false }
            return hosts.contains { $0.matches(u) }
        }
    }

    static let none = Policy(hosts: [], leaveSchemes: [], refused: [])

    static func policy(_ hosts: [String], _ leaveSchemes: [String], localHttp: Bool) -> Policy {
        var rules: [HostRule] = [], refused: [String] = []
        for raw in hosts { if let r = hostRule(raw, localHttp: localHttp) { rules.append(r) } else { refused.append(raw) } }
        var schemes: [String] = []
        for raw in leaveSchemes {
            var s = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if s.hasSuffix(":") { s.removeLast() }
            if s.isEmpty || never.contains(s) || !letter(s.first!) || !s.allSatisfy({ letter($0) || digit($0) || "+-.".contains($0) }) {
                refused.append(raw)
            } else if !schemes.contains(s) { schemes.append(s) }
        }
        return Policy(hosts: rules, leaveSchemes: Set(schemes), refused: refused)
    }

    enum Action { case stay, leave, refuse }

    static func decide(_ url: String, mainFrame: Bool, _ policy: Policy) -> (Action, String?) {
        guard let u = parseUrl(url) else { return (.refuse, "bad_url") }
        let web = u.scheme == "https" || u.scheme == "http"
        if !mainFrame { return web || frameOnly.contains(u.scheme) ? (.stay, nil) : (.refuse, "frame") }
        if never.contains(u.scheme) { return (.refuse, "scheme") }
        if web && policy.allowsPage(url) { return (.stay, nil) }
        if policy.leaveSchemes.contains(u.scheme) { return (.leave, nil) }
        return (.refuse, web ? "host" : "scheme")
    }

    static func pageMayShow(_ url: String?, _ policy: Policy, inline: Bool) -> Bool {
        guard let url, let u = parseUrl(url) else { return false }
        if url == "about:blank" { return true }
        if inline && (u.scheme == "data" || u.scheme == "about") { return true }
        return policy.allowsPage(url)
    }

    /// The allowed hosts as JSON for the page scripts (the bridge, the upload watch), which check the origin again.
    static func scriptRules(_ policy: Policy) -> String {
        let rules = policy.hosts.map { ["s": $0.scheme, "h": $0.host, "p": $0.port, "w": $0.wild] as [String: Any] }
        return (try? JSONSerialization.data(withJSONObject: rules, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
    }

    /// The upload script's answer as the event's count: a whole number of files, 0 to maxUploadCount.
    static func uploadCount(_ body: Any?) -> Int {
        guard let d = (body as? NSNumber)?.doubleValue, d.isFinite else { return 0 }
        return Int(min(max(d.rounded(.down), 0), Double(maxUploadCount)))
    }

    static func short(_ url: String?) -> String { String((url ?? "").prefix(2048)) }
    static func hostOf(_ url: String?) -> String { url.flatMap(parseUrl).map { $0.host ?? $0.scheme } ?? "?" }

    static var debug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }
}

