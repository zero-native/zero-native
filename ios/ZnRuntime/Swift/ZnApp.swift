// The app side of the runtime on iOS: loads a bundle, draws the first screen's skeleton from its template before JS
// runs, starts JS, applies batches, sends events. The counterpart of android/runtime's ZnRuntime.kt + ZnNav.kt
// (start sequence, ARCHITECTURE.md §8.1). Native modules: ZnModules.swift.
import Foundation
import Observation
import SwiftUI

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

/// App-level events to JS (instance 0), as in ZnAppEvent.kt.
enum ZnAppEvent {
    static let start = 1, back = 2, forcedBack = 3, open = 4, insets = 5, callResult = 7, appState = 11, navResult = 12, colorScheme = 14, lowMemory = 15, device = 16, window = 17, keyboard = 18
}

@MainActor
@Observable
final class ZnApp {
    static let shared = ZnApp()

    /// Back-stack entries (screen root instance ids), bottom first. The top one is drawn.
    private(set) var stack: [UInt32] = [] { didSet { topRouteMaybeChanged() } }
    /// A start failure (bad bundle, JS that didn't run), shown instead of a screen.
    private(set) var failure: String?
    /// startApp's app layers (NAV LAYER): "top" / "overlay" → its root instance id (ZnLayers.swift).
    private(set) var layers: [String: UInt32] = [:]
    /// Entries that want Back first (NAV BACK_WANTED): no native swipe-back on them, the swipe goes to JS (A8).
    @ObservationIgnored private(set) var backWanted = Set<UInt32>()
    /// Each back-stack entry's route.
    @ObservationIgnored private var entryRoutes: [UInt32: ZnRoute] = [:]
    /// The last safe-area insets (dp) JS was sent, as JSON; nil until JS has started.
    @ObservationIgnored private var insetsSent: String?
    @ObservationIgnored private var insetsNow = "{\"top\":0,\"bottom\":0,\"start\":0,\"end\":0}"
    @ObservationIgnored private var jsStarted = false

    func route(of entry: UInt32) -> ZnRoute? { entryRoutes[entry] }

    // MARK: Links

    @ObservationIgnored private var earlyLinks: [URL] = []

    /// A link while the app runs (the scene's openURLContexts, a universal link): JS pushes its route, or its
    /// onUnmatchedLink hears it (OPEN, as ZnNav.kt). A launch waiting for its app to come back hears it too.
    func openLink(_ url: URL) {
        ZnLaunch.noteLink(url)
        guard jsStarted else { return earlyLinks.append(url) }
        sendOpen(url, atStart: false)
    }

    private func sendOpen(_ url: URL, atStart: Bool) {
        var payload: [String: Any] = ["route": -1, "params": [String: String](), "url": url.absoluteString]
        if !atStart, let m = ZnLinks.match(url, routes) {
            payload["route"] = m.route
            payload["params"] = m.params
        } else {
            payload["atStart"] = atStart
        }
        guard let json = ZnModules.json(payload) else { return }
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.open), string: json)
    }

    // MARK: Listeners for plugins (Crashlytics, Analytics), as Android's ZnRuntime.addJsErrorListener and ZnNav.stack

    /// JS threw and nothing caught it, hung, or didn't start: kind ("screen", "handler", "async", "hang", "start", ...),
    /// where, and the details with the JS stack. Main thread.
    typealias JsErrorListener = (_ kind: String, _ whereText: String, _ details: String) -> Void
    @ObservationIgnored private var jsErrorListeners: [JsErrorListener] = []
    @ObservationIgnored private var routeListeners: [(String?) -> Void] = []
    @ObservationIgnored private var lastTopRoute: String??

    func addJsErrorListener(_ listener: @escaping JsErrorListener) { jsErrorListeners.append(listener) }

    /// The top screen's route name, now and after each change (nil before the first screen). Main thread.
    func addTopRouteListener(_ listener: @escaping (String?) -> Void) {
        routeListeners.append(listener)
        listener(topRoute)
    }

    /// The top screen's route name.
    var topRoute: String? { stack.last.flatMap { entryRoutes[$0]?.name } }

    private func topRouteMaybeChanged() {
        let now = topRoute
        guard lastTopRoute != .some(now) else { return }
        lastTopRoute = .some(now)
        routeListeners.forEach { $0(now) }
    }

    /// The window's safe-area insets changed (start, rotation): JS's insets() hears them (INSETS, as on Android).
    func reportInsets(top: CGFloat, bottom: CGFloat, start: CGFloat, end: CGFloat) {
        print("zn t=\(ZnDebug.ms()) insets: top \(top) bottom \(bottom) (JS started: \(jsStarted))")
        insetsNow = "{\"top\":\(Double(top)),\"bottom\":\(Double(bottom)),\"start\":\(Double(start)),\"end\":\(Double(end))}"
        sendInsets()
    }

    private func sendInsets() {
        guard jsStarted, insetsNow != insetsSent else { return }
        insetsSent = insetsNow
        print("zn t=\(ZnDebug.ms()) insets → JS \(insetsNow)")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.insets), string: insetsNow)
    }

    @ObservationIgnored let store = ZnStore()
    @ObservationIgnored private(set) var ctx: ZnContext?
    @ObservationIgnored private var routes: [ZnRoute] = []
    @ObservationIgnored private var nextNativeEntry: UInt32 = 0x8000_0001  // native entry ids have the top bit set
    @ObservationIgnored private let host = ZNHost.shared

    /// Starts the app from a bundle folder (main.hbc, main.zn.ui, main.zn.ui.json) on route `routeName`.
    /// The bundle folder (main.hbc, main.zn.ui, assets such as images/): `asset:` sources resolve against it.
    @ObservationIgnored private(set) var bundleURL: URL?

    /// [routeName] nil: the app's start route (path "/"), with [link]'s screen on top when a link started the app (as
    /// Android's ZnNav). A route name (the sample's ZN_ROUTE, debug) opens that route alone.
    func start(bundle: URL, routeName: String?, params: String, link: URL? = nil) {
        bundleURL = bundle
        do {
            let file = try TemplateReader.read(try Data(contentsOf: bundle.appendingPathComponent("main.zn.ui")))
            let templates = file.templates.map(ZnTemplate.init)
            routes = try Self.readRoutes(bundle.appendingPathComponent("main.zn.ui.json"))
            ctx = ZnContext(templates: templates, store: store) { [host] instance, event, payload in
                switch payload {
                case .none: host.dispatchEvent(instance, event: UInt16(event))
                case .bool(let b): host.dispatchEvent(instance, event: UInt16(event), boolean: b)
                case .number(let n): host.dispatchEvent(instance, event: UInt16(event), number: n)
                case .string(let s): host.dispatchEvent(instance, event: UInt16(event), string: s)
                }
            }
            // The first screens: (route, params JSON, link).
            var first: [(Int, String, String?)] = []
            var unmatched: URL?
            if let routeName {
                guard let i = routes.firstIndex(where: { $0.name == routeName }) else { throw ZnFormatError("no route \"\(routeName)\"") }
                first = [(i, params, nil)]
            } else {
                guard let home = routes.firstIndex(where: { $0.path == "/" }) else { throw ZnFormatError("the bundle has no route with path \"/\"") }
                first = [(home, "{}", nil)]
                if let link {
                    if let m = ZnLinks.match(link, routes) {
                        let p = ZnModules.json(m.params) ?? "{}"
                        // A link to the start screen itself (one of its tabs) opens it with the link's params.
                        if m.route == home { first[0] = (home, p, link.absoluteString) } else { first.append((m.route, p, link.absoluteString)) }
                    } else {
                        unmatched = link
                    }
                }
            }

            // 1. The skeleton: the root instances from their templates, drawn now, before JS has started (§8.1).
            var items: [String] = []
            var entries: [UInt32] = []
            for (routeIndex, p, l) in first {
                let entry = nextNativeEntry
                nextNativeEntry += 1
                if routes[routeIndex].native == nil {
                    store.mountRoot(id: entry, templateId: routes[routeIndex].screen, template: templates[routes[routeIndex].screen])
                }
                entryRoutes[entry] = routes[routeIndex]
                entries.append(entry)
                var item = "{\"entry\":\(entry),\"route\":\(routeIndex),\"params\":\(p)"
                if let l, let text = ZnModules.json(l) { item += ",\"link\":\(text)" }
                items.append(item + "}")
            }
            stack = entries

            // 2. JS: batches, events, errors.
            store.onNav = { [weak self] kind, entry, route, params in self?.nav(kind, entry, route, params) }
            store.onError = { message in ZnDebug.log.error("\(message, privacy: .public)") }
            host.onApply = { [weak self] data in self?.apply(data) }
            // JS's console and the core's log lines, on the console as well as os_log (the debug run reads them).
            host.onLog = { level, message in print("zn-js \(["D", "I", "W", "E"][min(max(level, 0), 3)]) \(message)") }
            host.onJsError = { [weak self] kind, whereText, details in
                ZnDebug.log.error("js error \(whereText, privacy: .public) [\(kind, privacy: .public)]: \(details, privacy: .public)")
                self?.jsErrorListeners.forEach { $0(kind, whereText, details) }
            }
            let delayMs = Double(ProcessInfo.processInfo.environment["ZN_JS_DELAY_MS"] ?? "") ?? 0
            let startPayload = "[\(items.joined(separator: ","))]"
            let mainScript = bundle.appendingPathComponent("main.hbc").path
            ZnModules.install()  // before the main script: its constants are read as it starts
            DispatchQueue.main.asyncAfter(deadline: .now() + delayMs / 1000) { [host] in
                host.evalFile(mainScript) { ok, result, ms in
                    guard ok else {
                        self.failure = "main.hbc failed: \(result)"
                        return
                    }
                    print("zn: main.hbc evaluated in \(String(format: "%.1f", ms)) ms")
                    // Fixed facts and the window, before any screen (ZnWindow.kt afterMainScript).
                    host.dispatchEvent(0, event: UInt16(ZnAppEvent.device), string: Self.deviceJson())
                    host.dispatchEvent(0, event: UInt16(ZnAppEvent.window), string: Self.windowJson())
                    self.jsStarted = true
                    ZnSystemEvents.shared.start()  // the colour scheme now, then app state, memory, keyboard changes
                    self.sendInsets()  // before START, so a full-bleed first screen pads its header at once
                    host.dispatchEvent(0, event: UInt16(ZnAppEvent.start), string: startPayload)
                    // A start link that matches no route goes to JS's onUnmatchedLink now; links that came while JS
                    // was starting follow.
                    if let unmatched { self.sendOpen(unmatched, atStart: true) }
                    let early = self.earlyLinks
                    self.earlyLinks = []
                    early.forEach { self.openLink($0) }
                }
            }
        } catch {
            failure = "can't start: \(error)"
        }
    }

    /// DEVICE (platform.ts): Android's keys, with iOS's values; `os` says which platform it is.
    static func deviceJson() -> String {
        ZnModules.json(["os": "ios", "sdk": 0, "release": znIosVersion(), "model": ZnOs.model, "brand": "Apple",
                        "manufacturer": "Apple"]) ?? "{}"
    }

    /// WINDOW (dimensions.ts): the screen in points (dp), its scale and the text size setting as a scale.
    static func windowJson() -> String {
        let screen = UIScreen.main
        let size = screen.bounds.size
        let fontScale = UIFontMetrics.default.scaledValue(for: 100) / 100
        let r = { (v: CGFloat) in (Double(v) * 10).rounded() / 10 }
        return ZnModules.json(["width": r(size.width), "height": r(size.height), "scale": Double(screen.scale),
                               "fontScale": (Double(fontScale) * 1000).rounded() / 1000,
                               "screenWidth": r(size.width), "screenHeight": r(size.height)]) ?? "{}"
    }

    /// The batch being applied (or just applied) changes the back stack: a sheet closing in the same batch closes
    /// without animation, or UIKit would hold the navigation transition until the sheet's animation ends (~0.5 s).
    @ObservationIgnored private(set) var batchChangesStack = false

    @ObservationIgnored private var jsDrew = false
    @ObservationIgnored private var waitingForJS: [() -> Void] = []

    /// Runs [f] once JS has drawn its first batch. The first screen is drawn from its template before JS runs
    /// (§8.1); an event from that skeleton (a local picture that loads at once: onLoad) would reach JS before the
    /// screen's handlers exist and be dropped ("no handler for event", seen 2026-11-08 in the RN props lab).
    func afterJSDrew(_ f: @escaping () -> Void) {
        if jsDrew { f() } else { waitingForJS.append(f) }
    }

    private func apply(_ data: Data) {
        do {
            let ops = try BatchReader.read(data)
            batchChangesStack = ops.contains {
                if case let .nav(kind, _, _, _) = $0 { return [NavKind.push, NavKind.remove, NavKind.clear].contains(kind) }
                return false
            }
            store.apply(ops)
            ZnDebug.afterBatch("a batch of \(ops.count) op(s)")
            if !jsDrew {
                jsDrew = true
                let waiting = waitingForJS
                waitingForJS = []
                waiting.forEach { $0() }
            }
        } catch {
            ZnDebug.log.error("bad batch: \(String(describing: error), privacy: .public)")
        }
    }

    private func nav(_ kind: Int, _ entry: UInt32, _ route: Int, _ params: String?) {
        guard let ctx else { return }
        print("zn t=\(ZnDebug.ms()) nav: kind \(kind) entry \(entry) route \(route) → stack \(stack)")
        switch kind {
        case NavKind.push:
            guard let r = routes[safe: route] else { return }
            if r.native != nil {
                // A plugin's screen: no template; its params go to the plugin (ZnPlugins.swift).
                nativeParams[entry] = params
            } else {
                guard let t = ctx.templates[safe: r.screen] else { return }
                store.mountRoot(id: entry, templateId: r.screen, template: t)
            }
            entryRoutes[entry] = r
            stack.append(entry)
        case NavKind.remove:
            stack.removeAll { $0 == entry }
            backWanted.remove(entry)
            releaseLater([entry])
        case NavKind.clear:
            releaseLater(stack)
            stack.removeAll()
        case NavKind.layer:
            // The layer's root from its template (entry = root id, route = template id); entry 0 removes it.
            let name = params.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }?["layer"] as? String
            guard let name, name == Self.layerTop || name == Self.layerOverlay else {
                return print("zn nav: unknown layer \(params ?? "")")
            }
            if let old = layers.removeValue(forKey: name) { store.removeTree(old) }
            guard entry != 0 else { return }
            guard let t = ctx.templates[safe: route] else { return print("zn nav: layer \(name) has no template \(route)") }
            store.mountRoot(id: entry, templateId: route, template: t)
            layers[name] = entry
        case NavKind.backWanted:
            if route != 0, stack.contains(entry) { backWanted.insert(entry) } else { backWanted.remove(entry) }
            print("zn t=\(ZnDebug.ms()) nav: screens that want Back first: \(backWanted.sorted())")
        default:
            break  // STARTED, BACK_ANSWERED, …: not needed by the spike
        }
    }

    /// A screen leaving keeps its instances until its transition has played (spike: a fixed delay).
    private func releaseLater(_ entries: [UInt32]) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self else { return }
            for e in entries where !self.stack.contains(e) {
                self.store.removeTree(e)
                self.entryRoutes[e] = nil
            }
        }
    }

    /// The host changed the stack by itself (a finished swipe back): JS hears FORCED_BACK for each entry it lost.
    func nativeChanged(to shown: [UInt32]) {
        let removed = stack.filter { !shown.contains($0) }
        print("zn nav: native shows \(shown), JS had \(stack); FORCED_BACK for \(removed)")
        guard !removed.isEmpty else { return }
        stack = stack.filter { shown.contains($0) }
        for e in removed { backWanted.remove(e) }
        for e in removed.reversed() { host.dispatchEvent(0, event: UInt16(ZnAppEvent.forcedBack), number: Double(e)) }
        releaseLater(removed)
    }

    /// A back gesture that JS decides (ZN_IOS_SWIPE=ask): BACK with the entry native has on top.
    /// A native screen's params (the push's), by entry.
    @ObservationIgnored private(set) var nativeParams: [UInt32: String?] = [:]

    /// A native screen answered (ZnScreenScope.finish): saved under "nav.<route>" before JS hears NAV_RESULT, and JS
    /// closes the screen (it owns the stack). Only the screen on top can answer.
    func answer(entry: UInt32, value: String) {
        guard stack.last == entry, let route = entryRoutes[entry] else {
            return print("zn nav: \(entry) answered but isn't on top; dropped")
        }
        let id = "\(entry).\(Int(Date().timeIntervalSince1970 * 1000))"
        ZnLaunch.saveScreenResult("nav.\(route.name)", id: id, value: value)
        let payload = ZnModules.json(["entry": entry, "route": route.name, "id": id]) ?? "{}"
        print("zn t=\(ZnDebug.ms()) nav: \(route.name) answered → JS")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.navResult), string: payload)
    }

    func systemBack() {
        guard let top = stack.last else { return }
        print("zn nav: BACK to JS for \(top)")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.back), number: Double(top))
    }

    private static func readRoutes(_ url: URL) throws -> [ZnRoute] {
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        guard let list = json?["routes"] as? [[String: Any]] else { throw ZnFormatError("main.zn.ui.json has no routes") }
        return list.map(ZnRoute.init(json:))
    }
}

/// The SwiftUI variant's root view (ZN_IOS_NAV=swiftui): the back stack as a NavigationStack.
struct ZnRootView: View {
    let app: ZnApp

    var body: some View {
        if let failure = app.failure {
            Text(failure).foregroundStyle(.red).padding()
        } else if app.ctx != nil, !app.stack.isEmpty {
            ZnNavSwiftUI(app: app, stack: app.stack)  // the comparison variant; UIKit is ZnNavController
        } else {
            Color.white
        }
    }
}
