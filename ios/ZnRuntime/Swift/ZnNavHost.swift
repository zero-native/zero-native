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
/// behind the bars either way (as android/runtime's ZnNavHost does).
struct ZnEntryScreen: View {
    let app: ZnApp
    let entry: UInt32

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
            ZnScreenView(ctx: ctx, root: root)
                .ignoresSafeArea(.container, edges: unsafeEdges(route))
                .background(ZnBarStrips(entry: entry, base: background ?? .white))
                .ignoresSafeArea(.keyboard, edges: route?.resizeForKeyboard == false ? .bottom : [])
        } else {
            Color.white
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
                    .navigationDestination(for: UInt32.self) { entry in
                        ZnEntryScreen(app: app, entry: entry)
                            .toolbar(.hidden, for: .navigationBar)
                    }
            }
        }
    }
}

// MARK: - UIKit: UINavigationController as the window's root

extension ZnApp {
    /// The window's root: the back stack (UIKit), or the SwiftUI comparison variant.
    public func makeRootViewController() -> UIViewController {
        switch ZnImpl.nav {
        case .uiKit: return ZnRootController(app: self)  // the back stack with startApp's layers (ZnLayers.swift)
        case .swiftUI: return UIHostingController(rootView: ZnRootView(app: self))
        }
    }
}

@MainActor
final class ZnNavController: UINavigationController, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
    let app: ZnApp
    private var screens: [UInt32: UIViewController] = [:]
    private var failureShown = false
    /// Our own back swipe (not UIKit's interactivePopGestureRecognizer: in our screens, where the left edge is mostly
    /// Pressables, it often never began and the drag became a tap, 2026-11-08). It starts within [edge] of the left
    /// edge, moving right, cancels the press under the finger, and drives the pop with the finger (ZnPopAnimator).
    private lazy var backPan = UIPanGestureRecognizer(target: self, action: #selector(backPanned(_:)))
    private var interaction: UIPercentDrivenInteractiveTransition?
    private let edge: CGFloat = 30

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
        let vcs = stack.map { entry in
            screens[entry] ?? (app.route(of: entry)?.native).map { name in
                let vc = app.nativeScreen(name, entry: entry, params: app.nativeParams[entry] ?? nil)
                markIfSecure(vc, entry)
                screens[entry] = vc
                return vc
            } ?? {
                let vc = ZnScreenController(rootView: ZnEntryScreen(app: app, entry: entry))
                vc.lightStatusBar = app.route(of: entry)?.lightStatusBar ?? false
                vc.entry = entry
                vc.view.backgroundColor = .white
                markIfSecure(vc, entry)
                screens[entry] = vc
                return vc
            }()
        }
        if vcs != viewControllers {
            print("zn t=\(ZnDebug.ms()) uikit: setViewControllers (\(vcs.count) screens)")
            setViewControllers(vcs, animated: !viewControllers.isEmpty && !ZnSplash.holding)  // under the splash: no slide
        }
        screens = screens.filter { stack.contains($0.key) }
    }

    private func entry(of vc: UIViewController) -> UInt32? { screens.first { $0.value === vc }?.key }

    /// A `secure: true` screen counts itself drawn while its view is in the window (ZnSecure), native screens included.
    private func markIfSecure(_ vc: UIViewController, _ entry: UInt32) {
        if app.route(of: entry)?.secure == true { vc.view.addSubview(ZnDrawnMarker()) }
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
        let shown = viewControllers.compactMap(entry(of:))
        if !shown.isEmpty, shown != app.stack { app.nativeChanged(to: shown) }
    }

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard g === backPan, viewControllers.count > 1, transitionCoordinator == nil,
              let top = app.stack.last else { return false }
        // The edge swipe pops screens that pushed in from the side; a modal / fade / none screen closes with its
        // own button (as an iOS modal does), not with a sideways swipe.
        guard app.route(of: top)?.transition ?? .push == .push else { return false }
        let start = backPan.location(in: view).x - backPan.translation(in: view).x
        let v = backPan.velocity(in: view)
        guard start <= edge, v.x > 0, abs(v.x) > abs(v.y) else { return false }  // from the left edge, moving right
        if app.backWanted.contains(top) {
            print("zn t=\(ZnDebug.ms()) nav: swipe on a screen that wants Back → BACK to JS")
            app.systemBack()  // JS decides; the screen moves only if JS pops it
            return false
        }
        print("zn t=\(ZnDebug.ms()) nav: swipe back, native pop")
        return true
    }

    @objc private func backPanned(_ g: UIPanGestureRecognizer) {
        let width = max(view.bounds.width, 1)
        let progress = min(max(g.translation(in: view).x / width, 0), 1)
        switch g.state {
        case .began:
            interaction = UIPercentDrivenInteractiveTransition()
            popViewController(animated: true)
        case .changed:
            interaction?.update(progress)
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

    // The swipe drives our pop animation. Otherwise the route's transition, as on Android: a push uses the new
    // screen's, a pop the leaving screen's. "push" is UIKit's own slide.
    func navigationController(_ nav: UINavigationController, animationControllerFor operation: UINavigationController.Operation,
                              from: UIViewController, to: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        if interaction != nil && operation == .pop { return ZnPopAnimator() }
        guard let entry = entry(of: operation == .push ? to : from),
              let transition = app.route(of: entry)?.transition, transition != .push else { return nil }
        return ZnTransitionAnimator(transition: transition, opening: operation == .push)
    }

    func navigationController(_ nav: UINavigationController,
                              interactionControllerFor animator: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        animator is ZnPopAnimator ? interaction : nil
    }
}

/// The pop the back swipe drives: like UIKit's (the top screen slides off to the right with a shadow, the one under it
/// comes in from a third of the way left, dimmed), linear so the finger sets the pace.
final class ZnPopAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    func transitionDuration(using ctx: UIViewControllerContextTransitioning?) -> TimeInterval { 0.35 }

    func animateTransition(using ctx: UIViewControllerContextTransitioning) {
        guard let from = ctx.view(forKey: .from), let to = ctx.view(forKey: .to) else { return ctx.completeTransition(false) }
        let box = ctx.containerView
        let width = box.bounds.width
        to.frame = ctx.finalFrame(for: ctx.viewController(forKey: .to)!)
        box.insertSubview(to, belowSubview: from)
        let dim = UIView(frame: to.bounds)
        dim.backgroundColor = UIColor.black.withAlphaComponent(0.1)
        to.addSubview(dim)
        to.transform = CGAffineTransform(translationX: -width / 3, y: 0)
        from.layer.shadowColor = UIColor.black.cgColor
        from.layer.shadowOpacity = 0.15
        from.layer.shadowRadius = 8
        UIView.animate(withDuration: transitionDuration(using: ctx), delay: 0, options: .curveLinear, animations: {
            to.transform = .identity
            from.transform = CGAffineTransform(translationX: width, y: 0)
            dim.alpha = 0
        }, completion: { _ in
            dim.removeFromSuperview()
            from.layer.shadowOpacity = 0
            from.transform = .identity
            to.transform = .identity
            ctx.completeTransition(!ctx.transitionWasCancelled)
        })
    }
}

/// A route's transition other than "push" (routes.ts `transition`, as android/runtime's ZnNavHost.transitions):
/// "modal" comes up from the bottom over the old screen and goes back down; "fade" cross-fades; "none" is instant.
final class ZnTransitionAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    let transition: ZnRoute.Transition
    let opening: Bool

    init(transition: ZnRoute.Transition, opening: Bool) {
        self.transition = transition
        self.opening = opening
    }

    func transitionDuration(using ctx: UIViewControllerContextTransitioning?) -> TimeInterval {
        transition == .none ? 0 : transition == .fade ? 0.25 : 0.4
    }

    func animateTransition(using ctx: UIViewControllerContextTransitioning) {
        guard let from = ctx.view(forKey: .from), let to = ctx.view(forKey: .to),
              let toVC = ctx.viewController(forKey: .to) else { return ctx.completeTransition(false) }
        print("zn t=\(ZnDebug.ms()) uikit: \(transition.rawValue) transition, \(opening ? "opening" : "closing")")
        let box = ctx.containerView
        to.frame = ctx.finalFrame(for: toVC)
        let height = box.bounds.height
        switch (transition, opening) {
        case (.modal, true):
            box.addSubview(to)
            to.transform = CGAffineTransform(translationX: 0, y: height)
        case (.modal, false):
            box.insertSubview(to, belowSubview: from)
        case (.fade, _):
            box.addSubview(to)
            to.alpha = 0
        default:
            box.addSubview(to)
        }
        let done = { (finished: Bool) in
            to.transform = .identity
            from.transform = .identity
            to.alpha = 1
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
        }, completion: done)
    }
}
