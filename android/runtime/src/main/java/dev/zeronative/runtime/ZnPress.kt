package dev.zeronative.runtime

import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.foundation.Indication
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.onLongClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Press handling for Pressable (ARCHITECTURE.md §5.3):
 * - onPressIn when the finger goes down; then exactly one onPressOut, with payload `true` if the press was cancelled
 *   (finger dragged off, a scroll took over) and `false` if the finger was lifted;
 * - onLongPress after the system long-press timeout;
 * - onPressRepeat while the finger stays down: first after repeatDelay, then every repeatInterval. Native times it,
 *   so JS never runs a timer for press-and-hold (v0's "zombie timer" bug);
 * - onPress only for a completed tap that didn't long-press or repeat.
 * Also: the press highlight (indication), an optional system-setting-aware haptic tick, and accessibility (role
 * Button; TalkBack's activate sends onPress).
 */
internal fun Modifier.znPress(
    s: ZnNodeSpec,
    inst: ZnInstance,
    enabled: Boolean,
    view: View,
    interactions: MutableInteractionSource,
    indication: Indication?,
): Modifier {
    fun send(eventId: Int, payload: Any? = null) {
        if (eventId != 0) ZnRuntime.dispatchEvent(inst.id, eventId, payload)
    }

    val aLabel = if (s.accessibilityLabelSlot >= 0) {
        inst.slot(s.accessibilityLabelSlot).value as? String
    } else s.accessibilityLabel

    val base = this
        .indication(interactions, indication)
        .semantics(mergeDescendants = true) {
            if (s.accessibilityHidden) {
                @OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
                hideFromAccessibility()
            }
            when (s.accessibilityRole) {
                Registry.AccessibilityRole.NONE -> {
                    // Rule 29: accessibilityRole="none" removes the role but keeps the onClick action
                }
                Registry.AccessibilityRole.HEADER -> heading()
                Registry.AccessibilityRole.IMAGE -> role = Role.Image
                Registry.AccessibilityRole.SWITCH -> role = Role.Switch
                Registry.AccessibilityRole.CHECKBOX -> role = Role.Checkbox
                Registry.AccessibilityRole.BUTTON, null -> role = Role.Button
                else -> role = Role.Button
            }
            if (!enabled) disabled()
            if (aLabel != null) {
                contentDescription = aLabel
            }
            onClick(label = s.accessibilityHint) { if (enabled) send(s.onPress); enabled }
            if (s.onLongPress != 0) onLongClick { if (enabled) send(s.onLongPress); enabled }
        }
    if (!enabled) return base

    return base.pointerInput(s, inst) {
        coroutineScope {
            awaitEachGesture {
                val down = awaitFirstDown()
                val press = PressInteraction.Press(down.position)
                interactions.tryEmit(press)
                send(s.onPressIn)
                if (s.haptic) view.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)

                var handled = false // a long press or a repeat already fired: no onPress on release
                val longPress = if (s.onLongPress != 0) launch {
                    delay(viewConfiguration.longPressTimeoutMillis)
                    handled = true
                    send(s.onLongPress)
                } else null
                val repeat = if (s.onPressRepeat != 0) launch {
                    delay(s.repeatDelayMs)
                    handled = true
                    while (isActive) {
                        send(s.onPressRepeat)
                        delay(s.repeatIntervalMs)
                    }
                } else null

                val up = waitForUpOrCancellation()
                longPress?.cancel()
                repeat?.cancel()
                if (up != null) {
                    up.consume()
                    interactions.tryEmit(PressInteraction.Release(press))
                    send(s.onPressOut, false)
                    if (!handled) send(s.onPress)
                } else {
                    interactions.tryEmit(PressInteraction.Cancel(press))
                    send(s.onPressOut, true)
                }
            }
        }
    }
}
