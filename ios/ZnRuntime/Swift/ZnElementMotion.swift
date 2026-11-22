// useElementMotion() on iOS (`motion={m}`; Android: ZnMotionUi.kt znElementOf / ZnProvide / ZnFollow / ZnPressMotion /
// znElementBox). An element gives:
// - its box in the window (x, y, width, height, in points = dp), written when it is placed, when a scroll view around it
//   scrolls, and right before a measure() read (ZnElementBoxView, a clear UIView in the node's background, inside its
//   layer, so a moved or scaled node gives where it is drawn: Android's positionInWindow inside graphicsLayer);
// - a Pressable's press as 0 → 1 (`pressed`): a quick spring down (ratio 1, stiffness 1500), a softer one back (0.6);
// - scrolling things' values (Scroll scrollX / scrollY, List index / offset / scroll, Carousel page, pull to refresh):
//   their owners give the element's lambda source a reader while they are on screen (ZnProvided) and follow m.follow(v)
//   through ZnFollower. Sheet progress comes with the sheet's own work (W4-A).
//
// Also here, inside the layer for the same reason: a Pressable's press feedback and touch view (ZnPressInLayer). They
// used to sit around the node, outside its transforms, so a moved Pressable took taps where it was laid out, not where
// it was drawn (Compose's pointer input sits inside graphicsLayer).
import SwiftUI
import UIKit

extension ZnNodeSpec {
    /// The element motion this node fills, or nil (Android's znElementOf). Read in a body: a miss reads the engine's
    /// generation, so the body runs again when JS's `element` call reaches the main thread after the template batch.
    @MainActor func elementNow(_ inst: ZnInstance) -> ZnElementMotion? {
        guard motionSlot >= 0, let n = inst.slot(motionSlot).value.number, n.isFinite else { return nil }
        let engine = ZnMotionEngine.shared
        if let e = engine.element(Int(n)) { return e }
        _ = engine.generation.n
        return nil
    }
}

/// ZnProvide: who gives a lambda source its reader now. A component that goes away clears the reader only while it is
/// still its own (the same `m` on a screen leaving and on the one coming keeps the newer one's), and the source then
/// keeps its last value.
@MainActor
enum ZnProvided {
    private final class Owner {
        weak var o: AnyObject?
        init(_ o: AnyObject) { self.o = o }
    }
    private static var owners: [ObjectIdentifier: Owner] = [:]

    static func provide(_ src: ZnLambdaSource?, by owner: AnyObject, _ reader: @escaping () -> Float) {
        guard let src else { return }
        owners[ObjectIdentifier(src)] = Owner(owner)
        src.reader = reader
    }

    static func release(_ src: ZnLambdaSource?, by owner: AnyObject) {
        guard let src, let o = owners[ObjectIdentifier(src)], o.o === owner else { return }
        owners[ObjectIdentifier(src)] = nil
        src.reader = nil
    }
}

/// m.follow(v) (ZnFollow): while set, each new value of v goes to [apply] at once (on the frame after it moved), which
/// scrolls the element there with no animation. Smoothness comes from v itself; the user can still scroll, and the
/// next change of v wins. Only a change applies (Android's snapshotFlow), so the scroll it causes doesn't loop back.
@MainActor
final class ZnFollower {
    private var src: ZnSource?
    private var last: Float = .nan
    var apply: (Float) -> Void

    init(_ apply: @escaping (Float) -> Void = { _ in }) { self.apply = apply }

    /// The value to follow now (nil stops). A new source applies its value at once.
    func set(_ s: ZnSource?) {
        guard s !== src else { return }
        src = s
        last = .nan
        let engine = ZnMotionEngine.shared
        if s == nil {
            engine.removeOnDirty(self)
            return
        }
        engine.onDirty(self) { [weak self] in MainActor.assumeIsolated { self?.check() } }
        check()
    }

    /// Applies the source's value if it changed (also after the scroll view came back: [force]).
    func check(force: Bool = false) {
        guard let src else { return }
        let v = src.read(nil)
        guard v.isFinite, force || v != last else { return }
        last = v
        apply(v)
    }
}

/// The element seam inside ZnPaintLayers, before ZnLayer (so inside the node's transforms): the box writer, and for a
/// Pressable (UIKit variant) its feedback, press look and touch view.
struct ZnElementProbe: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znPressLink) private var press

    func body(content: Content) -> some View {
        let link = press.flatMap { $0.node == s.index && $0.inst === inst ? $0 : nil }
        let element = s.motionSlot >= 0 ? s.elementNow(inst) : nil
        content
            // The link is this node's: its children don't see it (a Pressable inside starts its own).
            .environment(\.znPressLink, nil)
            .modifier(ZnPressInLayer(s: s, inst: inst, link: link, element: element))
            .background {
                if let element, element.hasBox { ZnElementBoxView(element: element).allowsHitTesting(false).accessibilityHidden(true) }
            }
    }
}

extension ZnElementMotion {
    /// It has a box value (x, y, width, height): useElementMotion always makes all four.
    var hasBox: Bool { value("x") != nil || value("y") != nil || value("width") != nil || value("height") != nil }
}

// MARK: - The box

/// Writes the element's box in the window from a clear view the size of the node.
struct ZnElementBoxView: UIViewRepresentable {
    let element: ZnElementMotion

    func makeUIView(context: Context) -> ZnElementBoxUIView {
        let v = ZnElementBoxUIView()
        v.isUserInteractionEnabled = false
        v.isAccessibilityElement = false
        return v
    }

    func updateUIView(_ v: ZnElementBoxUIView, context: Context) {
        v.element = element
        // After SwiftUI has placed it (an update runs before the new frame is set).
        DispatchQueue.main.async { [weak v] in v?.write() }
    }

    static func dismantleUIView(_ v: ZnElementBoxUIView, coordinator: ()) {
        v.element = nil
        v.watchScrolls(false)
    }
}

final class ZnElementBoxUIView: UIView {
    var element: ZnElementMotion? {
        didSet {
            guard element !== oldValue else { return }
            if let old = oldValue, Self.refreshers[ObjectIdentifier(old)]?.v === self {
                old.refresh = nil
                Self.refreshers[ObjectIdentifier(old)] = nil
            }
            if let e = element {
                e.refresh = { [weak self] in self?.write() }
                Self.refreshers[ObjectIdentifier(e)] = Weak(self)
            }
        }
    }
    private var watches: [NSKeyValueObservation] = []

    /// Whose [ZnElementMotion.refresh] each element's is (a box view leaving clears only its own).
    private final class Weak {
        weak var v: ZnElementBoxUIView?
        init(_ v: ZnElementBoxUIView) { self.v = v }
    }
    private static var refreshers: [ObjectIdentifier: Weak] = [:]

    override func layoutSubviews() {
        super.layoutSubviews()
        write()
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        watchScrolls(window != nil)
        if window != nil { write() }
    }

    /// Android's onGloballyPositioned also runs when a scroll moves the element: every scroll view around it is watched
    /// (a SwiftUI one, a List's collection view, a Carousel).
    func watchScrolls(_ on: Bool) {
        watches.forEach { $0.invalidate() }
        watches = []
        guard on else { return }
        var p = superview
        while let v = p {
            if let sv = v as? UIScrollView {
                watches.append(sv.observe(\.contentOffset, options: []) { [weak self] _, _ in
                    MainActor.assumeIsolated { self?.write() }
                })
            }
            p = v.superview
        }
    }

    /// x, y: where its top-left corner is drawn in the window (with the node's transforms); width, height: its own size
    /// (not scaled), as Android's positionInWindow and size.
    func write() {
        guard let e = element, window != nil else { return }
        let at = convert(CGPoint.zero, to: nil)
        e.value("x")?.value = Float(at.x)
        e.value("y")?.value = Float(at.y)
        e.value("width")?.value = Float(bounds.width)
        e.value("height")?.value = Float(bounds.height)
    }
}

// MARK: - A Pressable inside its layer

/// What a Pressable (UIKit variant) hands to its own node's ZnElementProbe: its press state and context. One per
/// Pressable (its @State); [inst] and [node] say whose it is, set by ZnPressable each body run.
@MainActor
final class ZnPressLink {
    let state = ZnPressState()
    var ctx: ZnContext?
    weak var inst: ZnInstance?
    var node = -1
    /// `pressed` of the element motion: 0 → 1, moved by springs (ZnPressMotion).
    let pressed = ZnMotionValue(id: -1, 0)
}

extension EnvironmentValues {
    /// The Pressable around this node's paint (see ZnPressLink). Cleared under the node itself.
    @Entry var znPressLink: ZnPressLink? = nil
}

/// The press feedback (ripple or highlight, in the node's shape now, corners from motion values too), the press look
/// (pressScale, pressOpacity) and the touch view (with hitSlop), all under the node's transforms. Nothing for a node
/// that isn't a UIKit Pressable.
struct ZnPressInLayer: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    let link: ZnPressLink?
    let element: ZnElementMotion?

    func body(content: Content) -> some View {
        if let link, let ctx = link.ctx {
            content.modifier(ZnPressDrawn(ctx: ctx, s: s, inst: inst, link: link, element: element))
        } else {
            content
        }
    }
}

private struct ZnPressDrawn: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let link: ZnPressLink
    let element: ZnElementMotion?

    func body(content: Content) -> some View {
        let state = link.state
        // `disabled` may change at runtime (a slot, e.g. the Pay button's disabled={!active()}).
        let disabled = s.disabledNow(inst)
        // pointerEvents "none" / "box-none": this Pressable takes no taps itself (its children may: box-none).
        let pe = s.pointerEventsNow(inst)
        let selfOff = pe == Registry.PointerEvents.none || pe == Registry.PointerEvents.boxNone
        content
            .overlay { ZnPressFeedback(s: s, state: state, shape: znShapeNow(s, inst)).accessibilityHidden(true) }
            .scaleEffect(state.pressed ? s.pressScale : 1)
            .opacity(state.pressed ? s.pressOpacity : 1)
            .animation(.spring(response: 0.2, dampingFraction: 0.8), value: state.pressed)
            // hitSlop: the touch view reaches past the Pressable by the slop (start / end follow the layout
            // direction, as SwiftUI's leading / trailing).
            .overlay(ZnTouchTarget(ctx: ctx, s: s, inst: inst, state: state, disabled: disabled, off: selfOff)
                .padding(s.hitSlop.map { EdgeInsets(top: -$0.top, leading: -$0.start, bottom: -$0.bottom, trailing: -$0.end) } ?? EdgeInsets()))
            .modifier(ZnPressMotion(link: link, element: element))
    }
}

/// `pressed` of the element motion (ZnPressMotion): springs towards 1 on a press, back to 0 on its release. With
/// Reduce Motion (animations off) it jumps.
private struct ZnPressMotion: ViewModifier {
    let link: ZnPressLink
    let element: ZnElementMotion?

    func body(content: Content) -> some View {
        if let element, let src = element.lambda("pressed") {
            content
                .onAppear {
                    let v = link.pressed
                    ZnProvided.provide(src, by: link) { v.cell.v }
                }
                .onDisappear { ZnProvided.release(src, by: link) }
                .onChange(of: link.state.pressed) { _, down in Self.move(link.pressed, to: down ? 1 : 0) }
        } else {
            content
        }
    }

    @MainActor static func move(_ v: ZnMotionValue, to target: Float) {
        let engine = ZnMotionEngine.shared
        if znAnimationsOff() { return engine.set(v, target, interrupt: true) }
        let spring = ZnTimingSpec(ms: -1, easing: 0, bezier: nil, ratio: target > 0 ? 1 : 0.6, stiffness: 1500, clamp: false)
        engine.animate(v, to: target, timing: spring)
    }
}
