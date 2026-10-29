package dev.zeronative.exp4

import android.util.Log
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.snapshots.Snapshot
import org.json.JSONArray
import org.json.JSONObject

object NodeStore {
    private const val TAG = "zn"

    val nodes = HashMap<Int, ZnNode>()
    val hasRoot = mutableStateOf(false)
    val treeVersion = mutableStateOf(0)

    // Profiling
    var lastTapUptimeNanos: Long = 0
    val latencyMeasurements = mutableListOf<Double>()

    fun recordTap(nodeId: Int, eventName: String) {
        lastTapUptimeNanos = System.nanoTime()
    }

    fun applyBatch(jsonString: String) {
        val applyStartNanos = System.nanoTime()

        try {
            Snapshot.withMutableSnapshot {
                val batch = JSONArray(jsonString)
                for (i in 0 until batch.length()) {
                    val op = batch.getJSONArray(i)
                    when (op.getString(0)) {
                        "c" -> {
                            val id = op.getInt(1)
                            val type = op.getString(2)
                            nodes[id] = ZnNode(id, type)
                            if (id == 0) {
                                hasRoot.value = true
                            }
                        }
                        "p" -> {
                            val id = op.getInt(1)
                            val key = op.getString(2)
                            val value = if (op.isNull(3)) null else op.get(3)
                            nodes[id]?.prop(key)?.value = value
                        }
                        "i" -> {
                            val parentId = op.getInt(1)
                            val childId = op.getInt(2)
                            val index = op.getInt(3)
                            if (parentId != childId) {
                                val parent = nodes[parentId]
                                if (parent != null && !parent.children.contains(childId)) {
                                    if (index >= parent.children.size) {
                                        parent.children.add(childId)
                                    } else {
                                        parent.children.add(index, childId)
                                    }
                                }
                            }
                        }
                        "r" -> {
                            val id = op.getInt(1)
                            removeRecursive(id)
                        }
                        "nav" -> {
                            val navType = op.getString(1)
                            when (navType) {
                                "push" -> {
                                    val route = op.getString(2)
                                    val paramsObj = if (!op.isNull(3) && op.get(3) is JSONObject) op.getJSONObject(3) else null
                                    val entryId = op.getInt(4)
                                    val paramsMap = paramsObj?.toMap() ?: emptyMap()
                                    NavigationManager.push(route, paramsMap, entryId)
                                }
                                "pop" -> {
                                    NavigationManager.pop()
                                }
                                "replace" -> {
                                    val route = op.getString(2)
                                    val paramsObj = if (!op.isNull(3) && op.get(3) is JSONObject) op.getJSONObject(3) else null
                                    val entryId = op.getInt(4)
                                    val paramsMap = paramsObj?.toMap() ?: emptyMap()
                                    NavigationManager.replace(route, paramsMap, entryId)
                                }
                                "reset" -> {
                                    val route = op.getString(2)
                                    val paramsObj = if (!op.isNull(3) && op.get(3) is JSONObject) op.getJSONObject(3) else null
                                    val entryId = op.getInt(4)
                                    val paramsMap = paramsObj?.toMap() ?: emptyMap()
                                    NavigationManager.reset(route, paramsMap, entryId)
                                }
                            }
                        }
                        "app" -> {
                            val action = op.getString(1)
                            if (action == "exit") {
                                ZnBridge.onExitAppListener?.invoke()
                            }
                        }
                    }
                }
            }

            // Latency measurement
            if (lastTapUptimeNanos > 0) {
                val totalMs = (System.nanoTime() - lastTapUptimeNanos) / 1_000_000.0
                lastTapUptimeNanos = 0
                latencyMeasurements.add(totalMs)
                Log.i(TAG, "[LATENCY] tap-to-update applied in ${"%.2f".format(totalMs)} ms (batch apply: ${"%.2f".format((System.nanoTime() - applyStartNanos) / 1_000_000.0)} ms)")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error applying batch: $jsonString", e)
        }
    }

    private fun JSONObject.toMap(): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        val keys = this.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = this.opt(key)
        }
        return map
    }

    private fun removeRecursive(id: Int) {
        val node = nodes.remove(id) ?: return
        for (childId in node.children) {
            removeRecursive(childId)
        }
    }

    fun clear() {
        nodes.clear()
        hasRoot.value = false
        latencyMeasurements.clear()
        NavigationManager.clear()
        treeVersion.value++
    }
}

