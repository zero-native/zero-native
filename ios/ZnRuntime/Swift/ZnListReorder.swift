// <List reorderable onReorder> (registry 24, docs/motion.md §11) on iOS, as android/runtime's ZnReorder.kt: a long press
// on a row picks it up, a drag moves it (the other rows make room, the list scrolls near its ends), the drop sends
// onReorder("from,to"). from is the row's index in JS's rows, to its new place. The list then shows the new order itself
// until JS's rows change (JS moved it), or a second passes and the row glides back (JS said no).
//
// The UIKit list does it with UIKit's own drag and drop inside the collection view (the lift, the room the others make,
// the scroll at the ends, VoiceOver's drag actions), local to the app. Not with pinned rows or a grid (as Android).
// A row's own onLongPress is off in a reorderable list (Pavan's decision 7; the compiler warns): the long press is the
// pick-up. The SwiftUI list (ZN_IOS_LIST=swiftui) does the same with SwiftUI's onDrag / onDrop (ZnLazyList).
import SwiftUI
import UIKit

extension EnvironmentValues {
    /// Inside a row of a reorderable List: a long press picks the row up, so a Pressable's onLongPress is off.
    @Entry var znReorderRow = false
}

extension ZnNodeSpec {
    /// A List with snap rules or scroll events: it needs a <Scroll>'s driver (ZnScroll.swift) on its scroll view.
    var listUsesScrollDriver: Bool { hasSnap || (scrollEvents != nil && onScrollEvent != 0) }
}

extension ZnCollectionList.Coordinator: UICollectionViewDragDelegate, UICollectionViewDropDelegate {
    private var rowsPart: Int { ZnListPart.rows.rawValue }

    // MARK: Drag

    func collectionView(_ cv: UICollectionView, itemsForBeginning session: UIDragSession, at ip: IndexPath) -> [UIDragItem] {
        // Header, footer and empty item can't be picked (Android's pick).
        guard canReorder, ip.section == rowsPart, let row = rows[safe: ip.item] else { return [] }
        let item = UIDragItem(itemProvider: NSItemProvider())
        item.localObject = row.key
        dropShown = ip
        dropTick.prepare()
        // Android's LONG_PRESS haptic on the pick.
        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        print("zn t=\(ZnDebug.ms()) list: reorder picks \(row.key) at \(ip.item)")
        return [item]
    }

    func collectionView(_ cv: UICollectionView, dragSessionIsRestrictedToDraggingApplication session: UIDragSession) -> Bool { true }

    func collectionView(_ cv: UICollectionView, dragSessionAllowsMoveOperation session: UIDragSession) -> Bool { true }

    /// The lifted row: its cell, with the corners a little round (UIKit adds the lift shadow, as Android's elevation).
    func collectionView(_ cv: UICollectionView, dragPreviewParametersForItemAt ip: IndexPath) -> UIDragPreviewParameters? {
        guard let cell = cv.cellForItem(at: ip) else { return nil }
        let p = UIDragPreviewParameters()
        p.visiblePath = UIBezierPath(roundedRect: cell.bounds, cornerRadius: 10)
        return p
    }

    // MARK: Drop

    func collectionView(_ cv: UICollectionView, canHandle session: UIDropSession) -> Bool {
        canReorder && session.localDragSession != nil
    }

    func collectionView(_ cv: UICollectionView, dropSessionDidUpdate session: UIDropSession,
                        withDestinationIndexPath dest: IndexPath?) -> UICollectionViewDropProposal {
        guard canReorder, session.localDragSession != nil else { return UICollectionViewDropProposal(operation: .forbidden) }
        // Over the header, empty item or footer: no room opens there (the drop goes to the first or last row).
        guard let dest, dest.section == rowsPart else { return UICollectionViewDropProposal(operation: .move, intent: .unspecified) }
        if dest != dropShown {
            dropShown = dest
            // Android's CLOCK_TICK on each swap.
            dropTick.selectionChanged()
        }
        return UICollectionViewDropProposal(operation: .move, intent: .insertAtDestinationIndexPath)
    }

    func collectionView(_ cv: UICollectionView, performDropWith coordinator: UICollectionViewDropCoordinator) {
        guard let item = coordinator.items.first, let src = item.sourceIndexPath, src.section == rowsPart,
              let row = rows[safe: src.item] else { return }
        let dest = coordinator.destinationIndexPath
        let to = znDropTarget(part: dest.flatMap { ZnListPart(rawValue: $0.section) } ?? .footer, item: dest?.item ?? rows.count,
                              rows: rows.count)
        let target = IndexPath(item: to, section: rowsPart)
        dropShown = nil
        guard to != src.item else {
            coordinator.drop(item.dragItem, toItemAt: src)
            return
        }
        cv.performBatchUpdates {
            var r = rows
            r.insert(r.remove(at: src.item), at: to)
            rows = r
            keys = r.map(\.key)
            cv.moveItem(at: src, to: target)
        }
        coordinator.drop(item.dragItem, toItemAt: target)
        // from: the row's index in JS's rows (the order shown may still be an earlier drop's); to: its place now.
        guard let ctx, let inst, let s, let list else { return }
        let from = list.row(row.key)?.index ?? src.item
        print("zn t=\(ZnDebug.ms()) list: reorder drops \(row.key) \(from) → \(to), waiting for JS")
        startReorderWait(cv, list)
        if s.onReorder != 0 { ctx.send(inst.id, s.onReorder, .string("\(from),\(to)")) }
    }

    func collectionView(_ cv: UICollectionView, dropSessionDidEnd session: UIDropSession) {
        dropShown = nil
    }

    // MARK: The wait for JS

    /// After a drop: the order shown stays until JS's rows change; after a second without, back to JS's order.
    private func startReorderWait(_ cv: UICollectionView, _ list: ZnListState) {
        reorderTimer?.cancel()
        reorderWait.version = list.version
        let work = DispatchWorkItem { [weak self, weak cv, weak list] in
            guard let self, let cv, let list else { return }
            self.reorderTimer = nil
            guard self.reorderWait.timedOut(at: list.version) else { return }
            let rows = list.rows
            print("zn t=\(ZnDebug.ms()) list: reorder: JS kept its order, the row goes back")
            var shape = self.shape
            shape.rows = rows.count
            self.apply(cv, rows: rows, keys: rows.map(\.key), shape: shape, animation: "move")
        }
        reorderTimer = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(ZnReorderWait.ms), execute: work)
    }

    func endReorderWait() {
        reorderTimer?.cancel()
        reorderTimer = nil
        reorderWait.version = nil
    }
}
