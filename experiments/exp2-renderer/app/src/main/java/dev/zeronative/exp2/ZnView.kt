package dev.zeronative.exp2

import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage

@Composable
fun ZnView(id: Int, modifier: Modifier = Modifier) {
    val node = NodeStore.nodes[id] ?: return

    when (node.type) {
        "Column" -> ZnColumn(node, modifier)
        "Row" -> ZnRow(node, modifier)
        "Box" -> ZnBox(node, modifier)
        "Text" -> ZnText(node, modifier)
        "Pressable" -> ZnPressable(node, modifier)
        "Spacer" -> ZnSpacer(node, modifier)
        "Image" -> ZnImage(node, modifier)
        else -> Box(modifier)
    }
}

@Composable
private fun ZnColumn(node: ZnNode, modifier: Modifier) {
    android.util.Log.i("zn", "[RECOMPOSE_PARENT] Column ${node.id} recomposed")
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
                ZnChildInColumn(childId)
            }
        }
    }
}

@Composable
private fun ColumnScope.ZnChildInColumn(childId: Int) {
    val child = NodeStore.nodes[childId] ?: return
    val weight = child.getFloat("weight", 0f)
    val mod = if (weight > 0f) Modifier.weight(weight) else Modifier
    ZnView(childId, mod)
}

@Composable
private fun ZnRow(node: ZnNode, modifier: Modifier) {
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
                ZnChildInRow(childId)
            }
        }
    }
}

@Composable
private fun RowScope.ZnChildInRow(childId: Int) {
    val child = NodeStore.nodes[childId] ?: return
    val weight = child.getFloat("weight", 0f)
    val mod = if (weight > 0f) Modifier.weight(weight) else Modifier
    ZnView(childId, mod)
}

@Composable
private fun ZnBox(node: ZnNode, modifier: Modifier) {
    val baseMod = applyNodeModifiers(node, modifier)
    val contentAlignment = parseBoxAlignment(node.getString("align"), node.getString("justify"))

    Box(modifier = baseMod, contentAlignment = contentAlignment) {
        for (childId in node.children) {
            key(childId) {
                ZnView(childId)
            }
        }
    }
}

/**
 * Leaf Text Composable
 * Recomposition Isolation: Reads `node.prop(...)` strictly inside here!
 */
@Composable
private fun ZnText(node: ZnNode, modifier: Modifier) {
    node.debugRecomposeCount++

    val textState = node.prop("text")
    val textValue = (textState.value as? String) ?: ""
    android.util.Log.i("zn", "[RECOMPOSE_LEAF] Text node ${node.id} recomposed: text='$textValue'")

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

    // Dynamic autoShrink for 7-digit amounts
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
 * Handles native touch feedback, spring scale animations, and haptics.
 */
@Composable
private fun ZnPressable(node: ZnNode, modifier: Modifier) {
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
                ZnView(childId)
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

    AsyncImage(
        model = src,
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
        if (widthStr == "100%") {
            mod = mod.fillMaxWidth()
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
