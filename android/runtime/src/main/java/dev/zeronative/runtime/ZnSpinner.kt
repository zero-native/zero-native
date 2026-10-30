package dev.zeronative.runtime

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp

/**
 * Native endless circular spinner (milestone 3 step 3.7).
 * Continuous rotation in the draw phase: zero recompositions per frame.
 */
@Composable
internal fun ZnSpinner(s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    if (ZnDebug.countRecompositions) SideEffect { ZnDebug.hit("Spinner#${inst.id}.${s.index}") }

    val spinnerSize = (s.size ?: 24f).dp
    val spinnerColor = (if (s.colorSlot >= 0) toColor(inst.slot(s.colorSlot).value) else s.color) ?: Color(0xFF10B981)

    val transition = rememberInfiniteTransition(label = "ZnSpinner")
    val rotation = transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(1000, easing = LinearEasing)
        ),
        label = "ZnSpinnerRotation"
    )

    Box(
        modifier = mod
            .size(spinnerSize)
            .drawBehind {
                val strokeWidth = (this.size.minDimension * 0.1f).coerceIn(2.dp.toPx(), 4.dp.toPx())
                val arcSize = Size(this.size.width - strokeWidth, this.size.height - strokeWidth)
                val topLeft = Offset(strokeWidth / 2f, strokeWidth / 2f)

                // Read rotation inside draw lambda only -> zero recompositions per frame!
                val currentAngle = rotation.value

                drawArc(
                    color = spinnerColor,
                    startAngle = currentAngle,
                    sweepAngle = 270f,
                    useCenter = false,
                    topLeft = topLeft,
                    size = arcSize,
                    style = Stroke(width = strokeWidth, cap = StrokeCap.Round)
                )
            }
    )
}

