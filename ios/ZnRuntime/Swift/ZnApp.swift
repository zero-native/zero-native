// The app side of the runtime on iOS: loads a bundle, draws the first screen's skeleton from its template before JS
// runs, starts JS, applies batches, sends events. The counterpart of android/runtime's ZnRuntime.kt + ZnNav.kt
// (start sequence, ARCHITECTURE.md §8.1). i.1b spike: one screen at a time, no transitions (i.1c tries the back
// stack with UIKit and SwiftUI), no native modules (calls answer "unavailable").
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
    }
}

/// App-level events to JS (instance 0), as in ZnAppEvent.kt.
enum ZnAppEvent {
    static let start = 1, back = 2, forcedBack = 3, insets = 5, callResult = 7, colorScheme = 14
}

@MainActor
@Observable
final class ZnApp {
    static let shared = ZnApp()

    /// Back-stack entries (screen root instance ids), bottom first. The top one is drawn.
    private(set) var stack: [UInt32] = []
    /// A start failure (bad bundle, JS that didn't run), shown instead of a screen.
    private(set) var failure: String?
    /// Entries that want Back first (NAV BACK_WANTED): no native swipe-back on them, the swipe goes to JS (A8).
    @ObservationIgnored private(set) var backWanted = Set<UInt32>()
    /// Each back-stack entry's route.
    @ObservationIgnored private var entryRoutes: [UInt32: ZnRoute] = [:]
    /// The last safe-area insets (dp) JS was sent, as JSON; nil until JS has started.
    @ObservationIgnored private var insetsSent: String?
    @ObservationIgnored private var insetsNow = "{\"top\":0,\"bottom\":0,\"start\":0,\"end\":0}"
    @ObservationIgnored private var jsStarted = false

    func route(of entry: UInt32) -> ZnRoute? { entryRoutes[entry] }

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
    func start(bundle: URL, routeName: String, params: String) {
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
            guard let routeIndex = routes.firstIndex(where: { $0.name == routeName }) else {
                throw ZnFormatError("no route \"\(routeName)\"")
            }

            // 1. The skeleton: the root instance from its template, drawn now, before JS has started (§8.1).
            let entry = nextNativeEntry
            nextNativeEntry += 1
            store.mountRoot(id: entry, templateId: routes[routeIndex].screen, template: templates[routes[routeIndex].screen])
            entryRoutes[entry] = routes[routeIndex]
            stack = [entry]

            // 2. JS: batches, events, errors.
            store.onNav = { [weak self] kind, entry, route, params in self?.nav(kind, entry, route, params) }
            store.onError = { message in ZnDebug.log.error("\(message, privacy: .public)") }
            host.onApply = { [weak self] data in self?.apply(data) }
            host.onJsError = { kind, whereText, details in
                ZnDebug.log.error("js error \(whereText, privacy: .public) [\(kind, privacy: .public)]: \(details, privacy: .public)")
            }
            let delayMs = Double(ProcessInfo.processInfo.environment["ZN_JS_DELAY_MS"] ?? "") ?? 0
            let startPayload = "[{\"entry\":\(entry),\"route\":\(routeIndex),\"params\":\(params)}]"
            let mainScript = bundle.appendingPathComponent("main.hbc").path
            DispatchQueue.main.asyncAfter(deadline: .now() + delayMs / 1000) { [host] in
                host.evalFile(mainScript) { ok, result, ms in
                    guard ok else {
                        self.failure = "main.hbc failed: \(result)"
                        return
                    }
                    print("zn: main.hbc evaluated in \(String(format: "%.1f", ms)) ms")
                    host.dispatchEvent(0, event: UInt16(ZnAppEvent.colorScheme), string: "light")
                    self.jsStarted = true
                    self.sendInsets()  // before START, so a full-bleed first screen pads its header at once
                    host.dispatchEvent(0, event: UInt16(ZnAppEvent.start), string: startPayload)
                }
            }
        } catch {
            failure = "can't start: \(error)"
        }
    }

    private func apply(_ data: Data) {
        do {
            let ops = try BatchReader.read(data)
            store.apply(ops)
            ZnDebug.afterBatch("a batch of \(ops.count) op(s)")
        } catch {
            ZnDebug.log.error("bad batch: \(String(describing: error), privacy: .public)")
        }
    }

    private func nav(_ kind: Int, _ entry: UInt32, _ route: Int, _ params: String?) {
        guard let ctx else { return }
        print("zn t=\(ZnDebug.ms()) nav: kind \(kind) entry \(entry) route \(route) → stack \(stack)")
        switch kind {
        case NavKind.push:
            guard let r = routes[safe: route], let t = ctx.templates[safe: r.screen] else { return }
            store.mountRoot(id: entry, templateId: r.screen, template: t)
            entryRoutes[entry] = r
            stack.append(entry)
        case NavKind.remove:
            stack.removeAll { $0 == entry }
            backWanted.remove(entry)
            releaseLater([entry])
        case NavKind.clear:
            releaseLater(stack)
            stack.removeAll()
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
