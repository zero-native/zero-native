// Pressable on iOS, both ways (i.1c). Same rules as android/runtime's ZnPress.kt:
// - onPressIn when the finger goes down; then exactly one onPressOut, `true` if cancelled (dragged off, a scroll took
//   over), `false` if lifted;
// - onLongPress after the system long-press time (0.5 s), only while JS has a handler (the hasLongPress slot);
// - onPressRepeat while the finger stays down: first after repeatDelay, then every repeatInterval, timed natively;
// - onPress only for a completed tap that didn't long-press or repeat.
//
// UIKit variant: a plain UIView over the content does the touch tracking (under it, SwiftUI's hosting view takes the
// touches: checked 2026-11-08). A nested Pressable must win, as on Android: the outer view lets a touch through
// when one inside it shows under the finger (and to a scroll inside it: ZnPressInner.swift). Not a UIControl: a scroll view never cancels touches in a UIControl
// (touchesShouldCancel(in:) is false for controls, and SwiftUI's ScrollView doesn't change that), so a slow drag that
// started on a button didn't scroll the page (found 2026-11-08 in the RN props lab). A plain view is cancelled when
// the scroll starts (touchesCancelled → onPressOut(true)), as on Android.
// SwiftUI variant: Button + ButtonStyle (tap only: long press and repeat would need gestures composed with it).
import SwiftUI
import UIKit

@Observable
final class ZnPressState {
    /// The press look (ripple, highlight, pressScale, pressOpacity): on at the press, off at its end but shown at
    /// least [minShown].
    var pressed = false
    /// Where the finger went down, in the Pressable's own space (the ripple starts there).
    var touch: CGPoint?
    /// Counts the presses: a new one restarts the ripple at its finger even while `pressed` is still held on by the
    /// last one's [minShown] (two quick taps showed one ripple, at the first finger).
    private(set) var presses = 0
    @ObservationIgnored private var downAt: CFTimeInterval = 0

    /// How long a press shows at least. Inside a Scroll, List or Carousel UIKit holds a quick tap's touch until the
    /// lift (the scroll's content delay), then hands over its start and end at once: `pressed` went true and back to
    /// false before SwiftUI drew, so the tap showed no feedback at all, while Android's (no delay) always shows it.
    /// The delay itself stays (a scroll that starts on a Pressable doesn't flash its ripple, as UIKit's buttons).
    static let minShown: CFTimeInterval = 0.1

    func press(at p: CGPoint) {
        presses += 1
        downAt = CACurrentMediaTime()
        touch = p
        pressed = true
    }

    func release() {
        let left = Self.minShown - (CACurrentMediaTime() - downAt)
        guard left > 0 else { pressed = false; return }
        let n = presses
        DispatchQueue.main.asyncAfter(deadline: .now() + left) { [weak self] in
            // Not if a new press began since.
            guard let self, self.presses == n else { return }
            self.pressed = false
        }
    }
}

/// Pressable's press feedback, as Android's ZnRipple / ZnHighlight (ZnAnimation.kt), drawn over the content and inside
/// the node's shape. ripple (the default): a circle from the finger that moves to the center as it grows (from the
/// center when borderless), black at 12 % (a `rippleColor` at 24 %;
/// `rippleOpacity` wins), fading in over 75 ms, growing to cover the node in ~225 ms, held at least 225 ms from the
/// press and fading 150 ms (Android's RippleDrawable: a quick tap shows ~375 ms, not a blink); `rippleBorderless`: not
/// clipped, half the node's diagonal (or `rippleRadius`) its size. highlight: a flat overlay while pressed.
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
                // As Android's RippleDrawable: a borderless ripple grows from the node's center wherever the finger
                // was; a bounded one starts at the finger and moves to the center while it grows, ending at the
                // corners. (iOS drew both around the finger, so a tap near an icon's edge rippled off to one side.)
                let start = s.rippleBorderless ? CGPoint(x: size.width / 2, y: size.height / 2) : origin
                // Half the diagonal both ways, as Android (material-ripple's getRippleEndRadius): a 40 pt round back
                // button's borderless ripple reaches ~8 pt past it (it used half the longest side, inside the button).
                let r = s.rippleRadius ?? hypot(size.width, size.height) / 2
                let alpha = s.rippleOpacity ?? (s.rippleColor == nil ? 0.12 : 0.24)
                ZnRippleCircle(start: start, radius: r, scale: grown ? 1 : 0.2, shown: shown ? 1 : 0)
                    .fill(znRippleColor(s.rippleColor))
                    .opacity(shown ? alpha : 0)
            }
            .modifier(ZnRippleClip(clip: !s.rippleBorderless, shape: shape))
            .allowsHitTesting(false)
            // Each press starts a ripple (also one that comes while the last is still shown); the end of the press
            // look fades it.
            .onChange(of: state.presses) {
                origin = state.touch ?? .zero
                downAt = Date()
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) { grown = false }
                withAnimation(.linear(duration: ZnRippleTiming.enter)) { shown = true }
                withAnimation(.easeOut(duration: ZnRippleTiming.grow)) { grown = true }
            }
            .onChange(of: state.pressed) { _, pressed in
                guard !pressed else { return }
                // A quick tap still shows the ripple grown before it fades.
                let wait = max(0, ZnRippleTiming.hold - Date().timeIntervalSince(downAt))
                withAnimation(.easeOut(duration: ZnRippleTiming.exit).delay(wait)) { shown = false }
            }
        }
    }
}

/// The ripple's timings, as Android's RippleDrawable (RippleForeground): it fades in over 75 ms and grows in 225 ms; at
/// its end it is held until 225 ms after the press, then fades in 150 ms. (iOS showed it at once, held it 0.1 s and
/// faded it in 0.15 s: about 180 ms in all on a quick tap, a blink next to Android's ~375 ms.)
enum ZnRippleTiming {
    static let enter: TimeInterval = 0.075
    static let grow: TimeInterval = 0.225
    static let hold: TimeInterval = 0.225
    static let exit: TimeInterval = 0.15
}

/// The ripple's colour: [c]'s own alpha left out, as Android's ripple (color.copy(alpha = the ripple's alpha)). A
/// rippleColor such as rgba(61,38,237,0.1) at the default 24 % was 2.4 % on iOS, almost invisible.
func znRippleColor(_ c: Color?) -> Color {
    guard let c else { return .black }
    return Color(uiColor: UIColor(c).withAlphaComponent(1))
}

/// The ripple's circle. No path at all while it isn't shown (once its fade has ended): SwiftUI counts a shape's path
/// in the Pressable's VoiceOver frame, hidden or not, so an idle circle made the element larger than its box.
private struct ZnRippleCircle: Shape {
    /// Where it starts; its center moves from here to the middle of the node as it grows (scale 0.2 → 1).
    var start: CGPoint
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
        let t = min(max((scale - 0.2) / 0.8, 0), 1)
        let center = CGPoint(x: start.x + (rect.midX - start.x) * t, y: start.y + (rect.midY - start.y) * t)
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
            .buttonStyle(ZnPressStyle(scale: s.pressScale, opacity: s.pressOpacity,
                                      group: s.pressOpacity < 1 && s.drawsOverlappingParts))
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
    /// pressOpacity fades the Pressable as one picture (ZnOpacityGroup, ZnRenderer.swift), as the UIKit variant's.
    var group = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .modifier(ZnOpacityGroup(on: group))
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
    /// How far the touch view reaches past the node (hitSlop grown to the 44 pt minimum: ZnTouchRules.reach), when the
    /// caller sized it so; else the node's hitSlop.
    var reach: ZnTouchReach? = nil
    /// This Pressable's id and the Pressables holding it (ZnPressLink ids; see znPressAncestors). Without ancestors
    /// given (a tappable Text), the Pressables around it in the environment.
    var own: ObjectIdentifier? = nil
    var ancestors: [ObjectIdentifier]? = nil

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
        let slop = reach ?? znTouchSlop(s)
        let rtl = context.environment.layoutDirection == .rightToLeft
        c.slop = UIEdgeInsets(top: slop.top, left: rtl ? slop.end : slop.start, bottom: slop.bottom, right: rtl ? slop.start : slop.end)
        c.isEnabled = !disabled
        c.own = own
        c.ancestors = Set(ancestors ?? context.environment.znPressAncestors)
        c.haptic = s.haptic
        c.repeatDelay = s.onPressRepeat != 0 ? s.repeatDelayMs / 1000 : nil
        c.repeatInterval = s.repeatIntervalMs / 1000
        // In a row of a reorderable List the long press picks the row up: no onLongPress (decision 7, ZnListReorder.swift).
        let reorderRow = context.environment.znReorderRow
        c.longPressOn = { !reorderRow && s.onLongPress != 0 && (s.hasLongPressSlot < 0 || inst.slot(s.hasLongPressSlot).value != .bool(false)) }
        c.onEvent = { [weak c] kind, payload in
            switch kind {
            case .down:
                state.press(at: c?.lastDown ?? .zero)
                if s.onPressIn != 0 { ctx.send(inst.id, s.onPressIn, .none) }
            case .out: state.release(); if s.onPressOut != 0 { ctx.send(inst.id, s.onPressOut, payload) }
            case .tap:
                if s.onPress != 0 { ctx.send(inst.id, s.onPress, .none) }
            case .long: ctx.send(inst.id, s.onLongPress, .none)
            case .repeat: ctx.send(inst.id, s.onPressRepeat, .none)
            }
        }
    }
}

/// A node's hitSlop as a ZnTouchReach (0 on each side without one).
func znTouchSlop(_ s: ZnNodeSpec) -> ZnTouchReach {
    let e = s.hitSlop ?? ZnEdges()
    return ZnTouchReach(top: e.top, start: e.start, bottom: e.bottom, end: e.end)
}

final class ZnTouchControl: UIView {
    enum Kind { case down, out, tap, long, `repeat` }

    var onEvent: ((Kind, ZnPayload) -> Void)?
    var longPressOn: () -> Bool = { false }
    var repeatDelay: TimeInterval?
    var repeatInterval: TimeInterval = 0.1
    var haptic = false
    /// A disabled Pressable takes no touch: the Pressable around it (a tappable card) gets it, or what is under it, as
    /// on Android (no pointer input while disabled, ZnPress.kt) and in RN. It used to take the touch and do nothing, so
    /// a card with a disabled button in it didn't open from there.
    var isEnabled = true
    private var timer: Timer?
    private var handled = false  // a long press or a repeat fired: no onPress on release
    private var active = false   // between onPressIn and its onPressOut
    /// Where the last press began, in the Pressable's space (the ripple starts there).
    private(set) var lastDown: CGPoint = .zero
    /// How long ago the finger went down when the next touchesBegan comes (ZnPressForward presses after its delay):
    /// onLongPress and onPressRepeat are timed from the finger, as on Android, not from the late press.
    var late: TimeInterval = 0
    /// hitSlop: how far this view reaches past the Pressable on each side (0 without one).
    var slop: UIEdgeInsets = .zero
    /// The Pressable itself, without its slop.
    var core: CGRect { bounds.inset(by: slop) }
    /// This Pressable's id and the Pressables that hold it (a card around a button).
    var own: ObjectIdentifier?
    var ancestors: Set<ObjectIdentifier> = []
    private func holds(_ other: ZnTouchControl) -> Bool { other.own.map { ancestors.contains($0) } ?? false }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard isEnabled, let hit = super.hitTest(point, with: event), let window else { return nil }
        let p = convert(point, to: window)
        // Sizes and the finger in the window's space: the touch views sit inside their Pressables' layers, so a scaled
        // or turned parent scales and turns them (its children with it).
        let area = windowArea(core, window)
        // In the slop (hitSlop and the 44 pt minimum), past the Pressable's own edges: another Pressable right under
        // the finger wins, as on Android (Compose's minimum touch size; RN would give it to the one on top), unless it
        // holds this one (a tappable card around a small button: the button keeps its grown area, as on Android).
        // Where two grown areas overlap, the nearer Pressable wins. Over empty space the slop counts.
        let inSlop = !core.contains(point)
        let mine = windowRect(core, window)
        let screen = screenController
        // Only controls of the same screen: a screen under the top one (still in the hierarchy during and after a
        // push) must not take its taps (found 2026-11-08: Home's buttons blocked the Dev screen's).
        // A disabled one takes nothing (its own hitTest), so it doesn't count here either.
        for other in ZnTouchControl.live.allObjects
        where other !== self && other.window === window && !other.isHidden && other.isEnabled && other.screenController === screen {
            let q = other.convert(p, from: window)
            // Only where it shows: not clipped away by a Scroll or List, not in a hidden or reused cell.
            guard other.bounds.contains(q), other.reaches(p, in: window) else { continue }
            // Under the finger: in its own space, so a turned one's corners don't count.
            if other.core.contains(q) {
                // On this Pressable itself: a Pressable inside it takes the touch, as Compose's hit test (children
                // first). Never one that isn't inside it: a sibling drawn under it (a button under an absolute bar or
                // a tap-outside backdrop) or a Scroll's chip clipped out of view under a fixed Pay button. "Smaller"
                // stood for "inside" until 2026-11-24, so those took the tap or killed it. In our slop: any Pressable
                // under the finger does, but not one that holds this one.
                if inSlop ? !holds(other) : other.holds(self) {
                    return nil
                }
            } else {
                let theirs = other.windowRect(other.core, window)
                // On this Pressable itself, in the grown area of a small one inside it (a card's button): the inner one
                // takes it, as on Android. In our slop with theirs too: the nearer one takes it.
                if inSlop ? ZnTouchRules.distance(p, to: theirs) < ZnTouchRules.distance(p, to: mine) : other.holds(self) {
                    return nil
                }
            }
        }
        // A TextField inside the Pressable (a dialog's note field in a tappable dim, a search field in a tappable row):
        // the field takes the touch, as on Android, where the innermost one gets it. It never could (2026-11-19).
        for box in ZnFieldFocus.boxes(at: p, in: window)
        where box.controller === screen && (inSlop || box.frame.width * box.frame.height < area) {
            return nil
        }
        // A scroll view that can scroll, or a plugin's view that takes touches, inside this Pressable under the finger
        // (a chip rail or a Carousel in a card): it gets the touch, as on Android. The scroll still presses this one
        // through its ZnPressForward (a tap on the rail presses the card; a swipe scrolls and cancels the press).
        if let own, let (v, native) = ZnPressInner.taker(at: p, in: window, inside: own, event: event) {
            if !native, let sv = v as? UIScrollView { ZnPressForward.on(sv).arm(self) }
            return nil
        }
        return hit
    }

    /// Would a touch at [p] (window space) reach this view? Each view above it must take the point too: a scroll view,
    /// a Sheet or the screen clips the grown area, so a Pressable scrolled out of sight never wins from under its edge.
    func reaches(_ p: CGPoint, in window: UIWindow) -> Bool {
        guard let superview else { return false }
        return znReaches(superview, p, in: window)
    }

    /// [r]'s bounding box as drawn in [window] (a turned rect's corners included).
    func windowRect(_ r: CGRect, _ window: UIWindow) -> CGRect {
        let pts = [CGPoint(x: r.minX, y: r.minY), CGPoint(x: r.maxX, y: r.minY), CGPoint(x: r.minX, y: r.maxY), CGPoint(x: r.maxX, y: r.maxY)]
            .map { convert($0, to: window) }
        let xs = pts.map(\.x), ys = pts.map(\.y)
        return CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
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
        // Inside a Scroll or List UIKit hands the touch over after its content delay (~150 ms): the touch's own time says
        // when the finger went down, so onLongPress comes 0.5 s after it, not 0.65 s (as Android, which has no delay).
        // Capped below the long press, so an odd timestamp can't fire it at once.
        let since = touches.first.map { CACurrentMediaTime() - $0.timestamp } ?? 0
        let late = min(max(self.late, since, 0), 0.4)
        self.late = 0
        guard isEnabled, !active else { return }
        let at = touches.first?.location(in: self) ?? CGPoint(x: bounds.midX, y: bounds.midY)
        lastDown = CGPoint(x: at.x - slop.left, y: at.y - slop.top)
        handled = false
        active = true
        if haptic { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        onEvent?(.down, .none)
        if let delay = repeatDelay {
            timer = Timer.scheduledTimer(withTimeInterval: max(0.01, delay - late), repeats: false) { [weak self] _ in
                guard let self else { return }
                self.handled = true
                self.onEvent?(.repeat, .none)
                self.timer = Timer.scheduledTimer(withTimeInterval: self.repeatInterval, repeats: true) { [weak self] _ in
                    self?.onEvent?(.repeat, .none)
                }
            }
        } else if longPressOn() {
            timer = Timer.scheduledTimer(withTimeInterval: max(0.01, 0.5 - late), repeats: false) { [weak self] _ in
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
