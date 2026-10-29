package dev.zeronative.runtime

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.runtime.snapshots.SnapshotStateList

/**
 * One mounted template (ARCHITECTURE.md §9.1). Each slot is its own observable cell, so a change recomposes only
 * what reads that slot. Child instances (components, `&&` branches, `.map` rows) are kept per anchor node, in order,
 * as observable lists.
 */
class ZnInstance internal constructor(
    val id: Int,
    /** Index of this instance's template in its .zn.ui file (set later for a screen root, see mountRoot). */
    templateId: Int,
    val parent: Int,
    /** The anchor node in the parent's template this instance is mounted at. */
    val anchor: Int,
) {
    var templateId: Int = templateId
        internal set
    private val cells = HashMap<Int, MutableState<Any?>>()
    private val anchors = HashMap<Int, SnapshotStateList<Int>>()

    /** The observable cell for a slot; created on first use, so readers subscribe even before a value arrives. */
    fun slot(slot: Int): MutableState<Any?> = cells.getOrPut(slot) { mutableStateOf(null) }

    fun hasSlot(slot: Int): Boolean = cells.containsKey(slot)

    /** Ids of the instances mounted at an anchor node, in order. Observable. */
    fun children(anchor: Int): SnapshotStateList<Int> = anchors.getOrPut(anchor) { mutableStateListOf() }

    internal fun allChildren(): List<Int> = anchors.values.flatten()

    private val lists = HashMap<Int, ZnList>()

    /** The state of the <List> at node [node] (created on first use). */
    fun list(node: Int): ZnList = lists.getOrPut(node) { ZnList() }

    internal fun listOrNull(node: Int): ZnList? = lists[node]

    /**
     * Called for every PATCH of a slot, even one that repeats the current value (a cell only notifies on change). A
     * controlled <TextField> needs that: JS resends its value to undo typing it rejected. Main thread.
     */
    internal val patchWatchers = HashMap<Int, (Any?) -> Unit>()
}

/** One row of a <List>: its key and its type (the row template id: Compose reuse per kind, and its placeholder). */
data class ZnListRow(val key: String, val type: Int)

/**
 * A <List>'s rows (docs/lists.md). Native knows every row's key and type; only rows near the screen have an instance
 * (mounted by JS), found through [bound]. Observable, so a row redraws when its instance arrives.
 */
class ZnList {
    val rows: SnapshotStateList<ZnListRow> = mutableStateListOf()
    /** Row key → the instance that draws it. */
    val bound: SnapshotStateMap<String, Int> = mutableStateMapOf()
    private val keyOf = HashMap<Int, String>()

    internal fun bind(key: String, row: Int) {
        keyOf.remove(bound[key] ?: Int.MIN_VALUE)
        bound[key] = row
        keyOf[row] = key
    }

    internal fun unbind(row: Int) {
        val key = keyOf.remove(row) ?: return
        if (bound[key] == row) bound.remove(key)
    }
}

/**
 * Instances owned by the process (not by an Activity), so a recreated Activity shows the current state at once
 * (ARCHITECTURE.md §8.2). Main thread only.
 */
object ZnStore {
    private val instances = HashMap<Int, ZnInstance>()

    /** Returns the instance, creating an empty one if needed. */
    fun instance(id: Int): ZnInstance = instances.getOrPut(id) { ZnInstance(id, templateId = 0, parent = 0, anchor = 0) }

    fun find(id: Int): ZnInstance? = instances[id]

    val size: Int get() = instances.size

    /**
     * Creates a screen root from its template, with every slot set to its default, so the skeleton can draw before
     * JS runs (ARCHITECTURE §8.1, §8.3). Native creates screen roots; JS never mounts them. If the root already
     * exists (the Activity was recreated), it is returned as is, with its current values.
     */
    fun mountRoot(id: Int, templateId: Int, template: ZnTemplate): ZnInstance {
        // JS may already have sent patches and child mounts for this root before the template finished loading:
        // keep the same instance (with those values and children) and only fill in what's missing.
        val inst = instances.getOrPut(id) { ZnInstance(id, templateId, parent = 0, anchor = 0) }
        inst.templateId = templateId
        template.slotDefaults.forEachIndexed { slot, value -> if (!inst.hasSlot(slot)) inst.slot(slot).value = value }
        return inst
    }

    /** Applies one batch atomically: Compose sees all of it in the same frame, never half of it. */
    internal fun apply(ops: List<BatchOp>) {
        Snapshot.withMutableSnapshot {
            for (op in ops) {
                when (op) {
                    is BatchOp.Patch -> {
                        // An unknown instance means a bug (JS patching a screen it closed, or before its NAV push).
                        val inst = instances[op.instance]
                        if (inst != null) {
                            inst.slot(op.slot).value = op.value
                            inst.patchWatchers[op.slot]?.invoke(op.value)
                        } else {
                            android.util.Log.w("zn", "patch for unknown instance ${op.instance} ignored")
                        }
                    }
                    is BatchOp.Mount -> {
                        val inst = ZnInstance(op.instance, op.templateId, op.parent, op.anchor)
                        op.values.forEachIndexed { i, v -> inst.slot(i).value = v }
                        instances[op.instance] = inst
                        val siblings = instance(op.parent).children(op.anchor)
                        siblings.add(op.index.coerceIn(0, siblings.size), op.instance)
                    }
                    is BatchOp.Remove -> {
                        val inst = instances[op.instance]
                        if (inst != null) {
                            val parent = instances[inst.parent]
                            parent?.children(inst.anchor)?.remove(op.instance)
                            parent?.listOrNull(inst.anchor)?.unbind(op.instance) // a <List> row leaving the window
                        }
                        removeTree(op.instance)
                    }
                    is BatchOp.ListSet -> instances[op.instance]?.list(op.node)?.rows?.let { rows ->
                        rows.clear()
                        rows.addAll(op.keys.indices.map { ZnListRow(op.keys[it], op.types[it]) })
                    }
                    is BatchOp.ListSplice -> instances[op.instance]?.list(op.node)?.rows?.let { rows ->
                        val at = op.index.coerceIn(0, rows.size)
                        rows.removeRange(at, (at + op.removeCount).coerceAtMost(rows.size))
                        rows.addAll(at, op.keys.indices.map { ZnListRow(op.keys[it], op.types[it]) })
                    }
                    is BatchOp.ListRow -> instances[op.instance]?.list(op.node)?.bind(op.key, op.row)
                    is BatchOp.Move -> {
                        val inst = instances[op.instance] ?: continue
                        val siblings = instances[inst.parent]?.children(inst.anchor) ?: continue
                        if (siblings.remove(op.instance)) {
                            siblings.add(op.toIndex.coerceIn(0, siblings.size), op.instance)
                        }
                    }
                    is BatchOp.Nav -> ZnNav.apply(op)
                }
            }
        }
    }

    private val placeholders = HashMap<Int, ZnInstance>()

    /**
     * A read-only instance of [template] with its slot defaults, for <List> rows whose instance isn't mounted yet:
     * same template, so the same height and look, never raw template syntax (docs/lists.md §3). Not in the store;
     * JS never patches it, and its events reach no handler.
     */
    fun placeholder(templateId: Int, template: ZnTemplate): ZnInstance = placeholders.getOrPut(templateId) {
        ZnInstance(Int.MIN_VALUE, templateId, parent = 0, anchor = 0).also { p ->
            template.slotDefaults.forEachIndexed { slot, value -> p.slot(slot).value = value }
        }
    }

    /** Drops a screen root and everything mounted under it (its entry left the back stack, ZnNav). */
    internal fun removeRoot(id: Int) = removeTree(id)

    /** Debug builds (`zn dev` reload): forget every instance; the new JS starts its ids from 1 again. */
    internal fun resetForReload() {
        instances.clear()
        placeholders.clear()
    }

    private fun removeTree(id: Int) {
        val inst = instances.remove(id) ?: return
        for (child in inst.allChildren()) removeTree(child)
    }
}
