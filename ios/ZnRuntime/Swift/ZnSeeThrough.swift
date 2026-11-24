// Registry 24: `transparent: true` routes on iOS, as android/runtime's ZnNavHost.kt ZnSeeThroughStrategy. The back
// stack's UINavigationController holds one ZnSeeThroughBox per opaque entry (Android's scene): that entry's screen and
// the see-through screens pushed over it, drawn together (ZnRoutes.seeThroughGroups). So:
// - the screens below a see-through one stay drawn, and keep updating, where it draws nothing: they never leave the
//   window (UIKit takes a covered screen's view out of it; a box's screens are never covered by UIKit);
// - a screen pushed over a see-through one starts a new box: UIKit's slide moves the old box, both screens in it, and
//   Back slides it back with both;
// - a see-through screen opens and closes inside its box by its own route's transition ("none", "fade", "modal",
//   "push"); the screen below stays still. android-issues A28: Android's scene may move the screen below too.
// - Where the see-through screen has nothing to tap, touches reach the screen below, as on Android (Compose gives a
//   touch to the topmost node with pointer input; a Box with only a background takes none). Pressables, Scrolls,
//   fields, tappable Text, Switch / Checkbox and plugin views take their touches (ZnSeeThroughHolder); a backdrop or a
//   card's empty part lets them through, as on Android. An absolute layer that stops taps (one with a background or
//   children, or pointerEvents "auto" / "box-only": Android's znBlockTouches) takes them, even at opacity 0, as Compose
//   doesn't skip a node for its alpha. A screen showing the error screen takes them all. SwiftUI-only
//   taps let them through too: a plugin's SwiftUI Button, and every Pressable under ZN_IOS_PRESS=swiftui.
// - The screens below don't get viewWillDisappear / viewDidDisappear when a see-through screen opens over them (they
//   are still on screen, as Android keeps them composed).
// A stack whose bottom entry is see-through starts its box with it (nothing below: the window's background).
// The see-through screen gets no shared elements (Android sets LocalZnSharedVisibility = null): a later sharedTag
// flight must skip transparent routes.
// - `accessibilityHidesBelow: true` on its route: VoiceOver skips the screens under it while it shows (A100). They stay
//   drawn; their views are hidden from accessibility (hideBelow). Off by default.
import SwiftUI
import UIKit

@MainActor
final class ZnSeeThroughBox: UIViewController {
    /// One screen in the box, bottom first.
    final class Layer {
        let entry: UInt32
        let vc: UIViewController
        let seeThrough: Bool
        let transition: ZnRoute.Transition
        /// Its route's `accessibilityHidesBelow`: VoiceOver skips the screens under it while it shows.
        let hidesBelow: Bool
        /// What the box moves: the screen's view itself (opaque), or a pass-through view holding it (see-through).
        var holder: UIView?
        /// The back swipe took it off screen already: its close doesn't animate again.
        var dragged = false

        init(entry: UInt32, vc: UIViewController, seeThrough: Bool, transition: ZnRoute.Transition, hidesBelow: Bool = false) {
            self.entry = entry
            self.vc = vc
            self.seeThrough = seeThrough
            self.transition = transition
            self.hidesBelow = hidesBelow
        }
    }

    /// The group's first entry (the opaque one, or the stack's bottom): the box's name in ZnNavController.
    let key: UInt32
    private(set) var layers: [Layer] = []
    /// Called just before a screen's view is first used here (ZnNavController marks secure screens then).
    var prepare: (UIViewController) -> Void = { _ in }
    /// The see-through screen [entry] takes every touch on it: it shows the error screen (opaque, SwiftUI buttons).
    var takesAll: (UInt32) -> Bool = { _ in false }

    init(key: UInt32) {
        self.key = key
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    /// The entries the box shows, bottom first (not the ones closing).
    var entries: [UInt32] { layers.map(\.entry) }
    var contents: [UIViewController] { layers.map(\.vc) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        for l in layers { attach(l, above: nil, top: true) }
        hideBelow()
    }

    // The top screen's status bar: a see-through screen's route `statusBar` (or its <StatusBar>) wins while it shows.
    override var childForStatusBarStyle: UIViewController? { layers.last?.vc }
    override var childForStatusBarHidden: UIViewController? { layers.last?.vc }

    /// Shows [items], bottom first. New see-through screens open and closed ones close by their route's transition
    /// when [animated]; else at once.
    func set(_ items: [Layer], animated: Bool) {
        let keep = Set(items.map(\.entry))
        for l in layers where !keep.contains(l.entry) { close(l, animated: animated) }
        let old = Dictionary(layers.map { ($0.entry, $0) }, uniquingKeysWith: { a, _ in a })
        var next: [Layer] = []
        for item in items {
            if let l = old[item.entry], l.vc === item.vc {
                next.append(l)
                continue
            }
            // A screen another box held (a replace under it): it moves here.
            if let other = item.vc.parent as? ZnSeeThroughBox, other !== self { other.drop(item.vc) }
            let below = next.last
            next.append(item)
            addChild(item.vc)
            // The top one goes over everything (over one closing, as a push); one below goes right over its neighbour.
            if isViewLoaded { attach(item, above: below?.holder, top: item === items.last) }
            item.vc.didMove(toParent: self)
            if item.seeThrough { open(item, over: next.count > 1 ? next[next.count - 2].entry : nil, animated: animated && next.count > 1) }
        }
        layers = next
        hideBelow()
        ZnSystemBars.refreshStatusBar()
    }

    /// What VoiceOver was on when screens were first hidden (hideBelow): it goes back there when they are read again.
    private weak var focusBefore: NSObject?

    /// VoiceOver: the screens under the topmost see-through one whose route says `accessibilityHidesBelow` are hidden
    /// (accessibilityElementsHidden on their views); the rest are read as before, also a see-through screen opened over
    /// that one (a dialog or toast route). Not accessibilityViewIsModal: VoiceOver would then skip the screens above it
    /// too. A change moves VoiceOver as a push and a pop do (screenChanged): to the screen now on top, and back to what
    /// it was on (the thumbnail that opened the viewer) once the screens below are read again. Only while this box is
    /// the screen showing: a change under another screen moves nothing.
    private func hideBelow() {
        guard isViewLoaded else { return }
        let top = layers.lastIndex { $0.seeThrough && $0.hidesBelow }
        let wasHiding = layers.contains { $0.holder?.accessibilityElementsHidden == true }
        var changed = false
        for (i, l) in layers.enumerated() {
            guard let h = l.holder else { continue }
            let hidden = top.map { i < $0 } ?? false
            if h.accessibilityElementsHidden != hidden { changed = true }
            h.accessibilityElementsHidden = hidden
        }
        guard changed else { return }
        let hiding = top != nil
        if hiding && !wasHiding { focusBefore = UIAccessibility.focusedElement(using: .notificationVoiceOver) as? NSObject }
        let back = !hiding ? focusBefore : nil
        if !hiding { focusBefore = nil }
        print("zn t=\(ZnDebug.ms()) see-through: VoiceOver \(top.map { "skips the \($0) screen\($0 == 1 ? "" : "s") under \(layers[$0].entry)" } ?? "reads every screen")")
        guard view.window != nil, navigationController.map({ $0.topViewController === self }) ?? true else { return }
        UIAccessibility.post(notification: .screenChanged, argument: back)
    }

    /// Takes [vc] out at once (it moves to another box). Its view is read again wherever it goes.
    func drop(_ vc: UIViewController) {
        guard let i = layers.firstIndex(where: { $0.vc === vc }) else { return }
        let l = layers.remove(at: i)
        vc.willMove(toParent: nil)
        l.holder?.removeFromSuperview()
        vc.view.removeFromSuperview()
        vc.view.accessibilityElementsHidden = false
        vc.removeFromParent()
    }

    private func attach(_ l: Layer, above below: UIView?, top: Bool) {
        prepare(l.vc)
        let v = l.vc.view!
        // Hidden here before as an opaque screen under one that hides it (its view was the holder): read again.
        v.accessibilityElementsHidden = false
        let holder: UIView
        if l.seeThrough {
            // Sized before the screen goes in: grown from zero later, it would grow the screen by as much again.
            let pass = ZnSeeThroughHolder(frame: view.bounds)
            pass.hosting = v
            pass.takesAll = { [weak self, entry = l.entry] in self?.takesAll(entry) ?? false }
            pass.backgroundColor = .clear
            v.frame = pass.bounds
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            pass.addSubview(v)
            holder = pass
        } else {
            holder = v
        }
        holder.frame = view.bounds
        holder.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        if top {
            view.addSubview(holder)
        } else if let below, below.superview === view {
            view.insertSubview(holder, aboveSubview: below)
        } else {
            view.insertSubview(holder, at: 0)
        }
        l.holder = holder
    }

    // MARK: Opening and closing a see-through screen

    private func open(_ l: Layer, over below: UInt32?, animated: Bool) {
        print("zn t=\(ZnDebug.ms()) see-through: \(l.entry) opens over \(below.map(String.init) ?? "nothing") (\(l.transition.rawValue)\(animated ? "" : ", at once"))")
        guard animated, let h = l.holder, l.transition != .none, !znAnimationsOff() else { return }
        if l.transition == .fade { h.alpha = 0 } else { h.transform = offscreen(l.transition) }
        UIView.animate(withDuration: duration(l.transition), delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0,
                       options: [.allowUserInteraction], animations: {
            h.alpha = 1
            h.transform = .identity
        })
    }

    private func close(_ l: Layer, animated: Bool) {
        print("zn t=\(ZnDebug.ms()) see-through: \(l.entry) closes")
        // Out of VoiceOver while it fades: the screens below are read again at once (hideBelow).
        l.holder?.accessibilityElementsHidden = true
        l.vc.willMove(toParent: nil)
        let done = {
            l.holder?.removeFromSuperview()
            l.vc.view.removeFromSuperview()
            l.vc.view.accessibilityElementsHidden = false  // its view may be the holder: read again if it comes back
            l.vc.removeFromParent()
        }
        guard animated, l.seeThrough, !l.dragged, let h = l.holder, h.window != nil, l.transition != .none,
              !znAnimationsOff() else { return done() }
        h.isUserInteractionEnabled = false
        UIView.animate(withDuration: duration(l.transition), delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0,
                       options: [], animations: {
            if l.transition == .fade { h.alpha = 0 } else { h.transform = self.offscreen(l.transition) }
        }, completion: { _ in done() })
    }

    /// As ZnTransitionAnimator and UIKit's push.
    private func duration(_ t: ZnRoute.Transition) -> TimeInterval { t == .fade ? 0.25 : t == .modal ? 0.4 : 0.35 }

    private func offscreen(_ t: ZnRoute.Transition) -> CGAffineTransform {
        let b = view.bounds
        switch t {
        case .modal: return CGAffineTransform(translationX: 0, y: b.height)
        case .push: return CGAffineTransform(translationX: view.effectiveUserInterfaceLayoutDirection == .leftToRight ? b.width : -b.width, y: 0)
        default: return .identity
        }
    }

    // MARK: The back swipe on a see-through screen (route transition "push")

    /// The top screen is see-through, over another in this box: the back swipe moves it alone. Not one already swiped
    /// away (it stays here until JS's pop lands, 0.25 s on).
    var canDragTop: Bool { layers.count > 1 && layers.last?.seeThrough == true && layers.last?.dragged == false }

    /// [progress] 0...1 of the width: the top screen follows the finger; the screens below stay still.
    func drag(_ progress: CGFloat) {
        guard canDragTop, let h = layers.last?.holder else { return }
        h.transform = CGAffineTransform(translationX: progress * view.bounds.width, y: 0)
    }

    /// The finger let go: off screen ([finish], then [closed] tells JS) or back in place.
    func endDrag(finish: Bool, closed: @escaping () -> Void) {
        guard canDragTop, let top = layers.last, let h = top.holder else { return }
        if finish { top.dragged = true }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut], animations: {
            h.transform = finish ? self.offscreen(.push) : .identity
        }, completion: { _ in if finish { closed() } })
    }
}

/// A see-through screen's view: it takes a touch only where it has something to take it, as Compose's hit testing,
/// where a node with no pointer input lets the touch go on to the screen below:
/// - a UIKit view of ours or a plugin's (a Pressable's touch view, a Scroll, a text field, a native view) under the finger;
/// - a TextField's box or a tappable Text (ZnFieldFocus registers their frames; SwiftUI taps focus or press them).
/// Anything else SwiftUI draws (a backdrop, a card's empty part, plain text) lets it through. SwiftUI's own hitTest
/// can't tell: it answers its hosting view for empty space and for its own content alike, and on some calls for a
/// Pressable's touch view too (seen 2026-11-22: three calls for one touch gave touch view, hosting view, touch view).
/// So the UIKit views under the finger are found here, past SwiftUI's own container views.
final class ZnSeeThroughHolder: UIView {
    weak var hosting: UIView?
    /// The screen shows the error screen (ZnEntryScreen): it takes every touch, as its Retry / Back are SwiftUI's.
    var takesAll: () -> Bool = { false }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hosting, isUserInteractionEnabled, !isHidden, alpha > 0.01, self.point(inside: point, with: event) else { return nil }
        if takesAll() { return super.hitTest(point, with: event) ?? hosting }
        if let v = super.hitTest(point, with: event), v !== self, v !== hosting, !Self.isContainer(v) { return v }
        if let v = Self.touchView(in: hosting, at: convert(point, to: hosting), event) { return v }
        if let window, let screen = znNearestController(hosting) {
            let p = convert(point, to: window)
            if ZnFieldFocus.boxes(at: p, in: window).contains(where: { $0.controller === screen })
                || ZnSeeThroughTaps.any(at: p, in: window, screen: screen) {
                return hosting  // SwiftUI's tap on the box
            }
        }
        return nil
    }

    /// The topmost view under [p] (in [view]'s space) that takes touches, looking inside SwiftUI's containers.
    private static func touchView(in view: UIView, at p: CGPoint, _ event: UIEvent?) -> UIView? {
        for sub in view.subviews.reversed() where !sub.isHidden && sub.alpha > 0.01 && sub.isUserInteractionEnabled {
            let q = view.convert(p, to: sub)
            if isContainer(sub) {
                if sub.clipsToBounds && !sub.bounds.contains(q) { continue }
                if let v = touchView(in: sub, at: q, event) { return v }
            } else if let v = sub.hitTest(q, with: event) {
                return v
            }
        }
        return nil
    }

    /// SwiftUI's own views (hosting, platform view hosts, group containers) and plain UIViews it wraps things in; not
    /// its scroll views, which take their drags, nor a plain UIView with gesture recognizers (a plugin's view or native
    /// screen built from UIView() with a tap or pan: an AndroidView takes its touches too).
    private static func isContainer(_ v: UIView) -> Bool {
        if v is UIScrollView || v is UIControl { return false }
        if NSStringFromClass(type(of: v)).contains("SwiftUI") { return true }
        return type(of: v) == UIView.self && (v.gestureRecognizers ?? []).isEmpty
    }
}

extension EnvironmentValues {
    /// Drawn in a see-through screen (ZnEntryScreen): boxes that stop taps put a ZnSeeThroughTapMarker under them.
    @Entry var znSeeThrough = false
}

/// The Switches and Checkboxes that take taps (enabled, with onValueChange), and the boxes that stop taps (znStopsTaps:
/// an absolute layer, pointerEvents "auto" / "box-only"), for a see-through screen's holder only:
/// SwiftUI taps them, so the holder can't find a UIKit view there. (Switches and Checkboxes are in ZnFieldFocus's boxes
/// too since A53, which the holder checks first; their markers here stay, as the stop-taps boxes are none of those.)
@MainActor
enum ZnSeeThroughTaps {
    private static let views = NSHashTable<UIView>.weakObjects()

    static func register(_ v: UIView) { views.add(v) }

    /// One in [window] under [point] (window coordinates), in [screen].
    static func any(at point: CGPoint, in window: UIWindow, screen: UIViewController) -> Bool {
        views.allObjects.contains { v in
            v.window === window && !v.isHidden && v.convert(v.bounds, to: window).contains(point) && znNearestController(v) === screen
        }
    }
}

/// An empty UIView the size of a Switch / Checkbox (ZnSeeThroughTaps); hidden while it takes no taps.
struct ZnSeeThroughTapMarker: UIViewRepresentable {
    var off = false

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        ZnSeeThroughTaps.register(v)
        return v
    }

    func updateUIView(_ v: UIView, context: Context) { v.isHidden = off }
}
