// The Crashlytics plugin's iOS side (plugins/firebase-crashlytics, as android/.../CrashlyticsPlugin.kt, CrashlyticsModule.kt and
// CrashlyticsRules.kt). By itself it sends:
// - native crashes (Crashlytics' own handlers: Swift, Objective-C and C++ crashes, signals),
// - every JS error as a non-fatal, with its JS frames as the stack (issues group by JS function, like Android) and the
//   full JS stack with columns as a log line,
// - keys on every report: the bundle, host API, the top route; each screen change as a log line.
// With Firebase off (no SDK or no GoogleService-Info.plist) the module still answers: every call does nothing, and
// `status` says available false.
//
// iOS differences: no OTA yet, so the bundle key is "built-in". `crash("native")` and `crash("kotlin")` both crash the
// process (iOS has no Kotlin; Crashlytics catches both). Release builds need their dSYMs uploaded for native stacks
// (ios/third_party/firebase/FirebaseCrashlytics/upload-symbols); JS stacks don't need them.
import Foundation
#if SWIFT_PACKAGE
import ZnRuntime
import ZnPluginFirebaseApp
#endif
// In the Swift package the SDK is a declared dependency (ios/ExtrasPackage/Package.swift): without it, stop the build
// instead of building a plugin that quietly does nothing. The CMake builds may leave the SDK out on purpose.
#if SWIFT_PACKAGE && !(canImport(FirebaseCrashlytics))
#error("ZnPluginFirebaseCrashlytics needs FirebaseCrashlytics: check ios/ExtrasPackage/Package.swift")
#endif
#if canImport(FirebaseCrashlytics)
import FirebaseCrashlytics
#endif

/// The plugin's choices with no iOS in them (CrashlyticsRules.kt).
enum CrashlyticsRules {
    static let keyBundle = "zn_bundle", keyBundleId = "zn_bundle_id", keyBuiltIn = "zn_built_in", keyHostApi = "zn_host_api"
    static let keyRoute = "zn_route", keyJsKind = "zn_js_kind"
    /** JS errors sent per process (an error in a loop would send hundreds). */
    static let maxJsErrors = 30
    static let maxLogChars = 4_000
    static let maxKeyChars = 1_024

    /// A recorded error's text: Hermes' stack starts with "Error: message" already.
    static func details(_ name: String?, _ message: String, _ stack: String?) -> String {
        let s = stack ?? ""
        if !s.isEmpty && s.contains(message) { return s }
        let head = (name ?? "").isEmpty ? message : "\(name!): \(message)"
        return s.isEmpty ? head : "\(head)\n\(s)"
    }

    static func routeLog(_ from: String?, _ to: String?) -> String { "nav: \(from ?? "-") -> \(to ?? "-")" }

    /// Hermes frames, `at fn (file:line:col)` or `at file:line:col`, as (function, file, line). Native frames are left out.
    static func frames(_ details: String) -> [(String, String, Int)] {
        let re = try! NSRegularExpression(pattern: #"^\s*at (?:(.+?) \()?([^\s()]+):(\d+):\d+\)?\s*$"#)
        return details.split(separator: "\n").compactMap { line in
            let s = String(line)
            guard let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) else { return nil }
            func g(_ i: Int) -> String? { Range(m.range(at: i), in: s).map { String(s[$0]) } }
            let file = (g(2) ?? "").split(separator: "/").last.map(String.init) ?? ""
            return ((g(1) ?? "").isEmpty ? "<anonymous>" : g(1)!, file, Int(g(3) ?? "") ?? 0)
        }
    }
}

/// Add it with `ZnPlugins.register(..., CrashlyticsPlugin())`, as early as the other plugins.
/// `redact`: runs on every text that goes to Crashlytics from JS (as on Android).
public struct CrashlyticsPlugin: ZnPlugin {
    public init(jsErrors: Bool = true, redact: ((String) -> String)? = nil) {
        self.jsErrors = jsErrors
        self.redact = redact
    }

    public var jsErrors = true
    public var redact: ((String) -> String)? = nil

    public func register(_ r: ZnPluginRegistry) {
        r.requireHostApi(8)
        let on = ZnFirebase.start()
        let module = CrashlyticsModule(on: on, redact: redact)
        r.module(module)  // also with Firebase off: bundles that use the plugin still run
        #if canImport(FirebaseCrashlytics)
        guard on else { return }
        let c = Crashlytics.crashlytics()
        c.setCustomValue(ZnPlugins.hostApi, forKey: CrashlyticsRules.keyHostApi)
        c.setCustomValue("built-in", forKey: CrashlyticsRules.keyBundle)
        c.setCustomValue("built-in", forKey: CrashlyticsRules.keyBundleId)
        c.setCustomValue(true, forKey: CrashlyticsRules.keyBuiltIn)
        let app = ZnApp.shared
        if jsErrors {
            var used = 0, dropped = 0
            app.addJsErrorListener { kind, whereText, details in
                guard used < CrashlyticsRules.maxJsErrors else {
                    dropped += 1
                    if dropped == 1 || dropped % 100 == 0 {
                        c.log("js: \(dropped) more JS errors not sent (limit \(CrashlyticsRules.maxJsErrors) per launch)")
                    }
                    return
                }
                used += 1
                module.record(kind: kind, whereText: whereText, details: module.clean(details), route: app.topRoute)
            }
        }
        var last: String?? = nil
        app.addTopRouteListener { name in
            defer { last = .some(name) }
            guard let previous = last else { return }  // the first value: nothing changed yet
            c.setCustomValue(name ?? "", forKey: CrashlyticsRules.keyRoute)
            c.log(CrashlyticsRules.routeLog(previous, name))
        }
        #endif
    }
}

final class CrashlyticsModule: ZnModuleBase, @unchecked Sendable {
    private let on: Bool
    private let redact: ((String) -> String)?

    init(on: Bool, redact: ((String) -> String)?) {
        self.on = on
        self.redact = redact
        super.init("FirebaseCrashlytics", version: 1)
        function("status") { call in call.resolve(self.status()) }
        function("setCollectionEnabled") { call in
            guard let enabled = call.args["on"] as? Bool else { throw ZnInvalidArgs("\"on\" must be a boolean") }
            #if canImport(FirebaseCrashlytics)
            if on { Crashlytics.crashlytics().setCrashlyticsCollectionEnabled(enabled) }
            #endif
            call.resolve(self.status())
        }
        function("log") { call in
            guard let message = call.args["message"] as? String else { throw ZnInvalidArgs("\"message\" must be a string") }
            #if canImport(FirebaseCrashlytics)
            if on { Crashlytics.crashlytics().log(self.clean(message)) }
            #endif
            call.resolve(true)
        }
        // On the main thread: it reads the top route.
        function("recordError", onMain: true) { call in
            guard let message = call.args["message"] as? String else { throw ZnInvalidArgs("\"message\" must be a string") }
            let details = CrashlyticsRules.details(call.args["name"] as? String, message, call.args["stack"] as? String)
            guard on else { return call.resolve(false) }
            let route = MainActor.assumeIsolated { ZnApp.shared.topRoute }
            self.record(kind: "recorded", whereText: call.args["tag"] as? String ?? "recordError", details: self.clean(details), route: route)
            call.resolve(true)
        }
        function("setAttribute") { call in
            guard let key = call.args["key"] as? String else { throw ZnInvalidArgs("\"key\" must be a string") }
            self.setKey(key, call.args["value"])
            call.resolve(true)
        }
        function("setAttributes") { call in
            for (k, v) in call.args["values"] as? [String: Any] ?? [:] { self.setKey(k, v) }
            call.resolve(true)
        }
        function("setUserId") { call in
            #if canImport(FirebaseCrashlytics)
            if on { Crashlytics.crashlytics().setUserID(String((call.args["id"] as? String ?? "").prefix(CrashlyticsRules.maxKeyChars))) }
            #endif
            call.resolve(true)
        }
        // A real crash, to test the setup. Answers first, then crashes on the main thread.
        function("crash") { call in
            call.resolve(true)
            print("zn-crashlytics: crash(\(call.args["kind"] as? String ?? "kotlin")) asked: the app will now crash on purpose")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { fatalError("Test crash from Crashlytics.crash()") }
        }
    }

    private func status() -> [String: Any] {
        #if canImport(FirebaseCrashlytics)
        return ["available": on, "enabled": on && Crashlytics.crashlytics().isCrashlyticsCollectionEnabled()]
        #else
        return ["available": false, "enabled": false]
        #endif
    }

    /// A JS error as a non-fatal: named after its first line, with the JS frames as its stack (Android's ZnJsException).
    func record(kind: String, whereText: String, details: String, route: String?) {
        #if canImport(FirebaseCrashlytics)
        guard on else { return }
        let c = Crashlytics.crashlytics()
        c.setCustomValue(kind, forKey: CrashlyticsRules.keyJsKind)
        c.log(String(details.prefix(CrashlyticsRules.maxLogChars)))  // the full JS stack, with columns
        let first = details.split(separator: "\n").first.map(String.init) ?? details
        let model = ExceptionModel(name: "JS error", reason: "[built-in] \(kind) in \(whereText): \(first)")
        model.stackTrace = CrashlyticsRules.frames(details).map { fn, file, line in
            StackFrame(symbol: fn, file: file, line: line)
        }
        c.record(exceptionModel: model)
        print("zn-crashlytics: JS error recorded (\(kind)\(route.map { ", on \($0)" } ?? ""))")
        #endif
    }

    private func setKey(_ key: String, _ raw: Any?) {
        #if canImport(FirebaseCrashlytics)
        guard on, !key.isEmpty, key.count <= CrashlyticsRules.maxKeyChars else { return }
        let c = Crashlytics.crashlytics()
        switch raw {
        case let s as String: c.setCustomValue(String(clean(s).prefix(CrashlyticsRules.maxKeyChars)), forKey: key)
        case let n as NSNumber: c.setCustomValue(n, forKey: key)
        default: print("zn-crashlytics: setAttribute(\"\(key)\"): only a string, number or boolean can be a key's value")
        }
        #endif
    }

    /// The app's redact, if any. If it throws, Swift has no catch for it, so redact must not trap.
    func clean(_ text: String) -> String { redact?(text) ?? text }
}
