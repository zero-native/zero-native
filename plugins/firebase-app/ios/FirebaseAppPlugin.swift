// The Firebase base plugin's iOS side (plugins/firebase-app, as android/.../FirebaseAppPlugin.kt): RN Firebase's `app`
// and `installations` modules, and Firebase's start for every zero-native Firebase plugin (ZnFirebase).
//
// Firebase is on when the app was built with the Firebase SDK (bun run tools/fetch-firebase-apple.ts) and has its
// GoogleService-Info.plist, as Android needs its google-services.json. Otherwise every call answers "not available"
// (app: available false, Installations: null) and nothing fails.
//
// iOS difference: Android's google-services plugin starts Firebase by itself; here the first Firebase plugin to register
// calls `FirebaseApp.configure()` (ZnFirebase.start), before the app's JS runs.
import Foundation
#if SWIFT_PACKAGE
import ZnRuntime
#endif
#if canImport(FirebaseCore)
import FirebaseCore
import FirebaseInstallations
#endif

/// Firebase's state for every zero-native Firebase plugin.
public enum ZnFirebase {
    /// The app has its GoogleService-Info.plist.
    static var hasConfig: Bool { Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist") != nil }

    /// Starts Firebase once, if it can. True when Firebase is running. Main thread (plugins register there).
    @MainActor @discardableResult
    public static func start() -> Bool {
        #if canImport(FirebaseCore)
        if FirebaseApp.app() != nil { return true }
        guard hasConfig else {
            print("zn-firebase: no GoogleService-Info.plist in the app, so Firebase is off")
            return false
        }
        FirebaseApp.configure()
        return FirebaseApp.app() != nil
        #else
        print("zn-firebase: the app was built without the Firebase SDK (bun run tools/fetch-firebase-apple.ts), so Firebase is off")
        return false
        #endif
    }

    /// True when Firebase is running (any thread).
    static var available: Bool {
        #if canImport(FirebaseCore)
        return FirebaseApp.app() != nil
        #else
        return false
        #endif
    }
}

/// Add it with `ZnPlugins.register(FirebaseAppPlugin(), ...)` when JS uses `Firebase.app()` or `installations()`.
public struct FirebaseAppPlugin: ZnPlugin {
    public init() {}

    public func register(_ r: ZnPluginRegistry) {
        r.requireHostApi(8)
        ZnFirebase.start()
        r.module(FirebaseModule())
        r.module(InstallationsModule())
    }
}

/// `Firebase.app()` and the data collection default.
final class FirebaseModule: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("FirebaseApp", version: 1)
        function("app") { call in call.resolve(Self.info()) }
        function("setDataCollectionDefault") { call in
            guard let on = call.args["on"] as? Bool else { throw ZnInvalidArgs("\"on\" must be a boolean") }
            #if canImport(FirebaseCore)
            FirebaseApp.app()?.isDataCollectionDefaultEnabled = on
            #endif
            call.resolve(Self.info())
        }
    }

    private static func info() -> [String: Any] {
        #if canImport(FirebaseCore)
        guard let app = FirebaseApp.app() else { return ["available": false] }
        let o = app.options
        return [
            "available": true,
            "name": app.name,
            "projectId": o.projectID ?? NSNull(),
            "appId": o.googleAppID,
            "senderId": o.gcmSenderID,
            "storageBucket": o.storageBucket ?? NSNull(),
            "dataCollectionDefault": app.isDataCollectionDefaultEnabled,
        ]
        #else
        return ["available": false]
        #endif
    }
}

/// RN Firebase's `installations`: the install id Firebase services know this app by.
final class InstallationsModule: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("FirebaseInstallations", version: 1)
        function("getId") { call in
            #if canImport(FirebaseCore)
            guard ZnFirebase.available else { return call.resolve(nil) }
            Installations.installations().installationID { id, _ in call.resolve(id) }
            #else
            call.resolve(nil)
            #endif
        }
        function("getToken") { call in
            #if canImport(FirebaseCore)
            guard ZnFirebase.available else { return call.resolve(nil) }
            let force = call.args["forceRefresh"] as? Bool ?? false
            Installations.installations().authTokenForcingRefresh(force) { result, _ in
                guard let r = result else { return call.resolve(nil) }
                call.resolve(["token": r.authToken, "expiresAt": (r.expirationDate.timeIntervalSince1970 * 1000).rounded()])
            }
            #else
            call.resolve(nil)
            #endif
        }
        function("delete") { call in
            #if canImport(FirebaseCore)
            guard ZnFirebase.available else { return call.resolve(false) }
            Installations.installations().delete { error in call.resolve(error == nil) }
            #else
            call.resolve(false)
            #endif
        }
    }
}
