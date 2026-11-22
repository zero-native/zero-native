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
//   card's empty part lets them through, as on Android.
// - The screens below don't get viewWillDisappear / viewDidDisappear when a see-through screen opens over them (they
//   are still on screen, as Android keeps them composed).
// A stack whose bottom entry is see-through starts its box with it (nothing below: the window's background).
// The see-through screen gets no shared elements (Android sets LocalZnSharedVisibility = null): a later sharedTag
// flight must skip transparent routes.
import UIKit

@MainActor
final class ZnSeeThroughBox: UIViewController {
    /// One screen in the box, bottom first.
    final class Layer {
        let entry: UInt32
        let vc: UIViewController
        let seeThrough: Bool
        let transition: ZnRoute.Transition
        /// What the box moves: the screen's view itself (opaque), or a pass-through view holding it (see-through).
        var holder: UIView?
        /// The back swipe took it off screen already: its close doesn't animate again.
        var dragged = false

        init(entry: UInt32, vc: UIViewController, seeThrough: Bool, transition: ZnRoute.Transition) {
            self.entry = entry
            self.vc = vc
            self.seeThrough = seeThrough
            self.transition = transition
        }
    }

    /// The group's first entry (the opaque one, or the stack's bottom): the box's name in ZnNavController.
    let key: UInt32
    private(set) var layers: [Layer] = []
    /// Called just before a screen's view is first used here (ZnNavController marks secure screens then).
    var prepare: (UIViewController) -> Void = { _ in }

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
        for l in layers { attach(l) }
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
            next.append(item)
            addChild(item.vc)
            if isViewLoaded { attach(item) }
            item.vc.didMove(toParent: self)
            if item.seeThrough { open(item, over: next.count > 1 ? next[next.count - 2].entry : nil, animated: animated && next.count > 1) }
        }
        layers = next
        ZnSystemBars.refreshStatusBar()
    }

    /// Takes [vc] out at once (it moves to another box).
    func drop(_ vc: UIViewController) {
        guard let i = layers.firstIndex(where: { $0.vc === vc }) else { return }
        let l = layers.remove(at: i)
        vc.willMove(toParent: nil)
        l.holder?.removeFromSuperview()
        vc.view.removeFromSuperview()
        vc.removeFromParent()
    }

    private func attach(_ l: Layer) {
        prepare(l.vc)
        let v = l.vc.view!
        let holder: UIView
        if l.seeThrough {
            // Sized before the screen goes in: grown from zero later, it would grow the screen by as much again.
            let pass = ZnSeeThroughHolder(frame: view.bounds)
            pass.hosting = v
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
        view.addSubview(holder)
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
        l.vc.willMove(toParent: nil)
        let done = {
            l.holder?.removeFromSuperview()
            l.vc.view.removeFromSuperview()
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

    /// The top screen is see-through, over another in this box: the back swipe moves it alone.
    var canDragTop: Bool { layers.count > 1 && layers.last?.seeThrough == true }

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

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hosting, isUserInteractionEnabled, !isHidden, alpha > 0.01, self.point(inside: point, with: event) else { return nil }
        if let v = super.hitTest(point, with: event), v !== self, v !== hosting, !Self.isContainer(v) { return v }
        if let v = Self.touchView(in: hosting, at: convert(point, to: hosting), event) { return v }
        if let window, let screen = znNearestController(hosting),
           ZnFieldFocus.boxes(at: convert(point, to: window), in: window).contains(where: { $0.controller === screen }) {
            return hosting  // SwiftUI's tap on the box
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
    /// its scroll views, which take their drags.
    private static func isContainer(_ v: UIView) -> Bool {
        if v is UIScrollView || v is UIControl { return false }
        if type(of: v) == UIView.self { return true }
        return NSStringFromClass(type(of: v)).contains("SwiftUI")
    }
}
