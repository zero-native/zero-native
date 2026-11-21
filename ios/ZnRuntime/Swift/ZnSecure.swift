// `secure: true` routes on iOS, as android/runtime's ZnNavHost.kt SecureWindow (FLAG_SECURE). iOS can't refuse a
// screenshot, so while a secure screen is drawn its content is left out of them instead:
// - What is drawn: each secure screen's view carries a ZnDrawnMarker, which counts itself while it is in the window
//   (Android's secureDrawn): from the frame the screen appears, through its exit or cover animation, until UIKit takes
//   its view out of the window.
// - Screenshots, screen recordings and mirroring (AirPlay, QuickTime): the window root's content sits inside a
//   UITextField's text canvas (ZnSecureContainer). While a secure screen is drawn the field is a password field
//   (isSecureTextEntry), and iOS then leaves the canvas out of every capture: they show the root's plain background.
//   Sheets, Modals, the app layers and toasts are inside it too (on Android they share the secure window). Alerts are
//   presented by UIKit outside it and stay visible in captures.
// - The app switcher: a plain cover in the screen's background colour from willResignActive to didBecomeActive (also
//   over Control Center and Notification Center, as banking apps do).
// The container is installed only when the bundle has a secure route (ZnRootController), so other apps keep the plain
// view tree. If a later iOS changes the text field's insides (no canvas found), it logs once and shows the cover while
// the screen is recorded or mirrored instead; screenshots then are not blanked.
import UIKit

@MainActor
final class ZnSecure {
    static let shared = ZnSecure()

    /// Secure screens in the window now (their markers). On at once; off one main-queue turn later, if still none:
    /// a transition moves a screen's view out of the window and back in the same turn (seen 2026-11-21 on a push).
    private var drawn = 0 {
        didSet {
            if drawn > 0 {
                if !on { apply() }
            } else if on {
                DispatchQueue.main.async { if self.drawn == 0 && self.on { self.apply() } }
            }
        }
    }
    /// The window root's container (ZnRootController), when the bundle has a secure route.
    private weak var container: ZnSecureContainer?
    private var cover: UIView?
    private var observing = false
    private var resigned = false

    /// True while a secure screen is drawn: captures must not show the screens.
    private(set) var on = false

    func install(_ c: ZnSecureContainer) {
        container = c
        observe()
        apply()
    }

    /// Where a toast goes in [window]: inside the protected content when there is one.
    func toastParent(in window: UIWindow) -> UIView? {
        guard let c = container, c.window === window else { return nil }
        return c.content
    }

    fileprivate func markerEntered() { drawn += 1 }
    fileprivate func markerLeft() { drawn = max(drawn - 1, 0) }

    private func apply() {
        on = drawn > 0
        print("zn t=\(ZnDebug.ms()) secure: \(on ? "on" : "off")\(container == nil ? " (no container)" : "")")
        container?.secure = on
        if !on { uncover(fade: false) } else if resigned || (container?.blanksCapture == false && captured) { coverUp() }
    }

    private func observe() {
        guard !observing else { return }
        observing = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                self.resigned = true
                if self.on { self.coverUp() }
            }
        }
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated {
                self.resigned = false
                if !(self.on && self.container?.blanksCapture == false && self.captured) { self.uncover(fade: true) }
            }
        }
    }

    /// The scene is being recorded or mirrored (the fallback when the canvas is missing).
    private var captured: Bool { container?.window?.windowScene?.traitCollection.sceneCaptureState == .active }

    /// The fallback: recording or mirroring started or stopped (ZnRootController's trait observer).
    func captureChanged() {
        guard container?.blanksCapture == false, on, !resigned else { return }
        print("zn t=\(ZnDebug.ms()) secure: capture \(captured ? "started: cover" : "ended")")
        if captured { coverUp() } else { uncover(fade: true) }
    }

    private func coverUp() {
        guard cover == nil, let window = container?.window ?? ZnOta.window() else { return }
        let v = UIView(frame: window.bounds)
        v.backgroundColor = ZnApp.shared.topBackground ?? .systemBackground
        v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        v.isUserInteractionEnabled = true
        window.addSubview(v)
        cover = v
        print("zn t=\(ZnDebug.ms()) secure: cover up")
    }

    private func uncover(fade: Bool) {
        guard let v = cover else { return }
        cover = nil
        print("zn t=\(ZnDebug.ms()) secure: cover down")
        guard fade else { return v.removeFromSuperview() }
        UIView.animate(withDuration: 0.1, animations: { v.alpha = 0 }, completion: { _ in v.removeFromSuperview() })
    }
}

/// Counts its screen as drawn while it is in the window (Android's DisposableEffect on a secure NavEntry).
final class ZnDrawnMarker: UIView {
    private var counted = false

    init() {
        super.init(frame: .zero)
        isHidden = true
        isUserInteractionEnabled = false
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        let inWindow = window != nil
        guard inWindow != counted else { return }
        counted = inWindow
        if inWindow { ZnSecure.shared.markerEntered() } else { ZnSecure.shared.markerLeft() }
    }
}

/// The window root's content, inside a text field's canvas: [content] holds what ZnRootController shows. While
/// [secure], iOS leaves it out of screenshots, recordings and mirroring.
final class ZnSecureContainer: UIView {
    let content = UIView()
    private let field = ZnSecureField()
    private weak var canvas: UIView?
    /// False when the field's canvas wasn't found (a later iOS): captures are not blanked (ZnSecure's fallback).
    private(set) var blanksCapture = false

    init() {
        super.init(frame: .zero)
        field.frame = bounds
        addSubview(field)
        content.isAccessibilityElement = false
        // Its children are framed by their owner (ZnRootController.place): when it grows from zero at the first layout,
        // a controller's view (flexible width and height) would grow by as much again.
        content.autoresizesSubviews = false
        attach()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    var secure: Bool {
        get { field.isSecureTextEntry }
        set {
            guard newValue != field.isSecureTextEntry else { return }
            field.isSecureTextEntry = newValue
            field.strip()
            attach()  // in case the field made a new canvas
        }
    }

    /// Puts [content] in the field's canvas (the first subview whose class is a canvas, else its first subview).
    private func attach() {
        field.layoutIfNeeded()
        let found = field.subviews.first { NSStringFromClass(type(of: $0)).contains("CanvasView") } ?? field.subviews.first
        if found !== canvas || content.superview == nil {
            print("zn secure: the screens are in \(found.map { NSStringFromClass(type(of: $0)) } ?? "the container")\(canvas == nil ? "" : " (the field made a new canvas)")")
            canvas = found
            if let found {
                found.addSubview(content)
            } else {
                print("zn secure: the text field has no canvas on this iOS: captures are not blanked, a cover shows while recording")
                addSubview(content)
            }
        }
        blanksCapture = found != nil
        setNeedsLayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        field.frame = bounds
        field.layoutIfNeeded()
        if let canvas, content.superview !== canvas { attach() }
        // The container's own rectangle, wherever the canvas sits in the field.
        if let parent = content.superview { content.frame = convert(bounds, to: parent) }
    }

    /// The field and its canvas take no touches: a touch on nothing of the content goes on to what is under it.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let v = super.hitTest(point, with: event)
        return v === self || v === field || v === canvas || v === content ? nil : v
    }
}

/// The text field whose canvas holds the content: never focused, no text gestures, no edit menu, not one
/// VoiceOver element (VoiceOver reads the content inside).
private final class ZnSecureField: UITextField {
    init() {
        super.init(frame: .zero)
        borderStyle = .none
        isAccessibilityElement = false
        strip()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    /// Takes out the gestures and interactions UIKit gives a text field (they would see every touch in the content).
    func strip() {
        for g in gestureRecognizers ?? [] { removeGestureRecognizer(g) }
        for i in interactions { removeInteraction(i) }
    }

    override var canBecomeFirstResponder: Bool { false }
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { false }
    override func textRect(forBounds bounds: CGRect) -> CGRect { bounds }
    override func editingRect(forBounds bounds: CGRect) -> CGRect { bounds }
    override func placeholderRect(forBounds bounds: CGRect) -> CGRect { bounds }
    override var isAccessibilityElement: Bool {
        get { false }
        set {}
    }
    override func addGestureRecognizer(_ g: UIGestureRecognizer) {}  // UIKit adds them again when the field changes
    override func didMoveToWindow() {
        super.didMoveToWindow()
        strip()
    }
}
