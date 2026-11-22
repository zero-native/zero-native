// The app side of the runtime on iOS: loads a bundle, draws the first screen's skeleton from its template before JS
// runs, starts JS, applies batches, sends events. The counterpart of android/runtime's ZnRuntime.kt + ZnNav.kt
// (start sequence, ARCHITECTURE.md §8.1). Native modules: ZnModules.swift.
import Foundation
import Observation
import SwiftUI
#if SWIFT_PACKAGE
import ZnHost
#endif

/// App-level events to JS (instance 0), as in ZnAppEvent.kt.
enum ZnAppEvent {
    static let start = 1, back = 2, forcedBack = 3, open = 4, insets = 5, callResult = 7, retry = 10, appState = 11, navResult = 12, colorScheme = 14, lowMemory = 15, device = 16, window = 17, keyboard = 18
}

@MainActor
@Observable
public final class ZnApp {
    public static let shared = ZnApp()

    /// Back-stack entries (screen root instance ids), bottom first. The top one is drawn.
    private(set) var stack: [UInt32] = [] { didSet { topRouteMaybeChanged() } }
    /// A start failure (bad bundle, JS that didn't run), shown instead of a screen.
    private(set) var failure: String?
    /// Screens whose JS threw while building them (NAV FAILED), or that hung: entry → the error message. They stay on
    /// the stack and show ZnErrorScreen; "Try again" builds them again (retry).
    private(set) var failedScreens: [UInt32: String] = [:]
    /// startApp's app layers (NAV LAYER): "top" / "overlay" → its root instance id (ZnLayers.swift).
    private(set) var layers: [String: UInt32] = [:]
    /// Entries that want Back first (NAV BACK_WANTED): no native swipe-back on them, the swipe goes to JS (A8).
    @ObservationIgnored private(set) var backWanted = Set<UInt32>()
    /// Each back-stack entry's route, its params (JSON), and its `restorableSignal` values (NAV RESTORE).
    @ObservationIgnored private var entryRoutes: [UInt32: ZnRoute] = [:]
    @ObservationIgnored private var entryParams: [UInt32: String] = [:]
    @ObservationIgnored private var entryValues: [UInt32: [String: Any]] = [:]
    /// The last safe-area insets (dp) JS was sent, as JSON; nil until JS has started.
    @ObservationIgnored private var insetsSent: String?
    @ObservationIgnored private var insetsNow = "{\"top\":0,\"bottom\":0,\"start\":0,\"end\":0}"
    /// When START goes: after the main script ran and the window asked for its screens (ZnLifecycleRules.swift).
    @ObservationIgnored private var startGate = ZnStartGate()
    /// JS got START: it has screens and their listeners (links, insets and taps on notifications go to it now).
    private var jsStarted: Bool { startGate.uiStarted && startHeld == nil }
    /// prepare ran for this runtime: the bundle is read and its main script is queued or has run.
    @ObservationIgnored private var prepared = false
    /// prepare ran once in this process. A restart clears `prepared` until its new runtime is up; this stays, so
    /// nothing starts JS a second way in between (ZnTasks.run's start, a late prepare call).
    @ObservationIgnored private(set) var everPrepared = false

    /// JS has its screens (START went). Before that JS may be running already with none (a background launch: a push,
    /// a task, ZnApp.prepare), so a plugin keeps a tap or an open for the app to ask for (getInitialNotification)
    /// instead of sending an event nobody listens to yet. Main thread.
    public var isUIStarted: Bool { jsStarted }

    /// prepare ran: JS is starting or running in this process (with or without a window). Main thread.
    public var isPrepared: Bool { prepared }

    /// A tap on a notification (no link) now: true to send it to JS as an event, false to keep it for
    /// getInitialNotification (ZnTapRules: no screens yet, a getInitialNotification call waiting, or the tap that
    /// opened the app, which iOS hands over around the first time the app is in front). [asking]: the plugin's
    /// getInitialNotification calls waiting; [answered]: one had its answer already. Main thread.
    public func tapIsEvent(asking: Int, answered: Bool) -> Bool {
        ZnTapRules.isEvent(uiStarted: isUIStarted, asking: asking,
                           frontFor: firstFrontAt == 0 ? nil : CACurrentMediaTime() - firstFrontAt, answered: answered)
    }

    /// When the app first was in front with its screens up (CACurrentMediaTime), 0 before. Once per process.
    @ObservationIgnored private var firstFrontAt: CFTimeInterval = 0
    /// whenUIStartedInFront calls waiting for the screens and the front.
    @ObservationIgnored private var frontWaiters: [() -> Void] = []

    private var inFrontWithScreens: Bool { isUIStarted && UIApplication.shared.applicationState == .active }

    /// The screens went up or the app came to the front: notes the first time, and answers whoever waits for it.
    private func noteFront() {
        guard inFrontWithScreens else { return }
        if firstFrontAt == 0 { firstFrontAt = CACurrentMediaTime() }
        let waiters = frontWaiters
        frontWaiters = []
        waiters.forEach { $0() }
    }

    /// Runs [f] once JS has its screens and the app has come to the front (and a moment more: iOS hands a tap that
    /// opened the app to the notification delegate around then), or after [capMs]. For getInitialNotification, which
    /// JS may call from its main script before any window, as Android's waits for its Activity (INITIAL_WAIT_MS).
    /// Main thread.
    public func whenUIStartedInFront(capMs: Int = 10_000, _ f: @escaping () -> Void) {
        let once = ZnOnce<Void> { _ in f() }
        let ready = { [self] in
            // Long after START (a screen opened later asks): nothing is on its way.
            if CACurrentMediaTime() - uiStartedAt > 2 { once(()); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { once(()) }
        }
        if inFrontWithScreens { return ready() }
        frontWaiters.append(ready)
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(capMs)) { once(()) }
    }

    func route(of entry: UInt32) -> ZnRoute? { entryRoutes[entry] }

    /// The bundle has a `secure: true` route: the window root then holds its content in ZnSecure's container.
    var hasSecureRoute: Bool { routes.contains(where: \.secure) }

    /// The top screen's root background (slot or template), for ZnSecure's app switcher cover; nil when it has none.
    var topBackground: UIColor? {
        guard let entry = stack.last, let root = store.find(entry), let node = ctx?.templates[safe: root.templateId]?.nodes.first,
              let color = node.backgroundSlot >= 0 ? znColor(root.slot(node.backgroundSlot).value) : node.background else { return nil }
        return UIColor(color)
    }

    // MARK: Restore after the system ends the app (ZnNav.kt saveState / restart)

    static let restorationType = "dev.zeronative.zn.stack"
    private static let maxSavedChars = 50_000

    /// The app's build: values saved by another build may have another shape, so they are dropped (screens kept).
    private static var buildLabel: String {
        let i = Bundle.main.infoDictionary ?? [:]
        return "\(i["CFBundleShortVersionString"] as? String ?? "")+\(i["CFBundleVersion"] as? String ?? "")"
    }

    /// For the scene's `stateRestorationActivity(for:)`: the back stack (route names, params, restorableSignal values)
    /// up to the first `restore: false` route; nil when only the start screen with no values is open.
    public func restorationActivity() -> NSUserActivity? { savedStack(values: true) }

    /// The screens to open again, as `restorationActivity`; [values] false leaves their restorableSignal values out
    /// (an update applied in place: new code starts its state fresh, as on Android).
    private func savedStack(values withValuesToo: Bool) -> NSUserActivity? {
        let keep = stack.prefix { entryRoutes[$0]?.restore ?? false }
        if keep.isEmpty || (keep.count == 1 && (!withValuesToo || (entryValues[keep[0]] ?? [:]).isEmpty)) { return nil }
        func json(_ withValues: Bool) -> String? {
            let list: [[String: Any]] = keep.map { e in
                var o: [String: Any] = ["route": entryRoutes[e]!.name,
                                        "params": (try? JSONSerialization.jsonObject(with: Data((entryParams[e] ?? "{}").utf8))) ?? [String: Any]()]
                if withValues, let v = entryValues[e], !v.isEmpty { o["values"] = v }
                return o
            }
            return ZnModules.json(list)
        }
        var text = json(withValuesToo)
        if (text?.count ?? 0) > Self.maxSavedChars {
            print("zn: nav: screen values too big to save; saving the screens without them")
            text = json(false)
        }
        guard let text, text.count <= Self.maxSavedChars else { print("zn: nav: back stack too big to save; not saved"); return nil }
        let a = NSUserActivity(activityType: Self.restorationType)
        a.addUserInfoEntries(from: ["stack": text, "build": Self.buildLabel])
        return a
    }

    /// The saved screens to open first: the start screen, then the saved ones (route, params, values), or nil.
    private static func saved(_ a: NSUserActivity?, _ routes: [ZnRoute]) -> [(Int, String, String?, String?)]? {
        guard let a, a.activityType == restorationType, let text = a.userInfo?["stack"] as? String,
              let list = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [[String: Any]],
              let home = routes.firstIndex(where: { $0.path == "/" }) else { return nil }
        let sameBuild = a.userInfo?["build"] as? String == buildLabel
        if !sameBuild { print("zn: nav: screen values not restored: saved by another build") }
        var out: [(Int, String, String?, String?)] = []
        for o in list {
            guard let name = o["route"] as? String, let i = routes.firstIndex(where: { $0.name == name }) else { continue }
            let p = ZnModules.json(o["params"] ?? [String: Any]()) ?? "{}"
            let v = sameBuild ? (o["values"]).flatMap { ZnModules.json($0) } : nil
            out.append((i, p, nil, v))
        }
        if out.first?.0 != home { out.insert((home, "{}", nil, nil), at: 0) }
        return out.count > 1 || out.first?.3 != nil ? out : nil
    }

    // MARK: Links

    @ObservationIgnored private var earlyLinks: [URL] = []

    /// A link while the app runs (the scene's openURLContexts, a universal link): JS pushes its route, or its
    /// onUnmatchedLink hears it (OPEN, as ZnNav.kt). A launch waiting for its app to come back hears it too.
    public func openLink(_ url: URL) {
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
    public typealias JsErrorListener = (_ kind: String, _ whereText: String, _ details: String) -> Void
    @ObservationIgnored private var jsErrorListeners: [JsErrorListener] = []
    @ObservationIgnored private var routeListeners: [(String?) -> Void] = []
    @ObservationIgnored private var lastTopRoute: String??

    public func addJsErrorListener(_ listener: @escaping JsErrorListener) { jsErrorListeners.append(listener) }

    /// The top screen's route name, now and after each change (nil before the first screen). Main thread.
    public func addTopRouteListener(_ listener: @escaping (String?) -> Void) {
        routeListeners.append(listener)
        listener(topRoute)
    }

    /// The top screen's route name.
    public var topRoute: String? { stack.last.flatMap { entryRoutes[$0]?.name } }

    private func topRouteMaybeChanged() {
        let now = topRoute
        guard lastTopRoute != .some(now) else { return }
        lastTopRoute = .some(now)
        routeListeners.forEach { $0(now) }
    }

    /// The window's safe-area insets changed (start, rotation): JS's insets() hears them (INSETS, as on Android).
    /// The window's top and bottom safe areas, for ZnBarStrips (the status bar's and the home indicator's strips).
    private(set) var windowInsetTop: CGFloat = 0
    private(set) var windowInsetBottom: CGFloat = 0

    func reportInsets(top: CGFloat, bottom: CGFloat, start: CGFloat, end: CGFloat) {
        if windowInsetTop != top { windowInsetTop = top }
        if windowInsetBottom != bottom { windowInsetBottom = bottom }
        print("zn t=\(ZnDebug.ms()) insets: top \(top) bottom \(bottom) (JS started: \(jsStarted))")
        insetsNow = "{\"top\":\(Double(top)),\"bottom\":\(Double(bottom)),\"start\":\(Double(start)),\"end\":\(Double(end))}"
        insetsKnown = true
        if startHeld != nil { releaseHeldStart() } else { sendInsets() }
    }

    /// The window has reported its safe area once (it stays known across a restart: same window).
    @ObservationIgnored private var insetsKnown = false
    /// START, held until the window's safe area is known: JS was up before the window (a launch with no window), and
    /// the first screen would pad its header with 0 first.
    @ObservationIgnored private var startHeld: String?

    private func startOnceWindowKnown(_ payload: String) {
        guard !insetsKnown else { return sendStart(payload) }
        startHeld = payload
        // A host whose root never reports insets (none of ours): START goes anyway.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.releaseHeldStart() }
    }

    private func releaseHeldStart() {
        guard let payload = startHeld else { return }
        startHeld = nil
        sendStart(payload)
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

    /// The bundle folder (main.hbc, main.zn.ui, assets such as images/): `asset:` sources resolve against it.
    @ObservationIgnored public private(set) var bundleURL: URL?

    /// Starts JS on the app's bundle with no window: reads the bundle, runs its main script, and from then on tasks
    /// (`defineTask`) and events reach JS. Call it at the end of `application(_:didFinishLaunchingWithOptions:)`, after
    /// ZnPlugins.register and ZnOta.configure: a launch with no window (a data-only push, a notification's button, a
    /// background task) then runs its JS task, as Android starts JS in Application.onCreate. The window's screens come
    /// later with `start` (the scene). Safe to call more than once; `start` calls it if the app didn't.
    /// [builtIn]: the app's own bundle folder (main.hbc, main.zn.ui, main.zn.ui.json), usually Bundle.main.resourceURL.
    public func prepare(bundle builtIn: URL) { prepare(bundle: builtIn, reusing: false) }

    /// [reusing]: a restart (ZnOta's swap): [builtIn] is the folder to run, already chosen.
    private func prepare(bundle builtIn: URL, reusing: Bool) {
        // Once per process, then once per restart (which names its bundle): a second first start would choose the
        // bundle again and run it over the one a restart is bringing up.
        guard !prepared, reusing || !everPrepared else { return }
        prepared = true
        if !everPrepared {
            everPrepared = true
            // The first time the app is in front with its screens (getInitialNotification, tapMayHaveOpenedApp).
            NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { ZnApp.shared.noteFront() }
            }
        }
        // The bundle to run: a downloaded one when OTA is on and it passes every check, else the app's own (ZnOta.swift).
        ZnModules.registerBuiltIns()  // a bundle's needs are checked against every module
        let bundle = reusing ? builtIn : (ZnBundles.choose(builtIn: builtIn).dir ?? builtIn)
        bundleURL = bundle
        print("zn t=\(ZnDebug.ms()) app: JS starts on \(bundle.lastPathComponent)")
        do {
            let file = try TemplateReader.read(try Data(contentsOf: bundle.appendingPathComponent("main.zn.ui")))
            let templates = file.templates.map(ZnTemplate.init)
            let manifest = try Self.readManifest(bundle.appendingPathComponent("main.zn.ui.json"))
            routes = manifest.routes
            ZnFontTable.install(manifest: manifest.json)  // this bundle's fonts (a restart too)
            ctx = ZnContext(templates: templates, store: store) { [host] instance, event, payload in
                switch payload {
                case .none: host.dispatchEvent(instance, event: UInt16(event))
                case .bool(let b): host.dispatchEvent(instance, event: UInt16(event), boolean: b)
                case .number(let n): host.dispatchEvent(instance, event: UInt16(event), number: n)
                case .string(let s): host.dispatchEvent(instance, event: UInt16(event), string: s)
                }
            }
        } catch {
            let evaluated = onEvaluated
            onEvaluated = nil
            failure = "can't start: \(error)"
            ZnOta.errorScreen(kind: "start", where: "the bundle", details: "\(error)")
            evaluated?(false, "\(error)")
            return
        }

        // JS: batches, events, errors.
        store.onNav = { [weak self] kind, entry, route, params in self?.nav(kind, entry, route, params) }
        store.onError = { message in ZnDebug.log.error("\(message, privacy: .public)") }
        host.onApply = { [weak self] data in self?.apply(data) }
        // JS's console and the core's log lines, on the console as well as os_log (the debug run reads them).
        host.onLog = { level, message in print("zn-js \(["D", "I", "W", "E"][min(max(level, 0), 3)]) \(message)") }
        host.onJsError = { [weak self] kind, whereText, details in
            ZnDebug.log.error("js error \(whereText, privacy: .public) [\(kind, privacy: .public)]: \(details, privacy: .public)")
            // JS stopped by the time limit: the top screen's state may be half updated; it shows the error screen
            // and "Try again" builds it again (Android's ZnNav.hung).
            // A downloaded bundle that isn't healthy yet and shows an error screen is blocked and the last good
            // one runs from the next start (Android's ZnRuntime.jsError). A hang in the background (a task) doesn't count.
            if kind == "start" || kind == "screen" || (kind == "hang" && ZnOtaHealth.inFront) {
                ZnOta.errorScreen(kind: kind, where: whereText, details: details)
            }
            if kind == "hang", let self, let top = self.stack.last {
                self.failedScreens[top] = String(details.split(separator: "\n", maxSplits: 1).first ?? "")
            }
            self?.jsErrorListeners.forEach { $0(kind, whereText, details) }
        }
        let delayMs = Double(ProcessInfo.processInfo.environment["ZN_JS_DELAY_MS"] ?? "") ?? 0
        let mainScript = bundle.appendingPathComponent("main.hbc").path
        ZnModules.install()  // before the main script: its constants are read as it starts
        DispatchQueue.main.asyncAfter(deadline: .now() + delayMs / 1000) { [host] in
            ZnOta.mainScriptQueued()  // OTA status events may go now: they run after the script
            host.evalFile(mainScript) { ok, result, ms in
                // A restart's caller hears first; it may restart again on another bundle (that resets `failure`).
                let evaluated = self.onEvaluated
                self.onEvaluated = nil
                guard ok else {
                    self.failure = "main.hbc failed: \(result)"  // the host also sent it as a "start" JS error (OTA)
                    evaluated?(false, result)
                    return
                }
                evaluated?(true, "")
                print("zn: main.hbc evaluated in \(String(format: "%.1f", ms)) ms")
                // Fixed facts and the window, before any screen (ZnWindow.kt afterMainScript): the window measured
                // already (a restart, or the window came first), else the screen's.
                host.dispatchEvent(0, event: UInt16(ZnAppEvent.device), string: Self.deviceJson())
                let window = self.windowNow ?? Self.screenWindowJson()
                self.windowSent = window
                host.dispatchEvent(0, event: UInt16(ZnAppEvent.window), string: window)
                let start = self.startGate.scriptRan()
                ZnTasks.shared.jsLoaded()  // tasks that waited for JS (a push, a dismiss, a button)
                ZnSystemEvents.shared.start()  // the colour scheme now, then app state, memory, keyboard changes
                if let start { self.startOnceWindowKnown(start) } else { print("zn t=\(ZnDebug.ms()) app: JS is up, no window yet") }
            }
        }
    }

    /// The window's first screens (the scene): their skeletons now, from their templates (§8.1), and START to JS once
    /// its main script has run. JS starts here if `prepare` didn't run yet.
    /// [routeName] nil: the app's start route (path "/"), with [link]'s screen on top when a link started the app (as
    /// Android's ZnNav). A route name (the sample's ZN_ROUTE, debug) opens that route alone.
    /// [restoring]: the scene's `stateRestorationActivity` (restorationActivity's): iOS gives it back only after it ended
    /// the app itself, never after the user closed it, as Android's saved state. It wins over [link], not over [routeName].
    public func start(bundle builtIn: URL, routeName: String?, params: String, link: URL? = nil, restoring: NSUserActivity? = nil,
               reusing: Bool = false) {
        // [reusing]: a restart (ZnOta's swap): [builtIn] is the folder to run, already chosen.
        if !reusing, everPrepared, builtIn.standardizedFileURL != ZnBundles.builtInURL.standardizedFileURL {
            print("zn: app: start names the app's bundle \(builtIn.path), but JS already started from \(ZnBundles.builtInURL.path) (ZnApp.prepare or a task ran first); that one stays")
        }
        prepare(bundle: builtIn, reusing: reusing)
        if !reusing { ZnOta.beginLaunchGate() }  // the first window: the update check runs now (ZnOtaGate)
        // A second window (iOS connected the scene again while the process lived, or another scene): the screens
        // JS has stay, and the new window's root draws them; the link it came with reaches JS as a link.
        if !reusing, !stack.isEmpty || startGate.uiStarted {
            print("zn: app: a window asks for screens again; keeping the \(stack.count) open")
            if let link { openLink(link) }
            return
        }
        guard let ctx, failure == nil else {  // the bundle couldn't be read: the error screen shows
            // JS started with no window on a downloaded bundle that failed: it is blocked; with a window now, the
            // last good bundle comes in place (ZnOta), as when the window was there first.
            if !reusing, failure != nil { DispatchQueue.main.async { ZnOta.rollBackPendingInPlace() } }
            return
        }
        let templates = ctx.templates
        do {
            // The first screens: (route, params JSON, link, restorableSignal values JSON).
            var first: [(Int, String, String?, String?)] = []
            var unmatched: URL?
            if routeName == nil, let saved = Self.saved(restoring, routes) {  // a route named for a dev run wins
                print("zn: nav: iOS restored the app; reopening \(saved.count) screen(s): \(saved.map { routes[$0.0].name })")
                first = saved
            } else if let routeName {
                guard let i = routes.firstIndex(where: { $0.name == routeName }) else { throw ZnFormatError("no route \"\(routeName)\"") }
                first = [(i, params, nil, nil)]
            } else {
                guard let home = routes.firstIndex(where: { $0.path == "/" }) else { throw ZnFormatError("the bundle has no route with path \"/\"") }
                first = [(home, "{}", nil, nil)]
                if let link {
                    if let m = ZnLinks.match(link, routes) {
                        let p = ZnModules.json(m.params) ?? "{}"
                        // A link to the start screen itself (one of its tabs) opens it with the link's params.
                        if m.route == home { first[0] = (home, p, link.absoluteString, nil) } else { first.append((m.route, p, link.absoluteString, nil)) }
                    } else {
                        unmatched = link
                    }
                }
            }

            // The skeleton: the root instances from their templates, drawn now, before JS has started (§8.1).
            var items: [String] = []
            var entries: [UInt32] = []
            for (routeIndex, p, l, values) in first {
                let entry = nextNativeEntry
                nextNativeEntry += 1
                if routes[routeIndex].native == nil {
                    store.mountRoot(id: entry, templateId: routes[routeIndex].screen, template: templates[routes[routeIndex].screen])
                }
                entryRoutes[entry] = routes[routeIndex]
                entryParams[entry] = p
                if routes[routeIndex].native != nil { nativeParams[entry] = p }
                entries.append(entry)
                var item = "{\"entry\":\(entry),\"route\":\(routeIndex),\"params\":\(p)"
                if let values, let o = try? JSONSerialization.jsonObject(with: Data(values.utf8)) as? [String: Any], !o.isEmpty {
                    entryValues[entry] = o  // kept natively too: a value not shown yet must survive a second kill
                    item += ",\"values\":\(values)"
                }
                if let l, let text = ZnModules.json(l) { item += ",\"link\":\(text)" }
                items.append(item + "}")
            }
            stack = entries
            startLink = unmatched
            // START now if JS is up (it started in the background), else when its main script has run.
            if let start = startGate.windowAsks("[\(items.joined(separator: ","))]") { startOnceWindowKnown(start) }
        } catch {
            let evaluated = onEvaluated
            onEvaluated = nil
            failure = "can't start: \(error)"
            ZnOta.errorScreen(kind: "start", where: "the bundle", details: "\(error)")
            evaluated?(false, "\(error)")
        }
    }

    /// When START went (CACurrentMediaTime), for whenUIStartedInFront.
    @ObservationIgnored private var uiStartedAt: CFTimeInterval = 0

    /// A start link that matches no route: JS's onUnmatchedLink hears it right after START.
    @ObservationIgnored private var startLink: URL?

    /// START: JS builds the first screens. Insets first, so a full-bleed first screen pads its header at once.
    private func sendStart(_ payload: String) {
        uiStartedAt = CACurrentMediaTime()
        sendInsets()
        print("zn t=\(ZnDebug.ms()) app: START → JS")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.start), string: payload)
        noteFront()
        // A start link that matches no route goes to JS's onUnmatchedLink now; links that came while JS was starting
        // follow.
        if let unmatched = startLink {
            startLink = nil
            sendOpen(unmatched, atStart: true)
        }
        let early = earlyLinks
        earlyLinks = []
        early.forEach { openLink($0) }
    }

    // MARK: Restart on another bundle (an OTA update applied in place, ZnOta.swift)

    /// Runs once when the next start's main.hbc has run (true) or failed (false, the error), before START.
    @ObservationIgnored private var onEvaluated: ((Bool, String) -> Void)?
    @ObservationIgnored private(set) var restarting = false

    /// Replaces the JS runtime and runs [bundle] in this process: the screens that were open (the restorable ones,
    /// as `restorationActivity`) open again by route and params, their JS state fresh. The window gets a new root
    /// controller; [window]'s cover (the caller's) hides the swap. [done] runs on the main thread after main.hbc ran:
    /// true, or false with the error (the caller may restart again on another bundle).
    public func restart(bundle: URL, in window: UIWindow?, done: @escaping (Bool, String) -> Void) {
        let saved = savedStack(values: false)
        restarting = true
        ZnPopups.shared.closeAll(why: "the runtime is replaced")  // no slide over the OTA cover; the new root has its own box
        stack = []
        failure = nil
        failedScreens = [:]
        layers = [:]
        backWanted = []
        entryRoutes = [:]
        entryParams = [:]
        entryValues = [:]
        nativeParams = [:]
        insetsSent = nil
        windowSent = nil  // the new JS hears the window again (Android's generation key)
        startGate.reset()
        startHeld = nil
        startLink = nil
        prepared = false
        ZnTasks.shared.jsStopped()
        ZnModules.runtimeReplaced()
        firstScreensUp = false
        jsDrew = false
        batchChangesStack = false
        ctx = nil
        routes = []
        store.reset()
        host.restartRuntime { [self] in
            onEvaluated = { [self] ok, error in
                restarting = false
                done(ok, error)
            }
            start(bundle: bundle, routeName: nil, params: "{}", restoring: saved, reusing: true)
            if let window {
                window.rootViewController = makeRootViewController()
                // The covers (the swap's, the update screen) stay above the new screens.
                for v in window.subviews where v !== window.rootViewController?.view { window.bringSubviewToFront(v) }
            }
        }
    }

    /// DEVICE (platform.ts): Android's keys, with iOS's values; `os` says which platform it is.
    static func deviceJson() -> String {
        ZnModules.json(["os": "ios", "sdk": 0, "release": znIosVersion(), "model": ZnOs.model, "brand": "Apple",
                        "manufacturer": "Apple"]) ?? "{}"
    }

    // MARK: The window (WINDOW, dimensions.ts), as Android's ZnWindow.kt

    /// The window measured last (ZnRootController), as WINDOW's text; nil before the first layout.
    @ObservationIgnored private var windowNow: String?
    /// The last WINDOW JS got (nil: none yet for this runtime).
    @ObservationIgnored private var windowSent: String?
    /// The last measured window's size and screen, to send again when only the text size changes.
    @ObservationIgnored private var windowSize: CGSize?
    @ObservationIgnored private weak var windowScreen: UIScreen?

    /// The phone's text size setting as a scale (Android's fontScale): the same number the drawn text uses. The
    /// category is the app's (UITraitCollection.current isn't updated yet when the change notification comes).
    static func fontScale() -> Double {
        Double(znContentSizeScale(UIApplication.shared.preferredContentSizeCategory))
    }

    /// Before the window is measured (JS started with no window): the whole screen.
    static func screenWindowJson() -> String {
        let screen = UIScreen.main
        return windowJson(screen.bounds.size, screen: screen)
    }

    private static func windowJson(_ size: CGSize, screen: UIScreen) -> String {
        ZnWindowRules.windowJson(width: Double(size.width), height: Double(size.height), scale: Double(screen.scale),
                                 fontScale: fontScale(), screenWidth: Double(screen.bounds.width),
                                 screenHeight: Double(screen.bounds.height))
    }

    /// The window's root laid out (ZnRootController): its size, in [screen] (which turns with the phone). WINDOW goes
    /// to JS when it changed (rotation, split view, Stage Manager) and JS is up.
    func reportWindow(_ size: CGSize, screen: UIScreen?) {
        guard size.width > 0, size.height > 0 else { return }
        windowSize = size
        windowScreen = screen
        let json = Self.windowJson(size, screen: screen ?? .main)
        windowNow = json
        sendWindow()
    }

    /// The text size setting changed (ZnSystemEvents): the last window again, with the new font scale.
    func refreshWindow() {
        if let windowSize { reportWindow(windowSize, screen: windowScreen) } else { sendWindow() }
    }

    private func sendWindow() {
        guard startGate.scriptLoaded, let json = windowNow ?? (windowSent != nil ? Self.screenWindowJson() : nil),
              json != windowSent else { return }
        windowSent = json
        print("zn t=\(ZnDebug.ms()) window → JS \(json)")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.window), string: json)
    }

    /// The batch being applied (or just applied) changes the back stack: a sheet closing in the same batch closes
    /// without animation, or UIKit would hold the navigation transition until the sheet's animation ends (~0.5 s).
    @ObservationIgnored private(set) var batchChangesStack = false

    /// JS sent NAV STARTED: it handled START and built the first screens (ZnSplash waits for it).
    @ObservationIgnored private(set) var firstScreensUp = false

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
            let before = stack
            store.apply(ops)
            // Screens that left the stack in this batch (pop, replace, reset) close their Sheets and Modals now, before
            // the next screen's own open (finding 20): not when UIKit releases them ~0.6 s later.
            let gone = Set(before).subtracting(stack)
            if !gone.isEmpty { ZnPopups.shared.closeEntries(gone, why: "its screen left the stack") }
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
            entryParams[entry] = params ?? "{}"
            stack.append(entry)
        case NavKind.restore:
            // A restorableSignal of [entry] changed: {"key":k,"value":v} keeps v; no "value" forgets k.
            guard let o = params.flatMap({ try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }),
                  let key = o["key"] as? String else { return print("zn nav: bad RESTORE params for \(entry)") }
            var values = entryValues[entry] ?? [:]
            if let v = o["value"] { values[key] = v } else { values.removeValue(forKey: key) }
            entryValues[entry] = values
        case NavKind.remove:
            stack.removeAll { $0 == entry }
            failedScreens[entry] = nil
            backWanted.remove(entry)
            releaseLater([entry])
        case NavKind.clear:
            for e in stack { failedScreens[e] = nil }
            releaseLater(stack)
            stack.removeAll()
        case NavKind.layer:
            // The layer's root from its template (entry = root id, route = template id); entry 0 removes it.
            let name = params.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }?["layer"] as? String
            guard let name, name == Self.layerTop || name == Self.layerOverlay else {
                return print("zn nav: unknown layer \(params ?? "")")
            }
            if let old = layers.removeValue(forKey: name) {
                ZnPopups.shared.closeEntries([old], why: "app layer \(name) replaced")
                store.removeTree(old)
            }
            guard entry != 0 else { return }
            guard let t = ctx.templates[safe: route] else { return print("zn nav: layer \(name) has no template \(route)") }
            store.mountRoot(id: entry, templateId: route, template: t)
            layers[name] = entry
        case NavKind.backWanted:
            if route != 0, stack.contains(entry) { backWanted.insert(entry) } else { backWanted.remove(entry) }
            print("zn t=\(ZnDebug.ms()) nav: screens that want Back first: \(backWanted.sorted())")
        case NavKind.failed:
            // The screen's JS threw while building it: it stays and shows the error screen.
            guard stack.contains(entry) else { return }
            let o = params.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
            failedScreens[entry] = o?["message"] as? String ?? ""
            print("zn t=\(ZnDebug.ms()) nav: screen \(entry) failed: \(failedScreens[entry] ?? "")")
        case NavKind.started:
            firstScreensUp = true  // JS handled START: the splash may go (ZnSplash)
            ZnOta.screensUp()  // a downloaded bundle's healthy clock starts
            print("zn t=\(ZnDebug.ms()) nav: first screens up\(ZnDebug.sinceStart())")
        default:
            break  // BACK_ANSWERED, …: not needed by the spike
        }
    }

    /// A screen leaving keeps its instances until its transition has played (spike: a fixed delay).
    private func releaseLater(_ entries: [UInt32]) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self else { return }
            for e in entries where !self.stack.contains(e) {
                self.store.removeTree(e)
                self.entryRoutes[e] = nil
                self.entryParams[e] = nil
                self.entryValues[e] = nil
            }
        }
    }

    /// "Try again" on a failed screen: drop what the failed build left under its root, make a fresh root from the
    /// template, and ask JS to build the screen again (RETRY).
    func retry(_ entry: UInt32) {
        guard stack.contains(entry), failedScreens.removeValue(forKey: entry) != nil, let ctx,
              let route = entryRoutes[entry], route.native == nil, let t = ctx.templates[safe: route.screen] else { return }
        store.removeTree(entry)
        store.mountRoot(id: entry, templateId: route.screen, template: t)
        print("zn t=\(ZnDebug.ms()) nav: RETRY \(entry)")
        host.dispatchEvent(0, event: UInt16(ZnAppEvent.retry), number: Double(entry))
    }

    /// The host changed the stack by itself (a finished swipe back): JS hears FORCED_BACK for each entry it lost.
    func nativeChanged(to shown: [UInt32]) {
        let removed = stack.filter { !shown.contains($0) }
        print("zn nav: native shows \(shown), JS had \(stack); FORCED_BACK for \(removed)")
        guard !removed.isEmpty else { return }
        stack = stack.filter { shown.contains($0) }
        ZnPopups.shared.closeEntries(Set(removed), why: "swiped back")
        for e in removed { backWanted.remove(e); failedScreens[e] = nil }
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

    /// main.zn.ui.json, parsed once: its routes (ZnRoutes.read) and the whole object (the font table reads "fonts").
    private static func readManifest(_ url: URL) throws -> (routes: [ZnRoute], json: [String: Any]) {
        let json = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        guard let json, let routes = (json["routes"] as? [[String: Any]])?.map(ZnRoute.init(json:)) else {
            throw ZnFormatError("main.zn.ui.json has no routes")
        }
        return (routes, json)
    }
}

/// The SwiftUI variant's root view (ZN_IOS_NAV=swiftui): the back stack as a NavigationStack.
struct ZnRootView: View {
    let app: ZnApp

    var body: some View {
        if let failure = app.failure {
            ZnErrorScreenView(message: failure, startFailed: true, canGoBack: false, onRetry: {}, onBack: {})
        } else if app.ctx != nil, !app.stack.isEmpty {
            ZnNavSwiftUI(app: app, stack: app.stack)  // the comparison variant; UIKit is ZnNavController
        } else {
            Color.white
        }
    }
}
