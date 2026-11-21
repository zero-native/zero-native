// <Scroll> (ZnRenderer.kt's SCROLL): a SwiftUI ScrollView around the node's Column / Row. Its own file, so the scroll
// work (commands, events, snapping, keyboard dismiss) changes this file and not the renderer.
//
// RN's scroll extras (registry 24, android/runtime ZnScrollExtras.kt) hang off ZnScrollDriver: a probe inside the
// content finds SwiftUI's UIScrollView and the driver watches it (contentOffset / contentSize KVO, a target on its pan
// recognizer). From there it sends onScroll (throttled), onScrollBeginDrag / EndDrag and onMomentumScrollBegin / End,
// runs <Scroll ref> commands, sets decelerationRate and holds pull to refresh. Snapping is SwiftUI's
// scrollTargetBehavior with Android's rules (ZnSnapBehavior). The plain rules are in ZnScrollSnap.swift.
// A Scroll with none of these has no probe and no driver work.
import SwiftUI
import UIKit

/// The padding scrolls with the content (Android: the scroll's content padding), so nothing is clipped at the edges
/// and the last item can scroll clear of a floating button.
/// A vertical Scroll with no height that doesn't fill (no flex, no stretch) is as tall as its content, up to what it is
/// offered (its maxHeight, the space left): Compose's verticalScroll Column. A SwiftUI ScrollView takes all it is
/// offered, so ZeroBill's checkout offers sheet (`maxHeight: 400`, one or two rows) was 400 tall with an empty band
/// (2026-11-09).
struct ZnScrollView<Content: View>: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let outer: ZnOuter
    /// The scroll's padding now. Read by the node's body (ZnNodeView) as before this view had its own file, so a
    /// change of its slots runs the same bodies. `refreshing` and the extras' slots are read by the probe alone.
    let padding: EdgeInsets
    /// The node's Column (vertical) or Row (horizontal), built by ZnNodeView.
    let content: Content
    @State private var driver = ZnScrollDriver()

    init(ctx: ZnContext, s: ZnNodeSpec, inst: ZnInstance, outer: ZnOuter, padding: EdgeInsets,
         @ViewBuilder content: () -> Content) {
        self.ctx = ctx
        self.s = s
        self.inst = inst
        self.outer = outer
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        let hug = !s.horizontal && !s.hasHeight && !outer.fillHeight
        // All static per template, so the ScrollView's identity never changes (a new one would be a new UIScrollView).
        let keyboard = ZnKeyboardDismiss.of(s.keyboardDismissMode, vertical: !s.horizontal)
        ZnScrollHugLayout(hug: hug) {
            ScrollView(s.horizontal ? .horizontal : .vertical) {
                content
                    .padding(padding)
                    .background {
                        if s.usesScrollProbe { ZnScrollProbe(ctx: ctx, s: s, inst: inst, driver: driver) }
                    }
                    // keyboardDismissMode is this scroll's own: scrolls inside it keep SwiftUI's default.
                    .scrollDismissesKeyboard(.automatic)
            }
            .scrollDismissesKeyboard(keyboard == .onDrag ? .immediately : keyboard == .interactive ? .interactively : .automatic)
            .modifier(ZnSnapModifier(on: s.hasSnap, driver: driver))
        }
    }
}

extension ZnNodeSpec {
    /// Snap rules (static or from their slot; the compiler always gives them a slot).
    var hasSnap: Bool { snapSlot >= 0 || snap != nil }

    /// A Scroll that needs its UIScrollView: pull to refresh, snapping, scroll events or a ref.
    var usesScrollProbe: Bool {
        (hasRefresh && !horizontal) || hasSnap || (scrollEvents != nil && onScrollEvent != 0) || scrollCommandSlot >= 0
    }
}

/// Snapping with Android's rules: SwiftUI asks where a released drag should stop (with UIKit's projection at the
/// current decelerationRate) and the driver answers with ZnSnap.pick. Only on a Scroll with snap rules.
private struct ZnSnapModifier: ViewModifier {
    let on: Bool
    let driver: ZnScrollDriver

    func body(content: Content) -> some View {
        if on { content.scrollTargetBehavior(ZnSnapBehavior(driver: driver)) } else { content }
    }
}

struct ZnSnapBehavior: ScrollTargetBehavior {
    let driver: ZnScrollDriver

    func updateTarget(_ target: inout ScrollTarget, context: TargetContext) {
        let driver = driver
        var origin = target.rect.origin
        MainActor.assumeIsolated { driver.snapTarget(&origin) }
        target.rect.origin = origin
    }
}

/// Reads the slots the extras follow (so a patch redraws only this probe, the leaf-update rule in ZnRenderer.swift)
/// and hands them to the driver.
private struct ZnScrollProbe: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let driver: ZnScrollDriver

    var body: some View {
        let refreshing = s.hasRefresh && !s.horizontal && s.refreshingNow(inst)
        let snap = s.snapSlot >= 0 ? inst.slot(s.snapSlot).value.string : s.snap
        let command = s.scrollCommandSlot >= 0 ? inst.slot(s.scrollCommandSlot).value.string : nil
        ZnScrollProbeView(ctx: ctx, s: s, inst: inst, driver: driver, refreshing: refreshing, snap: snap, command: command)
    }
}

/// Finds the scroll view around it (SwiftUI's) once it is in the window, and keeps the driver on it.
private struct ZnScrollProbeView: UIViewRepresentable {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let driver: ZnScrollDriver
    let refreshing: Bool
    let snap: String?
    let command: String?

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        return v
    }

    func updateUIView(_ v: UIView, context: Context) {
        let (ctx, s, inst, driver) = (ctx, s, inst, driver)
        driver.configure(ctx: ctx, s: s, inst: inst)
        let (refreshing, snap, command) = (refreshing, snap, command)
        // The scroll view is an ancestor once this view is in the window.
        DispatchQueue.main.async {
            var p = v.superview
            while let sv = p, !(sv is UIScrollView) { p = sv.superview }
            if let sv = p as? UIScrollView { driver.attach(sv) }
            driver.update(refreshing: refreshing, snap: snap, command: command)
        }
    }
}

/// One <Scroll>'s UIKit side: events, commands, deceleration, snapping and pull to refresh (see the file header).
/// Offsets are along the scroll's axis, from the content's start (Android's ZnScrollPos): ZnScrollMetrics.
@MainActor
final class ZnScrollDriver: NSObject {
    private(set) weak var sv: UIScrollView?
    private var watches: [NSKeyValueObservation] = []
    private var horizontal = false
    private var wants: ZnScrollWants?
    private var emit: ((String) -> Void)?
    private var snap: ZnSnap?
    private var hasSnap = false
    private var refresh: ZnRefresh?
    private var spec: (ctx: ZnContext, s: ZnNodeSpec, inst: ZnInstance)?

    // onScroll: the last offset seen, when the last event went, and the one trailing send of a throttle.
    private var lastOffset: Double?
    private var lastSentMs: Double = 0
    private var trailing: DispatchWorkItem?

    // Momentum: watched frame by frame from a drag's release until the scroll rests.
    private var link: CADisplayLink?
    private var released: (metrics: ZnScrollMetrics, velocity: Double)?
    private var lastTick: Double = 0
    private var stillFrames = 0
    private var frames = 0
    private var inMomentum = false

    // A <Scroll ref> command waiting for the first layout (sent with the MOUNT).
    private var pending: ZnScrollCommand?

    /// The node this driver serves (each update: the spec is the same for a template; the context and instance too).
    func configure(ctx: ZnContext, s: ZnNodeSpec, inst: ZnInstance) {
        guard spec?.inst !== inst || spec?.s.index != s.index || spec?.ctx !== ctx else { return }
        spec = (ctx, s, inst)
        horizontal = s.horizontal
        hasSnap = s.hasSnap
        wants = s.onScrollEvent != 0 ? ZnScrollWants.parse(s.scrollEvents).flatMap { $0.any ? $0 : nil } : nil
        emit = s.onScrollEvent != 0 ? { [weak inst] json in
            guard let inst else { return }
            ctx.send(inst.id, s.onScrollEvent, .string(json))
        } : nil
        if s.hasRefresh && !s.horizontal {
            let r = refresh ?? ZnRefresh(asSubview: true)
            r.onRefresh = s.onRefresh != 0 ? { [weak inst] in if let inst { ctx.send(inst.id, s.onRefresh, .none) } } : nil
            refresh = r
        }
    }

    /// Watches [sv] (again when SwiftUI made a new scroll view). Idempotent.
    func attach(_ sv: UIScrollView) {
        guard sv !== self.sv else { return }
        detach()
        self.sv = sv
        #if DEBUG
        if ZnDebug.enabled { print("zn t=\(ZnDebug.ms()) scroll: attach \(ObjectIdentifier(sv)) inst \(spec?.inst.id ?? 0)") }
        #endif
        watches = [
            sv.observe(\.contentOffset, options: []) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.scrolled() }
            },
            sv.observe(\.contentSize, options: []) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.sized() }
            },
        ]
        sv.panGestureRecognizer.addTarget(self, action: #selector(pan(_:)))
        lastOffset = metrics()?.offset
        refresh?.attach(to: sv)
    }

    private func detach() {
        watches.forEach { $0.invalidate() }
        watches = []
        sv?.panGestureRecognizer.removeTarget(self, action: #selector(pan(_:)))
        stopMomentum(send: false)
        trailing?.cancel()
        trailing = nil
        sv = nil
    }

    /// The probe's slots: refreshing, the snap rules and the newest scroll command.
    func update(refreshing: Bool, snap text: String?, command: String?) {
        if let r = refresh, let s = spec?.s {
            r.update(refreshing: refreshing, tint: UIColor(s.refreshColor), canPull: s.onRefresh != 0,
                     background: s.refreshBackground.map(UIColor.init))
        }
        if hasSnap {
            snap = ZnSnap.parse(text)
            // RN's decelerationRate, already on UIKit's scale (core scrollSnap); only on a Scroll with snap props, so
            // others keep whatever UIKit and SwiftUI set.
            let rate = ZnSnap.decelerationRate(snap)
            if let sv, abs(sv.decelerationRate.rawValue - rate) > 0.00001 {
                sv.decelerationRate = UIScrollView.DecelerationRate(rawValue: rate)
            }
        }
        if let command, let slot = spec?.s.scrollCommandSlot, slot >= 0, let inst = spec?.inst,
           let cmd = ZnScrollCommand(command), cmd.isNew(after: inst.scrollSeqs[slot] ?? 0) {
            // On the instance, so a Scroll that comes back on screen doesn't run its last command again (Android).
            inst.scrollSeqs[slot] = cmd.seq
            run(cmd)
        }
    }

    // MARK: Where it is

    /// The top inset when not refreshing: UIKit adds the refresh control's height to it while refreshing, which
    /// Android's content doesn't have (its spinner sits over the content).
    private var restTop: CGFloat = 0

    /// Its offset, end, viewport and other side along the axis; nil before it is attached.
    func metrics() -> ZnScrollMetrics? {
        guard let sv else { return nil }
        var i = sv.adjustedContentInset
        if refresh?.control.isRefreshing == true { i.top = restTop } else { restTop = i.top }
        if horizontal {
            return .along(offset: sv.contentOffset.x, inset: i.left, insetEnd: i.right, content: sv.contentSize.width,
                          viewport: sv.bounds.width, cross: sv.bounds.height)
        }
        return .along(offset: sv.contentOffset.y, inset: i.top, insetEnd: i.bottom, content: sv.contentSize.height,
                      viewport: sv.bounds.height, cross: sv.bounds.width)
    }

    /// The finger's speed along the axis in pt/s, + toward the content's end (Android's fling velocity).
    private func fingerVelocity(_ sv: UIScrollView) -> Double {
        let v = sv.panGestureRecognizer.velocity(in: sv.superview ?? sv)
        return -(horizontal ? v.x : v.y)
    }

    // MARK: Commands

    private func run(_ cmd: ZnScrollCommand) {
        guard let sv, let m = metrics(), (horizontal ? sv.contentSize.width : sv.contentSize.height) > 0 else {
            pending = cmd  // before the first layout: run once the content has a size
            return
        }
        pending = nil
        guard let target = cmd.scrollTarget(horizontal: horizontal, max: m.max) else { return }
        stopMomentum(send: true)
        let i = sv.adjustedContentInset
        var p = sv.contentOffset
        if horizontal { p.x = target - i.left } else { p.y = target - i.top }
        sv.setContentOffset(p, animated: cmd.animated)
    }

    private func sized() {
        if let p = pending { run(p) }
    }

    // MARK: Events

    private func send(_ k: String, _ m: ZnScrollMetrics? = nil, velocity: Double = 0) {
        guard let emit, let m = m ?? metrics() else { return }
        emit(m.json(k, horizontal: horizontal, velocity: velocity))
    }

    private func nowMs() -> Double { CACurrentMediaTime() * 1000 }

    /// contentOffset changed: onScroll at most once per frame (UIKit moves it once a frame) or per throttle, the last
    /// position always sent (Android's ZnScrollEvents). A bounce reads as the edge, so it sends nothing.
    private func scrolled() {
        guard let w = wants, w.scroll, let m = metrics() else { return }
        guard m.offset != lastOffset else { return }
        lastOffset = m.offset
        let wait = w.wait(nowMs: nowMs(), lastSentMs: lastSentMs)
        if wait <= 0 {
            trailing?.cancel()
            trailing = nil
            sendScroll()
        } else if trailing == nil {
            let item = DispatchWorkItem { [weak self] in
                self?.trailing = nil
                self?.sendScroll()
            }
            trailing = item
            DispatchQueue.main.asyncAfter(deadline: .now() + wait / 1000, execute: item)
        }
    }

    private func sendScroll() {
        lastSentMs = nowMs()
        send("s")
    }

    /// The finger: begin / end drag, then the momentum watch.
    @objc private func pan(_ g: UIPanGestureRecognizer) {
        guard let sv else { return }
        switch g.state {
        case .began:
            // A new drag stops the coast: its momentum ends first, as Android's fling ends when a drag starts.
            stopMomentum(send: true)
            if wants?.beginDrag == true { send("b") }
        case .ended, .cancelled, .failed:
            if wants?.endDrag == true { send("e") }
            guard let m = metrics() else { return }
            let velocity = g.state == .ended ? fingerVelocity(sv) : 0
            released = (m, velocity)
            // UIKit's own pan handler ran first, so a coast has started (or not) by the next turn of the run loop.
            DispatchQueue.main.async { [weak self] in self?.afterRelease() }
        default:
            break
        }
    }

    private func afterRelease() {
        guard let sv, let r = released, !sv.isTracking else { return }
        // A snap scroll let go with no speed: UIKit doesn't move to its target then, so go to the nearest point
        // (Android snaps a let-go with no speed too).
        if snap?.snaps == true, !sv.isDecelerating, let m = metrics() {
            let to = snap!.pick(start: m.offset, projected: m.offset, velocity: 0, viewport: m.viewport, max: m.max)
            if abs(to - m.offset) > 0.5 {
                var p = sv.contentOffset
                if horizontal { p.x = to - sv.adjustedContentInset.left } else { p.y = to - sv.adjustedContentInset.top }
                sv.setContentOffset(p, animated: true)
            }
        }
        guard wants?.momentum == true else { released = nil; return }
        // Watch frame by frame: momentum begins when the offset moves after the release (a bounce back at an edge
        // doesn't move it, as Android has none) and ends when it rests.
        inMomentum = false
        stillFrames = 0
        frames = 0
        lastTick = r.metrics.offset
        if link == nil {
            let l = CADisplayLink(target: self, selector: #selector(tick))
            l.add(to: .main, forMode: .common)
            link = l
        }
    }

    @objc private func tick() {
        guard let sv, let m = metrics(), let r = released else { return stopMomentum(send: false) }
        frames += 1
        let moved = abs(m.offset - lastTick) > 0.01
        lastTick = m.offset
        if moved {
            stillFrames = 0
            if !inMomentum {
                inMomentum = true
                // Where and how fast it was let go, as Android's onMomentumScrollBegin.
                if wants?.momentumBegin == true { send("mb", r.metrics, velocity: r.velocity) }
            }
        } else if !sv.isDecelerating {
            stillFrames += 1
            // At rest: two still frames once it coasted; nothing moved in the first few: it never coasted.
            if (inMomentum && stillFrames >= 2) || (!inMomentum && frames >= 4) { stopMomentum(send: true) }
        }
    }

    /// Ends the momentum watch; [send]: onMomentumScrollEnd if it had begun.
    private func stopMomentum(send sendEnd: Bool) {
        link?.invalidate()
        link = nil
        if inMomentum, sendEnd, wants?.momentumEnd == true { send("me") }
        inMomentum = false
        released = nil
    }

    // MARK: Snapping

    /// From ZnSnapBehavior: SwiftUI's resting point for a released drag ([origin], in the content's coordinates, the
    /// same as metrics' offsets), moved to Android's snap pick. Only for the user's release: a programmatic scroll or
    /// a resize keeps its target.
    func snapTarget(_ origin: inout CGPoint) {
        guard let snap, snap.snaps, let sv, sv.panGestureRecognizer.state == .ended, let m = metrics() else { return }
        let projected = horizontal ? origin.x : origin.y
        let to = snap.pick(start: m.offset, projected: projected, velocity: fingerVelocity(sv), viewport: m.viewport,
                           max: m.max)
        if horizontal { origin.x = to } else { origin.y = to }
    }
}

/// A vertical Scroll that hugs its content (see ZnScrollView): a ScrollView's ideal height (asked with no height) is its
/// content's, so the Scroll takes that, up to the height it is offered. Without hug it is the ScrollView as it is.
struct ZnScrollHugLayout: Layout {
    var hug: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        guard hug else { return child.sizeThatFits(proposal) }
        let ideal = child.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        var h = ideal.height
        if let p = proposal.height, p.isFinite { h = min(h, p) }
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? ideal.width
        return CGSize(width: w, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}
