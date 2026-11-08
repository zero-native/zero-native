// <Carousel> on iOS, as android/runtime's ZnRenderer.kt ZnCarousel (Compose's HorizontalPager): one page per child
// (all built, not lazily: carousels are short),
// as wide as the carousel (minus its horizontal padding) or `itemWidth`, `gap` apart, snapping page by page. The
// node's padding is the pager's content padding (inside the scroll), not padding around it.
// - No height (none set, no flex): as tall as the tallest page, the dots 10 pt under it.
// - A height (set, or flex): pages get all of it but the dots, so a page's flex / justifyContent work and the dots sit
//   at the bottom (R35).
// - `dots`: a 20 × 6 pill for the page shown, 6 × 6 dots for the rest. `autoAdvance` ms: the next page (wrapping),
//   not while dragging and not for `pauseAfterTouch` ms (3000 by default) after a touch. `onPageChange` (index) when
//   a new page settles; not for the first.
import SwiftUI

struct ZnCarouselView: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec

    @State private var page: Int? = 0
    @State private var settled = 0
    @State private var lastTouch = Date.distantPast
    /// Each page's own height (no-height carousels are as tall as the tallest).
    @State private var heights: [Int: CGFloat] = [:]

    var body: some View {
        let refs = znChildRefs(ctx, t, inst, s.children)
        let pad = s.paddingInsets(inst)
        let fill = s.height != nil || s.flex > 0
        VStack(spacing: 0) {
            GeometryReader { g in
                let pageWidth = s.itemWidth ?? max(g.size.width - pad.leading - pad.trailing, 0)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: s.gap) {
                        ForEach(Array(refs.enumerated()), id: \.element.id) { i, ref in
                            ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node,
                                       outer: ZnOuter(fillWidth: true, fillHeight: fill), definiteWidth: true)
                                .frame(width: pageWidth)
                                .fixedSize(horizontal: false, vertical: !fill)
                                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { heights[i] = $0 }
                                .frame(maxHeight: fill ? .infinity : nil, alignment: .top)
                                .id(i)
                        }
                    }
                    .scrollTargetLayout()
                    .padding(.top, pad.top)
                    .padding(.bottom, pad.bottom)
                }
                .contentMargins(.leading, pad.leading, for: .scrollContent)
                .contentMargins(.trailing, pad.trailing, for: .scrollContent)
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: $page)
                .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in lastTouch = Date() })
            }
            // A GeometryReader has no height of its own: with a height it takes what the dots leave; without one, the
            // tallest page's.
            .frame(height: fill ? nil : (heights.values.max() ?? 0) + pad.top + pad.bottom)
            .frame(maxHeight: fill ? .infinity : nil)
            if s.dots && refs.count > 1 {
                HStack(spacing: 6) {
                    ForEach(0..<refs.count, id: \.self) { i in
                        let active = (page ?? settled) == i
                        RoundedRectangle(cornerRadius: 3)
                            .fill(active ? s.activeDotColor : s.dotColor)
                            .frame(width: active ? 20 : 6, height: 6)
                    }
                }
                .padding(.top, 10)
                .animation(.easeOut(duration: 0.2), value: page)
            }
        }
        .onChange(of: page) { _, p in
            guard let p, p != settled else { return }
            settled = p
            if s.onPageChange != 0 { ctx.send(inst.id, s.onPageChange, .number(Double(p))) }
        }
        .task(id: refs.count) {
            guard s.autoAdvanceMs > 0, refs.count > 1 else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(s.autoAdvanceMs))
                if Date().timeIntervalSince(lastTouch) * 1000 < s.pauseAfterTouchMs { continue }
                withAnimation(.easeInOut(duration: 0.35)) { page = ((page ?? 0) + 1) % refs.count }
            }
        }
    }
}
