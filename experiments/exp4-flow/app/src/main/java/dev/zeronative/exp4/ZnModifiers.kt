package dev.zeronative.exp4

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

/**
 * Robust Color Parser supporting #RGB, #RGBA, #RRGGBB, #AARRGGBB and named tokens
 */
fun parseColor(raw: Any?): Color {
    if (raw == null) return Color.Transparent
    if (raw is Long) return Color(raw)
    if (raw is Int) return Color(raw.toLong() and 0xFFFFFFFFL)
    val str = raw.toString().trim()
    if (str.isEmpty()) return Color.Transparent
    if (str.startsWith("#")) {
        val hex = str.substring(1)
        return try {
            when (hex.length) {
                3 -> { // #RGB
                    val r = hex.substring(0, 1).repeat(2).toInt(16)
                    val g = hex.substring(1, 2).repeat(2).toInt(16)
                    val b = hex.substring(2, 3).repeat(2).toInt(16)
                    Color(r, g, b, 255)
                }
                4 -> { // #RGBA
                    val r = hex.substring(0, 1).repeat(2).toInt(16)
                    val g = hex.substring(1, 2).repeat(2).toInt(16)
                    val b = hex.substring(2, 3).repeat(2).toInt(16)
                    val a = hex.substring(3, 4).repeat(2).toInt(16)
                    Color(r, g, b, a)
                }
                6 -> { // #RRGGBB
                    Color(android.graphics.Color.parseColor("#$hex"))
                }
                8 -> { // #AARRGGBB or #RRGGBBAA
                    Color(android.graphics.Color.parseColor("#$hex"))
                }
                else -> Color.Transparent
            }
        } catch (_: Exception) {
            Color.Transparent
        }
    }
    return when (str.lowercase()) {
        "white" -> Color.White
        "black" -> Color.Black
        "transparent" -> Color.Transparent
        "red" -> Color.Red
        "green" -> Color.Green
        "blue" -> Color.Blue
        "gray" -> Color.Gray
        else -> Color.Transparent
    }
}

/**
 * Slot Value Token Resolver for Fast Virtualized Templates
 */
fun resolveSlotValue(raw: Any?, slots: Map<String, Any?>?): Any? {
    if (raw !is String) return raw
    if (raw.startsWith("{{slot:") && raw.endsWith("}}")) {
        val key = raw.substring(7, raw.length - 2)
        return slots?.get(key) ?: ""
    }
    if (raw.startsWith("{{cond:") && raw.endsWith("}}")) {
        val parts = raw.substring(7, raw.length - 2).split(":")
        if (parts.size >= 3) {
            val key = parts[0]
            val trueVal = parts[1]
            val falseVal = parts[2]
            val cond = slots?.get(key)
            val isTrue = when (cond) {
                is Boolean -> cond
                is Number -> cond.toInt() != 0
                is String -> cond == "true" || cond == "1"
                else -> false
            }
            return if (isTrue) trueVal else falseVal
        }
    }
    return raw
}

/**
 * Sequential Chained Modifier Pipeline (Argon Specification)
 * Preserves exact semantic evaluation order without prop bloat
 */
@Composable
fun applyModifierChain(base: Modifier, modifiersJson: String, node: ZnNode): Modifier {
    var mod = base
    try {
        val tuples = JSONArray(modifiersJson)
        for (i in 0 until tuples.length()) {
            val item = tuples.getJSONArray(i)
            val type = item.getString(0)
            mod = when (type) {
                "padAll" -> mod.padding(item.getInt(1).dp)
                "pad" -> mod.padding(
                    top = item.getInt(1).dp,
                    bottom = item.getInt(2).dp,
                    start = item.getInt(3).dp,
                    end = item.getInt(4).dp
                )
                "bg" -> {
                    val color = parseColor(item.getString(1))
                    val radius = item.optInt(2, 0)
                    if (radius > 0) mod.background(color, RoundedCornerShape(radius.dp))
                    else mod.background(color)
                }
                "width" -> {
                    val w = item.get(1)
                    if (w == "100%") mod.fillMaxWidth() else mod.width(item.getInt(1).dp)
                }
                "height" -> {
                    val h = item.get(1)
                    if (h == "100%") mod.fillMaxHeight() else mod.height(item.getInt(1).dp)
                }
                "size" -> mod.size(item.getInt(1).dp, item.getInt(2).dp)
                "fillMax" -> mod.fillMaxSize()
                "clip" -> mod.clip(RoundedCornerShape(item.getInt(1).dp))
                "border" -> {
                    val width = item.getInt(1)
                    val color = parseColor(item.getString(2))
                    val radius = item.optInt(3, 0)
                    if (radius > 0) mod.border(width.dp, color, RoundedCornerShape(radius.dp))
                    else mod.border(width.dp, color)
                }
                "alpha" -> mod.alpha(item.getDouble(1).toFloat())
                "click" -> {
                    val eventKey = "mod_click_${node.id}_$i"
                    mod.clickable {
                        ZnBridge.dispatchEvent(node.id, eventKey)
                    }
                }
                else -> mod
            }
        }
    } catch (_: Exception) {
    }
    return mod
}

/**
 * Applies Node Modifiers with Backward Compatibility for Flat Props & Chained Modifiers
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun applyNodeModifiers(node: ZnNode, modifier: Modifier): Modifier {
    var mod = modifier

    // 1. Chained Modifiers (Primary Argon Engine)
    val chainedModifiers = node.getString("modifiers", "")
    if (chainedModifiers.isNotEmpty()) {
        mod = applyModifierChain(mod, chainedModifiers, node)
    }

    // 2. Flat Layout Dimensions (Backward Compatible)
    val widthVal = node.prop("width").value
    val heightVal = node.prop("height").value
    val fill = node.getBoolean("fill", false)
    val fillWidth = node.getBoolean("fillWidth", false)
    val fillHeight = node.getBoolean("fillHeight", false)

    if (fill) {
        mod = mod.fillMaxSize()
    } else {
        if (fillWidth || widthVal == "100%") mod = mod.fillMaxWidth()
        else if (widthVal is Number) mod = mod.width(widthVal.toInt().dp)

        if (fillHeight || heightVal == "100%") mod = mod.fillMaxHeight()
        else if (heightVal is Number) mod = mod.height(heightVal.toInt().dp)
    }

    // 3. Padding
    val pad = node.getInt("padding", 0)
    if (pad > 0) {
        mod = mod.padding(pad.dp)
    } else {
        val padH = node.getInt("paddingHorizontal", 0)
        val padV = node.getInt("paddingVertical", 0)
        val padT = node.getInt("paddingTop", 0)
        val padB = node.getInt("paddingBottom", 0)
        val padL = node.getInt("paddingLeft", 0)
        val padR = node.getInt("paddingRight", 0)

        if (padH > 0 || padV > 0 || padT > 0 || padB > 0 || padL > 0 || padR > 0) {
            mod = mod.padding(
                start = (if (padL > 0) padL else padH).dp,
                top = (if (padT > 0) padT else padV).dp,
                end = (if (padR > 0) padR else padH).dp,
                bottom = (if (padB > 0) padB else padV).dp
            )
        }
    }

    // 4. Background & Shape
    val bg = node.prop("bg").value ?: node.prop("backgroundColor").value
    val radius = node.getInt("radius", 0).coerceAtLeast(node.getInt("borderRadius", 0))
    if (bg != null) {
        val bgColor = parseColor(bg)
        mod = if (radius > 0) {
            mod.background(bgColor, RoundedCornerShape(radius.dp))
        } else {
            mod.background(bgColor)
        }
    }

    // 5. Border
    val borderWidth = node.getInt("border", 0).coerceAtLeast(node.getInt("borderWidth", 0))
    val borderColor = node.prop("borderColor").value
    if (borderWidth > 0 && borderColor != null) {
        val bColor = parseColor(borderColor)
        mod = if (radius > 0) {
            mod.border(borderWidth.dp, bColor, RoundedCornerShape(radius.dp))
        } else {
            mod.border(borderWidth.dp, bColor)
        }
    }

    // 6. Clip
    if (radius > 0 && bg == null && borderWidth == 0) {
        mod = mod.clip(RoundedCornerShape(radius.dp))
    }

    // 7. Hero Transitions (Only for non-virtual static cards)
    val heroTag = node.getString("heroTag", "")
    if (heroTag.isNotEmpty()) {
        val sharedScope = LocalSharedTransitionScope.current
        val animScope = LocalAnimatedVisibilityScope.current
        if (sharedScope != null && animScope != null) {
            with(sharedScope) {
                mod = mod.sharedElement(
                    rememberSharedContentState(key = heroTag),
                    animatedVisibilityScope = animScope
                )
            }
        }
    }

    return mod
}

/**
 * Applies Slot Modifiers for Virtualized Template Instantiations
 */
@Composable
fun applySlotModifiers(node: ZnNode, modifier: Modifier, slots: Map<String, Any?>?): Modifier {
    var mod = modifier

    // 1. Dimensions
    val widthVal = resolveSlotValue(node.prop("width").value, slots)
    val heightVal = resolveSlotValue(node.prop("height").value, slots)

    if (widthVal == "100%") mod = mod.fillMaxWidth()
    else if (widthVal is Number) mod = mod.width(widthVal.toInt().dp)

    if (heightVal == "100%") mod = mod.fillMaxHeight()
    else if (heightVal is Number) mod = mod.height(heightVal.toInt().dp)

    // 2. Background
    val rawBg = resolveSlotValue(node.prop("bg").value, slots)
    val rawRadius = resolveSlotValue(node.prop("radius").value, slots)
    val radius = when (rawRadius) {
        is Number -> rawRadius.toInt()
        is String -> rawRadius.toIntOrNull() ?: 0
        else -> 0
    }

    if (rawBg != null) {
        val bgColor = parseColor(rawBg)
        mod = if (radius > 0) {
            mod.background(bgColor, RoundedCornerShape(radius.dp))
        } else {
            mod.background(bgColor)
        }
    }

    // 3. Border
    val rawBorder = resolveSlotValue(node.prop("border").value, slots)
    val borderWidth = when (rawBorder) {
        is Number -> rawBorder.toInt()
        is String -> rawBorder.toIntOrNull() ?: 0
        else -> 0
    }
    val rawBorderColor = resolveSlotValue(node.prop("borderColor").value, slots)
    if (borderWidth > 0 && rawBorderColor != null) {
        val bColor = parseColor(rawBorderColor)
        mod = if (radius > 0) {
            mod.border(borderWidth.dp, bColor, RoundedCornerShape(radius.dp))
        } else {
            mod.border(borderWidth.dp, bColor)
        }
    }

    // 4. Padding
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

    // 5. Item Press Handler
    if (node.hasEvent("onPress")) {
        val itemId = slots?.get("id")?.toString() ?: ""
        val payloadJson = if (itemId.isNotEmpty()) "{\"id\":$itemId}" else "{}"
        mod = mod.clickable {
            ZnBridge.dispatchEvent(node.id, "onPress", payloadJson)
        }
    }

    return mod
}
