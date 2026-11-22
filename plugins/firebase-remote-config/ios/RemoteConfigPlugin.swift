// The Remote Config plugin's iOS side (plugins/firebase-remote-config, as android/.../RemoteConfigPlugin.kt): RN
// Firebase's `remoteConfig()`. Values go to JS all at once in every answer, so JS reads them with no call. With Firebase
// off (no SDK or no GoogleService-Info.plist) the module still answers: every call gives the defaults JS set and
// `available: false`.
//
// The rules with no Firebase in them are RemoteConfigRules.swift (tested on the Mac: ios/tests/remote-config).
//
// iOS differences:
// - `reset()` answers false: iOS's Firebase has no reset (JS still forgets the fetched values).
// - Defaults are given to Firebase as text (RemoteConfigRules.defaults), so a boolean reads "true" as on Android, not "1".
// - fetchAndActivate is a fetch then an activate, so `changed` says whether new values came into use, as on Android
//   (iOS's own fetchAndActivate says "fetched from remote" even when nothing changed).
import Foundation
#if SWIFT_PACKAGE
import ZnRuntime
import ZnPluginFirebaseApp
#endif
// In the Swift package the SDK is a declared dependency (ios/packages/firebase/Package.swift): without it, stop the build
// instead of building a plugin that quietly does nothing. The CMake builds may leave the SDK out on purpose.
#if SWIFT_PACKAGE && !(canImport(FirebaseRemoteConfig))
#error("ZnPluginFirebaseRemoteConfig needs FirebaseRemoteConfig: check ios/packages/firebase/Package.swift")
#endif
#if canImport(FirebaseRemoteConfig)
import FirebaseRemoteConfig
#endif

/// Add it with `ZnPlugins.register(..., RemoteConfigPlugin())`. JS: `RemoteConfig` (plugins/firebase-remote-config/src).
public struct RemoteConfigPlugin: ZnPlugin {
    public init() {}

    public func register(_ r: ZnPluginRegistry) {
        r.requireHostApi(8)
        let on = ZnFirebase.start()
        if !on { print("zn-remote-config: Firebase isn't set up in this app, so Remote Config is off") }
        r.module(RemoteConfigModule(on: on))  // also with Firebase off: bundles that use the plugin still run
    }
}

final class RemoteConfigModule: ZnModuleBase, @unchecked Sendable {
    #if canImport(FirebaseRemoteConfig)
    private let rc: RemoteConfig?
    /// The real-time listener while JS listens (main thread).
    private var updates: ConfigUpdateListenerRegistration?
    #endif

    init(on: Bool) {
        #if canImport(FirebaseRemoteConfig)
        rc = on ? RemoteConfig.remoteConfig() : nil
        #endif
        super.init("FirebaseRemoteConfig", version: 1)

        function("setDefaults") { call in
            #if canImport(FirebaseRemoteConfig)
            guard let rc = self.rc else { return call.resolve(false) }
            let d = RemoteConfigRules.defaults(call.args["defaults"] as? [String: Any] ?? [:])
            // Firebase applies them on its own queue; every later read waits for that, so it can answer now.
            rc.setDefaults(d.mapValues { $0 as NSString })
            call.resolve(true)
            #else
            call.resolve(false)
            #endif
        }

        function("setConfigSettings") { call in
            #if canImport(FirebaseRemoteConfig)
            guard let rc = self.rc else { return call.resolve(false) }
            // A new settings object starts from Firebase's defaults (12 hours, 60 s), as Android's Builder does.
            let s = RemoteConfigSettings()
            if let ms = Self.number(call.args["minimumFetchIntervalMillis"]) { s.minimumFetchInterval = TimeInterval(RemoteConfigRules.seconds(ms)) }
            if let ms = Self.number(call.args["fetchTimeMillis"]) { s.fetchTimeout = TimeInterval(max(1, RemoteConfigRules.seconds(ms))) }
            rc.configSettings = s
            call.resolve(true)
            #else
            call.resolve(false)
            #endif
        }

        // Each answers { ok, reason, values, info }: JS keeps the values, so reads need no call.
        function("fetch") { call in
            #if canImport(FirebaseRemoteConfig)
            guard let rc = self.rc else { return call.resolve(RemoteConfigRules.off()) }
            let done: (RemoteConfigFetchStatus, Error?) -> Void = { status, error in
                self.answer(call, ok: status == .success && error == nil, error)
            }
            if let s = Self.number(call.args["expirationSeconds"]) {
                rc.fetch(withExpirationDuration: max(0, s), completionHandler: done)
            } else {
                rc.fetch(completionHandler: done)
            }
            #else
            call.resolve(RemoteConfigRules.off())
            #endif
        }

        function("activate") { call in
            #if canImport(FirebaseRemoteConfig)
            guard let rc = self.rc else { return call.resolve(RemoteConfigRules.off()) }
            // Nothing new to activate answers (false, no error), as Android's false.
            rc.activate { changed, error in self.answer(call, ok: error == nil, error, changed: error == nil && changed) }
            #else
            call.resolve(RemoteConfigRules.off())
            #endif
        }

        function("fetchAndActivate") { call in
            #if canImport(FirebaseRemoteConfig)
            guard let rc = self.rc else { return call.resolve(RemoteConfigRules.off()) }
            rc.fetch { status, error in
                guard status == .success, error == nil else { return self.answer(call, ok: false, error) }
                rc.activate { changed, error in self.answer(call, ok: error == nil, error, changed: error == nil && changed) }
            }
            #else
            call.resolve(RemoteConfigRules.off())
            #endif
        }

        // The values Firebase has now: activated remote ones, else the defaults. Also at start, from its cache.
        function("getAll") { call in
            #if canImport(FirebaseRemoteConfig)
            call.resolve(self.rc == nil ? RemoteConfigRules.off() : self.result(ok: true, reason: nil, changed: false))
            #else
            call.resolve(RemoteConfigRules.off())
            #endif
        }

        function("reset") { call in
            #if canImport(FirebaseRemoteConfig)
            if self.rc != nil { print("zn-remote-config: reset() isn't in iOS's Firebase: the fetched values stay") }
            #endif
            call.resolve(false)
        }

        // Real-time updates: Firebase keeps a connection open only while JS listens (startUpdates .. stopUpdates).
        function("startUpdates", onMain: true) { call in
            #if canImport(FirebaseRemoteConfig)
            guard let rc = self.rc else { return call.resolve(false) }
            if self.updates == nil {
                self.updates = rc.addOnConfigUpdateListener { update, error in
                    if let error {
                        let code = RemoteConfigRules.updateError(error)
                        print("zn-remote-config: real-time updates: \(code)")
                        self.emit("updated", ["updatedKeys": [String](), "error": code])
                        return
                    }
                    self.emit("updated", ["updatedKeys": (update?.updatedKeys ?? []).sorted()])
                }
            }
            call.resolve(true)
            #else
            call.resolve(false)
            #endif
        }

        function("stopUpdates", onMain: true) { call in
            #if canImport(FirebaseRemoteConfig)
            self.updates?.remove()
            self.updates = nil
            #endif
            call.resolve(true)
        }
    }

    private static func number(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        return n.doubleValue
    }

    #if canImport(FirebaseRemoteConfig)
    private func answer(_ call: ZnCall, ok: Bool, _ error: Error?, changed: Bool = false) {
        if !ok { print("zn-remote-config: \((error as NSError?).map { "\($0.domain) \($0.code) \($0.localizedDescription)" } ?? "failed")") }
        call.resolve(result(ok: ok, reason: ok ? nil : RemoteConfigRules.reason(error), changed: changed))
    }

    private func result(ok: Bool, reason: String?, changed: Bool) -> [String: Any] {
        let rc = rc!
        var values: [String: (value: String, source: Int)] = [:]
        for key in Set(rc.allKeys(from: .remote)).union(rc.allKeys(from: .default)) {
            let v = rc.configValue(forKey: key)
            values[key] = (v.stringValue, v.source.rawValue)
        }
        return RemoteConfigRules.result(ok: ok, reason: reason, changed: changed, values: values,
                                        lastFetchStatus: rc.lastFetchStatus.rawValue, fetchTime: rc.lastFetchTime)
    }
    #endif
}
