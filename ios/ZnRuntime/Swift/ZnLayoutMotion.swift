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
// iOS differences: a place is where the parent's layout puts the node in its coordinate space, which a moving ancestor
// moves too (Android's positionInParent doesn't); a node in a List cell grows inside a cell that takes its new size at
// once.
import SwiftUI

struct ZnAnimateLayout: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if let t = s.animateLayout { content.modifier(ZnAnimatedSize(spec: znLayoutSpec(t))) } else { content }
    }
}

/// The node's place; outermost in the node's chain (ZnRenderer.swift styled).
struct ZnAnimatePlace: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if let t = s.animateLayout { content.modifier(ZnAnimatedPlace(spec: znLayoutSpec(t))) } else { content }
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
    let spec: ZnTimingSpec
    @State private var box: ZnGrowBox

    init(spec: ZnTimingSpec) {
        self.spec = spec
        _box = State(initialValue: ZnGrowBox(spec))
    }

    func body(content: Content) -> some View {
        ZnAnimatedSizeLayout(box: box, tick: box.step.tick.n) { content }
            .clipped()
    }
}

/// What the size layout keeps between passes.
private final class ZnGrowBox {
    let step: ZnLayoutStepper
    /// The content's own size from the latest measure (the parent's last measure before it places the node).
    var natural: CGSize?
    /// The size it last answered: a proposal of that size is the node being placed (the chain above passes its
    /// placed size down), not a measure, so it must not change [natural] (a Text asked at its old width says so).
    var answered: CGSize?
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
        // Within a point of it (the answer is kept as a Float, and a frame's answer may reach the chain a frame late).
        if let a = box.answered, let w = proposal.width, let h = proposal.height, abs(w - a.width) <= 1, abs(h - a.height) <= 1 {
            return a
        }
        let n = child.sizeThatFits(proposal)
        box.natural = n
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
        box.answered = r
        if znLayoutLog { print("zn layout-motion size: asked \(proposal.width.map { "\($0)" } ?? "nil") x \(proposal.height.map { "\($0)" } ?? "nil") own \(n) answer \(r)") }
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
    let spec: ZnTimingSpec
    @State private var box: ZnPlaceBox

    init(spec: ZnTimingSpec) {
        self.spec = spec
        _box = State(initialValue: ZnPlaceBox(spec))
    }

    func body(content: Content) -> some View {
        ZnAnimatedPlaceLayout(box: box, tick: box.step.tick.n) { content }
    }
}

/// Where the node was placed last; the offset it is drawn at moves to 0.
private final class ZnPlaceBox {
    let step: ZnLayoutStepper
    var origin: CGPoint?
    /// When it was first placed. A new node is placed more than once as it comes in (SwiftUI may place it at its
    /// container's corner first): for a moment it takes each new place at once, as Android's first onPlaced.
    var firstPlaced: CFTimeInterval = 0

    init(_ spec: ZnTimingSpec) { step = ZnLayoutStepper(spec) }
}

private struct ZnAnimatedPlaceLayout: Layout {
    let box: ZnPlaceBox
    let tick: Int

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        subviews.first?.sizeThatFits(proposal) ?? .zero
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let o = bounds.origin
        let now = CACurrentMediaTime()
        if box.origin == nil { box.firstPlaced = now }
        if let was = box.origin, abs(was.x - o.x) > 0.5 || abs(was.y - o.y) > 0.5 {
            let a = box.step.anim
            if now - box.firstPlaced < 0.1 || MainActor.assumeIsolated({ znAnimationsOff() }) {
                box.step.anim.jump(0, 0)
            } else {
                // Drawn where it was seen (its old place plus the offset it had), going to its new place.
                box.step.anim.go(0, 0, fromX: a.x + Float(was.x - o.x), fromY: a.y + Float(was.y - o.y))
                box.step.run()
            }
        }
        box.origin = o
        let a = box.step.anim
        child.place(at: CGPoint(x: o.x + CGFloat(a.x), y: o.y + CGFloat(a.y)), anchor: .topLeading,
                    proposal: ProposedViewSize(bounds.size))
    }
}
