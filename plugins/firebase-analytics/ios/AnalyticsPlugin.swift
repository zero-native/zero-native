// The Analytics plugin's iOS side (plugins/firebase-analytics, as android/.../AnalyticsPlugin.kt and AnalyticsRules.kt): RN
// Firebase's `analytics()` calls, Google Analytics' limits checked before Firebase sees a call (a bad name answers its
// reason, "" when sent), a `screen_view` for each top route, and `zn_bundle` on every event.
// With Firebase off the module still answers (status available false; calls do nothing).
//
// iOS differences:
// - Firebase's own screen views would name UIKit classes (the whole app is a few view controllers), so the app turns
//   them off with FirebaseAutomaticScreenReportingEnabled = NO in its Info.plist (the sample does); this plugin sends
//   the route names instead, as on Android.
// - Linked without Analytics' IDFA part (no tracking prompt): no advertising id is collected.
// - No OTA yet: zn_bundle is "built-in".
import Foundation
#if SWIFT_PACKAGE
import ZnRuntime
import ZnPluginFirebaseApp
#endif
// In the Swift package the SDK is a declared dependency (ios/packages/firebase/Package.swift): without it, stop the build
// instead of building a plugin that quietly does nothing. The CMake builds may leave the SDK out on purpose.
#if SWIFT_PACKAGE && !(canImport(FirebaseAnalytics))
#error("ZnPluginFirebaseAnalytics needs FirebaseAnalytics: check ios/packages/firebase/Package.swift")
#endif
#if canImport(FirebaseAnalytics)
import FirebaseAnalytics
#endif

/// Google Analytics' limits (AnalyticsRules.kt).
enum AnalyticsRules {
    static let maxName = 40, maxParams = 25, maxString = 100, maxPropertyName = 24, maxPropertyValue = 36
    static let maxUserId = 256, maxItems = 200
    static let items = "items"
    static let paramBundle = "zn_bundle"
    private static let reservedPrefixes = ["firebase_", "google_", "ga_"]
    private static let reservedEvents: Set<String> = [
        "ad_activeview", "ad_click", "ad_exposure", "ad_query", "ad_reward", "adunit_exposure", "app_background",
        "app_clear_data", "app_exception", "app_remove", "app_store_refund", "app_store_subscription_cancel",
        "app_store_subscription_convert", "app_store_subscription_renew", "app_upgrade", "app_update", "error",
        "first_open", "first_visit", "in_app_purchase", "notification_dismiss", "notification_foreground",
        "notification_open", "notification_receive", "os_update", "session_start", "session_start_with_rollout",
        "user_engagement",
    ]
    private static let reservedProperties: Set<String> = ["first_open_after_install", "first_open_time", "first_visit_time", "last_deep_link_referrer", "user_id"]

    static func eventNameProblem(_ name: String) -> String? {
        nameProblem("event name", name, maxName) ?? (reservedEvents.contains(name) ? "event name \"\(name)\" is Firebase's own" : nil)
    }

    static func propertyNameProblem(_ name: String) -> String? {
        nameProblem("user property name", name, maxPropertyName)
            ?? (reservedProperties.contains(name) ? "user property name \"\(name)\" is Firebase's own" : nil)
    }

    static func userIdProblem(_ id: String) -> String? { id.count > maxUserId ? "user id is longer than \(maxUserId) characters" : nil }

    static func propertyValue(_ v: String) -> String { String(v.prefix(maxPropertyValue)) }

    /// Checks and converts: strings cut to 100, booleans to 1 / 0, nulls left out; only "items" can be a list.
    static func params(_ raw: [String: Any], allowItems: Bool = true) -> (values: [String: Any], problem: String?) {
        var out: [String: Any] = [:]
        for key in raw.keys.sorted() {
            if let p = nameProblem("parameter name", key, maxName) { return ([:], p) }
            let value = raw[key]!
            if value is NSNull { continue }
            if let list = value as? [Any] {
                guard allowItems && key == items else { return ([:], "parameter \"\(key)\" is a list: only \"\(items)\" can be one") }
                guard list.count <= maxItems else { return ([:], "\"\(items)\" has more than \(maxItems) entries") }
                var converted: [[String: Any]] = []
                for item in list {
                    guard let map = item as? [String: Any] else { return ([:], "each entry of \"\(items)\" must be an object") }
                    let p = params(map, allowItems: false)
                    if let problem = p.problem { return ([:], "in \"\(items)\": \(problem)") }
                    converted.append(p.values)
                }
                out[key] = converted
                continue
            }
            guard let v = scalar(value) else { return ([:], "parameter \"\(key)\" must be a string, a finite number or a boolean") }
            out[key] = v
        }
        if out.count > maxParams { return ([:], "more than \(maxParams) parameters") }
        return (out, nil)
    }

    private static func scalar(_ v: Any) -> Any? {
        if let s = v as? String { return String(s.prefix(maxString)) }
        guard let n = v as? NSNumber else { return nil }
        if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? 1 : 0 }
        let d = n.doubleValue
        guard d.isFinite else { return nil }
        return d == d.rounded() && abs(d) < 9e15 ? Int(d) : d
    }

    private static func nameProblem(_ what: String, _ name: String, _ max: Int) -> String? {
        if name.isEmpty { return "\(what) is empty" }
        if name.count > max { return "\(what) \"\(name)\" is longer than \(max) characters" }
        if name.range(of: "^[A-Za-z][A-Za-z0-9_]*$", options: .regularExpression) == nil {
            return "\(what) \"\(name)\" must start with a letter and have only letters, digits and _"
        }
        if reservedPrefixes.contains(where: name.hasPrefix) { return "\(what) \"\(name)\" starts with a prefix Firebase keeps for itself" }
        return nil
    }
}

/// Add it with `ZnPlugins.register(..., AnalyticsPlugin())`. `screenName` renames a route or leaves it out (nil).
public struct AnalyticsPlugin: ZnPlugin {
    public init(screenViews: Bool = true, screenName: @escaping (String) -> String? = { $0 }, bundleParam: Bool = true) {
        self.screenViews = screenViews
        self.screenName = screenName
        self.bundleParam = bundleParam
    }

    public var screenViews = true
    public var screenName: (String) -> String? = { $0 }
    public var bundleParam = true

    public func register(_ r: ZnPluginRegistry) {
        r.requireHostApi(8)
        let on = ZnFirebase.start()
        let module = AnalyticsModule(on: on)
        r.module(module)
        #if canImport(FirebaseAnalytics)
        guard on else { return }
        if bundleParam { module.setBundle("built-in") }
        if screenViews {
            let rename = screenName
            ZnApp.shared.addTopRouteListener { route in
                guard let route, let name = rename(route) else { return }  // before the first screen, or left out
                let n = String(name.prefix(AnalyticsRules.maxString))
                Analytics.logEvent(AnalyticsEventScreenView, parameters: [AnalyticsParameterScreenName: n, AnalyticsParameterScreenClass: n])
            }
        }
        #endif
    }
}

final class AnalyticsModule: ZnModuleBase, @unchecked Sendable {
    private let on: Bool
    /// Kept so the app's setDefaultEventParameters(null) doesn't clear it.
    private var bundle: String?

    init(on: Bool) {
        self.on = on
        super.init("FirebaseAnalytics", version: 1)
        function("status") { call in call.resolve(["available": on]) }
        function("setCollectionEnabled") { call in
            guard let enabled = call.args["on"] as? Bool else { throw ZnInvalidArgs("\"on\" must be a boolean") }
            #if canImport(FirebaseAnalytics)
            if on { Analytics.setAnalyticsCollectionEnabled(enabled) }
            #endif
            call.resolve(on)
        }
        function("setConsent") { call in
            guard on else { return call.resolve(false) }
            #if canImport(FirebaseAnalytics)
            var map: [ConsentType: ConsentStatus] = [:]
            func put(_ arg: String, _ type: ConsentType) {
                if let b = call.args[arg] as? Bool { map[type] = b ? .granted : .denied }
            }
            put("analyticsStorage", .analyticsStorage)
            put("adStorage", .adStorage)
            put("adUserData", .adUserData)
            put("adPersonalization", .adPersonalization)
            Analytics.setConsent(map)
            #endif
            call.resolve(true)
        }
        function("logEvent") { call in
            guard let name = call.args["name"] as? String else { throw ZnInvalidArgs("\"name\" must be a string") }
            if let problem = AnalyticsRules.eventNameProblem(name) { return self.refuse(call, problem) }
            let p = AnalyticsRules.params(call.args["params"] as? [String: Any] ?? [:])
            if let problem = p.problem { return self.refuse(call, "\(name): \(problem)") }
            #if canImport(FirebaseAnalytics)
            if on { Analytics.logEvent(name, parameters: p.values) }
            #endif
            call.resolve("")
        }
        function("setUserId") { call in
            let id = call.args["id"] as? String
            if let id, let problem = AnalyticsRules.userIdProblem(id) { return self.refuse(call, problem) }
            #if canImport(FirebaseAnalytics)
            if on { Analytics.setUserID(id?.isEmpty == false ? id : nil) }
            #endif
            call.resolve("")
        }
        function("setUserProperty") { call in
            guard let name = call.args["name"] as? String else { throw ZnInvalidArgs("\"name\" must be a string") }
            if let problem = AnalyticsRules.propertyNameProblem(name) { return self.refuse(call, problem) }
            #if canImport(FirebaseAnalytics)
            if on { Analytics.setUserProperty((call.args["value"] as? String).map(AnalyticsRules.propertyValue), forName: name) }
            #endif
            call.resolve("")
        }
        function("setUserProperties") { call in
            let values = call.args["values"] as? [String: Any] ?? [:]
            for name in values.keys { if let p = AnalyticsRules.propertyNameProblem(name) { return self.refuse(call, p) } }
            #if canImport(FirebaseAnalytics)
            if on {
                for (name, v) in values {
                    let s: String? = v is NSNull ? nil : (v as? String ?? "\(v)")
                    Analytics.setUserProperty(s.map(AnalyticsRules.propertyValue), forName: name)
                }
            }
            #endif
            call.resolve("")
        }
        function("setDefaultEventParameters") { call in
            guard let raw = call.args["params"] as? [String: Any] else {
                #if canImport(FirebaseAnalytics)
                if on { Analytics.setDefaultEventParameters(nil) }
                #endif
                if let b = self.bundle { self.setBundle(b) }
                return call.resolve("")
            }
            let p = AnalyticsRules.params(raw, allowItems: false)
            if let problem = p.problem { return self.refuse(call, problem) }
            #if canImport(FirebaseAnalytics)
            if on { Analytics.setDefaultEventParameters(p.values) }
            #endif
            call.resolve("")
        }
        function("getAppInstanceId") { call in
            #if canImport(FirebaseAnalytics)
            call.resolve(on ? Analytics.appInstanceID() : nil)
            #else
            call.resolve(nil)
            #endif
        }
        function("resetAnalyticsData") { call in
            #if canImport(FirebaseAnalytics)
            if on { Analytics.resetAnalyticsData() }
            #endif
            call.resolve(on)
        }
        function("setSessionTimeoutDuration") { call in
            #if canImport(FirebaseAnalytics)
            if on, let ms = call.args["ms"] as? Double { Analytics.setSessionTimeoutInterval(ms / 1000) }
            #endif
            call.resolve(on)
        }
    }

    func setBundle(_ label: String) {
        bundle = label
        #if canImport(FirebaseAnalytics)
        if on { Analytics.setDefaultEventParameters([AnalyticsRules.paramBundle: String(label.prefix(AnalyticsRules.maxString))]) }
        #endif
    }

    private func refuse(_ call: ZnCall, _ problem: String) {
        print("zn-analytics: \(problem)")
        call.resolve(problem)
    }
}
