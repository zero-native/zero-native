// animateLayout (Android: ZnMotionUi.kt znAnimateLayout; Reanimated's layout transitions): when a node's size changes it
// grows or shrinks to the new size, and when its place changes (a row above it went, chips reflow) it glides there,
// with the node's timing (spring or tween). Two parts, as Android's two modifiers:
// - ZnAnimateLayout (right after ZnSizeFrame, so the background and border drawn around it follow the animated box):
//   the size, as animateContentSize. A Layout that measures the content's own size and reports the animated one; the
//   content is placed at its own size and clipped to the box (animateContentSize clips too), so text inside isn't
//   squeezed while the box grows. Each frame lays the node and its parent out again, so the siblings it pushes move
//   with it.
// - ZnAnimatePlace (outermost, after the paint): the place, as Android's offset from the previous positionInParent. A
//   Layout that sees where it is placed; when that changes it stays drawn where it was and glides to the new place
//   (FLIP), in the same layout pass, so no frame shows it at the new place first.
// Both step on ZnFrameClock with the engine's curves (ZnLayoutAnim, ZnMotionMath.swift), so a spring keeps its speed
// when the target moves again. Reduce Motion (animations off): sizes and places jump.
//
// The node's state for both is one ZnLayoutMotionBox, kept by ZnLayoutMotionLink in ZnChildTraits (the node's
// outermost modifier): zn's own layouts reach it there (ZnPlaceKey) and tell it where they place the node in their box
// (LayoutSubview.znPlace), as Android's positionInParent, so a moving ancestor doesn't start a glide; the two
// modifiers get it from the environment. animateLayout is a build-time value, so a node has it or not for good.
//
// iOS differences: a node placed by something other than a Column / Row / wrap / Stack (a Scroll's content root, a
// List row) uses its place in that container's coordinate space; a node in a List cell grows inside a cell that takes
// its new size at once.
import SwiftUI

/// One node's animateLayout state, made once for its view (ZnLayoutMotionLink).
final class ZnLayoutMotionBox {
    let grow: ZnGrowBox
    let place: ZnPlaceBox

    init(_ spec: ZnTimingSpec) {
        grow = ZnGrowBox(spec)
        place = ZnPlaceBox(spec)
    }

    /// The node's timing now, for the next change (zn dev may reload a template with another one).
    func use(_ spec: ZnTimingSpec) {
        grow.step.anim.spec = spec
        place.step.anim.spec = spec
    }
}

/// What a zn layout reads off an animateLayout child, to tell it where it placed it (LayoutSubview.znPlace).
struct ZnPlaceKey: LayoutValueKey {
    static var defaultValue: ZnLayoutMotionBox? { nil }
}

private struct ZnLayoutMotionEnvKey: EnvironmentKey {
    static var defaultValue: ZnLayoutMotionBox? { nil }
}

extension EnvironmentValues {
    /// The nearest animateLayout node's box; read only by that node's own two modifiers (each animateLayout node
    /// sets its own).
    fileprivate var znLayoutMotion: ZnLayoutMotionBox? {
        get { self[ZnLayoutMotionEnvKey.self] }
        set { self[ZnLayoutMotionEnvKey.self] = newValue }
    }
}

/// In ZnChildTraits (outermost, so the parent's Layout sees the box: a probe such as onGeometryChange inside the node
/// hides layout values set under it).
struct ZnLayoutMotionLink: ViewModifier {
    let s: ZnNodeSpec

    func body(content: Content) -> some View {
        if let t = s.animateLayout { content.modifier(ZnLayoutMotionHold(spec: znLayoutSpec(t))) } else { content }
    }
}

private struct ZnLayoutMotionHold: ViewModifier {
    let spec: ZnTimingSpec
    @State private var box: ZnLayoutMotionBox

    init(spec: ZnTimingSpec) {
        self.spec = spec
        _box = State(initialValue: ZnLayoutMotionBox(spec))
    }

    func body(content: Content) -> some View {
        let _ = box.use(spec)
        content
            .environment(\.znLayoutMotion, box)
            .layoutValue(key: ZnPlaceKey.self, value: box)
    }
}

extension LayoutSubview {
    /// place(at:) from the top start corner, for zn's own layouts (ZnFlexLayout, ZnWrapLayout, ZnStackLayout): an
    /// animateLayout child is also told its place in [bounds], the parent's box (Android's positionInParent).
    func znPlace(at p: CGPoint, in bounds: CGRect, proposal: ProposedViewSize) {
        if let b = self[ZnPlaceKey.self] { b.place.parentPlaced(CGPoint(x: p.x - bounds.minX, y: p.y - bounds.minY)) }
        place(at: p, anchor: .topLeading, proposal: proposal)
    }
}

struct ZnAnimateLayout: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if s.animateLayout != nil { content.modifier(ZnAnimatedSize()) } else { content }
    }
}

/// The node's place; outermost in the node's chain (ZnRenderer.swift styled).
struct ZnAnimatePlace: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if s.animateLayout != nil { content.modifier(ZnAnimatedPlace()) } else { content }
    }
}

/// animateLayout's timing as the engine's (Android: ZnTiming.finiteSpec: a tween or a spring; no delay).
func znLayoutSpec(_ t: ZnTiming) -> ZnTimingSpec {
    t.ms >= 0
        ? ZnTimingSpec(ms: t.ms, easing: t.easing, bezier: t.bezier, ratio: 1, stiffness: 0, clamp: false)
        : ZnTimingSpec(ms: -1, easing: 0, bezier: nil, ratio: Float(t.damping), stiffness: Float(t.stiffness), clamp: false)
}

/// ZN_LAYOUT_MOTION_LOG=1 (debug): each size measure and placement is printed.
private let znLayoutLog: Bool = {
    #if DEBUG
    return ProcessInfo.processInfo.environment["ZN_LAYOUT_MOTION_LOG"] == "1"
    #else
    return false
    #endif
}()

/// A frame counter the modifier's body reads: a frame of the animation makes SwiftUI lay the node out again.
@Observable
final class ZnLayoutTick {
    var n = 0
}

/// One animation stepped on ZnFrameClock; [onFrame] runs after each step.
final class ZnLayoutStepper {
    var anim: ZnLayoutAnim
    let tick = ZnLayoutTick()
    private var running = false

    init(_ spec: ZnTimingSpec) { anim = ZnLayoutAnim(spec, x: 0, y: 0) }

    /// Starts frames if the animation moves (from layout: no observed state is written here).
    func run() {
        guard anim.moving, !running else { return }
        running = true
        MainActor.assumeIsolated {
            ZnFrameClock.shared.add(self) { [weak self] t in
                guard let self else { return false }
                let more = self.anim.frame(Int64(t * 1e9))
                self.tick.n &+= 1
                if !more { self.running = false }
                return more
            }
        }
    }
}

// MARK: - Size

private struct ZnAnimatedSize: ViewModifier {
    @Environment(\.znLayoutMotion) private var box

    func body(content: Content) -> some View {
        if let box {
            ZnAnimatedSizeLayout(box: box.grow, tick: box.grow.step.tick.n) { content }
                .clipped()
        } else {
            content
        }
    }
}

/// What the size layout keeps between passes.
final class ZnGrowBox {
    let step: ZnLayoutStepper
    /// The content's own size from the latest measure (the parent's last measure before it places the node).
    var natural: CGSize?
    /// The parent is measuring the node now (set by its place layout around the measure). Asked at other times, the
    /// size layout is the node being placed (the chain above passes its placed size down): the content isn't measured
    /// again then, so [natural] stays the parent's (a Text asked at its old width would say it is narrower).
    var measuring = false
    var settled = false

    init(_ spec: ZnTimingSpec) { step = ZnLayoutStepper(spec) }

    var shown: CGSize { CGSize(width: CGFloat(step.anim.x), height: CGFloat(step.anim.y)) }
    var target: CGSize { CGSize(width: CGFloat(step.anim.toX), height: CGFloat(step.anim.toY)) }
}

private func znApart(_ a: CGSize, _ b: CGSize) -> Bool { abs(a.width - b.width) > 0.5 || abs(a.height - b.height) > 0.5 }

private struct ZnAnimatedSizeLayout: Layout {
    let box: ZnGrowBox
    /// Changes each frame of the animation: SwiftUI lays this out again.
    let tick: Int

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let n: CGSize
        if box.measuring || box.natural == nil {
            n = child.sizeThatFits(proposal)
            box.natural = n
        } else {
            n = box.natural!
        }
        let r: CGSize
        if !box.settled {
            r = n  // until it is first placed, its own size (a parent may ask with other proposals first)
        } else if box.step.anim.moving {
            r = box.shown
        } else {
            // At rest: the content's own size, unless it changed; then the old one until it is placed (placeSubviews
            // starts the animation from there), so no frame shows the new size first.
            r = znApart(n, box.target) ? box.target : n
        }
        if znLayoutLog { print("zn layout-motion size: \(box.measuring ? "measured" : "placing"), \(proposal.width.map { "\($0)" } ?? "nil") x \(proposal.height.map { "\($0)" } ?? "nil") own \(n) answer \(r)") }
        return r
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let n = box.natural ?? bounds.size
        if znLayoutLog { print("zn layout-motion size: placed \(bounds.size) own \(n) target \(box.target)") }
        if !box.settled {
            // The first size: no animation (as animateContentSize's first measure).
            box.settled = true
            box.step.anim.jump(Float(n.width), Float(n.height))
        } else if znApart(n, box.target) {
            if MainActor.assumeIsolated({ znAnimationsOff() }) {
                box.step.anim.jump(Float(n.width), Float(n.height))
            } else {
                box.step.anim.go(Float(n.width), Float(n.height))
                box.step.run()
            }
        }
        // At its own size from the top start corner; the box clips it while it differs.
        child.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(n))
    }
}

// MARK: - Place

private struct ZnAnimatedPlace: ViewModifier {
    @Environment(\.znLayoutMotion) private var box

    func body(content: Content) -> some View {
        if let box {
            ZnAnimatedPlaceLayout(box: box, tick: box.place.step.tick.n) { content }
        } else {
            content
        }
    }
}

/// Where the node was placed last; the offset it is drawn at moves to 0.
final class ZnPlaceBox {
    let step: ZnLayoutStepper
    /// The last place: in the parent's box once a zn layout told it (parentPlaced), else the place layout's own.
    private var origin: CGPoint?
    /// A zn layout places it (its place is then the parent's word, not the place layout's coordinates).
    private(set) var byParent = false
    /// When it was first placed. A new node is placed more than once as it comes in (SwiftUI may place it at its
    /// container's corner first): for a moment it takes each new place at once, as Android's first onPlaced.
    private var firstPlaced: CFTimeInterval = 0

    init(_ spec: ZnTimingSpec) { step = ZnLayoutStepper(spec) }

    /// Its parent (a zn layout) places it at [p] in its box, before the node's own layout runs.
    func parentPlaced(_ p: CGPoint) {
        if !byParent {
            byParent = true
            if origin != nil {
                origin = p  // the coordinates change, not the place
                return
            }
        }
        moved(to: p)
    }

    /// A place [o]; a new one starts the glide from where it was seen (FLIP).
    func moved(to o: CGPoint) {
        let now = CACurrentMediaTime()
        guard let was = origin else {
            origin = o
            firstPlaced = now
            return
        }
        origin = o
        guard abs(was.x - o.x) > 0.5 || abs(was.y - o.y) > 0.5 else { return }
        let a = step.anim
        if now - firstPlaced < 0.1 || MainActor.assumeIsolated({ znAnimationsOff() }) {
            step.anim.jump(0, 0)
        } else {
            // Drawn where it was seen (its old place plus the offset it had), going to its new place.
            step.anim.go(0, 0, fromX: a.x + Float(was.x - o.x), fromY: a.y + Float(was.y - o.y))
            step.run()
            if znLayoutLog { print("zn layout-motion place: glide from \(was) to \(o)\(byParent ? " in the parent" : "")") }
        }
    }
}

private struct ZnAnimatedPlaceLayout: Layout {
    let box: ZnLayoutMotionBox
    let tick: Int

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        // The parent measuring the node (the size layout below measures its content only now).
        box.grow.measuring = true
        defer { box.grow.measuring = false }
        return child.sizeThatFits(proposal)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let p = box.place
        if !p.byParent { p.moved(to: bounds.origin) }
        let a = p.step.anim
        child.place(at: CGPoint(x: bounds.minX + CGFloat(a.x), y: bounds.minY + CGFloat(a.y)), anchor: .topLeading,
                    proposal: ProposedViewSize(bounds.size))
    }
}
