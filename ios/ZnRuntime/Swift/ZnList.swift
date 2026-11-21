// <List> on iOS, both ways (i.1c). Window protocol as android/runtime (docs/lists.md): native knows every row's key and
// type (LIST_SET / LIST_SPLICE); JS mounts instances only for a window of rows (LIST_ROW binds a key to one); native
// sends the visible range (onRange "a,b") so JS moves the window. A row without an instance draws its template with
// slot defaults (a placeholder): same height and look, never blank.
//
// The items are in Android's order (ZnRenderer.kt ZnLazyList, also when inverted): ListHeaderComponent, then
// ListEmptyComponent while there are no rows, the rows (one item per grid line with numColumns, ZnListGrid.swift),
// ListFooterComponent. The list's gap goes between every two of them. horizontal lays them out sideways (no pull to
// refresh, pinned rows or inverted there, as on Android). A ref's scrollToIndex / scrollToEnd / scrollToOffset come as
// commands in a slot (ZnScrollCommand), each run once.
//
// SwiftUI variant: ScrollView + LazyVStack / LazyHStack (rows are created lazily, never reused; the visible range comes
// from onAppear / onDisappear; commands through ScrollViewReader). UIKit variant: UICollectionView with a compositional
// layout and UIHostingConfiguration cells (cells are reused; the visible range comes from indexPathsForVisibleItems),
// one section per part (ZnListPart).
import SwiftUI
import UIKit

struct ZnListRow: Equatable {
    let key: String
    let type: Int
}

/// A <List>'s rows. Observable: a row redraws when its instance arrives.
@Observable
final class ZnListState {
    var rows: [ZnListRow] = []
    /// Row key → the instance that draws it.
    var bound: [String: UInt32] = [:]
    /// The instances of ListHeaderComponent / ListFooterComponent / ListEmptyComponent (registry 23), or nil. Kept out
    /// of [bound], so a row bind doesn't redraw the list around them (Android's M9 note). Core sends them under the keys
    /// "__zn_header" / "__zn_footer" / "__zn_empty"; a row key never starts with "__zn_".
    var header: UInt32?
    var footer: UInt32?
    var empty: UInt32?
    @ObservationIgnored private var keyOf: [UInt32: String] = [:]
    /// Last range sent to JS, so the same one isn't sent twice.
    @ObservationIgnored var sentRange = ""
    /// The last scroll command run (ZnScrollCommand.seq). -1, so a command sent with the MOUNT runs on first draw; on
    /// the list, so a list drawn again doesn't run it twice (Android's ZnList.lastScrollSeq).
    @ObservationIgnored var lastScrollSeq = -1

    func bind(_ key: String, _ row: UInt32) {
        switch key {
        case "__zn_header": keyOf[row] = key; if let old = header, old != row { keyOf[old] = nil }; header = row
        case "__zn_footer": keyOf[row] = key; if let old = footer, old != row { keyOf[old] = nil }; footer = row
        case "__zn_empty": keyOf[row] = key; if let old = empty, old != row { keyOf[old] = nil }; empty = row
        default:
            if let old = bound[key] { keyOf[old] = nil }
            bound[key] = row
            keyOf[row] = key
        }
    }

    func unbind(_ row: UInt32) {
        guard let key = keyOf.removeValue(forKey: row) else { return }
        switch key {
        case "__zn_header": if header == row { header = nil }
        case "__zn_footer": if footer == row { footer = nil }
        case "__zn_empty": if empty == row { empty = nil }
        default: if bound[key] == row { bound[key] = nil }
        }
    }

    /// The extra's instance for [part], or nil (rows have none).
    func extra(_ part: ZnListPart) -> UInt32? {
        switch part {
        case .header: return header
        case .footer: return footer
        case .empty: return empty
        case .rows: return nil
        }
    }
}

/// The SwiftUI environment a list cell needs from around the list. A UIHostingConfiguration cell starts a new SwiftUI
/// tree and gets none of the custom values, so the list hands them on: the screen's entry (impressions, shared
/// elements), a hidden tab, pointerEvents "none" around the list, the gesture depth.
struct ZnHostedEnv: Equatable {
    var entry: UInt32 = 0
    var inHiddenTab = false
    var touchOff = false
    var gestureDepth = 0

    init() {}

    init(_ e: EnvironmentValues) {
        entry = e.znEntry
        inHiddenTab = e.znInHiddenTab
        touchOff = e.znTouchOff
        gestureDepth = e.znGestureDepth
    }
}

/// The values a list's cells read (observed: a change redraws every cell drawn, without reconfiguring them).
@Observable
final class ZnHostedEnvBox {
    var env = ZnHostedEnv()
}

/// Puts the list's environment back on a cell's content.
struct ZnHostedEnvView<Content: View>: View {
    let box: ZnHostedEnvBox
    @ViewBuilder let content: () -> Content

    var body: some View {
        let e = box.env
        content()
            .environment(\.znEntry, e.entry)
            .environment(\.znInHiddenTab, e.inHiddenTab)
            .environment(\.znTouchOff, e.touchOff)
            .environment(\.znGestureDepth, e.gestureDepth)
    }
}

struct ZnListView: View {
    let ctx: ZnContext
    let inst: ZnInstance
    let s: ZnNodeSpec

    var body: some View {
        let list = inst.list(s.index)
        // Read here, so a change of these reaches the list (updateUIView / the SwiftUI body).
        let cols = znGridColumns(slot: s.numColumnsSlot >= 0 ? inst.slot(s.numColumnsSlot).value.number : nil,
                                 fixed: s.numColumns, horizontal: s.horizontal)
        let header = drawn(list.header), footer = drawn(list.footer), empty = drawn(list.empty)
        let command = s.scrollCommandSlot >= 0 ? inst.slot(s.scrollCommandSlot).value.string : nil
        let padding = s.paddingInsets(inst)
        switch ZnImpl.list {
        case .swiftUI:
            ZnLazyList(ctx: ctx, inst: inst, s: s, list: list, cols: cols, header: header, footer: footer, empty: empty,
                       command: command, padding: padding)
        case .uiKit:
            let stickyText = s.stickySlot >= 0 ? inst.slot(s.stickySlot).value.string : s.stickyHeaderIndices
            // Pinned rows: not sideways or in a grid (Android draws them only in a plain column).
            let sticky = s.horizontal || cols > 1 ? [] : znParseSticky(stickyText)
            ZnCollectionList(ctx: ctx, inst: inst, s: s, list: list, count: list.rows.count, sticky: sticky,
                             refreshing: s.refreshingNow(inst), cols: cols, header: header, footer: footer, empty: empty,
                             command: command, padding: padding)
        }
    }

    /// An extra's instance when it is mounted and its template is in this file (Android's drawnExtra).
    private func drawn(_ id: UInt32?) -> UInt32? {
        guard let id, let e = ctx.store.find(id), ctx.templates[safe: e.templateId] != nil else { return nil }
        return id
    }
}

/// Where a sideways list places a short item (Android's verticalAlignment(alignItems)).
func znRowAlignment(_ alignItems: Int) -> Alignment {
    switch alignItems {
    case Registry.AlignItems.center: return .leading
    case Registry.AlignItems.flexEnd: return .bottomLeading
    default: return .topLeading
    }
}

/// One row: its instance if JS mounted one, else a placeholder of its template. Full width in a column; its own width
/// in a sideways list, placed in the list's height by alignItems.
struct ZnListRowView: View {
    let ctx: ZnContext
    let list: ZnListState
    let row: ZnListRow
    var horizontal = false
    var alignItems = -1

    var body: some View {
        let mounted = list.bound[row.key].flatMap { ctx.store.find($0) }
        let templateId = mounted?.templateId ?? row.type
        if let t = ctx.templates[safe: templateId] {
            let inst = mounted ?? ctx.store.placeholder(templateId: templateId, template: t)
            if horizontal {
                ZnNodeView(ctx: ctx, t: t, inst: inst, n: 0, outer: ZnOuter(), definiteWidth: t.nodes.first?.width != nil)
                    .frame(maxHeight: .infinity, alignment: znRowAlignment(alignItems))
            } else {
                ZnNodeView(ctx: ctx, t: t, inst: inst, n: 0, outer: ZnOuter(fillWidth: true), definiteWidth: true)
            }
        }
    }
}

/// A header, footer or empty item: its own template, full width in a column, its own width in a row. Its instance is
/// read here, so JS mounting a new one (it does on every run of the extra's effect) redraws it in place.
struct ZnListExtraView: View {
    let ctx: ZnContext
    let list: ZnListState
    let part: ZnListPart
    var horizontal = false
    var alignItems = -1

    var body: some View {
        if let id = list.extra(part), let e = ctx.store.find(id), let t = ctx.templates[safe: e.templateId] {
            if horizontal {
                ZnNodeView(ctx: ctx, t: t, inst: e, n: 0, outer: ZnOuter(), definiteWidth: t.nodes.first?.width != nil)
                    .frame(maxHeight: .infinity, alignment: znRowAlignment(alignItems))
            } else {
                ZnNodeView(ctx: ctx, t: t, inst: e, n: 0, outer: ZnOuter(fillWidth: true), definiteWidth: true)
            }
        }
    }
}

@MainActor
func znSendRange(_ ctx: ZnContext, _ inst: ZnInstance, _ s: ZnNodeSpec, _ list: ZnListState, _ a: Int, _ b: Int) {
    guard s.onRange != 0, a <= b else { return }
    let range = "\(a),\(b)"
    guard range != list.sentRange else { return }
    list.sentRange = range
    print("zn t=\(ZnDebug.ms()) list: visible \(range) → JS (\(list.bound.count) rows bound)")
    ctx.send(inst.id, s.onRange, .string(range))
}

/// How close to the end (in rows) a <List> sends onEndReached (Android's END_REACHED_ROWS).
let znEndReachedRows = 5

// MARK: - SwiftUI

@MainActor
final class ZnVisibleRows {
    /// Items on screen: part * 1_000_000_000 + item.
    var shown = Set<Int>()
    /// onEndReached was sent while the list had this many rows.
    var endSentAt = -1
    /// The props this variant doesn't draw were named once.
    var told = false
}

struct ZnLazyList: View {
    let ctx: ZnContext
    let inst: ZnInstance
    let s: ZnNodeSpec
    let list: ZnListState
    let cols: Int
    let header: UInt32?
    let footer: UInt32?
    let empty: UInt32?
    let command: String?
    let padding: EdgeInsets
    @State private var visible = ZnVisibleRows()

    private var shape: ZnListShape {
        ZnListShape(header: header != nil, empty: empty != nil, rows: list.rows.count, footer: footer != nil, cols: cols)
    }

    var body: some View {
        let rows = list.rows
        let lineKeys = znLineKeys(rows.map(\.key), cols: cols)
        ScrollViewReader { proxy in
            ScrollView(s.horizontal ? .horizontal : .vertical, showsIndicators: !s.horizontal) {
                if s.horizontal {
                    LazyHStack(alignment: znRowAlignment(s.alignItems).vertical, spacing: s.gap) {
                        items(rows, lineKeys)
                    }
                    .padding(padding)
                } else {
                    LazyVStack(spacing: s.gap) {
                        items(rows, lineKeys)
                    }
                    .padding(padding)
                }
            }
            .onAppear { tellUnsupported() }
            .onChange(of: command, initial: true) { _, text in run(text, proxy, lineKeys) }
        }
    }

    @ViewBuilder
    private func items(_ rows: [ZnListRow], _ lineKeys: [String]) -> some View {
        if header != nil {
            ZnListExtraView(ctx: ctx, list: list, part: .header, horizontal: s.horizontal, alignItems: s.alignItems)
                .id("__zn_header").modifier(seen(.header, 0))
        }
        if rows.isEmpty, empty != nil {
            ZnListExtraView(ctx: ctx, list: list, part: .empty, horizontal: s.horizontal, alignItems: s.alignItems)
                .id("__zn_empty").modifier(seen(.empty, 0))
        }
        if cols > 1 {
            ForEach(lineKeys.indices, id: \.self) { g in
                ZnGridLineView(ctx: ctx, list: list, line: g, cols: cols, wrapper: s.columnWrapper)
                    .id(lineKeys[g]).modifier(seen(.rows, g))
            }
        } else {
            ForEach(rows.indices, id: \.self) { i in
                ZnListRowView(ctx: ctx, list: list, row: rows[i], horizontal: s.horizontal, alignItems: s.alignItems)
                    .id(rows[i].key).modifier(seen(.rows, i))
            }
        }
        if footer != nil {
            ZnListExtraView(ctx: ctx, list: list, part: .footer, horizontal: s.horizontal, alignItems: s.alignItems)
                .id("__zn_footer").modifier(seen(.footer, 0))
        }
    }

    private func seen(_ part: ZnListPart, _ item: Int) -> ZnSeen {
        let code = part.rawValue * 1_000_000_000 + item
        return ZnSeen(appear: { visible.shown.insert(code); report() }, disappear: { visible.shown.remove(code); report() })
    }

    private func report() {
        let items = visible.shown.map { (part: ZnListPart(rawValue: $0 / 1_000_000_000) ?? .rows, item: $0 % 1_000_000_000) }
        guard !items.isEmpty else { return }
        let n = list.rows.count
        let (a, b) = znVisibleRange(items, rows: n, cols: cols, pinned: [])
        znSendRange(ctx, inst, s, list, a, b)
        // Near the end: ask JS for more (onEndReached), once per list length, as Android does.
        if s.onEndReached != 0, n > 0, b >= n - znEndReachedRows, visible.endSentAt != n {
            visible.endSentAt = n
            ctx.send(inst.id, s.onEndReached, .none)
        }
    }

    /// A ref's command: index and end scroll to that item (its id); offset 0 to the start. A viewOffset or another offset
    /// needs the scroll view's offset, which SwiftUI gives only from iOS 18 (ScrollPosition): named, nothing moves.
    private func run(_ text: String?, _ proxy: ScrollViewProxy, _ lineKeys: [String]) {
        guard let cmd = ZnScrollCommand(text), cmd.isNew(after: list.lastScrollSeq) else { return }
        list.lastScrollSeq = cmd.seq
        let start: UnitPoint = s.horizontal ? .leading : .top
        var id: String?
        var anchor = start
        if let offset = cmd.axisOffset(horizontal: s.horizontal) {
            if offset <= 0, let first = shape.item(0) { id = itemId(first, lineKeys) }
            else { print("zn t=\(ZnDebug.ms()) list: SwiftUI list can't scroll to offset \(offset) (UIKit list only)") }
        } else if let flat = znScrollTarget(cmd, shape), let it = shape.item(flat) {
            id = itemId(it, lineKeys)
            if cmd.action == .end { anchor = s.horizontal ? .trailing : .bottom }
            if cmd.action == .index, cmd.second != 0 { print("zn t=\(ZnDebug.ms()) list: SwiftUI list ignores viewOffset \(cmd.second)") }
        }
        guard let id else { return }
        print("zn t=\(ZnDebug.ms()) list: command \(text ?? "") → \(id)")
        if cmd.animated { withAnimation { proxy.scrollTo(id, anchor: anchor) } } else { proxy.scrollTo(id, anchor: anchor) }
    }

    private func itemId(_ it: (part: ZnListPart, item: Int), _ lineKeys: [String]) -> String? {
        switch it.part {
        case .header: return "__zn_header"
        case .empty: return "__zn_empty"
        case .footer: return "__zn_footer"
        case .rows: return cols > 1 ? lineKeys[safe: it.item] : list.rows[safe: it.item]?.key
        }
    }

    /// Once per list: the props only the UIKit list draws.
    private func tellUnsupported() {
        guard !visible.told else { return }
        visible.told = true
        var names: [String] = []
        if s.inverted { names.append("inverted") }
        if s.stickySlot >= 0 || s.stickyHeaderIndices != nil { names.append("stickyHeaderIndices") }
        if s.hasRefresh { names.append("pull to refresh") }
        if s.reorderable { names.append("reorderable") }
        if !names.isEmpty { print("zn t=\(ZnDebug.ms()) list: the SwiftUI list doesn't draw \(names.joined(separator: ", ")) (ZN_IOS_LIST=swiftui)") }
    }
}

/// A SwiftUI list item's appear / disappear.
private struct ZnSeen: ViewModifier {
    let appear: () -> Void
    let disappear: () -> Void

    func body(content: Content) -> some View {
        content.onAppear(perform: appear).onDisappear(perform: disappear)
    }
}

// MARK: - UIKit

/// The list's collection view: tells the list when it was laid out (a scroll command sent with the MOUNT waits for its
/// first size).
final class ZnListCollectionView: UICollectionView {
    var onLayout: (() -> Void)?

    override func layoutSubviews() {
        super.layoutSubviews()
        onLayout?()
    }
}

struct ZnCollectionList: UIViewRepresentable {
    let ctx: ZnContext
    let inst: ZnInstance
    let s: ZnNodeSpec
    let list: ZnListState
    let count: Int  // read in the parent body, so a row count change reaches updateUIView
    let sticky: [Int]
    /// Pull to refresh (ZnTabsRefresh.swift): `refreshing` now (read in the parent body).
    let refreshing: Bool
    /// The grid's columns now (1: a plain list), the extras drawn (their instances), a ref's command and the padding:
    /// read in the parent body too.
    let cols: Int
    let header: UInt32?
    let footer: UInt32?
    let empty: UInt32?
    let command: String?
    let padding: EdgeInsets

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ZnListCollectionView {
        let c = context.coordinator
        c.horizontal = s.horizontal
        let cfg = UICollectionViewCompositionalLayoutConfiguration()
        if s.horizontal { cfg.scrollDirection = .horizontal }
        let layout = ZnStickyLayout(sectionProvider: { [weak c] index, _ in
            MainActor.assumeIsolated { c?.section(index) }
        }, configuration: cfg)
        let cv = ZnListCollectionView(frame: .zero, collectionViewLayout: layout)
        cv.backgroundColor = .clear
        cv.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "row")
        cv.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "line")
        cv.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "extra")
        cv.dataSource = c
        cv.delegate = c
        // A sideways list shows no scroll bar, as Compose's LazyRow.
        if s.horizontal { cv.showsHorizontalScrollIndicator = false }
        // inverted (RN): row 0 at the bottom, growing upwards (a chat). The list is flipped and each cell flipped back.
        // Not sideways (Android's LazyRow has no reverseLayout here).
        if s.inverted && !s.horizontal { cv.transform = CGAffineTransform(scaleX: 1, y: -1) }
        cv.onLayout = { [weak c, weak cv] in
            guard let c, let cv else { return }
            MainActor.assumeIsolated { c.runPending(cv) }
        }
        return cv
    }

    func updateUIView(_ cv: ZnListCollectionView, context: Context) {
        let c = context.coordinator
        c.ctx = ctx; c.inst = inst; c.s = s; c.list = list
        // The environment the cells need (a UIHostingConfiguration cell doesn't inherit it).
        let env = ZnHostedEnv(context.environment)
        if c.envBox.env != env {
            c.envBox.env = env
            print("zn t=\(ZnDebug.ms()) list: cells get entry \(env.entry), hidden tab \(env.inHiddenTab), touch off \(env.touchOff), gesture depth \(env.gestureDepth)")
        }
        if s.hasRefresh && !s.horizontal {
            let (ctx, inst, s) = (ctx, inst, s)
            let r = c.refresh ?? ZnRefresh()
            c.refresh = r
            r.attach(to: cv)
            r.onRefresh = s.onRefresh != 0 ? { ctx.send(inst.id, s.onRefresh, .none) } : nil
            r.update(refreshing: refreshing, tint: UIColor(s.refreshColor), canPull: s.onRefresh != 0,
                     background: s.refreshBackground.map(UIColor.init))
        }
        let layout = cv.collectionViewLayout as? ZnStickyLayout
        // Padding scrolls with the items (RN's contentContainerStyle): along the list it is the scroll view's inset, so
        // the header sits inside it as on Android; across, each section's insets (ZnCoordinator.section).
        if c.padding != padding {
            c.padding = padding
            let inset = s.horizontal ? UIEdgeInsets(top: 0, left: padding.leading, bottom: 0, right: padding.trailing)
                : UIEdgeInsets(top: padding.top, left: 0, bottom: padding.bottom, right: 0)
            if cv.contentInset != inset { cv.contentInset = inset }
            layout?.invalidateLayout()
        }
        c.gap = s.gap
        if let layout, layout.sticky != sticky {
            // A new layout pass forgets the scroll position (the lab's list jumped 34 rows on each toggle,
            // 2026-11-08): keep the first row that isn't pinned where it is.
            let anchor = c.anchor(cv)
            layout.sticky = sticky
            c.sticky = Set(sticky)
            layout.invalidateLayout()
            c.restore(cv, anchor)
        }
        update(cv, c, layout)
        if let cmd = ZnScrollCommand(command), cmd.isNew(after: list.lastScrollSeq) {
            list.lastScrollSeq = cmd.seq
            c.pending = cmd
        }
        c.runPending(cv)
    }

    /// The rows and extras: inserts and removals in one batch when they are few, else a reload.
    private func update(_ cv: ZnListCollectionView, _ c: Coordinator, _ layout: ZnStickyLayout?) {
        let rows = list.rows
        let shape = ZnListShape(header: header != nil, empty: empty != nil, rows: rows.count, footer: footer != nil, cols: cols)
        let keys = znLineKeys(rows.map(\.key), cols: cols)
        guard c.keys != keys || c.shape != shape else {
            if c.rows != rows { c.rows = rows }  // a row's type changed under the same key
            return
        }
        let old = c.keys, oldShape = c.shape
        // The first visible item stays where it is on screen (Home: "New payment arrives" inserts at the top, and the
        // rows being read must not move), as on Android, where LazyColumn keeps the first visible key in place.
        let anchor = c.anchor(cv)
        let ranges = oldShape.cols == cols ? znChangedRanges(old, keys) : nil
        print("zn t=\(ZnDebug.ms()) list: \(old.count) → \(keys.count) \(cols > 1 ? "lines (\(cols) columns)" : "rows"), changed \(ranges.map { "\($0.removed) → \($0.inserted)" } ?? "all"), extras \(extrasText(shape)), anchor \(anchor.map { "\($0.key) at \($0.at)" } ?? "none")")
        if let (removed, inserted) = ranges, removed.count + inserted.count <= 200 {
            // The data source changes inside the update block, never before it: UIKit reads the item count before
            // and after, and they must differ by exactly these updates (crashed on 30 older chat messages,
            // 2026-11-08, when the count was read early).
            cv.layoutIfNeeded()
            let rowsPart = ZnListPart.rows.rawValue
            UIView.performWithoutAnimation {
                cv.performBatchUpdates {
                    c.keys = keys; c.rows = rows; c.shape = shape
                    cv.deleteItems(at: removed.map { IndexPath(item: $0, section: rowsPart) })
                    cv.insertItems(at: inserted.map { IndexPath(item: $0, section: rowsPart) })
                    for part in [ZnListPart.header, .empty, .footer] {
                        let (was, now) = (oldShape.count(part), shape.count(part))
                        if was > now { cv.deleteItems(at: [IndexPath(item: 0, section: part.rawValue)]) }
                        if now > was { cv.insertItems(at: [IndexPath(item: 0, section: part.rawValue)]) }
                    }
                }
            }
        } else {
            c.keys = keys; c.rows = rows; c.shape = shape
            cv.reloadData()
        }
        // The gap before each part depends on which parts have items (ZnListShape.gapBefore).
        if ZnListPart.allCases.contains(where: { oldShape.gapBefore($0) != shape.gapBefore($0) }) { layout?.invalidateLayout() }
        c.restore(cv, anchor)
        // Android sends the range when it changes, also without a scroll (rows added, the columns changed).
        if !cv.bounds.isEmpty {
            cv.layoutIfNeeded()
            c.report(cv)
        }
    }

    private func extrasText(_ shape: ZnListShape) -> String {
        let names = [shape.header ? "header" : nil, shape.count(.empty) > 0 ? "empty" : nil, shape.footer ? "footer" : nil].compactMap { $0 }
        return names.isEmpty ? "none" : names.joined(separator: "+")
    }

    @MainActor
    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate {
        var ctx: ZnContext?
        var inst: ZnInstance?
        var s: ZnNodeSpec?
        var list: ZnListState?
        /// What the collection view shows now: the rows, the keys of the rows part (line keys in a grid) and each
        /// part's count. Changed only inside the update (UIKit counts must match its updates).
        var rows: [ZnListRow] = []
        var keys: [String] = []
        var shape = ZnListShape()
        var sticky = Set<Int>()
        var refresh: ZnRefresh?
        var horizontal = false
        var gap: CGFloat = 0
        /// nil until the first update sets it.
        var padding: EdgeInsets?
        let envBox = ZnHostedEnvBox()
        /// onEndReached was sent while the list had this many rows (once per length, as on Android).
        var endSentAt = -1
        /// A ref's command waiting to run (the list has no size yet), and one being finished after its animation
        /// (estimated sizes settle as the target's rows are measured).
        var pending: ZnScrollCommand?
        var settling: (cmd: ZnScrollCommand, tries: Int)?

        // MARK: Layout

        /// The layout of section [index] (a ZnListPart): one item per row (grid line) or extra, full width in a column
        /// (self-sized height), the list's height in a row (self-sized width).
        func section(_ index: Int) -> NSCollectionLayoutSection? {
            let part = ZnListPart(rawValue: index) ?? .rows
            let pad = padding ?? EdgeInsets()
            let gapBefore = shape.gapBefore(part) ? gap : 0
            let size = horizontal
                ? NSCollectionLayoutSize(widthDimension: .estimated(100), heightDimension: .fractionalHeight(1))
                : NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(part == .rows ? 60 : 44))
            let item = NSCollectionLayoutItem(layoutSize: size)
            let group = horizontal ? NSCollectionLayoutGroup.horizontal(layoutSize: size, subitems: [item])
                : NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [item])
            let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = gap
            section.contentInsets = horizontal
                ? NSDirectionalEdgeInsets(top: pad.top, leading: gapBefore, bottom: pad.bottom, trailing: 0)
                : NSDirectionalEdgeInsets(top: gapBefore, leading: pad.leading, bottom: 0, trailing: pad.trailing)
            return section
        }

        // MARK: Data source

        func numberOfSections(in cv: UICollectionView) -> Int { ZnListPart.allCases.count }

        func collectionView(_ cv: UICollectionView, numberOfItemsInSection section: Int) -> Int {
            shape.count(ZnListPart(rawValue: section) ?? .rows)
        }

        func collectionView(_ cv: UICollectionView, cellForItemAt ip: IndexPath) -> UICollectionViewCell {
            let part = ZnListPart(rawValue: ip.section) ?? .rows
            let grid = part == .rows && shape.cols > 1
            let cell = cv.dequeueReusableCell(withReuseIdentifier: part != .rows ? "extra" : grid ? "line" : "row", for: ip)
            if let ctx, let list, let s {
                let (box, horizontal, align, cols) = (envBox, horizontal, s.alignItems, shape.cols)
                if part != .rows {
                    cell.contentConfiguration = UIHostingConfiguration {
                        ZnHostedEnvView(box: box) { ZnListExtraView(ctx: ctx, list: list, part: part, horizontal: horizontal, alignItems: align) }
                    }.margins(.all, 0)
                } else if grid {
                    let (line, wrapper) = (ip.item, s.columnWrapper)
                    cell.contentConfiguration = UIHostingConfiguration {
                        ZnHostedEnvView(box: box) { ZnGridLineView(ctx: ctx, list: list, line: line, cols: cols, wrapper: wrapper) }
                    }.margins(.all, 0)
                } else if let row = rows[safe: ip.item] {
                    cell.contentConfiguration = UIHostingConfiguration {
                        ZnHostedEnvView(box: box) { ZnListRowView(ctx: ctx, list: list, row: row, horizontal: horizontal, alignItems: align) }
                    }.margins(.all, 0)
                }
            }
            cell.contentView.transform = cv.transform  // inverted: flip each row back
            return cell
        }

        // MARK: Visible range

        func scrollViewDidScroll(_ sv: UIScrollView) {
            guard let cv = sv as? UICollectionView else { return }
            if ProcessInfo.processInfo.environment["ZN_LIST_TRACE"] == "1" { print("zn t=\(ZnDebug.ms()) list: offset \(cv.contentOffset)") }
            report(cv)
        }

        /// Sends the rows on screen (onRange) and, near the end, onEndReached.
        func report(_ cv: UICollectionView) {
            guard let ctx, let inst, let s, let list else { return }
            let visible = cv.indexPathsForVisibleItems.map { (part: ZnListPart(rawValue: $0.section) ?? .rows, item: $0.item) }
            guard !visible.isEmpty else { return }
            let n = rows.count
            // A pinned row shows above rows far below it: left out (znVisibleRange), or JS would mount every row in
            // between (Android does the same).
            let (a, b) = znVisibleRange(visible, rows: n, cols: shape.cols, pinned: sticky)
            znSendRange(ctx, inst, s, list, a, b)
            // Near the end: ask JS for more (onEndReached), once per list length, as Android does (5 rows ahead).
            if s.onEndReached != 0, n > 0, b >= n - znEndReachedRows, endSentAt != n {
                endSentAt = n
                ctx.send(inst.id, s.onEndReached, .none)
            }
        }

        // MARK: Keeping the place

        /// The item for an anchor key: an extra's own key, or a row key (its grid line).
        private func indexPath(forAnchor key: String) -> IndexPath? {
            for part in [ZnListPart.header, .empty, .footer] where key == "__zn_\(part)" {
                return shape.count(part) > 0 ? IndexPath(item: 0, section: part.rawValue) : nil
            }
            guard let r = rows.firstIndex(where: { $0.key == key }) else { return nil }
            return IndexPath(item: r / max(shape.cols, 1), section: ZnListPart.rows.rawValue)
        }

        private func main(_ p: CGPoint) -> CGFloat { horizontal ? p.x : p.y }

        /// The first visible item (pinned rows left out: they sit at the top wherever the list is) and its distance
        /// from the start of the list. Its key: an extra's ("__zn_header"), or the row's (a line's first row).
        func anchor(_ cv: UICollectionView) -> (key: String, at: CGFloat)? {
            let rowsPart = ZnListPart.rows.rawValue
            let items = cv.indexPathsForVisibleItems.filter { !($0.section == rowsPart && sticky.contains($0.item)) }.sorted()
            guard let ip = items.first, let a = cv.collectionViewLayout.layoutAttributesForItem(at: ip) else { return nil }
            let key: String
            if ip.section == rowsPart {
                guard let row = rows[safe: ip.item * max(shape.cols, 1)] else { return nil }
                key = row.key
            } else {
                key = "__zn_\(ZnListPart(rawValue: ip.section) ?? .rows)"
            }
            return (key, main(a.frame.origin) - main(cv.contentOffset))
        }

        /// Scrolls so the anchor item is back at its distance from the start (clamped to the content).
        func restore(_ cv: UICollectionView, _ anchor: (key: String, at: CGFloat)?) {
            guard let anchor, let ip = indexPath(forAnchor: anchor.key) else { return }
            cv.layoutIfNeeded()
            guard let a = cv.collectionViewLayout.layoutAttributesForItem(at: ip) else { return }
            let target = clamp(cv, main(a.frame.origin) - anchor.at)
            if horizontal { cv.contentOffset.x = target } else { cv.contentOffset.y = target }
            print("zn t=\(ZnDebug.ms()) list: anchor \(ip.section):\(ip.item) at \(main(a.frame.origin)) → offset \(target)")
        }

        /// [v] kept between the start (before the padding) and the end of the content.
        private func clamp(_ cv: UICollectionView, _ v: CGFloat) -> CGFloat {
            let i = cv.adjustedContentInset
            return horizontal
                ? znClampOffset(v, before: i.left, content: cv.contentSize.width, viewport: cv.bounds.width, after: i.right)
                : znClampOffset(v, before: i.top, content: cv.contentSize.height, viewport: cv.bounds.height, after: i.bottom)
        }

        // MARK: Scroll commands

        /// Runs the waiting command once the list has a size.
        func runPending(_ cv: UICollectionView) {
            guard let cmd = pending, !cv.bounds.isEmpty, cv.window != nil else { return }
            pending = nil
            run(cmd, cv)
        }

        /// Where [cmd] puts the list (its offset along the list), or nil when it moves nothing. index: the row's item
        /// at the start, below the padding, [cmd.second] (viewOffset) further from the start; end: the last item
        /// (the footer), clamped to the end; offset / to: that far from the start.
        private func target(_ cmd: ZnScrollCommand, _ cv: UICollectionView) -> CGFloat? {
            let start = horizontal ? cv.adjustedContentInset.left : cv.adjustedContentInset.top
            if let v = cmd.axisOffset(horizontal: horizontal) { return clamp(cv, -start + max(0, v)) }
            guard let flat = znScrollTarget(cmd, shape), let it = shape.item(flat),
                  let a = cv.collectionViewLayout.layoutAttributesForItem(at: IndexPath(item: it.item, section: it.part.rawValue))
            else { return nil }
            let viewOffset = cmd.action == .index ? cmd.second : 0
            return clamp(cv, main(a.frame.origin) - start - viewOffset)
        }

        private func offset(_ cv: UICollectionView, _ v: CGFloat) -> CGPoint {
            horizontal ? CGPoint(x: v, y: cv.contentOffset.y) : CGPoint(x: cv.contentOffset.x, y: v)
        }

        private func run(_ cmd: ZnScrollCommand, _ cv: UICollectionView) {
            // A fling still going stops first.
            cv.setContentOffset(cv.contentOffset, animated: false)
            cv.layoutIfNeeded()
            guard let first = target(cmd, cv) else { return }
            print("zn t=\(ZnDebug.ms()) list: command \(cmd.action) \(cmd.param) seq \(cmd.seq) → offset \(first)\(cmd.animated ? " (animated)" : "")")
            if cmd.animated {
                settling = (cmd, 3)
                cv.setContentOffset(offset(cv, first), animated: true)
                return
            }
            // Far rows have estimated sizes until they are laid out: go there, lay out, and correct (a few times at most).
            var to = first
            for _ in 0..<4 {
                cv.setContentOffset(offset(cv, to), animated: false)
                cv.layoutIfNeeded()
                guard let again = target(cmd, cv), abs(again - to) > 0.5 else { break }
                to = again
            }
        }

        func scrollViewDidEndScrollingAnimation(_ sv: UIScrollView) {
            guard let cv = sv as? UICollectionView, let st = settling else { return }
            let (cmd, tries) = st
            settling = nil
            // The target's rows are measured now: if it moved, go on to where it really is.
            guard tries > 0, let to = target(cmd, cv), abs(to - main(cv.contentOffset)) > 1 else { return }
            print("zn t=\(ZnDebug.ms()) list: command seq \(cmd.seq) corrected → offset \(to)")
            settling = (cmd, tries - 1)
            cv.setContentOffset(offset(cv, to), animated: true)
        }

        func scrollViewWillBeginDragging(_ sv: UIScrollView) {
            settling = nil  // the user took over
        }
    }
}

/// RN stickyHeaderIndices on the UIKit list: the last sticky row that has scrolled past the top stays pinned there
/// (above the other rows), and the next sticky row pushes it up as it arrives, as Compose's stickyHeader does on
/// Android. The cell itself moves (no copy), so it keeps its presses and state. Only the pinned row is added to the
/// rows on screen; the others are where the list puts them. Rows are the list's rows section (ZnListPart.rows).
final class ZnStickyLayout: UICollectionViewCompositionalLayout {
    var sticky: [Int] = []
    private let rowsPart = ZnListPart.rows.rawValue

    private func rowCount() -> Int? {
        guard let cv = collectionView, cv.numberOfSections > rowsPart else { return nil }
        return cv.numberOfItems(inSection: rowsPart)
    }

    /// Row [i]'s frame as the list lays it out, before pinning.
    private func plain(_ i: Int) -> UICollectionViewLayoutAttributes? {
        super.layoutAttributesForItem(at: IndexPath(item: i, section: rowsPart))?.copy() as? UICollectionViewLayoutAttributes
    }

    /// The sticky row pinned now: the last one whose own frame starts at or above the top (nil: none yet).
    private func pinnedIndex(top: CGFloat, count: Int) -> Int? {
        var found: Int?
        for h in sticky where h < count {
            guard let a = plain(h), a.frame.minY <= top else { break }
            found = h
        }
        return found
    }

    private func pin(_ a: UICollectionViewLayoutAttributes, top: CGFloat, count: Int) {
        let i = a.indexPath.item
        guard let k = sticky.firstIndex(of: i) else { return }
        var y = max(a.frame.minY, top)
        if let next = sticky[safe: k + 1], next < count, let n = plain(next) { y = min(y, n.frame.minY - a.frame.height) }
        a.frame.origin.y = y
        a.zIndex = 1000 + k
    }

    override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
        let base = super.layoutAttributesForElements(in: rect)
        guard !sticky.isEmpty, let cv = collectionView, let count = rowCount() else { return base }
        let top = cv.contentOffset.y + cv.adjustedContentInset.top
        var attrs = (base ?? []).map { $0.copy() as! UICollectionViewLayoutAttributes }
        let isRow = { (a: UICollectionViewLayoutAttributes) in a.representedElementCategory == .cell && a.indexPath.section == self.rowsPart }
        if let p = pinnedIndex(top: top, count: count), !attrs.contains(where: { isRow($0) && $0.indexPath.item == p }), let a = plain(p) {
            attrs.append(a)
        }
        for a in attrs where isRow(a) { pin(a, top: top, count: count) }
        return attrs
    }

    override func layoutAttributesForItem(at ip: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard ip.section == rowsPart else { return super.layoutAttributesForItem(at: ip) }
        guard let a = plain(ip.item) else { return nil }
        if let cv = collectionView, sticky.contains(ip.item), let count = rowCount() {
            pin(a, top: cv.contentOffset.y + cv.adjustedContentInset.top, count: count)
        }
        return a
    }

    override func shouldInvalidateLayout(forBoundsChange b: CGRect) -> Bool {
        !sticky.isEmpty || super.shouldInvalidateLayout(forBoundsChange: b)
    }

    override func invalidationContext(forBoundsChange b: CGRect) -> UICollectionViewLayoutInvalidationContext {
        let c = super.invalidationContext(forBoundsChange: b)
        if let count = rowCount() {
            c.invalidateItems(at: sticky.filter { $0 < count }.map { IndexPath(item: $0, section: rowsPart) })
        }
        return c
    }
}
