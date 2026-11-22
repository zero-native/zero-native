// <Carousel> on iOS, as android/runtime's ZnRenderer.kt ZnCarousel (Compose's HorizontalPager): one page per child
// (all built, not lazily: carousels are short),
// as wide as the carousel (minus its horizontal padding), `itemWidth`, or `itemWidth="80%"` (itemWidthPercent: of the
// width inside the padding, the gap not taken off, as Android's PageSize), `gap` apart, snapping page by page. The
// node's padding is the pager's content padding (inside the scroll), not padding around it.
// - Pages narrower than the carousel: the last one can't reach the leading edge (the scroll stops at its end), so at
//   the end of the scroll the last page is the one shown (its dot, onPageChange), as Compose's pager.
// - No height (none set, no flex): as tall as the tallest page, the dots 10 pt under it.
// - A height (set, or flex): pages get all of it but the dots, so a page's flex / justifyContent work and the dots sit
//   at the bottom (R35).
// - `dots`: a 20 × 6 pill for the page shown, 6 × 6 dots for the rest. `autoAdvance` ms: the next page (wrapping),
//   not while dragging and not for `pauseAfterTouch` ms (3000 by default) after a touch. `onPageChange` (index) when
//   a new page settles; not for the first.
// - motion={m} (useElementMotion): m.page is the page as a number (2.5: half way from page 2 to 3), from the scroll view
//   (ZnScrollDriver's watch, found by ZnScrollFinder); m.follow(v) moves the pages to page v at once, with no animation.
import SwiftUI
import UIKit

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
    /// The scroll is at its end with pages narrower than the carousel: the last page is the one shown.
    @State private var atEnd = false
    /// useElementMotion: the scroll view, and the page from it.
    @StateObject private var scroll = ZnScrollDriver()
    @State private var values = ZnCarouselElement()
    /// The page (rounded) m.follow(v) last moved to, while it follows.
    @State private var followed: Int?

    var body: some View {
        let refs = znShownRefs(ctx, t, inst, s.children)
        let pad = s.paddingInsets(inst)
        let fill = s.hasHeight || s.flexNow(inst) > 0
        // The page m.follow(v) moved to: SwiftUI's scroll position doesn't hear a contentOffset set from code.
        let shown = followed ?? (atEnd && refs.count > 1 ? refs.count - 1 : (page ?? settled))
        let element = s.elementNow(inst)
        let follow = element?.follow.source
        let _ = values.onFollowed = { p in if followed != p { followed = p } }
        VStack(spacing: 0) {
            GeometryReader { g in
                let pageWidth = znCarouselPageWidth(width: g.size.width, padding: pad.leading + pad.trailing,
                                                    itemWidth: s.itemWidth, percent: s.itemWidthPercent)
                let viewW = g.size.width
                let _ = values.bind(pageWidth: pageWidth, gap: s.gapNow(inst), count: refs.count)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: s.gapNow(inst)) {
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
                    // A clear hit shape over the pages: backgrounds and plain Texts take no taps (as on Android), so a
                    // page with no Pressable left nothing for the touch gesture below, and autoAdvance didn't pause.
                    .contentShape(Rectangle())
                    .background { if element != nil { ZnScrollFinder(driver: scroll) } }
                    // Where the pages' row is in the scroll view: its end at the scroll's end means the last page.
                    .onGeometryChange(for: Bool.self) { p in
                        let f = p.frame(in: .named(Self.space))
                        return f.width + pad.leading + pad.trailing > viewW + 1 && f.maxX <= viewW - pad.trailing + 1
                    } action: { atEnd = $0 }
                    .scrollTargetLayout()
                    .padding(.top, pad.top)
                    .padding(.bottom, pad.bottom)
                }
                .contentMargins(.leading, pad.leading, for: .scrollContent)
                .contentMargins(.trailing, pad.trailing, for: .scrollContent)
                .scrollTargetBehavior(.viewAligned)
                .scrollPosition(id: $page)
                .coordinateSpace(.named(Self.space))
                .simultaneousGesture(DragGesture(minimumDistance: 0).onChanged { _ in lastTouch = Date() })
            }
            // A GeometryReader has no height of its own: with a height it takes what the dots leave; without one, the
            // tallest page's.
            .frame(height: fill ? nil : (heights.values.max() ?? 0) + pad.top + pad.bottom)
            .frame(maxHeight: fill ? .infinity : nil)
            if s.dots && refs.count > 1 {
                HStack(spacing: 6) {
                    ForEach(0..<refs.count, id: \.self) { i in
                        let active = shown == i
                        RoundedRectangle(cornerRadius: 3)
                            .fill(active ? s.activeDotColor : s.dotColor)
                            .frame(width: active ? 20 : 6, height: 6)
                    }
                }
                .padding(.top, 10)
                .animation(.easeOut(duration: 0.2), value: shown)
            }
        }
        .onChange(of: element.map(ObjectIdentifier.init), initial: true) { values.set(element, scroll) }
        .onChange(of: follow.map(ObjectIdentifier.init), initial: true) {
            values.follower.set(element == nil ? nil : follow)
            // Follow stopped: SwiftUI's position takes the page it left (already there, so nothing moves).
            if follow == nil, let f = followed {
                page = f
                followed = nil
            }
        }
        .onAppear {  // back on screen: its reader and follow again
            values.set(element, scroll)
            values.follower.set(element == nil ? nil : follow)
        }
        .onDisappear { values.set(nil, scroll) }
        .onChange(of: shown) { _, p in
            guard p != settled else { return }
            settled = p
            if s.onPageChange != 0 { ctx.send(inst.id, s.onPageChange, .number(Double(p))) }
        }
        .task(id: refs.count) {
            guard s.autoAdvanceMs > 0, refs.count > 1 else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(s.autoAdvanceMs))
                if Date().timeIntervalSince(lastTouch) * 1000 < s.pauseAfterTouchMs { continue }
                // From the state now (this closure was made when the task started).
                let now = atEnd && refs.count > 1 ? refs.count - 1 : (page ?? settled)
                let next = (now + 1) % refs.count
                withAnimation(.easeInOut(duration: 0.35)) { page = next }
            }
        }
    }

    private static let space = "znCarousel"
}

/// A Carousel's useElementMotion values: `page` from its scroll view, and m.follow(v) by page.
@MainActor
final class ZnCarouselElement {
    let follower = ZnFollower()
    /// Told the page (rounded) each time m.follow(v) moves the pages, for the dots and onPageChange.
    var onFollowed: (Int) -> Void = { _ in }
    private var element: ZnElementMotion?
    private weak var sv: UIScrollView?
    private var pageWidth: CGFloat = 0, gap: CGFloat = 0, count = 0
    private let page = ZnCell(0)

    /// The pages' width, gap and count now (each body run).
    func bind(pageWidth: CGFloat, gap: CGFloat, count: Int) {
        self.pageWidth = pageWidth
        self.gap = gap
        self.count = count
    }

    func set(_ e: ZnElementMotion?, _ driver: ZnScrollDriver) {
        guard e !== element else { return }
        if let old = element { ZnProvided.release(old.lambda("page"), by: self) }
        element = e
        if let e {
            let page = page
            ZnProvided.provide(e.lambda("page"), by: self) { page.v }
            driver.onScroll = { [weak self] sv in self?.scrolled(sv) }
            follower.apply = { [weak self] v in self?.followTo(v) }
        } else {
            driver.onScroll = nil
            follower.set(nil)
        }
    }

    /// The offset from the first page's place (contentMargins are the scroll view's inset).
    private func scrolled(_ sv: UIScrollView) {
        self.sv = sv
        let offset = sv.contentOffset.x + sv.adjustedContentInset.left
        page.write(Float(ZnElementRules.carouselPage(offset: offset, pageWidth: pageWidth, gap: gap, count: count)))
    }

    private func followTo(_ v: Float) {
        guard let sv else { return }
        let i = sv.adjustedContentInset
        let maxOffset = sv.contentSize.width + i.left + i.right - sv.bounds.width
        guard let to = ZnElementRules.carouselFollow(Double(v), pageWidth: pageWidth, gap: gap, count: count, maxOffset: maxOffset),
              abs(to - (sv.contentOffset.x + i.left)) > 0.25 else { return }
        sv.setContentOffset(CGPoint(x: to - i.left, y: sv.contentOffset.y), animated: false)
        let p = ZnElementRules.carouselPage(offset: to, pageWidth: pageWidth, gap: gap, count: count)
        onFollowed(Int(p.rounded()))
    }
}
