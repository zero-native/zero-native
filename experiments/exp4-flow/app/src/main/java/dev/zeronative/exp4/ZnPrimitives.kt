package dev.zeronative.exp4

import android.util.Log
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage

@Composable
fun ZnRow(node: ZnNode, modifier: Modifier, depth: Int = 0) {
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
fun RowScope.ZnChildInRow(childId: Int, depth: Int) {
    val childNode = NodeStore.nodes[childId] ?: return
    val weight = childNode.getFloat("weight", 0f)
    val childMod = if (weight > 0f) Modifier.weight(weight) else Modifier
    ZnView(childId, childMod, depth + 1)
}

@Composable
fun ZnColumn(node: ZnNode, modifier: Modifier, depth: Int = 0) {
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
fun ColumnScope.ZnChildInColumn(childId: Int, depth: Int) {
    val childNode = NodeStore.nodes[childId] ?: return
    val weight = childNode.getFloat("weight", 0f)
    val childMod = if (weight > 0f) Modifier.weight(weight) else Modifier
    ZnView(childId, childMod, depth + 1)
}

@Composable
fun ZnBox(node: ZnNode, modifier: Modifier, depth: Int = 0) {
    val baseMod = applyNodeModifiers(node, modifier)
    val contentAlignment = parseBoxAlignment(node.getString("align"), node.getString("justify"))

    Box(
        modifier = baseMod,
        contentAlignment = contentAlignment
    ) {
        for (childId in node.children) {
            key(childId) {
                ZnView(childId, depth = depth + 1)
            }
        }
    }
}

@Composable
fun ZnText(node: ZnNode, modifier: Modifier) {
    node.debugRecomposeCount++

    val textState = node.prop("text")
    val textValue = (textState.value as? String) ?: ""

    val colorHex = (node.prop("color").value as? String) ?: "#1C1C1C"
    val textColor = parseColor(colorHex)

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

@Composable
fun ZnPressable(node: ZnNode, modifier: Modifier, depth: Int = 0) {
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
fun ZnSpacer(node: ZnNode, modifier: Modifier) {
    val width = node.getInt("width", 0).dp
    val height = node.getInt("height", 0).dp
    var mod = modifier
    if (width > 0.dp) mod = mod.width(width)
    if (height > 0.dp) mod = mod.height(height)
    Spacer(modifier = mod)
}

@Composable
fun ZnImage(node: ZnNode, modifier: Modifier) {
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

    AsyncImage(
        model = model,
        contentDescription = null,
        modifier = baseMod
    )
}

@Composable
fun UpiNativeBar(node: ZnNode, modifier: Modifier) {
    val isNativeActive = node.getBoolean("isNativeActive", false)
    val progress = remember { Animatable(0f) }

    LaunchedEffect(isNativeActive) {
        if (isNativeActive) {
            progress.snapTo(0f)
            progress.animateTo(
                targetValue = 0.60f,
                animationSpec = tween(durationMillis = 400, easing = FastOutSlowInEasing)
            )
            progress.animateTo(
                targetValue = 0.82f,
                animationSpec = tween(durationMillis = 600, easing = LinearEasing)
            )
            progress.animateTo(
                targetValue = 0.94f,
                animationSpec = tween(durationMillis = 1400, easing = FastOutSlowInEasing)
            )
        } else {
            progress.snapTo(0f)
        }
    }

    val radius = node.getInt("radius", 3).dp
    val bgHex = node.prop("bg").value as? String ?: "#059669"
    val bgColor = parseColor(bgHex)
    val heightDp = node.getInt("height", 6).dp

    Box(
        modifier = modifier
            .fillMaxWidth(progress.value.coerceIn(0f, 1f))
            .height(heightDp)
            .clip(RoundedCornerShape(radius))
            .background(bgColor)
    )
}

fun parseVerticalArrangement(justify: String): Arrangement.Vertical {
    return when (justify) {
        "center" -> Arrangement.Center
        "space-between" -> Arrangement.SpaceBetween
        "flex-end" -> Arrangement.Bottom
        else -> Arrangement.Top
    }
}

fun parseHorizontalArrangement(justify: String): Arrangement.Horizontal {
    return when (justify) {
        "center" -> Arrangement.Center
        "space-between" -> Arrangement.SpaceBetween
        "flex-end" -> Arrangement.End
        else -> Arrangement.Start
    }
}

fun parseHorizontalAlignment(align: String): Alignment.Horizontal {
    return when (align) {
        "center" -> Alignment.CenterHorizontally
        "flex-end" -> Alignment.End
        else -> Alignment.Start
    }
}

fun parseVerticalAlignment(align: String): Alignment.Vertical {
    return when (align) {
        "center" -> Alignment.CenterVertically
        "flex-end" -> Alignment.Bottom
        else -> Alignment.Top
    }
}

fun parseBoxAlignment(align: String, justify: String): Alignment {
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
