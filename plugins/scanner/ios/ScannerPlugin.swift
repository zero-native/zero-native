// The scanner plugin on iOS (plugins/scanner, as android/.../ScannerPlugin.kt, ScannerScreen.kt, ScannerView.kt,
// ScannerParts.kt, ScannerTexts.kt): the "Scanner" module, the full screen "scanner.full" (answers `{ value, format }`
// once; close and Back answer null) and the view "scanner.qr" (events scanned, permission, error, torch). Same words,
// colours and layout as Android's: the dark shade with a clear square, corner marks and a moving line, the title at
// the top, the hint and an http(s) link at the bottom, round close and torch buttons, and messages for permission and
// failure. The app's Info.plist needs NSCameraUsageDescription.
import AVFoundation
import UIKit

struct ScannerPlugin: ZnPlugin {
    func register(_ r: ZnPluginRegistry) {
        r.module(ScannerModule())
        r.screen("scanner.full") { scope in ScannerScreen(scope) }
        r.view("scanner.qr") { scope in ScannerView(scope) }
    }
}

final class ScannerModule: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("Scanner", version: 1)
        function("available") { call in call.resolve(AVCaptureDevice.default(for: .video) != nil) }
    }
}

/// Words and colours, from the route's params or the view's props. The defaults are plain and belong to no brand.
struct ScannerTexts {
    let title, hint, linkLabel, close, torchOn, torchOff: String
    let permissionTitle, permissionBody, blockedBody, allow, settings, failedTitle, failedBody, retry: String
    let linkUrl: URL?
    let accent, button, buttonText: UIColor
    let formats: [String]
    let zoom: CGFloat?
    let pinch: Bool

    init(_ p: [String: Any]) {
        func t(_ k: String, _ d: String) -> String { p[k] as? String ?? d }
        func c(_ k: String, _ d: UIColor) -> UIColor {
            guard let s = p[k] as? String, s.count == 7, s.first == "#", let v = UInt32(s.dropFirst(), radix: 16) else { return d }
            return UIColor(red: CGFloat(v >> 16 & 0xFF) / 255, green: CGFloat(v >> 8 & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
        }
        title = t("title", "Scan a QR code"); hint = t("hint", ""); linkLabel = t("linkLabel", "")
        close = t("closeLabel", "Close"); torchOn = t("torchOnLabel", "Turn flash on"); torchOff = t("torchOffLabel", "Turn flash off")
        permissionTitle = t("permissionTitle", "Camera is off"); permissionBody = t("permissionBody", "Allow the camera to scan codes.")
        blockedBody = t("blockedBody", "Turn on the camera for this app in Settings.")
        allow = t("allowLabel", "Allow camera"); settings = t("settingsLabel", "Open settings")
        failedTitle = t("failedTitle", "Camera can't start")
        failedBody = t("failedBody", "Another app may be using it. Close that app and try again.")
        retry = t("retryLabel", "Try again")
        linkUrl = ScannerRules.safeLink(p["linkUrl"] as? String)
        accent = c("accentColor", .white); button = c("buttonColor", .white)
        buttonText = c("buttonTextColor", UIColor(red: 0x11 / 255, green: 0x11 / 255, blue: 0x11 / 255, alpha: 1))
        formats = p["formats"] as? [String] ?? []
        zoom = (p["zoom"] as? NSNumber).map { CGFloat($0.doubleValue) }.flatMap { $0 > 0 ? $0 : nil }
        pinch = p["pinchZoom"] as? Bool ?? true
    }
}

// MARK: - Parts

private let panel = UIColor(red: 0x14 / 255, green: 0x16 / 255, blue: 0x1A / 255, alpha: 1)
private let muted = UIColor(red: 0xA6 / 255, green: 0xAC / 255, blue: 0xB5 / 255, alpha: 1)

/// The dark shade with a clear square (75 % of the short side), corner marks and a line moving up and down (2.5 s).
final class ScanFrameView: UIView {
    let accent: UIColor
    private let shade = CAShapeLayer()
    private let marks = CAShapeLayer()
    private let line = CALayer()

    init(accent: UIColor) {
        self.accent = accent
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        shade.fillRule = .evenOdd
        shade.fillColor = UIColor(white: 0, alpha: 0.4).cgColor
        marks.strokeColor = accent.cgColor
        marks.fillColor = nil
        marks.lineWidth = 4
        marks.lineCap = .round
        line.backgroundColor = accent.cgColor
        line.shadowColor = accent.cgColor
        line.shadowOpacity = 0.5
        line.shadowRadius = 3
        line.shadowOffset = .zero
        [shade, marks, line].forEach(layer.addSublayer)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = min(bounds.width, bounds.height) * 0.75
        let box = CGRect(x: (bounds.width - side) / 2, y: (bounds.height - side) / 2, width: side, height: side)
        let p = UIBezierPath(rect: bounds)
        p.append(UIBezierPath(roundedRect: box, cornerRadius: 6))
        shade.path = p.cgPath
        let m = UIBezierPath(), e: CGFloat = 12.5, len: CGFloat = 30, b = box.insetBy(dx: -e, dy: -e)
        for (corner, dx, dy) in [(CGPoint(x: b.minX, y: b.minY), 1.0, 1.0), (CGPoint(x: b.maxX, y: b.minY), -1.0, 1.0),
                                 (CGPoint(x: b.minX, y: b.maxY), 1.0, -1.0), (CGPoint(x: b.maxX, y: b.maxY), -1.0, -1.0)] {
            m.move(to: CGPoint(x: corner.x, y: corner.y + dy * len))
            m.addLine(to: corner)
            m.addLine(to: CGPoint(x: corner.x + dx * len, y: corner.y))
        }
        marks.path = m.cgPath
        let half = side * 0.4, inset: CGFloat = 24
        line.frame = CGRect(x: bounds.midX - half, y: box.minY + inset, width: half * 2, height: 2)
        line.removeAllAnimations()
        let move = CABasicAnimation(keyPath: "position.y")
        move.fromValue = box.minY + inset
        move.toValue = box.maxY - inset
        move.duration = 2.5
        move.autoreverses = true
        move.repeatCount = .infinity
        move.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        line.add(move, forKey: "scan")
    }
}

/// A title, a line of text and a button, centred on the dark panel (permission and failure messages).
final class ScannerMessageView: UIView {
    init(title: String, body: String, action: String?, texts: ScannerTexts, onAction: @escaping () -> Void) {
        super.init(frame: .zero)
        backgroundColor = panel
        let icon = UIImageView(image: UIImage(systemName: "camera"))
        icon.tintColor = .white
        icon.contentMode = .center
        icon.backgroundColor = UIColor(white: 1, alpha: 0.1)
        icon.layer.cornerRadius = 36
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.widthAnchor.constraint(equalToConstant: 72).isActive = true
        icon.heightAnchor.constraint(equalToConstant: 72).isActive = true
        let t = UILabel(), b = UILabel()
        t.text = title; t.font = .boldSystemFont(ofSize: 20); t.textColor = .white; t.textAlignment = .center; t.numberOfLines = 0
        b.text = body; b.font = .systemFont(ofSize: 14); b.textColor = muted; b.textAlignment = .center; b.numberOfLines = 0
        var views: [UIView] = [icon, t, b]
        if let action {
            var conf = UIButton.Configuration.filled()
            conf.title = action
            conf.baseBackgroundColor = texts.button
            conf.baseForegroundColor = texts.buttonText
            conf.cornerStyle = .capsule
            conf.contentInsets = NSDirectionalEdgeInsets(top: 14, leading: 28, bottom: 14, trailing: 28)
            views.append(UIButton(configuration: conf, primaryAction: UIAction { _ in onAction() }))
        }
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -24),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    /// The permission message: "Allow camera" asks (first time), "Open settings" once iOS won't ask again.
    static func permission(_ state: ScanPermission, _ texts: ScannerTexts, asked: @escaping () -> Void) -> ScannerMessageView {
        let blocked = state == .blocked
        return ScannerMessageView(title: texts.permissionTitle, body: blocked ? texts.blockedBody : texts.permissionBody,
                                  action: blocked ? texts.settings : texts.allow, texts: texts) {
            if blocked {
                if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
            } else {
                AVCaptureDevice.requestAccess(for: .video) { _ in DispatchQueue.main.async(execute: asked) }
            }
        }
    }
}

/// [v] fills [parent], whatever size the parent has now (it may not be laid out yet).
private func pin(_ v: UIView, to parent: UIView) {
    v.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        v.topAnchor.constraint(equalTo: parent.topAnchor), v.bottomAnchor.constraint(equalTo: parent.bottomAnchor),
        v.leadingAnchor.constraint(equalTo: parent.leadingAnchor), v.trailingAnchor.constraint(equalTo: parent.trailingAnchor),
    ])
}

private func roundButton(_ symbol: String, label: String, _ action: @escaping () -> Void) -> UIButton {
    var conf = UIButton.Configuration.plain()
    conf.image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
    conf.baseForegroundColor = .white
    let b = UIButton(configuration: conf, primaryAction: UIAction { _ in action() })
    b.backgroundColor = UIColor(white: 0, alpha: 0.3)
    b.layer.cornerRadius = 22
    b.layer.borderWidth = 1
    b.layer.borderColor = UIColor(white: 1, alpha: 0.2).cgColor
    b.accessibilityLabel = label
    b.translatesAutoresizingMaskIntoConstraints = false
    b.widthAnchor.constraint(equalToConstant: 44).isActive = true
    b.heightAnchor.constraint(equalToConstant: 44).isActive = true
    return b
}

// MARK: - The full screen

/// The full scanner (`nav.pushForResult`). The app's route needs `safeArea: "none"`: the camera runs under the status bar.
final class ScannerScreen: UIViewController {
    let scope: ZnScreenScope
    let texts: ScannerTexts
    private let gate = ScanGate()
    private var content: UIView?
    private var camera: ScannerCameraView?
    private var torchButton: UIButton?
    private var closeButton: UIButton?

    init(_ scope: ZnScreenScope) {
        self.scope = scope
        texts = ScannerTexts(scope.params)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        NotificationCenter.default.addObserver(self, selector: #selector(back), name: UIApplication.didBecomeActiveNotification, object: nil)
        if ScanPermission.askable && ScannerRules.fakeCode == nil {
            AVCaptureDevice.requestAccess(for: .video) { _ in DispatchQueue.main.async { self.show() } }
        }
        show()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    /// Permission is read again at every return (it may have changed in Settings).
    @objc private func back() { if (camera != nil) != (ScanPermission.now == .granted) { show() } }

    private func show() {
        content?.removeFromSuperview()
        camera = nil
        torchButton = nil
        let state = ScanPermission.now
        let page: UIView
        if state == .granted || ScannerRules.fakeCode != nil {
            page = cameraPage()
        } else if ScanPermission.askable {
            page = UIView()  // iOS's dialog is open
        } else {
            page = ScannerMessageView.permission(state, texts) { [weak self] in self?.show() }
        }
        page.frame = view.bounds
        page.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.insertSubview(page, at: 0)
        content = page
        let close = roundButton("xmark", label: texts.close) { [weak self] in self?.scope.cancel() }
        page.addSubview(close)
        closeButton = close
        NSLayoutConstraint.activate([
            close.topAnchor.constraint(equalTo: page.safeAreaLayoutGuide.topAnchor, constant: 8),
            close.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 16),
        ])
    }

    private func cameraPage() -> UIView {
        let page = UIView()
        let cam = ScannerCameraView(gate: gate)
        cam.formats = texts.formats
        cam.zoom = texts.zoom
        cam.pinch = texts.pinch
        cam.onCode = { [weak self] value, format in
            guard let self else { return }
            cam.running = false  // the camera stops while the code is handled, also behind the closing animation
            print("zn scanner: read \(format)")
            self.scope.finish(["value": value, "format": format])
        }
        cam.onFailed = { [weak self, weak cam] failed in
            guard let self, failed, let cam else { return }
            let m = ScannerMessageView(title: self.texts.failedTitle, body: self.texts.failedBody, action: self.texts.retry, texts: self.texts) { [weak cam] in
                cam?.superview?.subviews.compactMap { $0 as? ScannerMessageView }.forEach { $0.removeFromSuperview() }
                cam?.retry()
            }
            // Over the whole page (frame, title and hint), under the close button.
            page.addSubview(m)
            pin(m, to: page)
            self.closeButton.map { page.bringSubviewToFront($0) }
        }
        cam.onFlash = { [weak self] has in self?.torchButton?.isHidden = !has }
        cam.onLeft = { [weak self] in self?.updateTorchButton(false) }
        cam.frame = page.bounds
        cam.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        page.addSubview(cam)
        camera = cam
        let frame = ScanFrameView(accent: texts.accent)
        frame.frame = page.bounds
        frame.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        page.addSubview(frame)
        addTexts(to: page)
        let torch = roundButton("bolt.slash", label: texts.torchOn) { [weak self] in
            guard let self, let cam = self.camera else { return }
            cam.torch.toggle()
            self.updateTorchButton(cam.torch)
        }
        torch.isHidden = true
        page.addSubview(torch)
        NSLayoutConstraint.activate([
            torch.topAnchor.constraint(equalTo: page.safeAreaLayoutGuide.topAnchor, constant: 8),
            torch.trailingAnchor.constraint(equalTo: page.trailingAnchor, constant: -16),
        ])
        torchButton = torch
        return page
    }

    private func updateTorchButton(_ on: Bool) {
        guard let b = torchButton else { return }
        b.configuration?.image = UIImage(systemName: on ? "bolt.fill" : "bolt.slash",
                                         withConfiguration: UIImage.SymbolConfiguration(pointSize: 18, weight: .semibold))
        b.accessibilityLabel = on ? texts.torchOff : texts.torchOn
    }

    /// The title under the top bar, and the hint and link at the bottom, on soft dark gradients.
    private func addTexts(to page: UIView) {
        let title = UILabel()
        title.text = texts.title
        title.textColor = .white
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        title.textAlignment = .center
        title.numberOfLines = 0
        title.translatesAutoresizingMaskIntoConstraints = false
        page.addSubview(title)
        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: page.safeAreaLayoutGuide.topAnchor, constant: 64),
            title.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 24),
            title.trailingAnchor.constraint(equalTo: page.trailingAnchor, constant: -24),
        ])
        var bottom: [UIView] = []
        if !texts.hint.isEmpty {
            let hint = UILabel()
            hint.text = texts.hint
            hint.textColor = .white
            hint.font = .systemFont(ofSize: 15, weight: .medium)
            hint.textAlignment = .center
            hint.numberOfLines = 0
            bottom.append(hint)
        }
        if !texts.linkLabel.isEmpty, let url = texts.linkUrl {
            var conf = UIButton.Configuration.plain()
            conf.title = texts.linkLabel
            conf.baseForegroundColor = .white
            conf.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 24, bottom: 12, trailing: 24)
            let link = UIButton(configuration: conf, primaryAction: UIAction { _ in UIApplication.shared.open(url) })
            link.backgroundColor = UIColor(white: 0, alpha: 0.3)
            link.layer.cornerRadius = 22
            link.layer.borderWidth = 1
            link.layer.borderColor = texts.accent.cgColor
            bottom.append(link)
        }
        guard !bottom.isEmpty else { return }
        let stack = UIStackView(arrangedSubviews: bottom)
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 24
        stack.translatesAutoresizingMaskIntoConstraints = false
        page.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.bottomAnchor.constraint(equalTo: page.safeAreaLayoutGuide.bottomAnchor, constant: -42),
            stack.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: page.trailingAnchor, constant: -24),
        ])
    }
}

// MARK: - The view

/// The camera inside a JS screen (`QrScanner`). After one code it stops and waits; a new `scanKey` scans again. Events:
/// scanned, permission, error, torch (it went off by itself).
final class ScannerView: UIView {
    let scope: ZnViewScope
    private let gate = ScanGate()
    private var texts: ScannerTexts
    private var camera: ScannerCameraView?
    private var message: UIView?
    private var lastKey: String
    private var held = false
    private var lastPermission: ScanPermission?

    init(_ scope: ZnViewScope) {
        self.scope = scope
        texts = ScannerTexts(scope.props)
        lastKey = scope.props["scanKey"] as? String ?? ""
        super.init(frame: .zero)
        backgroundColor = .black
        clipsToBounds = true
        scope.onProps = { [weak self] p in self?.apply(p) }
        NotificationCenter.default.addObserver(self, selector: #selector(back), name: UIApplication.didBecomeActiveNotification, object: nil)
        let ask = scope.props["askPermission"] as? Bool ?? true
        if ask && ScanPermission.askable && ScannerRules.fakeCode == nil {
            AVCaptureDevice.requestAccess(for: .video) { _ in DispatchQueue.main.async { self.show() } }
        }
        show()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit { NotificationCenter.default.removeObserver(self) }

    @objc private func back() { show() }

    private var fake: Bool { ScannerRules.fakeCode != nil }

    private func show() {
        let state = fake ? .granted : ScanPermission.now
        if state != lastPermission, !(state == .denied && ScanPermission.askable && (scope.props["askPermission"] as? Bool ?? true)) {
            lastPermission = state
            scope.emit("permission", ["state": state.rawValue])
        }
        if state == .granted {
            message?.removeFromSuperview()
            message = nil
            if camera == nil {
                let cam = ScannerCameraView(gate: gate)
                cam.formats = texts.formats
                cam.zoom = texts.zoom
                cam.pinch = texts.pinch
                cam.onCode = { [weak self] value, format in
                    self?.camera?.running = false
                    self?.scope.emit("scanned", ["value": value, "format": format])
                }
                cam.onFailed = { [weak self] failed in
                    guard let self, failed else { return }
                    self.scope.emit("error", ["code": "camera_failed", "message": "the camera can't start"])
                    let m = ScannerMessageView(title: self.texts.failedTitle, body: self.texts.failedBody, action: self.texts.retry,
                                               texts: self.texts) { [weak self] in
                        self?.message?.removeFromSuperview()
                        self?.message = nil
                        self?.camera?.retry()
                    }
                    self.place(m)
                }
                cam.onLeft = { [weak self] in
                    guard let self else { return }
                    self.scope.emit("torch", ["on": false])
                    self.held = TorchRule.heldAfterLeaving(true, held: self.held)
                }
                cam.frame = bounds
                cam.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                insertSubview(cam, at: 0)
                camera = cam
            }
            apply(scope.props)
        } else if message == nil || camera != nil {
            camera?.removeFromSuperview()
            camera = nil
            place(ScannerMessageView.permission(state, texts) { [weak self] in self?.show() })
        }
    }

    private func place(_ m: UIView) {
        message?.removeFromSuperview()
        addSubview(m)
        pin(m, to: self)
        message = m
    }

    private func apply(_ p: [String: Any]) {
        let key = p["scanKey"] as? String ?? ""
        if key != lastKey {
            lastKey = key
            gate.release()
        }
        let wanted = p["torch"] as? Bool ?? false
        held = TorchRule.heldAfterProp(wanted, held: held)
        guard let cam = camera else { return }
        cam.running = (p["active"] as? Bool ?? true) && !gate.locked
        cam.torch = TorchRule.isOn(wanted, held: held)
    }
}
