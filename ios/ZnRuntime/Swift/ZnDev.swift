// The dev client for `zn dev` (ARCHITECTURE §17), as Android's ZnDev.kt. **Debug builds only**: the whole file is
// behind `#if DEBUG`, so a Release build has none of it.
//
// - Connects to `zn dev` on the Mac (a plain TCP socket, so no App Transport Security settings), retrying every 2 s
//   while it isn't running. Where (ZnDevWire.target): ZN_DEV_HOST in the environment, else the Info.plist's ZNDevHost,
//   else 127.0.0.1:8082 on the simulator (it shares the Mac's network, so no adb step) and Bonjour on an iPhone: the
//   Mac runs `zn dev --lan`, which advertises _zn-dev._tcp (a phone can't reach the Mac's 127.0.0.1, and iOS has no
//   adb reverse). An iPhone asks for Local Network access the first time (NSLocalNetworkUsageDescription and
//   NSBonjourServices are Debug-only Info.plist keys: ios/cmake/ZnDev.cmake). Bonjour never uses a server for another
//   app (its TXT app= against this build's zn-bundle.json), and prefers the Mac the build was made on (ZNDevMac). A
//   host from the Info.plist that stops answering (the Mac got a new address) gives way to Bonjour after 3 tries.
// - A new build replaces templates and JS: the runtime is replaced (ZnApp.restart, as an OTA update applied in place)
//   and every screen that was open opens again by route and params, with a still picture of the old screens over
//   the swap. Templates and JS always come from the same build folder (Android's A12 can't happen here).
// - JS errors and build errors show on a dev error screen ([ZnDevOverlay]); the server maps JS stacks back to TSX.
//   Only once this run has talked to a dev server: a debug build without `zn dev` keeps the app's own error screens.
// - ZN_DEV=0 in the environment turns it off.
// Wire format: ZnDevWire.swift.
#if DEBUG
import Foundation
import Network
import UIKit
#if SWIFT_PACKAGE
import ZnHost
#endif

@MainActor
final class ZnDev {
    static let shared = ZnDev()

    private struct Problem {
        let id: Int
        let title: String
        var text: String
    }

    private let queue = DispatchQueue(label: "zn-dev")
    private var connection: NWConnection?
    /// Where `zn dev` is (start), where that came from, and where to look if a host from the Info.plist stops answering.
    private var target = ZnDevWire.Target.host("127.0.0.1", ZnDevWire.port)
    private var targetSource = ZnDevWire.Source.none
    private var fallback = ZnDevWire.Target.host("127.0.0.1", ZnDevWire.port)
    /// Failed tries in a row at the target (a host from the Info.plist falls back after ZnDevWire.plistTries).
    private var tries = 0
    /// Bonjour (an iPhone): the browser, and the dev servers it sees now (sorted by name).
    private var browser: NWBrowser?
    private var services: [(service: ZnDevWire.Service, endpoint: NWEndpoint)] = []
    /// This build's app (its zn-bundle.json) and the Mac it was built on (the Info.plist's ZNDevMac): a Bonjour server
    /// for another app is never used, and this Mac's goes first.
    private lazy var app: String? = ZnBundles.builtIn?.app
    private let mac = Bundle.main.object(forInfoDictionaryKey: "ZNDevMac") as? String
    /// Servers for another app already named in the log; the last server named as on another Mac.
    private var saidOtherApp = Set<String>()
    private var saidOtherMac: String?
    /// When the Local Network message was last printed (again every minute while it stays off; from now on after a
    /// connection); no `zn dev --lan` seen yet (said once).
    private var saidDenied: Date?
    private var saidLooking = false
    /// Bonjour browsing failed this many times in a row (the next try waits longer); it was said in the log.
    private var browseFailures = 0
    /// A connect is due in 2 s (drop): Bonjour finding a server meanwhile doesn't start a second one.
    private var retryPending = false
    private var connected = false
    /// This run has talked to a dev server: errors show on the dev error screen from then on.
    private var everConnected = false
    private var warned = false
    private var started = false
    private var nextErrorId = 1
    private var problem: Problem?
    private var overlay: ZnDevOverlay?
    /// The dev server's hash of the build now running ("app" until the first build arrives).
    private var runningHash = "app"
    /// A build that came while the last one was still starting: it goes next.
    private var waiting: (URL, String)?
    private var reloading = false

    /// The folder of the last build `zn dev` ran, or nil. A restart on the app's own bundle in this process runs it
    /// instead (ZnApp.restart), as Android's devBytecode on a fresh start.
    private(set) var devBundle: URL?

    private nonisolated static var buildsDir: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("zn-dev", isDirectory: true)
    }

    #if targetEnvironment(simulator)
    private let simulator = true
    #else
    private let simulator = false
    #endif

    /// Once per process, before JS runs (ZnApp.prepare).
    func start() {
        guard !started else { return }
        started = true
        if ProcessInfo.processInfo.environment["ZN_DEV"] == "0" { return print("zn-dev: off (ZN_DEV=0)") }
        // Builds from an earlier run: this one starts on the app's own bundle.
        let dir = Self.buildsDir
        queue.async { try? FileManager.default.removeItem(at: dir) }
        ZnApp.shared.addJsErrorListener { [weak self] _, whereText, details in self?.onJsError("\(whereText)\n\(details)") }
        let found = ZnDevWire.target(env: ProcessInfo.processInfo.environment["ZN_DEV_HOST"],
                                     plist: Bundle.main.object(forInfoDictionaryKey: "ZNDevHost") as? String, simulator: simulator)
        if let bad = found.bad { print("zn-dev: ZN_DEV_HOST / ZNDevHost \"\(bad)\" isn't host, host:port or bonjour; skipped") }
        target = found.target
        targetSource = found.source
        fallback = found.fallback
        print("zn-dev: looking for `zn dev` at \(target)" + (targetSource == .plist ? " (ZNDevHost, from the build)" : ""))
        if target == .bonjour { startBonjour() }
        connect()
    }

    /// Looks for `zn dev --lan` with Bonjour from now on (start, or a host from the Info.plist that stopped answering).
    private func startBonjour() {
        let types = Bundle.main.object(forInfoDictionaryKey: "NSBonjourServices") as? [String] ?? []
        if !simulator, !types.contains(ZnDevWire.bonjourType) {
            // iOS would refuse the browse (NoAuth): said once, no browsing.
            return print("zn-dev: this build's Info.plist has no NSBonjourServices \(ZnDevWire.bonjourType) (a Debug key: "
                         + "ios/cmake/ZnDev.cmake), so iOS won't let it look with Bonjour. Set ZN_DEV_HOST=<the Mac's address> "
                         + "(the scheme's environment, or the ZN_DEV_HOST build setting) instead")
        }
        browse()
    }

    /// JS threw ("where\nmessage and stack"): on the dev error screen now (when `zn dev` is in use), replaced by the
    /// TSX-mapped text if it comes back.
    func onJsError(_ text: String) {
        let id = nextErrorId
        nextErrorId += 1
        let parts = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false)
        show(Problem(id: id, title: String(parts.first ?? ""), text: parts.count > 1 ? String(parts[1]) : ""))
        send(ZnDevWire.error, json: ["id": id, "text": text])
    }

    /// The bundle about to run needs native modules no plugin registered (Android's ZnBundles warnMissingModules):
    /// their calls fail with "unavailable". Logged; on the dev error screen when `zn dev` is in use.
    func checkModules(_ requires: ZnBundleRules.Requires?) {
        guard let requires else { return }
        let have = ZnCapabilities.current().modules
        var missing: [String] = []
        for part in [requires.modules, requires.os["ios"] ?? [:]] {
            for name in part.keys.sorted() where (have[name] ?? 0) < part[name]! {
                missing.append(have[name].map { "\(name) v\(part[name]!) (this app has v\($0))" } ?? name)
            }
        }
        guard !missing.isEmpty else { return }
        let message = "the bundle needs native modules this app didn't register: \(missing.joined(separator: ", ")). "
            + "Add the plugin to ZnPlugins.register(...) before ZnApp.prepare (its README has the line). Until then its calls "
            + "fail with \"unavailable\"."
        print("zn: bundle: \(message)")
        pendingModules = message
        showModulesIfConnected()
    }

    private var pendingModules: String?

    private func showModulesIfConnected() {
        guard everConnected, let message = pendingModules else { return }
        pendingModules = nil
        onJsError("native modules missing\n\(message)")
    }

    // MARK: Connection

    private func connect() {
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = 2
        let params = NWParameters(tls: nil, tcp: tcp)
        let c: NWConnection
        trying = nil
        switch target {
        case .host(let host, let port):
            c = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: params)
        case .bonjour:
            // This Mac's dev server first, never one for another app; one that just failed once every one has. None
            // yet: connect when one comes (browse).
            guard let pick = ZnDevWire.choose(services.map(\.service), failed: failed, app: app, mac: mac),
                  let endpoint = services.first(where: { $0.service == pick })?.endpoint else {
                if !saidLooking {
                    saidLooking = true
                    print("zn-dev: no `zn dev --lan` for this app on this network yet (run it on the Mac, on the same Wi-Fi as this phone)")
                }
                return
            }
            if failed.contains(pick.name) { failed.removeAll() }  // every one failed: round again
            if let m = pick.mac, mac != nil, !ZnDevWire.sameMac(pick, mac: mac), saidOtherMac != pick.name {
                saidOtherMac = pick.name
                print("zn-dev: WARNING: \(pick.name) runs on another Mac (\(m)), not the one this build was made on "
                      + "(\(mac!)); its JS runs here. For a set server: ZN_DEV_HOST=<its Mac's address>")
            }
            trying = pick.name
            c = NWConnection(to: endpoint, using: params)
        }
        connection = c
        c.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async { MainActor.assumeIsolated { self?.changed(c, state) } }
        }
        c.start(queue: queue)
        // A connection can wait on its own for long (a Bonjour name whose server is gone, a network that drops the
        // packets): not up in 5 s, try again (the next server Bonjour sees, if there is one).
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.connection === c, !self.connected else { return }
            self.drop(c, "no answer in 5 s")
        }
    }

    /// Bonjour: the server being tried, and the ones that didn't answer (tried again once every one has failed).
    private var trying: String?
    private var failed = Set<String>()

    /// Bonjour looks for `zn dev --lan` for as long as the app runs: the Mac's address can change, and the server can
    /// stop and start again. The TXT record says which app the server serves and on which Mac (tools/zn-dev.ts).
    private func browse() {
        let b = NWBrowser(for: .bonjourWithTXTRecord(type: ZnDevWire.bonjourType, domain: nil), using: NWParameters())
        browser = b
        b.browseResultsChangedHandler = { results, _ in
            let found: [(service: ZnDevWire.Service, endpoint: NWEndpoint)] = results.compactMap { r in
                guard case .service(let name, _, _, _) = r.endpoint else { return nil }
                var txt: NWTXTRecord?
                if case .bonjour(let t) = r.metadata { txt = t }
                return (ZnDevWire.Service(name: name, app: txt?["app"], mac: txt?["mac"]), r.endpoint)
            }.sorted { $0.service.name < $1.service.name }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    let dev = ZnDev.shared
                    let was = Set(dev.services.map(\.service.name))
                    for (s, _) in found where !was.contains(s.name) {
                        if ZnDevWire.otherApp(s, app: dev.app) {
                            if dev.saidOtherApp.insert(s.name).inserted {
                                print("zn-dev: skipped \(s.name): it serves the app \"\(s.app ?? "")\", this build is "
                                      + "\"\(dev.app ?? "")\" (to use it anyway: ZN_DEV_HOST=<its Mac's address>)")
                            }
                        } else {
                            print("zn-dev: found \(s.name)" + (s.mac.map { " (on \($0))" } ?? ""))
                        }
                    }
                    dev.services = found
                    // Nothing to connect to until now: go (a connection that is up or on its way stays).
                    if dev.connection == nil, !found.isEmpty, !dev.retryPending { dev.connect() }
                }
            }
        }
        b.stateUpdateHandler = { state in
            DispatchQueue.main.async { MainActor.assumeIsolated { ZnDev.shared.browserChanged(b, state) } }
        }
        b.start(queue: queue)
    }

    private func browserChanged(_ b: NWBrowser, _ state: NWBrowser.State) {
        guard b === browser else { return }
        switch state {
        case .ready:
            browseFailures = 0
        case .waiting(let error):
            sayIfDenied(error)
        case .failed(let error):
            sayIfDenied(error)
            // Let it go (its handlers hold it).
            browser = nil
            b.browseResultsChangedHandler = nil
            b.stateUpdateHandler = nil
            b.cancel()
            if case .dns(let code) = error, code == ZnDevWire.noAuth {
                return print("zn-dev: iOS won't let this build browse for \(ZnDevWire.bonjourType) (\(error)): its "
                             + "Info.plist needs NSBonjourServices \(ZnDevWire.bonjourType) (a Debug key: ios/cmake/ZnDev.cmake). "
                             + "Bonjour is off for this run; set ZN_DEV_HOST=<the Mac's address> instead")
            }
            // Again later, waiting longer each time (2 s, 4 s, ... a minute); said the first time only.
            let wait = min(60.0, 2 * pow(2, Double(browseFailures)))
            if browseFailures == 0 { print("zn-dev: Bonjour stopped (\(error)); trying again, every minute at most") }
            browseFailures += 1
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                guard let self, self.browser == nil, self.target == .bonjour else { return }
                self.browse()
            }
        default:
            break
        }
    }

    /// Local Network access is off for this app (the user said no, or turned it off later; maybe iOS is still asking):
    /// say how to turn it on, again every minute while it stays off. Bonjour says so with kDNSServiceErr_PolicyDenied, a
    /// connection with its path's reason.
    private func sayIfDenied(_ error: NWError?, path: NWPath? = nil) {
        var denied = path?.unsatisfiedReason == .localNetworkDenied
        if case .dns(let code) = error, code == ZnDevWire.policyDenied { denied = true }
        guard denied, saidDenied.map({ Date().timeIntervalSince($0) >= 60 }) ?? true else { return }
        saidDenied = Date()
        print("zn-dev: Local Network access is off for this app, so it can't reach `zn dev` on the Mac. If iOS is asking "
              + "now, tap Allow; else turn it on in Settings > Privacy & Security > Local Network")
    }

    private func changed(_ c: NWConnection, _ state: NWConnection.State) {
        guard c === connection else { return }
        switch state {
        case .ready:
            connected = true
            everConnected = true
            warned = false
            tries = 0
            saidDenied = nil  // a later "off" is said again
            failed.removeAll()
            print("zn-dev: connected to the dev server" + (target == .bonjour ? " \(trying ?? "")" : " at \(target)"))
            let env = ProcessInfo.processInfo.environment
            let device = env["SIMULATOR_DEVICE_NAME"].map { "iOS simulator \($0)" } ?? "\(UIDevice.current.name) (\(ZnOs.model))"
            var hello: [String: Any] = ["device": device, "hash": runningHash, "os": "ios", "bytecode": ZNHost.bytecodeVersion]
            if let app { hello["app"] = app }
            send(ZnDevWire.hello, json: hello)
            read(c)
            showModulesIfConnected()
        case .waiting(let error), .failed(let error):
            sayIfDenied(error, path: c.currentPath)
            drop(c, "\(error)")
        default:
            break
        }
    }

    /// The connection ended or never came: try again in 2 s. A host from the Info.plist that failed
    /// ZnDevWire.plistTries times in a row is left for the default way (Bonjour on an iPhone): the Mac's address can
    /// have changed since the build.
    private func drop(_ c: NWConnection, _ why: String) {
        guard c === connection else { return }
        connection = nil
        c.stateUpdateHandler = nil
        c.cancel()
        if !connected, target == .bonjour, let name = trying { failed.insert(name) }  // the next one first
        trying = nil
        if connected {
            print("zn-dev: dev server disconnected (\(why))")
        } else if !warned {
            let run: String
            if simulator {
                run = target == .host("127.0.0.1", ZnDevWire.port) ? "`bun run dev` or `zn dev`" : "`zn dev --lan`"
            } else {
                run = "`zn dev --lan` on the Mac, on the same Wi-Fi as this phone"
            }
            print("zn-dev: no dev server at \(target) (\(why)); run \(run). Retrying every 2 s")
        }
        warned = true
        if !connected { tries += 1 }
        connected = false
        if targetSource == .plist, tries >= ZnDevWire.plistTries, target != fallback {
            print("zn-dev: ZNDevHost \(target) (from the build) didn't answer \(tries) times; looking at \(fallback) instead "
                  + "(a new address: rebuild with another ZN_DEV_HOST, or none)")
            target = fallback
            targetSource = .none
            tries = 0
            warned = false
            if target == .bonjour, browser == nil { startBonjour() }
        }
        retryPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.retryPending = false
            self?.connect()
        }
    }

    /// Reads one frame, hands it on, and reads the next (on the zn-dev queue).
    private nonisolated func read(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 5, maximumLength: 5) { [weak self] data, _, done, error in
            guard let data, error == nil, let head = ZnDevWire.head(data) else {
                let why = error.map { "\($0)" } ?? (done ? "closed" : "a bad frame")
                DispatchQueue.main.async { MainActor.assumeIsolated { self?.drop(c, why) } }
                return
            }
            let next = { (body: Data) in
                self?.received(head.type, body)
                self?.read(c)
            }
            if head.body == 0 { return next(Data()) }
            c.receive(minimumIncompleteLength: head.body, maximumLength: head.body) { body, _, done, error in
                guard let body, body.count == head.body, error == nil else {
                    let why = error.map { "\($0)" } ?? (done ? "closed" : "a short frame")
                    DispatchQueue.main.async { MainActor.assumeIsolated { self?.drop(c, why) } }
                    return
                }
                next(body)
            }
        }
    }

    /// A frame from the server (zn-dev queue): a build is written to its folder here, off the main thread.
    private nonisolated func received(_ type: UInt8, _ body: Data) {
        let json = { (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:] }
        switch type {
        case ZnDevWire.build:
            do {
                let build = try ZnDevWire.parseBuild(body)
                let keep = DispatchQueue.main.sync { MainActor.assumeIsolated { ZnApp.shared.bundleURL } }
                let dir = try ZnDevWire.write(build, in: Self.buildsDir, keep: keep)
                DispatchQueue.main.async { MainActor.assumeIsolated { ZnDev.shared.apply(dir, build.hash) } }
            } catch {
                print("zn-dev: a build from the dev server didn't arrive whole: \(error)")
            }
        case ZnDevWire.buildFailed:
            let message = json()["message"] as? String ?? ""
            DispatchQueue.main.async { MainActor.assumeIsolated { ZnDev.shared.show(Problem(id: 0, title: "Build failed", text: message)) } }
        case ZnDevWire.errorMapped:
            let o = json()
            guard let id = (o["id"] as? NSNumber)?.intValue, let text = o["text"] as? String else { return }
            DispatchQueue.main.async {
                MainActor.assumeIsolated {
                    let dev = ZnDev.shared
                    guard var p = dev.problem, p.id == id else { return }
                    p.text = text
                    dev.show(p)
                }
            }
        default:
            print("zn-dev: unknown message type \(type)")
        }
    }

    private func send(_ type: UInt8, json: [String: Any]) {
        guard connected, let c = connection else { return }
        c.send(content: ZnDevWire.frame(type, json: json), completion: .contentProcessed { error in
            if let error { print("zn-dev: send failed: \(error)") }
        })
    }

    // MARK: Reload

    /// Runs the build in [dir]: the runtime is replaced and every open screen opens again.
    private func apply(_ dir: URL, _ hash: String) {
        guard !reloading else {
            waiting = (dir, hash)  // after the reload going on now
            return
        }
        if ZnApp.shared.restarting {
            // Another restart (an OTA update applied in place) is going on: this build (or a newer one) goes after it.
            waiting = (dir, hash)
            if !retrying {
                retrying = true
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [self] in
                    retrying = false
                    guard let (d, h) = waiting else { return }
                    waiting = nil
                    apply(d, h)
                }
            }
            return
        }
        // The app has just started (the first build comes right after HELLO): its first screens and the module
        // events they start are on their way, and those still queued would reach the new runtime before its main
        // script ("global function not defined: __zn_onEvent"). The build goes once the screens have been up 0.5 s
        // (or 5 s on, when they never come: JS failed).
        let app = ZnApp.shared
        let wait = app.firstScreensUp ? 0.5 - (CACurrentMediaTime() - app.screensUpAt) : 5
        if wait > 0, !settling {
            settling = true
            waiting = (dir, hash)
            let go = ZnOnce<Void> { [self] _ in
                settling = false
                guard let (d, h) = waiting else { return }
                waiting = nil
                // A restart that came meanwhile (an OTA update in place) runs its waiters at once: go after it.
                if ZnApp.shared.restarting { apply(d, h) } else { reload(d, h) }
            }
            app.afterScreensUp(capMs: 5_000) {
                let left = max(0, 0.5 - (CACurrentMediaTime() - app.screensUpAt))
                DispatchQueue.main.asyncAfter(deadline: .now() + left) { go(()) }
            }
            return
        }
        if settling { waiting = (dir, hash); return }
        reload(dir, hash)
    }

    /// A build waits for the app's first screens to settle (apply).
    private var settling = false
    /// A build waits for another restart to end (apply).
    private var retrying = false

    private func reload(_ dir: URL, _ hash: String) {
        reloading = true
        let t0 = CACurrentMediaTime()
        hide()
        let window = ZnOta.window()
        let route = ZnApp.shared.topRoute ?? "start"
        // A still picture of the screens over the swap (a secure screen: its plain background, as ZnOta's cover).
        var cover: UIView?
        if let window {
            let v = (ZnSecure.shared.on ? nil : window.snapshotView(afterScreenUpdates: false)) ?? UIView(frame: window.bounds)
            if v.backgroundColor == nil, ZnSecure.shared.on { v.backgroundColor = ZnApp.shared.topBackground ?? .systemBackground }
            v.frame = window.bounds
            v.isUserInteractionEnabled = false
            window.addSubview(v)
            cover = v
        }
        ZnApp.shared.restart(bundle: dir, in: window, keepAll: true) { [self] ok, error in
            runningHash = hash
            devBundle = dir
            let js = (CACurrentMediaTime() - t0) * 1000
            let finish = { [self] in
                cover?.removeFromSuperview()
                if let p = problem { show(p) }  // an error while starting: above the new screens
                reloading = false
                print("zn-dev: reloaded in \(Int((CACurrentMediaTime() - t0) * 1000)) ms (JS up in \(Int(js)) ms), on \(route)"
                      + (ok ? "" : " — the new code threw, see the error screen: \(error)"))
                if let (d, h) = waiting {
                    waiting = nil
                    apply(d, h)
                }
            }
            if ok { ZnApp.shared.afterScreensUp(finish) } else { finish() }
        }
    }

    // MARK: Error screen

    private func show(_ p: Problem) {
        problem = p
        guard everConnected else { return }  // no `zn dev` in this run: the app's own error screens only
        guard let window = ZnOta.window() else {
            // No window yet (JS failed before the scene, or a launch in the back): try again shortly, one retry at
            // a time, with the newest problem, until it is dismissed or a window comes.
            guard !showLater else { return }
            showLater = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self else { return }
                self.showLater = false
                if let p = self.problem { self.show(p) }
            }
            return
        }
        let o = overlay ?? ZnDevOverlay(onDismiss: { [weak self] in self?.hide() },
                                        onReload: { [weak self] in self?.hide(); self?.send(ZnDevWire.reload, json: [:]) })
        overlay = o
        o.set(title: p.title, text: p.text.trimmingCharacters(in: .whitespacesAndNewlines))
        if o.superview !== window {
            o.removeFromSuperview()
            o.frame = window.bounds
            o.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            window.addSubview(o)
        }
        window.bringSubviewToFront(o)
        print("zn-dev: error screen: \(p.title)")
    }

    /// A show waits for a window (show).
    private var showLater = false

    private func hide() {
        problem = nil
        overlay?.removeFromSuperview()
    }
}

/// The dev error screen: opaque, over the screens (they may be broken), and it takes every touch. As Android's
/// ZnDev.Overlay: #111827, a red title, the text in a monospaced scrolling box, Dismiss and Reload.
private final class ZnDevOverlay: UIView {
    private let title = UILabel()
    private let text = UITextView()
    private let onDismiss: () -> Void
    private let onReload: () -> Void

    init(onDismiss: @escaping () -> Void, onReload: @escaping () -> Void) {
        self.onDismiss = onDismiss
        self.onReload = onReload
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0x11 / 255.0, green: 0x18 / 255.0, blue: 0x27 / 255.0, alpha: 1)
        accessibilityViewIsModal = true
        title.textColor = UIColor(red: 0xF8 / 255.0, green: 0x71 / 255.0, blue: 0x71 / 255.0, alpha: 1)
        title.font = .systemFont(ofSize: 17, weight: .semibold)
        title.numberOfLines = 0
        text.backgroundColor = .clear
        text.textColor = UIColor(red: 0xE5 / 255.0, green: 0xE7 / 255.0, blue: 0xEB / 255.0, alpha: 1)
        text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        text.isEditable = false
        text.textContainerInset = .zero
        text.textContainer.lineFragmentPadding = 0
        text.accessibilityIdentifier = "zn-dev-error-text"
        let dismiss = Self.button("Dismiss", #selector(dismissTapped), self)
        let reload = Self.button("Reload", #selector(reloadTapped), self)
        let row = UIStackView(arrangedSubviews: [dismiss, reload, UIView()])
        row.axis = .horizontal
        row.spacing = 12
        let column = UIStackView(arrangedSubviews: [title, text, row])
        column.axis = .vertical
        column.spacing = 12
        column.alignment = .fill
        column.translatesAutoresizingMaskIntoConstraints = false
        addSubview(column)
        let g = safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            column.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            column.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            column.topAnchor.constraint(equalTo: g.topAnchor, constant: 16),
            column.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    func set(title t: String, text body: String) {
        title.text = t
        text.text = body
        text.setContentOffset(.zero, animated: false)
    }

    private static func button(_ label: String, _ action: Selector, _ target: Any) -> UIButton {
        var config = UIButton.Configuration.filled()
        config.title = label
        config.baseBackgroundColor = UIColor(red: 0x37 / 255.0, green: 0x41 / 255.0, blue: 0x51 / 255.0, alpha: 1)
        config.baseForegroundColor = .white
        config.cornerStyle = .fixed
        config.background.cornerRadius = 8
        config.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { a in
            var a = a
            a.font = .systemFont(ofSize: 14, weight: .medium)
            return a
        }
        let b = UIButton(configuration: config)
        b.setContentHuggingPriority(.required, for: .horizontal)
        b.setContentHuggingPriority(.required, for: .vertical)
        b.accessibilityIdentifier = "zn-dev-\(label.lowercased())"
        b.addTarget(target, action: action, for: .touchUpInside)
        return b
    }

    @objc private func dismissTapped() { onDismiss() }
    @objc private func reloadTapped() { onReload() }
}
#endif
