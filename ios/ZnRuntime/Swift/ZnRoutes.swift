// Routes from main.zn.ui.json and deep links, as android/runtime's ZnRoutes.kt. Foundation only, so the Mac test
// harness (ios/tests/routes, bun run ios:routes-test) builds it without UIKit, SwiftUI or Hermes.
import Foundation

/// A route from main.zn.ui.json (routes.ts): what native needs to show its screens.
struct ZnRoute {
    enum Transition: String { case push, modal, fade, none }
    let name: String
    let screen: Int  // template id of the screen's root
    let transition: Transition
    /// The sides kept clear of the system bars (safeArea: "all" by default, "none", or { top, bottom }).
    let safeTop: Bool
    let safeBottom: Bool
    /// statusBar "light": white status bar text (for a dark header); "dark" (default): black text.
    let lightStatusBar: Bool
    /// keyboard "resize" (default): the screen ends above the keyboard; "none": the keyboard covers it.
    let resizeForKeyboard: Bool
    /// A plugin's native screen ("<plugin>.<name>", ZnPlugins.swift), or nil for a zn screen.
    let native: String?
    /// routes.ts `path` ("/pay/:merchantId"), its parts, and whether a link may open it (`deepLink: true`).
    let path: String
    let segments: [String]
    let deepLink: Bool
    /// A screen with tabs: "<path>/<tab>" opens it on that tab (ZnRoutes.kt, host API 8).
    let tabs: [String]
    /// `restore: false`: not reopened after the system ends the app (nor the screens above it).
    let restore: Bool
    /// True: screenshots, recordings and the app switcher don't show this screen while it is drawn (the `secure` option).
    let secure: Bool
    /// Registry 24: the screen below stays drawn under this one (the `transparent` option).
    let transparent: Bool
    /// With `transparent`: VoiceOver skips the screens drawn under this one while it shows (`accessibilityHidesBelow`).
    let accessibilityHidesBelow: Bool

    init(json r: [String: Any]) {
        name = r["name"] as? String ?? ""
        screen = r["screen"] as? Int ?? 0
        transition = Transition(rawValue: r["transition"] as? String ?? "push") ?? .push
        switch r["safeArea"] {
        case let s as String where s == "none": (safeTop, safeBottom) = (false, false)
        case let d as [String: Any]: (safeTop, safeBottom) = (d["top"] as? Bool ?? true, d["bottom"] as? Bool ?? true)
        default: (safeTop, safeBottom) = (true, true)
        }
        lightStatusBar = (r["statusBar"] as? String) == "light"
        resizeForKeyboard = (r["keyboard"] as? String) != "none"
        native = r["native"] as? String
        path = r["path"] as? String ?? ""
        segments = path.split(separator: "/").map(String.init)
        deepLink = r["deepLink"] as? Bool ?? false
        tabs = r["tabs"] as? [String] ?? []
        restore = r["restore"] as? Bool ?? true
        secure = r["secure"] as? Bool ?? false
        transparent = r["transparent"] as? Bool ?? false
        accessibilityHidesBelow = r["accessibilityHidesBelow"] as? Bool ?? false
    }
}

/// A link matched to a route: its index and params (path values, plus the query's).
struct ZnRouteMatch {
    let route: Int
    let params: [String: String]
}

enum ZnLinks {
    /// The route a link's path opens (ZnRoutes.kt matchDeepLink): only `deepLink` routes; `:name` parts take the
    /// part's text; the most literal match wins; a route with tabs also matches "<path>/<tab>" ("tab" param).
    static func match(_ path: String, _ routes: [ZnRoute]) -> ZnRouteMatch? {
        let clean = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        let parts = (clean.split(separator: "#", maxSplits: 1).first.map(String.init) ?? "").split(separator: "/").map(String.init)
        var best: ZnRouteMatch?
        var bestLiterals = -1
        for (index, route) in routes.enumerated() where route.deepLink {
            let shapes: [([String], String?)] = [(route.segments, nil)] + route.tabs.map { (route.segments + [$0], $0) }
            for (segments, tab) in shapes where segments.count == parts.count {
                var params: [String: String] = [:]
                var literals = 0, ok = true
                for (seg, part) in zip(segments, parts) {
                    if seg.hasPrefix(":") {
                        guard let value = part.removingPercentEncoding, !value.isEmpty else { ok = false; break }
                        params[String(seg.dropFirst())] = value
                    } else if seg == part {
                        literals += 1
                    } else { ok = false; break }
                }
                if let tab { params["tab"] = tab }
                if ok && literals > bestLiterals { best = ZnRouteMatch(route: index, params: params); bestLiterals = literals }
            }
        }
        return best
    }

    /// [url]'s route, with its query values as params too (a value from the path wins).
    static func match(_ url: URL, _ routes: [ZnRoute]) -> ZnRouteMatch? {
        let c = URLComponents(url: url, resolvingAgainstBaseURL: false)
        // A custom scheme's "host" is the app's own name (zn://sample/pay/m1): only the path counts, as on Android.
        guard let m = match(c?.percentEncodedPath.isEmpty == false ? c!.percentEncodedPath : "/", routes) else {
            print("zn: deep link \(url.scheme ?? "?")://\(url.host ?? "")\(url.path) → no route")
            return nil
        }
        var params: [String: String] = [:]
        for q in c?.queryItems ?? [] { if let v = q.value { params[q.name] = v } }
        params.merge(m.params) { _, path in path }
        print("zn: deep link \(url.scheme ?? "?")://\(url.host ?? "")\(url.path) → \(routes[m.route].name) \(params.keys.sorted())")
        return ZnRouteMatch(route: m.route, params: params)
    }
}

enum ZnRoutes {
    /// main.zn.ui.json's routes, in order (a route's index is its place here). nil: the file has no route list.
    static func read(_ data: Data) throws -> [ZnRoute]? {
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (json?["routes"] as? [[String: Any]])?.map(ZnRoute.init(json:))
    }

    /// Registry 24 (ZnNavHost.kt's ZnSeeThroughStrategy): the entries drawn together when the top one is see-through,
    /// from the last opaque entry below it to the top (a see-through over a see-through shows both). nil: the top
    /// entry is drawn alone (it is opaque, or the only one). [transparent] is each entry's route option, bottom first.
    static func seeThroughRange(_ transparent: [Bool]) -> Range<Int>? {
        guard transparent.count >= 2, transparent.last == true else { return nil }
        var from = transparent.count - 2
        while from > 0 && transparent[from] { from -= 1 }
        return from..<transparent.count
    }

    /// The back stack cut into what ZnNavController draws together (ZnSeeThroughBox): a group starts at the bottom
    /// entry and at each opaque one, and holds the see-through entries above it. The top group is seeThroughRange's
    /// when that isn't nil. [transparent] is each entry's route option, bottom first.
    static func seeThroughGroups(_ transparent: [Bool]) -> [Range<Int>] {
        var groups: [Range<Int>] = []
        var start = 0
        for i in transparent.indices where i > 0 && !transparent[i] {
            groups.append(start..<i)
            start = i
        }
        if !transparent.isEmpty { groups.append(start..<transparent.count) }
        return groups
    }
}
