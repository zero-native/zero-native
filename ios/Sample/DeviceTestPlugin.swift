// The sample's test plugin on iOS, as plugins/device-test's DeviceTestPlugin.kt: a native screen and a native view for
// the core check (CoreLabScreen.tsx), and the Device module's parts iOS can do: info, slowEcho, fail, and the two
// launches of the Launch lab (LaunchScreen.tsx). The rest (Kotlin storage, tasks, motion sources) answers "unavailable".
import UIKit
#if canImport(ZnRuntime)
import ZnRuntime
#endif

struct DeviceTestPlugin: ZnPlugin {
    func register(_ r: ZnPluginRegistry) {
        r.screen("device.fake-screen") { scope in FakeScreen(scope) }
        r.view("device.fake-view") { scope in FakeView(scope) }
        r.module(DeviceModule())
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
private final class FakeView: UIView {
    let scope: ZnViewScope
    let label = UILabel()

    init(_ scope: ZnViewScope) {
        self.scope = scope
        super.init(frame: .zero)
        backgroundColor = UIColor(red: 0xDD / 255, green: 0xEE / 255, blue: 1, alpha: 1)
        addSubview(label)
        show(scope.props)
        scope.onProps = { [weak self] p in self?.show(p) }
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        label.frame = bounds.insetBy(dx: 12, dy: 12)
    }

    private func show(_ p: [String: Any]) { label.text = "view says \(p["label"] as? String ?? "none")" }

    @objc private func tapped() { scope.emit("tapped", ["label": scope.props["label"] as? String ?? "none"]) }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        print("zn-sample fake view: \(window == nil ? "off screen" : "on screen")")
    }
}
