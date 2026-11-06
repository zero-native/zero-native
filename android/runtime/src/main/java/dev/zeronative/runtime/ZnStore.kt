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

    /**
     * Text a field keeps itself, per node, for as long as the instance lives (the process): an <OtpInput>'s code. A new
     * Activity draws the field again from it, as a <TextField> does from its value slot (R51). Main thread.
     */
    internal val keptText = HashMap<Int, String>()

    /** Its root has an `exit` transition (set when drawn): a REMOVE then plays it before the instance goes. */
    internal var hasExit = false

    /** JS removed it and its `exit` animation is playing; it stays in its parent until ZnStore.finishExit. */
    internal val exiting = mutableStateOf(false)
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
                // One bad op (a bug, or a bundle built wrong) is reported and skipped; the rest of the batch still
                // applies, and the app doesn't crash (step 3.9).
                try {
                    applyOne(op)
                } catch (e: Exception) {
                    ZnRuntime.rendererError("batch op ${op::class.simpleName} failed and was skipped", e)
                }
            }
        }
    }

    private fun applyOne(op: BatchOp) {
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
                // A node placed inside itself would make drawing loop forever (v0's StackOverflowError).
                if (wouldLoop(op.instance, op.parent)) {
                    ZnRuntime.rendererError("mount of ${op.instance} under ${op.parent} refused", IllegalStateException("it would be inside itself"))
                    return
                }
                val inst = ZnInstance(op.instance, op.templateId, op.parent, op.anchor)
                op.values.forEachIndexed { i, v -> inst.slot(i).value = v }
                instances[op.instance] = inst
                val siblings = instance(op.parent).children(op.anchor)
                siblings.add(liveIndex(siblings, op.index), op.instance)
            }
            is BatchOp.Remove -> {
                val inst = instances[op.instance]
                if (inst != null) {
                    val parent = instances[inst.parent]
                    val list = parent?.listOrNull(inst.anchor)
                    // `exit` (step 3.6): keep it on screen while it animates out; finishExit drops it. Not
                    // for <List> rows (they leave because they scrolled away) or a root whose parent is gone.
                    if (inst.hasExit && parent != null && list == null && !inst.exiting.value) {
                        inst.exiting.value = true
                        return
                    }
                    parent?.children(inst.anchor)?.remove(op.instance)
                    list?.unbind(op.instance) // a <List> row leaving the window
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
                val inst = instances[op.instance] ?: return
                val siblings = instances[inst.parent]?.children(inst.anchor) ?: return
                if (siblings.remove(op.instance)) {
                    siblings.add(liveIndex(siblings, op.toIndex), op.instance)
                }
            }
            is BatchOp.Nav -> ZnNav.apply(op)
        }
    }

    /** True if mounting [instance] under [parent] would put it inside itself ([parent] is it or one of its children). */
    private fun wouldLoop(instance: Int, parent: Int): Boolean {
        var p = parent
        var steps = 0
        while (steps++ < 100_000) {
            if (p == instance) return true
            p = instances[p]?.parent ?: return false
            if (p == 0) return false
        }
        return true
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

    /**
     * The list position for JS's index [jsIndex]. JS doesn't count children that are playing their exit animation
     * (they are gone for JS); they keep their place, and a new child goes after any of them at that spot.
     */
    private fun liveIndex(siblings: List<Int>, jsIndex: Int): Int {
        var live = 0
        for (i in siblings.indices) {
            if (instances[siblings[i]]?.exiting?.value == true) continue
            if (live == jsIndex) return i
            live++
        }
        return siblings.size
    }

    /** An instance's exit animation ended (ZnAnimation.kt): now it really goes. Main thread. */
    internal fun finishExit(id: Int) {
        val inst = instances[id] ?: return
        if (!inst.exiting.value) return
        instances[inst.parent]?.children(inst.anchor)?.remove(id)
        removeTree(id)
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
