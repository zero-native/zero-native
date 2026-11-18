// Sheets and Modals on iOS (review finding 20, 2026-11-18): our own layers, children of the window's root
// (ZnRootController) in one box above the screens and the app layers, in open order. Not UIKit presentations: a
// dismiss there also closed everything presented over the closing one (a sheet or Modal opened over a sheet went with
// it), and a leaving screen's layers closed only when UIKit released the screen, ~0.6 s later, taking down what the
// next screen had opened over them meanwhile.
// - Each layer is recorded under (screen entry, node, template index): its screen's entry id (znScreenEntry), or an
//   app layer's root id. Closing matches the layer itself, so it removes that one alone; what is over it stays.
// - A screen that leaves the stack (pop, replace, reset, a swipe back) or an app layer that is replaced closes its
//   layers in that same step, with no slide, before the next screen's own can open (ZnApp). Their entries are
//   remembered, so the leaving screen's tree (drawn for its transition) can't open a layer again.
// - The node leaving the tree (dismantleUIViewController) still closes it: a {cond && <Sheet/>}, the error screen,
//   and a safety net after the nav step (then it finds nothing to close).
// - S5 (a sheet that presents a share sheet or a store page closes with it, 2026-11-11): system controllers present
//   from the root, over every layer; closing the top layer dismisses what was presented after it opened.
// - VoiceOver stays in the top layer: the box is modal while a layer is open, and only the top layer is modal in it.
import UIKit

/// A Sheet or Modal layer in ZnPopups' box.
@MainActor protocol ZnPopupLayer: UIViewController {
    /// Before it is added, its view already the box's size: its first state (a Modal's alpha 0 or slid down).
    func willAppear(in box: ZnPopupBox)
    /// One main-queue turn after it was added, if still open: it shows (a Sheet slides up, a Modal fades or slides).
    func shown()
    /// It closes: takes no touches from now on, and leaves the box (at once, or after its own animation) with
    /// box.drop(self). Never sends onDismiss.
    func leave(animated: Bool, in box: ZnPopupBox)
}

@MainActor final class ZnPopups {
    static let shared = ZnPopups()

    struct Key: Hashable, CustomStringConvertible {
        /// The screen's stack entry (or an app layer's root id) when it opened.
        let entry: UInt32
        let node: UInt32
        let index: Int
        var description: String { "\(entry)/\(node).\(index)" }
    }

    private final class Weak {
        weak var vc: UIViewController?
        init(_ vc: UIViewController) { self.vc = vc }
    }

    private final class Rec {
        let key: Key
        let layer: ZnPopupLayer
        /// The controllers the root presented when it opened (S5: only what came after them goes with it).
        let before: [Weak]
        init(_ key: Key, _ layer: ZnPopupLayer, _ before: [UIViewController]) {
            self.key = key
            self.layer = layer
            self.before = before.map(Weak.init)
        }
    }

    /// Open layers, bottom first (their z-order). A closing one is not in it (its leave animation may still run).
    private var live: [Rec] = []
    /// Entries whose layers closed at a nav step: no layer opens for them again (entry ids are never reused).
    private var left: Set<UInt32> = []
    private weak var root: UIViewController?
    private weak var box: ZnPopupBox?
    private weak var lastTop: UIView?

    /// ZnRootController.viewDidLoad: the container. A new root (ZnApp.restart) installs its own.
    func install(root: UIViewController, box: ZnPopupBox) {
        if !live.isEmpty { closeAll(why: "new root") }
        self.root = root
        self.box = box
    }

    /// Adds [layer] now (in the same update as its node, so a close that follows finds it). false: not opened (its
    /// screen has left, or there is no container).
    @discardableResult
    func open(_ layer: ZnPopupLayer, key: Key) -> Bool {
        if left.contains(key.entry) {
            print("zn t=\(ZnDebug.ms()) popups: \(key) not opened: its screen has left")
            return false
        }
        guard let root, let box else {
            print("zn popups: \(key) not opened: no layer container (ZN_IOS_NAV=swiftui has none)")
            return false
        }
        if let same = live.first(where: { $0.key == key }) { close(same.layer, animated: false, why: "the same node opened again") }
        live.append(Rec(key, layer, Self.chain(root)))
        layer.view.bounds = CGRect(origin: .zero, size: box.bounds.size)
        layer.view.center = CGPoint(x: box.bounds.midX, y: box.bounds.midY)
        layer.willAppear(in: box)
        root.addChild(layer)
        box.addSubview(layer.view)
        layer.didMove(toParent: root)
        print("zn t=\(ZnDebug.ms()) popups: open \(key) (\(live.count) open)")
        refreshAccessibility()
        DispatchQueue.main.async { [weak self, weak layer] in
            guard let self, let layer, self.live.contains(where: { $0.layer === layer }) else { return }
            layer.shown()
        }
        return true
    }

    /// Closes [layer] alone (what is over it stays). Nothing when it isn't open (already closed, or never opened).
    func close(_ layer: ZnPopupLayer, animated: Bool, why: String) {
        close(layer, animated: animated, why: why, s5: true)
    }

    private func close(_ layer: ZnPopupLayer, animated: Bool, why: String, s5: Bool) {
        guard let i = live.firstIndex(where: { $0.layer === layer }) else { return }
        let rec = live.remove(at: i)
        let wasTop = i == live.count
        print("zn t=\(ZnDebug.ms()) popups: close \(rec.key) (\(why))\(animated ? "" : ", no animation"), \(live.count) left open")
        if s5, wasTop { dismissPresented(since: rec) }
        if let box {
            layer.leave(animated: animated, in: box)
        } else {
            layer.willMove(toParent: nil)
            layer.view.removeFromSuperview()
            layer.removeFromParent()
        }
        refreshAccessibility()
    }

    /// The nav step: every layer of [entries] (screens that left the stack, an app layer replaced), top first, with
    /// no animation and no onDismiss.
    func closeEntries(_ entries: Set<UInt32>, why: String) {
        guard !entries.isEmpty else { return }
        left.formUnion(entries)
        for rec in live.reversed() where entries.contains(rec.key.entry) {
            close(rec.layer, animated: false, why: why, s5: true)
        }
    }

    /// The runtime is replaced (ZnApp.restart): every layer, no animation, nothing else dismissed. A new runtime
    /// numbers its instances from the start again: the remembered entries are forgotten.
    func closeAll(why: String) {
        for rec in live.reversed() { close(rec.layer, animated: false, why: why, s5: false) }
        left = []
    }

    /// ZnRootController.place(): each layer the box's size (bounds and center, so a Modal's slide transform stays).
    func layout() {
        guard let box else { return }
        let size = box.bounds.size, center = CGPoint(x: box.bounds.midX, y: box.bounds.midY)
        for v in box.subviews where v.bounds.size != size || v.center != center {
            v.bounds = CGRect(origin: .zero, size: size)
            v.center = center
        }
    }

    // MARK: -

    /// The controllers [root] presents now, bottom first.
    private static func chain(_ root: UIViewController) -> [UIViewController] {
        var all: [UIViewController] = []
        var p = root.presentedViewController
        while let q = p {
            all.append(q)
            p = q.presentedViewController
        }
        return all
    }

    /// S5: the top layer closes, so what was presented after it opened (an Alert, a share sheet, a store page) goes too.
    /// What was already up when it opened stays, and so does one still sliding in: JS started it in the same turn that
    /// closed the layer (`open.set(false); Alert.alert(...)`: the Alert comes first), and it is meant to show.
    private func dismissPresented(since rec: Rec) {
        guard let root else { return }
        let before = rec.before.compactMap(\.vc)
        guard let over = Self.chain(root).first(where: { c in !before.contains { $0 === c } }),
              !over.isBeingDismissed, let base = over.presentingViewController else { return }
        if over.isBeingPresented {
            return print("zn t=\(ZnDebug.ms()) popups: \(rec.key) leaves the \(type(of: over)) that is just opening (same turn)")
        }
        print("zn t=\(ZnDebug.ms()) popups: \(rec.key) closes the \(type(of: over)) presented over it")
        base.dismiss(animated: false)
    }

    private func refreshAccessibility() {
        guard let box else { return }
        box.accessibilityViewIsModal = !live.isEmpty
        for (i, rec) in live.enumerated() where rec.layer.isViewLoaded {
            rec.layer.view.accessibilityViewIsModal = i == live.count - 1
        }
        let top: UIView? = live.last?.layer.view
        if top !== lastTop {
            lastTop = top
            UIAccessibility.post(notification: .screenChanged, argument: top)
        }
    }
}

/// The layers' container, over the screens and the app layers: a touch goes through where no layer takes it.
final class ZnPopupBox: UIView {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let v = super.hitTest(point, with: event)
        return v === self ? nil : v
    }

    /// Takes [layer] out of the box and the root.
    func drop(_ layer: UIViewController) {
        layer.willMove(toParent: nil)
        layer.view.removeFromSuperview()
        layer.removeFromParent()
    }
}
