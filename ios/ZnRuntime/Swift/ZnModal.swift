// React Native's <Modal> on iOS (registry 15), as android/runtime's ZnModal.kt: a full-screen layer over the app (a
// view controller presented over full screen, from the frontmost one, so it also opens over a sheet), in which the
// app draws its own content, laid out like a Column that fills it (`flex: 1`, `justifyContent: "center"`).
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

    var body: some View {
        var free: Edge.Set = []
        if s.statusBarTranslucent { free.insert(.top) }
        if s.navigationBarTranslucent { free.insert(.bottom) }
        return ZnNodeView(ctx: ctx, t: t, inst: inst, n: s.index, outer: ZnOuter(fillWidth: true, fillHeight: true),
                          definiteWidth: true, sheetBody: true)
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

    final class Coordinator {
        var layer: UIViewController?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }

    func updateUIViewController(_ host: UIViewController, context: Context) {
        let c = context.coordinator
        let anim = s.animationType
        if visible, c.layer == nil {
            let layer = UIHostingController(rootView: ZnModalContent(ctx: ctx, t: t, inst: inst, s: s))
            layer.view.backgroundColor = .clear
            layer.modalPresentationStyle = .overFullScreen
            c.layer = layer
            guard let top = znTopController() else { return }
            print("zn t=\(ZnDebug.ms()) modal: open (\(anim == Registry.AnimationType.fade ? "fade" : anim == Registry.AnimationType.slide ? "slide" : "no animation"))")
            let (ctx, id, onShow) = (ctx, inst.id, s.onShow)
            let shown = { if onShow != 0 { ctx.send(id, onShow, .none) } }
            top.present(layer, animated: false) {
                guard let v = layer.view else { return }
                switch anim {
                case Registry.AnimationType.fade:
                    v.alpha = 0
                    UIView.animate(withDuration: Self.duration, animations: { v.alpha = 1 }) { _ in shown() }
                case Registry.AnimationType.slide:
                    v.transform = CGAffineTransform(translationX: 0, y: v.bounds.height)
                    UIView.animate(withDuration: Self.duration, animations: { v.transform = .identity }) { _ in shown() }
                default:
                    shown()
                }
            }
        } else if !visible, let layer = c.layer {
            c.layer = nil
            print("zn t=\(ZnDebug.ms()) modal: close")
            Self.close(layer, anim)
        }
    }

    static func dismantleUIViewController(_ host: UIViewController, coordinator: Coordinator) {
        // The Modal left the screen (its screen closed, or JS removed it): the layer goes with it.
        if let layer = coordinator.layer { close(layer, -1) }
        coordinator.layer = nil
    }

    private static func close(_ layer: UIViewController, _ anim: Int) {
        guard let v = layer.viewIfLoaded else { return layer.dismiss(animated: false) }
        v.isUserInteractionEnabled = false
        // UIKit's container (UITransitionView) stays over the screen until the fade or slide ends and took the next
        // tap (2026-11-12): it takes none from now, so the screen below gets it at once (Android: ZnModal.kt).
        layer.presentationController?.containerView?.isUserInteractionEnabled = false
        v.superview?.isUserInteractionEnabled = false
        let gone = { layer.presentingViewController?.dismiss(animated: false) ?? layer.dismiss(animated: false) }
        switch anim {
        case Registry.AnimationType.fade:
            UIView.animate(withDuration: duration, animations: { v.alpha = 0 }) { _ in gone() }
        case Registry.AnimationType.slide:
            UIView.animate(withDuration: duration, animations: { v.transform = CGAffineTransform(translationX: 0, y: v.bounds.height) }) { _ in gone() }
        default:
            gone()
        }
    }
}
