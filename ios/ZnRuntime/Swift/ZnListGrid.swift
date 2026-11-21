// <List numColumns> (registry 24) on iOS, as android/runtime's ZnGridLine / ZnGridCell (ZnRenderer.kt): one list item
// per grid line, laid out as RN lays out a FlatList row: a Row styled by columnWrapperStyle (gap, justifyContent,
// alignItems, padding), each item placed by its root's own flex, width ("48%" is 48% of the line, as in RN) and
// alignSelf. A short last line gets invisible copies of its last item, so its items keep the columns' widths; the
// copies take no taps and are hidden from VoiceOver. Used by both list variants (ZnList.swift).
import SwiftUI

/// Grid line [line] of [list]: its rows are read here (live), so rows added after a short last line fill it.
struct ZnGridLineView: View {
    let ctx: ZnContext
    let list: ZnListState
    let line: Int
    let cols: Int
    let wrapper: ZnColumnWrapper

    var body: some View {
        let rows = list.rows
        let range = znGridRows(line: line, cols: cols, rows: rows.count)
        let missing = range.isEmpty ? 0 : cols - range.count
        ZnFlexLayout(vertical: false, justify: wrapper.justify, alignItems: wrapper.align, gap: wrapper.gap,
                     definiteWidth: true, definiteHeight: false) {
            ForEach(rows[range], id: \.key) { row in
                ZnGridCellView(ctx: ctx, list: list, row: row, ghost: false)
            }
            if missing > 0, let last = rows[safe: range.upperBound - 1] {
                ForEach(0..<missing, id: \.self) { _ in
                    ZnGridCellView(ctx: ctx, list: list, row: last, ghost: true)
                }
            }
        }
        .padding(EdgeInsets(top: wrapper.top, leading: wrapper.start, bottom: wrapper.bottom, trailing: wrapper.end))
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }
}

/// One item of a grid line: its instance (or a placeholder), placed like a Row child. A ghost is the placeholder of
/// its row's template, drawn invisible.
struct ZnGridCellView: View {
    let ctx: ZnContext
    let list: ZnListState
    let row: ZnListRow
    let ghost: Bool

    var body: some View {
        let mounted = ghost ? nil : list.bound[row.key].flatMap { ctx.store.find($0) }
        let templateId = mounted?.templateId ?? row.type
        if let t = ctx.templates[safe: templateId], let root = t.nodes.first {
            let inst = mounted ?? ctx.store.placeholder(templateId: templateId, template: t)
            let flex = root.flexNow(inst)
            ZnNodeView(ctx: ctx, t: t, inst: inst, n: 0, outer: ZnOuter(fillWidth: flex > 0), definiteWidth: root.hasWidth || flex > 0)
                .modifier(ZnGhost(on: ghost))
                .layoutValue(key: ZnFlexKey.self, value: flex)
                .layoutValue(key: ZnAlignSelfKey.self, value: root.alignSelf)
        }
    }
}

/// A short line's copy: takes its room, draws nothing, takes no tap (Android's LocalTouchOff and clearAndSetSemantics).
private struct ZnGhost: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        if on {
            content.opacity(0).allowsHitTesting(false).accessibilityHidden(true).environment(\.znTouchOff, true)
        } else {
            content
        }
    }
}
