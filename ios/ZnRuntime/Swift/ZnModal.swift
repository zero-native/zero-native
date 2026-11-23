// React Native's <Modal> on iOS (registry 15), as android/runtime's ZnModal.kt: a full-screen layer over the app (in
// ZnPopups' box, over the screens and any Sheet or Modal opened before it; not presented, so closing it, or one under
// it, closes that one alone: finding 20, 2026-11-18), in which the app draws its own content, laid out like a Column
// that fills it (`flex: 1`, `justifyContent: "center"`).
// - Controlled by JS: shown while `visible` is true (true when not written); native never closes it.
// - `transparent`: the screen shows through where the content draws nothing (else white). `animationType`: "none"
//   (default), "fade", "slide" (up from the bottom), 250 ms as RN on Android.
// - The content stays clear of the status bar and the home indicator unless `statusBarTranslucent` /
//   `navigationBarTranslucent`; above the keyboard always (SwiftUI's keyboard safe area). The status bar keeps the
//   app's style.
// - `onShow` once it is on screen (after its animation).
// iOS difference: there is no system Back, and a full-screen presentation has no swipe to close, so `onRequestClose`
// is never sent (as in RN on iOS for full-screen modals); the app closes it with its own button.
import SwiftUI
import UIKit

struct ZnModalHost: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec

    var body: some View {
        let visible = s.visibleSlot >= 0 ? inst.slot(s.visibleSlot).value == .bool(true) : (s.hasVisible ? s.visible : true)
        ZnModalPresenter(ctx: ctx, t: t, inst: inst, s: s, visible: visible)
            .frame(width: 0, height: 0)
    }
}

/// The Modal's own content, filling the layer.
struct ZnModalContent: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    /// The screen's environment, which the layer's hosting controller doesn't get (its own SwiftUI tree): the entry
    /// (impressions inside count under the screen, as Android's), a hidden tab, pointerEvents "none" around it.
    let env: ZnHostedEnvBox

    var body: some View {
        var free: Edge.Set = []
        if s.statusBarTranslucent { free.insert(.top) }
        if s.navigationBarTranslucent { free.insert(.bottom) }
        return ZnHostedEnvView(box: env) {
            ZnNodeView(ctx: ctx, t: t, inst: inst, n: s.index, outer: ZnOuter(fillWidth: true, fillHeight: true),
                       definiteWidth: true, sheetBody: true)
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .ignoresSafeArea(.container, edges: free)
            .background((s.transparent ? Color.clear : Color.white).ignoresSafeArea())
    }
}

struct ZnModalPresenter: UIViewControllerRepresentable {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    let visible: Bool

    static let duration = 0.25

    @MainActor final class Coordinator {
        var layer: ZnModalLayer?
        let env = ZnHostedEnvBox()
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }

    func updateUIViewController(_ host: UIViewController, context: Context) {
        let c = context.coordinator
        let anim = s.animationType
        // The screen's environment, for the layer's own SwiftUI tree (a new value redraws what reads it).
        var env = ZnHostedEnv(context.environment)
        env.gestureDepth = 0  // the layer's gestures have their own hub
        if c.env.env != env { c.env.env = env }
        if visible, c.layer == nil {
            let layer = ZnModalLayer(rootView: ZnModalContent(ctx: ctx, t: t, inst: inst, s: s, env: c.env))
            layer.view.backgroundColor = .clear
            layer.anim = anim
            let (ctx, id, onShow) = (ctx, inst.id, s.onShow)
            layer.onShown = { if onShow != 0 { ctx.send(id, onShow, .none) } }
            c.layer = layer
            print("zn t=\(ZnDebug.ms()) modal: open (\(anim == Registry.AnimationType.fade ? "fade" : anim == Registry.AnimationType.slide ? "slide" : "no animation"))")
            ZnPopups.shared.open(layer, key: ZnPopups.Key(entry: znScreenEntry(inst), node: inst.id, index: s.index))
        } else if !visible, let layer = c.layer {
            c.layer = nil
            print("zn t=\(ZnDebug.ms()) modal: close")
            // Its fade or slide, as before (also in a batch that changes the stack); none while the runtime is replaced.
            ZnPopups.shared.close(layer, animated: !ZnApp.shared.restarting, why: "JS set visible false")
        }
    }

    static func dismantleUIViewController(_ host: UIViewController, coordinator: Coordinator) {
        // The Modal left the screen (its node removed, the error screen): the layer goes with it, at once. A screen
        // that left the stack closed it at the nav step already (then this finds nothing).
        if let layer = coordinator.layer { ZnPopups.shared.close(layer, animated: false, why: "its node left the screen") }
        coordinator.layer = nil
    }
}

/// A Modal's layer in ZnPopups' box: the hosting controller itself, faded or slid in and out.
final class ZnModalLayer: UIHostingController<ZnModalContent>, ZnPopupLayer {
    var anim = 0
    /// onShow, once it is on screen (after its animation).
    var onShown: () -> Void = {}

    func willAppear(in box: ZnPopupBox) {
        switch anim {
        case Registry.AnimationType.fade: view.alpha = 0
        case Registry.AnimationType.slide: view.transform = CGAffineTransform(translationX: 0, y: box.bounds.height)
        default: break
        }
    }

    func shown() {
        switch anim {
        case Registry.AnimationType.fade:
            UIView.animate(withDuration: ZnModalPresenter.duration, animations: { self.view.alpha = 1 }) { _ in self.onShown() }
        case Registry.AnimationType.slide:
            UIView.animate(withDuration: ZnModalPresenter.duration, animations: { self.view.transform = .identity }) { _ in self.onShown() }
        default:
            onShown()
        }
    }

    func leave(animated: Bool, in box: ZnPopupBox) {
        // From now on the next tap goes below, also during the fade or slide (2026-11-12).
        view.isUserInteractionEnabled = false
        view.accessibilityElementsHidden = true
        let gone = { [weak self, weak box] in
            guard let self, let box else { return }
            box.drop(self)
        }
        switch animated ? anim : -1 {
        case Registry.AnimationType.fade:
            UIView.animate(withDuration: ZnModalPresenter.duration, animations: { self.view.alpha = 0 }) { _ in gone() }
        case Registry.AnimationType.slide:
            UIView.animate(withDuration: ZnModalPresenter.duration, animations: {
                self.view.transform = CGAffineTransform(translationX: 0, y: self.view.bounds.height)
            }) { _ in gone() }
        default:
            gone()
        }
    }
}
