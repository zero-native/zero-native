// Elements that follow motion values (docs/motion.md §5; Android: ZnAnimation.kt znLayer / znBackground,
// ZnMotionUi.kt ZnMotionShape, ZnGesture.kt znSite, ZnRenderer.kt resolveSizePx). A slot holding "\u{0}m<id>" is read
// where it draws, each in a leaf modifier: ZnLayer (opacity, transforms, 3D turns, camera, blur), ZnBackground (a
// motion colour), ZnPaintLayers (corners) and ZnSizeFrame (width / height). A source's cell is @Observable, so a
// moving value runs that one modifier's body again (a few struct builds), never the node's view, its children, its
// parent or any JS. The rules are plain functions in ZnMotionBindRules.swift (Mac unit suite ios/tests/motion).
//
// Sizes for `self` / `parent` (ZnSite): a node whose bound formula reads them measures itself (its box inside the
// margin) and asks its parent for its content box (inside the parent's padding, as Android's parentLayoutCoordinates).
// Both go through ZnInstance.sizeBox, so gestures can read the same boxes ("N%self", "N%parent"): set `wanted` on a
// box and it is written from then on. A box nobody wants is never measured.
import SwiftUI

extension ZnInstance {
    /// The slot holds a motion reference (made yet or not).
    func followsMotion(_ slot: Int) -> Bool { slot >= 0 && znIsMotionRef(self.slot(slot).value) }

    /// A number slot that may follow a motion value (corners, sizes): its value now, or nil when it is neither.
    func boundNumber(_ slot: Int) -> CGFloat? { slot >= 0 ? znBoundNumberOrNil(self.slot(slot).value) : nil }

    /// The box children read as `parent`: node [node]'s content box, inside its padding. (sizeBox(node) is the
    /// node's own box; content boxes use the negative keys.)
    func contentBox(_ node: Int) -> ZnSizeBox { sizeBox(~node) }
}

extension ZnNodeSpec {
    /// A transform, 3D, camera or blur value comes from a slot (hasTransformSlots without making an array: these run
    /// in ZnLayer's body, each frame a bound value moves).
    var layerTransformSlots: Bool {
        scaleSlot >= 0 || scaleXSlot >= 0 || scaleYSlot >= 0 || translateXSlot >= 0 || translateYSlot >= 0 || rotateSlot >= 0 ||
            rotateXSlot >= 0 || rotateYSlot >= 0 || cameraDistanceSlot >= 0 || blurRadiusSlot >= 0
    }

    /// Something in the layer may follow a slot (so may follow a motion value): such a node can need its site.
    var hasLayerSlots: Bool { opacitySlot >= 0 || layerTransformSlots }

    /// ZnLayer draws transforms (2D or 3D, blur), not only opacity.
    var layerTransforms: Bool { hasTransform || hasDepth || layerTransformSlots }

    /// blurRadius is written or comes from a slot.
    var blurs: Bool { blurRadius != 0 || blurRadiusSlot >= 0 }
}

/// A layer slot follows a formula that reads `self` / `parent` now (reads the slots, so the caller follows them).
@MainActor func znSiteUsed(_ s: ZnNodeSpec, _ inst: ZnInstance) -> Bool {
    func uses(_ slot: Int) -> Bool { slot >= 0 && znMotionSource(inst.slot(slot).value)?.usesSite == true }
    return uses(s.opacitySlot) || uses(s.scaleSlot) || uses(s.scaleXSlot) || uses(s.scaleYSlot) || uses(s.rotateSlot) ||
        uses(s.translateXSlot) || uses(s.translateYSlot) || uses(s.rotateXSlot) || uses(s.rotateYSlot) ||
        uses(s.cameraDistanceSlot) || uses(s.blurRadiusSlot)
}

/// The content box of the node an element is laid out in: its template parent, or for an instance's root the node
/// of the parent instance that holds the anchor it is mounted at (a fragment root goes up once more, as its children
/// are laid out in its own parent).
@MainActor func znParentContentBox(_ s: ZnNodeSpec, _ inst: ZnInstance) -> ZnSizeBox? {
    if s.parent >= 0 { return inst.contentBox(s.parent) }
    guard let ctx = ZnApp.shared.ctx else { return nil }
    var child = inst
    for _ in 0..<8 {
        guard let p = ctx.store.find(child.parent), let t = ctx.templates[safe: p.templateId],
              let anchor = t.nodes[safe: child.anchor], anchor.parent >= 0 else { return nil }
        if anchor.parent == 0 && t.nodes[0].type == Registry.Component.fragment {
            child = p
            continue
        }
        return p.contentBox(anchor.parent)
    }
    return nil
}

/// The node's corners now, with any corner (or borderRadius) that follows a motion value read from it: the same
/// precedence as ZnNodeSpec.cornersNow (a corner of its own beats borderRadius; negative is 0). Read in
/// ZnPaintLayers, so a corner morph re-runs that modifier alone.
@MainActor func znShapeNow(_ s: ZnNodeSpec, _ inst: ZnInstance) -> UnevenRoundedRectangle {
    guard s.hasDynamicRadius else { return s.shape }
    let slots = [s.topStartRadiusSlot, s.topEndRadiusSlot, s.bottomEndRadiusSlot, s.bottomStartRadiusSlot]
    guard inst.followsMotion(s.borderRadiusSlot) || slots.contains(where: { inst.followsMotion($0) }) else {
        return s.shapeNow(inst)
    }
    typealias P = Registry.Prop
    func has(_ a: Int, _ b: Int) -> Bool { s.props[a] != nil || s.props[b] != nil }
    let c = znCorners(fixed: [s.topStart, s.topEnd, s.bottomEnd, s.bottomStart],
                      written: [has(P.borderTopStartRadius, P.borderTopLeftRadius), has(P.borderTopEndRadius, P.borderTopRightRadius),
                                has(P.borderBottomEndRadius, P.borderBottomRightRadius),
                                has(P.borderBottomStartRadius, P.borderBottomLeftRadius)],
                      cornerSlots: slots.map { inst.boundNumber($0) }, all: inst.boundNumber(s.borderRadiusSlot))
    return UnevenRoundedRectangle(topLeadingRadius: c[0], bottomLeadingRadius: c[3], bottomTrailingRadius: c[2],
                                  topTrailingRadius: c[1], style: .circular)
}

/// width / height from a slot that follows a motion value (registry 24): points now, never below 0; nil while the
/// value isn't made. Read in ZnSizeFrame, so a moving value lays that node out again each frame (as Android's layout
/// phase read: fine for one header or panel, not for many rows). [fallback]: the slot's usual reading.
@MainActor func znBoundSize(_ slot: Int, _ inst: ZnInstance, _ fallback: () -> ZnSize?) -> ZnSize? {
    guard inst.followsMotion(slot) else { return fallback() }
    return znMotionSource(inst.slot(slot).value).map { .points(max(0, CGFloat($0.read(nil)))) }
}

// MARK: - Sizes

/// Writes [box] with the size of the view it is on while someone wants it (a child's formula reading `parent`, a
/// gesture). The size is read after layout (onGeometryChange): the first frame of a formula sees 0, as on Android
/// before the first placement. Nil: this node never feeds one, and nothing is added.
struct ZnSizeWriter: ViewModifier {
    let box: ZnSizeBox?

    func body(content: Content) -> some View {
        if let box {
            let on = box.wanted
            content.onGeometryChange(for: CGSize.self) { on ? $0.size : .zero } action: { z in
                guard on else { return }
                znWrite(box, z)
            }
        } else {
            content
        }
    }
}

/// [box] = [z], each side only when it changed (a write notifies its readers).
@MainActor func znWrite(_ box: ZnSizeBox, _ z: CGSize) {
    if box.w != Double(z.width) { box.w = Double(z.width) }
    if box.h != Double(z.height) { box.h = Double(z.height) }
}

/// The ZnSite a node's bound formulas read: made, and fed with the node's own size and its parent's content size,
/// once [on] (a layer slot follows a formula reading `self` / `parent`). Inside ZnLayer, under its transforms, so the
/// size is the laid-out one.
struct ZnSiteFeed: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    let on: Bool
    @Binding var site: ZnSite?

    func body(content: Content) -> some View {
        let own = inst.sizeBox(s.index)
        let wanted = on || own.wanted
        let parent = on ? znParentContentBox(s, inst) : nil
        let p = CGSize(width: parent?.w ?? 0, height: parent?.h ?? 0)  // read here: a parent resize feeds the site
        content
            .onGeometryChange(for: CGSize.self) { wanted ? $0.size : .zero } action: { z in
                guard wanted else { return }
                znWrite(own, z)
                site?.update(Float(z.width), Float(z.height), Float(p.width), Float(p.height))
            }
            .onChange(of: on, initial: true) { _, on in
                guard on else { return }
                parent?.wanted = true
                own.wanted = true
                let made = site ?? ZnSite()
                if site == nil { site = made }
                made.update(Float(own.w), Float(own.h), Float(p.width), Float(p.height))
            }
            .onChange(of: p) { _, p in
                site?.update(Float(own.w), Float(own.h), Float(p.width), Float(p.height))
            }
    }
}

// MARK: - 3D turns and blur

/// A layer's scale, rotate, 3D turn and translation as one projection (znLayerMatrix), for a node with no `animate`:
/// one effect to update per frame instead of a chain of them, which is what a moving value costs.
struct ZnLayerEffect: GeometryEffect {
    var scaleX: CGFloat, scaleY: CGFloat, rotate: CGFloat
    var rotateX: CGFloat, rotateY: CGFloat, camera: CGFloat
    var translateX: CGFloat, translateY: CGFloat
    var origin: UnitPoint
    var scale: CGFloat

    var animatableData: EmptyAnimatableData {
        get { EmptyAnimatableData() }
        set {}
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(znLayerMatrix(size: size, scaleX: scaleX, scaleY: scaleY, rotate: rotate, rotateX: rotateX,
                                          rotateY: rotateY, cameraDistance: camera, translateX: translateX,
                                          translateY: translateY, originX: origin.x, originY: origin.y, scale: scale))
    }
}

/// rotateX / rotateY about the transform origin with the camera distance (ZnDepthEffect), only on a node that uses
/// them (hasDepth: written, from a slot, or an enter / exit that turns), so other nodes get no extra modifier.
struct ZnDepthIf: ViewModifier {
    let on: Bool
    let rotateX: CGFloat, rotateY: CGFloat, camera: CGFloat
    let origin: UnitPoint
    let scale: CGFloat

    func body(content: Content) -> some View {
        if on {
            content.modifier(ZnDepthEffect(rotateX: rotateX, rotateY: rotateY, cameraDistance: max(camera, 0.1), origin: origin,
                                           scale: scale))
        } else {
            content
        }
    }
}

/// blurRadius (points) on everything the layer draws (background and border too, as Android's layer renderEffect),
/// only on a node that has one. iOS blurs on every version; Android only from 12.
struct ZnBlurIf: ViewModifier {
    let on: Bool
    let radius: CGFloat
    let scale: CGFloat

    func body(content: Content) -> some View {
        if on { content.blur(radius: znBlurSigma(radius, scale: scale), opaque: false) } else { content }
    }
}

// MARK: - The cost per frame (Debug)

#if DEBUG
/// ZN_MOTION_PERF=1 (a Debug build): once a second while bound values move, logs the frames, the main thread's busy
/// CPU time per frame (the engine's tick, SwiftUI's update of the bound modifiers, layout and the Core Animation commit)
/// and the bodies that ran per frame, so the cost of N bound boxes can be read on a device or the simulator:
/// "motion-perf: 120 frames/s, main thread 1.40 ms/frame, per frame: 30.0 Layer, 0.0 Background, 0.0 node".
@MainActor
enum ZnMotionPerf {
    static let on = ProcessInfo.processInfo.environment["ZN_MOTION_PERF"] == "1"
    private static var frames = 0
    private static var busy: CFTimeInterval = 0
    private static var awake: CFTimeInterval = 0
    private static var bodies: [String: Int] = [:]
    private static var windowStart: CFTimeInterval = 0
    private static var observer: CFRunLoopObserver?
    private static let owner = NSObject()

    /// Counts one body run of [name] ("Layer", "Background", "Paint", "node").
    static func hit(_ name: String) {
        guard on else { return }
        start()
        bodies[name, default: 0] += 1
    }

    private static func start() {
        guard observer == nil else { return }
        let o = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue,
                                                   true, Int.max) { _, activity in
            // The main thread's own CPU time, so other processes on a busy Mac don't count.
            let t = Double(clock_gettime_nsec_np(CLOCK_THREAD_CPUTIME_ID)) / 1e9
            if activity == .afterWaiting { awake = t } else if awake > 0 { busy += t - awake; awake = 0 }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), o, .commonModes)
        observer = o
        windowStart = CACurrentMediaTime()
        ZnMotionEngine.shared.onFrame(owner) { _ in
            MainActor.assumeIsolated { frame() }
            return true
        }
    }

    private static func frame() {
        frames += 1
        let now = CACurrentMediaTime()
        guard now - windowStart >= 1 else { return }
        let n = Double(max(frames, 1))
        let per = ["Layer", "Background", "Paint", "Size", "node"].map { String(format: "%.1f %@", Double(bodies[$0] ?? 0) / n, $0) }
        print(String(format: "motion-perf: %d frames/s, main thread %.2f ms/frame, per frame: %@", Int(Double(frames) / (now - windowStart)),
                     busy * 1000 / n, per.joined(separator: ", ")))
        frames = 0
        busy = 0
        bodies = [:]
        windowStart = now
    }
}
#endif
