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
        let picked = ZnDragRow(key: row.key)
        item.localObject = picked
        // An inverted list is flipped and each row flipped back inside it (cell.contentView), so UIKit's own preview
        // of the cell, drawn outside the list, showed the row upside down for the whole drag (2026-11-24). The drag
        // preview is the row as it shows instead, from the moment the finger moves (the drop then flies it to its
        // place: drop(_:at:in:_:moving:)). UIKit's lift preview, while the finger holds still after the pick, is
        // still upside down: it is drawn from the cell's last frame with no say for the app (tried 2026-11-24:
        // unflipping the cell for the lift, or flipping the cell instead of its content, didn't change it).
        if cv.transform.d < 0, let cell = cv.cellForItem(at: ip) {
            let image = znUprightImage(of: cell)
            picked.image = image
            item.previewProvider = { znDragPreview(image) }
        }
        dropShown = ip
        dropDone = false
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
        // From here UIKit only animates the row into its place: JS's rows can go in again.
        dropDone = true
        defer { flushHeld(cv) }
        // The row's own cell (UIKit hides it while it is dragged): it moves to its place under the flying row (drop).
        let moving = cv.cellForItem(at: src)
        guard to != src.item else {
            drop(item.dragItem, at: src, in: cv, coordinator, moving: moving)
            return
        }
        cv.performBatchUpdates {
            var r = rows
            r.insert(r.remove(at: src.item), at: to)
            rows = r
            keys = r.map(\.key)
            cv.moveItem(at: src, to: target)
        }
        drop(item.dragItem, at: target, in: cv, coordinator, moving: moving)
        // from: the row's index in JS's rows (the order shown may still be an earlier drop's); to: its place now.
        guard let ctx, let inst, let s, let list else { return }
        let from = list.row(row.key)?.index ?? src.item
        print("zn t=\(ZnDebug.ms()) list: reorder drops \(row.key) \(from) → \(to), waiting for JS")
        startReorderWait(cv, list)
        if s.onReorder != 0 { ctx.send(inst.id, s.onReorder, .string("\(from),\(to)")) }
    }

    /// The dropped row flies from the finger to its place [ip]. UIKit's own drop animation (drop(_:toItemAt:)) on an
    /// inverted list jumped: the row showed upside down about a row's height off, then slid to the gap (2026-11-24;
    /// UIKit places its preview of the cell as if the list weren't flipped). There it flies as it shows, upright, to
    /// the place the row has in the list (converted through the flip) and the row's own cell shows when it lands.
    private func drop(_ dragItem: UIDragItem, at ip: IndexPath, in cv: UICollectionView,
                      _ coordinator: UICollectionViewDropCoordinator, moving: UICollectionViewCell?) {
        guard cv.transform.d < 0, (dragItem.localObject as? ZnDragRow)?.image != nil, let container = cv.superview,
              let frame = cv.layoutAttributesForItem(at: ip)?.frame else {
            coordinator.drop(dragItem, toItemAt: ip)
            return
        }
        let place = cv.convert(frame, to: container)
        let target = UIDragPreviewTarget(container: container, center: CGPoint(x: place.midX, y: place.midY))
        // Its cell stays hidden while it slides from the old place to the new one under the flying row (it showed: a
        // second copy of the row coming up from the bottom), and shows when the row lands.
        let cell = moving ?? cv.cellForItem(at: ip)
        cell?.alpha = 0
        coordinator.drop(dragItem, to: target).addCompletion { [weak cell] _ in cell?.alpha = 1 }
    }

    func collectionView(_ cv: UICollectionView, dropSessionDidEnd session: UIDropSession) {
        dropShown = nil
        flushHeld(cv)
    }

    func collectionView(_ cv: UICollectionView, dragSessionDidEnd session: UIDragSession) {
        dropDone = true
        flushHeld(cv)
    }

    // MARK: JS's rows during a drag

    /// UIKit is moving rows for a drag now: no batch updates or reloads then (they would clash with its own). Once
    /// the drop is done (the row only glides into place, about a second on the simulator) they can go in.
    func dragBusy(_ cv: UICollectionView) -> Bool {
        cv.hasUncommittedUpdates || (!dropDone && (cv.hasActiveDrag || cv.hasActiveDrop))
    }

    /// The drag ended: JS's rows that came meanwhile go in (once UIKit has finished the drop).
    func flushHeld(_ cv: UICollectionView, tries: Int = 20) {
        guard held != nil else { return }
        DispatchQueue.main.async { [weak self, weak cv] in
            guard let self, let cv, let run = self.held else { return }
            guard !self.dragBusy(cv) else {
                if tries > 0 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self, weak cv] in
                        if let self, let cv { self.flushHeld(cv, tries: tries - 1) }
                    }
                }
                return
            }
            self.held = nil
            print("zn t=\(ZnDebug.ms()) list: reorder: the rows JS sent during the drag go in now")
            run()
        }
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
            print("zn t=\(ZnDebug.ms()) list: reorder: JS kept its order, the row goes back")
            let back = { [weak self, weak cv, weak list] in
                guard let self, let cv, let list else { return }
                let rows = list.rows
                var shape = self.shape
                shape.rows = rows.count
                self.apply(cv, rows: rows, keys: znLineKeys(rows.map(\.key), cols: shape.cols), shape: shape, animation: "move")
            }
            // Another drag under way: after it (unless JS's rows come first and take its place).
            if self.dragBusy(cv) {
                if self.held == nil { self.held = back }
            } else {
                back()
            }
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

/// The row a drag picked up (UIDragItem.localObject): its key and, in an inverted list, how it shows (the preview).
final class ZnDragRow {
    let key: String
    var image: UIImage?
    init(key: String) { self.key = key }
}

/// [cell] of an inverted (flipped) list as it shows on screen: drawn flipped once more, so its row reads the right way
/// up (the cell's own drawing has the row flipped back for the flipped list).
@MainActor
private func znUprightImage(of cell: UICollectionViewCell) -> UIImage {
    UIGraphicsImageRenderer(bounds: cell.bounds).image { r in
        r.cgContext.translateBy(x: 0, y: cell.bounds.height)
        r.cgContext.scaleBy(x: 1, y: -1)
        cell.drawHierarchy(in: cell.bounds, afterScreenUpdates: false)
    }
}

/// A drag preview of [image] with the lifted row's corners (dragPreviewParametersForItemAt).
@MainActor
private func znDragPreview(_ image: UIImage) -> UIDragPreview {
    let v = UIImageView(image: image)
    v.frame = CGRect(origin: .zero, size: image.size)
    let p = UIDragPreviewParameters()
    p.visiblePath = UIBezierPath(roundedRect: v.bounds, cornerRadius: 10)
    return UIDragPreview(view: v, parameters: p)
}
