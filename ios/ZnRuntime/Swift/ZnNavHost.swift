// The back stack on iOS (i.1c: UIKit). JS owns the stack (ARCHITECTURE.md §11): NAV ops change ZnApp.stack and the
// host shows it; one batch's ops arrive together, so a replace (REMOVE + PUSH) is one change of the stack, and the
// host picks the transition from the result (push if the new top is new, pop if it was below), as on Android.
//
// The swipe back (android-issues-found-when-building-ios.md A8): JS tells native which screens want Back first (NAV
// BACK_WANTED: a useBack / BackHandler, or tabs on a later tab). On such a screen the swipe doesn't move it: it sends
// BACK to JS, which pops (animated) or keeps the screen. On any other screen the swipe pops at once, interactively,
// and JS hears FORCED_BACK for the entry.
//
// ZnNavController is the window's root (2026-11-08): the app shell is UIKit, SwiftUI draws inside screens. The back
// swipe is our own pan gesture driving the pop (backPan, ZnPopAnimator): UIKit's built-in one often never began in our
// screens, whose left edge is mostly Pressables (a drag there became a tap). The SwiftUI variant (NavigationStack,
// ZN_IOS_NAV=swiftui) stays for comparison until the device checks are done.
import SwiftUI
import UIKit

/// One back-stack entry's screen, with its route's safe area: the sides it doesn't keep clear of the system bars are
/// drawn under them (a full-bleed header pads itself with insets().top), and the screen's root background fills
/// behind the bars either way (as android/runtime's ZnNavHost does). A see-through screen (`transparent: true`, in a
/// ZnSeeThroughBox) has no white of its own: with no root background the screens below show through.
struct ZnEntryScreen: View {
    let app: ZnApp
    let entry: UInt32
    var seeThrough = false

    var body: some View {
        if let message = app.failedScreens[entry] {
            // A screen whose JS threw (or hung) shows the error screen instead.
            ZnErrorScreenView(message: message, startFailed: false, canGoBack: (app.stack.firstIndex(of: entry) ?? 0) > 0,
                              onRetry: { app.retry(entry) }, onBack: { app.systemBack() })
        } else if let ctx = app.ctx, let root = app.store.find(entry) {
            let route = app.route(of: entry)
            let node = ctx.templates[safe: root.templateId]?.nodes.first
            let background = node.flatMap { $0.backgroundSlot >= 0 ? znColor(root.slot($0.backgroundSlot).value) : $0.background }
            // keyboard "resize" (default): SwiftUI lays the screen out above the keyboard (its keyboard safe area),
            // as Android's imePadding; only the part of the keyboard below the bottom safe area is new room taken.
            // "none": the keyboard covers the screen.
            // The entry: impressions, shared elements and List cells count under it (ZnEnv.swift).
            ZnScreenView(ctx: ctx, root: root)
                .environment(\.znEntry, entry)
                .ignoresSafeArea(.container, edges: unsafeEdges(route))
                .background(ZnBarStrips(entry: entry, base: background ?? (seeThrough ? .clear : .white)))
                .ignoresSafeArea(.keyboard, edges: route?.resizeForKeyboard == false ? .bottom : [])
        } else {
            seeThrough ? Color.clear : Color.white
        }
    }

    private func unsafeEdges(_ route: ZnRoute?) -> Edge.Set {
        var e: Edge.Set = []
        if route?.safeTop == false { e.insert(.top) }
        if route?.safeBottom == false { e.insert(.bottom) }
        return e
    }
}

/// A screen's controller: its route's status bar style.
final class ZnScreenController: UIHostingController<ZnEntryScreen> {
    var lightStatusBar = false
    var entry: UInt32 = 0
    /// The screen's <StatusBar barStyle> (ZnSystemBars), else its route's `statusBar` option.
    override var preferredStatusBarStyle: UIStatusBarStyle {
        (ZnSystemBars.shared.merged(entry, navigation: false)?.lightContent ?? lightStatusBar) ? .lightContent : .darkContent
    }
    /// <StatusBar hidden>.
    override var prefersStatusBarHidden: Bool { ZnSystemBars.shared.merged(entry, navigation: false)?.hidden == true }
}

// MARK: - SwiftUI: NavigationStack(path:)

struct ZnNavSwiftUI: View {
    let app: ZnApp
    let stack: [UInt32]

    var body: some View {
        if let first = stack.first {
            NavigationStack(path: Binding(
                get: { Array(stack.dropFirst()) },
                set: { path in app.nativeChanged(to: [first] + path) }
            )) {
                ZnEntryScreen(app: app, entry: first)
                    .toolbar(.hidden, for: .navigationBar)
                    .modifier(ZnSwiftUIDrawn(app: app, entry: first))
                    .navigationDestination(for: UInt32.self) { entry in
                        ZnEntryScreen(app: app, entry: entry)
                            .toolbar(.hidden, for: .navigationBar)
                            .modifier(ZnSwiftUIDrawn(app: app, entry: entry))
                    }
            }
        }
    }
}

/// The SwiftUI variant's ZnDrawnMarker: a screen counts as drawn from onAppear to onDisappear (NavigationStack calls
/// it once a pop's slide has ended), so a leaving screen's instances go then. No secure counting here (no container).
private struct ZnSwiftUIDrawn: ViewModifier {
    let app: ZnApp
    let entry: UInt32
    @State private var generation = ZnApp.shared.screensGeneration
    /// The entry this view counted as drawn. The root sits at one place in the tree: when a reset or replace gives
    /// it a new entry, SwiftUI keeps this view (no disappear / appear), so the old entry is hidden and the new shown.
    @State private var counted: UInt32?

    func body(content: Content) -> some View {
        content
            .onAppear {
                guard counted == nil else { return }
                counted = entry
                app.screenShown(entry, generation: generation)
            }
            .onDisappear {
                guard let c = counted else { return }
                counted = nil
                app.screenHidden(c, generation: generation)
            }
            .onChange(of: entry) { _, new in
                guard let c = counted, c != new else { return }
                counted = new
                app.screenShown(new, generation: generation)
                app.screenHidden(c, generation: generation)
            }
    }
}

// MARK: - UIKit: UINavigationController as the window's root

extension ZnApp {
    /// The window's root: the back stack (UIKit), or the SwiftUI comparison variant.
    public func makeRootViewController() -> UIViewController {
        switch ZnImpl.nav {
        case .uiKit:
            // SwiftUI's Pressables have no UIKit view a see-through screen's holder can find (ZnSeeThroughHolder).
            if hasTransparentRoute && ZnImpl.press == .swiftUI {
                print("zn nav: ZN_IOS_PRESS=swiftui: Pressables on transparent routes don't take taps (they reach the screen below)")
            }
            return ZnRootController(app: self)  // the back stack with startApp's layers (ZnLayers.swift)
        case .swiftUI:
            if hasSecureRoute { print("zn secure: ZN_IOS_NAV=swiftui has no secure container: secure routes are not protected") }
            // NavigationStack takes the screen below out when a push ends: a see-through screen is drawn opaque there.
            if hasTransparentRoute { print("zn nav: ZN_IOS_NAV=swiftui draws transparent routes opaque (white)") }
            return UIHostingController(rootView: ZnRootView(app: self))
        }
    }
}

/// The back stack: one ZnSeeThroughBox per opaque entry (ZnSeeThrough.swift), holding that entry's screen and the
/// see-through screens over it. Without `transparent` routes each box holds one screen.
@MainActor
final class ZnNavController: UINavigationController, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
    let app: ZnApp
    /// Each entry's own controller (a ZnScreenController, or a plugin's native screen).
    private var screens: [UInt32: UIViewController] = [:]
    /// The boxes, by their first entry.
    private var boxes: [UInt32: ZnSeeThroughBox] = [:]
    /// A box UIKit is moving (covered by a push, or in a push or pop under way): its own change (a see-through screen
    /// closed in the same batch, or in one that came during the slide) waits until the slide has ended, so the box
    /// slides as it was. [animate]: the box is then the top one, and its see-through screens open / close animated.
    private var pending: [ObjectIdentifier: (box: ZnSeeThroughBox, layers: [ZnSeeThroughBox.Layer], animate: Bool)] = [:]
    private var failureShown = false
    /// Our own back swipe (not UIKit's interactivePopGestureRecognizer: in our screens, where the left edge is mostly
    /// Pressables, it often never began and the drag became a tap, 2026-11-08). It starts within [edge] of the left
    /// edge, moving right, cancels the press under the finger, and drives the pop with the finger (ZnPopAnimator).
    private lazy var backPan = UIPanGestureRecognizer(target: self, action: #selector(backPanned(_:)))
    private var interaction: UIPercentDrivenInteractiveTransition?
    /// The swipe's shared-element flights (the debug log only).
    private weak var swipeFlight: ZnSharedFlight?
    /// The swipe on a see-through screen moves it alone, inside its box (no UIKit pop).
    private var dragging: ZnSeeThroughBox?
    private let edge: CGFloat = 30
    /// backPan's name: the gesture hub (ZnGestureHub.swift) leaves it to claimsBackEdge instead of making it wait.
    static let backPanName = "zn.backPan"

    init(app: ZnApp) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
        setNavigationBarHidden(true, animated: false)
        delegate = self
        view.backgroundColor = .white
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.isEnabled = false  // ours instead (backPan)
        backPan.delegate = self
        backPan.name = Self.backPanName
        backPan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(backPan)
        // Light / dark changes (the phone's setting, or Control Center): JS's colorScheme() follows.
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: ZnNavController, _: UITraitCollection) in
            ZnSystemEvents.shared.colorSchemeChanged(self.traitCollection.userInterfaceStyle)
        }
        follow()
    }

    /// Shows the stack now, and again whenever ZnApp.stack (or a start failure) changes.
    private func follow() {
        withObservationTracking {
            sync(app.stack, failure: app.failure)
        } onChange: { [weak self] in
            DispatchQueue.main.async { self?.follow() }
        }
    }

    private func sync(_ stack: [UInt32], failure: String?) {
        if let failure {
            guard !failureShown else { return }
            failureShown = true
            // The app's JS didn't start (or the bundle can't be read): the error screen, with no button (ZnErrorScreen).
            setViewControllers([UIHostingController(rootView: ZnErrorScreenView(message: failure, startFailed: true, canGoBack: false,
                                                                                onRetry: {}, onBack: {}))], animated: false)
            return
        }
        let contents = stack.map(screen(for:))
        let transparent = stack.map { app.route(of: $0)?.transparent == true }
        let groups = ZnRoutes.seeThroughGroups(transparent)
        let vcs = groups.map { g in
            boxes[stack[g.lowerBound]] ?? {
                let box = ZnSeeThroughBox(key: stack[g.lowerBound])
                box.prepare = { [weak self] vc in self?.markLoaded(vc) }
                box.takesAll = { [weak self] entry in self?.app.failedScreens[entry] != nil }
                boxes[box.key] = box
                return box
            }()
        }
        let navChanges = vcs != viewControllers
        // Under the splash: no slide. Nor for a new top screen JS pushed while opening the first screens (before NAV
        // STARTED): it is simply there, as Android's openedAtStart; its back still slides.
        let shownBefore = viewControllers.flatMap { ($0 as? ZnSeeThroughBox)?.entries ?? [] }
        let atStart = stack.last.map { !shownBefore.contains($0) && app.openedAtStart.contains($0) } ?? false
        let animated = !viewControllers.isEmpty && !ZnSplash.holding && !atStart
        let shownBox = viewControllers.last
        // The boxes in a slide under way (a push or pop, the swipe's too).
        let moving = transitionCoordinator.map { c in
            [c.viewController(forKey: .from), c.viewController(forKey: .to)].compactMap { $0.map(ObjectIdentifier.init) }
        } ?? []
        for (box, g) in zip(vcs, groups) {
            let layers = g.map { i in
                box.layers.first { $0.entry == stack[i] && $0.vc === contents[i] }
                    ?? ZnSeeThroughBox.Layer(entry: stack[i], vc: contents[i], seeThrough: transparent[i] && i > g.lowerBound,
                                             transition: app.route(of: stack[i])?.transition ?? .push)
            }
            if navChanges && animated && box === shownBox && box !== vcs.last {
                pending[ObjectIdentifier(box)] = (box, layers, false)  // UIKit covers it now: changed once covered
            } else if moving.contains(ObjectIdentifier(box)) {
                pending[ObjectIdentifier(box)] = (box, layers, !navChanges && box === vcs.last)  // changed once it stops
            } else {
                pending[ObjectIdentifier(box)] = nil
                // A see-through screen opening or closing on the box shown now animates; with a push or pop, at once.
                box.set(layers, animated: animated && !navChanges && box === vcs.last)
            }
        }
        if navChanges {
            print("zn t=\(ZnDebug.ms()) uikit: setViewControllers (\(stack.count) screens\(vcs.count == stack.count ? "" : " in \(vcs.count) box\(vcs.count == 1 ? "" : "es")"), animated \(animated)\(atStart ? ", opened at start" : ""))")
            setViewControllers(vcs, animated: animated)
        }
        // didShow doesn't come after a cancelled swipe: the slide's end applies the waiting changes either way.
        if !pending.isEmpty, let c = transitionCoordinator {
            c.animate(alongsideTransition: nil) { [weak self] _ in self?.applyPending() }
        }
        boxes = boxes.filter { k, _ in vcs.contains { $0.key == k } }
        screens = screens.filter { stack.contains($0.key) }
        unmarked = unmarked.filter { id, _ in screens.values.contains { ObjectIdentifier($0) == id } }
    }

    /// [entry]'s own controller, made the first time.
    private func screen(for entry: UInt32) -> UIViewController {
        if let vc = screens[entry] { return vc }
        let route = app.route(of: entry)
        let vc: UIViewController
        if let name = route?.native {
            vc = app.nativeScreen(name, entry: entry, params: app.nativeParams[entry] ?? nil)
        } else {
            let seeThrough = route?.transparent == true
            let screen = ZnScreenController(rootView: ZnEntryScreen(app: app, entry: entry, seeThrough: seeThrough))
            screen.lightStatusBar = route?.lightStatusBar ?? false
            screen.entry = entry
            screen.view.backgroundColor = seeThrough ? .clear : .white
            vc = screen
        }
        markDrawn(vc, entry)
        screens[entry] = vc
        return vc
    }

    /// The entry UIKit's transitions go by: a box's first (opaque) one.
    private func entry(of vc: UIViewController) -> UInt32? { (vc as? ZnSeeThroughBox)?.key }

    /// Every screen counts itself drawn while its view is in the window (ZnDrawnMarker): a leaving screen's instances
    /// go once it has left (ZnApp.screenHidden), and a `secure: true` one protects captures meanwhile (ZnSecure), native
    /// screens included. A native screen's view not loaded yet gets it when a box is about to use it, so its
    /// viewDidLoad still runs then, not when the stack is built.
    private func markDrawn(_ vc: UIViewController, _ entry: UInt32) {
        if let v = vc.viewIfLoaded { mark(v, entry) } else { unmarked[ObjectIdentifier(vc)] = entry }
    }

    private var unmarked: [ObjectIdentifier: UInt32] = [:]

    /// A box is about to use [vc]'s view (ZnSeeThroughBox.prepare).
    private func markLoaded(_ vc: UIViewController) {
        if let entry = unmarked.removeValue(forKey: ObjectIdentifier(vc)) { mark(vc.view, entry) }
    }

    private func mark(_ v: UIView, _ entry: UInt32) {
        guard !v.subviews.contains(where: { $0 is ZnDrawnMarker }) else { return }
        v.addSubview(ZnDrawnMarker(entry: entry, secure: app.route(of: entry)?.secure == true))
    }

    // A swipe that finished: native popped; JS is told (FORCED_BACK).
    override var childForStatusBarStyle: UIViewController? { topViewController }
    override var childForStatusBarHidden: UIViewController? { topViewController }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        // Inside ZnRootController the root reports them: this view's safe area changes for a moment while startApp's
        // top layer moves the screens (seen 2026-11-08: 83 then 59 reached JS).
        guard parent == nil else { return }
        let i = view.safeAreaInsets
        let ltr = view.effectiveUserInterfaceLayoutDirection == .leftToRight
        app.reportInsets(top: i.top, bottom: i.bottom, start: ltr ? i.left : i.right, end: ltr ? i.right : i.left)
    }

    func navigationController(_ nav: UINavigationController, willShow vc: UIViewController, animated: Bool) {
        setNeedsStatusBarAppearanceUpdate()  // the new top screen's route says light or dark
    }

    func navigationController(_ nav: UINavigationController, didShow vc: UIViewController, animated: Bool) {
        print("zn t=\(ZnDebug.ms()) uikit: didShow")
        applyPending()
        let shown = viewControllers.flatMap { ($0 as? ZnSeeThroughBox)?.entries ?? [] }
        if !shown.isEmpty, shown != app.stack { app.nativeChanged(to: shown) }
    }

    /// The moved boxes' own changes, now that the slide has ended.
    private func applyPending() {
        let waiting = pending.values
        pending = [:]
        for w in waiting where viewControllers.contains(w.box) {
            w.box.set(w.layers, animated: w.animate && w.box === viewControllers.last && !ZnSplash.holding)
        }
    }

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === backPan, transitionCoordinator == nil, dragging == nil, let top = app.stack.last else { return false }
        // A see-through screen over another in its box moves alone (its box isn't popped).
        let box = (topViewController as? ZnSeeThroughBox).flatMap { $0.canDragTop && $0.entries.last == top ? $0 : nil }
        guard viewControllers.count > 1 || box != nil else { return false }
        // The edge swipe pops screens that pushed in from the side; a modal / fade / none screen closes with its
        // own button (as an iOS modal does), not with a sideways swipe.
        guard app.route(of: top)?.transition ?? .push == .push else { return false }
        let start = backPan.location(in: view).x - backPan.translation(in: view).x
        let v = backPan.velocity(in: view)
        guard start <= edge, v.x > 0, abs(v.x) > abs(v.y) else { return false }  // from the left edge, moving right
        // A horizontal zn pan under the finger keeps it (a drawer from the left edge), as Android's
        // systemGestureExclusion: the whole node when it is short, else a 200 pt band at its centre.
        let down = backPan.location(in: nil)
        let at = CGPoint(x: down.x - backPan.translation(in: nil).x, y: down.y - backPan.translation(in: nil).y)
        if ZnGestureHub.claimsBackEdge(at: at, in: topViewController?.view) {
            print("zn t=\(ZnDebug.ms()) nav: swipe back left to a gesture under the finger")
            return false
        }
        if app.backWanted.contains(top) {
            print("zn t=\(ZnDebug.ms()) nav: swipe on a screen that wants Back → BACK to JS")
            app.systemBack()  // JS decides; the screen moves only if JS pops it
            return false
        }
        print("zn t=\(ZnDebug.ms()) nav: swipe back, native pop\(box == nil ? "" : " (see-through)")")
        dragging = box
        return true
    }

    @objc private func backPanned(_ g: UIPanGestureRecognizer) {
        let width = max(view.bounds.width, 1)
        let progress = min(max(g.translation(in: view).x / width, 0), 1)
        if let box = dragging { return dragSeeThrough(box, g, progress) }
        switch g.state {
        case .began:
            interaction = UIPercentDrivenInteractiveTransition()
            popViewController(animated: true)
        case .changed:
            interaction?.update(progress)
            #if DEBUG
            // ZN_SHARED_LOG=1: where the flights are under the finger (the swipe scrubs them).
            if ProcessInfo.processInfo.environment["ZN_SHARED_LOG"] == "1", let f = swipeFlight {
                print("zn t=\(ZnDebug.ms()) shared: swipe \(String(format: "%.2f", progress)) \(f.whereNow())")
            }
            #endif
        case .ended, .cancelled, .failed:
            let fling = g.velocity(in: view).x
            if g.state == .ended && (progress > 0.5 || fling > 600) {
                interaction?.completionSpeed = 1
                interaction?.finish()
                print("zn t=\(ZnDebug.ms()) nav: swipe back finished")
            } else {
                interaction?.cancel()
                print("zn t=\(ZnDebug.ms()) nav: swipe back cancelled")
            }
            interaction = nil
        default:
            break
        }
    }

    /// The back swipe on a see-through screen: it follows the finger over the still screens below; let go past half
    /// (or flung), it leaves and JS hears FORCED_BACK, as after a pop.
    private func dragSeeThrough(_ box: ZnSeeThroughBox, _ g: UIPanGestureRecognizer, _ progress: CGFloat) {
        switch g.state {
        case .began, .changed:
            box.drag(progress)
        case .ended, .cancelled, .failed:
            dragging = nil
            let finish = g.state == .ended && (progress > 0.5 || g.velocity(in: view).x > 600)
            print("zn t=\(ZnDebug.ms()) nav: swipe back \(finish ? "finished" : "cancelled") (see-through)")
            box.endDrag(finish: finish) { [weak self] in
                guard let self else { return }
                let shown = self.viewControllers.flatMap { ($0 as? ZnSeeThroughBox)?.entries ?? [] }.dropLast()
                if !shown.isEmpty { self.app.nativeChanged(to: Array(shown)) }
            }
        default:
            break
        }
    }

    // The swipe drives our pop animation. Otherwise the route's transition, as on Android: a push uses the new
    // screen's, a pop the leaving screen's. "push" is UIKit's own slide, or ours when shared elements fly with it
    // (ZnShared.swift: UIKit's own can't carry them).
    func navigationController(_ nav: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
                              from: UIViewController, to: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        let opening = operation == .push
        let interactive = interaction != nil && !opening
        let transition = entry(of: opening ? to : from).flatMap { app.route(of: $0)?.transition } ?? .push
        let flight = interactive || transition != .none ? sharedFlight(from: from, to: to, opening: opening) : nil
        swipeFlight = interactive ? flight : nil
        if interactive { return ZnPopAnimator(flight: flight) }
        if transition != .push { return ZnTransitionAnimator(transition: transition, opening: opening, flight: flight) }
        return flight.map { ZnSlideAnimator(opening: opening, flight: $0) }
    }

    func navigationController(_ nav: UINavigationController,
                              interactionControllerFor animator: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        animator is ZnPopAnimator ? interaction : nil
    }

    /// The shared elements of a push or pop from box [from] to box [to] (ZnShared.swift), or nil when none can fly: a
    /// push needs a tag on the screen it covers (the new screen's are known once it is laid out), a pop one tag on both.
    private func sharedFlight(from: UIViewController, to: UIViewController, opening: Bool) -> ZnSharedFlight? {
        guard !znAnimationsOff(), let a = from as? ZnSeeThroughBox, let b = to as? ZnSeeThroughBox else { return nil }
        let source = sharedAnchors(a)
        guard !source.isEmpty else { return nil }
        if !opening, Set(source.keys).isDisjoint(with: sharedAnchors(b).keys) { return nil }
        return ZnSharedFlight(from: source, to: { [weak self, weak b] in b.flatMap { self?.sharedAnchors($0) } ?? [:] },
                              waitsForLayout: opening)
    }

    /// The tagged nodes of a box's screens, by tag: not a see-through screen's (Android gives it no shared scope), nor
    /// a native screen's (none), nor a Sheet's or Modal's (another view tree).
    private func sharedAnchors(_ box: ZnSeeThroughBox) -> [String: ZnSharedAnchorView] {
        var out: [String: ZnSharedAnchorView] = [:]
        for l in box.layers where app.route(of: l.entry)?.transparent != true {
            guard let root = l.vc.viewIfLoaded else { continue }
            out.merge(ZnShared.anchors(entry: l.entry, under: root)) { _, top in top }  // the upper screen's wins
        }
        return out
    }
}

/// UIKit's slide (the new screen in from the end edge over the old one, which moves a third of the way behind it,
/// dimmed; Back the other way), for a push or pop that carries shared elements: they fly in the same animation.
class ZnSlideAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    let opening: Bool
    let flight: ZnSharedFlight?
    /// The edge swipe's pop: linear, so the finger sets the pace (UIPercentDrivenInteractiveTransition).
    var interactive: Bool { false }

    init(opening: Bool, flight: ZnSharedFlight?) {
        self.opening = opening
        self.flight = flight
    }

    func transitionDuration(using ctx: UIViewControllerContextTransitioning?) -> TimeInterval { interactive ? 0.35 : 0.4 }

    func animateTransition(using ctx: UIViewControllerContextTransitioning) {
        guard let from = ctx.view(forKey: .from), let to = ctx.view(forKey: .to),
              let toVC = ctx.viewController(forKey: .to) else { return ctx.completeTransition(false) }
        let box = ctx.containerView
        let toFrame = ctx.finalFrame(for: toVC)
        to.frame = toFrame
        box.insertSubview(to, belowSubview: from)  // a pushed screen is drawn under the old one first (ZnSharedFlight)
        to.layoutIfNeeded()
        let start = { [self] in
            flight?.lift(in: box, toView: to, toFrame: toFrame)
            let ltr = box.effectiveUserInterfaceLayoutDirection == .leftToRight
            let width = box.bounds.width * (ltr ? 1 : -1)
            let top = opening ? to : from, under = opening ? from : to
            if opening { box.insertSubview(to, aboveSubview: from) }
            let dim = UIView(frame: under.bounds)
            dim.backgroundColor = UIColor.black.withAlphaComponent(0.1)
            dim.alpha = opening ? 0 : 1
            under.addSubview(dim)
            if opening { to.transform = CGAffineTransform(translationX: width, y: 0) } else { to.transform = CGAffineTransform(translationX: -width / 3, y: 0) }
            top.layer.shadowColor = UIColor.black.cgColor
            top.layer.shadowOpacity = 0.15
            top.layer.shadowRadius = 8
            // A path: with none Core Animation finds the shadow's shape offscreen on every frame.
            top.layer.shadowPath = UIBezierPath(rect: top.bounds).cgPath
            let animations = {
                if self.opening {
                    to.transform = .identity
                    from.transform = CGAffineTransform(translationX: -width / 3, y: 0)
                } else {
                    to.transform = .identity
                    from.transform = CGAffineTransform(translationX: width, y: 0)
                }
                dim.alpha = self.opening ? 1 : 0
                self.flight?.fly()
            }
            let done = { (_: Bool) in
                dim.removeFromSuperview()
                top.layer.shadowOpacity = 0
                top.layer.shadowPath = nil
                from.transform = .identity
                to.transform = .identity
                self.flight?.land()
                ctx.completeTransition(!ctx.transitionWasCancelled)
            }
            if interactive {
                UIView.animate(withDuration: transitionDuration(using: ctx), delay: 0, options: .curveLinear, animations: animations, completion: done)
            } else {
                UIView.animate(withDuration: transitionDuration(using: ctx), delay: 0, usingSpringWithDamping: 1,
                               initialSpringVelocity: 0, options: [], animations: animations, completion: done)
            }
        }
        if let flight, flight.waitsForLayout { flight.whenLaidOut(start) } else { start() }
    }
}

/// The pop the back swipe drives: like UIKit's (the top screen slides off to the right with a shadow, the one under it
/// comes in from a third of the way left, dimmed), linear so the finger sets the pace; shared elements fly with it.
final class ZnPopAnimator: ZnSlideAnimator {
    init(flight: ZnSharedFlight?) { super.init(opening: false, flight: flight) }
    override var interactive: Bool { true }
}

/// A route's transition other than "push" (routes.ts `transition`, as android/runtime's ZnNavHost.transitions):
/// "modal" comes up from the bottom over the old screen and goes back down; "fade" cross-fades; "none" is instant.
/// Shared elements fly in the same animation (not with "none").
final class ZnTransitionAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    let transition: ZnRoute.Transition
    let opening: Bool
    let flight: ZnSharedFlight?

    init(transition: ZnRoute.Transition, opening: Bool, flight: ZnSharedFlight? = nil) {
        self.transition = transition
        self.opening = opening
        self.flight = transition == .none ? nil : flight
    }

    func transitionDuration(using ctx: UIViewControllerContextTransitioning?) -> TimeInterval {
        transition == .none ? 0 : transition == .fade ? 0.25 : 0.4
    }

    func animateTransition(using ctx: UIViewControllerContextTransitioning) {
        guard let from = ctx.view(forKey: .from), let to = ctx.view(forKey: .to),
              let toVC = ctx.viewController(forKey: .to) else { return ctx.completeTransition(false) }
        print("zn t=\(ZnDebug.ms()) uikit: \(transition.rawValue) transition, \(opening ? "opening" : "closing")")
        let box = ctx.containerView
        let toFrame = ctx.finalFrame(for: toVC)
        to.frame = toFrame
        let height = box.bounds.height
        if flight != nil {
            box.insertSubview(to, belowSubview: from)  // a pushed screen is drawn under the old one first (ZnSharedFlight)
            to.layoutIfNeeded()
        }
        let start = { [self] in
            flight?.lift(in: box, toView: to, toFrame: toFrame)
            switch (transition, opening) {
            case (.modal, true):
                box.insertSubview(to, aboveSubview: from)
                to.transform = CGAffineTransform(translationX: 0, y: height)
            case (.modal, false):
                box.insertSubview(to, belowSubview: from)
            case (.fade, _):
                box.insertSubview(to, aboveSubview: from)
                to.alpha = 0
            default:
                box.insertSubview(to, aboveSubview: from)
            }
            let done = { (finished: Bool) in
                to.transform = .identity
                from.transform = .identity
                to.alpha = 1
                self.flight?.land()
                ctx.completeTransition(!ctx.transitionWasCancelled)
            }
            guard transition != .none else { return done(true) }
            UIView.animate(withDuration: transitionDuration(using: ctx), delay: 0,
                           usingSpringWithDamping: 1, initialSpringVelocity: 0, options: [], animations: {
                switch (self.transition, self.opening) {
                case (.modal, true): to.transform = .identity
                case (.modal, false): from.transform = CGAffineTransform(translationX: 0, y: height)
                default: to.alpha = 1
                }
                self.flight?.fly()
            }, completion: done)
        }
        if let flight, flight.waitsForLayout { flight.whenLaidOut(start) } else { start() }
    }
}
