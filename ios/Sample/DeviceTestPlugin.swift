// The sample's test plugin on iOS, as plugins/device-test's DeviceTestPlugin.kt: a native screen and a native view for
// the core check (CoreLabScreen.tsx). The plugin's Device module (storage, launches, tasks) is Android-only so far.
import UIKit

struct DeviceTestPlugin: ZnPlugin {
    func register(_ r: ZnPluginRegistry) {
        r.screen("device.fake-screen") { scope in FakeScreen(scope) }
        r.view("device.fake-view") { scope in FakeView(scope) }
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
