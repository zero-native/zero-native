package dev.zeronative.runtime

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Pull to refresh on a vertical <Scroll> and a <List> (guide notes §41), with Compose foundation only (no material3).
 *
 * - The pull is the scroll left over at the top: a NestedScrollConnection on the container takes it before Android's
 *   overscroll stretch does. The content does not move; a disc with an arc slides down over it (Android's look).
 * - It is drawn with drawWithContent on the container's own modifier chain (no wrapper box), so layout is unchanged.
 *   The disc's position is read only while drawing: a pull never recomposes anything.
 * - Controlled (ARCHITECTURE §9.7): a release past the line sends onRefresh and shows the spinner at once. Then JS's
 *   `refreshing` decides. If JS doesn't set it to true within [PENDING_MS], the spinner goes away (a refresh that
 *   doesn't use `refreshing`).
 */
@Composable
internal fun znPullRefresh(s: ZnNodeSpec, inst: ZnInstance): Modifier {
    // Static per node (the template doesn't change), so this early return never changes the composable's shape.
    if (s.onRefresh == 0 && s.refreshingSlot < 0 && !s.refreshing) return Modifier
    val density = LocalDensity.current
    val scope = rememberCoroutineScope()
    val state = remember(s, inst) {
        with(density) {
            ZnPullState(scope, ZnPullMath(PULL_LINE.toPx(), DISC.toPx() + REST_GAP.toPx()), canPull = s.onRefresh != 0) {
                ZnRuntime.dispatchEvent(inst.id, s.onRefresh)
            }
        }
    }
    // `refreshing` is read here, not in the composable: a change moves the disc without recomposing the list.
    LaunchedEffect(state) {
        snapshotFlow { if (s.refreshingSlot >= 0) inst.slot(s.refreshingSlot).value == true else s.refreshing }
            .collect { state.setRefreshing(it) }
    }
    val spin = remember(state) { Animatable(0f) }
    LaunchedEffect(state) {
        snapshotFlow { state.shown }.collectLatest { shown ->
            while (shown && isActive) {
                spin.snapTo(0f)
                spin.animateTo(360f, tween(SPIN_MS, easing = LinearEasing))
            }
        }
    }
    val arc = s.refreshColor
    val disc = s.refreshBackground
    return Modifier.nestedScroll(state.connection).drawWithContent {
        drawContent()
        val y = state.offset
        if (y <= 0f) return@drawWithContent
        val r = DISC.toPx() / 2f
        val center = Offset(size.width / 2f, y - r)
        // Clipped to the container: the disc slides in from its top edge, never over what is above it.
        clipRect(0f, 0f, size.width, size.height) {
            // A soft shadow without material: two faint rings under the disc.
            drawCircle(SHADOW.copy(alpha = 0.05f), r + 2.5.dp.toPx(), center + Offset(0f, 1.5.dp.toPx()))
            drawCircle(SHADOW.copy(alpha = 0.08f), r + 1.dp.toPx(), center + Offset(0f, 1.dp.toPx()))
            drawCircle(disc, r, center)
            val stroke = 2.5.dp.toPx()
            val inset = 11.dp.toPx()
            val box = Size(r * 2 - inset * 2, r * 2 - inset * 2)
            val topLeft = Offset(center.x - box.width / 2f, center.y - box.height / 2f)
            if (state.shown) {
                rotate(spin.value, center) {
                    drawArc(arc, -90f, 270f, false, topLeft, box, style = Stroke(stroke, cap = StrokeCap.Round))
                }
            } else {
                // While pulling: the arc grows with the pull, and is solid once a release would refresh.
                val progress = state.math.progress(y)
                val alpha = if (state.math.refreshes(y)) 1f else 0.45f
                rotate(progress * 180f, center) {
                    drawArc(arc.copy(alpha = arc.alpha * alpha), -90f, 280f * progress, false, topLeft, box,
                        style = Stroke(stroke, cap = StrokeCap.Round))
                }
            }
        }
    }
}

/**
 * The pull's numbers, in px, apart from Compose so unit tests can check them. [line]: how far the disc must come
 * down for a release to refresh. [rest]: where it stays while refreshing. A position is the disc's bottom edge, measured
 * from the container's top.
 */
internal class ZnPullMath(val line: Float, val rest: Float) {
    /** How far the disc moves for a finger move: half, like Android's own pull to refresh. */
    fun distance(fingerDy: Float): Float = fingerDy * DRAG_RATE

    /** The disc's position for a pulled [distance]: 1:1 up to the line, then slower, never past [max]. */
    fun position(distance: Float): Float =
        if (distance <= line) distance.coerceAtLeast(0f) else (line + (distance - line) * 0.5f).coerceAtMost(max)

    val max: Float get() = line * 1.5f

    /** A release at [position] refreshes. */
    fun refreshes(position: Float): Boolean = position >= line

    /** 0–1: how much of the line the pull has covered (the arc's length). */
    fun progress(position: Float): Float = (position / line).coerceIn(0f, 1f)
}

@Stable
internal class ZnPullState(
    private val scope: CoroutineScope,
    val math: ZnPullMath,
    /** false: no onRefresh, so only JS's `refreshing` shows the spinner. */
    private val canPull: Boolean,
    private val onRefresh: () -> Unit,
) {
    /** The disc's position (px). Read only while drawing. */
    var offset by mutableFloatStateOf(0f)
        private set

    /** The spinner shows: JS's `refreshing`, or a release that JS hasn't answered yet. */
    var shown by mutableStateOf(false)
        private set

    private var refreshing: Boolean? = null // null: not heard yet (the first value doesn't animate)
    private var pending: Job? = null
    private var pulling = false
    private var distance = 0f
    private var move: Job? = null

    fun setRefreshing(value: Boolean) {
        val first = refreshing == null
        refreshing = value
        if (value) {
            pending?.cancel()
            pending = null
        }
        update(animate = !first)
    }

    private fun update(animate: Boolean = true) {
        val now = refreshing == true || pending != null
        if (now == shown) return
        shown = now
        if (pulling) return // the release decides where the disc goes
        moveTo(if (now) math.rest else 0f, animate)
    }

    private fun moveTo(target: Float, animate: Boolean = true) {
        move?.cancel()
        if (!animate || offset == target) {
            offset = target
            return
        }
        move = scope.launch {
            animate(offset, target, animationSpec = tween(MOVE_MS)) { v, _ -> offset = v }
        }
    }

    private fun pull(fingerDy: Float) {
        move?.cancel()
        pulling = true
        distance = (distance + math.distance(fingerDy)).coerceAtLeast(0f)
        offset = math.position(distance)
    }

    private fun release() {
        if (!pulling) return
        pulling = false
        val refresh = math.refreshes(offset)
        distance = 0f
        if (refresh && !shown) {
            pending = scope.launch {
                delay(PENDING_MS)
                pending = null
                update()
            }
            onRefresh()
            update() // shows the spinner and moves the disc to its rest place
        } else {
            moveTo(if (shown) math.rest else 0f)
        }
    }

    val connection = object : NestedScrollConnection {
        // Finger going back up while the disc is out: move the disc first, the content stays.
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (!pulling || source != NestedScrollSource.UserInput || available.y >= 0f || distance <= 0f) return Offset.Zero
            val used = maxOf(available.y, -distance / DRAG_RATE)
            pull(used)
            return Offset(0f, used)
        }

        // The content is at its top and the finger still moves down: that is the pull.
        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            if (!canPull || shown || source != NestedScrollSource.UserInput || available.y <= 0f) return Offset.Zero
            pull(available.y)
            return Offset(0f, available.y)
        }

        // The finger is up (a fling or not). A pull eats the fling, so the content doesn't jump.
        override suspend fun onPreFling(available: Velocity): Velocity {
            if (!pulling) return Velocity.Zero
            val pulled = distance > 0f
            release()
            return if (pulled) available else Velocity.Zero
        }
    }
}

private val PULL_LINE = 80.dp
private val DISC = 40.dp
/** While refreshing, the disc's top sits this far below the container's top. */
private val REST_GAP = 16.dp
private const val DRAG_RATE = 0.5f
private const val MOVE_MS = 200
private const val SPIN_MS = 1000
/** How long the spinner waits for JS to set `refreshing` after a release. */
internal const val PENDING_MS = 1000L
private val SHADOW = Color.Black
