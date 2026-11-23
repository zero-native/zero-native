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
    /// Where the finger went down, in the Pressable's own space (the ripple starts there).
    var touch: CGPoint?
}

/// Pressable's press feedback, as Android's ZnRipple / ZnHighlight (ZnAnimation.kt), drawn over the content and inside
/// the node's shape. ripple (the default): a circle from the finger, black at 12 % (a `rippleColor` at 24 %;
/// `rippleOpacity` wins), growing to cover the node in ~225 ms and fading ~150 ms after the finger leaves (Material's
/// timings); `rippleBorderless`: not clipped, `rippleRadius` its size. highlight: a flat overlay while pressed.
struct ZnPressFeedback: View {
    let s: ZnNodeSpec
    let state: ZnPressState
    /// The node's shape now (corners from slots too), so the highlight and the ripple follow it.
    let shape: UnevenRoundedRectangle
    @State private var origin: CGPoint = .zero
    @State private var grown = false
    @State private var shown = false
    @State private var downAt = Date.distantPast

    var body: some View {
        switch s.pressFeedback {
        case Registry.PressFeedback.none:
            EmptyView()
        case Registry.PressFeedback.highlight:
            shape.fill(s.highlightColor).opacity(state.pressed ? 1 : 0).allowsHitTesting(false)
        default:
            GeometryReader { geo in
                let size = geo.size
                // To the farthest corner: the circle covers the node wherever the finger was.
                let far = [CGPoint.zero, CGPoint(x: size.width, y: 0), CGPoint(x: 0, y: size.height), CGPoint(x: size.width, y: size.height)]
                    .map { hypot($0.x - origin.x, $0.y - origin.y) }.max() ?? 0
                let r = s.rippleRadius ?? (s.rippleBorderless ? max(size.width, size.height) / 2 : far)
                let alpha = s.rippleOpacity ?? (s.rippleColor == nil ? 0.12 : 0.24)
                ZnRippleCircle(center: origin, radius: r, scale: grown ? 1 : 0.2, shown: shown ? 1 : 0)
                    .fill(s.rippleColor ?? .black)
                    .opacity(shown ? alpha : 0)
            }
            .modifier(ZnRippleClip(clip: !s.rippleBorderless, shape: shape))
            .allowsHitTesting(false)
            .onChange(of: state.pressed) { _, pressed in
                if pressed {
                    origin = state.touch ?? .zero
                    downAt = Date()
                    var t = Transaction()
                    t.disablesAnimations = true
                    withTransaction(t) { grown = false; shown = true }
                    withAnimation(.easeOut(duration: 0.225)) { grown = true }
                } else {
                    // A quick tap still shows the ripple grow a little before it fades.
                    let wait = max(0, 0.1 - Date().timeIntervalSince(downAt))
                    withAnimation(.easeOut(duration: 0.15).delay(wait)) { shown = false }
                }
            }
        }
    }
}

/// The ripple's circle. No path at all while it isn't shown (once its fade has ended): SwiftUI counts a shape's path
/// in the Pressable's VoiceOver frame, hidden or not, so an idle circle made the element larger than its box.
private struct ZnRippleCircle: Shape {
    var center: CGPoint
    var radius: CGFloat
    var scale: CGFloat
    /// 1 while shown, animated to 0 with the fade.
    var shown: CGFloat

    var animatableData: AnimatablePair<CGFloat, CGFloat> {
        get { AnimatablePair(scale, shown) }
        set { scale = newValue.first; shown = newValue.second }
    }

    func path(in rect: CGRect) -> Path {
        guard shown > 0 else { return Path() }
        let r = radius * scale
        return Path(ellipseIn: CGRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
    }
}

private struct ZnRippleClip: ViewModifier {
    let clip: Bool
    let shape: UnevenRoundedRectangle
    func body(content: Content) -> some View {
        if clip { content.clipShape(shape) } else { content }
    }
}

struct ZnPressable<Label: View>: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    @ViewBuilder let label: () -> Label
    /// Its press state and context, for its node's paint (ZnElementProbe, ZnElementMotion.swift).
    @State private var link = ZnPressLink()

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
            .modifier(ZnPressA11y(ctx: ctx, s: s, inst: inst, disabled: disabled))
        case .uiKit:
            // The feedback, the press look and the touch view are drawn by the node's own paint, inside its layer
            // (ZnPressInLayer, ZnElementMotion.swift): a Pressable moved, scaled or turned by its transforms takes taps
            // where it is drawn, as on Android, and its ripple moves with it. They used to sit out here, around the
            // untransformed box.
            let _ = link.bind(ctx: ctx, inst: inst, node: s.index)
            label()
                .environment(\.znPressLink, link)
                // VoiceOver: one element, a button by default (ZnAccessibility.swift). The touch view isn't one.
                .modifier(ZnPressA11y(ctx: ctx, s: s, inst: inst, disabled: disabled))
        }
    }
}

extension ZnPressLink {
    /// Whose link this is now: set in ZnPressable's body, before its node's paint reads it in the same update.
    func bind(ctx: ZnContext, inst: ZnInstance, node: Int) {
        self.ctx = ctx
        self.inst = inst
        self.node = node
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
    /// Takes no taps (pointerEvents "none" / "box-none" on this node): hidden, as under znTouchOff.
    var off = false

    func makeUIView(context: Context) -> ZnTouchControl {
        let c = ZnTouchControl()
        c.backgroundColor = .clear
        return c
    }

    func updateUIView(_ c: ZnTouchControl, context: Context) {
        let s = s, inst = inst, ctx = ctx, state = state
        // On a hidden tab (ZnTabsView), inside pointerEvents "none" (or a "box-only" parent), or "none" / "box-none"
        // itself: out of every hit test, also the inner-Pressable check of the controls over it.
        c.isHidden = context.environment.znInHiddenTab || context.environment.znTouchOff || off
        let slop = s.hitSlop ?? ZnEdges()
        let rtl = context.environment.layoutDirection == .rightToLeft
        c.slop = UIEdgeInsets(top: slop.top, left: rtl ? slop.end : slop.start, bottom: slop.bottom, right: rtl ? slop.start : slop.end)
        c.isEnabled = !disabled
        c.haptic = s.haptic
        c.repeatDelay = s.onPressRepeat != 0 ? s.repeatDelayMs / 1000 : nil
        c.repeatInterval = s.repeatIntervalMs / 1000
        // In a row of a reorderable List the long press picks the row up: no onLongPress (decision 7, ZnListReorder.swift).
        let reorderRow = context.environment.znReorderRow
        c.longPressOn = { !reorderRow && s.onLongPress != 0 && (s.hasLongPressSlot < 0 || inst.slot(s.hasLongPressSlot).value != .bool(false)) }
        c.onEvent = { [weak c] kind, payload in
            switch kind {
            case .down:
                state.touch = c?.lastDown
                state.pressed = true
                if s.onPressIn != 0 { ctx.send(inst.id, s.onPressIn, .none) }
            case .out: state.pressed = false; if s.onPressOut != 0 { ctx.send(inst.id, s.onPressOut, payload) }
            case .tap:
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
    /// Where the last press began, in the Pressable's space (the ripple starts there).
    private(set) var lastDown: CGPoint = .zero
    /// hitSlop: how far this view reaches past the Pressable on each side (0 without one).
    var slop: UIEdgeInsets = .zero
    /// The Pressable itself, without its slop.
    var core: CGRect { bounds.inset(by: slop) }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event), let window else { return nil }
        let p = convert(point, to: window)
        // Sizes and the finger in the window's space: the touch views sit inside their Pressables' layers, so a scaled
        // or turned parent scales and turns them (its children with it).
        let area = windowArea(core, window)
        // In the slop, past the Pressable's own edges: another Pressable right under the finger wins, as on Android
        // (Compose's minimum touch size; RN would give it to the one on top). Over empty space the slop counts.
        let inSlop = !core.contains(point)
        let screen = screenController
        // Only controls of the same screen: a screen under the top one (still in the hierarchy during and after a
        // push) must not take its taps (found 2026-11-08: Home's buttons blocked the Dev screen's).
        for other in ZnTouchControl.live.allObjects
        where other !== self && other.window === window && !other.isHidden && other.screenController === screen {
            // Under the finger: in its own space, so a turned one's corners don't count.
            guard other.core.contains(other.convert(p, from: window)) else { continue }
            // An inner Pressable takes the touch; in our slop, any Pressable under the finger does.
            if inSlop || other.windowArea(other.core, window) < area { return nil }
        }
        // A TextField inside the Pressable (a dialog's note field in a tappable dim, a search field in a tappable row):
        // the field takes the touch, as on Android, where the innermost one gets it. It never could (2026-11-19).
        for box in ZnFieldFocus.boxes(at: p, in: window)
        where box.controller === screen && (inSlop || box.frame.width * box.frame.height < area) {
            return nil
        }
        return hit
    }

    /// [r]'s area as drawn in [window] (its transforms' scale; a turn doesn't change it).
    func windowArea(_ r: CGRect, _ window: UIWindow) -> CGFloat {
        let a = convert(CGPoint(x: r.minX, y: r.minY), to: window)
        let b = convert(CGPoint(x: r.maxX, y: r.minY), to: window)
        let c = convert(CGPoint(x: r.minX, y: r.maxY), to: window)
        return abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x))
    }

    /// The view controller hosting this control's screen (the nearest one up the responder chain).
    var screenController: UIViewController? { znNearestController(self) }

    static let live = NSHashTable<ZnTouchControl>.weakObjects()
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { ZnTouchControl.live.add(self) } else { ZnTouchControl.live.remove(self) }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        guard isEnabled, !active else { return }
        let at = touches.first?.location(in: self) ?? CGPoint(x: bounds.midX, y: bounds.midY)
        lastDown = CGPoint(x: at.x - slop.left, y: at.y - slop.top)
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

extension EnvironmentValues {
    /// The view is on a <Tabs> child that isn't selected (kept, faded out). Its Pressables hide their touch views: SwiftUI's
    /// allowsHitTesting(false) keeps them from taking touches, but ZnTouchControl's inner-Pressable check still saw
    /// them, so a smaller button on a hidden tab swallowed taps on the shown one (ZeroBill: Offers' card after visiting
    /// Rewards, 2026-11-09).
    @Entry var znInHiddenTab = false
    // znTouchOff, znEntry and znGestureDepth: ZnEnv.swift.
}

/// The nearest view controller up [view]'s responder chain (its screen's, or its Sheet's or Modal's).
@MainActor func znNearestController(_ view: UIView) -> UIViewController? {
    var r: UIResponder? = view
    while let next = r?.next {
        if let vc = next as? UIViewController { return vc }
        r = next
    }
    return nil
}
