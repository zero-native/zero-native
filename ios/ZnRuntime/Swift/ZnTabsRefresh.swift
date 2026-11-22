// <Tabs> and pull to refresh on iOS, as android/runtime's ZnTabs (ZnRenderer.kt) and ZnPullRefresh.kt.
//
// Tabs: only the child at `selected` is drawn, filling the container. A hidden tab's instances stay (JS keeps its
// state) and its views are kept, hidden and out of the hit test, so its scroll position and text fields come back
// as they were (Android keeps them with a SaveableStateHolder). A tab not yet shown is not built.
//
// Pull to refresh, on a vertical <Scroll> and a <List> (flat props or RN's refreshControl, which the compiler turns
// into the same props). iOS draws its own control (UIRefreshControl), as Android draws Android's disc: each platform's
// look. The contract is Android's (ARCHITECTURE §9.7, controlled): a pull past the line sends onRefresh and shows the
// spinner at once; JS's `refreshing` then decides. If JS doesn't set it to true within 1 s, the spinner goes away (a
// refresh that doesn't use `refreshing`). `refreshing` set by JS alone shows the spinner without a pull. No onRefresh:
// no pull, only `refreshing` shows it. refreshColor is the spinner's tint. refreshBackground, when written, puts a
// 40 pt disc in that colour (with a soft shadow, as Android's) under the spinner, so a white spinner shows on a white
// screen; not written, iOS's plain spinner stays (Android's disc is white by default: each platform's look). The disc
// follows UIKit's spinner, which grows in place while pulled (Android's disc slides down with the pull).
// iOS limits: `refreshing` from JS alone scrolls the spinner into view only when the scroll is at its top (Android's
// shows over the content anywhere), and comes up in UIKit's grey until the first pull (iOS 18's spinner takes the tint
// only from a pull).
// On a <Scroll> the control is a subview of SwiftUI's scroll view, not its `refreshControl`: SwiftUI's ScrollView owns
// that property. Its update (UIScrollView._updateRefreshControl, from SwiftUI's render) sets it from .refreshable,
// nil for us, so it took ours out (twice as each Scroll starts, in the stack traces of 2026-11-21) and a pull under
// way when it ran was lost; putting it back after the fact can't save that pull. A subview is UIKit's older way to add
// one and works the same (the pull, the spinner, its inset); SwiftUI never touches it. A <List> (UIKit's own
// collection view) uses `refreshControl`.
import SwiftUI
import UIKit

struct ZnTabsView: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    @State private var seen = Set<Int>()
    /// These Tabs are themselves on a hidden tab: every child counts as hidden.
    @Environment(\.znInHiddenTab) private var inHiddenTab

    var body: some View {
        let refs = znChildRefs(ctx, t, inst, s.children)
        let selected = s.selectedSlot >= 0 ? Int(inst.slot(s.selectedSlot).value.number ?? 0) : s.selected
        ZStack(alignment: .topLeading) {
            ForEach(Array(refs.enumerated()), id: \.element.id) { i, ref in
                if i == selected || seen.contains(i) {
                    ZnNodeView(ctx: ctx, t: ref.t, inst: ref.inst, n: ref.node, outer: ZnOuter(fillWidth: true, fillHeight: true),
                               definiteWidth: true)
                        .opacity(i == selected ? 1 : 0)
                        .allowsHitTesting(i == selected)
                        .environment(\.znInHiddenTab, inHiddenTab || i != selected)
                        .accessibilityHidden(i != selected)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { seen.insert(selected) }
        .onChange(of: selected) { _, n in seen.insert(n) }
    }
}

/// UIRefreshControl with refreshBackground's disc under its spinner.
final class ZnRefreshControl: UIRefreshControl {
    private let disc = UIView()

    override init() {
        super.init()
        disc.isHidden = true
        disc.isUserInteractionEnabled = false
        disc.layer.cornerRadius = 20
        disc.layer.shadowColor = UIColor.black.cgColor
        disc.layer.shadowOpacity = 0.12
        disc.layer.shadowRadius = 3
        disc.layer.shadowOffset = CGSize(width: 0, height: 1)
        insertSubview(disc, at: 0)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// It left its scroll view (for a `refreshControl`, also when the scroll view's owner cleared it).
    var onLeft: () -> Void = {}

    override func didMoveToSuperview() {
        super.didMoveToSuperview()
        if superview == nil { onLeft() }
    }

    /// The disc's colour; nil: no disc.
    var discColor: UIColor? {
        didSet {
            disc.isHidden = discColor == nil
            disc.backgroundColor = discColor
            setNeedsLayout()
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard discColor != nil else { return }
        // UIKit adds its spinner's views later (on the first pull): keep the disc under them.
        if subviews.first !== disc { sendSubviewToBack(disc) }
        // Centred on UIKit's spinner (a UIActivityIndicatorView somewhere inside, on iOS versions that use one; no
        // private class names), else on the middle of the control, where iOS 18's own spinner is.
        let center = spinner(in: self).map { $0.convert(CGPoint(x: $0.bounds.midX, y: $0.bounds.midY), to: self) }
            ?? CGPoint(x: bounds.midX, y: bounds.midY)
        disc.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
        disc.center = center
        // Fades in with the pull, as the spinner does; whole while refreshing.
        disc.alpha = isRefreshing ? 1 : min(1, bounds.height / 60)
    }

    private func spinner(in v: UIView) -> UIActivityIndicatorView? {
        for sub in v.subviews where sub !== disc {
            if let a = sub as? UIActivityIndicatorView { return a }
            if let s = spinner(in: sub) { return s }
        }
        return nil
    }
}

/// One scroll view's pull to refresh: a UIRefreshControl with the controlled contract above.
@MainActor
final class ZnRefresh: NSObject {
    let control = ZnRefreshControl()
    var onRefresh: (() -> Void)?
    private var refreshing = false
    private var pending: DispatchWorkItem?
    private weak var scroll: UIScrollView?
    /// The control belongs in the scroll view now (it can be pulled, or JS shows it).
    private var wanted = false
    /// A subview of the scroll view, not its refreshControl (a <Scroll>: see the header).
    private let asSubview: Bool

    init(asSubview: Bool = false) {
        self.asSubview = asSubview
        super.init()
        control.addTarget(self, action: #selector(pulled), for: .valueChanged)
        // Taken out with no update of ours after it: put it back, or the scroll could no longer be pulled.
        control.onLeft = { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.wanted, let sv = self.scroll, !self.isIn(sv) else { return }
                self.put(in: sv, true)
            }
        }
    }

    private func isIn(_ sv: UIScrollView) -> Bool {
        asSubview ? control.superview === sv : sv.refreshControl === control
    }

    private func put(in sv: UIScrollView, _ on: Bool) {
        if asSubview {
            // Under the content, as UIKit puts a refreshControl.
            if on { sv.insertSubview(control, at: 0) } else { control.removeFromSuperview() }
            // A subview only: as the scroll view's refreshControl, SwiftUI's next update would take it out.
            assert(sv.refreshControl !== control, "ZnRefresh: UIKit made the subview control the refreshControl")
        } else {
            sv.refreshControl = on ? control : nil
        }
    }

    func attach(to sv: UIScrollView) {
        guard scroll !== sv else { return }
        scroll = sv
        sv.alwaysBounceVertical = true
    }

    /// [background]: refreshBackground (nil: not written, no disc).
    func update(refreshing r: Bool, tint: UIColor, canPull: Bool, background: UIColor? = nil) {
        // No onRefresh: the control shows only when JS says so (attached only then, so it can't be pulled).
        wanted = canPull || r
        if let sv = scroll, wanted != isIn(sv) { put(in: sv, wanted) }
        // The spinner's tint and the disc.
        control.tintColor = tint
        if control.discColor != background { control.discColor = background }
        refreshing = r
        if r {
            pending?.cancel()
            pending = nil
            if !control.isRefreshing {
                // Set by JS alone with the scroll at its top: scroll the spinner into view, as Android's indicator
                // shows itself (beginRefreshing alone leaves it above the top edge). Scrolled down, the spinner stays
                // above what shows (Android's shows over the content wherever it is scrolled). A control attached in
                // this update (no onRefresh) has no height before a layout: laid out first, 60 pt if still none.
                if let sv = scroll, isIn(sv), !sv.isDragging,
                   sv.contentOffset.y <= -sv.adjustedContentInset.top + 0.5 {
                    if control.frame.height <= 0 { sv.layoutIfNeeded() }
                    let h = control.frame.height > 0 ? control.frame.height : 60
                    sv.setContentOffset(CGPoint(x: sv.contentOffset.x, y: -sv.adjustedContentInset.top - h), animated: true)
                }
                control.beginRefreshing()
            }
        } else if pending == nil, control.isRefreshing {
            control.endRefreshing()  // JS says done (a pull still waiting for JS keeps its spinner until then)
        }
    }

    @objc private func pulled() {
        guard control.isRefreshing else { return }
        print("zn t=\(ZnDebug.ms()) refresh: pulled → onRefresh")
        assert(!asSubview || scroll?.refreshControl !== control, "ZnRefresh: UIKit made the subview control the refreshControl")
        onRefresh?()
        // JS has 1 s to say `refreshing`; else the spinner goes.
        let p = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.pending = nil
            if !self.refreshing { self.control.endRefreshing() }
        }
        pending = p
        DispatchQueue.main.asyncAfter(deadline: .now() + 1, execute: p)
    }
}

extension ZnNodeSpec {
    /// This node has pull to refresh (an onRefresh, or a `refreshing` prop).
    var hasRefresh: Bool { onRefresh != 0 || refreshingSlot >= 0 || refreshing }

    @MainActor func refreshingNow(_ inst: ZnInstance) -> Bool {
        refreshingSlot >= 0 ? inst.slot(refreshingSlot).value == .bool(true) : refreshing
    }
}
