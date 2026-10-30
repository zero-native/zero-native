package dev.zeronative.runtime

import android.os.SystemClock
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color

/**
 * Native Shimmer component and modifier (milestone 3 step 3.7).
 * Synchronized across the entire screen using a shared time base (SystemClock.uptimeMillis() % period).
 * Zero recompositions per frame: animated frame pulse is read ONLY inside the draw phase.
 */
@Composable
internal fun ZnShimmer(s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    if (ZnDebug.countRecompositions) SideEffect { ZnDebug.hit("Shimmer#${inst.id}.${s.index}") }

    val baseColor = s.baseColor ?: Color(0xFFE5E7EB)
    val period = (s.period ?: 1200f).toLong().coerceAtLeast(100L)

    Box(
        modifier = mod.shimmerEffect(baseColor = baseColor, highlightColor = s.shimmerHighlight, periodMs = period)
    )
}

/**
 * Modifier extension to draw a synced shimmer gradient during the draw phase.
 */
@Composable
internal fun Modifier.shimmerEffect(
    baseColor: Color = Color(0xFFE5E7EB),
    highlightColor: Color = Color.White.copy(alpha = 0.55f),
    periodMs: Long = 1200L
): Modifier {
    val transition = rememberInfiniteTransition(label = "ZnShimmer")
    val pulse = transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(1000, easing = LinearEasing)
        ),
        label = "ZnShimmerPulse"
    )

    return this.drawBehind {
        // Read pulse in draw phase to invalidate draw on each frame without recomposition
        @Suppress("UNUSED_VARIABLE")
        val p = pulse.value

        val now = SystemClock.uptimeMillis()
        val progress = (now % periodMs).toFloat() / periodMs.toFloat()

        // Draw base background
        drawRect(color = baseColor)

        // Gradient sweep: -width to +2*width
        val sweepWidth = size.width * 1.5f
        val startX = -sweepWidth + progress * (size.width + sweepWidth)
        val endX = startX + sweepWidth

        val brush = Brush.linearGradient(
            colors = listOf(
                baseColor,
                highlightColor,
                baseColor
            ),
            start = Offset(startX, 0f),
            end = Offset(endX, size.height)
        )

        drawRect(brush = brush)
    }
}

