// The sample's test plugin on iOS, as plugins/device-test's DeviceTestPlugin.kt: a native screen and a native view for
// the core check (CoreLabScreen.tsx), and the Device module's parts iOS can do: info, slowEcho, fail, and the two
// launches of the Launch lab (LaunchScreen.tsx), storage shared with JS (StorageScreen.tsx), runTask (CoreLabScreen.tsx),
// and the plugin motion parts (ZnMotionApi.swift; MotionExtensionLab.tsx, MotionCoreLab.tsx): the orbit value stepped
// each frame, the "device.wobble" curve, and the fake view's bar drawn from a motion `level`.
// The rest (crash, makeFile) answers "unavailable".
import UIKit
#if canImport(ZnRuntime)
import ZnRuntime
#endif

struct DeviceTestPlugin: ZnPlugin {
    func register(_ r: ZnPluginRegistry) {
        r.screen("device.fake-screen") { scope in FakeScreen(scope) }
        r.view("device.fake-view") { scope in FakeView(scope) }
        r.module(DeviceModule())
        // A custom motion curve (lab 9, DeviceTestPlugin.kt): v.to(x, wobble()) overshoots and rings like a struck
        // bell, `rings` times.
        ZnMotionApi.registerDriver("device.wobble") { from, to, _, p in
            let rings = Float(min(max((p["rings"] as? NSNumber)?.doubleValue ?? 3, 1), 10))
            let ms = min(max((p["ms"] as? NSNumber)?.int64Value ?? 900, 50), 10_000)
            return Wobble(from: from, to: to, durationNanos: ms * 1_000_000, w: rings * 2 * .pi)
        }
    }
}

/// One wobble: to + (from - to) * e^(-5t) * cos(w t), t from 0 to 1 over the run (DeviceTestPlugin.kt's driver).
private struct Wobble: ZnMotionDriver {
    let from: Float, to: Float
    let durationNanos: Int64
    let w: Float

    func value(_ timeNanos: Int64) -> Float {
        let t = Float(timeNanos) / Float(durationNanos)
        return to + (from - to) * exp(-5 * t) * cos(w * t)
    }

    func velocity(_ timeNanos: Int64) -> Float {
        let t = Float(timeNanos) / Float(durationNanos)
        let d = (from - to) * exp(-5 * t) * (-5 * cos(w * t) - w * sin(w * t))
        return d * 1e9 / Float(durationNanos)
    }
}

/// Device v6 (plugins/device-test/src/index.ts), the parts iOS can do.
private final class DeviceModule: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("Device", version: 6)
        function("info") { call in call.resolve(["model": ZnOs.model, "android": "", "sdk": 0]) }
        function("slowEcho") { call in
            let text = try call.string("text"), ms = (call.args["ms"] as? NSNumber)?.doubleValue ?? 0
            DispatchQueue.global().asyncAfter(deadline: .now() + ms / 1000) { if !call.isCancelled { call.resolve(text) } }
        }
        function("fail") { call in call.reject("no_luck", "this call always fails") }
        // v6: a plugin motion source (DeviceModule.kt orbit, lab 9): the value JS made with id `id` goes round a circle
        // of `radius` pt every `periodMs`, stepped natively each frame (x for "x", y for "y"). It stops when JS drops
        // the value. The kind of work a formula can't do (here: time itself).
        function("orbit", onMain: true) { call in
            let id = try call.int("id")
            let radius = Float(try call.doubleOrNil("radius") ?? 40)
            let period = Int64(max(try call.intOrNil("periodMs") ?? 2000, 100)) * 1_000_000
            let useY = try call.stringOrNil("axis") == "y"
            MainActor.assumeIsolated {
                let handle = ZnMotionApi.value(id)
                var start: Int64 = -1
                let frames = ZnMotionApi.onFrame { now in
                    if start < 0 { start = now }
                    let a = Float((now - start) % period) / Float(period) * (2 * .pi)
                    handle.value = radius * (useY ? sin(a) : cos(a))
                    return true
                }
                handle.onDispose { frames.cancel() }
            }
            call.resolve()
        }
        // Storage shared with JS (DeviceModule.kt storageEcho): reads what JS wrote, writes values JS then checks.
        function("storageEcho") { call in
            let store = ZnStorage.store()
            let fromJs = store.string("dev.fromJs")
            store.set("dev.fromKotlin", "\(fromJs ?? "null") ← Kotlin")  // the key and text the lab checks on both
            store.set("dev.kotlinNumber", 42.5)
            store.set("dev.kotlinFlag", true)
            // A typed getter of another type answers nil on iOS (Android's throws): Android's message, made here.
            let typeError: String
            if store.number("dev.fromJs") != nil {
                typeError = "no error"
            } else if case .string = store.get("dev.fromJs") {
                typeError = "ZnStorage: \"dev.fromJs\" in \"\(store.id)\" holds a string, not a number"
            } else {
                typeError = "dev.fromJs is missing"
            }
            call.resolve(["fromJs": fromJs as Any? ?? NSNull(), "typeError": typeError])
        }
        // Like a push handler writing while the app is in use: the module's queue (not JS's thread) writes its own
        // counter and a key JS writes too, `count` times, while JS does the same (DeviceModule.kt storageHammer).
        function("storageHammer") { call in
            let count = (call.args["count"] as? NSNumber)?.intValue ?? 20_000
            let store = ZnStorage.store()
            let t0 = CACurrentMediaTime()
            for i in stride(from: 1, through: count, by: 1) {
                store.set("dev.hammer.kotlin", i)
                store.set("dev.hammer.shared", "kotlin \(i):" + String(repeating: "k", count: i % 300) + ":\(i)")
            }
            call.resolve(["count": count, "ms": Int((CACurrentMediaTime() - t0) * 1000)])
        }
        // v5: runs a background task, as a plugin would (DeviceModule.kt runTask): DONE, FAILED, NO_TASK or TIMED_OUT.
        function("runTask") { call in
            let name = try call.string("name"), timeoutMs = (call.args["timeoutMs"] as? NSNumber)?.intValue ?? 5_000
            ZnTasks.shared.run(name, ["from": "lab"], timeoutMs: timeoutMs) { outcome in call.resolve(Self.kotlinName(outcome)) }
        }
        // The mock UPI app is an Android test app. On iOS: a web page in Safari stands in for the other app. Come back by
        // switching apps (resultCode 0) or by a link (`xcrun simctl openurl booted "zn://sample/dev/launch?…"`, -1).
        function("openMockUpi", onMain: true) { call in
            let id = try call.string("id")
            MainActor.assumeIsolated {
                ZnLaunch.open("mock-upi", id: id, url: URL(string: "https://example.com/?zn-mock-upi")!) { ok, reason in
                    call.resolve(ok ? ["launched": true] : ["launched": false, "reason": reason ?? "failed"])
                }
            }
        }
        function("openMissingApp", onMain: true) { call in
            let id = try call.string("id")
            MainActor.assumeIsolated {
                ZnLaunch.open("mock-missing", id: id, url: URL(string: "zn-missing-app://x")!) { ok, reason in
                    call.resolve(ok ? ["launched": true] : ["launched": false, "reason": reason ?? "failed"])
                }
            }
        }
    }

    /// Kotlin's ZnBackground.Outcome names, which the lab shows.
    private static func kotlinName(_ o: ZnTasks.Outcome) -> String {
        switch o {
        case .done: "DONE"
        case .failed: "FAILED"
        case .noTask: "NO_TASK"
        case .timedOut: "TIMED_OUT"
        }
    }
}

/// A native screen: its params' title, and buttons that answer once, twice (only the first counts) or cancel.
private final class FakeScreen: UIViewController {
    let scope: ZnScreenScope
    init(_ scope: ZnScreenScope) {
        self.scope = scope
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        print("zn t=\(ZnDebug.ms()) device fake screen: viewDidLoad")  // when (ZnNavController loads it as it shows)
        view.backgroundColor = .white
        let title = UILabel()
        title.text = "fake screen: \(scope.params["title"] as? String ?? "no title")"
        let stack = UIStackView(arrangedSubviews: [title,
            button("Finish") { [scope] in scope.finish(["code": "abc"]) },
            button("Finish twice") { [scope] in
                scope.finish(["code": "first"])
                scope.finish(["code": "second"])
            },
            button("Cancel") { [scope] in scope.cancel() }])
        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
        ])
    }

    private func button(_ title: String, _ action: @escaping () -> Void) -> UIButton {
        let b = UIButton(type: .system, primaryAction: UIAction { _ in action() })
        b.setTitle(title, for: .normal)
        return b
    }
}

/// A native view: shows its `label` prop, sends "tapped" with it, and logs when it comes on and leaves the screen.
/// Registry 24 (lab 9): `level` may be a motion value; a bar 24 pt under the text shows it (0 to 1), set on each frame
/// it moves, with no JS (FakeNative.kt draws it in drawBehind).
private final class FakeView: UIView {
    let scope: ZnViewScope
    let label = UILabel()
    private let bar = CALayer()
    private var level: Float = 0

    init(_ scope: ZnViewScope) {
        self.scope = scope
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0xDD / 255, green: 0xEE / 255, blue: 1, alpha: 1)
        addSubview(label)
        bar.backgroundColor = UIColor(red: 0x5B / 255, green: 0x5B / 255, blue: 0xD6 / 255, alpha: 1).cgColor
        layer.addSublayer(bar)
        show(scope.props)
        scope.onProps = { [weak self] p in self?.show(p) }
        scope.onMotion("level") { [weak self] v in
            self?.level = v
            self?.placeBar()
        }
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let line = label.font.lineHeight.rounded(.up)
        label.frame = bar.isHidden ? bounds.insetBy(dx: 12, dy: 12) : CGRect(x: 12, y: 12, width: max(0, bounds.width - 24), height: line)
        placeBar()
    }

    /// The bar's width: the padded width times the level now (no implicit layer animation: it follows each frame).
    private func placeBar() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let f = CGFloat(min(max(level, 0), 1))
        bar.frame = CGRect(x: 12, y: 36, width: max(0, bounds.width - 24) * f, height: 6)
        CATransaction.commit()
    }

    private func show(_ p: [String: Any]) {
        label.text = "view says \(p["label"] as? String ?? "none")"
        let drawn = scope.motion("level") != nil
        if bar.isHidden == drawn {
            bar.isHidden = !drawn
            setNeedsLayout()
        }
    }

    @objc private func tapped() { scope.emit("tapped", ["label": scope.props["label"] as? String ?? "none"]) }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        print("zn-sample fake view: \(window == nil ? "off screen" : "on screen")")
    }
}
