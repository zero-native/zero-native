package dev.zeronative.exp4

import android.util.Log
import android.view.Choreographer
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.distinctUntilChanged
import org.json.JSONArray

fun parseSlotDataList(raw: Any?): List<Map<String, Any?>> {
    if (raw == null) return emptyList()
    val jsonArray = when (raw) {
        is JSONArray -> raw
        is String -> try { JSONArray(raw) } catch (_: Exception) { null }
        else -> null
    } ?: return emptyList()

    val count = jsonArray.length()
    val result = ArrayList<Map<String, Any?>>(count)
    for (i in 0 until count) {
        val obj = jsonArray.optJSONObject(i) ?: continue
        val map = HashMap<String, Any?>()
        val keys = obj.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = obj.opt(key)
        }
        result.add(map)
    }
    return result
}

@Composable
fun ZnVirtualList(node: ZnNode, modifier: Modifier) {
    val baseMod = applyNodeModifiers(node, modifier)
    val gap = node.getInt("gap", 8).dp
    val totalCount = node.getInt("totalCount", 0)
    val windowStart = node.getInt("windowStart", 0)
    val templateRootId = node.getInt("templateRootId", -1)
    val rawData = node.prop("data").value
    val listState = rememberLazyListState()

    val slotList = remember(rawData) { parseSlotDataList(rawData) }

    val cachedSlots = remember { HashMap<Int, Map<String, Any?>>() }
    LaunchedEffect(windowStart, slotList) {
        for (i in slotList.indices) {
            cachedSlots[windowStart + i] = slotList[i]
        }
    }

    LaunchedEffect(listState, node.id) {
        var lastDispatched = -1
        snapshotFlow { listState.firstVisibleItemIndex }
            .distinctUntilChanged()
            .collect { firstIndex ->
                if (firstIndex == 0 || Math.abs(firstIndex - lastDispatched) >= 4) {
                    lastDispatched = firstIndex
                    ZnBridge.dispatchEvent(node.id, "onScrollWindow", firstIndex.toString())
                }
            }
    }

    LaunchedEffect(listState.isScrollInProgress) {
        if (listState.isScrollInProgress) {
            var lastFrameTimeNanos = 0L
            var totalFrames = 0
            var jankFrames = 0
            val callback = object : Choreographer.FrameCallback {
                override fun doFrame(frameTimeNanos: Long) {
                    if (lastFrameTimeNanos > 0) {
                        val durationMs = (frameTimeNanos - lastFrameTimeNanos) / 1_000_000.0
                        totalFrames++
                        if (durationMs > 16.0) {
                            jankFrames++
                        }
                    }
                    lastFrameTimeNanos = frameTimeNanos
                    if (listState.isScrollInProgress) {
                        Choreographer.getInstance().postFrameCallback(this)
                    } else {
                        Log.i("zn-scroll", "[VIRTUAL_SLOT_SCROLL] Fling finished: $totalFrames frames, $jankFrames jank frames (${"%.1f".format(if (totalFrames > 0) (totalFrames - jankFrames) * 100.0 / totalFrames else 100.0)}% smooth)")
                    }
                }
            }
            Choreographer.getInstance().postFrameCallback(callback)
        }
    }

    LazyColumn(
        state = listState,
        modifier = baseMod,
        verticalArrangement = Arrangement.spacedBy(gap)
    ) {
        items(
            count = totalCount,
            key = { index -> index }
        ) { index ->
            val slots = cachedSlots[index]
            ZnSlotView(templateRootId, slots)
        }
    }
}

@Composable
fun ZnLazyColumn(node: ZnNode, modifier: Modifier, depth: Int = 0) {
    val baseMod = applyNodeModifiers(node, modifier)
    val gap = node.getInt("gap", 0).dp
    val children = node.children
    val listState = rememberLazyListState()

    LazyColumn(
        state = listState,
        modifier = baseMod,
        verticalArrangement = if (gap > 0.dp) Arrangement.spacedBy(gap) else Arrangement.Top
    ) {
        items(
            count = children.size,
            key = { index -> children[index] }
        ) { index ->
            val childId = children[index]
            key(childId) {
                ZnView(childId, Modifier.fillMaxWidth(), depth)
            }
        }
    }
}

@Composable
fun ZnSlotView(nodeId: Int, slots: Map<String, Any?>?, modifier: Modifier = Modifier) {
    val node = NodeStore.nodes[nodeId] ?: return

    when (node.type) {
        "Row" -> {
            val baseMod = applySlotModifiers(node, modifier, slots)
            val gap = node.getInt("gap", 0).dp
            val alignStr = node.getString("align", "")
            val justifyStr = node.getString("justify", "")

            val vertAlign = when (alignStr) {
                "center" -> Alignment.CenterVertically
                "bottom" -> Alignment.Bottom
                else -> Alignment.Top
            }
            val horizArrangement = when (justifyStr) {
                "center" -> Arrangement.Center
                "space-between" -> Arrangement.SpaceBetween
                "space-around" -> Arrangement.SpaceAround
                "end" -> Arrangement.End
                else -> if (gap > 0.dp) Arrangement.spacedBy(gap) else Arrangement.Start
            }

            Row(
                modifier = baseMod,
                verticalAlignment = vertAlign,
                horizontalArrangement = horizArrangement
            ) {
                for (childId in node.children) {
                    key(childId) {
                        ZnSlotView(childId, slots)
                    }
                }
            }
        }
        "Column" -> {
            val baseMod = applySlotModifiers(node, modifier, slots)
            val gap = node.getInt("gap", 0).dp
            val alignStr = node.getString("align", "")
            val justifyStr = node.getString("justify", "")

            val horizAlign = when (alignStr) {
                "center" -> Alignment.CenterHorizontally
                "flex-end", "end" -> Alignment.End
                else -> Alignment.Start
            }
            val vertArrangement = when (justifyStr) {
                "center" -> Arrangement.Center
                "space-between" -> Arrangement.SpaceBetween
                "space-around" -> Arrangement.SpaceAround
                "bottom" -> Arrangement.Bottom
                else -> if (gap > 0.dp) Arrangement.spacedBy(gap) else Arrangement.Top
            }

            Column(
                modifier = baseMod,
                horizontalAlignment = horizAlign,
                verticalArrangement = vertArrangement
            ) {
                for (childId in node.children) {
                    key(childId) {
                        ZnSlotView(childId, slots)
                    }
                }
            }
        }
        "Box" -> {
            val baseMod = applySlotModifiers(node, modifier, slots)
            val alignStr = node.getString("align", "")
            val justifyStr = node.getString("justify", "")
            val contentAlign = when {
                alignStr == "center" && justifyStr == "center" -> Alignment.Center
                alignStr == "center" -> Alignment.CenterStart
                justifyStr == "center" -> Alignment.TopCenter
                else -> Alignment.TopStart
            }

            Box(modifier = baseMod, contentAlignment = contentAlign) {
                for (childId in node.children) {
                    key(childId) {
                        ZnSlotView(childId, slots)
                    }
                }
            }
        }
        "Text" -> {
            val baseMod = applySlotModifiers(node, modifier, slots)
            val rawText = node.prop("text").value
            val resolvedText = resolveSlotValue(rawText, slots)?.toString() ?: ""
            val size = node.getInt("size", 14).sp
            val weightStr = node.getString("weight", "normal")
            val weight = when (weightStr) {
                "bold" -> FontWeight.Bold
                "medium" -> FontWeight.Medium
                "extrabold" -> FontWeight.ExtraBold
                else -> FontWeight.Normal
            }
            val rawColor = node.prop("color").value
            val resolvedColor = resolveSlotValue(rawColor, slots)
            val color = if (resolvedColor != null) parseColor(resolvedColor) else Color.Unspecified
            val lines = node.getInt("numberOfLines", 0)

            BasicText(
                text = resolvedText,
                modifier = baseMod,
                style = TextStyle(
                    fontSize = size,
                    fontWeight = weight,
                    color = color
                ),
                maxLines = if (lines > 0) lines else Int.MAX_VALUE,
                overflow = if (lines > 0) TextOverflow.Ellipsis else TextOverflow.Clip
            )
        }
        else -> Box(modifier)
    }
}
