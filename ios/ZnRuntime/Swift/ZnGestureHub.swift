// Touches for the gestures (Android: Modifier.znGesture's pointerInput in ZnGesture.kt). A node with `gesture={g}`
// gets a probe: a clear UIView behind its content and inside its layer, so it moves, scales and turns with the node.
// The probe gives the gesture its size (and its parent's, for "%" coordinates) and tells where the node is; it takes
// no touches itself. Each screen (and each Sheet or Modal, which have their own controller) has one hub on its
// controller's view: two UIGestureRecognizers that every touch in that screen passes.
//
// - The feed sees every touch and never stops anyone (simultaneous with all, never prevented). A finger landing on
//   probes starts one touch session per node (ZnGestureRecognizers.swift), ordered as Compose's passes: withParent
//   "block" outermost first, then the rest innermost first. Each UIKit callback becomes one ZnPointerEvent per session.
//   As Compose's hit test, only the frontmost node under the finger and the nodes around it get the touch: not a
//   sibling it covers, and not one a Pressable in front of it covers (frontmost).
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
// - withParent "after-edge" on a vertical pan with a list inside (a panel): the list scrolls; once the list's drag has
//   started, finger up while the pan is below its top bound, or pulling down with the list at its top, moves the pan
//   first and the rest scrolls the list, in the same drag (Android: ZnNestedPan). "simultaneous": the pan never takes
//   the touch from the scroll it is in.
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
            .background(ZnGestureProbe(g: g, depth: depth, off: hiddenTab || touchOff, parent: p, mark: mark))
            .overlay(ZnGestureEnd(mark: mark).allowsHitTesting(false))
            .onAppear { parent?.wanted = true }
    }

    @State private var mark = ZnGestureMark()
}

/// Where a gesture node's drawing ends: a view over its content that takes no touches. A Pressable drawn between the
/// node's probe and it is inside the node; one drawn after it covers the node (ZnGestureHub.frontmost).
final class ZnGestureMark {
    weak var end: UIView?
}

private struct ZnGestureEnd: UIViewRepresentable {
    let mark: ZnGestureMark

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .clear
        v.isOpaque = false
        v.isUserInteractionEnabled = false
        v.isAccessibilityElement = false
        mark.end = v
        return v
    }

    func updateUIView(_ v: UIView, context: Context) { mark.end = v }
}

private struct ZnGestureProbe: UIViewRepresentable {
    let g: ZnGesture?
    let depth: Int
    let off: Bool
    let parent: CGSize
    let mark: ZnGestureMark

    func makeUIView(context: Context) -> ZnGestureProbeView { ZnGestureProbeView() }

    func updateUIView(_ v: ZnGestureProbeView, context: Context) {
        v.mark = mark
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
    /// The node's end mark (its drawing ends there).
    var mark: ZnGestureMark?
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
        // Without its gesture (not arrived yet, or the Motion engine off) it is no hit target: a tap goes through to
        // what is under it, as for any node without handlers.
        takes && self.point(inside: point, with: event) ? self : nil
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
    func contains(_ t: UITouch) -> Bool { znShows(self, bounds, at: t.location(in: nil), upTo: host) }
}

/// [rect] of [v] holds window point [w], and so does every clipping view around [v] up to [top] (a row scrolled under
/// its list's edge doesn't).
@MainActor func znShows(_ v: UIView, _ rect: CGRect, at w: CGPoint, upTo top: UIView?) -> Bool {
    guard rect.contains(v.convert(w, from: nil)) else { return false }
    var u = v.superview
    while let s = u, s !== top {
        if s.clipsToBounds && !s.bounds.contains(s.convert(w, from: nil)) { return false }
        u = s.superview
    }
    return true
}

/// Is [a] drawn in front of [b] (one window)? Under their nearest common superview, the later subview (or the higher
/// zPosition) is in front; a view is in front of its superviews.
@MainActor func znInFront(_ a: UIView, _ b: UIView) -> Bool {
    var onA: [ObjectIdentifier: UIView] = [:]  // each superview of a, and its subview on a's way up
    var c = a
    while let s = c.superview {
        onA[ObjectIdentifier(s)] = c
        c = s
    }
    if onA[ObjectIdentifier(b)] != nil { return true }  // a is inside b
    var d = b
    while let s = d.superview {
        if s === a { return false }  // b is inside a
        if let ca = onA[ObjectIdentifier(s)] {
            if ca.layer.zPosition != d.layer.zPosition { return ca.layer.zPosition > d.layer.zPosition }
            let subs = s.subviews
            return (subs.firstIndex { $0 === ca } ?? 0) > (subs.firstIndex { $0 === d } ?? 0)
        }
        d = s
    }
    return false
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

    /// The hub lives with its view (an associated object): a popped screen's hub goes with the screen. (A weak-key
    /// NSMapTable keeps its values until it next resizes.)
    private static var key: UInt8 = 0

    static func install(on view: UIView) {
        guard of(view) == nil else { return }
        objc_setAssociatedObject(view, &key, ZnGestureHub(view), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
    }

    private static func of(_ view: UIView) -> ZnGestureHub? { objc_getAssociatedObject(view, &key) as? ZnGestureHub }

    static func hub(of probe: ZnGestureProbeView) -> ZnGestureHub? { probe.host.flatMap { of($0) } }

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
    private var timerAt: Int64?

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
        edges.removeAll { a in
            if a.over || a.touch.phase == .ended || a.touch.phase == .cancelled { a.drop(); return true }
            return false
        }
        for t in touches {
            let under = ZnGestureProbeView.live.allObjects.filter { p in
                p.host === view && p.window === t.window && p.takes && p.contains(t)
            }
            let hits = frontmost(under, at: t.location(in: nil))
            if Self.log, hits.count < under.count {
                print("zn t=\(ZnDebug.ms()) gesture: covered, no touch for \(under.filter { p in !hits.contains { $0 === p } }.map { $0.gesture?.id ?? -1 })")
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
                    if Self.log { print("zn t=\(ZnDebug.ms()) gesture: \(g.id) after-edge, the list \(type(of: list)) scrolls first") }
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
        deliver(touches, phase: .moved)
    }

    fileprivate func ended(_ touches: Set<UITouch>, cancelled: Bool) {
        // An after-edge whose list is dragging ends with that drag (its release comes from the list's pan).
        edges.removeAll { a in
            let gone = a.over || (touches.contains(a.touch) && !a.dragging)
            if gone { a.drop() }
            return gone
        }
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
            // On the list inside an "after-edge" pan, the list takes the touch (it sees it first, as on Android). A
            // "simultaneous" pan goes on with the scroll that took it.
            var ev = ZnPointerEvent(changes: changes, consumed: consumed || (taken && !e.session.shareTouch) || e.inList)
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
        edges.removeAll { $0.over }
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
        let now = ZnGestures.now()
        let next = entries.compactMap { $0.session.wakeAt(now) }.min()
        if let next, next == timerAt, timer?.isValid == true { return }  // the same deadline: the timer stands
        timer?.invalidate()
        timer = nil
        timerAt = next
        guard let next else { return }
        let t = Timer(fire: Date(timeIntervalSinceNow: Double(max(0, next - now)) / 1000), interval: 0, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.wake() }
        }
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func wake() {
        timerAt = nil
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

    /// Compose's hit test: the touch goes to the frontmost node under the finger and to the nodes around it, not to a
    /// sibling it covers. Of [under], the frontmost, and at each depth outside it the frontmost one there (the node
    /// around it); then none that a Pressable covers (one drawn in front of the node and not inside it: after its end
    /// mark). A Pressable inside the node, or the node itself being one, doesn't stop it.
    private func frontmost(_ under: [ZnGestureProbeView], at w: CGPoint) -> [ZnGestureProbeView] {
        guard let top = under.max(by: { znInFront($1, $0) }) else { return [] }
        var keep = [top]
        for d in Set(under.map(\.depth)) where d < top.depth {
            if let f = under.filter({ $0.depth == d }).max(by: { znInFront($1, $0) }) { keep.append(f) }
        }
        let covers = ZnTouchControl.live.allObjects.filter { c in
            !c.isHidden && c.window === top.window && znShows(c, c.core, at: w, upTo: view) && znNearestController(c)?.view === view
        }
        if covers.isEmpty { return keep }
        return keep.filter { p in
            !covers.contains { c in
                guard znInFront(c, p) else { return false }
                guard let end = p.mark?.end, end.window === p.window else { return false }  // no mark yet: don't guess
                if znInFront(end, c) { return false }  // inside the node
                // The node is the Pressable (its touch area lies over the whole node, outside the layer).
                let a = c.convert(c.core, to: nil), b = p.convert(p.bounds, to: nil)
                return abs(a.minX - b.minX) > 1 || abs(a.minY - b.minY) > 1 || abs(a.maxX - b.maxX) > 1 || abs(a.maxY - b.maxY) > 1
            }
        }
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
        let under = ZnGestureProbeView.live.allObjects.filter { p in
            p.host === view && p.takes && znShows(p, p.bounds, at: at, upTo: view)
        }
        return frontmost(under, at: at).contains { p in
            p.isDescendant(of: ov) && (p.gesture?.leaves.contains { $0.withParent != "simultaneous" && ZnGestureHub.consuming($0.kind) } ?? false)
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
            // Where it shows (not where a clipping scroll hides it), as Android's exclusion rects.
            guard znShows(p, p.bounds, at: point, upTo: host) else { return false }
            let local = p.convert(point, from: nil)
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

/// withParent "after-edge" (Android: ZnNestedPan): a vertical pan with a list inside, the finger on the list. Nothing
/// happens until the list's own drag starts (its slop and axis). Then each move of the finger is shared as Compose's
/// nested scroll: finger up while the pan is below its top bound, the pan moves first and the rest scrolls the list;
/// finger down, the list scrolls back first and the rest moves the pan. It runs as a target of the list's pan, after
/// the list's own handler, and sets the list's offset to its share (FloatingPanel does the same). Once the pan moved
/// in a drag, the release is the pan's: the list doesn't fling.
@MainActor
private final class ZnAfterEdge: NSObject {
    let pan: ZnGesture
    let touch: UITouch
    private weak var list: UIScrollView?
    /// The finger's y (window) and the list's offset after the last share.
    private var lastY: CGFloat = 0
    private var offset: CGFloat = 0
    private var moving = false
    private var vt = ZnVelocityTracker()
    /// The list's drag started in this touch (its release comes from there).
    private(set) var dragging = false
    private(set) var over = false

    init(pan: ZnGesture, list: UIScrollView, touch: UITouch) {
        self.pan = pan
        self.list = list
        self.touch = touch
        super.init()
        list.panGestureRecognizer.addTarget(self, action: #selector(listPanned(_:)))
    }

    @objc private func listPanned(_ r: UIPanGestureRecognizer) {
        guard !over, let s = list else { return done() }
        let y = touch.location(in: nil).y
        let t = Int64(touch.timestamp * 1000)
        switch r.state {
        case .began:
            dragging = true
            lastY = y
            offset = s.contentOffset.y
            vt.add(t, 0, Float(y))
        case .changed:
            let dy = y - lastY  // the finger's way: < 0 up
            lastY = y
            vt.add(t, 0, Float(y))
            share(dy, s)
        default:  // ended, cancelled, failed
            if moving { release(s) }
            done()
        }
    }

    /// Splits the finger's move [dy] between the pan and the list.
    private func share(_ dy: CGFloat, _ s: UIScrollView) {
        guard let v = pan.y, dy != 0 else {
            offset = s.contentOffset.y
            return
        }
        let lo = CGFloat(pan.lo(false) ?? -.greatestFiniteMagnitude), hi = CGFloat(pan.hi(false) ?? .greatestFiniteMagnitude)
        let cur = CGFloat(v.value)
        let top = -s.adjustedContentInset.top
        var listDy = dy, panDy: CGFloat = 0
        if dy < 0 {
            // Content going up: the pan first (Android's onPreScroll), until its top bound.
            if cur > lo { panDy = max(cur + dy, lo) - cur }
            listDy = dy - panDy
        } else {
            // Content going down: the list first, back to its top; the rest moves the pan (onPostScroll).
            listDy = min(dy, max(0, offset - top))
            panDy = min(cur + dy - listDy, hi) - cur
            if panDy < 0 { panDy = 0 }
        }
        guard panDy != 0 else {
            offset = s.contentOffset.y  // the list's own move (with its edge bounce)
            return
        }
        if !moving {
            moving = true
            v.interrupt()
            pan.detach()
        }
        v.value = Float(cur + panDy)
        let end = max(top, s.contentSize.height - s.bounds.height + s.adjustedContentInset.bottom)
        offset = min(max(offset - listDy, top), end)
        s.contentOffset.y = offset
    }

    /// The finger lifted after the pan moved: where the pan goes (Android's onPreFling: chooseTarget + settle, with
    /// the finger's speed; the list's fling is used up).
    private func release(_ s: UIScrollView) {
        moving = false
        vt.add(Int64(touch.timestamp * 1000), 0, Float(touch.location(in: nil).y))  // the lift: held still first, no speed
        s.setContentOffset(s.contentOffset, animated: false)  // stops the list's deceleration
        let vy = vt.velocity().y
        let y = pan.y?.value ?? 0
        let t = pan.chooseTarget(0, y, 0, vy, 0, y)
        var end: [String: Any] = ["y": Double(y), "vy": Double(vy), "cancelled": false]
        if let t { end["anchor"] = t.id }
        pan.send("end", end)
        pan.settle(t, 0, vy)
    }

    private func done() {
        guard !over else { return }
        over = true
        list?.panGestureRecognizer.removeTarget(self, action: #selector(listPanned(_:)))
    }

    /// The hub dropped it before the list's drag started (a tap, a swipe a row took).
    func drop() { done() }
}
