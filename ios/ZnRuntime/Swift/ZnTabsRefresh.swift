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
// no pull, only `refreshing` shows it. refreshColor is the spinner's tint (refreshBackground has no iOS counterpart).
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

/// One scroll view's pull to refresh: a UIRefreshControl with the controlled contract above.
@MainActor
final class ZnRefresh: NSObject {
    let control = UIRefreshControl()
    var onRefresh: (() -> Void)?
    private var refreshing = false
    private var pending: DispatchWorkItem?
    private weak var scroll: UIScrollView?

    override init() {
        super.init()
        control.addTarget(self, action: #selector(pulled), for: .valueChanged)
    }

    func attach(to sv: UIScrollView) {
        guard scroll !== sv else { return }
        scroll = sv
        sv.refreshControl = control
        sv.alwaysBounceVertical = true
    }

    func update(refreshing r: Bool, tint: UIColor, canPull: Bool) {
        control.tintColor = tint
        // No onRefresh: the control shows only when JS says so (attached only then, so it can't be pulled).
        if !canPull { scroll?.refreshControl = r ? control : nil }
        refreshing = r
        if r {
            pending?.cancel()
            pending = nil
            if !control.isRefreshing { control.beginRefreshing() }
        } else if pending == nil, control.isRefreshing {
            control.endRefreshing()  // JS says done (a pull still waiting for JS keeps its spinner until then)
        }
    }

    @objc private func pulled() {
        guard control.isRefreshing else { return }
        print("zn t=\(ZnDebug.ms()) refresh: pulled → onRefresh")
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

/// For a <Scroll>: finds the scroll view around it (SwiftUI's) and gives it the refresh control.
struct ZnScrollRefresh: UIViewRepresentable {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let refreshing: Bool

    func makeCoordinator() -> ZnRefresh { ZnRefresh() }

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        return v
    }

    func updateUIView(_ v: UIView, context: Context) {
        let r = context.coordinator
        let (ctx, s, inst) = (ctx, s, inst)
        r.onRefresh = s.onRefresh != 0 ? { ctx.send(inst.id, s.onRefresh, .none) } : nil
        let refreshing = refreshing
        // The scroll view is an ancestor once this view is in the window.
        DispatchQueue.main.async {
            var p = v.superview
            while let sv = p, !(sv is UIScrollView) { p = sv.superview }
            if let sv = p as? UIScrollView { r.attach(to: sv) }
            r.update(refreshing: refreshing, tint: UIColor(s.refreshColor), canPull: s.onRefresh != 0)
        }
    }
}
