// <Scroll> (ZnRenderer.kt's SCROLL): a SwiftUI ScrollView around the node's Column / Row. Its own file, so the scroll
// work (commands, events, snapping, keyboard dismiss) changes this file and not the renderer.
import SwiftUI

/// The padding scrolls with the content (Android: the scroll's content padding), so nothing is clipped at the edges
/// and the last item can scroll clear of a floating button.
/// A vertical Scroll with no height that doesn't fill (no flex, no stretch) is as tall as its content, up to what it is
/// offered (its maxHeight, the space left): Compose's verticalScroll Column. A SwiftUI ScrollView takes all it is
/// offered, so ZeroBill's checkout offers sheet (`maxHeight: 400`, one or two rows) was 400 tall with an empty band
/// (2026-11-09).
struct ZnScrollView<Content: View>: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let outer: ZnOuter
    /// The scroll's padding and refreshing now. Read by the node's body (ZnNodeView) as before this view had its own
    /// file, so a change of their slots runs the same bodies.
    let padding: EdgeInsets
    let refreshing: Bool
    /// The node's Column (vertical) or Row (horizontal), built by ZnNodeView.
    let content: Content

    init(ctx: ZnContext, s: ZnNodeSpec, inst: ZnInstance, outer: ZnOuter, padding: EdgeInsets, refreshing: Bool,
         @ViewBuilder content: () -> Content) {
        self.ctx = ctx
        self.s = s
        self.inst = inst
        self.outer = outer
        self.padding = padding
        self.refreshing = refreshing
        self.content = content()
    }

    var body: some View {
        let hug = !s.horizontal && !s.hasHeight && !outer.fillHeight
        ZnScrollHugLayout(hug: hug) {
            ScrollView(s.horizontal ? .horizontal : .vertical) {
                content
                    .padding(padding)
                    .background {
                        // Pull to refresh (ZnTabsRefresh.swift): finds this scroll view from inside it.
                        if s.hasRefresh && !s.horizontal {
                            ZnScrollRefresh(ctx: ctx, s: s, inst: inst, refreshing: refreshing)
                        }
                    }
            }
        }
    }
}

/// A vertical Scroll that hugs its content (see ZnScrollView): a ScrollView's ideal height (asked with no height) is its
/// content's, so the Scroll takes that, up to the height it is offered. Without hug it is the ScrollView as it is.
struct ZnScrollHugLayout: Layout {
    var hug: Bool

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        guard hug else { return child.sizeThatFits(proposal) }
        let ideal = child.sizeThatFits(ProposedViewSize(width: proposal.width, height: nil))
        var h = ideal.height
        if let p = proposal.height, p.isFinite { h = min(h, p) }
        let w = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? ideal.width
        return CGSize(width: w, height: h)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
    }
}
