// Mounted template instances and their slot cells (ARCHITECTURE.md §9.1). Port of android/runtime's ZnStore.kt.
// Each slot is its own @Observable cell: a SwiftUI body that reads one cell is redrawn only when that cell changes,
// so typing a digit redraws the amount text and nothing else (the i.1b check).
import Foundation
import Observation

@Observable
final class SlotCell {
    var value: ZnValue
    init(_ value: ZnValue) { self.value = value }
}

/// The instances mounted at one anchor node, in order.
@Observable
final class ChildList {
    var ids: [UInt32] = []
}

/// A flag views can watch (an instance playing its exit).
@Observable
final class ZnFlag {
    var on = false
}

/// A node's drawn size, for formulas and gestures that read self / parent sizes (Android's ZnSite). `wanted`: a child
/// reads it as its parent size, so this node writes its size too.
@Observable
final class ZnSizeBox {
    var w: Double = 0
    var h: Double = 0
    var wanted = false
}

/// One mounted template. Not observable itself: its cells and child lists are.
@MainActor
final class ZnInstance {
    let id: UInt32
    var templateId: Int
    let parent: UInt32
    let anchor: Int
    private var cells: [Int: SlotCell] = [:]
    private var anchors: [Int: ChildList] = [:]
    private var lists: [Int: ZnListState] = [:]
    private var sizeBoxes: [Int: ZnSizeBox] = [:]
    /// Its root has an `exit` transition (set when drawn): a REMOVE then plays it before the instance goes.
    var hasExit = false
    /// JS removed it and its `exit` is playing; it stays in its parent until ZnStore.finishExit.
    let exiting = ZnFlag()
    /// The last scroll command run per command slot (ZnScrollCommand.seq), so a <Scroll> that comes back on screen
    /// doesn't run its last command again (Android's inst.scrollSeqs).
    var scrollSeqs: [Int: Int] = [:]

    /// The state of the <List> at node [node] (created on first use).
    func list(_ node: Int) -> ZnListState {
        if let l = lists[node] { return l }
        let l = ZnListState()
        lists[node] = l
        return l
    }

    func listOrNil(_ node: Int) -> ZnListState? { lists[node] }

    /// The size box of node [node] (created on first use; nothing writes one yet).
    func sizeBox(_ node: Int) -> ZnSizeBox {
        if let b = sizeBoxes[node] { return b }
        let b = ZnSizeBox()
        sizeBoxes[node] = b
        return b
    }

    init(id: UInt32, templateId: Int, parent: UInt32, anchor: Int) {
        self.id = id
        self.templateId = templateId
        self.parent = parent
        self.anchor = anchor
    }

    /// The cell for a slot; created on first use, so readers subscribe even before a value arrives.
    func slot(_ slot: Int) -> SlotCell {
        if let c = cells[slot] { return c }
        let c = SlotCell(.null)
        cells[slot] = c
        return c
    }

    func hasSlot(_ slot: Int) -> Bool { cells[slot] != nil }

    func children(_ anchor: Int) -> ChildList {
        if let l = anchors[anchor] { return l }
        let l = ChildList()
        anchors[anchor] = l
        return l
    }

    var allChildren: [UInt32] { anchors.values.flatMap { $0.ids } }
}

/// Instances owned by the process (not by a scene). Main actor only.
@MainActor
final class ZnStore {
    private(set) var instances: [UInt32: ZnInstance] = [:]
    var onNav: ((Int, UInt32, Int, String?) -> Void)?
    var onError: ((String) -> Void)?

    func find(_ id: UInt32) -> ZnInstance? { instances[id] }

    /// Forgets every instance (a new JS runtime numbers its instances from the start again).
    func reset() { instances = [:] }

    /// A screen root from its template, every slot at its default, so the skeleton draws before JS runs (§8.1).
    @discardableResult
    func mountRoot(id: UInt32, templateId: Int, template: ZnTemplate) -> ZnInstance {
        let inst = instances[id] ?? ZnInstance(id: id, templateId: templateId, parent: 0, anchor: 0)
        instances[id] = inst
        inst.templateId = templateId
        for (i, v) in template.slotDefaults.enumerated() where !inst.hasSlot(i) { inst.slot(i).value = v }
        return inst
    }

    /// Applies one batch. All of it is set inside one main-actor call, so SwiftUI draws it in one frame: a user
    /// never sees half a batch (§8.3).
    func apply(_ ops: [BatchOp]) {
        for op in ops { applyOne(op) }
    }

    private func applyOne(_ op: BatchOp) {
        switch op {
        case let .patch(instance, slot, value):
            guard let inst = instances[instance] else { return onError?("patch for unknown instance \(instance) ignored") ?? () }
            let cell = inst.slot(slot)
            if cell.value != value { cell.value = value }  // an unchanged value must not redraw
        case let .mount(templateId, parent, anchor, instance, index, values):
            if wouldLoop(instance, parent) { return onError?("mount of \(instance) under \(parent) refused: inside itself") ?? () }
            let inst = ZnInstance(id: instance, templateId: templateId, parent: parent, anchor: anchor)
            for (i, v) in values.enumerated() { inst.slot(i).value = v }
            instances[instance] = inst
            let siblings = self.instance(parent).children(anchor)
            siblings.ids.insert(instance, at: liveIndex(siblings.ids, index))
        case let .remove(instance):
            if let inst = instances[instance], let parent = instances[inst.parent] {
                // `exit`: kept on screen while it animates out; finishExit drops it. Not for <List> rows (they
                // leave because they scrolled away).
                if inst.hasExit && parent.listOrNil(inst.anchor) == nil && !inst.exiting.on {
                    inst.exiting.on = true
                    print("zn t=\(ZnDebug.ms()) exit: \(instance) plays its exit")
                    return
                }
                parent.children(inst.anchor).ids.removeAll { $0 == instance }
                parent.listOrNil(inst.anchor)?.unbind(instance)  // a <List> row leaving the window
            }
            removeTree(instance)
        case let .move(instance, toIndex):
            guard let inst = instances[instance], let parent = instances[inst.parent] else { return }
            let list = parent.children(inst.anchor)
            guard let from = list.ids.firstIndex(of: instance) else { return }
            list.ids.remove(at: from)
            list.ids.insert(instance, at: liveIndex(list.ids, toIndex))
        case let .nav(kind, entry, route, params):
            onNav?(kind, entry, route, params)
        case let .listSet(instance, node, keys, types):
            instances[instance]?.list(node).rows = zip(keys, types).map { ZnListRow(key: $0, type: $1) }
        case let .listSplice(instance, node, index, removeCount, keys, types):
            guard let list = instances[instance]?.list(node) else { return }
            let at = min(max(index, 0), list.rows.count)
            list.rows.removeSubrange(at..<min(at + removeCount, list.rows.count))
            list.rows.insert(contentsOf: zip(keys, types).map { ZnListRow(key: $0, type: $1) }, at: at)
        case let .listRow(instance, node, key, row):
            instances[instance]?.list(node).bind(key, row)
        }
    }

    private var placeholders: [Int: ZnInstance] = [:]

    /// A read-only instance of a template with its slot defaults, for <List> rows not mounted yet (not in the store:
    /// JS never patches it, its events reach no handler).
    func placeholder(templateId: Int, template: ZnTemplate) -> ZnInstance {
        if let p = placeholders[templateId] { return p }
        let p = ZnInstance(id: 0, templateId: templateId, parent: 0, anchor: 0)
        for (i, v) in template.slotDefaults.enumerated() { p.slot(i).value = v }
        placeholders[templateId] = p
        return p
    }

    func instance(_ id: UInt32) -> ZnInstance {
        if let i = instances[id] { return i }
        let i = ZnInstance(id: id, templateId: 0, parent: 0, anchor: 0)
        instances[id] = i
        return i
    }

    private func wouldLoop(_ instance: UInt32, _ parent: UInt32) -> Bool {
        var p = parent
        for _ in 0..<100_000 {
            if p == instance { return true }
            guard let next = instances[p]?.parent, p != 0 else { return false }
            p = next
            if p == 0 { return false }
        }
        return true
    }

    /// The list position for JS's index [jsIndex]. JS doesn't count children playing their exit (they are gone for
    /// JS); they keep their place, and a new child goes after any of them at that spot.
    private func liveIndex(_ siblings: [UInt32], _ jsIndex: Int) -> Int {
        var live = 0
        for (i, id) in siblings.enumerated() {
            if instances[id]?.exiting.on == true { continue }
            if live == jsIndex { return i }
            live += 1
        }
        return siblings.count
    }

    /// An instance's exit animation ended (ZnAnimation.swift): now it really goes.
    func finishExit(_ id: UInt32) {
        guard let inst = instances[id], inst.exiting.on else { return }
        print("zn t=\(ZnDebug.ms()) exit: \(id) done, removed")
        instances[inst.parent]?.children(inst.anchor).ids.removeAll { $0 == id }
        removeTree(id)
    }

    func removeTree(_ id: UInt32) {
        guard let inst = instances.removeValue(forKey: id) else { return }
        for child in inst.allChildren { removeTree(child) }
    }
}
