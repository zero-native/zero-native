// Pressable on iOS, both ways (i.1c). Same rules as android/runtime's ZnPress.kt:
// - onPressIn when the finger goes down; then exactly one onPressOut, `true` if cancelled (dragged off, a scroll took
//   over), `false` if lifted;
// - onLongPress after the system long-press time (0.5 s), only while JS has a handler (the hasLongPress slot);
// - onPressRepeat while the finger stays down: first after repeatDelay, then every repeatInterval, timed natively;
// - onPress only for a completed tap that didn't long-press or repeat.
//
// UIKit variant: a plain UIView over the content does the touch tracking (under it, SwiftUI's hosting view takes the
// touches: checked 2026-11-08). A nested Pressable must win, as on Android: the outer view lets a touch through
// when a smaller one lies under the finger. Not a UIControl: a scroll view never cancels touches in a UIControl
// (touchesShouldCancel(in:) is false for controls, and SwiftUI's ScrollView doesn't change that), so a slow drag that
// started on a button didn't scroll the page (found 2026-11-08 in the RN props lab). A plain view is cancelled when
// the scroll starts (touchesCancelled → onPressOut(true)), as on Android.
// SwiftUI variant: Button + ButtonStyle (tap only: long press and repeat would need gestures composed with it).
import SwiftUI
import UIKit

@Observable
final class ZnPressState {
    var pressed = false
}

struct ZnPressable<Label: View>: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    @ViewBuilder let label: () -> Label
    @State private var state = ZnPressState()

    var body: some View {
        // `disabled` may change at runtime (a slot, e.g. the Pay button's disabled={!active()}).
        let disabled = s.disabledNow(inst)
        switch ZnImpl.press {
        case .swiftUI:
            Button {
                if s.haptic { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                if s.onPress != 0 { ctx.send(inst.id, s.onPress, .none) }
            } label: {
                label()
            }
            .buttonStyle(ZnPressStyle(scale: s.pressScale, opacity: s.pressOpacity))
            .disabled(disabled)
        case .uiKit:
            label()
                .scaleEffect(state.pressed ? s.pressScale : 1)
                .opacity(state.pressed ? s.pressOpacity : 1)
                .animation(.spring(response: 0.2, dampingFraction: 0.8), value: state.pressed)
                .overlay(ZnTouchTarget(ctx: ctx, s: s, inst: inst, state: state, disabled: disabled))
        }
    }
}

struct ZnPressStyle: ButtonStyle {
    let scale: CGFloat
    let opacity: Double
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? opacity : 1)
            .animation(.spring(response: 0.2, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

struct ZnTouchTarget: UIViewRepresentable {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let state: ZnPressState
    let disabled: Bool

    func makeUIView(context: Context) -> ZnTouchControl {
        let c = ZnTouchControl()
        c.backgroundColor = .clear
        return c
    }

    func updateUIView(_ c: ZnTouchControl, context: Context) {
        let s = s, inst = inst, ctx = ctx, state = state
        c.isEnabled = !disabled
        c.haptic = s.haptic
        c.repeatDelay = s.onPressRepeat != 0 ? s.repeatDelayMs / 1000 : nil
        c.repeatInterval = s.repeatIntervalMs / 1000
        c.longPressOn = { s.onLongPress != 0 && (s.hasLongPressSlot < 0 || inst.slot(s.hasLongPressSlot).value != .bool(false)) }
        c.onEvent = { kind, payload in
            switch kind {
            case .down: state.pressed = true; if s.onPressIn != 0 { ctx.send(inst.id, s.onPressIn, .none) }
            case .out: state.pressed = false; if s.onPressOut != 0 { ctx.send(inst.id, s.onPressOut, payload) }
            case .tap:
                print("zn t=\(ZnDebug.ms()) tap on \(inst.id).\(s.index)")
                if s.onPress != 0 { ctx.send(inst.id, s.onPress, .none) }
            case .long: ctx.send(inst.id, s.onLongPress, .none)
            case .repeat: ctx.send(inst.id, s.onPressRepeat, .none)
            }
        }
    }
}

final class ZnTouchControl: UIView {
    enum Kind { case down, out, tap, long, `repeat` }

    var onEvent: ((Kind, ZnPayload) -> Void)?
    var longPressOn: () -> Bool = { false }
    var repeatDelay: TimeInterval?
    var repeatInterval: TimeInterval = 0.1
    var haptic = false
    /// A disabled Pressable still takes the touch (nothing under it gets it), but does nothing, as on Android.
    var isEnabled = true
    private var timer: Timer?
    private var handled = false  // a long press or a repeat fired: no onPress on release
    private var active = false   // between onPressIn and its onPressOut

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event), let window else { return nil }
        let p = convert(point, to: window)
        let area = bounds.width * bounds.height
        let screen = screenController
        // Only controls of the same screen: a screen under the top one (still in the hierarchy during and after a
        // push) must not take its taps (found 2026-11-08: Home's buttons blocked the Dev screen's).
        for other in ZnTouchControl.live.allObjects
        where other !== self && other.window === window && !other.isHidden && other.screenController === screen {
            let f = other.convert(other.bounds, to: window)
            if f.contains(p) && f.width * f.height < area { return nil }  // an inner Pressable: it takes the touch
        }
        return hit
    }

    /// The view controller hosting this control's screen (the nearest one up the responder chain).
    var screenController: UIViewController? {
        var r: UIResponder? = self
        while let next = r?.next {
            if let vc = next as? UIViewController { return vc }
            r = next
        }
        return nil
    }

    static let live = NSHashTable<ZnTouchControl>.weakObjects()
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { ZnTouchControl.live.add(self) } else { ZnTouchControl.live.remove(self) }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard isEnabled, !active else { return }
        handled = false
        active = true
        if haptic { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        onEvent?(.down, .none)
        if let delay = repeatDelay {
            timer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
                guard let self else { return }
                self.handled = true
                self.onEvent?(.repeat, .none)
                self.timer = Timer.scheduledTimer(withTimeInterval: self.repeatInterval, repeats: true) { [weak self] _ in
                    self?.onEvent?(.repeat, .none)
                }
            }
        } else if longPressOn() {
            timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: false) { [weak self] _ in
                guard let self else { return }
                self.handled = true
                if self.haptic { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
                self.onEvent?(.long, .none)
            }
        }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
        // Dragged well off the element: the press is cancelled, as on Android.
        guard active, let t = touches.first else { return }
        if !bounds.insetBy(dx: -30, dy: -30).contains(t.location(in: self)) { finish(cancelled: true) }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard active else { return }
        let inside = touches.first.map { bounds.insetBy(dx: -30, dy: -30).contains($0.location(in: self)) } ?? false
        let tap = inside && !handled
        finish(cancelled: !inside)
        if tap { onEvent?(.tap, .none) }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
        finish(cancelled: true)
    }

    /// Exactly one onPressOut per press, whichever way it ends.
    private func finish(cancelled: Bool) {
        timer?.invalidate()
        timer = nil
        guard active else { return }
        active = false
        onEvent?(.out, .bool(cancelled))
    }
}
