package dev.zeronative.runtime

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.ViewConfiguration
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp

// RN props pack 2 (registry 15): pointerEvents and Pressable hitSlop.

/**
 * True inside an element with `pointerEvents="none"` (or the children of "box-only"): Pressables there take no taps,
 * so the tap reaches what is under them. Read by [ZnNode] and passed to the press handling.
 */
internal val LocalTouchOff = staticCompositionLocalOf { false }

/** No pointerEvents written: a zn element without handlers lets taps through (Compose's hit test). */
internal const val POINTER_EVENTS_UNSET = -1

/** The node's pointerEvents now: the static value, or the slot's ("none", "box-none", ...) when it changes at runtime. */
internal fun pointerEventsOf(s: ZnNodeSpec, inst: ZnInstance): Int {
    if (s.pointerEventsSlot < 0) return s.pointerEvents
    return when (inst.slot(s.pointerEventsSlot).value as? String) {
        "none" -> Registry.PointerEvents.NONE
        "box-none" -> Registry.PointerEvents.BOX_NONE
        "box-only" -> Registry.PointerEvents.BOX_ONLY
        "auto" -> Registry.PointerEvents.AUTO
        else -> POINTER_EVENTS_UNSET // undefined at runtime: as if not written
    }
}

/**
 * A hit target that does nothing: taps on this element stop here and don't reach what is under it, as a React Native
 * view with pointerEvents "auto" (or "box-only") does. Its parents (a Scroll around it) still get them.
 */
internal fun Modifier.znBlockTouches(): Modifier = pointerInput(Unit) {
    awaitPointerEventScope { while (true) awaitPointerEvent() }
}

/**
 * RN hitSlop on a Pressable: taps up to [slop] dp past its edges count (start, top, end, bottom). Done with Compose's
 * minimum touch target, the only way Compose lets a finger hit outside an element (touchBoundsExpansion is for a
 * stylus only): this element's minimum touch size becomes its size plus the slop on each side. So each axis reaches
 * as far as its larger side's slop, on both sides. Like Compose's own 48 dp minimum, a tap in the extra area loses to
 * another element hit right where the finger is. [content] gets the modifier that measures the element.
 */
@Composable
internal fun WithHitSlop(slop: FloatArray, margin: Edges?, content: @Composable (Modifier) -> Unit) {
    val density = LocalDensity.current
    var size by remember { mutableStateOf(IntSize.Zero) }
    val base = LocalViewConfiguration.current
    val config = remember(base, size, density) {
        // The press handling sits inside the margin: measure without it.
        val w = with(density) { size.width.toDp() } - ((margin?.start ?: 0f) + (margin?.end ?: 0f)).dp
        val h = with(density) { size.height.toDp() } - ((margin?.top ?: 0f) + (margin?.bottom ?: 0f)).dp
        val target = DpSize(w + (2 * maxOf(slop[0], slop[2])).dp, h + (2 * maxOf(slop[1], slop[3])).dp)
        object : ViewConfiguration by base {
            override val minimumTouchTargetSize: DpSize get() = target
        }
    }
    CompositionLocalProvider(LocalViewConfiguration provides config) {
        content(Modifier.onSizeChanged { size = it })
    }
}

/** "start,top,end,bottom" (the compiler's hitSlop) → 4 dp values, or null. */
internal fun parseHitSlop(spec: String?): FloatArray? {
    val parts = spec?.split(',')?.mapNotNull { it.trim().toFloatOrNull() } ?: return null
    return if (parts.size == 4 && parts.any { it > 0f }) parts.toFloatArray() else null
}
