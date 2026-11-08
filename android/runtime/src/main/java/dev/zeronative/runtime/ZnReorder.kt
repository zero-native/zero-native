package dev.zeronative.runtime

import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.lazy.LazyListItemInfo
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.zIndex
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** How long the order shown after a drop waits for JS to move the row in its data before going back (ms). */
private const val WAIT_FOR_JS_MS = 1000L
/** Near this far (dp) from the list's start or end, a dragged row scrolls the list; faster nearer the edge. */
private const val EDGE_DP = 56f
private const val MAX_SCROLL_DP_PER_FRAME = 14f

/**
 * <List reorderable> (registry 24, docs/gestures-and-motion-v1.md §2.9): a long press on a row picks it up, a drag
 * moves it, and the list scrolls when the finger is near its start or end. Other rows glide out of the way. On the
 * drop, JS hears onReorder(from, to) and moves the row in its data.
 *
 * The rows really move while dragging: the list shows them in a local order ([order], row indexes) so the picked row
 * stays composed under the finger even far from where it started. After the drop that order stays until JS's rows
 * change (JS moved it), or [WAIT_FOR_JS_MS] passes (JS said no: the row glides back). Main thread only.
 */
@Stable
internal class ZnReorder(
    private val state: LazyListState,
    private val scope: CoroutineScope,
    private val view: View,
    private val horizontal: Boolean,
    /** Lazy items before the first row (a header, an empty item). */
    private val head: () -> Int,
    private val rowCount: () -> Int,
    private val keyOfRow: (Int) -> String?,
    private val onDrop: (from: Int, to: Int) -> Unit,
) {
    /** The order shown: position → row index, or null for the rows' own order. */
    var order by mutableStateOf<IntArray?>(null)
        private set

    /** The key of the row being dragged (or gliding into place after the drop), or null. */
    var dragged by mutableStateOf<String?>(null)
        private set

    private var finger by mutableFloatStateOf(0f) // main axis, list coordinates
    private var fingerAtPick = 0f
    private var offsetAtPick = 0f
    private var fromRow = -1
    private var scroller: Job? = null
    private var waitForJs: Job? = null
    private val settle = Animatable(0f)
    private var settling by mutableStateOf(false)

    /** The row index shown at position [p]. */
    fun rowAt(p: Int): Int {
        // A row added or removed by JS mid-drag: the old order no longer fits, so the rows' own order (never a key twice).
        val o = order
        return if (o != null && o.size == rowCount()) o[p] else p
    }

    private fun item(key: String): LazyListItemInfo? = state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == key }

    /** How far the dragged row is drawn from its place in the list (px, main axis). */
    fun translation(): Float {
        if (settling) return settle.value
        val key = dragged ?: return 0f
        val now = item(key)?.offset?.toFloat() ?: offsetAtPick
        return (finger - fingerAtPick) - (now - offsetAtPick)
    }

    /** JS's rows changed: its data now has the new order, so the local order is dropped (the keys put rows in place). */
    fun rowsChanged() {
        if (dragged != null && !settling) return
        waitForJs?.cancel()
        order = null
    }

    private fun mainOf(o: Offset) = if (horizontal) o.x else o.y

    private fun pick(at: Offset): Boolean {
        if (dragged != null) return false
        val y = mainOf(at) + state.layoutInfo.viewportStartOffset
        val hit = state.layoutInfo.visibleItemsInfo.firstOrNull { y >= it.offset && y < it.offset + it.size } ?: return false
        val pos = hit.index - head()
        if (pos < 0 || pos >= rowCount()) return false // a header, footer or empty item
        val key = hit.key as? String ?: return false
        if (keyOfRow(rowAt(pos)) != key) return false
        waitForJs?.cancel()
        if (order == null) order = IntArray(rowCount()) { it }
        fromRow = rowAt(pos)
        finger = y
        fingerAtPick = y
        offsetAtPick = hit.offset.toFloat()
        dragged = key
        view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
        scroller = scope.launch { autoScroll() }
        return true
    }

    private fun move(dy: Float) {
        finger += dy
        swapIfOver()
    }

    /** The layout a swap was decided on: until the list lays out again its positions are old, so no second swap. */
    private var swappedOn: Any? = null

    /** When the dragged row's centre is over another row, they swap places in the shown order. */
    private fun swapIfOver() {
        val key = dragged ?: return
        // Two touch events can come in one frame; the second would see the old places and swap the rows back.
        if (swappedOn === state.layoutInfo) return
        val me = item(key) ?: return
        val centre = me.offset + translation() + me.size / 2f
        val other = state.layoutInfo.visibleItemsInfo.firstOrNull {
            it.key != key && centre >= it.offset && centre < it.offset + it.size
        } ?: return
        val to = other.index - head()
        val from = me.index - head()
        val o = order ?: return
        if (to < 0 || to >= o.size || from < 0 || from >= o.size) return
        // Keep the scroll still when the first visible row moves (a lazy list keeps its scroll by key).
        val first = state.firstVisibleItemIndex
        val firstOffset = state.firstVisibleItemScrollOffset
        val next = o.toMutableList()
        next.add(to, next.removeAt(from))
        order = next.toIntArray()
        swappedOn = state.layoutInfo
        if (first == me.index || first == other.index) scope.launch { state.scrollToItem(first, firstOffset) }
        view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    }

    private suspend fun autoScroll() {
        val edge = EDGE_DP * view.resources.displayMetrics.density
        val max = MAX_SCROLL_DP_PER_FRAME * view.resources.displayMetrics.density
        while (scope.isActive && dragged != null && !settling) {
            withFrameNanos { }
            val info = state.layoutInfo
            val start = info.viewportStartOffset.toFloat()
            val end = info.viewportEndOffset.toFloat()
            val speed = when {
                finger < start + edge -> -max * (1f - (finger - start).coerceAtLeast(0f) / edge)
                finger > end - edge -> max * (1f - (end - finger).coerceAtLeast(0f) / edge)
                else -> 0f
            }
            if (speed != 0f && state.scrollBy(speed) != 0f) swapIfOver()
        }
    }

    private fun drop() {
        val key = dragged ?: return
        scroller?.cancel()
        val o = order
        val pos = o?.indexOf(fromRow) ?: -1
        val from = fromRow
        scope.launch {
            settle.snapTo(translation())
            settling = true
            settle.animateTo(0f, spring(dampingRatio = 0.8f, stiffness = 600f))
            settling = false
            if (dragged == key) dragged = null
        }
        if (pos < 0 || pos == from) {
            order = null
            return
        }
        onDrop(from, pos)
        waitForJs = scope.launch {
            delay(WAIT_FOR_JS_MS)
            if (dragged == null || settling) order = null
        }
    }

    /**
     * The list's pointer handling: watches each touch at the Initial pass without taking it; after a long press with
     * the finger still, it takes the touch (rows and the scroll stop seeing it) and drags.
     */
    fun modifier(): Modifier = Modifier.pointerInput(this) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            val ended = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) {
                while (true) {
                    val e = awaitPointerEvent(PointerEventPass.Initial)
                    val c = e.changes.firstOrNull { it.id == down.id } ?: break
                    if (!c.pressed || c.isConsumed || (c.position - down.position).getDistance() > viewConfiguration.touchSlop) break
                }
                true
            }
            if (ended != null) return@awaitEachGesture
            if (!pick(down.position)) return@awaitEachGesture
            try {
                while (true) {
                    val e = awaitPointerEvent(PointerEventPass.Initial)
                    val c = e.changes.firstOrNull { it.id == down.id } ?: break
                    val d = mainOf(c.positionChange())
                    e.changes.forEach { it.consume() }
                    if (!c.pressed) break
                    move(d)
                }
            } finally {
                drop()
            }
        }
    }

    /** For a row: the dragged one is drawn above the others and follows the finger. */
    fun rowModifier(key: String): Modifier =
        if (dragged != key) Modifier
        else Modifier.zIndex(1f).graphicsLayer {
            val t = translation()
            if (horizontal) translationX = t else translationY = t
            shadowElevation = 8f * density
        }
}
