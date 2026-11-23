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
import UniformTypeIdentifiers

struct ZnListRow: Equatable {
    let key: String
    let type: Int
}

/// A <List>'s rows. Observable: a row redraws when its instance arrives.
@Observable
final class ZnListState {
    var rows: [ZnListRow] = [] { didSet { indexOf = nil; version &+= 1 } }
    /// Counts each change of [rows] (LIST_SET / LIST_SPLICE): the UIKit list hears a change that keeps the count (JS
    /// moved a row), and a drop's wait for JS knows whether JS has answered (ZnListReorder.swift).
    @ObservationIgnored private(set) var version = 0
    /// A row got its instance (the image preload looks again at the rows past the screen, ZnImagePreload.swift).
    @ObservationIgnored var onBind: (() -> Void)?
    /// Row key → its index in [rows], built when first asked after a change.
    @ObservationIgnored private var indexOf: [String: Int]?
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
            onBind?()
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

    /// The row with [key] now (its index and type), or nil when it is gone. Reads [rows], so a view that asks redraws
    /// when the rows change. A cell keeps its key while rows are added or removed around it (UIKit doesn't ask again
    /// for an item that only moved), so it finds where its row is now by the key, never by a remembered index.
    func row(_ key: String) -> (index: Int, row: ZnListRow)? {
        let rows = self.rows
        if indexOf == nil {
            var map = [String: Int](minimumCapacity: rows.count)
            for (i, r) in rows.enumerated() { map[r.key] = i }
            indexOf = map
        }
        guard let i = indexOf?[key], let r = rows[safe: i], r.key == key else { return nil }
        return (i, r)
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
    /// The list is reorderable now: a long press on a row picks it up, so the row's onLongPress is off (decision 7).
    var reorderRow = false

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
            .environment(\.znReorderRow, e.reorderRow)
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
        // useElementMotion (motion={m}): the element and the value m.follow(v) gave it (observed: a new one comes here).
        let element = s.elementNow(inst)
        let follow = element?.follow.source
        // RN's snapping and decelerationRate (registry 24, ZnScrollSnap.swift): from the slot when the compiler gave one.
        let snap = s.snapSlot >= 0 ? inst.slot(s.snapSlot).value.string : s.snap
        let stickyText = s.stickySlot >= 0 ? inst.slot(s.stickySlot).value.string : s.stickyHeaderIndices
        // Pinned rows: not sideways or in a grid (Android draws them only in a plain column).
        let sticky = s.horizontal || cols > 1 ? [] : znParseSticky(stickyText)
        switch ZnImpl.list {
        case .swiftUI:
            ZnLazyList(ctx: ctx, inst: inst, s: s, list: list, cols: cols, header: header, footer: footer, empty: empty,
                       command: command, padding: padding, element: element, follow: follow, sticky: sticky,
                       refreshing: s.refreshingNow(inst), snap: snap)
        case .uiKit:
            ZnCollectionList(ctx: ctx, inst: inst, s: s, list: list, count: list.rows.count, version: list.version,
                             sticky: sticky, refreshing: s.refreshingNow(inst), cols: cols, header: header, footer: footer,
                             empty: empty, command: command, padding: padding, element: element, follow: follow, snap: snap)
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

/// One row: its instance if JS mounted one, else a placeholder of its template (the row's type now, read by its key, so
/// a new type under the same key redraws the cell). Full width in a column; its own width in a sideways list, placed
/// in the list's height by alignItems.
struct ZnListRowView: View {
    let ctx: ZnContext
    let list: ZnListState
    let row: ZnListRow
    var horizontal = false
    var alignItems = -1

    var body: some View {
        let mounted = list.bound[row.key].flatMap { ctx.store.find($0) }
        let templateId = mounted?.templateId ?? list.row(row.key)?.row.type ?? row.type
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
    /// Items on screen, by their ids ("__zn_header", a row key, a grid line key): an index would go stale when rows
    /// are added or removed above an item that stays drawn.
    var shown = Set<String>()
    /// onEndReached was sent while the list had this many rows.
    var endSentAt = -1
    /// The first row key seen (an inverted list follows a new newest row, as Android's FollowNewestRow).
    var firstKey: String?
}

/// The SwiftUI list's drag to reorder (ZnListReorder.swift's rules): the order shown while dragging and after a drop
/// until JS answers (nil: JS's rows), the row being dragged.
@MainActor
@Observable
final class ZnLazyReorder {
    var shown: [ZnListRow]?
    @ObservationIgnored var dragging: String?
    @ObservationIgnored var wait = ZnReorderWait()
    @ObservationIgnored var timer: DispatchWorkItem?
    @ObservationIgnored let tick = UISelectionFeedbackGenerator()
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
    let element: ZnElementMotion?
    let follow: ZnSource?
    /// Pinned rows (stickyHeaderIndices), pull to refresh's `refreshing`, the snap rules' text: read in the parent body.
    let sticky: [Int]
    let refreshing: Bool
    let snap: String?
    @State private var visible = ZnVisibleRows()
    /// The scroll view (found by a probe in the stack): useElementMotion, pull to refresh, snapping, scroll events and
    /// offsets, as a <Scroll>'s (ZnScroll.swift).
    @StateObject private var scroll = ZnScrollDriver()
    @State private var values = ZnLazyListElement()
    @State private var reorder = ZnLazyReorder()

    private var shape: ZnListShape {
        ZnListShape(header: header != nil, empty: empty != nil, rows: list.rows.count, footer: footer != nil, cols: cols)
    }

    /// Drag to reorder: a plain column or row with no pinned rows (as the UIKit list and Android).
    private var canReorder: Bool { s.reorderable && sticky.isEmpty && cols == 1 }
    /// Flipped (row 0 at the bottom): vertical only, as the UIKit list.
    private var inverted: Bool { s.inverted && !s.horizontal }
    /// The scroll view is needed: fixed per template, so the probe never comes and goes.
    private var needsScrollView: Bool {
        s.motionSlot >= 0 || s.hasRefresh || s.listUsesScrollDriver || s.scrollCommandSlot >= 0 || s.inverted
    }

    var body: some View {
        // The rows shown: JS's, or the order a drag made until JS answers (reorder).
        let rows = canReorder ? (reorder.shown ?? list.rows) : list.rows
        let lineKeys = znLineKeys(rows.map(\.key), cols: cols)
        let _ = values.bind(horizontal: s.horizontal, total: shape.total,
                            flat: { [shape] id in item(id).map { shape.flat($0.part, $0.item) } },
                            id: { [shape] i in shape.item(i).flatMap { itemId($0, lineKeys) } })
        let keyboard = ZnKeyboardDismiss.of(s.keyboardDismissMode, vertical: !s.horizontal)
        // itemAnimation (a reorderable list's rows glide by default, as Android's "move").
        let animation = s.itemAnimation.flatMap { ["fade", "move"].contains($0) ? $0 : nil } ?? (canReorder ? "move" : nil)
        ScrollViewReader { proxy in
            let _ = values.proxy = proxy
            ScrollView(s.horizontal ? .horizontal : .vertical, showsIndicators: !s.horizontal) {
                Group {
                    if s.horizontal {
                        LazyHStack(alignment: znRowAlignment(s.alignItems).vertical, spacing: s.gap) {
                            items(rows, lineKeys, animation)
                        }
                    } else {
                        LazyVStack(spacing: s.gap, pinnedViews: sticky.isEmpty ? [] : [.sectionHeaders]) {
                            items(rows, lineKeys, animation)
                        }
                    }
                }
                .modifier(ZnLazyAnimate(on: animation != nil, keys: lineKeys))
                .coordinateSpace(.named(ZnLazyListElement.space))
                .background { if needsScrollView { ZnScrollFinder(driver: scroll) } }
                .padding(padding)
                // A drop between rows or past them lands where the drag has put the row.
                .modifier(ZnLazyDropArea(on: canReorder, list: self))
            }
            .modifier(ZnFlip(on: inverted))
            .scrollDismissesKeyboard(keyboard == .onDrag ? .immediately : keyboard == .interactive ? .interactively : .never)
            .modifier(ZnLazySnap(on: s.hasSnap, driver: scroll))
            .environment(\.znReorderRow, canReorder)
            .onAppear {
                values.set(element, scroll)  // back on screen: its readers and follow again
                values.follower.set(element == nil ? nil : follow)
            }
            .onChange(of: ZnLazyDriven(refreshing: refreshing, snap: snap), initial: true) { _, now in drive(now) }
            .onChange(of: command, initial: true) { _, text in run(text, proxy, lineKeys) }
            .onChange(of: element.map(ObjectIdentifier.init), initial: true) { values.set(element, scroll) }
            .onChange(of: follow.map(ObjectIdentifier.init), initial: true) { values.follower.set(element == nil ? nil : follow) }
            .onChange(of: list.version) { jsRowsChanged() }
            .onChange(of: rows.first?.key) { _, first in followNewest(first, proxy) }
            .onDisappear { values.set(nil, scroll) }
        }
    }

    @ViewBuilder
    private func items(_ rows: [ZnListRow], _ lineKeys: [String], _ animation: String?) -> some View {
        if header != nil {
            ZnListExtraView(ctx: ctx, list: list, part: .header, horizontal: s.horizontal, alignItems: s.alignItems)
                .modifier(ZnFlip(on: inverted)).id("__zn_header").modifier(seen("__zn_header"))
        }
        if rows.isEmpty, empty != nil {
            ZnListExtraView(ctx: ctx, list: list, part: .empty, horizontal: s.horizontal, alignItems: s.alignItems)
                .modifier(ZnFlip(on: inverted)).id("__zn_empty").modifier(seen("__zn_empty"))
        }
        // Identified by key (a grid line by its line key), so a new numColumns builds new lines rather than keeping
        // the old ones at the same places (seen 2026-11-21: lines of 2 left in a 3-column grid).
        if cols > 1 {
            ForEach(Array(lineKeys.enumerated()), id: \.element) { g, key in
                ZnGridLineView(ctx: ctx, list: list, first: rows[safe: g * cols]?.key ?? "", cols: cols, wrapper: s.columnWrapper)
                    .modifier(ZnFlip(on: inverted)).id(key).modifier(seen(key))
                    .transition(animation == "fade" ? .opacity : .identity)
            }
        } else if sticky.isEmpty || s.horizontal {
            ForEach(rows, id: \.key) { row in rowView(row, animation) }
        } else {
            // Pinned rows (RN stickyHeaderIndices): each pinned row heads a section of the rows up to the next one, and
            // SwiftUI pins a section's header at the top until the next header pushes it up (Compose's stickyHeader).
            let runs = znStickyRuns(sticky, rows: rows.count)
            ForEach(rows[0..<runs.lead], id: \.key) { row in rowView(row, animation) }
            ForEach(runs.sections, id: \.pinned) { sec in
                if let head = rows[safe: sec.pinned] {
                    Section {
                        ForEach(rows[sec.rows], id: \.key) { row in rowView(row, animation) }
                    } header: {
                        rowView(head, nil)
                    }
                }
            }
        }
        if footer != nil {
            ZnListExtraView(ctx: ctx, list: list, part: .footer, horizontal: s.horizontal, alignItems: s.alignItems)
                .modifier(ZnFlip(on: inverted)).id("__zn_footer").modifier(seen("__zn_footer"))
        }
    }

    private func rowView(_ row: ZnListRow, _ animation: String?) -> some View {
        ZnListRowView(ctx: ctx, list: list, row: row, horizontal: s.horizontal, alignItems: s.alignItems)
            .modifier(ZnFlip(on: inverted))
            .id(row.key).modifier(seen(row.key))
            .transition(animation == "fade" ? .opacity : .identity)
            .modifier(ZnLazyDrag(on: canReorder, key: row.key, list: self))
    }

    private func seen(_ id: String) -> ZnSeen {
        let values = values
        // The frames are watched on a list that can have an element at all (fixed per node): a branch on the element
        // itself, which comes a frame after the rows, would make every row new (onAppear again, onRange again).
        return ZnSeen(appear: { visible.shown.insert(id); report() },
                      disappear: { visible.shown.remove(id); values.frames[id] = nil; report() },
                      place: s.motionSlot < 0 ? nil : { values.placed(id, $0) })
    }

    /// An id on screen → its part and item now (nil: gone from the list).
    private func item(_ id: String) -> (part: ZnListPart, item: Int)? {
        switch id {
        case "__zn_header": return (.header, 0)
        case "__zn_empty": return (.empty, 0)
        case "__zn_footer": return (.footer, 0)
        default:
            let line = id.hasPrefix("__zn_g:")
            guard let r = list.row(line ? String(id.dropFirst(7)) : id)?.index else { return nil }
            return (.rows, line ? r / max(cols, 1) : r)
        }
    }

    private func report() {
        let items = visible.shown.compactMap(item)
        guard !items.isEmpty else { return }
        let n = list.rows.count
        // A pinned row shows above rows far below it: left out (as the UIKit list and Android).
        let (a, b) = znVisibleRange(items, rows: n, cols: cols, pinned: Set(sticky))
        znSendRange(ctx, inst, s, list, a, b)
        // Near the end: ask JS for more (onEndReached), once per list length, as Android does.
        if s.onEndReached != 0, n > 0, b >= n - znEndReachedRows, visible.endSentAt != n {
            visible.endSentAt = n
            ctx.send(inst.id, s.onEndReached, .none)
        }
    }

    // MARK: Scroll view (refresh, snapping, events, offsets)

    /// Pull to refresh, the snap rules and decelerationRate, scroll events: a <Scroll>'s driver on SwiftUI's scroll view
    /// (it attaches when the probe finds it). Commands stay the list's own (run below).
    private func drive(_ now: ZnLazyDriven, tries: Int = 20) {
        guard s.hasRefresh || s.listUsesScrollDriver else { return }
        scroll.configure(ctx: ctx, s: s, inst: inst)
        scroll.update(refreshing: now.refreshing, snap: now.snap, command: nil)
        // The refresh control goes into the scroll view at an update after it is found (the probe finds it a moment
        // after the first draw): until then, again a little later.
        if scroll.sv == nil, tries > 0 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { drive(now, tries: tries - 1) }
        }
    }

    /// Moves SwiftUI's scroll view to [to] along the list (from the content's start: the padding counts), kept inside
    /// the content. False before the scroll view is found.
    @discardableResult
    private func scrollTo(_ to: Double, animated: Bool) -> Bool {
        guard let sv = scroll.sv, let m = scroll.metrics() else { return false }
        let v = min(max(to, 0), m.max)
        var p = sv.contentOffset
        if s.horizontal { p.x = v - sv.adjustedContentInset.left } else { p.y = v - sv.adjustedContentInset.top }
        sv.setContentOffset(p, animated: animated)
        return true
    }

    /// A ref's command: index and end scroll to that item (its id), then index moves [viewOffset] further from the
    /// start; offset / to go to that offset on the scroll view (UIKit's, found by the probe: iOS 17 and 18 alike).
    private func run(_ text: String?, _ proxy: ScrollViewProxy, _ lineKeys: [String]) {
        guard let cmd = ZnScrollCommand(text), cmd.isNew(after: list.lastScrollSeq) else { return }
        list.lastScrollSeq = cmd.seq
        if let offset = cmd.axisOffset(horizontal: s.horizontal) {
            print("zn t=\(ZnDebug.ms()) list: command \(text ?? "") → offset \(offset)")
            if scrollTo(offset, animated: cmd.animated) { return }
            // Before the scroll view is found: only the start can be reached (its first item).
            if offset <= 0, let first = shape.item(0), let id = itemId(first, lineKeys) {
                proxy.scrollTo(id, anchor: s.horizontal ? .leading : .top)
            }
            return
        }
        guard let flat = znScrollTarget(cmd, shape), let it = shape.item(flat), let id = itemId(it, lineKeys) else { return }
        let end = cmd.action == .end
        let anchor: UnitPoint = s.horizontal ? (end ? .trailing : .leading) : (end ? .bottom : .top)
        let viewOffset = cmd.action == .index ? cmd.second : 0
        print("zn t=\(ZnDebug.ms()) list: command \(text ?? "") → \(id)\(viewOffset != 0 ? " viewOffset \(viewOffset)" : "")")
        // viewOffset: once the item is at the start, the list moves that much back (RN: the item ends up further in).
        let then = { [scroll] in
            guard viewOffset != 0, let m = scroll.metrics() else { return }
            _ = scrollTo(m.offset - viewOffset, animated: cmd.animated)
        }
        if cmd.animated {
            withAnimation(.default, completionCriteria: .logicallyComplete) { proxy.scrollTo(id, anchor: anchor) } completion: { then() }
        } else {
            proxy.scrollTo(id, anchor: anchor)
            // SwiftUI moves the scroll view in its next update.
            DispatchQueue.main.async { DispatchQueue.main.async { then() } }
        }
    }

    private func itemId(_ it: (part: ZnListPart, item: Int), _ lineKeys: [String]) -> String? {
        switch it.part {
        case .header: return "__zn_header"
        case .empty: return "__zn_empty"
        case .footer: return "__zn_footer"
        case .rows: return cols > 1 ? lineKeys[safe: it.item] : list.rows[safe: it.item]?.key
        }
    }

    /// An inverted list (a chat) at its newest row keeps showing the newest row when one arrives (FollowNewestRow).
    private func followNewest(_ first: String?, _ proxy: ScrollViewProxy) {
        defer { visible.firstKey = first }
        guard inverted, let first, visible.firstKey != nil, first != visible.firstKey,
              let m = scroll.metrics(), m.offset <= 24 else { return }
        _ = scrollTo(0, animated: true)
    }

    // MARK: Reorder

    /// JS's rows changed: a drop's order gives way to them (JS moved the row, or changed the rows).
    private func jsRowsChanged() {
        guard reorder.shown != nil, reorder.dragging == nil else { return }
        if reorder.wait.keepsOrder(at: list.version) { return }
        reorder.timer?.cancel()
        reorder.shown = nil
    }

    /// The drag is over [key]'s row: the dragged row takes its place (the others make room).
    fileprivate func dragOver(_ key: String) {
        guard let dragged = reorder.dragging, dragged != key else { return }
        var r = reorder.shown ?? list.rows
        guard let from = r.firstIndex(where: { $0.key == dragged }), let to = r.firstIndex(where: { $0.key == key }) else { return }
        r.insert(r.remove(at: from), at: to)
        reorder.shown = r
        reorder.tick.selectionChanged()
    }

    fileprivate func dragStart(_ key: String) {
        reorder.timer?.cancel()
        reorder.dragging = key
        if reorder.shown == nil { reorder.shown = list.rows }
        reorder.tick.prepare()
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        print("zn t=\(ZnDebug.ms()) list: reorder picks \(key) (SwiftUI list)")
    }

    /// The drop: onReorder(from, to) (from: JS's index of the row; to: its place now), then the wait for JS.
    fileprivate func drop() {
        guard let key = reorder.dragging else { return }
        reorder.dragging = nil
        let shown = reorder.shown ?? list.rows
        guard let to = shown.firstIndex(where: { $0.key == key }), let from = list.row(key)?.index else { return }
        guard from != to else {
            reorder.shown = nil
            return
        }
        print("zn t=\(ZnDebug.ms()) list: reorder drops \(key) \(from) → \(to), waiting for JS (SwiftUI list)")
        reorder.wait.version = list.version
        let (reorder, list) = (reorder, list)
        let work = DispatchWorkItem {
            guard reorder.wait.timedOut(at: list.version) else { return }
            print("zn t=\(ZnDebug.ms()) list: reorder: JS kept its order, the row goes back (SwiftUI list)")
            reorder.shown = nil
        }
        reorder.timer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ZnReorderWait.ms), execute: work)
        if s.onReorder != 0 { ctx.send(inst.id, s.onReorder, .string("\(from),\(to)")) }
    }
}

/// The values the SwiftUI list hands its scroll driver (one change key for onChange).
struct ZnLazyDriven: Equatable {
    let refreshing: Bool
    let snap: String?
}

/// itemAnimation on the SwiftUI list: a change of the rows springs (no bounce, as Compose's animateItem); a list
/// without it gets no animation modifier at all.
private struct ZnLazyAnimate: ViewModifier {
    let on: Bool
    let keys: [String]

    func body(content: Content) -> some View {
        if on { content.animation(.spring(duration: 0.35, bounce: 0), value: keys) } else { content }
    }
}

/// RN inverted on the SwiftUI list: the scroll view flipped, each item flipped back (row 0 at the bottom).
private struct ZnFlip: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        if on { content.scaleEffect(x: 1, y: -1) } else { content }
    }
}

/// Snapping with Android's rules (ZnSnapBehavior, ZnScroll.swift), on a list with snap rules.
private struct ZnLazySnap: ViewModifier {
    let on: Bool
    let driver: ZnScrollDriver

    func body(content: Content) -> some View {
        if on { content.scrollTargetBehavior(ZnSnapBehavior(driver: driver)) } else { content }
    }
}

/// A row of a reorderable SwiftUI list: a long press lifts it (SwiftUI's onDrag), and the drag over it moves it.
private struct ZnLazyDrag: ViewModifier {
    let on: Bool
    let key: String
    let list: ZnLazyList

    func body(content: Content) -> some View {
        if on {
            content
                .onDrag {
                    list.dragStart(key)
                    return NSItemProvider(object: key as NSString)
                }
                .onDrop(of: [.text], delegate: ZnLazyDrop(key: key, list: list))
        } else {
            content
        }
    }
}

/// A reorderable list's whole content takes the drop (between rows, past the last one).
private struct ZnLazyDropArea: ViewModifier {
    let on: Bool
    let list: ZnLazyList

    func body(content: Content) -> some View {
        if on { content.onDrop(of: [.text], delegate: ZnLazyDrop(key: nil, list: list)) } else { content }
    }
}

/// Drops on a row ([key]) or anywhere in the list (nil).
private struct ZnLazyDrop: DropDelegate {
    let key: String?
    let list: ZnLazyList

    func dropEntered(info: DropInfo) {
        if let key { list.dragOver(key) }
    }

    func dropUpdated(info: DropInfo) -> DropProposal? { DropProposal(operation: .move) }

    func performDrop(info: DropInfo) -> Bool {
        list.drop()
        return true
    }
}

/// A SwiftUI list item's appear / disappear.
private struct ZnSeen: ViewModifier {
    let appear: () -> Void
    let disappear: () -> Void
    /// Its frame in the stack, for useElementMotion's index / offset (only on a list with a motion slot).
    var place: ((CGRect) -> Void)?

    func body(content: Content) -> some View {
        if let place {
            content.onAppear(perform: appear).onDisappear(perform: disappear)
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(ZnLazyListElement.space)) } action: { place($0) }
        } else {
            content.onAppear(perform: appear).onDisappear(perform: disappear)
        }
    }
}

/// The SwiftUI list's useElementMotion values (as the UIKit list's: index, offset, scrollY / scrollX; no pull, it has no
/// pull to refresh), from its scroll view (ZnScrollDriver, found by ZnScrollFinder) and its items' frames in the stack.
@MainActor
final class ZnLazyListElement {
    static let space = "znLazyList"
    let follower = ZnFollower()
    var proxy: ScrollViewProxy?
    /// The items on screen: their start and size along the list, in the stack (inside the padding).
    var frames: [String: (start: CGFloat, size: CGFloat)] = [:]
    private var element: ZnElementMotion?
    private weak var sv: UIScrollView?
    private var horizontal = false
    private var total = 0
    private var flat: (String) -> Int? = { _ in nil }
    private var idOf: (Int) -> String? = { _ in nil }
    private let index = ZnCell(0), within = ZnCell(0), along = ZnCell(0)

    /// The list's shape now (each body run).
    func bind(horizontal: Bool, total: Int, flat: @escaping (String) -> Int?, id: @escaping (Int) -> String?) {
        self.horizontal = horizontal
        self.total = total
        self.flat = flat
        idOf = id
    }

    func set(_ e: ZnElementMotion?, _ driver: ZnScrollDriver) {
        guard e !== element else { return }
        if let old = element { for n in ["index", "offset", "scrollX", "scrollY"] { ZnProvided.release(old.lambda(n), by: self) } }
        element = e
        if let e {
            let (index, within, along) = (index, within, along)
            ZnProvided.provide(e.lambda("index"), by: self) { index.v }
            ZnProvided.provide(e.lambda("offset"), by: self) { within.v }
            ZnProvided.provide(e.lambda(horizontal ? "scrollX" : "scrollY"), by: self) { along.v }
            driver.onScroll = { [weak self] sv in self?.scrolled(sv) }
            follower.apply = { [weak self] v in self?.followTo(v) ?? false }
        } else {
            driver.onScroll = nil
            follower.set(nil)
        }
    }

    func placed(_ id: String, _ r: CGRect) {
        let f = horizontal ? (start: r.minX, size: r.width) : (start: r.minY, size: r.height)
        frames[id] = f
        // The item a follow just went to moved (the stack settles rows near a jump a pass later): go where it really
        // is now, a few times at most. Only a move: an item placed again where it was (the user scrolled it out and
        // back) doesn't pull the list back.
        if let c = fresh(), c.id == id, abs(c.start - f.start) > 0.5 || abs(c.size - f.size) > 0.5 { correct(c) }
        if let sv { scrolled(sv) }
    }
    /// The follow just applied, while its item may still move (see placed) or SwiftUI may still move the list: a
    /// ScrollViewReader.scrollTo that brought the item on screen lands again a pass after the exact offset was set.
    private var correcting: (id: String, v: Float, tries: Int, start: CGFloat, size: CGFloat, to: CGFloat)?

    /// Only for half a second after the follow applied (a scroll command after it must not be pulled back).
    private var correctUntil: CFTimeInterval = 0
    private func fresh() -> (id: String, v: Float, tries: Int, start: CGFloat, size: CGFloat, to: CGFloat)? {
        CACurrentMediaTime() < correctUntil ? correcting : nil
    }

    private func correct(_ c: (id: String, v: Float, tries: Int, start: CGFloat, size: CGFloat, to: CGFloat)) {
        correcting = c.tries > 1 ? (c.id, c.v, c.tries - 1, c.start, c.size, c.to) : nil
        _ = followTo(c.v, again: true)
    }

    private func main(_ p: CGPoint) -> CGFloat { horizontal ? p.x : p.y }

    private func scrolled(_ sv: UIScrollView) {
        self.sv = sv
        guard element != nil else { return }
        // A follow that came before the scroll view was found, or before its item was placed, applies now.
        defer { follower.check() }
        // Moved off the follow's offset by something other than the user (SwiftUI's scrollTo landing late): back.
        if let c = fresh(), !sv.isTracking, !sv.isDecelerating, abs(main(sv.contentOffset) - c.to) > 0.5 { correct(c) }
        if sv.isTracking { correcting = nil }  // the user's scroll wins
        let i = sv.adjustedContentInset
        let start = horizontal ? i.left : i.top, end = horizontal ? i.right : i.bottom
        let content = horizontal ? sv.contentSize.width : sv.contentSize.height
        let viewport = horizontal ? sv.bounds.width : sv.bounds.height
        let at = min(max(main(sv.contentOffset) + start, 0), max(0, content + start + end - viewport))
        along.write(Float(at))
        let starts: [(item: Int, start: Double)] = frames.compactMap { id, f in flat(id).map { ($0, Double(f.start)) } }
        guard let p = ZnElementRules.listPosition(at: Double(at), starts: starts) else { return }
        index.write(Float(p.item))
        within.write(Float(p.offset))
    }

    /// m.follow(v): an item on screen goes exactly there (with its fraction); one that isn't drawn yet is brought to the
    /// start by ScrollViewReader, and the value waits until it is placed (then its fraction applies). False until then.
    private func followTo(_ v: Float, again: Bool = false) -> Bool {
        guard let (i, f) = ZnElementRules.listFollow(Double(v), total: total), let id = idOf(i) else { return true }
        guard let sv, let place = frames[id] else {
            if !again { correcting = nil }
            proxy?.scrollTo(id, anchor: horizontal ? .leading : .top)
            return false
        }
        let old = correcting
        let inset = sv.adjustedContentInset
        let start = horizontal ? inset.left : inset.top, end = horizontal ? inset.right : inset.bottom
        let content = horizontal ? sv.contentSize.width : sv.contentSize.height
        let viewport = horizontal ? sv.bounds.width : sv.bounds.height
        // At [place.start] from the start the item sits just below the padding, as Compose's scrollToItem.
        let to = min(max(place.start + CGFloat(f) * place.size - start, -start), max(-start, content + end - viewport))
        var o = sv.contentOffset
        if horizontal { o.x = to } else { o.y = to }
        correcting = again ? old.map { ($0.id, $0.v, $0.tries, place.start, place.size, to) } : (id, v, 3, place.start, place.size, to)
        if !again { correctUntil = CACurrentMediaTime() + 0.5 }
        if abs(main(o) - main(sv.contentOffset)) > 0.25 { sv.setContentOffset(o, animated: false) }
        return true
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
    /// ZnListState.version: a change that keeps the count (JS moved a row) reaches updateUIView too.
    let version: Int
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
    let element: ZnElementMotion?
    let follow: ZnSource?
    /// The snap rules' text now (ZnSnap), or nil.
    let snap: String?

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
        // RN keyboardDismissMode (Android's znKeyboardDismiss): UIKit's own, as a <Scroll>'s.
        switch ZnKeyboardDismiss.of(s.keyboardDismissMode, vertical: !s.horizontal) {
        case .onDrag: cv.keyboardDismissMode = .onDrag
        case .interactive: cv.keyboardDismissMode = .interactive
        case .none: cv.keyboardDismissMode = .none
        }
        // <List reorderable>: UIKit's drag and drop moves the rows (ZnListReorder.swift); on only while it can reorder.
        if s.reorderable {
            cv.dragDelegate = c
            cv.dropDelegate = c
            cv.reorderingCadence = .immediate
        }
        cv.onLayout = { [weak c, weak cv] in
            guard let c, let cv else { return }
            MainActor.assumeIsolated {
                c.runPending(cv)
                c.laidOut(cv)
            }
        }
        return cv
    }

    func updateUIView(_ cv: ZnListCollectionView, context: Context) {
        let c = context.coordinator
        c.ctx = ctx; c.inst = inst; c.s = s; c.list = list
        // Drag to reorder: a plain column or row, no pinned rows (they can't move), as Android's ZnReorder.
        c.canReorder = s.reorderable && sticky.isEmpty && cols == 1
        if cv.dragInteractionEnabled != c.canReorder { cv.dragInteractionEnabled = c.canReorder }
        // The environment the cells need (a UIHostingConfiguration cell doesn't inherit it).
        var env = ZnHostedEnv(context.environment)
        env.reorderRow = c.canReorder
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
            layout?.padTop = s.horizontal ? 0 : padding.top
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
        c.element(element, follow: follow, cv)
        // RN's snapping, decelerationRate and scroll events (registry 24): a <Scroll>'s driver on this collection view,
        // without its refresh control (the list has its own) or its commands (the list runs its own).
        if s.listUsesScrollDriver {
            c.scroll.configure(ctx: ctx, s: s, inst: inst, ownsRefresh: false)
            c.scroll.attach(cv)
            c.scroll.update(refreshing: false, snap: snap, command: nil)
        }
        c.preloadAhead(cv)
    }

    static func dismantleUIView(_ cv: ZnListCollectionView, coordinator c: Coordinator) {
        c.element(nil, follow: nil, cv)
        c.scroll.detach()
        c.endReorderWait()
        c.list?.onBind = nil
        ZnImagePreload.shared.cancel(owner: c.preloadOwner)
    }

    /// The rows and extras: inserts and removals in one batch when they are few, else a reload.
    private func update(_ cv: ZnListCollectionView, _ c: Coordinator, _ layout: ZnStickyLayout?) {
        let rows = list.rows
        let shape = ZnListShape(header: header != nil, empty: empty != nil, rows: rows.count, footer: footer != nil, cols: cols)
        // A drop waits for JS: the order shown stays until JS's rows change (ZnListReorder.swift).
        if c.reorderWait.keepsOrder(at: list.version) && shape.rows == c.shape.rows { return }
        let keys = znLineKeys(rows.map(\.key), cols: cols)
        guard c.keys != keys || c.shape != shape else {
            if c.rows != rows { c.rows = rows }  // a row's type changed under the same key
            return
        }
        // itemAnimation; a reorderable list's rows glide by default (Android: "move").
        let animation = s.itemAnimation.flatMap { ["fade", "move"].contains($0) ? $0 : nil } ?? (c.canReorder ? "move" : nil)
        c.apply(cv, rows: rows, keys: keys, shape: shape, animation: animation)
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
        /// Snapping, decelerationRate and scroll events (a <Scroll>'s, ZnScroll.swift), when the list has any.
        let scroll = ZnScrollDriver()
        /// Drag to reorder (ZnListReorder.swift): on now, the wait for JS after a drop, the drop place last shown.
        var canReorder = false
        var reorderWait = ZnReorderWait()
        var reorderTimer: DispatchWorkItem?
        var dropShown: IndexPath?
        let dropTick = UISelectionFeedbackGenerator()
        /// The image preload (ZnImagePreload.swift): this list's id there, and the direction it last moved.
        lazy var preloadOwner = ObjectIdentifier(self).hashValue
        var preloadFirst = -1
        var preloadForward = true
        var preloadAsked: [UInt32] = []
        var preloadSoon = false
        weak var preloadHooked: ZnListState?

        // MARK: Updates

        /// Shows [rows] (their [keys]: line keys in a grid) and [shape]: in one batch when the changes are few, else a
        /// reload. [animation] ("fade" / "move", itemAnimation): the rows glide to their new places (moves found by
        /// key) and fade in and out ("fade"); without it nothing animates and the first visible item keeps its place.
        func apply(_ cv: UICollectionView, rows: [ZnListRow], keys: [String], shape: ZnListShape, animation: String?) {
            let old = self.keys, oldShape = self.shape
            let layout = cv.collectionViewLayout as? ZnStickyLayout
            // The first visible item stays where it is on screen (Home: "New payment arrives" inserts at the top, and
            // the rows being read must not move), as on Android, where LazyColumn keeps the first visible key in place.
            let anchor = anchor(cv)
            let rowsPart = ZnListPart.rows.rawValue
            var plan: ZnListUpdates?
            if oldShape.cols == shape.cols {
                if animation != nil {
                    plan = znListUpdates(old, keys)
                } else if let (removed, inserted) = znChangedRanges(old, keys), removed.count + inserted.count <= 200 {
                    plan = ZnListUpdates(deletes: Array(removed), inserts: Array(inserted))
                }
            }
            // An inverted list (a chat) at its newest row follows a new newest row, as Android's FollowNewestRow (at
            // most 24 pt from the start counts as there); else the new row would sit unseen below the screen.
            let atStart = main(cv.contentOffset) + (horizontal ? cv.adjustedContentInset.left : cv.adjustedContentInset.top) <= 24
            let follow = s?.inverted == true && !horizontal && atStart && !old.isEmpty && keys.first != old.first
            // Animated only when a change shows: one wholly above the first row on screen keeps the place instead.
            let firstShown = cv.indexPathsForVisibleItems.filter { $0.section == rowsPart }.map(\.item).min()
            let animate = animation != nil && plan.map { p in follow || (firstShown.map { !p.onlyBefore($0) } ?? true) } == true
            print("zn t=\(ZnDebug.ms()) list: \(old.count) → \(keys.count) \(shape.cols > 1 ? "lines (\(shape.cols) columns)" : "rows"), changed \(plan.map { "-\($0.deletes.count) +\($0.inserts.count) moved \($0.moves.count)" } ?? "all"), extras \(extrasText(shape)), \(animate ? "animated (\(animation!))" : "anchor \(anchor.map { "\($0.key) at \($0.at)" } ?? "none")")")
            if let plan {
                // The data source changes inside the update block, never before it: UIKit reads the item count before
                // and after, and they must differ by exactly these updates (crashed on 30 older chat messages,
                // 2026-11-08, when the count was read early).
                cv.layoutIfNeeded()
                let batch = {
                    cv.performBatchUpdates {
                        self.keys = keys; self.rows = rows; self.shape = shape
                        cv.deleteItems(at: plan.deletes.map { IndexPath(item: $0, section: rowsPart) })
                        cv.insertItems(at: plan.inserts.map { IndexPath(item: $0, section: rowsPart) })
                        for m in plan.moves {
                            cv.moveItem(at: IndexPath(item: m.from, section: rowsPart), to: IndexPath(item: m.to, section: rowsPart))
                        }
                        for part in [ZnListPart.header, .empty, .footer] {
                            let (was, now) = (oldShape.count(part), shape.count(part))
                            if was > now { cv.deleteItems(at: [IndexPath(item: 0, section: part.rawValue)]) }
                            if now > was { cv.insertItems(at: [IndexPath(item: 0, section: part.rawValue)]) }
                        }
                    }
                }
                if animate {
                    // Compose's animateItem springs (no bounce); "move": no fade (ZnStickyLayout).
                    layout?.itemAnimation = animation
                    UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0,
                                   options: [.allowUserInteraction, .beginFromCurrentState], animations: batch)
                } else {
                    UIView.performWithoutAnimation(batch)
                }
            } else {
                self.keys = keys; self.rows = rows; self.shape = shape
                cv.reloadData()
            }
            // The gap before each part depends on which parts have items (ZnListShape.gapBefore).
            if ZnListPart.allCases.contains(where: { oldShape.gapBefore($0) != shape.gapBefore($0) }) { layout?.invalidateLayout() }
            // Restoring the place mid-animation would fight the glide; an animated change is one the user sees.
            if follow {
                cv.setContentOffset(offset(cv, -cv.adjustedContentInset.top), animated: animate)
            } else if !animate {
                restore(cv, anchor)
            }
            // Android sends the range when it changes, also without a scroll (rows added, the columns changed).
            if !cv.bounds.isEmpty {
                if !animate { cv.layoutIfNeeded() }
                report(cv)
            }
        }

        private func extrasText(_ shape: ZnListShape) -> String {
            let names = [shape.header ? "header" : nil, shape.count(.empty) > 0 ? "empty" : nil, shape.footer ? "footer" : nil].compactMap { $0 }
            return names.isEmpty ? "none" : names.joined(separator: "+")
        }

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
                    // The line's first row key, not its index: UIKit keeps this cell when rows are added or removed
                    // above it, so an index would draw the wrong rows.
                    let (first, wrapper) = (rows[safe: ip.item * cols]?.key ?? "", s.columnWrapper)
                    cell.contentConfiguration = UIHostingConfiguration {
                        ZnHostedEnvView(box: box) { ZnGridLineView(ctx: ctx, list: list, first: first, cols: cols, wrapper: wrapper) }
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
            writeElement(cv)
            preloadAhead(cv)
        }

        /// A released drag with snap rules stops where Android's would (ZnSnap.pick through the scroll driver, which
        /// takes SwiftUI's target: the content offset plus the inset before it).
        func scrollViewWillEndDragging(_ sv: UIScrollView, withVelocity velocity: CGPoint,
                                       targetContentOffset: UnsafeMutablePointer<CGPoint>) {
            guard s?.hasSnap == true, scroll.sv === sv else { return }
            let i = sv.adjustedContentInset
            var origin = targetContentOffset.pointee
            origin.x += i.left
            origin.y += i.top
            scroll.snapTarget(&origin)
            targetContentOffset.pointee = CGPoint(x: origin.x - i.left, y: origin.y - i.top)
        }

        // MARK: Element values (useElementMotion)

        /// The element this List fills (motion={m}): index, offset, scrollY (scrollX sideways) and pull, as cells its
        /// readers read; m.follow(v) scrolls to item v.
        private var element: ZnElementMotion?
        private let index = ZnCell(0), within = ZnCell(0), along = ZnCell(0), pull = ZnCell(0)
        private lazy var follower = ZnFollower()
        private weak var followed: UICollectionView?
        /// The top inset when not refreshing (UIKit adds the spinner's height while refreshing).
        private var restTop: CGFloat = 0

        func element(_ e: ZnElementMotion?, follow: ZnSource?, _ cv: UICollectionView) {
            if e !== element {
                if let old = element {
                    for n in ["index", "offset", "scrollX", "scrollY", "pull"] { ZnProvided.release(old.lambda(n), by: self) }
                }
                element = e
                if let e {
                    let (index, within, along, pull) = (index, within, along, pull)
                    ZnProvided.provide(e.lambda("index"), by: self) { index.v }
                    ZnProvided.provide(e.lambda("offset"), by: self) { within.v }
                    ZnProvided.provide(e.lambda(horizontal ? "scrollX" : "scrollY"), by: self) { along.v }
                    if refresh != nil { ZnProvided.provide(e.lambda("pull"), by: self) { pull.v } }
                }
            }
            followed = cv
            follower.apply = { [weak self] v in
                guard let self, let cv = self.followed else { return false }
                guard self.followTo(v, cv) else { return false }
                // From the items laid out where it landed (its scrolls don't follow again).
                self.applying = true
                self.writeElement(cv)
                self.applying = false
                return true
            }
            follower.set(e == nil ? nil : follow)
            writeElement(cv)
        }

        /// A layout: a follow still waiting for the list's size or its item applies (cheap when nothing waits); the
        /// values are written at the first one with a size.
        func laidOut(_ cv: UICollectionView) {
            guard element != nil, !cv.bounds.isEmpty else { return }
            if laid { return applying ? () : follower.check() }
            laid = true
            writeElement(cv)
        }
        private var laid = false

        /// How far the list is scrolled from its start (its padding's start), in points, kept inside the content.
        private func scrolled(_ cv: UICollectionView) -> CGFloat {
            let i = cv.adjustedContentInset
            if refresh?.control.isRefreshing != true { restTop = i.top }
            let start = horizontal ? i.left : restTop
            let end = horizontal ? i.right : i.bottom
            let content = horizontal ? cv.contentSize.width : cv.contentSize.height
            let viewport = horizontal ? cv.bounds.width : cv.bounds.height
            return min(max(main(cv.contentOffset) + start, 0), max(0, content + start + end - viewport))
        }

        /// index: the item (header, empty, row or grid line, footer: Android's lazy items) at the scroll position;
        /// offset: how far that item is scrolled past (Compose's firstVisibleItemIndex / ScrollOffset). Pinned rows
        /// are left out (they sit at the top wherever the list is). scrollY: exact, not Android's estimate.
        func writeElement(_ cv: UICollectionView) {
            guard element != nil, !cv.bounds.isEmpty else { return }
            // A follow that came before the list had a size applies now (a scroll, an update, a layout come here).
            if !applying { follower.check() }
            let at = scrolled(cv)
            along.write(Float(at))
            if let refresh { pull.write(refresh.pull(cv)) }
            let rowsPart = ZnListPart.rows.rawValue
            let items = cv.indexPathsForVisibleItems.filter { !($0.section == rowsPart && sticky.contains($0.item)) }.sorted()
            let starts: [(item: Int, start: Double)] = items.compactMap { ip in
                guard let part = ZnListPart(rawValue: ip.section),
                      let a = cv.collectionViewLayout.layoutAttributesForItem(at: ip) else { return nil }
                return (shape.flat(part, ip.item), Double(main(a.frame.origin)))
            }
            guard let p = ZnElementRules.listPosition(at: Double(at), starts: starts) else { return }
            index.write(Float(p.item))
            within.write(Float(p.offset))
        }

        /// m.follow(v): item floor(v) at the list's start, (v - floor(v)) of its size further (3.5: half way through
        /// item 3), kept inside the content. Far items may have estimated sizes until they are laid out.
        /// False before the list has a size or its items (writeElement tries again).
        private func followTo(_ v: Float, _ cv: UICollectionView) -> Bool {
            guard !cv.bounds.isEmpty, cv.window != nil else { return false }
            guard let (i, f) = ZnElementRules.listFollow(Double(v), total: shape.total), let it = shape.item(i) else { return true }
            let ip = IndexPath(item: it.item, section: it.part.rawValue)
            // Where item i, f of its size in, sits at the list's start (below the padding).
            func target() -> CGFloat? {
                guard let a = (cv.collectionViewLayout as? ZnStickyLayout)?.unpinned(ip)
                        ?? cv.collectionViewLayout.layoutAttributesForItem(at: ip) else { return nil }
                let size = horizontal ? a.frame.width : a.frame.height
                // The start without the spinner's height while refreshing, as scrolled() reads it (index / offset agree).
                _ = scrolled(cv)
                let start = horizontal ? cv.adjustedContentInset.left : restTop
                return clamp(cv, main(a.frame.origin) + CGFloat(f) * size - start)
            }
            guard var to = target() else { return false }
            // A far item has an estimated size and place until it is laid out (a jump, a follow set at mount): go there,
            // lay out, and correct, a few times at most (as a scroll command). The scrolls it causes don't follow again.
            applying = true
            defer { applying = false }
            for _ in 0..<4 {
                guard abs(to - main(cv.contentOffset)) > 0.25 else { break }
                cv.setContentOffset(offset(cv, to), animated: false)
                cv.layoutIfNeeded()
                guard let again = target() else { break }
                to = again
            }
            return true
        }
        /// Inside followTo: its own scrolls don't check the follow again.
        private var applying = false

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
            // A pinned row's own place, not where it is pinned now (ZnStickyLayout.unpinned).
            guard let flat = znScrollTarget(cmd, shape), let it = shape.item(flat) else { return nil }
            let ip = IndexPath(item: it.item, section: it.part.rawValue)
            guard let a = (cv.collectionViewLayout as? ZnStickyLayout)?.unpinned(ip)
                    ?? cv.collectionViewLayout.layoutAttributesForItem(at: ip)
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
                // Already there: no animation runs, so none ends to clear [settling].
                guard abs(first - main(cv.contentOffset)) > 0.5 else { settling = nil; return }
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
    /// The list's padding before the content (part of the scroll view's inset): a row pins at the visible top, above
    /// it, as Compose pins a stickyHeader at -beforeContentPadding.
    var padTop: CGFloat = 0
    private let rowsPart = ZnListPart.rows.rawValue

    private func rowCount() -> Int? {
        guard let cv = collectionView, cv.numberOfSections > rowsPart else { return nil }
        return cv.numberOfItems(inSection: rowsPart)
    }

    /// Item [ip]'s frame as the list lays it out, never pinned (a scroll command goes to a sticky row's own place).
    func unpinned(_ ip: IndexPath) -> UICollectionViewLayoutAttributes? {
        ip.section == rowsPart ? plain(ip.item) : super.layoutAttributesForItem(at: ip)
    }

    /// The top a row pins at: the visible top.
    private func pinTop(_ cv: UICollectionView) -> CGFloat { cv.contentOffset.y + cv.adjustedContentInset.top - padTop }

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
        let top = pinTop(cv)
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
            pin(a, top: pinTop(cv), count: count)
        }
        return a
    }

    // MARK: itemAnimation

    /// The animated update now ("fade" / "move"), set by Coordinator.apply just before it. "fade" keeps UIKit's own
    /// cross-fade for rows added and removed (Compose's animateItem); "move": an added row is there at once and a
    /// removed one gone at once, only the others glide (animateItem with no fade).
    var itemAnimation: String?
    private var added = Set<IndexPath>(), removed = Set<IndexPath>()

    override func prepare(forCollectionViewUpdates items: [UICollectionViewUpdateItem]) {
        super.prepare(forCollectionViewUpdates: items)
        added = []; removed = []
        for u in items {
            switch u.updateAction {
            case .insert: if let ip = u.indexPathAfterUpdate { added.insert(ip) }
            case .delete: if let ip = u.indexPathBeforeUpdate { removed.insert(ip) }
            default: break
            }
        }
    }

    override func finalizeCollectionViewUpdates() {
        super.finalizeCollectionViewUpdates()
        added = []; removed = []
        itemAnimation = nil
    }

    override func initialLayoutAttributesForAppearingItem(at ip: IndexPath) -> UICollectionViewLayoutAttributes? {
        let a = super.initialLayoutAttributesForAppearingItem(at: ip)
        guard itemAnimation == "move", added.contains(ip), let c = a?.copy() as? UICollectionViewLayoutAttributes else { return a }
        c.alpha = 1
        return c
    }

    override func finalLayoutAttributesForDisappearingItem(at ip: IndexPath) -> UICollectionViewLayoutAttributes? {
        let a = super.finalLayoutAttributesForDisappearingItem(at: ip)
        guard itemAnimation == "move", removed.contains(ip), let c = a?.copy() as? UICollectionViewLayoutAttributes else { return a }
        c.isHidden = true
        return c
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
