package dev.zeronative.runtime

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * Native Progress Bar (milestone 3 step 3.7).
 * Value 0–1 (determinate) with smooth draw-phase animation and snap on first show,
 * or indeterminate endless bar if no value prop is specified.
 */
@Composable
internal fun ZnProgress(s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    if (ZnDebug.countRecompositions) SideEffect { ZnDebug.hit("Progress#${inst.id}.${s.index}") }

    val hasValueProp = s.valueSlot >= 0 || s.value != null || s.rawValue != null
    val targetFraction: Float = if (hasValueProp) {
        val raw = if (s.valueSlot >= 0) inst.slot(s.valueSlot).value else (s.value ?: s.rawValue)
        val num = when (raw) {
            is Number -> raw.toFloat()
            is String -> raw.toFloatOrNull() ?: 0f
            else -> 0f
        }
        if (num.isNaN()) 0f else num.coerceIn(0f, 1f)
    } else 0f

    val progressColor = (if (s.colorSlot >= 0) toColor(inst.slot(s.colorSlot).value) else s.color) ?: Color(0xFF10B981)
    val trackColor = s.trackColor ?: Color(0xFFE5E7EB)

    val barHeight = when (val h = s.height) {
        is Double -> h.toFloat().dp
        else -> 4.dp
    }

    if (hasValueProp) {
        val anim = remember(inst.id) { Animatable(targetFraction) }
        var hasMounted by remember(inst.id) { androidx.compose.runtime.mutableStateOf(false) }
        LaunchedEffect(inst.id, targetFraction) {
            if (!hasMounted) {
                hasMounted = true
                anim.snapTo(targetFraction)
            } else {
                anim.animateTo(targetFraction, tween(150))
            }
        }

        Box(
            modifier = mod
                .fillMaxWidth()
                .height(barHeight)
                .drawBehind {
                    val radius = CornerRadius(size.height / 2f, size.height / 2f)
                    // Draw track
                    drawRoundRect(
                        color = trackColor,
                        size = size,
                        cornerRadius = radius
                    )
                    // Draw active progress
                    val currentVal = anim.value
                    if (currentVal > 0f) {
                        drawRoundRect(
                            color = progressColor,
                            size = Size(size.width * currentVal, size.height),
                            cornerRadius = radius
                        )
                    }
                }
        )
    } else {
        // Indeterminate endless bar
        val transition = rememberInfiniteTransition(label = "ZnProgressIndeterminate")
        val shift = transition.animateFloat(
            initialValue = -0.4f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(1200, easing = LinearEasing)
            ),
            label = "ZnProgressShift"
        )

        Box(
            modifier = mod
                .fillMaxWidth()
                .height(barHeight)
                .drawBehind {
                    val radius = CornerRadius(size.height / 2f, size.height / 2f)
                    drawRoundRect(
                        color = trackColor,
                        size = size,
                        cornerRadius = radius
                    )
                    val offsetFraction = shift.value
                    val barWidth = size.width * 0.4f
                    val startX = (size.width * offsetFraction).coerceIn(0f, size.width)
                    val endX = (size.width * (offsetFraction + 0.4f)).coerceIn(0f, size.width)
                    if (endX > startX) {
                        drawRoundRect(
                            color = progressColor,
                            topLeft = Offset(startX, 0f),
                            size = Size(endX - startX, size.height),
                            cornerRadius = radius
                        )
                    }
                }
        )
    }
}
