package dev.zeronative.exp4

import android.util.Log
import android.view.HapticFeedbackConstants
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import org.json.JSONArray
import org.json.JSONObject
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import android.view.Choreographer
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage

/**
 * Top-level Animated Screen Navigation Host
 * Handles 60 FPS slide & fade transitions between Zero-Native screens
 */
@Composable
fun NavigationHost(modifier: Modifier = Modifier) {
    val currentEntry = NavigationManager.currentEntry
    val isForward = NavigationManager.isForwardTransition

    AnimatedContent(
        targetState = currentEntry,
        transitionSpec = {
            if (isForward) {
                (slideInHorizontally(
                    initialOffsetX = { fullWidth -> fullWidth },
                    animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing)
                ) + fadeIn(animationSpec = tween(280))).togetherWith(
                    slideOutHorizontally(
                        targetOffsetX = { fullWidth -> -fullWidth / 3 },
                        animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing)
                    ) + fadeOut(animationSpec = tween(280))
                )
            } else {
                (slideInHorizontally(
                    initialOffsetX = { fullWidth -> -fullWidth / 3 },
                    animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing)
                ) + fadeIn(animationSpec = tween(280))).togetherWith(
                    slideOutHorizontally(
                        targetOffsetX = { fullWidth -> fullWidth },
                        animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing)
                    ) + fadeOut(animationSpec = tween(280))
                )
            }
        },
        label = "zn_nav_transition",
        modifier = modifier
    ) { targetEntry ->
        ZnView(id = targetEntry.entryId, modifier = Modifier.fillMaxSize())
    }
}

@Composable
fun ZnView(id: Int, modifier: Modifier = Modifier, depth: Int = 0) {
    if (depth > 32) return
    val node = NodeStore.nodes[id] ?: return

    if (node.type != "BottomSheet") {
        val visibleVal = node.prop("visible").value
        if (visibleVal != null && visibleVal == false) {
            return
        }
    }

    when (node.type) {
        "Column" -> ZnColumn(node, modifier, depth + 1)
        "LazyColumn" -> ZnLazyColumn(node, modifier, depth + 1)
        "VirtualList" -> ZnVirtualList(node, modifier)
        "BottomSheet" -> ZnBottomSheet(node, modifier)
        "Row" -> ZnRow(node, modifier, depth + 1)
        "Box" -> {
            if (node.hasProp("isNativeActive")) {
                UpiNativeBar(node, modifier)
            } else {
                ZnBox(node, modifier, depth + 1)
            }
        }
        "Text" -> ZnText(node, modifier)
        "Pressable" -> ZnPressable(node, modifier, depth + 1)
        "Spacer" -> ZnSpacer(node, modifier)
        "Image" -> ZnImage(node, modifier)
        else -> Box(modifier)
    }
}

@Composable
private fun ZnColumn(node: ZnNode, modifier: Modifier, depth: Int = 0) {
    val baseMod = applyNodeModifiers(node, modifier)
    val gap = node.getInt("gap", 0).dp
    val verticalArrangement = if (gap > 0.dp) Arrangement.spacedBy(gap) else parseVerticalArrangement(node.getString("justify"))
    val horizontalAlignment = parseHorizontalAlignment(node.getString("align"))

    Column(
        modifier = baseMod,
        verticalArrangement = verticalArrangement,
        horizontalAlignment = horizontalAlignment
    ) {
        for (childId in node.children) {
            key(childId) {
                ZnChildInColumn(childId, depth)
            }
        }
    }
}

@Composable
private fun ZnLazyColumn(node: ZnNode, modifier: Modifier, depth: Int = 0) {
    val baseMod = applyNodeModifiers(node, modifier)
    val gap = node.getInt("gap", 0).dp
    val children = node.children
    val listState = rememberLazyListState()

    // 90Hz / 120Hz Scroll Performance Instrumentation
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
                        Log.i("zn-scroll", "[LAZY_SCROLL] Fling finished: $totalFrames frames, $jankFrames jank frames (${"%.1f".format(if (totalFrames > 0) (totalFrames - jankFrames) * 100.0 / totalFrames else 100.0)}% smooth)")
                    }
                }
            }
            Choreographer.getInstance().postFrameCallback(callback)
        }
    }

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
private fun ZnVirtualList(node: ZnNode, modifier: Modifier) {
    val baseMod = applyNodeModifiers(node, modifier)
    val gap = node.getInt("gap", 8).dp
    val totalCount = node.getInt("totalCount", 0)
    val windowStart = node.getInt("windowStart", 0)
    val templateRootId = node.getInt("templateRootId", -1)
    val rawData = node.prop("data").value
    val listState = rememberLazyListState()

    val slotList = remember(rawData) { parseSlotDataList(rawData) }

    val windowMap = remember(windowStart, slotList) {
        val map = HashMap<Int, Map<String, Any?>>(slotList.size)
        for (i in slotList.indices) {
            map[windowStart + i] = slotList[i]
        }
        map
    }

    LaunchedEffect(listState, node.id) {
        var lastDispatched = -1
        snapshotFlow { listState.firstVisibleItemIndex }
            .distinctUntilChanged()
            .collect { firstIndex ->
                if (Math.abs(firstIndex - lastDispatched) >= 8) {
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
            val slots = windowMap[index]
            ZnSlotView(templateRootId, slots)
        }
    }
}

private fun resolveSlotValue(raw: Any?, slots: Map<String, Any?>?): Any? {
    if (raw !is String) return raw
    if (raw.startsWith("{{slot:") && raw.endsWith("}}")) {
        val key = raw.substring(7, raw.length - 2)
        return slots?.get(key)
    }
    if (raw.startsWith("{{cond:") && raw.endsWith("}}")) {
        val content = raw.substring(7, raw.length - 2)
        val parts = content.split(":")
        if (parts.size >= 3) {
            val key = parts[0]
            val trueVal = parts[1]
            val falseVal = parts[2]
            val cond = slots?.get(key)
            val isTrue = when (cond) {
                is Boolean -> cond
                is Number -> cond.toInt() != 0
                is String -> cond.isNotEmpty() && cond != "false" && cond != "0"
                else -> false
            }
            return if (isTrue) trueVal else falseVal
        }
    }
    return raw
}

private fun applySlotModifiers(node: ZnNode, modifier: Modifier, slots: Map<String, Any?>?): Modifier {
    var mod = modifier

    if (node.getBoolean("fill", false)) {
        mod = mod.fillMaxSize()
    } else {
        val widthStr = node.getString("width", "")
        if (widthStr.endsWith("%")) {
            val pct = widthStr.removeSuffix("%").toFloatOrNull()
            if (pct != null && pct > 0f) {
                mod = mod.fillMaxWidth(pct / 100f)
            }
        } else {
            val w = node.getInt("width", 0)
            if (w > 0) mod = mod.width(w.dp)
        }

        val heightStr = node.getString("height", "")
        if (heightStr.endsWith("%")) {
            val pct = heightStr.removeSuffix("%").toFloatOrNull()
            if (pct != null && pct > 0f) {
                mod = mod.fillMaxHeight(pct / 100f)
            }
        } else {
            val h = node.getInt("height", 0)
            if (h > 0) mod = mod.height(h.dp)
        }
    }

    val radius = node.getInt("radius", 0)
    if (radius > 0) {
        mod = mod.clip(RoundedCornerShape(radius.dp))
    }

    val rawBg = node.prop("bg").value
    val resolvedBg = resolveSlotValue(rawBg, slots)?.toString() ?: ""
    val bgColor = if (slots == null && rawBg is String && rawBg.startsWith("{{")) {
        Color(0xFFF1F5F9)
    } else if (resolvedBg.isNotEmpty()) {
        ZnColors.parseColor(resolvedBg)
    } else null
    if (bgColor != null) {
        mod = mod.background(bgColor)
    }

    val border = node.getInt("border", 0)
    if (border > 0) {
        val borderColorHex = node.getString("borderColor", "#000000")
        val borderColor = ZnColors.parseColor(borderColorHex)
        mod = if (radius > 0) {
            mod.border(border.dp, borderColor, RoundedCornerShape(radius.dp))
        } else {
            mod.border(border.dp, borderColor)
        }
    }

    val pad = node.getInt("padding", 0)
    if (pad > 0) {
        mod = mod.padding(pad.dp)
    } else {
        val padH = node.getInt("paddingHorizontal", 0)
        val padV = node.getInt("paddingVertical", 0)
        if (padH > 0 || padV > 0) {
            mod = mod.padding(horizontal = padH.dp, vertical = padV.dp)
        }
    }

    return mod
}

@Composable
private fun ZnSlotView(nodeId: Int, slots: Map<String, Any?>?, modifier: Modifier = Modifier) {
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
                else -> FontWeight.Normal
            }
            val rawColor = node.prop("color").value
            val resolvedColorStr = resolveSlotValue(rawColor, slots)?.toString()
            val color = if (slots == null && rawColor is String && rawColor.startsWith("{{")) {
                Color(0xFFCBD5E1)
            } else if (!resolvedColorStr.isNullOrEmpty()) {
                ZnColors.parseColor(resolvedColorStr)
            } else {
                Color(0xFF0F172A)
            }

            BasicText(
                text = if (slots == null && resolvedText.isNotEmpty()) " " else resolvedText,
                modifier = baseMod,
                style = TextStyle(color = color, fontSize = size, fontWeight = weight)
            )
        }
        "Spacer" -> {
            val width = node.getInt("width", 0).dp
            val height = node.getInt("height", 0).dp
            Spacer(modifier = if (width > 0.dp) Modifier.width(width) else Modifier.height(height))
        }
    }
}

private fun parseSlotDataList(raw: Any?): List<Map<String, Any?>> {
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
            map[key] = obj.get(key)
        }
        result.add(map)
    }
    return result
}

@Composable
private fun ColumnScope.ZnChildInColumn(childId: Int, depth: Int = 0) {
    val child = NodeStore.nodes[childId] ?: return
    val weight = child.getFloat("weight", 0f)
    val mod = if (weight > 0f) Modifier.weight(weight) else Modifier
    ZnView(childId, mod, depth)
}

@Composable
private fun ZnRow(node: ZnNode, modifier: Modifier, depth: Int = 0) {
    val baseMod = applyNodeModifiers(node, modifier)
    val gap = node.getInt("gap", 0).dp
    val horizontalArrangement = if (gap > 0.dp) Arrangement.spacedBy(gap) else parseHorizontalArrangement(node.getString("justify"))
    val verticalAlignment = parseVerticalAlignment(node.getString("align"))

    Row(
        modifier = baseMod,
        horizontalArrangement = horizontalArrangement,
        verticalAlignment = verticalAlignment
    ) {
        for (childId in node.children) {
            key(childId) {
                ZnChildInRow(childId, depth)
            }
        }
    }
}

@Composable
private fun RowScope.ZnChildInRow(childId: Int, depth: Int = 0) {
    val child = NodeStore.nodes[childId] ?: return
    val weight = child.getFloat("weight", 0f)
    val mod = if (weight > 0f) Modifier.weight(weight) else Modifier
    ZnView(childId, mod, depth)
}

@Composable
private fun ZnBox(node: ZnNode, modifier: Modifier, depth: Int = 0) {
    val baseMod = applyNodeModifiers(node, modifier)
    val contentAlignment = parseBoxAlignment(node.getString("align"), node.getString("justify"))

    Box(modifier = baseMod, contentAlignment = contentAlignment) {
        for (childId in node.children) {
            key(childId) {
                ZnView(childId, depth = depth)
            }
        }
    }
}

/**
 * Native Compose Animatable Glide Bar
 * Logs high-resolution frame timestamps with tag "zn-frame" to verify
 * Compose Choreographer keeps ticking at 60 FPS (dt <= 20ms) during onPause()!
 */
@Composable
private fun UpiNativeBar(node: ZnNode, modifier: Modifier) {
    val isNativeActive = node.getBoolean("isNativeActive", false)
    val progress = remember { Animatable(0f) }

    LaunchedEffect(isNativeActive) {
        if (isNativeActive) {
            progress.snapTo(0f)
            val startTime = System.nanoTime()
            var lastFrameTime = startTime

            // Segment 1: 0% -> 60% in 400ms (Fast EaseOut)
            progress.animateTo(
                targetValue = 0.60f,
                animationSpec = tween(durationMillis = 400, easing = FastOutSlowInEasing)
            ) {
                val now = System.nanoTime()
                val dtMs = (now - lastFrameTime) / 1_000_000.0
                lastFrameTime = now
                Log.i("zn-frame", "[FRAME] native_bar progress=${"%.3f".format(value)} dt=${"%.2f".format(dtMs)}ms (seg1)")
            }

            // Segment 2: 60% -> 82% in 600ms (Linear Crawl)
            progress.animateTo(
                targetValue = 0.82f,
                animationSpec = tween(durationMillis = 600, easing = LinearEasing)
            ) {
                val now = System.nanoTime()
                val dtMs = (now - lastFrameTime) / 1_000_000.0
                lastFrameTime = now
                Log.i("zn-frame", "[FRAME] native_bar progress=${"%.3f".format(value)} dt=${"%.2f".format(dtMs)}ms (seg2)")
            }

            // Segment 3: 82% -> 94% in 1400ms (Asymptotic EaseOut)
            progress.animateTo(
                targetValue = 0.94f,
                animationSpec = tween(durationMillis = 1400, easing = FastOutSlowInEasing)
            ) {
                val now = System.nanoTime()
                val dtMs = (now - lastFrameTime) / 1_000_000.0
                lastFrameTime = now
                Log.i("zn-frame", "[FRAME] native_bar progress=${"%.3f".format(value)} dt=${"%.2f".format(dtMs)}ms (seg3)")
            }
        } else {
            progress.snapTo(0f)
        }
    }

    val radius = node.getInt("radius", 3).dp
    val bgHex = node.prop("bg").value as? String ?: "#059669"
    val bgColor = ZnColors.parseColor(bgHex)
    val heightDp = node.getInt("height", 6).dp

    Box(
        modifier = modifier
            .fillMaxWidth(progress.value.coerceIn(0f, 1f))
            .height(heightDp)
            .clip(RoundedCornerShape(radius))
            .background(bgColor)
    )
}

/**
 * Leaf Text Composable
 */
@Composable
private fun ZnText(node: ZnNode, modifier: Modifier) {
    node.debugRecomposeCount++

    val textState = node.prop("text")
    val textValue = (textState.value as? String) ?: ""

    val colorHex = (node.prop("color").value as? String) ?: "#1C1C1C"
    val textColor = ZnColors.parseColor(colorHex)

    val sizeInt = node.getInt("size", 16)
    val weightStr = node.getString("weight", "normal")
    val autoShrink = node.getBoolean("autoShrink", false)

    val fontWeight = when (weightStr) {
        "bold" -> FontWeight.Bold
        "extrabold" -> FontWeight.ExtraBold
        "medium" -> FontWeight.Medium
        else -> FontWeight.Normal
    }

    val effectiveSize = if (autoShrink && textValue.length > 6) {
        (sizeInt * 0.75).toInt().sp
    } else {
        sizeInt.sp
    }

    BasicText(
        text = textValue,
        modifier = applyNodeModifiers(node, modifier),
        style = TextStyle(
            color = textColor,
            fontSize = effectiveSize,
            fontWeight = fontWeight,
            fontFamily = FontFamily.Default
        )
    )
}

/**
 * Leaf Pressable Composable
 */
@Composable
private fun ZnPressable(node: ZnNode, modifier: Modifier, depth: Int = 0) {
    val view = LocalView.current
    var isPressed by remember { mutableStateOf(false) }

    val disabledState = node.prop("disabled")
    val isDisabled = (disabledState.value as? Boolean) ?: false

    val targetScale = if (isPressed && !isDisabled) {
        node.getFloat("pressedScale", 0.95f)
    } else {
        1.0f
    }

    val animatedScale by animateFloatAsState(
        targetValue = targetScale,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioLowBouncy),
        label = "press_scale"
    )

    val baseMod = applyNodeModifiers(node, modifier)
        .scale(animatedScale)
        .pointerInput(isDisabled) {
            if (isDisabled) return@pointerInput
            detectTapGestures(
                onPress = {
                    isPressed = true
                    view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)

                    if (node.hasEvent("onTouchDown")) {
                        NodeStore.recordTap(node.id, "onTouchDown")
                        ZnBridge.dispatchEvent(node.id, "onTouchDown")
                    }

                    tryAwaitRelease()

                    isPressed = false
                    if (node.hasEvent("onTouchUp")) {
                        ZnBridge.dispatchEvent(node.id, "onTouchUp")
                    }
                    if (node.hasEvent("onPress")) {
                        NodeStore.recordTap(node.id, "onPress")
                        ZnBridge.dispatchEvent(node.id, "onPress")
                    }
                }
            )
        }

    val contentAlignment = parseBoxAlignment(node.getString("align"), node.getString("justify"))

    Box(modifier = baseMod, contentAlignment = contentAlignment) {
        for (childId in node.children) {
            key(childId) {
                ZnView(childId, depth = depth)
            }
        }
    }
}

@Composable
private fun ZnSpacer(node: ZnNode, modifier: Modifier) {
    val width = node.getInt("width", 0).dp
    val height = node.getInt("height", 0).dp
    var mod = modifier
    if (width > 0.dp) mod = mod.width(width)
    if (height > 0.dp) mod = mod.height(height)
    Spacer(modifier = mod)
}

@Composable
private fun ZnImage(node: ZnNode, modifier: Modifier) {
    val src = (node.prop("src").value as? String) ?: ""
    val baseMod = applyNodeModifiers(node, modifier)
    val context = LocalContext.current

    val model: Any? = if (src.startsWith("zn://")) {
        val cached = ZnResourceRegistry.get(src)
        if (cached != null) {
            cached
        } else if (src.startsWith("zn://app-icon/")) {
            val pkg = src.removePrefix("zn://app-icon/")
            try {
                val icon = context.packageManager.getApplicationIcon(pkg)
                ZnResourceRegistry.register(src, icon)
                icon
            } catch (e: Exception) {
                Log.w("zn", "[ZnImage] Failed to load application icon for $pkg", e)
                null
            }
        } else {
            null
        }
    } else {
        src
    }

    Log.i("zn", "[ZnImage] src=$src -> resolved model=${model?.javaClass?.simpleName}")

    AsyncImage(
        model = model,
        contentDescription = null,
        modifier = baseMod
    )
}

// --- Layout Helpers ---

private fun applyNodeModifiers(node: ZnNode, modifier: Modifier): Modifier {
    var mod = modifier

    if (node.getBoolean("fill", false)) {
        mod = mod.fillMaxSize()
    } else {
        val widthStr = node.getString("width", "")
        if (widthStr.endsWith("%")) {
            val pct = widthStr.removeSuffix("%").toFloatOrNull()
            if (pct != null && pct > 0f) {
                mod = mod.fillMaxWidth(pct / 100f)
            }
        } else {
            val width = node.getInt("width", 0)
            if (width > 0) mod = mod.width(width.dp)
        }

        val heightStr = node.getString("height", "")
        if (heightStr == "100%") {
            mod = mod.fillMaxHeight()
        } else {
            val height = node.getInt("height", 0)
            if (height > 0) mod = mod.height(height.dp)
        }
    }

    val radius = node.getInt("radius", 0).dp
    if (radius > 0.dp) {
        mod = mod.clip(RoundedCornerShape(radius))
    }

    val bgHex = node.prop("bg").value as? String
    if (!bgHex.isNullOrBlank()) {
        val bgColor = ZnColors.parseColor(bgHex)
        if (bgColor != Color.Unspecified) {
            mod = if (radius > 0.dp) {
                mod.background(bgColor, RoundedCornerShape(radius))
            } else {
                mod.background(bgColor)
            }
        }
    }

    val border = node.getInt("border", 0)
    if (border > 0) {
        val borderColorHex = node.getString("borderColor", "#E2E8F0")
        val borderColor = ZnColors.parseColor(borderColorHex)
        mod = if (radius > 0.dp) {
            mod.border(border.dp, borderColor, RoundedCornerShape(radius))
        } else {
            mod.border(border.dp, borderColor)
        }
    }

    val p = node.getInt("padding", 0)
    if (p > 0) {
        mod = mod.padding(p.dp)
    } else {
        val ph = node.getInt("paddingHorizontal", 0)
        val pv = node.getInt("paddingVertical", 0)
        if (ph > 0 || pv > 0) {
            mod = mod.padding(horizontal = ph.dp, vertical = pv.dp)
        }
    }

    val mt = node.getInt("marginTop", 0)
    if (mt > 0) mod = mod.padding(top = mt.dp)

    val opacity = node.getFloat("opacity", 1f)
    // Opacity can be handled if needed or via alpha modifier

    return mod
}

private fun parseVerticalArrangement(justify: String): Arrangement.Vertical {
    return when (justify) {
        "center" -> Arrangement.Center
        "space-between" -> Arrangement.SpaceBetween
        "flex-end" -> Arrangement.Bottom
        else -> Arrangement.Top
    }
}

private fun parseHorizontalArrangement(justify: String): Arrangement.Horizontal {
    return when (justify) {
        "center" -> Arrangement.Center
        "space-between" -> Arrangement.SpaceBetween
        "flex-end" -> Arrangement.End
        else -> Arrangement.Start
    }
}

private fun parseHorizontalAlignment(align: String): Alignment.Horizontal {
    return when (align) {
        "center" -> Alignment.CenterHorizontally
        "flex-end" -> Alignment.End
        else -> Alignment.Start
    }
}

private fun parseVerticalAlignment(align: String): Alignment.Vertical {
    return when (align) {
        "center" -> Alignment.CenterVertically
        "flex-end" -> Alignment.Bottom
        else -> Alignment.Top
    }
}

private fun parseBoxAlignment(align: String, justify: String): Alignment {
    return if (align == "center" && justify == "center") {
        Alignment.Center
    } else if (align == "center") {
        Alignment.CenterStart
    } else if (justify == "center") {
        Alignment.TopCenter
    } else {
        Alignment.TopStart
    }
}

