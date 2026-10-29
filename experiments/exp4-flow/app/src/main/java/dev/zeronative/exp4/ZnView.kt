package dev.zeronative.exp4

import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

/**
 * Top-level ZnView Composable Dispatcher
 * Dispatches declarative ZnNode trees to specialized Compose primitives
 */
@Composable
fun ZnView(id: Int, modifier: Modifier = Modifier, depth: Int = 0) {
    val node = NodeStore.nodes[id] ?: return

    // If node is explicitly invisible, skip rendering
    // (except BottomSheet which handles its own exit spring animations)
    val visibleVal = node.prop("visible").value
    if (visibleVal == false && node.type != "BottomSheet") {
        return
    }

    when (node.type) {
        "Column" -> ZnColumn(node, modifier, depth)
        "LazyColumn" -> ZnLazyColumn(node, modifier, depth)
        "VirtualList" -> ZnVirtualList(node, modifier)
        "BottomSheet" -> ZnBottomSheet(node, modifier)
        "Row" -> ZnRow(node, modifier, depth)
        "Box" -> {
            if (node.hasProp("isNativeActive")) {
                UpiNativeBar(node, modifier)
            } else {
                ZnBox(node, modifier, depth)
            }
        }
        "Text" -> ZnText(node, modifier)
        "Pressable" -> ZnPressable(node, modifier, depth)
        "Spacer" -> ZnSpacer(node, modifier)
        "Image" -> ZnImage(node, modifier)
        else -> Box(modifier)
    }
}
