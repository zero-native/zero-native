package dev.zeronative.runtime

import androidx.compose.animation.core.AnimationState
import androidx.compose.animation.core.DecayAnimationSpec
import androidx.compose.animation.core.FloatExponentialDecaySpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDecay
import androidx.compose.animation.core.animateTo
import androidx.compose.animation.core.calculateTargetValue
import androidx.compose.animation.core.generateDecayAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.animation.splineBasedDecay
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.gestures.FlingBehavior
import androidx.compose.foundation.gestures.ScrollScope
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.platform.LocalDensity
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.abs

// RN's scroll extras on <Scroll> and <List> (registry 24): snapping (pagingEnabled, snapToInterval, snapToOffsets,
// snapToAlignment, snapToStart / snapToEnd, disableIntervalMomentum, decelerationRate), scroll events to JS (onScroll,
// onScrollBeginDrag / EndDrag, onMomentumScrollBegin / End through one event, onScrollEvent) and scrollTo on <Scroll>.
// The fling and the snap run here, on the UI thread; JS only hears the events it has handlers for.

/** Where a scroll is, in px along its axis (exact for <Scroll>, estimated from the visible rows for a <List>). */
internal interface ZnScrollPos {
    fun offset(): Float
    fun max(): Float
    fun viewport(): Float
    /** The other axis's offset (always 0 here: zn scrolls one way at a time). */
    fun content(): Float = max() + viewport()
    fun cross(): Float
}

internal class ZnScrollStatePos(private val state: ScrollState, private val crossSize: () -> Float) : ZnScrollPos {
    override fun offset() = state.value.toFloat()
    override fun max() = state.maxValue.toFloat().takeIf { it.isFinite() } ?: 0f
    override fun viewport() = state.viewportSize.toFloat()
    override fun cross() = crossSize()
}

internal class ZnLazyPos(private val state: LazyListState, private val horizontal: Boolean) : ZnScrollPos {
    private fun each(): Float {
        val items = state.layoutInfo.visibleItemsInfo
        if (items.isEmpty()) return 0f
        return items.sumOf { it.size }.toFloat() / items.size + state.layoutInfo.mainAxisItemSpacing
    }
    override fun offset(): Float = state.firstVisibleItemIndex * each() + state.firstVisibleItemScrollOffset
    override fun viewport(): Float = state.layoutInfo.let {
        (if (horizontal) it.viewportSize.width else it.viewportSize.height).toFloat()
    }
    override fun max(): Float {
        val info = state.layoutInfo
        val total = info.totalItemsCount * each() - info.mainAxisItemSpacing + info.beforeContentPadding + info.afterContentPadding
        return (total - viewport()).coerceAtLeast(0f)
    }
    override fun cross(): Float = state.layoutInfo.let {
        (if (horizontal) it.viewportSize.height else it.viewportSize.width).toFloat()
    }
}

/**
 * The snap rules, from the compiler's `snap` string (core scrollSnap): "p1;i80;a1;o0,120,400;s0;e0;m1;d0.99".
 * p paging, i interval (dp), a alignment (0 start, 1 center, 2 end), o offsets (dp), s / e snapToStart / snapToEnd
 * (default on), m disableIntervalMomentum, d decelerationRate. Units here are dp; [pick] works in px.
 */
internal class ZnSnap(
    val paging: Boolean,
    val interval: Float,
    val align: Int,
    val offsets: FloatArray,
    val toStart: Boolean,
    val toEnd: Boolean,
    val oneAtATime: Boolean,
    val deceleration: Float,
) {
    val snaps: Boolean get() = paging || interval > 0f || offsets.isNotEmpty()

    /**
     * Where a fling from [start] that would coast to [projected] (px) with [velocity] stops. [d] density, [viewport]
     * and [max] px. Snap points are clamped to 0..max.
     */
    fun pick(start: Float, projected: Float, velocity: Float, viewport: Float, max: Float, d: Float): Float {
        if (!snaps) return projected.coerceIn(0f, max)
        val points = points(start, projected, viewport, max, d)
        if (points.isEmpty()) return projected.coerceIn(0f, max)
        val first = points.first()
        val last = points.last()
        // snapToStart / snapToEnd off: free scrolling before the first point and after the last one (RN).
        if (!toStart && offsets.isNotEmpty() && projected < first && start <= first) return projected.coerceIn(0f, max)
        if (!toEnd && offsets.isNotEmpty() && projected > last && start >= last) return projected.coerceIn(0f, max)
        if (oneAtATime || paging) {
            // One step at most: the next point the way it was flung, or the nearest when it was let go slowly.
            if (abs(velocity) < 400f * d) return points.minByOrNull { abs(it - projected) } ?: start
            return if (velocity > 0f) points.firstOrNull { it > start + 1f } ?: last
            else points.lastOrNull { it < start - 1f } ?: first
        }
        return points.minByOrNull { abs(it - projected) } ?: projected
    }

    /** The snap points near [start]..[projected] (px), sorted. */
    private fun points(start: Float, projected: Float, viewport: Float, max: Float, d: Float): List<Float> {
        val out = ArrayList<Float>()
        if (offsets.isNotEmpty()) {
            for (o in offsets) out += (o * d).coerceIn(0f, max)
        } else {
            val step = if (paging) viewport else interval * d
            if (step <= 0f) return emptyList()
            // RN's snapToAlignment with an interval: the item's start, centre or end lines up with the viewport's.
            val shift = when (align) {
                1 -> (viewport - step) / 2f
                2 -> viewport - step
                else -> 0f
            }.let { if (paging) 0f else it }
            val lo = minOf(start, projected) - 2 * step
            val hi = maxOf(start, projected) + 2 * step
            var k = kotlin.math.floor((lo + shift) / step)
            while (true) {
                val p = k * step - shift
                if (p > hi) break
                if (p >= -0.5f && p <= max + 0.5f) out += p.coerceIn(0f, max)
                k += 1f
            }
            if (toStart) out += 0f
            if (toEnd) out += max
        }
        return out.distinct().sorted()
    }

    companion object {
        fun parse(text: String?): ZnSnap? {
            if (text.isNullOrEmpty()) return null
            var paging = false
            var interval = 0f
            var align = 0
            var offsets = FloatArray(0)
            var toStart = true
            var toEnd = true
            var one = false
            var dec = 0f
            for (part in text.split(";")) {
                if (part.isEmpty()) continue
                val v = part.substring(1)
                when (part[0]) {
                    'p' -> paging = v == "1"
                    'i' -> interval = v.toFloatOrNull()?.takeIf { it.isFinite() && it > 0f } ?: 0f
                    'a' -> align = v.toIntOrNull() ?: 0
                    'o' -> offsets = v.split(",").mapNotNull { it.toFloatOrNull()?.takeIf { f -> f.isFinite() } }.sorted().toFloatArray()
                    's' -> toStart = v != "0"
                    'e' -> toEnd = v != "0"
                    'm' -> one = v == "1"
                    'd' -> dec = v.toFloatOrNull()?.takeIf { it.isFinite() && it > 0f && it < 1f } ?: 0f
                }
            }
            return ZnSnap(paging, interval, align, offsets, toStart, toEnd, one, dec)
        }
    }
}

/** The events JS has handlers for, from the compiler's `scrollEvents` string: "t16;s;b;e;mb;me". */
internal class ZnScrollWants(val throttleMs: Int, val scroll: Boolean, val beginDrag: Boolean, val endDrag: Boolean, val momentumBegin: Boolean, val momentumEnd: Boolean) {
    val any get() = scroll || beginDrag || endDrag || momentumBegin || momentumEnd

    companion object {
        fun parse(text: String?): ZnScrollWants? {
            if (text.isNullOrEmpty()) return null
            val parts = text.split(";")
            val t = parts.firstOrNull { it.startsWith("t") }?.substring(1)?.toIntOrNull()?.coerceIn(0, 10_000) ?: 0
            return ZnScrollWants(t, "s" in parts, "b" in parts, "e" in parts, "mb" in parts, "me" in parts)
        }
    }
}

/** Sends one scroll event to JS: kind k ("s", "b", "e", "mb", "me"), offsets and sizes in dp, velocity in dp/s. */
internal fun znSendScroll(inst: ZnInstance, event: Int, k: String, pos: ZnScrollPos, horizontal: Boolean, d: Float, vx: Float = 0f, vy: Float = 0f) {
    if (event == 0) return
    val off = pos.offset() / d
    val main = pos.content() / d
    val vp = pos.viewport() / d
    val cross = pos.cross() / d
    val o = JSONObject().put("k", k)
        .put("x", if (horizontal) off.toDouble() else 0.0).put("y", if (horizontal) 0.0 else off.toDouble())
        .put("cw", (if (horizontal) main else cross).toDouble()).put("ch", (if (horizontal) cross else main).toDouble())
        .put("w", (if (horizontal) vp else cross).toDouble()).put("h", (if (horizontal) cross else vp).toDouble())
    if (vx != 0f || vy != 0f) o.put("vx", vx.toDouble()).put("vy", vy.toDouble())
    ZnRuntime.dispatchEvent(inst.id, event, o.toString())
}

/**
 * The fling of a <Scroll> / <List>: coasts with the platform's curve (or RN's decelerationRate), then snaps when it
 * has snap rules; tells JS onMomentumScrollBegin / End when it has handlers. A let-go with no speed still snaps.
 */
internal class ZnScrollFling(
    private val snap: ZnSnap?,
    private val decay: DecayAnimationSpec<Float>,
    private val pos: ZnScrollPos,
    private val d: Float,
    private val momentum: ((begin: Boolean, velocity: Float) -> Unit)?,
) : FlingBehavior {
    override suspend fun ScrollScope.performFling(initialVelocity: Float): Float {
        val start = pos.offset()
        val snaps = snap?.snaps == true
        if (!snaps && abs(initialVelocity) < 1f) return initialVelocity
        momentum?.invoke(true, initialVelocity)
        var left = 0f
        try {
            if (snaps) {
                val projected = start + decay.calculateTargetValue(0f, initialVelocity)
                val target = snap!!.pick(start, projected, initialVelocity, pos.viewport(), pos.max(), d)
                // A spring that starts with the finger's speed and settles on the snap point without bouncing past it.
                var last = 0f
                AnimationState(0f, initialVelocity).animateTo(target - start, spring(Spring.DampingRatioNoBouncy, Spring.StiffnessMediumLow)) {
                    val delta = value - last
                    val used = scrollBy(delta)
                    last = value
                    if (abs(delta - used) > 0.5f) cancelAnimation()
                }
            } else {
                var last = 0f
                left = initialVelocity
                AnimationState(0f, initialVelocity).animateDecay(decay) {
                    val delta = value - last
                    val used = scrollBy(delta)
                    last = value
                    left = velocity
                    if (abs(delta - used) > 0.5f) {
                        left = velocity
                        cancelAnimation()
                    }
                }
            }
        } finally {
            momentum?.invoke(false, 0f)
        }
        return if (snaps) 0f else left
    }
}

/** RN's decelerationRate as a decay: 0.998 ("normal") is the platform's own curve; lower numbers stop sooner. */
@Composable
internal fun znScrollDecay(snap: ZnSnap?): DecayAnimationSpec<Float> {
    val density = LocalDensity.current
    val rate = snap?.deceleration ?: 0f
    return remember(rate, density) {
        if (rate <= 0f || rate >= 0.998f) splineBasedDecay(density)
        else FloatExponentialDecaySpec(znFriction(rate.toDouble()).coerceAtLeast(0.1f)).generateDecayAnimationSpec()
    }
}

/**
 * The fling for a node with snap rules, a decelerationRate or momentum handlers; null keeps Compose's default.
 */
@Composable
internal fun znScrollFling(s: ZnNodeSpec, inst: ZnInstance, pos: ZnScrollPos): FlingBehavior? {
    val snapText = if (s.snapSlot >= 0) inst.slot(s.snapSlot).value as? String else s.snap
    val snap = remember(snapText) { ZnSnap.parse(snapText) }
    val wants = remember(s.scrollEvents) { ZnScrollWants.parse(s.scrollEvents) }
    val momentum = wants?.let { it.momentumBegin || it.momentumEnd } == true
    if (snap == null && !momentum) return null
    val decay = znScrollDecay(snap)
    val d = LocalDensity.current.density
    return remember(snap, decay, pos, momentum, d, inst) {
        ZnScrollFling(snap, decay, pos, d, if (!momentum) null else { begin, v ->
            if (begin && wants!!.momentumBegin) znSendScroll(inst, s.onScrollEvent, "mb", pos, s.horizontal, d,
                if (s.horizontal) v / d else 0f, if (s.horizontal) 0f else v / d)
            if (!begin && wants!!.momentumEnd) znSendScroll(inst, s.onScrollEvent, "me", pos, s.horizontal, d)
        })
    }
}

/** onScroll (throttled), onScrollBeginDrag and onScrollEndDrag for the handlers JS has. */
@Composable
internal fun ZnScrollEvents(s: ZnNodeSpec, inst: ZnInstance, pos: ZnScrollPos, interactions: InteractionSource) {
    val wants = remember(s.scrollEvents) { ZnScrollWants.parse(s.scrollEvents) } ?: return
    if (s.onScrollEvent == 0 || !wants.any) return
    val d = LocalDensity.current.density
    if (wants.scroll) {
        LaunchedEffect(pos, inst.id) {
            var lastSent = 0L
            var first = true
            snapshotFlow { pos.offset() }.collectLatest {
                if (first) {
                    first = false
                    return@collectLatest
                }
                // At most one per frame (Compose gives one value per frame); with scrollEventThrottle, one per that
                // many ms, and the last position is always sent (collectLatest waits out the rest).
                val now = android.os.SystemClock.uptimeMillis()
                val wait = wants.throttleMs - (now - lastSent)
                if (wait > 0) delay(wait)
                lastSent = android.os.SystemClock.uptimeMillis()
                znSendScroll(inst, s.onScrollEvent, "s", pos, s.horizontal, d)
            }
        }
    }
    if (wants.beginDrag || wants.endDrag) {
        LaunchedEffect(interactions, inst.id) {
            interactions.interactions.collect { i ->
                when (i) {
                    is DragInteraction.Start -> if (wants.beginDrag) znSendScroll(inst, s.onScrollEvent, "b", pos, s.horizontal, d)
                    is DragInteraction.Stop, is DragInteraction.Cancel -> if (wants.endDrag) znSendScroll(inst, s.onScrollEvent, "e", pos, s.horizontal, d)
                }
            }
        }
    }
}

/**
 * <Scroll ref> (registry 24): "to:x:anim:y:seq", "end:0:anim:0:seq" and "offset:o:anim:0:seq" from core's
 * bindListController. Numbers are dp; each sequence number runs once.
 */
@Composable
internal fun ZnScrollCommands(s: ZnNodeSpec, inst: ZnInstance, scroll: suspend (px: Int, animated: Boolean) -> Unit, max: () -> Int) {
    if (s.scrollCommandSlot < 0) return
    val cmd = inst.slot(s.scrollCommandSlot).value as? String
    val d = LocalDensity.current.density
    val done = remember(inst) { IntArray(1) }
    LaunchedEffect(cmd) {
        val parts = cmd?.split(":") ?: return@LaunchedEffect
        val seq = parts.getOrNull(4)?.toIntOrNull() ?: return@LaunchedEffect
        if (seq <= done[0]) return@LaunchedEffect
        done[0] = seq
        fun number(i: Int): Float = parts.getOrNull(i)?.toFloatOrNull()?.takeIf { it.isFinite() } ?: 0f
        val anim = parts.getOrNull(2) != "0"
        val px = when (parts.getOrNull(0)) {
            "to" -> ((if (s.horizontal) number(1) else number(3)) * d)
            "offset" -> number(1) * d
            "end" -> Float.MAX_VALUE
            else -> return@LaunchedEffect
        }
        val target = if (px == Float.MAX_VALUE) max() else px.coerceAtLeast(0f).toInt()
        launch { scroll(target, anim) }
    }
}
