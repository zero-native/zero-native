// The scanner's iOS side (plugins/scanner, as android/.../ScannerRules.kt, ScannerCamera.kt, CameraSession.kt): the
// rules apart from the camera, and the camera itself (AVFoundation: AVCaptureSession, a preview layer, and
// AVCaptureMetadataOutput, iOS's own code reader: no ML Kit, no download).
//
// The same rules as Android:
// - Old frames: the camera can hand over an old picture (the last counter's QR), so codes are ignored for 500 ms from
//   the session's first frame, at every start.
// - Double scan: the first code locks at once; stop / start (background and back) doesn't unlock; only release does.
// - Torch: off when the camera stops, and a view's torch stays off until the prop goes false then true (TorchRule).
// - Zoom: `zoom` at the start, kept inside what the camera can do; pinch on by default; `autoZoom` has no iOS
//   counterpart (AVFoundation has no "zoom in to this code" suggestion), so it is ignored.
// - Permission: asked when the scanner opens. iOS asks once: refused is "blocked" (only Settings changes it), as
//   Android's "don't ask again".
//
// Debug builds on the simulator (no camera): with the launch environment ZN_SCANNER_FAKE=<code>, the scanner shows a
// grey picture and reads that code (format qr) after the warm-up, so the screen, the view and their answers can be
// checked without a camera.
import AVFoundation
import UIKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif

enum ScannerRules {
    static let warmupMs = 500.0

    /// Debug builds on a device with no camera (the simulator): the code ZN_SCANNER_FAKE asks to read, or nil.
    static var fakeCode: String? {
        #if DEBUG
        guard AVCaptureDevice.default(for: .video) == nil else { return nil }
        return ProcessInfo.processInfo.environment["ZN_SCANNER_FAKE"]
        #else
        return nil
        #endif
    }

    /// AVFoundation's types by the names JS uses.
    static let formats: [String: AVMetadataObject.ObjectType] = [
        "qr": .qr, "aztec": .aztec, "datamatrix": .dataMatrix, "pdf417": .pdf417, "ean13": .ean13, "ean8": .ean8,
        "upca": .ean13, "upce": .upce, "code128": .code128, "code39": .code39, "code93": .code93, "codabar": .codabar,
        "itf": .itf14,
    ]

    /// The types to look for. QR only unless the app asks: fewer false reads.
    static func types(_ names: [String]) -> [AVMetadataObject.ObjectType] {
        let t = names.compactMap { formats[$0] }
        return t.isEmpty ? [.qr] : Array(Set(t))
    }

    /// The JS name of a type. A UPC-A comes as an EAN-13 starting with 0 on iOS: named "upca" when the app asked for it.
    static func name(_ type: AVMetadataObject.ObjectType, _ value: String, asked: [String]) -> String {
        if type == .ean13 && value.hasPrefix("0") && asked.contains("upca") && !asked.contains("ean13") { return "upca" }
        return formats.first { $0.value == type && $0.key != "upca" }?.key ?? "unknown"
    }

    /// Only web links: an OTA bundle sets this text, and it must not be able to open a payment link.
    static func safeLink(_ url: String?) -> URL? {
        guard let url, url.hasPrefix("https://") || url.hasPrefix("http://") else { return nil }
        return URL(string: url)
    }
}

/// Which frames count and which code wins (ScanGate in ScannerRules.kt). Main thread.
final class ScanGate {
    private var run = 0
    private var open = false
    private var firstFrameAt: CFTimeInterval?
    private(set) var locked = false

    func start() { run += 1; open = true; firstFrameAt = nil }
    func stop() { run += 1; open = false }
    /// The camera delivered its first frame of this run.
    func firstFrame() { if firstFrameAt == nil { firstFrameAt = CACurrentMediaTime() } }

    /// A code was read: true for the first one, after the warm-up, of the current run only.
    func claim() -> Bool {
        guard open, !locked, let first = firstFrameAt, (CACurrentMediaTime() - first) * 1000 >= ScannerRules.warmupMs else { return false }
        locked = true
        return true
    }

    /// "Scan again": the next code counts.
    func release() { locked = false }
}

/// A view's torch (TorchRule in ScannerRules.kt).
enum TorchRule {
    static func isOn(_ wanted: Bool, held: Bool) -> Bool { wanted && !held }
    static func heldAfterLeaving(_ wanted: Bool, held: Bool) -> Bool { wanted || held }
    static func heldAfterProp(_ wanted: Bool, held: Bool) -> Bool { wanted && held }
}

/// Camera permission as JS names it.
enum ScanPermission: String {
    case granted, denied, blocked

    static var now: ScanPermission {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return .granted
        case .notDetermined: return .denied
        default: return .blocked  // refused or restricted: iOS doesn't ask again
        }
    }
    static var askable: Bool { AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined }
}

/// The camera: a preview that fills the view, reading codes into `onCode`. Runs while `running` and on screen (in a
/// window, app active); `failed` when the camera can't start.
final class ScannerCameraView: UIView, AVCaptureMetadataOutputObjectsDelegate {
    var onCode: ((String, String) -> Void)?
    var onFailed: ((Bool) -> Void)?
    var onFlash: ((Bool) -> Void)?
    /// The torch went off because the camera stopped (the screen left or the app went to the background).
    var onLeft: (() -> Void)?
    let gate: ScanGate
    var formats: [String] = []
    var zoom: CGFloat?
    var pinch = true
    var running = true { didSet { if running != oldValue { update() } } }
    var torch = false { didSet { if torch != oldValue { applyTorch() } } }

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "zn-scanner")
    private var preview: AVCaptureVideoPreviewLayer?
    private var device: AVCaptureDevice?
    private var configured = false
    private var started = false
    private var appActive = UIApplication.shared.applicationState != .background
    private var pinchStart: CGFloat = 1
    private var fake: String?
    private var fakeTimer: Timer?

    init(gate: ScanGate) {
        self.gate = gate
        super.init(frame: .zero)
        backgroundColor = .black
        fake = ScannerRules.fakeCode
        let nc = NotificationCenter.default
        nc.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(inactive), name: UIApplication.willResignActiveNotification, object: nil)
        nc.addObserver(self, selector: #selector(sessionStarted), name: .AVCaptureSessionDidStartRunning, object: session)
        nc.addObserver(self, selector: #selector(sessionFailed), name: .AVCaptureSessionRuntimeError, object: session)
        let pinchGesture = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        addGestureRecognizer(pinchGesture)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    deinit {
        NotificationCenter.default.removeObserver(self)
        let s = session
        queue.async { if s.isRunning { s.stopRunning() } }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        preview?.frame = bounds
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        update()
    }

    @objc private func active() { appActive = true; update() }
    @objc private func inactive() { appActive = false; update() }

    /// Retry after a failure.
    func retry() {
        configured = false
        update()
    }

    private var shouldRun: Bool { running && window != nil && appActive && (fake != nil || ScanPermission.now == .granted) }

    private func update() {
        if shouldRun { start() } else { stop() }
    }

    private func configure() -> Bool {
        if configured { return true }
        guard let d = AVCaptureDevice.default(for: .video), let input = try? AVCaptureDeviceInput(device: d) else { return false }
        session.beginConfiguration()
        session.inputs.forEach(session.removeInput)
        session.outputs.forEach(session.removeOutput)
        guard session.canAddInput(input) else { session.commitConfiguration(); return false }
        session.addInput(input)
        let out = AVCaptureMetadataOutput()
        guard session.canAddOutput(out) else { session.commitConfiguration(); return false }
        session.addOutput(out)
        out.setMetadataObjectsDelegate(self, queue: .main)
        let wanted = ScannerRules.types(formats)
        out.metadataObjectTypes = wanted.filter { out.availableMetadataObjectTypes.contains($0) }
        session.commitConfiguration()
        device = d
        if preview == nil {
            let p = AVCaptureVideoPreviewLayer(session: session)
            p.videoGravity = .resizeAspectFill
            p.frame = bounds
            layer.insertSublayer(p, at: 0)
            preview = p
        }
        if let z = zoom, (try? d.lockForConfiguration()) != nil {
            d.videoZoomFactor = min(max(z, d.minAvailableVideoZoomFactor), d.maxAvailableVideoZoomFactor)
            d.unlockForConfiguration()
        }
        onFlash?(d.hasTorch)
        configured = true
        return true
    }

    private func start() {
        guard !started else { return }
        if fake != nil {
            started = true
            backgroundColor = .darkGray
            gate.start()
            gate.firstFrame()
            print("zn scanner: no camera; reading the fake code (ZN_SCANNER_FAKE) after the warm-up")
            fakeTimer = Timer.scheduledTimer(withTimeInterval: ScannerRules.warmupMs / 1000 + 0.3, repeats: false) { [weak self] _ in
                guard let self, let code = self.fake, self.gate.claim() else { return }
                self.onCode?(code, "qr")
            }
            return
        }
        guard configure() else {
            print("zn scanner: the camera can't start")
            onFailed?(true)
            return
        }
        started = true
        gate.start()
        let s = session
        queue.async { s.startRunning() }
    }

    private func stop() {
        guard started else { return }
        started = false
        fakeTimer?.invalidate()
        gate.stop()
        if torch { setTorch(false); onLeft?() }
        let s = session
        queue.async { if s.isRunning { s.stopRunning() } }
    }

    @objc private func sessionStarted() {
        DispatchQueue.main.async {
            self.gate.firstFrame()
            self.applyTorch()
        }
    }

    @objc private func sessionFailed() {
        DispatchQueue.main.async { self.onFailed?(true) }
    }

    private func applyTorch() { setTorch(torch && started) }

    private func setTorch(_ on: Bool) {
        guard let d = device, d.hasTorch, (try? d.lockForConfiguration()) != nil else { return }
        d.torchMode = on ? .on : .off
        d.unlockForConfiguration()
    }

    @objc private func pinched(_ g: UIPinchGestureRecognizer) {
        guard pinch, let d = device else { return }
        if g.state == .began { pinchStart = d.videoZoomFactor }
        guard (try? d.lockForConfiguration()) != nil else { return }
        d.videoZoomFactor = min(max(pinchStart * g.scale, d.minAvailableVideoZoomFactor), min(d.maxAvailableVideoZoomFactor, 10))
        d.unlockForConfiguration()
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput objects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard let code = objects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first(where: { $0.stringValue != nil }),
              let value = code.stringValue, gate.claim() else { return }
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        onCode?(value, ScannerRules.name(code.type, value, asked: formats))
    }
}
