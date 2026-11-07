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

    var body: some View {
        ZnNodeView(ctx: ctx, t: t, inst: inst, n: s.index, outer: ZnOuter(fillWidth: true), definiteWidth: true,
                   sheetBody: true)
            .padding(.top, 20)  // room for the grabber
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
            let content = UIHostingController(rootView: ZnSheetContent(ctx: ctx, t: t, inst: inst, s: s))
            content.view.backgroundColor = .white
            content.presentationController?.delegate = c
            if let sheet = content.sheetPresentationController {
                sheet.detents = s.detents.map { d -> UISheetPresentationController.Detent in
                    switch d {
                    case "half": return .medium()
                    case "full": return .large()
                    default:
                        // "content": the content's height at the sheet's width.
                        return .custom(identifier: .init("content")) { [weak content] dc in
                            guard let content else { return nil }
                            let width = content.view.window?.bounds.width ?? UIScreen.main.bounds.width
                            let h = content.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude)).height
                            return min(h, dc.maximumDetentValue)
                        }
                    }
                }
                sheet.prefersGrabberVisible = true
            }
            c.sheet = content
            print("zn t=\(ZnDebug.ms()) sheet: present")
            host.present(content, animated: true)
        } else if !visible, let sheet = c.sheet {
            c.sheet = nil
            print("zn t=\(ZnDebug.ms()) sheet: dismiss (JS set visible false)")
            sheet.dismiss(animated: true)
        }
    }

    final class Coordinator: NSObject, UIAdaptivePresentationControllerDelegate {
        var sheet: UIViewController?
        var onAttempt: () -> Void = {}

        // JS decides: the sheet never closes by itself.
        func presentationControllerShouldDismiss(_ pc: UIPresentationController) -> Bool { false }

        func presentationControllerDidAttemptToDismiss(_ pc: UIPresentationController) {
            print("zn t=\(ZnDebug.ms()) sheet: drag-down → onDismiss to JS")
            onAttempt()
        }
    }
}
