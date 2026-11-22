// The window values motion formulas read (`env` in core motion.ts, ids 1-8), in points, as Android's ZnNavHost.kt
// motionEnv writes them: the window's width and height, its safe-area insets (start / end by layout direction), the
// keyboard's height at every frame of its animation, and where the keyboard is going. Written by the window's root
// (ZnRootController, ZnLayers.swift): one root for every screen, so rotation and split view reach them, as on Android.
// The keyboard target comes from ZnSystemEvents (when the keyboard starts to move). With no motion engine running
// (release builds for now) these are plain numbers nobody reads.
import UIKit

@MainActor
enum ZnMotionEnv {
    private static var engine: ZnMotionEngine { ZnMotionEngine.shared }

    private static func set(_ id: Int, _ v: CGFloat) { engine.env(id)?.set(Float(v)) }

    /// The window's size (the root view fills it).
    static func window(_ size: CGSize) {
        set(ZnMotionEngine.envWidth, size.width)
        set(ZnMotionEngine.envHeight, size.height)
    }

    /// The window's safe area. [ltr]: start is left.
    static func insets(_ i: UIEdgeInsets, ltr: Bool) {
        set(ZnMotionEngine.envInsetTop, i.top)
        set(ZnMotionEngine.envInsetBottom, i.bottom)
        set(ZnMotionEngine.envInsetStart, ltr ? i.left : i.right)
        set(ZnMotionEngine.envInsetEnd, ltr ? i.right : i.left)
    }

    /// The keyboard's height now (each frame while it moves).
    static func keyboard(_ h: CGFloat) { set(ZnMotionEngine.envKeyboard, h) }

    /// Its height when it stops: the full height while it opens, 0 while it closes.
    static func keyboardTarget(_ h: CGFloat) { set(ZnMotionEngine.envKeyboardTarget, h) }
}

/// Follows the keyboard frame by frame: a 1x1 view with no content pinned to the root view's keyboard layout guide.
/// UIKit moves the guide inside the keyboard's own animation (and with the finger in an interactive dismiss), so the
/// view's presentation layer is where the keyboard is at each frame. While it moves, each frame reads that.
@MainActor
final class ZnKeyboardProbe {
    private let probe = UIView()
    private weak var root: UIView?
    private var lastTop: CGFloat = .nan
    private var lastHeight: CGFloat = .nan
    private var ticking = false
    /// Frames in a row where the presentation matched the model: two, and the animation is over.
    private var settled = 0

    func install(in root: UIView) {
        self.root = root
        probe.isUserInteractionEnabled = false
        probe.alpha = 0
        probe.isAccessibilityElement = false
        probe.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(probe)
        let guide = root.keyboardLayoutGuide
        guide.usesBottomSafeArea = false  // hidden: the guide's top is the window's bottom (height 0), not the safe area's
        NSLayoutConstraint.activate([
            probe.topAnchor.constraint(equalTo: guide.topAnchor),
            probe.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            probe.widthAnchor.constraint(equalToConstant: 1),
            probe.heightAnchor.constraint(equalToConstant: 1),
        ])
    }

    /// After the root's layout: the guide may have moved (the keyboard starts to move, the window turned).
    func layoutChanged() {
        guard let root else { return }
        let top = probe.frame.minY
        if top == lastTop && !ticking { return write(root) }
        lastTop = top
        settled = 0
        write(root)
        guard !ticking else { return }
        ticking = true
        ZnFrameClock.shared.add(self) { [weak self] _ in self?.frame() ?? false }
    }

    private func frame() -> Bool {
        guard let root, probe.window != nil else {
            ticking = false
            return false
        }
        let model = probe.frame.minY
        let now = probe.layer.presentation()?.frame.minY ?? model
        write(root, top: now)
        settled = abs(now - model) < 0.25 ? settled + 1 : 0
        if settled >= 2 {
            write(root)
            ticking = false
            return false
        }
        return true
    }

    private func write(_ root: UIView, top: CGFloat? = nil) {
        let h = ZnWindowRules.keyboardHeight(windowHeight: root.bounds.height, guideTop: top ?? probe.frame.minY)
        guard h != lastHeight else { return }
        lastHeight = h
        ZnMotionEnv.keyboard(h)
    }
}
