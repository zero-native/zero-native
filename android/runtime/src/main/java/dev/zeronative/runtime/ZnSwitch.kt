package dev.zeronative.runtime

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.unit.dp

/**
 * Controlled Switch (milestone 3 step 3.7).
 * Native only displays value and emits onValueChange(!value). Zero recomposition per frame while animating.
 */
@Composable
internal fun ZnSwitch(s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    if (ZnDebug.countRecompositions) SideEffect { ZnDebug.hit("Switch#${inst.id}.${s.index}") }

    val disabled = if (s.disabledSlot >= 0) inst.slot(s.disabledSlot).value == true else s.disabled
    val currentValue = if (s.valueSlot >= 0) {
        val v = inst.slot(s.valueSlot).value
        v == true || v == "true"
    } else {
        s.value == "true" || (s.rawValue == true)
    }

    val anim = remember(inst.id) { Animatable(if (currentValue) 1f else 0f) }
    var hasMounted by remember(inst.id) { androidx.compose.runtime.mutableStateOf(false) }
    LaunchedEffect(inst.id, currentValue) {
        if (!hasMounted) {
            hasMounted = true
            anim.snapTo(if (currentValue) 1f else 0f)
        } else {
            anim.animateTo(if (currentValue) 1f else 0f, tween(150))
        }
    }

    val trackOff = s.trackColor ?: Color(0xFFD1D5DB)
    val trackOn = s.activeTrackColor ?: Color(0xFF10B981)
    val thumbColor = s.thumbColor ?: Color.White

    val interactions = remember { MutableInteractionSource() }
    val ripple = remember(s) { ZnRipple(s.rippleColor, s.rippleOpacity ?: 0.16f, bounded = false, radius = 20f) }

    val baseAlpha = if (disabled) 0.38f else 1f

    Box(
        modifier = mod
            .defaultMinSize(minWidth = 48.dp, minHeight = 48.dp)
            .indication(interactions, ripple)
            .semantics {
                role = Role.Switch
                toggleableState = ToggleableState(currentValue)
                if (disabled) disabled()
                onClick {
                    if (!disabled && s.onValueChange != 0) {
                        ZnRuntime.dispatchEvent(inst.id, s.onValueChange, !currentValue)
                    }
                    !disabled
                }
            }
            .then(
                if (!disabled && s.onValueChange != 0) {
                    Modifier.pointerInput(inst.id, currentValue) {
                        awaitEachGesture {
                            val down = awaitFirstDown(requireUnconsumed = false)
                            val press = PressInteraction.Press(down.position)
                            interactions.tryEmit(press)
                            val up = waitForUpOrCancellation()
                            if (up != null) {
                                interactions.tryEmit(PressInteraction.Release(press))
                                ZnRuntime.dispatchEvent(inst.id, s.onValueChange, !currentValue)
                            } else {
                                interactions.tryEmit(PressInteraction.Cancel(press))
                            }
                        }
                    }
                } else Modifier
            ),
        contentAlignment = Alignment.Center
    ) {
        Box(
            modifier = Modifier
                .size(width = 36.dp, height = 20.dp)
                .drawBehind {
                    val progress = anim.value
                    val currentTrack = lerp(trackOff, trackOn, progress).copy(alpha = baseAlpha)
                    val currentThumb = thumbColor.copy(alpha = baseAlpha)

                    // Draw track (36 x 20)
                    drawRoundRect(
                        color = currentTrack,
                        cornerRadius = CornerRadius(10.dp.toPx(), 10.dp.toPx()),
                        size = size
                    )

                    // Draw thumb (radius 8dp, centered vertically, moves from x=10dp to x=26dp)
                    val startX = 10.dp.toPx()
                    val endX = 26.dp.toPx()
                    val thumbX = startX + (endX - startX) * progress
                    val thumbY = 10.dp.toPx()
                    val thumbRadius = 8.dp.toPx()

                    drawCircle(
                        color = currentThumb,
                        radius = thumbRadius,
                        center = Offset(thumbX, thumbY)
                    )
                }
        )
    }
}
