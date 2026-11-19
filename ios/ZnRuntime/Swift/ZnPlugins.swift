// Plugins on iOS (docs/plugins.md), as android/runtime's ZnPlugins.kt, ZnNativeScreens.kt, ZnNativeViews.kt: a plugin
// is one Swift type the app turns on with one line, `ZnPlugins.register(ScannerPlugin())`, before ZnApp.start. In
// `register` it adds native modules, native screens (a route with `native: "<plugin>.<name>"`) and native views
// (`<NativeView name="<plugin>.<name>">`).
// - A screen is a UIViewController made for its back-stack entry. It gets the route's params, and closes with
//   `finish(value)` (nav.pushForResult's answer, or onNavResult after a kill) or `cancel()` (as Back). Only the first
//   answer counts. Its answer is saved in the "zn.launch" store before JS hears of it (ZnLaunch.saveScreenResult), so a
//   kill between the two loses nothing; JS acks it through the Launches module.
// - A view is a UIView made for its node. It gets the props JS gave (again on each change, `onProps`) and sends
//   `emit(name, data)` to `<NativeView onEvent>`.
// A plugin is added whole or not at all: one that fails stops a debug build, and a release build skips it (calls to its
// module then answer "unavailable").
// iOS differences: a view hears its screen covered or closed through its own window / superview changes (UIKit's
// didMoveToWindow), not a lifecycle owner. Activity events (new intents, front / back) are ZnSystemEvents' (app state).
import SwiftUI
import UIKit
#if SWIFT_PACKAGE
@_exported import ZnHost  // plugins that use ZNHost get it from ZnRuntime
#endif

public protocol ZnPlugin {
    /// Called once, on the main thread, before the app starts. Only declare things here: no I/O, no slow work.
    @MainActor func register(_ r: ZnPluginRegistry)
}

/// What a plugin's screen gets.
@MainActor
public final class ZnScreenScope {
    public let entry: UInt32
    /// The route's params.
    public let params: [String: Any]
    private var answered = false

    init(entry: UInt32, params: [String: Any]) {
        self.entry = entry
        self.params = params
    }

    /// Closes the screen with [value] (a JSON object): `nav.pushForResult` or `onNavResult` gets it. Only the first answer
    /// counts (a double scan is dropped).
    public func finish(_ value: [String: Any]) {
        guard !answered else { return }
        answered = true
        ZnApp.shared.answer(entry: entry, value: ZnModules.json(value) ?? "null")
    }

    /// Closes the screen with no answer: the same as Back.
    public func cancel() {
        guard !answered else { return }
        answered = true
        ZnApp.shared.systemBack()
    }
}

/// What a plugin's view gets.
@MainActor
public final class ZnViewScope {
    public let id: String
    /// The `props` JS gave. `onProps` runs after each change.
    public private(set) var props: [String: Any]
    public var onProps: (([String: Any]) -> Void)?
    fileprivate let send: (String) -> Void

    init(id: String, props: [String: Any], send: @escaping (String) -> Void) {
        self.id = id
        self.props = props
        self.send = send
    }

    fileprivate func update(_ p: [String: Any]) {
        props = p
        onProps?(p)
    }

    /// Sends JS `{ name, data }`: `<NativeView onEvent>` hears it. [data]: anything JSON can hold.
    public func emit(_ name: String, _ data: Any? = nil) {
        if let json = ZnModules.json(["name": name, "data": data ?? NSNull()]) { send(json) }
    }
}

public typealias ZnScreenContent = @MainActor (ZnScreenScope) -> UIViewController
public typealias ZnViewContent = @MainActor (ZnViewScope) -> UIView

/// What a plugin adds, in register. Anything wrong throws, and ZnPlugins.register handles it.
@MainActor
public final class ZnPluginRegistry {
    fileprivate var modules: [ZnModule] = []
    fileprivate var screens: [String: ZnScreenContent] = [:]
    fileprivate var views: [String: ZnViewContent] = [:]
    fileprivate var failure: String?

    /// Adds a native module. Its name must be free: a plugin can't replace a built-in module or another plugin's.
    public func module(_ m: ZnModule) {
        if ZnModules.has(m.name) || modules.contains(where: { $0.name == m.name }) {
            failure = failure ?? "the native module name \"\(m.name)\" is already taken"
        }
        modules.append(m)
    }

    /// Adds a native screen, which a route opens with `native: "<plugin>.<name>"`.
    public func screen(_ name: String, _ content: @escaping ZnScreenContent) {
        if ZnPlugins.screens[name] != nil || screens[name] != nil { failure = failure ?? "the native screen name \"\(name)\" is already taken" }
        screens[name] = content
    }

    /// Adds a view, which a screen shows with `<NativeView name="<plugin>.<name>" />`.
    public func view(_ name: String, _ content: @escaping ZnViewContent) {
        if ZnPlugins.views[name] != nil || views[name] != nil { failure = failure ?? "the native view name \"\(name)\" is already taken" }
        views[name] = content
    }

    /// This plugin needs at least this host API.
    public func requireHostApi(_ version: Int) {
        if version > ZnPlugins.hostApi { failure = failure ?? "it needs host API v\(version); this app has v\(ZnPlugins.hostApi)" }
    }
}

@MainActor
public enum ZnPlugins {
    /// The host API of this runtime (kHostApiVersion in core/include/zn/engine.h).
    public static let hostApi = 9
    fileprivate(set) static var screens: [String: ZnScreenContent] = [:]
    fileprivate(set) static var views: [String: ZnViewContent] = [:]

    public static func register(_ plugins: ZnPlugin...) {
        for plugin in plugins {
            let r = ZnPluginRegistry()
            plugin.register(r)
            if let failure = r.failure {
                let message = "plugin \(type(of: plugin)) failed: \(failure)"
                #if DEBUG
                fatalError(message)
                #else
                print("zn: \(message); skipped")
                continue
                #endif
            }
            r.modules.forEach(ZnModules.register)
            screens.merge(r.screens) { a, _ in a }
            views.merge(r.views) { a, _ in a }
            print("zn: plugin \(type(of: plugin)): \(r.modules.count) module(s), \(r.screens.count) screen(s), \(r.views.count) view(s)")
        }
    }
}

// MARK: - Native screens

/// A native route's screen in the back stack: the plugin's view controller as a child, with the route's safe area.
final class ZnNativeScreenController: UIViewController {
    let content: UIViewController

    init(_ content: UIViewController) {
        self.content = content
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = content.view.backgroundColor ?? .white
        addChild(content)
        view.addSubview(content.view)
        content.view.frame = view.bounds
        content.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        content.didMove(toParent: self)
    }
}

extension ZnApp {
    /// The view controller for native route [name], or a plain one that says what is missing (the build checks a
    /// screen's plugin, so this is a bundle on an app without it).
    func nativeScreen(_ name: String, entry: UInt32, params: String?) -> UIViewController {
        let p = params.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
        guard let content = ZnPlugins.screens[name] else {
            print("zn: no native screen \"\(name)\": is its plugin registered?")
            let vc = UIViewController()
            vc.view.backgroundColor = .white
            return vc
        }
        return ZnNativeScreenController(content(ZnScreenScope(entry: entry, params: p)))
    }
}

// MARK: - Native views

/// `<NativeView name props onEvent>`: the plugin's UIView, sized by the node's style.
struct ZnNativeViewNode: UIViewRepresentable {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let props: String?

    final class Coordinator {
        var scope: ZnViewScope?
        var raw: String?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    private static func parse(_ name: String, _ raw: String?) -> [String: Any] {
        guard let raw else { return [:] }
        guard let o = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any] else {
            print("zn: native view \"\(name)\": props must be an object")
            return [:]
        }
        return o
    }

    func makeUIView(context: Context) -> UIView {
        let name = s.viewName ?? ""
        guard let content = ZnPlugins.views[name] else {
            print("zn: no native view \"\(name)\": is its plugin registered?")
            return UIView()
        }
        let (ctx, id, event) = (ctx, inst.id, s.onNativeEvent)
        let scope = ZnViewScope(id: "\(inst.id).\(s.index)", props: Self.parse(name, props)) { payload in
            if event != 0 { ctx.send(id, event, .string(payload)) }
        }
        context.coordinator.scope = scope
        context.coordinator.raw = props
        return content(scope)
    }

    func updateUIView(_ v: UIView, context: Context) {
        let c = context.coordinator
        guard c.raw != props, let scope = c.scope else { return }
        c.raw = props
        scope.update(Self.parse(s.viewName ?? "", props))
    }
}

// MARK: - Launches (ZnLaunch.kt): the store native screens answer through

/// The "Launches" module: records of results JS hasn't acted on yet, in the "zn.launch" store (key
/// "launch.record.<key>"). On iOS: native screens' answers, `ack`, and launches a plugin starts itself (`start` and
/// `finish`: the document scanner's camera; ZnLaunch.kt's start and onResult). Opening another app for a result (UPI)
/// comes back by URL, not here.
public final class ZnLaunch: ZnModuleBase, @unchecked Sendable {
    static let store = "zn.launch"
    static let record = "launch.record."
    static let current = "launch.current"

    init() {
        super.init("Launches", version: 1)
        // A launch still "waiting" from an earlier run never got its answer (the app was killed while it was open): JS
        // hears "lost", as on Android.
        if let key = ZNStorage.string(Self.store, key: Self.current), var rec = Self.read(key), rec["status"] as? String == "waiting" {
            rec["status"] = "lost"
            Self.write(key, rec)
            print("zn: launch \(key) was open when the app ended: lost")
        }
        // Only the id it answers clears a record, so an old screen can't clear a new payment; a waiting one has nothing
        // to confirm.
        function("ack", onMain: true) { call in
            let key = try call.string("key"), id = try call.string("id")
            let ok: Bool = MainActor.assumeIsolated {
                guard let raw = ZNStorage.string(Self.store, key: Self.record + key),
                      let rec = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any],
                      rec["id"] as? String == id, rec["status"] as? String != "waiting" else { return false }
                ZNStorage.remove(Self.store, key: Self.record + key)
                if ZNStorage.string(Self.store, key: Self.current) == key { ZNStorage.remove(Self.store, key: Self.current) }
                ZNStorage.flush(Self.store)
                return true
            }
            call.resolve(ok)
        }
    }

    private static func read(_ key: String) -> [String: Any]? {
        ZNStorage.string(store, key: record + key).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
    }

    private static func write(_ key: String, _ rec: [String: Any]) {
        guard let json = ZnModules.json(rec) else { return }
        ZNStorage.set(store, key: record + key, string: json)
        ZNStorage.flush(store)
    }

    /// A launch is open: another app or a native screen will answer it (an update must not replace the JS meanwhile).
    @MainActor static var isWaiting: Bool {
        guard let open = ZNStorage.string(store, key: current) else { return false }
        return read(open)?["status"] as? String == "waiting"
    }

    /// Starts a launch of [key] with [id]: its "waiting" record is on disk before anything opens. Refused with "busy"
    /// while another launch is open, and "unacked" while this key has an answer JS hasn't acked (ZnLaunch.kt's rules).
    @MainActor public static func start(_ key: String, id: String) -> (launched: Bool, reason: String?) {
        if let open = ZNStorage.string(store, key: current), read(open)?["status"] as? String == "waiting" { return (false, "busy") }
        if read(key) != nil { return (false, "unacked") }
        write(key, ["key": key, "id": id, "status": "waiting"])
        ZNStorage.set(store, key: current, string: key)
        ZNStorage.flush(store)
        return (true, nil)
    }

    /// The launch's answer: on disk, then JS's `launches.onResult` hears it. Only the open launch with this id; the first
    /// answer wins. [resultCode]: -1 OK, 0 cancelled (Android's codes, which JS reads).
    @MainActor public static func finish(_ key: String, id: String, resultCode: Int, data: String? = nil, extras: [String: Any] = [:]) {
        guard let rec = read(key), rec["id"] as? String == id, rec["status"] as? String == "waiting" else { return }
        let done: [String: Any] = ["key": key, "id": id, "status": "result", "resultCode": resultCode, "data": data ?? NSNull(), "extras": extras]
        write(key, done)
        ZnModules.emit("Launches", "result", done, latestOnly: false)
    }

    // MARK: Opening another app by its link (UPI apps): iOS gives no result back

    /// The launch waiting for the user to come back from the app it opened. Main thread.
    @MainActor private static var away: (key: String, id: String, left: Bool, link: String?)?
    @MainActor private static var watching = false

    /// Opens [url] (another app's link, as `upi://pay?…`) as a launch of [key] / [id]. iOS has no result Intent: when the
    /// user comes back the launch ends with resultCode -1 and `data` = the link the other app opened to come back, if it
    /// did, else resultCode 0 and no data (`extras.returned` true either way). Either way JS asks its server what
    /// happened; a kill in between is "lost" at the next start. [done]: (launched, reason): "busy", "unacked", "no_app".
    @MainActor public static func open(_ key: String, id: String, url: URL, done: @escaping (Bool, String?) -> Void) {
        let started = start(key, id: id)
        guard started.launched else { return done(false, started.reason) }
        watch()
        // Before open: iOS calls its completion after the app has already left (willResignActive came first).
        away = (key, id, false, nil)
        UIApplication.shared.open(url, options: [:]) { ok in
            guard ok else {
                away = nil
                // Nothing opened: no record is left behind, as Android's refused launch.
                ZNStorage.remove(store, key: record + key)
                if ZNStorage.string(store, key: current) == key { ZNStorage.remove(store, key: current) }
                ZNStorage.flush(store)
                return done(false, "no_app")
            }
            done(true, nil)
        }
    }

    /// A link that came in (ZnApp.openLink): the other app's way back. Kept for the waiting launch.
    @MainActor static func noteLink(_ url: URL) {
        if away != nil { away?.link = url.absoluteString }
    }

    @MainActor private static func watch() {
        guard !watching else { return }
        watching = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { if away != nil { away?.left = true } }
        }
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                guard let a = away, a.left else { return }
                // The link back (if any) can come just after the app is active again: give it a moment.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                    guard let a = away, a.left else { return }
                    away = nil
                    print("zn: launch \(a.key) came back \(a.link != nil ? "by a link" : "with no link")")
                    finish(a.key, id: a.id, resultCode: a.link != nil ? -1 : 0, data: a.link, extras: ["returned": true])
                }
            }
        }
    }

    /// A native screen's answer, on disk before JS hears of it.
    @MainActor static func saveScreenResult(_ key: String, id: String, value: String) {
        let rec: [String: Any] = ["key": key, "id": id, "status": "result", "resultCode": -1, "data": NSNull(), "extras": ["value": value]]
        guard let json = ZnModules.json(rec) else { return }
        ZNStorage.set(store, key: record + key, string: json)
        ZNStorage.flush(store)
    }
}
