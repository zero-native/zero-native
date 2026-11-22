// The app-updates plugin's iOS side (plugins/app-updates, as android/.../AppUpdatesPlugin.kt). Apple has no in-app
// update API like Play's, so:
// - isUpdateAvailable asks the App Store's public lookup (AppUpdatesRules.swift): `{ available, versionCode: 0,
//   immediateAllowed, flexibleAllowed, stalenessDays?, storeVersion, appStoreId }`; available = the store's version is
//   newer than this build's and this iOS can run it. Kept for an hour. Any failure answers `available: false`; it
//   never rejects. `{ appStoreId }` looks that id up instead of this app's bundle id (a lab, or an app whose bundle
//   id the store doesn't know yet).
// - start `{ flexible }` opens the App Store's own sheet for the app inside the app (SKStoreProductViewController;
//   its Update button installs). `{ ok }`. When the sheet can't load it opens the App Store app instead. The sheet
//   closing sends `state` "declined" (optional) or "canceled" (forced): iOS never says whether Update was tapped (the
//   App Store installs and ends the app). A forced start opens the sheet again each time the app comes back to the
//   front, as Android's IMMEDIATE update, until a check says there is no update (not while busy).
// - complete: `{ ok: false, unavailable: true }`. There is nothing to install from inside the app: the App Store does it.
// - setBusy `{ busy }`: no forced sheet opens again while busy. Kept on disk, as on Android.
// - openStore `{ appStoreId }`: the App Store app's page (itms-apps://apps.apple.com/app/id<appStoreId>); `{ opened }`.
// The zn-updates server's store rule (storeAnswer in JS) stays what decides when to ask; this module checks that the
// App Store already has the version (Apple's CDN lags a release), as Play does on Android.
import StoreKit
import UIKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif

public struct AppUpdatesPlugin: ZnPlugin {
    public init() {}

    public func register(_ r: ZnPluginRegistry) {
        r.module(AppUpdatesModule())
    }
}

final class AppUpdatesModule: ZnModuleBase, @unchecked Sendable {
    private static let busyKey = "zn.appupdates.busy"
    private let lock = NSLock()
    // Under the lock: the last lookup's answer, for which question (the id or bundle id), and when.
    private var cached: (key: String, info: AppUpdatesRules.StoreInfo?, at: Date)?
    // Main thread only.
    private var forcedPending = false
    private var forcedId: String?
    private var sheet: SKStoreProductViewController?
    private var sheetFlexible = true
    private lazy var storeDelegate = StoreDelegate(self)

    private static var busy: Bool {
        get { UserDefaults.standard.bool(forKey: busyKey) }
        set { UserDefaults.standard.set(newValue, forKey: busyKey) }
    }

    init() {
        super.init("AppUpdates", version: 1)
        function("isUpdateAvailable") { call in
            let id = try? call.stringOrNil("appStoreId")
            self.lookup(id) { info in
                let out = AppUpdatesRules.availability(info, current: Self.appVersion, system: znIosVersionText(), now: Date())
                if out["available"] as? Bool != true { DispatchQueue.main.async { self.forcedPending = false } }
                call.resolve(out)
            }
        }
        function("start", onMain: true) { call in
            let flexible = (try? call.boolOrNil("flexible")) ?? false
            let id = try? call.stringOrNil("appStoreId")
            MainActor.assumeIsolated { self.start(flexible: flexible, appStoreId: id) { call.resolve(["ok": $0]) } }
        }
        // The App Store installs an update itself and ends the app: nothing to install from here.
        function("complete") { call in call.resolve(["ok": false, "unavailable": true]) }
        function("setBusy") { call in
            Self.busy = (try? call.boolOrNil("busy")) ?? false
            call.resolve(nil)
        }
        function("openStore", onMain: true) { call in
            let id: String? = try? call.stringOrNil("appStoreId")
            MainActor.assumeIsolated { Self.openStoreApp(id) { call.resolve(["opened": $0]) } }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.front() }
        }
    }

    private static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    // MARK: The lookup (any thread)

    /// The App Store's answer for [appStoreId], else for this app's bundle id: kept for an hour, nil on any failure.
    private func lookup(_ appStoreId: String?, _ done: @escaping (AppUpdatesRules.StoreInfo?) -> Void) {
        let bundle = Bundle.main.bundleIdentifier
        let key = appStoreId.map { "id:\($0)" } ?? "bundle:\(bundle ?? "")"
        let now = Date()
        if let c = lock.withLock({ cached }), c.key == key, AppUpdatesRules.fresh(savedAt: c.at, now: now) { return done(c.info) }
        let country = AppUpdatesRules.country(Locale.current.region?.identifier)
        guard let url = AppUpdatesRules.lookupURL(bundleId: bundle, appStoreId: appStoreId, country: country,
                                                  minute: Int(now.timeIntervalSince1970 / 60)) else { return done(nil) }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = AppUpdatesRules.timeoutSeconds
        config.timeoutIntervalForResource = AppUpdatesRules.timeoutSeconds
        let session = URLSession(configuration: config)
        session.dataTask(with: url) { data, response, error in
            session.finishTasksAndInvalidate()
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            guard error == nil, status == 200, let data else {
                print("zn app-updates: the App Store lookup failed (\(error.map { ($0 as NSError).code } ?? status))")
                return done(nil)
            }
            let info = AppUpdatesRules.parse(data)
            if info == nil { print("zn app-updates: the App Store has no \(appStoreId == nil ? "app with this bundle id" : "app with that id") in \(country)") }
            self.lock.withLock { self.cached = (key, info, Date()) }
            done(info)
        }.resume()
    }

    // MARK: The App Store sheet (main thread)

    @MainActor private func start(flexible: Bool, appStoreId: String?, _ done: @escaping (Bool) -> Void) {
        if Self.busy { return done(false) }
        dropGoneSheet()
        if sheet != nil { return done(true) }  // already open
        lookup(appStoreId) { info in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    guard let info else { return done(false) }
                    if !flexible {
                        self.forcedPending = true
                        self.forcedId = appStoreId
                    }
                    self.present(info.trackId, flexible: flexible, done)
                }
            }
        }
    }

    @MainActor private func present(_ trackId: Int64, flexible: Bool, _ done: @escaping (Bool) -> Void) {
        guard sheet == nil, let top = znTopController() else { return done(false) }
        let store = SKStoreProductViewController()
        store.delegate = storeDelegate
        sheet = store
        sheetFlexible = flexible
        print("zn app-updates: the App Store sheet for \(trackId) (\(flexible ? "optional" : "forced"))")
        top.present(store, animated: true)
        store.loadProduct(withParameters: [SKStoreProductParameterITunesItemIdentifier: NSNumber(value: trackId)]) { loaded, error in
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    if loaded { return done(true) }
                    // No sheet (no network for StoreKit, a restricted phone): the App Store app instead.
                    print("zn app-updates: the App Store sheet didn't load (\((error as NSError?)?.code ?? 0)); opening the App Store")
                    self.sheet = nil
                    store.dismiss(animated: true)
                    Self.openStoreApp(String(trackId), done)
                }
            }
        }
    }

    @MainActor fileprivate func sheetClosed(_ c: SKStoreProductViewController) {
        guard c === sheet else { return }
        sheet = nil
        c.dismiss(animated: true)
        let status = AppUpdatesRules.closedStatus(flexible: sheetFlexible)
        print("zn app-updates: the App Store sheet closed (\(status))")
        emit("state", ["status": status, "bytesDownloaded": 0, "totalBytes": 0, "errorCode": 0])
    }

    /// A sheet that went away without its delegate hearing it (a swipe down): closed now.
    @MainActor private func dropGoneSheet() {
        if let s = sheet, s.presentingViewController == nil, !s.isBeingPresented { sheetClosed(s) }
    }

    /// Back in front: a forced update the App Store hasn't installed yet opens again.
    @MainActor private func front() {
        dropGoneSheet()
        guard AppUpdatesRules.reopen(forcedPending: forcedPending, busy: Self.busy, open: sheet != nil) else { return }
        print("zn app-updates: a forced update is still open: the App Store sheet again")
        start(flexible: false, appStoreId: forcedId) { _ in }
    }

    @MainActor private static func openStoreApp(_ id: String?, _ done: @escaping (Bool) -> Void) {
        guard let id, !id.isEmpty, id.allSatisfy(\.isNumber), let url = URL(string: "itms-apps://apps.apple.com/app/id\(id)") else {
            return done(false)
        }
        UIApplication.shared.open(url, options: [:]) { done($0) }
    }

    /// StoreKit's delegate must be an NSObject: this one forwards to the module.
    private final class StoreDelegate: NSObject, SKStoreProductViewControllerDelegate {
        weak var module: AppUpdatesModule?
        init(_ m: AppUpdatesModule) { module = m }

        func productViewControllerDidFinish(_ c: SKStoreProductViewController) {
            MainActor.assumeIsolated { module?.sheetClosed(c) }
        }
    }
}

/// "18.0" or "18.0.1", from any thread.
private func znIosVersionText() -> String {
    let v = ProcessInfo.processInfo.operatingSystemVersion
    return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
}
