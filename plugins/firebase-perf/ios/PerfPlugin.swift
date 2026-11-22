// The Performance plugin's iOS side (plugins/firebase-perf, as android/.../PerfPlugin.kt): RN Firebase's `perf()` custom
// traces, and by itself:
// - Firebase's own app start trace;
// - a network trace for every `fetch` (an observer on core's fetch, [network]); [url] decides the URL Firebase sees
//   (default: no query, no fragment, no user or password) or leaves a request out (nil);
// - a screen trace per top route, `screen_<route>`, with frames, slow frames and frozen frames ([screens]).
// Every trace the plugin makes carries `zn_bundle`, the running bundle. With Firebase off (no SDK or no
// GoogleService-Info.plist) the module still answers: every call does nothing, and `status` says available false.
//
// The rules with no Firebase in them are PerfRules.swift (tested on the Mac: ios/tests/perf).
//
// iOS differences:
// - Network traces: as Android (an OkHttp interceptor there, ZnFetch.addObserver here), an HTTPMetric per `fetch`
//   with `zn_bundle`, the method, the response code, the payload sizes and the content type. The response size is
//   the body received (unzipped); Android's is its Content-Length. A method Firebase doesn't know (PROPPATCH, REPORT)
//   gets no trace. A call that fails with no response stops with no code, which Firebase counts as a network error.
//   [automatic] (off by default; Android has nothing like it) turns on Firebase's own URLSession hooks as well:
//   every request (core's fetch again, images, OTA downloads, Firebase's own calls), the URL without query,
//   fragment, user and password, no `zn_bundle`. It also brings Firebase's view controller screen traces (the whole
//   app is one). Firebase reads that switch when it starts, so register this plugin before FirebaseAppPlugin and the
//   other Firebase plugins; registered later, the switch applies from the next start. An app that links the SDK and
//   never registers this plugin gets Firebase's hooks unless its Info.plist says
//   `firebase_performance_instrumentation_enabled` NO (the sample's does).
// - Frames are counted with a CADisplayLink (as Firebase iOS does). It ticks at every screen refresh, drawn or not,
//   so `frames` counts refreshes (about 60 a second on a still screen; Android counts only drawn frames), and it keeps
//   the screen from slowing its refresh while the app is in front (`screens: false` stops it). Slow is under 59 a
//   second, so a ProMotion frame that misses 120 Hz is not slow; a frozen frame is not also slow, as on Android.
import Foundation
import QuartzCore
import UIKit
#if SWIFT_PACKAGE
import ZnRuntime
import ZnPluginFirebaseApp
#endif
// In the Swift package the SDK is a declared dependency (ios/packages/firebase/Package.swift): without it, stop the build
// instead of building a plugin that quietly does nothing. The CMake builds may leave the SDK out on purpose.
#if SWIFT_PACKAGE && !(canImport(FirebasePerformance))
#error("ZnPluginFirebasePerf needs FirebasePerformance: check ios/packages/firebase/Package.swift")
#endif
#if canImport(FirebasePerformance)
import FirebaseCore
import FirebasePerformance
#endif

/// Add it with `ZnPlugins.register(PerfPlugin(), FirebaseAppPlugin(), ...)`: before FirebaseAppPlugin and the other
/// Firebase plugins (see [automatic]).
/// `network` / `url`: a trace for every `fetch` and the URL Firebase sees (url nil: no query, no fragment; url answers
/// nil: that request isn't traced), as on Android. Register it before the first fetch.
/// `screens`: a trace per route.
/// `automatic`: Firebase's own network traces (every URLSession request) and view controller screen traces. iOS only.
public struct PerfPlugin: ZnPlugin {
    public init(network: Bool = true, url: ((URL) -> String?)? = nil, screens: Bool = true, automatic: Bool = false) {
        self.network = network
        self.url = url
        self.screens = screens
        self.automatic = automatic
    }

    public var network = true
    public var url: ((URL) -> String?)?
    public var screens = true
    public var automatic = false

    public func register(_ r: ZnPluginRegistry) {
        r.requireHostApi(8)
        #if canImport(FirebasePerformance)
        let hasConfig = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil
        if hasConfig {
            // Before Firebase starts: it hooks URLSession and UIKit when it starts, or not at all. The switch is kept on
            // the phone, so it is set every start (an earlier build may have changed it). Firebase's getter says true
            // once it has hooked in.
            let perf = Performance.sharedInstance()
            if perf.isInstrumentationEnabled != automatic {
                if FirebaseApp.app() != nil {
                    print("zn-perf: Firebase started before PerfPlugin registered: automatic: \(automatic) applies from the next start")
                }
                perf.isInstrumentationEnabled = automatic
            }
        }
        #endif
        let on = ZnFirebase.start()
        r.module(PerfModule(on: on))  // also with Firebase off: bundles that use the plugin still run
        guard on else {
            print("zn-perf: Firebase isn't set up in this app, so Performance is off")
            return
        }
        #if canImport(FirebasePerformance)
        if network { ZnFetch.addObserver(NetworkTraces.observer(url)) }
        let traces = screens ? ScreenTraces() : nil
        ZnBundles.watchRunning { label in
            PerfState.bundle = PerfRules.attributeValue(label)
            traces?.bundleKnown()  // the first screen can come before the label does
        }
        if let traces { ZnApp.shared.addTopRouteListener { traces.next($0) } }
        #endif
    }
}

/// The running bundle's label, for every trace's `zn_bundle` (any thread).
enum PerfState {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var value: String?
    static var bundle: String? {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

#if canImport(FirebasePerformance)
/// One HTTPMetric per call of core's fetch (Android's NetworkTraces interceptor). The start runs on the calling
/// thread, the end on fetch's queue; an HTTPMetric takes both.
private enum NetworkTraces {
    static func observer(_ url: ((URL) -> String?)?) -> ZnFetchObserver {
        { start in
            guard let traced = PerfRules.traceUrl(start.url, url), let m = PerfRules.httpMethod(start.method),
                  let method = HTTPMethod(rawValue: m), let metric = HTTPMetric(url: traced, httpMethod: method) else { return nil }
            if let b = PerfState.bundle { metric.setValue(b, forAttribute: PerfRules.attrBundle) }
            metric.start()
            return { end in
                if let n = end.requestBytes { metric.requestPayloadSize = Int(n) }
                if let status = end.status { metric.responseCode = status }  // none: Firebase counts a network error
                if let n = end.responseBytes { metric.responsePayloadSize = Int(n) }
                if let type = end.contentType { metric.responseContentType = type }
                metric.stop()
            }
        }
    }
}

/// A trace per top route: from the route coming on top to leaving it, with the frames drawn meanwhile. Main thread.
private final class ScreenTraces: NSObject {
    private var total: Int64 = 0, slow: Int64 = 0, frozen: Int64 = 0
    private var current: Trace?
    private var labelled = false  // the current trace has its zn_bundle
    private var link: CADisplayLink?
    private var last: CFTimeInterval = 0

    override init() {
        super.init()
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        nc.addObserver(self, selector: #selector(foreground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    func next(_ route: String?) {
        if let t = current {
            t.setValue(total, forMetric: PerfRules.metricFrames)
            t.setValue(slow, forMetric: PerfRules.metricSlow)
            t.setValue(frozen, forMetric: PerfRules.metricFrozen)
            t.stop()
        }
        current = nil
        total = 0; slow = 0; frozen = 0
        guard let route, let t = Performance.sharedInstance().trace(name: PerfRules.screenTrace(route)) else { return stopLink() }
        labelled = PerfState.bundle != nil
        if let b = PerfState.bundle { t.setValue(b, forAttribute: PerfRules.attrBundle) }
        t.start()
        current = t
        startLink()
    }

    /// The running bundle's label came: the open screen trace gets it if it started without one. A trace that has
    /// one keeps it when the bundle changes (as Android, which puts it on at the start only).
    func bundleKnown() {
        guard let t = current, !labelled, let b = PerfState.bundle else { return }
        t.setValue(b, forAttribute: PerfRules.attrBundle)
        labelled = true
    }

    private func startLink() {
        guard link == nil else { return }
        let l = CADisplayLink(target: self, selector: #selector(frame(_:)))
        l.isPaused = UIApplication.shared.applicationState == .background
        l.add(to: .main, forMode: .common)
        link = l
        last = 0
    }

    private func stopLink() {
        link?.invalidate()
        link = nil
    }

    @objc private func frame(_ l: CADisplayLink) {
        defer { last = l.timestamp }
        guard last > 0 else { return }
        switch PerfRules.frameKind(l.timestamp - last) {
        case .frozen: frozen += 1
        case .slow: slow += 1
        case .ok: break
        }
        total += 1
    }

    // No frames are drawn in the background: the link sleeps, and the gap isn't counted as a frozen frame.
    @objc private func background() { link?.isPaused = true }

    @objc private func foreground() {
        last = 0
        link?.isPaused = false
    }
}
#endif

/// RN Firebase's `perf()`: custom traces. Each JS trace has an id (JS makes it) until it stops.
final class PerfModule: ZnModuleBase, @unchecked Sendable {
    private let on: Bool
    private let lock = NSLock()
    #if canImport(FirebasePerformance)
    private var traces: [String: Trace] = [:]
    #endif

    init(on: Bool) {
        self.on = on
        super.init("FirebasePerf", version: 1)

        function("status") { call in
            #if canImport(FirebasePerformance)
            call.resolve(["available": on, "enabled": on && Performance.sharedInstance().isDataCollectionEnabled])
            #else
            call.resolve(["available": false, "enabled": false])
            #endif
        }

        function("setCollectionEnabled") { call in
            guard let enabled = call.args["on"] as? Bool else { throw ZnInvalidArgs("\"on\" must be a boolean") }
            #if canImport(FirebasePerformance)
            if on { Performance.sharedInstance().isDataCollectionEnabled = enabled }
            #endif
            call.resolve(on)
        }

        function("startTrace") { call in
            let id = try Self.string(call, "id"), name = try Self.string(call, "name")
            if let p = PerfRules.nameProblem(name) { return call.resolve(p) }
            if self.count() >= PerfRules.maxOpenTraces { return call.resolve("too many traces open (\(PerfRules.maxOpenTraces)): stop some") }
            #if canImport(FirebasePerformance)
            guard on, let t = Performance.sharedInstance().trace(name: name) else { return call.resolve("") }
            if let b = PerfState.bundle { t.setValue(b, forAttribute: PerfRules.attrBundle) }
            t.start()
            self.lock.withLock { self.traces[id] = t }
            #endif
            call.resolve("")
        }

        function("putMetric") { call in
            try self.metric(call, value: Self.number(call.args["value"]) ?? 0, add: false)
        }
        function("incrementMetric") { call in
            try self.metric(call, value: Self.number(call.args["by"]) ?? 1, add: true)
        }

        function("putAttribute") { call in
            // Android's order: the name is checked before the id is read.
            let name = try Self.string(call, "name")
            let value = call.args["value"] as? String
            if let p = PerfRules.attributeProblem(name) { return call.resolve(p) }
            let id = try Self.string(call, "id")
            #if canImport(FirebasePerformance)
            guard let t = self.trace(id) else { return call.resolve("") }
            if let value { t.setValue(PerfRules.attributeValue(value), forAttribute: name) } else { t.removeAttribute(name) }
            #endif
            _ = (id, value)
            call.resolve("")
        }

        function("stopTrace") { call in
            let id = try Self.string(call, "id")
            #if canImport(FirebasePerformance)
            self.lock.withLock { self.traces.removeValue(forKey: id) }?.stop()
            #endif
            _ = id
            call.resolve("")
        }
    }

    private func count() -> Int {
        #if canImport(FirebasePerformance)
        return lock.withLock { traces.count }
        #else
        return 0
        #endif
    }

    #if canImport(FirebasePerformance)
    private func trace(_ id: String) -> Trace? { lock.withLock { traces[id] } }
    #endif

    private func metric(_ call: ZnCall, value: Double, add: Bool) throws {
        let id = try Self.string(call, "id"), name = try Self.string(call, "name")
        if let p = PerfRules.nameProblem(name) { return call.resolve(p) }
        #if canImport(FirebasePerformance)
        guard let t = trace(id) else { return call.resolve("") }
        let v = PerfRules.metricValue(value)
        if add { t.incrementMetric(name, by: v) } else { t.setValue(v, forMetric: name) }
        #endif
        _ = (id, value, add)
        call.resolve("")
    }

    private static func string(_ call: ZnCall, _ key: String) throws -> String {
        guard let s = call.args[key] as? String else { throw ZnInvalidArgs("\"\(key)\" must be a string") }
        return s
    }

    private static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }
}
