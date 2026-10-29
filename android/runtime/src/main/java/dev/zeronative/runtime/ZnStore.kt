package dev.zeronative.runtime

import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
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
                    is BatchOp.Patch -> instance(op.instance).slot(op.slot).value = op.value
                    is BatchOp.Mount -> {
                        val inst = ZnInstance(op.instance, op.templateId, op.parent, op.anchor)
                        op.values.forEachIndexed { i, v -> inst.slot(i).value = v }
                        instances[op.instance] = inst
                        val siblings = instance(op.parent).children(op.anchor)
                        siblings.add(op.index.coerceIn(0, siblings.size), op.instance)
                    }
                    is BatchOp.Remove -> {
                        val inst = instances[op.instance]
                        if (inst != null) instances[inst.parent]?.children(inst.anchor)?.remove(op.instance)
                        removeTree(op.instance)
                    }
                    is BatchOp.Move -> {
                        val inst = instances[op.instance] ?: continue
                        val siblings = instances[inst.parent]?.children(inst.anchor) ?: continue
                        if (siblings.remove(op.instance)) {
                            siblings.add(op.toIndex.coerceIn(0, siblings.size), op.instance)
                        }
                    }
                }
            }
        }
    }

    private fun removeTree(id: Int) {
        val inst = instances.remove(id) ?: return
        for (child in inst.allChildren()) removeTree(child)
    }
}
