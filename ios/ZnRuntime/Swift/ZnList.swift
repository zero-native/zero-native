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
        case .uiKit: ZnCollectionList(ctx: ctx, inst: inst, s: s, list: list, count: list.rows.count)
        }
    }
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

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UICollectionView {
        let gap = s.gap
        let pad = s.padding ?? ZnEdges()
        let layout = UICollectionViewCompositionalLayout { _, _ in
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
        return cv
    }

    func updateUIView(_ cv: UICollectionView, context: Context) {
        let c = context.coordinator
        c.ctx = ctx; c.inst = inst; c.s = s; c.list = list
        if c.keys != list.rows.map(\.key) {
            c.keys = list.rows.map(\.key)
            cv.reloadData()  // spike: a diffable data source keeps the scroll position on inserts (i.2)
        }
    }

    final class Coordinator: NSObject, UICollectionViewDataSource, UICollectionViewDelegate {
        var ctx: ZnContext?
        var inst: ZnInstance?
        var s: ZnNodeSpec?
        var list: ZnListState?
        var keys: [String] = []

        func collectionView(_ cv: UICollectionView, numberOfItemsInSection section: Int) -> Int { keys.count }

        func collectionView(_ cv: UICollectionView, cellForItemAt ip: IndexPath) -> UICollectionViewCell {
            let cell = cv.dequeueReusableCell(withReuseIdentifier: "row", for: ip)
            if let ctx, let list, let row = list.rows[safe: ip.item] {
                cell.contentConfiguration = UIHostingConfiguration { ZnListRowView(ctx: ctx, list: list, row: row) }
                    .margins(.all, 0)
            }
            return cell
        }

        func scrollViewDidScroll(_ sv: UIScrollView) {
            guard let cv = sv as? UICollectionView, let ctx, let inst, let s, let list else { return }
            let items = cv.indexPathsForVisibleItems.map(\.item)
            guard let a = items.min(), let b = items.max() else { return }
            MainActor.assumeIsolated { znSendRange(ctx, inst, s, list, a, b) }
        }
    }
}
