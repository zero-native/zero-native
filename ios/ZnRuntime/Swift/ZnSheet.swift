// <Sheet> on iOS, both ways (i.1c). Contract, as android/runtime's ZnSheet.kt: `visible` is a JS slot and native never
// writes it; a drag-down (or a tap outside) sends onDismiss, and JS decides: visible false → the sheet goes, true →
// it stays. Detents "content" (its content's height), "half", "full"; the first is where it opens.
//
// UIKit variant: UISheetPresentationController. presentationControllerShouldDismiss answers false and
// didAttemptToDismiss sends onDismiss, so JS decides, exactly as on Android; JS then sets visible false and we dismiss.
// SwiftUI variant: .sheet(isPresented:) + presentationDetents. SwiftUI has no "attempted to dismiss" callback: the
// sheet is already gone when the binding's setter tells us, so JS can't keep it (it would come back up).
import SwiftUI
import UIKit

struct ZnSheetHost: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec

    var body: some View {
        let visible = s.visibleSlot >= 0 ? inst.slot(s.visibleSlot).value == .bool(true) : s.visible
        switch ZnImpl.sheet {
        case .swiftUI:
            Color.clear.frame(width: 0, height: 0)
                .sheet(isPresented: Binding(get: { visible }, set: { shown in
                    if !shown, s.onDismiss != 0 { ctx.send(inst.id, s.onDismiss, .none) }
                })) {
                    ZnSheetSwiftUIBody(ctx: ctx, t: t, inst: inst, s: s)
                }
        case .uiKit:
            ZnSheetPresenter(ctx: ctx, t: t, inst: inst, s: s, visible: visible)
                .frame(width: 0, height: 0)
        }
    }
}

/// The sheet's own content: the Sheet node drawn as a Column (its style: padding, gap), full width.
struct ZnSheetContent: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    /// UIKit variant: its height whenever it changes, so the "content" detent follows the content (text set after the
    /// sheet opened, a row added).
    var onHeight: ((CGFloat) -> Void)? = nil

    var body: some View {
        let body = ZnNodeView(ctx: ctx, t: t, inst: inst, n: s.index, outer: ZnOuter(fillWidth: true), definiteWidth: true,
                              sheetBody: true)
            .padding(.top, 20)  // room for the grabber
        if let onHeight {
            body.fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight($0) }
        } else {
            body
        }
    }
}

// MARK: - SwiftUI

struct ZnSheetSwiftUIBody: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    @State private var height: CGFloat = 300

    var body: some View {
        ZnSheetContent(ctx: ctx, t: t, inst: inst, s: s)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            .presentationDetents(Set(s.detents.map { d -> PresentationDetent in
                switch d {
                case "half": return .medium
                case "full": return .large
                default: return .height(height)
                }
            }))
            .presentationDragIndicator(.visible)
            .interactiveDismissDisabled(!s.dismissible)
    }
}

// MARK: - UIKit

struct ZnSheetPresenter: UIViewControllerRepresentable {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    let visible: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }

    func updateUIViewController(_ host: UIViewController, context: Context) {
        let c = context.coordinator
        c.onAttempt = { [ctx, inst, s] in if s.dismissible, s.onDismiss != 0 { ctx.send(inst.id, s.onDismiss, .none) } }
        if visible, c.sheet == nil {
            c.height = 0
            let content = UIHostingController(rootView: ZnSheetContent(ctx: ctx, t: t, inst: inst, s: s) { [weak c] h in
                c?.contentHeight(h)
            })
            content.view.backgroundColor = .white
            content.presentationController?.delegate = c
            if let sheet = content.sheetPresentationController {
                sheet.detents = s.detents.map { d -> UISheetPresentationController.Detent in
                    switch d {
                    case "half": return .medium()
                    case "full": return .large()
                    default:
                        // "content": the content's height at the sheet's width. It was worked out once, when the
                        // sheet opened: content that changed later (ZeroBill's scanner sheets get their title and text
                        // after they open) left the sheet too tall or too short (2026-11-09). The content now reports
                        // its height (onHeight) and the detent follows it.
                        return .custom(identifier: .init("content")) { [weak content, weak c] dc in
                            guard let content else { return nil }
                            if let h = c?.height, h > 0 { return min(h, dc.maximumDetentValue) }
                            let width = content.view.window?.bounds.width ?? UIScreen.main.bounds.width
                            // Before the content has reported its height (the first open). A detent is the height
                            // above the bottom safe area (UIKit adds that area); once the sheet is on screen,
                            // sizeThatFits counts the area too (346.67 → 380.67 on an iPhone 16), so it is taken off.
                            let fit = content.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
                            let h = fit - content.view.safeAreaInsets.bottom
                            return min(h, dc.maximumDetentValue)
                        }
                    }
                }
                sheet.prefersGrabberVisible = true
            }
            c.sheet = content
            // animateIn={false}: already at rest, no slide-up or dimming fade (a sheet that is part of a restored
            // screen). Read now, when it opens; later opens read it again.
            let animated = s.animateInSlot >= 0 ? inst.slot(s.animateInSlot).value != .bool(false) : s.animateIn
            c.present(content, from: host, animated: animated)
        } else if !visible, let sheet = c.sheet {
            c.sheet = nil
            // In the same batch as a stack change (pick an app → receipt), close at once: UIKit would otherwise wait
            // for the sheet's animation before starting the navigation transition (2026-11-08, ~0.5 s).
            let animated = !ZnApp.shared.batchChangesStack
            // UIKit drops a dismiss sent while the sheet is still sliding in: the sheet stayed up over the next screen
            // (ZeroBill's "Processing Secure Payment" closed 231 ms after it opened, on an iPhone, 2026-11-09). The
            // present's completion closes it instead.
            if c.opening === sheet {
                print("zn t=\(ZnDebug.ms()) sheet: dismiss (JS set visible false) while it opens: closes when it has opened")
                return
            }
            print("zn t=\(ZnDebug.ms()) sheet: dismiss (JS set visible false\(animated ? "" : ", with a stack change: no animation"))")
            sheet.dismiss(animated: animated)
        }
    }

    final class Coordinator: NSObject, UIAdaptivePresentationControllerDelegate {
        var sheet: UIViewController?
        /// The sheet UIKit is presenting now (its slide-in not finished).
        var opening: UIViewController?
        /// The content's own height (ZnSheetContent.onHeight); the "content" detent is this.
        var height: CGFloat = 0

        func contentHeight(_ h: CGFloat) {
            guard abs(h - height) > 0.5 else { return }
            let first = height == 0
            height = h
            guard !first, let sheet = sheet?.sheetPresentationController else { return }
            print("zn t=\(ZnDebug.ms()) sheet: content now \(Int(h)) pt tall: resize")
            sheet.animateChanges { sheet.invalidateDetents() }
        }
        var onAttempt: () -> Void = {}

        /// Presents [content] once [host] is in the window. A sheet visible on its screen's first frame (a restored
        /// payment, animateIn false) gets here before SwiftUI has put the host in the window, and UIKit ignores a
        /// present from a view that isn't there ("not in the window hierarchy"): try again each frame, up to ~2 s.
        func present(_ content: UIViewController, from host: UIViewController, animated: Bool, tries: Int = 0) {
            guard sheet === content else { return }  // closed (visible false) before it could open
            guard host.view.window != nil else {
                if tries >= 120 { return print("zn sheet: its screen never reached the window; not shown") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { [weak self, weak host] in
                    guard let self, let host else { return }
                    self.present(content, from: host, animated: animated, tries: tries + 1)
                }
                return
            }
            let wait = tries > 0 ? " after \(tries) frame(s) for its screen" : ""
            print("zn t=\(ZnDebug.ms()) sheet: present\(animated ? "" : " (animateIn false: at rest)")\(wait)")
            opening = content
            host.present(content, animated: animated) { [weak self, weak content] in
                guard let self, let content else { return }
                if self.opening === content { self.opening = nil }
                // visible went false while it slid in.
                if self.sheet !== content {
                    print("zn t=\(ZnDebug.ms()) sheet: opened after JS closed it: dismiss now")
                    content.dismiss(animated: !ZnApp.shared.batchChangesStack)
                }
            }
        }

        // JS decides: the sheet never closes by itself.
        func presentationControllerShouldDismiss(_ pc: UIPresentationController) -> Bool { false }

        func presentationControllerDidAttemptToDismiss(_ pc: UIPresentationController) {
            print("zn t=\(ZnDebug.ms()) sheet: drag-down → onDismiss to JS")
            onAttempt()
        }
    }
}
