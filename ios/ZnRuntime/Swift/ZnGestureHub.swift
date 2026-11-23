// Touches for the gestures (Android: Modifier.znGesture's pointerInput in ZnGesture.kt). A node with `gesture={g}`
// gets a probe: a clear UIView behind its content and inside its layer, so it moves, scales and turns with the node.
// The probe gives the gesture its size (and its parent's, for "%" coordinates) and tells where the node is; it takes
// no touches itself. Each screen (and each Sheet or Modal, which have their own controller) has one hub on its
// controller's view: two UIGestureRecognizers that every touch in that screen passes.
//
// - The feed sees every touch and never stops anyone (simultaneous with all, never prevented). A finger landing on
//   probes starts one touch session per node (ZnGestureRecognizers.swift), ordered as Compose's passes: withParent
//   "block" outermost first, then the rest innermost first. Each UIKit callback becomes one ZnPointerEvent per session.
// - The claim is the touch in UIKit's terms. It begins when a consuming recognizer becomes active (a pan, pinch,
//   rotate or long press that started), so a scroll around it stops and the Pressables under the finger get their
//   touches cancelled (onPressOut(true)), as on Android. The pans of the scrolls and sheets around a probe wait for it
//   to fail: the child decides first, as in Compose, where it sees each event before its parent. It fails at the first
//   move after which no consuming recognizer can start any more (a one-axis pan that went the other way, a tap), and
//   then the scroll starts at once.
// - A scroll's (or a sheet's, or the back swipe's) pan that starts anyway took the touch: the sessions' events are
//   marked consumed, and their consuming recognizers that haven't started give up, as Android's takenByOther.
// - The back swipe (ZnNavHost.swift) doesn't start on a horizontal pan: claimsBackEdge, Android's
//   systemGestureExclusion band (the whole node if at most 200 pt tall, else a 200 pt band at its centre).
// - withParent "after-edge" on a vertical pan with a list inside (a panel): the list scrolls; finger up while the pan
//   is below its top bound, or pulling down with the list at its top, moves the pan instead and stops the list's drag
//   (Android: ZnNestedPan). "simultaneous": the pan never takes the touch from the scroll it is in.
//
// Deadlines (long press, the gap of a double tap) run on one timer per hub; manualActivation and requireToFail look
// again each frame (16 ms) while they wait, as Android's loop.
import SwiftUI
import UIKit

extension ZnGestures {
    /// The gesture functions of the `Motion` module (Android: ZnGestures.install). useZoom's zoomTo comes with
    /// gesture-zoom.
    @MainActor static func install(_ m: ZnMotionModule) {
        haptic = { k in MainActor.assumeIsolated { ZnHaptics.play(k) } }
        if ZnGestureHub.log { trace = { print("zn t=\(ZnDebug.ms()) gesture event: \($0)") } }
        m.addFunction("gesture") { c in
            try make(c.args)
            c.resolve()
        }
        m.addFunction("gestureGroup") { c in
            try makeGroup(c.args)
            c.resolve()
        }
        m.addFunction("gestureState") { c in
            setState(c.args)
            c.resolve()
        }
        m.addFunction("snapTo") { c in try snapTo(c.args) { c.resolve($0) } }
    }
}

// MARK: - The node's side

/// The gesture a node handles (gestureSlot): its probe, only on a node that has one. Applied inside ZnPaintLayers
/// before ZnLayer, so its touch area moves, scales and turns with the node.
struct ZnGestureModifier: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if s.gestureSlot >= 0 { content.modifier(ZnGestureNode(s: s, inst: inst)) } else { content }
    }
}

private struct ZnGestureNode: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znGestureDepth) private var depth
    @Environment(\.znInHiddenTab) private var hiddenTab
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        let id = inst.slot(s.gestureSlot).value.number.flatMap { $0.isFinite ? Int($0) : nil }
        let g = id.flatMap { ZnGestures.findObserved($0) }
        // The parent's size for "%" coordinates (read here: a parent resize reaches the gesture).
        let parent = znParentContentBox(s, inst)
        let p = CGSize(width: parent?.w ?? 0, height: parent?.h ?? 0)
        content
            .environment(\.znGestureDepth, depth + 1)
            .background(ZnGestureProbe(g: g, depth: depth, off: hiddenTab || touchOff, parent: p))
            .onAppear { parent?.wanted = true }
    }
}

private struct ZnGestureProbe: UIViewRepresentable {
    let g: ZnGesture?
    let depth: Int
    let off: Bool
    let parent: CGSize

    func makeUIView(context: Context) -> ZnGestureProbeView { ZnGestureProbeView() }

    func updateUIView(_ v: ZnGestureProbeView, context: Context) {
        v.depth = depth
        v.off = off
        v.parentSize = parent
        v.gesture = g
    }
}

/// The node's place for the hub. Hit-testable inside its bounds, so a node with nothing drawn still takes a touch
/// (Compose's pointerInput covers the whole node); the touch itself goes to the hub's recognizers.
final class ZnGestureProbeView: UIView {
    var gesture: ZnGesture? {
        didSet {
            guard gesture !== oldValue else { return }
            if let old = oldValue { ZnGestureHub.hub(of: self)?.probeLost(self, old) }
            place()
        }
    }
    var depth = 0
    var off = false
    var parentSize: CGSize = .zero {
        didSet { if parentSize != oldValue { place() } }
    }
    /// The view of the screen (Sheet, Modal) controller it is drawn in: its hub's view.
    private(set) weak var host: UIView?

    static let live = NSHashTable<ZnGestureProbeView>.weakObjects()

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isOpaque = false
        isAccessibilityElement = false
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        !off && !isHidden && self.point(inside: point, with: event) ? self : nil
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        place()
    }

    /// Its size (before the node's transforms) and its parent's, for the gesture's "%" coordinates.
    private func place() {
        gesture?.placed(Float(bounds.width), Float(bounds.height), Float(parentSize.width), Float(parentSize.height))
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil {
            Self.live.add(self)
            host = znNearestController(self)?.view
            if let host { ZnGestureHub.install(on: host) }
            if ZnGestureHub.log { print("zn t=\(ZnDebug.ms()) gesture: node of gesture \(gesture?.id ?? -1) on screen (hub on \(host.map { "\(type(of: $0))" } ?? "none"))") }
        } else {
            Self.live.remove(self)
            if let g = gesture { ZnGestureHub.hub(of: self)?.probeLost(self, g) }
            host = nil
        }
    }

    /// Takes touches now (shown, not under pointerEvents "none" or a hidden tab).
    var takes: Bool { window != nil && !off && !isHidden && alpha > 0.01 && gesture != nil }

    /// [t] landed inside it, and inside every clipping view around it up to its host (a scrolled-away row doesn't).
    func contains(_ t: UITouch) -> Bool {
        guard point(inside: t.location(in: self), with: nil) else { return false }
        var v = superview
        while let s = v, s !== host {
            if s.clipsToBounds && !s.point(inside: t.location(in: s), with: nil) { return false }
            v = s.superview
        }
        return true
    }
}

// MARK: - The hub

@MainActor
final class ZnGestureHub: NSObject, UIGestureRecognizerDelegate {
    #if DEBUG
    /// ZN_GESTURE_LOG=1 (a Debug build): one line per session start, claim, end, and the recognizers each touch met.
    static let log = ProcessInfo.processInfo.environment["ZN_GESTURE_LOG"] == "1"
    #else
    static let log = false
    #endif

    private static let hubs = NSMapTable<UIView, ZnGestureHub>(keyOptions: .weakMemory, valueOptions: .strongMemory)

    static func install(on view: UIView) {
        guard hubs.object(forKey: view) == nil else { return }
        let h = ZnGestureHub(view)
        hubs.setObject(h, forKey: view)
    }

    static func hub(of probe: ZnGestureProbeView) -> ZnGestureHub? { probe.host.flatMap { hubs.object(forKey: $0) } }

    /// One node in a touch: its session, its probe and the fingers it has.
    private final class Entry {
        let session: ZnGestureSession
        weak var probe: ZnGestureProbeView?
        let depth: Int
        var touches: [UITouch] = []
        /// Where each finger was in the last event (in the probe, in the window), and whether it was down.
        var last: [ObjectIdentifier: (CGPoint, CGPoint)] = [:]
        /// withParent "after-edge" with the finger on the list inside: the list takes the touch (ZnAfterEdge moves
        /// the pan through its edges).
        var inList = false

        init(_ s: ZnGestureSession, _ p: ZnGestureProbeView) {
            session = s
            probe = p
            depth = p.depth
        }
    }

    private weak var view: UIView?
    private let feed = ZnGestureFeed()
    private let claim = ZnGestureClaim()
    private var entries: [Entry] = []
    private var edges: [ZnAfterEdge] = []
    private var timer: Timer?

    private init(_ view: UIView) {
        self.view = view
        super.init()
        feed.hub = self
        claim.hub = self
        for r in [feed, claim] as [UIGestureRecognizer] {
            r.delegate = self
            r.delaysTouchesBegan = false
            r.delaysTouchesEnded = false
            view.addGestureRecognizer(r)
        }
        feed.cancelsTouchesInView = false
        claim.cancelsTouchesInView = true
    }

    // MARK: Touches (from the feed)

    fileprivate func began(_ touches: Set<UITouch>) {
        if Self.log { print("zn t=\(ZnDebug.ms()) gesture: \(touches.count) finger(s) down, \(ZnGestureProbeView.live.count) node(s) with gestures") }
        for t in touches {
            let hits = ZnGestureProbeView.live.allObjects.filter { p in
                p.host === view && p.window === t.window && p.takes && p.contains(t)
            }
            for p in hits {
                guard let g = p.gesture else { continue }
                let e: Entry
                if let have = entries.first(where: { $0.probe === p && !$0.session.over && $0.session.g === g }) {
                    e = have  // a double tap's next tap: the same session goes on
                } else {
                    let s = ZnGestureSession(g, downAt: ms(t.timestamp))
                    e = Entry(s, p)
                    s.touch.onCancel = { [weak self, weak s] in
                        guard let self, let s else { return }
                        MainActor.assumeIsolated { self.cancel(s) }
                    }
                    s.onEnd = { [weak self] s in MainActor.assumeIsolated { self?.sessionEnded(s) } }
                    entries.append(e)
                    ZnHaptics.prepare()
                    if Self.log { print("zn t=\(ZnDebug.ms()) gesture: \(g.id) touched (depth \(p.depth))") }
                }
                if !e.touches.contains(where: { $0 === t }) { e.touches.append(t) }
                if let pan = g.leaves.first(where: { $0.kind == ZnGesture.pan && $0.withParent == "after-edge" && $0.axis == ZnGesture.axisY }),
                   !edges.contains(where: { $0.pan === pan }), let list = innerList(t, inside: p) {
                    e.inList = true
                    edges.append(ZnAfterEdge(pan: pan, list: list, touch: t))
                }
            }
            #if DEBUG
            if Self.log, !hits.isEmpty {
                let names = (t.gestureRecognizers ?? []).map { "\(type(of: $0))\($0.name.map { "(\($0))" } ?? "")" }
                print("zn t=\(ZnDebug.ms()) gesture: the touch also goes to \(names.joined(separator: ", "))")
            }
            #endif
        }
        deliver(touches, phase: .began)
    }

    fileprivate func moved(_ touches: Set<UITouch>) {
        claim.moved = true
        for a in edges where touches.contains(a.touch) { a.moved() }
        deliver(touches, phase: .moved)
    }

    fileprivate func ended(_ touches: Set<UITouch>, cancelled: Bool) {
        for a in edges where touches.contains(a.touch) { a.release() }
        edges.removeAll { touches.contains($0.touch) }
        if cancelled {
            // The system took the touches (a call, Control Center): their nodes' touches end, cancelled.
            for e in entries where e.touches.contains(where: { touches.contains($0) }) { e.session.end(cancel: true) }
        } else {
            deliver(touches, phase: .ended)
        }
        for e in entries { e.touches.removeAll { touches.contains($0) } }
        afterEvent()
    }

    /// One event per node that has one of [touches].
    private func deliver(_ touches: Set<UITouch>, phase: UITouch.Phase) {
        // Someone else's pan (a scroll, a sheet, the back swipe) took these touches.
        let taken = touches.contains { t in
            (t.gestureRecognizers ?? []).contains { r in
                !(r is ZnGestureFeed) && !(r is ZnGestureClaim) && (r is UIPanGestureRecognizer || r is UIPinchGestureRecognizer)
                    && (r.state == .began || r.state == .changed)
            }
        }
        var consumed = false
        for e in order() where e.touches.contains(where: { touches.contains($0) }) {
            guard let p = e.probe else { continue }
            var changes: [ZnPointerChange] = []
            for t in e.touches {
                let local = t.location(in: p), win = t.location(in: nil)
                let id = ObjectIdentifier(t)
                let was = e.last[id]
                let new = touches.contains(t)
                let isDown = !(new && phase == .ended)
                let wasDown = !(new && phase == .began) || was != nil
                let (pl, pw) = was ?? (local, win)
                changes.append(ZnPointerChange(id: id.hashValue, x: Float(local.x), y: Float(local.y), px: Float(pl.x), py: Float(pl.y),
                                               wx: Float(win.x), wy: Float(win.y), pwx: Float(pw.x), pwy: Float(pw.y),
                                               pressed: isDown, previousPressed: wasDown, t: ms(t.timestamp)))
                e.last[id] = isDown ? (local, win) : nil
            }
            // On the list inside an "after-edge" pan, the list takes the touch (it sees it first, as on Android).
            var ev = ZnPointerEvent(changes: changes, consumed: consumed || taken || e.inList)
            e.session.handle(&ev)
            if ev.consumed && !e.inList { consumed = true }
        }
        afterEvent()
    }

    /// Compose's order: "block" nodes outermost first (the Initial pass), then the others innermost first.
    private func order() -> [Entry] {
        entries.sorted { a, b in
            if a.session.blocks != b.session.blocks { return a.session.blocks }
            return a.session.blocks ? a.depth < b.depth : a.depth > b.depth
        }
    }

    /// A gesture's touch was cancelled (snapTo, a JS command with interruptGesture, the gesture disposed).
    private func cancel(_ s: ZnGestureSession) {
        s.end()
        afterEvent()
    }

    /// The node went away (or got another gesture) in a touch: its session ends, cancelled.
    func probeLost(_ p: ZnGestureProbeView, _ g: ZnGesture) {
        for e in entries where e.probe === p || e.probe == nil { e.session.end(cancel: true) }
        afterEvent()
    }

    private func sessionEnded(_ s: ZnGestureSession) {
        if let i = entries.firstIndex(where: { $0.session === s }) {
            entries.remove(at: i)
            if Self.log { print("zn t=\(ZnDebug.ms()) gesture: \(s.g.id) touch over\(s.cancelled ? ", cancelled" : "")") }
        }
    }

    /// After every event, deadline and cancel: the claim's state, the timer, and the feed's end.
    private func afterEvent() {
        entries.removeAll { $0.session.over }
        let down = entries.contains { !$0.touches.isEmpty }
        let claiming = entries.contains { $0.session.claims }
        switch claim.state {
        case .possible:
            if claiming {
                claim.state = .began
                if Self.log { print("zn t=\(ZnDebug.ms()) gesture: takes the touch") }
            } else if entries.isEmpty || ((claim.moved || !down) && !entries.contains(where: { $0.session.mayClaim(fingers: $0.touches.count) })) {
                // No consuming recognizer can start any more: the scroll around it may go now.
                claim.state = .failed
            }
        case .began, .changed:
            claim.state = claiming || entries.contains(where: { $0.session.mayClaim(fingers: $0.touches.count) && !$0.touches.isEmpty }) ? .changed : .ended
        default:
            break
        }
        // Nothing to feed (no node under the fingers, none waiting for a next tap): the feed sits out this sequence.
        if entries.isEmpty && edges.isEmpty && feed.state == .possible { feed.state = .failed }
        schedule()
    }

    private func ms(_ timestamp: TimeInterval) -> Int64 { Int64(timestamp * 1000) }

    // MARK: Deadlines

    private func schedule() {
        timer?.invalidate()
        timer = nil
        let now = ZnGestures.now()
        guard let next = entries.compactMap({ $0.session.wakeAt(now) }).min() else { return }
        let t = Timer(fire: Date(timeIntervalSinceNow: Double(max(0, next - now)) / 1000), interval: 0, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.wake() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func wake() {
        let now = ZnGestures.now()
        for e in entries { if let w = e.session.wakeAt(now), w <= now { e.session.tick(now) } }
        afterEvent()
    }

    // MARK: Scrolls around and inside

    /// The scroll view under [t] inside the node [p] (a panel's list), or nil.
    private func innerList(_ t: UITouch, inside p: ZnGestureProbeView) -> UIScrollView? {
        let box = p.convert(p.bounds, to: nil)
        var v = t.view
        while let s = v, s !== view {
            if let sv = s as? UIScrollView, sv.isScrollEnabled, box.contains(sv.convert(CGPoint(x: sv.bounds.midX, y: sv.bounds.midY), to: nil)),
               sv.contentSize.height >= sv.contentSize.width || sv.alwaysBounceVertical {
                return sv
            }
            v = s.superview
        }
        return nil
    }

    /// The claim waits for nothing; [other] waits for the claim when it is a pan of a scroll or sheet around a node
    /// whose consuming recognizer may still start (not the back swipe: claimsBackEdge decides that one).
    fileprivate func otherWaits(_ other: UIGestureRecognizer) -> Bool {
        guard other is UIPanGestureRecognizer || other is UIPinchGestureRecognizer, !(other is ZnGestureFeed),
              other.name != ZnNavController.backPanName, let ov = other.view else { return false }
        if !entries.isEmpty {
            return entries.contains { e in
                e.session.mayClaim(fingers: max(1, e.touches.count)) && (e.probe?.isDescendant(of: ov) ?? false)
            }
        }
        // Asked before the feed saw the touch: the probes under it.
        let at = other.location(in: nil)
        return ZnGestureProbeView.live.allObjects.contains { p in
            p.host === view && p.takes && p.isDescendant(of: ov) && p.point(inside: p.convert(at, from: nil), with: nil)
                && (p.gesture?.leaves.contains { $0.withParent != "simultaneous" && ZnGestureHub.consuming($0.kind) } ?? false)
        }
    }

    fileprivate static func consuming(_ kind: Int) -> Bool { kind != ZnGesture.tap && kind != ZnGesture.fling }

    // MARK: The back swipe

    /// A horizontal pan of the screen [top] lies under [point] (window): the back swipe leaves it the touch, as
    /// Android's systemGestureExclusion (the whole node when it is at most 200 pt tall, else a 200 pt band at its
    /// centre).
    static func claimsBackEdge(at point: CGPoint, in top: UIView?) -> Bool {
        guard let top else { return false }
        return ZnGestureProbeView.live.allObjects.contains { p in
            guard p.takes, let host = p.host, host === top || host.isDescendant(of: top),
                  p.gesture?.leaves.contains(where: { $0.kind == ZnGesture.pan && $0.axis != ZnGesture.axisY }) == true else { return false }
            let local = p.convert(point, from: nil)
            guard p.point(inside: local, with: nil) else { return false }
            let h = p.bounds.height
            return h <= 200 || abs(local.y - h / 2) <= 100
        }
    }

    // MARK: UIGestureRecognizerDelegate

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        if g === feed || other is ZnGestureFeed { return true }
        // The claim stops the scrolls, sheets and pans around it; the rest (SwiftUI's own, taps) go on with it.
        if other is UIPanGestureRecognizer || other is UIPinchGestureRecognizer { return false }
        return true
    }
}

/// Sees every touch of its screen and hands it to the hub; never stops or waits for anyone.
private final class ZnGestureFeed: UIGestureRecognizer {
    weak var hub: ZnGestureHub?
    /// Fingers down in this touch sequence.
    private(set) var touchesDown = 0

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        touchesDown += touches.count
        MainActor.assumeIsolated { hub?.began(touches) }
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        MainActor.assumeIsolated { hub?.moved(touches) }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        touchesDown = max(0, touchesDown - touches.count)
        MainActor.assumeIsolated { hub?.ended(touches, cancelled: false) }
        if touchesDown == 0 && state == .possible { state = .failed }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        touchesDown = max(0, touchesDown - touches.count)
        MainActor.assumeIsolated { hub?.ended(touches, cancelled: true) }
        if touchesDown == 0 && state == .possible { state = .failed }
    }

    override func reset() {
        super.reset()
        touchesDown = 0
    }
}

/// The touch in UIKit's terms: the hub sets its state (ZnGestureHub.afterEvent).
private final class ZnGestureClaim: UIGestureRecognizer {
    weak var hub: ZnGestureHub?
    /// A finger moved in this sequence (before that, nothing that waits for the claim could start anyway).
    var moved = false

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible && event.allTouches?.allSatisfy({ $0.phase == .ended || $0.phase == .cancelled }) != false {
            state = .failed
        }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .possible { state = .failed } else if state == .began || state == .changed { state = .cancelled }
    }

    override func shouldBeRequiredToFail(by other: UIGestureRecognizer) -> Bool {
        MainActor.assumeIsolated { hub?.otherWaits(other) ?? false }
    }

    override func reset() {
        super.reset()
        moved = false
    }
}

/// withParent "after-edge" (Android: ZnNestedPan): a vertical pan with a list inside, the finger on the list. The
/// list scrolls; finger up while the pan is below its top bound, or pulling down with the list at its top, moves the
/// pan instead, and the list's own drag ends there (off and on cancels it, as ZnSheet's), so it stays still and
/// doesn't fling. (Pinning its offset on each change loops: ZnSheet.swift, 2026-11-12.)
@MainActor
private final class ZnAfterEdge {
    let pan: ZnGesture
    let touch: UITouch
    private weak var list: UIScrollView?
    private var lastY: CGFloat
    private var moving = false
    private var vt = ZnVelocityTracker()

    init(pan: ZnGesture, list: UIScrollView, touch: UITouch) {
        self.pan = pan
        self.list = list
        self.touch = touch
        lastY = touch.location(in: nil).y
    }

    func moved() {
        let y = touch.location(in: nil).y
        let dy = Float(y - lastY)
        lastY = y
        guard let v = pan.y, dy != 0 else { return }
        let lo = pan.lo(false) ?? -.greatestFiniteMagnitude, hi = pan.hi(false) ?? .greatestFiniteMagnitude
        if !moving {
            guard let s = list else { return }
            let top = -s.adjustedContentInset.top
            let atTop = s.contentOffset.y <= top + 0.5
            // Content going up while the pan isn't at its top; or the list at its top and the finger pulling down.
            guard (dy < 0 && v.value > lo) || (dy > 0 && atTop) else { return }
            moving = true
            v.interrupt()
            pan.detach()
            s.panGestureRecognizer.isEnabled = false
            s.panGestureRecognizer.isEnabled = true
            if atTop { s.contentOffset.y = top }
        }
        v.value = min(max(v.value + dy, lo), hi)
        vt.add(Int64(touch.timestamp * 1000), 0, v.value)
    }

    /// The finger lifted: where the pan goes (Android's onPreFling: chooseTarget + settle).
    func release() {
        guard moving else { return }
        moving = false
        vt.add(Int64(touch.timestamp * 1000), 0, pan.y?.value ?? 0)  // the lift: held still first, no speed
        let vy = vt.velocity().y
        let y = pan.y?.value ?? 0
        let t = pan.chooseTarget(0, y, 0, vy, 0, y)
        var end: [String: Any] = ["y": Double(y), "vy": Double(vy), "cancelled": false]
        if let t { end["anchor"] = t.id }
        pan.send("end", end)
        pan.settle(t, 0, vy)
    }
}
