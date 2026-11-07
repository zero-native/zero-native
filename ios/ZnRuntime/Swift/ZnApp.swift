// The app side of the runtime on iOS: loads a bundle, draws the first screen's skeleton from its template before JS
// runs, starts JS, applies batches, sends events. The counterpart of android/runtime's ZnRuntime.kt + ZnNav.kt
// (start sequence, ARCHITECTURE.md §8.1). i.1b spike: one screen at a time, no transitions (i.1c tries the back
// stack with UIKit and SwiftUI), no native modules (calls answer "unavailable").
import Foundation
import Observation
import SwiftUI

struct ZnRoute {
    let name: String
    let screen: Int  // template id of the screen's root
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
            stack.append(entry)
        case NavKind.remove:
            stack.removeAll { $0 == entry }
            releaseLater([entry])
        case NavKind.clear:
            releaseLater(stack)
            stack.removeAll()
        default:
            break  // STARTED, BACK_ANSWERED, …: not needed by the spike
        }
    }

    /// A screen leaving keeps its instances until its transition has played (spike: a fixed delay).
    private func releaseLater(_ entries: [UInt32]) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self else { return }
            for e in entries where !self.stack.contains(e) { self.store.removeTree(e) }
        }
    }

    /// The host changed the stack by itself (a finished swipe back): JS hears FORCED_BACK for each entry it lost.
    func nativeChanged(to shown: [UInt32]) {
        let removed = stack.filter { !shown.contains($0) }
        print("zn nav: native shows \(shown), JS had \(stack); FORCED_BACK for \(removed)")
        guard !removed.isEmpty else { return }
        stack = stack.filter { shown.contains($0) }
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
        return list.map { ZnRoute(name: $0["name"] as? String ?? "", screen: $0["screen"] as? Int ?? 0) }
    }
}

/// The app's root view: the top screen of the back stack.
struct ZnRootView: View {
    let app: ZnApp

    var body: some View {
        if let failure = app.failure {
            Text(failure).foregroundStyle(.red).padding()
        } else if app.ctx != nil, !app.stack.isEmpty {
            switch ZnImpl.nav {
            case .uiKit: ZnNavUIKit(app: app, stack: app.stack).ignoresSafeArea()
            case .swiftUI: ZnNavSwiftUI(app: app, stack: app.stack)
            }
        } else {
            Color.white
        }
    }
}
