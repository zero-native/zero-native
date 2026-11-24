// Scroll views and plugin views drawn inside a Pressable (a card with a horizontal chip rail, a product card with an
// image Carousel, a WebView in a tappable box). On Android the inner one sees the touch first (Compose's hit test,
// children first): a scroll that takes the drag cancels the Pressable's press (onPressOut(true), no onPress), and a
// plugin view that takes the touch keeps it. On iOS the Pressable's touch view lies over its whole content, so the
// inner UIScrollView never saw the touch: the chips didn't scroll and the swipe fired the card's onPress (found
// 2026-11-24, ZeroBill's TransactionRowCard).
//
// Now the Pressable's touch view (ZnTouchControl.hitTest) leaves the touch to an inner scroll view that can scroll and
// presses through ZnPressForward, a recognizer on that scroll view that only watches: the Pressable is pressed after
// UIKit's content delay (as a Pressable inside the scroll would be) or at once at a quick lift, and the press is
// cancelled when a scroll around the finger starts. A tap on the rail still presses the card, as on Android. A plugin
// view that takes touches itself (a recognizer or a control under the finger) gets the touch and the Pressable none.
import SwiftUI
import UIKit

@MainActor
enum ZnPressInner {
    final class Entry {
        weak var view: UIView?
        /// The Pressables around it (ZnPressLink ids, as znPressAncestors).
        var ancestors: Set<ObjectIdentifier>
        /// A plugin's view (else a scroll view).
        let native: Bool
        init(_ v: UIView, _ ancestors: Set<ObjectIdentifier>, native: Bool) {
            view = v
            self.ancestors = ancestors
            self.native = native
        }
    }

    private static var entries: [ObjectIdentifier: Entry] = [:]

    /// [v] is drawn inside the Pressables [ancestors] (none: it is no longer inside one, it is gone, or it takes no
    /// touches under pointerEvents "none" / "box-only": it is forgotten, and the Pressable keeps the touch).
    static func note(_ v: UIView, ancestors: [ObjectIdentifier], native: Bool) {
        let key = ObjectIdentifier(v)
        if ancestors.isEmpty {
            entries[key] = nil
            return
        }
        if let e = entries[key], e.view === v {
            e.ancestors = Set(ancestors)
            return
        }
        entries = entries.filter { $0.value.view != nil }
        entries[key] = Entry(v, Set(ancestors), native: native)
    }

    /// What inside the Pressable [own] takes the touch at [p] (window space) before it: a plugin view that takes
    /// touches there, or the outermost scroll view that can scroll there. nil: the Pressable keeps it.
    static func taker(at p: CGPoint, in window: UIWindow, inside own: ObjectIdentifier, event: UIEvent?) -> (UIView, native: Bool)? {
        var scroll: UIScrollView?
        // Views gone without a word (a plugin view has no dismantle) are dropped here.
        if entries.values.contains(where: { $0.view == nil }) { entries = entries.filter { $0.value.view != nil } }
        for e in entries.values where e.ancestors.contains(own) {
            guard let v = e.view, v.window === window, znReaches(v, p, in: window) else { continue }
            if e.native {
                if takesTouches(v, at: v.convert(p, from: window), event: event) { return (v, true) }
            } else if let sv = v as? UIScrollView, canScroll(sv) {
                // The outermost one: its recognizer sees the touch wherever it lands inside.
                if scroll.map({ sv.isDescendant(of: $0) }) != true { scroll = sv }
            }
        }
        return scroll.map { ($0, false) }
    }

    /// The scroll view has more content than it shows (bouncing alone isn't scrolling: Compose doesn't take the drag).
    static func canScroll(_ sv: UIScrollView) -> Bool {
        guard sv.isScrollEnabled, sv.isUserInteractionEnabled else { return false }
        let i = sv.adjustedContentInset
        return sv.contentSize.width + i.left + i.right > sv.bounds.width + 0.5
            || sv.contentSize.height + i.top + i.bottom > sv.bounds.height + 0.5
    }

    /// A plugin view takes the touch at [p] (its space) when what is under the finger, or a view around it inside the
    /// plugin's view, is a control, a scroll view or has a recognizer (a WebView, a map). A view that only draws (an
    /// animation) leaves the tap to the Pressable, as Android's AndroidView that doesn't handle the down.
    private static func takesTouches(_ v: UIView, at p: CGPoint, event: UIEvent?) -> Bool {
        guard var h = v.hitTest(p, with: event) else { return false }
        while true {
            if h is UIControl || h is UIScrollView || (h.gestureRecognizers ?? []).contains(where: \.isEnabled) { return true }
            guard h !== v, let up = h.superview else { return false }
            h = up
        }
    }
}

/// Inside the content of a SwiftUI ScrollView (a <Scroll>, a <Carousel>) that is inside a Pressable: notes the scroll
/// view with the Pressables around it (ZnPressInner), none under znTouchOff (SwiftUI takes the scroll out of the hit
/// test there, its UIScrollView still says it takes touches: the card would leave the tap to a scroll that never gets
/// it). Drawn only inside a Pressable.
struct ZnInnerScrollMark: UIViewRepresentable {
    let ancestors: [ObjectIdentifier]

    func makeUIView(context: Context) -> ZnInnerScrollMarkView {
        let v = ZnInnerScrollMarkView()
        v.isUserInteractionEnabled = false
        v.isAccessibilityElement = false
        return v
    }

    func updateUIView(_ v: ZnInnerScrollMarkView, context: Context) {
        v.ancestors = ancestors
        v.note()
    }

    static func dismantleUIView(_ v: ZnInnerScrollMarkView, coordinator: ()) {
        if let sv = v.scroll { ZnPressInner.note(sv, ancestors: [], native: false) }
    }
}

final class ZnInnerScrollMarkView: UIView {
    var ancestors: [ObjectIdentifier] = []
    private(set) weak var scroll: UIScrollView?

    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window != nil { note() }
    }

    /// The nearest scroll view up the hierarchy (again if SwiftUI made a new one).
    func note() {
        var p = superview
        while let v = p, !(v is UIScrollView) { p = v.superview }
        guard let sv = p as? UIScrollView else { return }
        if let old = scroll, old !== sv { ZnPressInner.note(old, ancestors: [], native: false) }
        scroll = sv
        ZnPressInner.note(sv, ancestors: ancestors, native: false)
    }
}

/// Would a touch at [p] (window space) reach [v]? It must take the point itself (shown, taking touches, the point
/// inside it), and so must each view above it: a scroll view or a list clips it, and a hidden or reused cell, a Sheet
/// or the screen keeps it out, as UIKit's own hit test. Stricter than the gesture hub's znShows (ZnGestureHub.swift),
/// on purpose: a touch view and a scroll view only get touches through UIKit's hit test, which needs all of this;
/// the hub's targets get theirs from the hub's own recognizer, so only clipping views keep them out.
@MainActor func znReaches(_ v: UIView, _ p: CGPoint, in window: UIWindow) -> Bool {
    var u: UIView? = v
    while let s = u, s !== window {
        if s.isHidden || !s.isUserInteractionEnabled || s.alpha < 0.01 || !s.point(inside: s.convert(p, from: window), with: nil) {
            return false
        }
        u = s.superview
    }
    return true
}

/// On a scroll view inside a Pressable: presses that Pressable (its ZnTouchControl) for a touch it left to the scroll
/// (ZnTouchControl.hitTest arms it for that touch). Never begins, never cancels or delays the scroll's touches.
final class ZnPressForward: UIGestureRecognizer {
    /// UIKit's content delay: a scroll that starts before it presses nothing, as for a Pressable inside a scroll.
    static let delay: TimeInterval = 0.15

    private weak var armed: ZnTouchControl?
    private weak var owner: ZnTouchControl?
    private var touch: UITouch?
    /// When the finger went down (the owner's long press and repeat are timed from it).
    private var downAt: CFTimeInterval = 0
    /// The press went to the owner (after the delay or at the lift).
    private var began = false
    private var timer: Timer?
    private var watched: [UIPanGestureRecognizer] = []

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    /// The forwarder on [sv] (added the first time).
    static func on(_ sv: UIScrollView) -> ZnPressForward {
        if let f = sv.gestureRecognizers?.first(where: { $0 is ZnPressForward }) as? ZnPressForward { return f }
        let f = ZnPressForward()
        sv.addGestureRecognizer(f)
        return f
    }

    /// The next touch (this turn of the main loop) presses [control].
    func arm(_ control: ZnTouchControl) {
        armed = control
        DispatchQueue.main.async { [weak self] in self?.armed = nil }
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard touch == nil, let t = touches.first, let c = armed, c.window != nil else {
            if touch == nil { state = .failed }
            return
        }
        armed = nil
        // It landed on a Pressable, a TextField or a control inside the scroll: that one has it.
        if let v = t.view, v is ZnTouchControl || v is UIControl || v is UITextView {
            state = .failed
            return
        }
        owner = c
        touch = t
        began = false
        downAt = CACurrentMediaTime()
        // Any scroll around the finger (this one, a page around it, a rail inside it) that starts cancels the press.
        var v = t.view
        while let s = v {
            if let sv = s as? UIScrollView {
                sv.panGestureRecognizer.addTarget(self, action: #selector(scrolled(_:)))
                watched.append(sv.panGestureRecognizer)
            }
            v = s.superview
        }
        timer = Timer.scheduledTimer(withTimeInterval: Self.delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated { self?.press() }
        }
    }

    private func press() {
        timer?.invalidate()
        timer = nil
        guard !began, let t = touch, let c = owner else { return }
        began = true
        c.late = CACurrentMediaTime() - downAt
        c.touchesBegan([t], with: nil)
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard began, let t = touch, touches.contains(t) else { return }
        owner?.touchesMoved([t], with: event)
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = touch, touches.contains(t) else { return }
        // A quick tap: pressed and lifted at once, as UIKit hands a scroll's delayed touch over at the lift.
        press()
        owner?.touchesEnded([t], with: event)
        stop()
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let t = touch, touches.contains(t) else { return }
        cancel()
        state = .failed
    }

    @objc private func scrolled(_ pan: UIPanGestureRecognizer) {
        guard pan.state == .began || pan.state == .changed, touch != nil else { return }
        cancel()
    }

    /// The scroll took the touch: onPressOut(true) if the press began, else nothing at all.
    private func cancel() {
        if began, let t = touch { owner?.touchesCancelled([t], with: nil) }
        stop()
    }

    private func stop() {
        timer?.invalidate()
        timer = nil
        for g in watched { g.removeTarget(self, action: #selector(scrolled(_:))) }
        watched = []
        touch = nil
        owner = nil
        began = false
    }

    override func reset() {
        super.reset()
        if touch != nil { cancel() }
    }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
