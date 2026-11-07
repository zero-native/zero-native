// The back stack on iOS, both ways (i.1c). JS owns the stack (ARCHITECTURE.md §11): NAV ops change ZnApp.stack and
// the host shows it; one batch's ops arrive together, so a replace (REMOVE + PUSH) is one change of the stack, and
// the host picks the transition from the result (push if the new top is new, pop if it was below), as on Android.
//
// The swipe back is the hard part: on Android every back press asks JS first (useBack can keep the screen), but an
// iOS swipe moves the screen before JS could answer. Two policies, ZN_IOS_SWIPE:
// - "native" (default): the swipe pops at once, interactively; JS hears FORCED_BACK for the entry (as when Android's
//   300 ms fallback pops without JS). A useBack handler is skipped.
// - "ask": the swipe doesn't move the screen; it sends BACK to JS, which pops (animated) or keeps the screen.
// UIKit variant: UINavigationController with one UIHostingController per entry. SwiftUI variant: NavigationStack(path:).
// Open (i.1c, 2026-11-08): on the simulator, a synthetic edge swipe reaches the pop gesture (once we are its delegate)
// but it never begins, in both variants, while the same swipe pops in Settings. [check on a device]; the likely fix is
// our own pan recognizer driving the transition (as react-native-screens does).
import SwiftUI
import UIKit

enum ZnSwipePolicy {
    case native, ask
    static let current: ZnSwipePolicy = ProcessInfo.processInfo.environment["ZN_IOS_SWIPE"] == "ask" ? .ask : .native
}

/// One back-stack entry's screen.
struct ZnEntryScreen: View {
    let app: ZnApp
    let entry: UInt32

    var body: some View {
        if let ctx = app.ctx, let root = app.store.find(entry) {
            ZnScreenView(ctx: ctx, root: root)
                .background(Color.white)
        } else {
            Color.white
        }
    }
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

// MARK: - UIKit: UINavigationController

struct ZnNavUIKit: UIViewControllerRepresentable {
    let app: ZnApp
    let stack: [UInt32]

    func makeCoordinator() -> Coordinator { Coordinator(app: app) }

    func makeUIViewController(context: Context) -> UINavigationController {
        let nav = UINavigationController()
        nav.setNavigationBarHidden(true, animated: false)
        nav.delegate = context.coordinator
        context.coordinator.nav = nav
        return nav
    }

    func updateUIViewController(_ nav: UINavigationController, context: Context) {
        context.coordinator.sync(stack)
    }

    @MainActor
    final class Coordinator: NSObject, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
        let app: ZnApp
        weak var nav: UINavigationController?
        private var screens: [UInt32: UIViewController] = [:]

        init(app: ZnApp) { self.app = app }

        func sync(_ stack: [UInt32]) {
            guard let nav else { return }
            // The gesture exists only once the view has loaded (it was nil in makeUIViewController: found 2026-11-08,
            // the swipe never started). Without us as its delegate, UIKit keeps it off while the bar is hidden.
            if let g = nav.interactivePopGestureRecognizer, g.delegate !== self {
                print("zn nav: taking the swipe-back gesture's delegate")
                g.delegate = self
            }
            let vcs = stack.map { entry in
                screens[entry] ?? {
                    let vc = UIHostingController(rootView: ZnEntryScreen(app: app, entry: entry))
                    vc.view.backgroundColor = .white
                    screens[entry] = vc
                    return vc
                }()
            }
            if vcs != nav.viewControllers {
                print("zn t=\(ZnDebug.ms()) uikit: setViewControllers (\(vcs.count) screens)")
                nav.setViewControllers(vcs, animated: !nav.viewControllers.isEmpty)
            }
            screens = screens.filter { stack.contains($0.key) }
        }

        private func entry(of vc: UIViewController) -> UInt32? { screens.first { $0.value === vc }?.key }

        // A swipe that finished: native popped; JS is told.
        func navigationController(_ nav: UINavigationController, didShow vc: UIViewController, animated: Bool) {
            print("zn t=\(ZnDebug.ms()) uikit: didShow")
            let shown = nav.viewControllers.compactMap(entry(of:))
            if shown != app.stack { app.nativeChanged(to: shown) }
        }

        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            print("zn nav: swipe back wants to begin (\(nav?.viewControllers.count ?? 0) screens)")
            guard let nav, nav.viewControllers.count > 1 else { return false }
            if ZnSwipePolicy.current == .ask {
                app.systemBack()  // JS decides; the screen moves only when JS pops it
                return false
            }
            return true
        }
    }
}
