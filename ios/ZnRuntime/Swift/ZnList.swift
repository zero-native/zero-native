// <List> on iOS, both ways (i.1c). Window protocol as android/runtime (docs/lists.md): native knows every row's key and
// type (LIST_SET / LIST_SPLICE); JS mounts instances only for a window of rows (LIST_ROW binds a key to one); native
// sends the visible range (onRange "a,b") so JS moves the window. A row without an instance draws its template with
// slot defaults (a placeholder): same height and look, never blank.
//
// SwiftUI variant: ScrollView + LazyVStack (rows are created lazily, never reused; the visible range comes from row
// onAppear / onDisappear). UIKit variant: UICollectionView with a list layout and UIHostingConfiguration cells (cells
// are reused; the visible range comes from indexPathsForVisibleItems).
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
    @ObservationIgnored private var keyOf: [UInt32: String] = [:]
    /// Last range sent to JS, so the same one isn't sent twice.
    @ObservationIgnored var sentRange = ""

    func bind(_ key: String, _ row: UInt32) {
        if let old = bound[key] { keyOf[old] = nil }
        bound[key] = row
        keyOf[row] = key
    }

    func unbind(_ row: UInt32) {
        guard let key = keyOf.removeValue(forKey: row) else { return }
        if bound[key] == row { bound[key] = nil }
    }
}

struct ZnListView: View {
    let ctx: ZnContext
    let inst: ZnInstance
    let s: ZnNodeSpec

    var body: some View {
        let list = inst.list(s.index)
        switch ZnImpl.list {
        case .swiftUI: ZnLazyList(ctx: ctx, inst: inst, s: s, list: list)
        case .uiKit:
            // Read here, so a change of the slot reaches updateUIView.
            let stickyText = s.stickySlot >= 0 ? inst.slot(s.stickySlot).value.string : s.stickyHeaderIndices
            ZnCollectionList(ctx: ctx, inst: inst, s: s, list: list, count: list.rows.count, sticky: znParseSticky(stickyText),
                             refreshing: s.refreshingNow(inst))
        }
    }
}

/// "1,30" → the sorted, distinct row indices (bad entries dropped), as Android's parseSticky.
func znParseSticky(_ text: String?) -> [Int] {
    guard let text else { return [] }
    return Array(Set(text.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }.filter { $0 >= 0 })).sorted()
}

/// One row: its instance if JS mounted one, else a placeholder of its template.
struct ZnListRowView: View {
    let ctx: ZnContext
    let list: ZnListState
    let row: ZnListRow

    var body: some View {
        let mounted = list.bound[row.key].flatMap { ctx.store.find($0) }
        let templateId = mounted?.templateId ?? row.type
        if let t = ctx.templates[safe: templateId] {
            let inst = mounted ?? ctx.store.placeholder(templateId: templateId, template: t)
            ZnNodeView(ctx: ctx, t: t, inst: inst, n: 0, outer: ZnOuter(fillWidth: true), definiteWidth: true)
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

// MARK: - SwiftUI

@MainActor
final class ZnVisibleRows {
    var shown = Set<Int>()
}

struct ZnLazyList: View {
    let ctx: ZnContext
    let inst: ZnInstance
    let s: ZnNodeSpec
    let list: ZnListState
    @State private var visible = ZnVisibleRows()

    var body: some View {
        let rows = list.rows
        ScrollView {
            LazyVStack(spacing: s.gap) {
                ForEach(rows.indices, id: \.self) { i in
                    ZnListRowView(ctx: ctx, list: list, row: rows[i])
                        .id(rows[i].key)
                        .onAppear { visible.shown.insert(i); report() }
                        .onDisappear { visible.shown.remove(i); report() }
                }
            }
            .padding(s.padding?.insets ?? EdgeInsets())
        }
    }

    private func report() {
        guard let a = visible.shown.min(), let b = visible.shown.max() else { return }
        znSendRange(ctx, inst, s, list, a, b)
    }
}

// MARK: - UIKit

struct ZnCollectionList: UIViewRepresentable {
    let ctx: ZnContext
    let inst: ZnInstance
    let s: ZnNodeSpec
    let list: ZnListState
    let count: Int  // read in the parent body, so a row count change reaches updateUIView
    let sticky: [Int]
    /// Pull to refresh (ZnTabsRefresh.swift): `refreshing` now (read in the parent body).
    let refreshing: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UICollectionView {
        let gap = s.gap
        let pad = s.padding ?? ZnEdges()
        let layout = ZnStickyLayout { _, _ in
            let size = NSCollectionLayoutSize(widthDimension: .fractionalWidth(1), heightDimension: .estimated(60))
            let item = NSCollectionLayoutItem(layoutSize: size)
            let group = NSCollectionLayoutGroup.vertical(layoutSize: size, subitems: [item])
            let section = NSCollectionLayoutSection(group: group)
            section.interGroupSpacing = gap
            section.contentInsets = NSDirectionalEdgeInsets(top: pad.top, leading: pad.start, bottom: pad.bottom, trailing: pad.end)
            return section
        }
        let cv = UICollectionView(frame: .zero, collectionViewLayout: layout)
        cv.backgroundColor = .clear
        cv.register(UICollectionViewCell.self, forCellWithReuseIdentifier: "row")
        cv.dataSource = context.coordinator
        cv.delegate = context.coordinator
        // inverted (RN): row 0 at the bottom, growing upwards (a chat). The list is flipped and each cell flipped back.
        if s.props[Registry.Prop.inverted]?.bool == true { cv.transform = CGAffineTransform(scaleX: 1, y: -1) }
        return cv
    }

    func updateUIView(_ cv: UICollectionView, context: Context) {
        let c = context.coordinator
        c.ctx = ctx; c.inst = inst; c.s = s; c.list = list
        if s.hasRefresh {
            let (ctx, inst, s) = (ctx, inst, s)
            let r = c.refresh ?? ZnRefresh()
            c.refresh = r
            r.attach(to: cv)
            r.onRefresh = s.onRefresh != 0 ? { ctx.send(inst.id, s.onRefresh, .none) } : nil
            r.update(refreshing: refreshing, tint: UIColor(s.refreshColor), canPull: s.onRefresh != 0)
        }
        if let layout = cv.collectionViewLayout as? ZnStickyLayout, layout.sticky != sticky {
            // A new layout pass forgets the scroll position (the lab's list jumped 34 rows on each toggle,
            // 2026-11-08): keep the first row that isn't pinned where it is.
            let anchor = Self.anchor(cv, c.keys, skipping: c.sticky)
            layout.sticky = sticky
            c.sticky = Set(sticky)
            layout.invalidateLayout()
            Self.restore(cv, anchor, c.keys)
        }
        let keys = list.rows.map(\.key)
        guard c.keys != keys else { return }
        let old = c.keys
        // The first visible row stays where it is on screen (Home: "New payment arrives" inserts at the top, and the
        // rows being read must not move), as on Android, where LazyColumn keeps the first visible key in place.
        let anchor = Self.anchor(cv, old, skipping: c.sticky)
        let ranges = Self.changedRanges(old, keys)
        print("zn t=\(ZnDebug.ms()) list: \(old.count) → \(keys.count) rows, changed \(ranges.map { "\($0.removed) → \($0.inserted)" } ?? "all"), anchor \(anchor.map { "\($0.key) at \($0.y)" } ?? "none"), offset \(cv.contentOffset.y)")
        if let (removed, inserted) = ranges, removed.count + inserted.count <= 200 {
            // The data source changes inside the update block, never before it: UIKit reads the item count before
            // and after, and they must differ by exactly these updates (crashed on 30 older chat messages,
            // 2026-11-08, when the count was read early).
            cv.layoutIfNeeded()
            UIView.performWithoutAnimation {
                cv.performBatchUpdates {
                    c.keys = keys
                    cv.deleteItems(at: removed.map { IndexPath(item: $0, section: 0) })
                    cv.insertItems(at: inserted.map { IndexPath(item: $0, section: 0) })
                }
            }
        } else {
            c.keys = keys
            cv.reloadData()
        }
        Self.restore(cv, anchor, keys)
    }

    /// The first visible row (pinned rows left out: they sit at the top wherever the list is) and its distance from
    /// the top of the list.
    static func anchor(_ cv: UICollectionView, _ keys: [String], skipping pinned: Set<Int>) -> (key: String, y: CGFloat)? {
        let items = cv.indexPathsForVisibleItems.map(\.item).filter { !pinned.contains($0) }.sorted()
        guard let i = items.first, let k = keys[safe: i],
              let a = cv.collectionViewLayout.layoutAttributesForItem(at: IndexPath(item: i, section: 0)) else { return nil }
        return (k, a.frame.minY - cv.contentOffset.y)
    }

    /// Scrolls so the anchor row is back at its distance from the top (clamped to the content).
    static func restore(_ cv: UICollectionView, _ anchor: (key: String, y: CGFloat)?, _ keys: [String]) {
        guard let anchor, let i = keys.firstIndex(of: anchor.key) else { return }
        cv.layoutIfNeeded()
        guard let a = cv.collectionViewLayout.layoutAttributesForItem(at: IndexPath(item: i, section: 0)) else { return }
        let top = -cv.adjustedContentInset.top
        let bottom = max(top, cv.contentSize.height - cv.bounds.height + cv.adjustedContentInset.bottom)
        cv.contentOffset.y = min(max(a.frame.minY - anchor.y, top), bottom)
        print("zn t=\(ZnDebug.ms()) list: anchor row \(i) at minY \(a.frame.minY) → offset \(cv.contentOffset.y)")
    }

    /// The rows that differ between [old] and [new], found from their common start and end (a splice: an insert at
    /// the top, a removal, a replaced block). O(n), so a 10,000-row list stays cheap. nil when nothing is shared.
    static func changedRanges(_ old: [String], _ new: [String]) -> (removed: Range<Int>, inserted: Range<Int>)? {
        guard !old.isEmpty, !new.isEmpty else { return nil }
        var start = 0
        while start < old.count, start < new.count, old[start] == new[start] { start += 1 }
        var end = 0
        while end < old.count - start, end < new.count - start, old[old.count - 1 - end] == new[new.count - 1 - end] { end += 1 }
        return (start..<(old.count - end), start..<(new.count - end))
    }

    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate {
        var ctx: ZnContext?
        var inst: ZnInstance?
        var s: ZnNodeSpec?
        var list: ZnListState?
        var keys: [String] = []
        var sticky = Set<Int>()
        var refresh: ZnRefresh?
        /// onEndReached was sent while the list had this many rows (once per length, as on Android).
        var endSentAt = -1

        func collectionView(_ cv: UICollectionView, numberOfItemsInSection section: Int) -> Int { keys.count }

        func collectionView(_ cv: UICollectionView, cellForItemAt ip: IndexPath) -> UICollectionViewCell {
            let cell = cv.dequeueReusableCell(withReuseIdentifier: "row", for: ip)
            if let ctx, let list, let row = list.rows[safe: ip.item] {
                cell.contentConfiguration = UIHostingConfiguration { ZnListRowView(ctx: ctx, list: list, row: row) }
                    .margins(.all, 0)
            }
            cell.contentView.transform = cv.transform  // inverted: flip each row back
            return cell
        }

        func scrollViewDidScroll(_ sv: UIScrollView) {
            guard let cv = sv as? UICollectionView, let ctx, let inst, let s, let list else { return }
            if ProcessInfo.processInfo.environment["ZN_LIST_TRACE"] == "1" { print("zn t=\(ZnDebug.ms()) list: offset \(cv.contentOffset.y)") }
            // A pinned row shows above rows far below it: leave it out, or JS would mount every row in between (Android
            // does the same).
            let all = cv.indexPathsForVisibleItems.map(\.item)
            let unpinned = all.filter { !sticky.contains($0) }
            let items = unpinned.isEmpty ? all : unpinned
            guard let a = items.min(), let b = items.max() else { return }
            MainActor.assumeIsolated { znSendRange(ctx, inst, s, list, a, b) }
            // Near the end: ask JS for more (onEndReached), once per list length, as Android does (5 rows ahead).
            let count = keys.count
            if s.onEndReached != 0, count > 0, b >= count - 5, endSentAt != count {
                endSentAt = count
                MainActor.assumeIsolated { ctx.send(inst.id, s.onEndReached, .none) }
            }
        }
    }
}

/// RN stickyHeaderIndices on the UIKit list: the last sticky row that has scrolled past the top stays pinned there
/// (above the other rows), and the next sticky row pushes it up as it arrives, as Compose's stickyHeader does on
/// Android. The cell itself moves (no copy), so it keeps its presses and state. Only the pinned row is added to the
/// rows on screen; the others are where the list puts them.
final class ZnStickyLayout: UICollectionViewCompositionalLayout {
    var sticky: [Int] = []

    /// Row [i]'s frame as the list lays it out, before pinning.
    private func plain(_ i: Int) -> UICollectionViewLayoutAttributes? {
        super.layoutAttributesForItem(at: IndexPath(item: i, section: 0))?.copy() as? UICollectionViewLayoutAttributes
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
        guard !sticky.isEmpty, let cv = collectionView, cv.numberOfSections > 0 else { return base }
        let count = cv.numberOfItems(inSection: 0)
        let top = cv.contentOffset.y + cv.adjustedContentInset.top
        var attrs = (base ?? []).map { $0.copy() as! UICollectionViewLayoutAttributes }
        if let p = pinnedIndex(top: top, count: count), !attrs.contains(where: { $0.representedElementCategory == .cell && $0.indexPath.item == p }),
           let a = plain(p) {
            attrs.append(a)
        }
        for a in attrs where a.representedElementCategory == .cell { pin(a, top: top, count: count) }
        return attrs
    }

    override func layoutAttributesForItem(at ip: IndexPath) -> UICollectionViewLayoutAttributes? {
        guard let a = plain(ip.item) else { return nil }
        if let cv = collectionView, sticky.contains(ip.item) {
            pin(a, top: cv.contentOffset.y + cv.adjustedContentInset.top, count: cv.numberOfItems(inSection: 0))
        }
        return a
    }

    override func shouldInvalidateLayout(forBoundsChange b: CGRect) -> Bool {
        !sticky.isEmpty || super.shouldInvalidateLayout(forBoundsChange: b)
    }

    override func invalidationContext(forBoundsChange b: CGRect) -> UICollectionViewLayoutInvalidationContext {
        let c = super.invalidationContext(forBoundsChange: b)
        if let cv = collectionView, cv.numberOfSections > 0 {
            let count = cv.numberOfItems(inSection: 0)
            c.invalidateItems(at: sticky.filter { $0 < count }.map { IndexPath(item: $0, section: 0) })
        }
        return c
    }
}
