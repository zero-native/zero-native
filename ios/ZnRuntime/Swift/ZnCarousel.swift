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
//   While it follows, the dots, onPageChange and autoAdvance go by where the pages are (moved by the follow or by the
//   user), as Android's pager's currentPage: SwiftUI's scroll position doesn't hear an offset set from code.
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
    /// The page (rounded) the pages are at while m.follow(v) is set (moved by it or by the user).
    @State private var followed: Int?
    /// The Pressables around it: inside one, its pages take the swipe from them (ZnPressInner.swift).
    @Environment(\.znPressAncestors) private var pressAncestors
    @Environment(\.znTouchOff) private var touchOff

    var body: some View {
        let refs = znShownRefs(ctx, t, inst, s.children)
        let pad = s.paddingInsets(inst)
        let fill = s.hasHeight || s.flexNow(inst) > 0
        // While it follows: where the pages are (SwiftUI's scroll position doesn't hear a contentOffset set from code).
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
                    .background { ZnTouchWatchProbe { lastTouch = Date() } }
                    .background { if !pressAncestors.isEmpty { ZnInnerScrollMark(ancestors: touchOff ? [] : pressAncestors) } }
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
                // 10 pt over the dots and none under them, as Android's Row(padding(top = 10.dp)): in a carousel with a
                // height the dots touch its bottom edge on both (checked 2026-11-24: 30 px / 18 px / 0 px at 3x). An
                // iPhone 11 (2x) measured to the dots' middle gives the same: 20 + 6 = 26 px over it, 6 px under it.
                .padding(.top, 10)
                .animation(.easeOut(duration: 0.2), value: shown)
            }
        }
        .onChange(of: element.map(ObjectIdentifier.init), initial: true) { values.set(element, scroll) }
        .onChange(of: follow.map(ObjectIdentifier.init), initial: true) {
            values.follow(element == nil ? nil : follow)
            // Follow stopped: SwiftUI's position takes the page it left (already there, so nothing moves).
            if follow == nil, let f = followed {
                page = f
                followed = nil
            }
        }
        .onAppear {  // back on screen: its reader and follow again
            values.set(element, scroll)
            values.follow(element == nil ? nil : follow)
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
                if let f = followed {
                    // Following: SwiftUI's position is stale (setting it to the page it still holds moves nothing).
                    values.go(to: (f + 1) % refs.count)
                    continue
                }
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
    /// Told the page (rounded) the pages are at while a follow is set, each time they move (by the follow or the user),
    /// for the dots, onPageChange and autoAdvance.
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
            follower.apply = { [weak self] v in self?.followTo(v) ?? false }
        } else {
            driver.onScroll = nil
            follower.set(nil)
        }
        reported = nil
    }

    /// The value to follow now (nil stops).
    func follow(_ src: ZnSource?) {
        if follower.following != (src != nil) { reported = nil }
        follower.set(src)
    }

    /// The offset from the first page's place (contentMargins are the scroll view's inset). Also when the scroll view
    /// is found or its content gets its size: a follow that came first applies then.
    private func scrolled(_ sv: UIScrollView) {
        self.sv = sv
        let offset = sv.contentOffset.x + sv.adjustedContentInset.left
        let p = ZnElementRules.carouselPage(offset: offset, pageWidth: pageWidth, gap: gap, count: count)
        page.write(Float(p))
        if follower.following {
            report(Int(p.rounded()))
            follower.check()
        }
    }

    /// The page the pages are at, to the view's state after this turn (the offset may move inside SwiftUI's update).
    private var reported: Int?
    private func report(_ p: Int) {
        guard p != reported else { return }
        reported = p
        DispatchQueue.main.async { [weak self] in
            guard let self, self.follower.following else { return }  // (stopped in between)
            self.onFollowed(p)
        }
    }

    /// False until the pages are laid out (no scroll view, or no size yet): the value waits.
    private func followTo(_ v: Float) -> Bool {
        guard let sv, sv.contentSize.width > 0, pageWidth > 0 else { return false }
        let i = sv.adjustedContentInset
        let maxOffset = sv.contentSize.width + i.left + i.right - sv.bounds.width
        guard let to = ZnElementRules.carouselFollow(Double(v), pageWidth: pageWidth, gap: gap, count: count, maxOffset: maxOffset)
        else { return true }
        if abs(to - (sv.contentOffset.x + i.left)) > 0.25 {
            sv.setContentOffset(CGPoint(x: to - i.left, y: sv.contentOffset.y), animated: false)
        }
        report(Int(ZnElementRules.carouselPage(offset: to, pageWidth: pageWidth, gap: gap, count: count).rounded()))
        return true
    }

    /// autoAdvance while following: to page [p], animated (the follow's next change wins again).
    func go(to p: Int) {
        guard let sv, sv.contentSize.width > 0 else { return }
        let i = sv.adjustedContentInset
        let maxOffset = sv.contentSize.width + i.left + i.right - sv.bounds.width
        guard let to = ZnElementRules.carouselFollow(Double(p), pageWidth: pageWidth, gap: gap, count: count, maxOffset: maxOffset)
        else { return }
        sv.setContentOffset(CGPoint(x: to - i.left, y: sv.contentOffset.y), animated: true)
    }
}

/// A touch on the pages pauses autoAdvance: a UIKit recognizer on the carousel's scroll view that only watches. It
/// used to be a SwiftUI DragGesture(minimumDistance: 0) on the scroll view, which began at the finger's touch-down and
/// so cancelled the touch of a Pressable on a page: a banner's tap did nothing (ZeroBill's Store Promotions,
/// 2026-11-24). This one never begins, never cancels or delays the touches, and prevents no other gesture.
struct ZnTouchWatchProbe: UIViewRepresentable {
    let onTouch: () -> Void

    func makeUIView(context: Context) -> ZnTouchWatchProbeView {
        let v = ZnTouchWatchProbeView()
        v.isUserInteractionEnabled = false
        v.isAccessibilityElement = false
        return v
    }

    func updateUIView(_ v: ZnTouchWatchProbeView, context: Context) {
        v.watch.onTouch = onTouch
        DispatchQueue.main.async { [weak v] in v?.attach() }
    }

    static func dismantleUIView(_ v: ZnTouchWatchProbeView, coordinator: ()) {
        v.watch.view?.removeGestureRecognizer(v.watch)
    }
}

final class ZnTouchWatchProbeView: UIView {
    let watch = ZnTouchWatch()

    /// Onto the nearest scroll view up the hierarchy (again if SwiftUI made a new one).
    func attach() {
        var p = superview
        while let v = p, !(v is UIScrollView) { p = v.superview }
        guard let sv = p as? UIScrollView, watch.view !== sv else { return }
        watch.view?.removeGestureRecognizer(watch)
        sv.addGestureRecognizer(watch)
    }
}

final class ZnTouchWatch: UIGestureRecognizer {
    var onTouch: () -> Void = {}

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) { onTouch() }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) { onTouch() }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        onTouch()
        state = .failed
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) { state = .failed }
    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }
}
