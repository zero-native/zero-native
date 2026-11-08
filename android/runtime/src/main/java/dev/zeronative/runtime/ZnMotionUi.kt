package dev.zeronative.runtime

import android.view.View
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector2D
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.spring
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.layout.positionInParent
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.round
import kotlinx.coroutines.launch

// Motion in the renderer, phase 2 (docs/gestures-and-motion-v1.md §2.4, §2.6, §2.8): values from elements, corners
// that follow motion values, layout animations.

/** The useElementMotion() object this element fills, or null. A composition read of the slot (it rarely changes). */
internal fun znElementOf(s: ZnNodeSpec, inst: ZnInstance): ZnElementMotion? =
    if (s.motionSlot < 0) null else (inst.slot(s.motionSlot).value as? Double)?.toInt()?.let { ZnMotion.element(it) }

/** Gives [name] of [e] its reader while this is composed (a scroll offset read from its state, frame by frame). */
@Composable
internal fun ZnProvide(e: ZnElementMotion, name: String, reader: () -> Float) {
    DisposableEffect(e, name) {
        val src = e.lambda(name)
        src?.reader?.value = reader
        onDispose { if (src?.reader?.value === reader) src.reader.value = null }
    }
}

/**
 * m.follow(v) (plan §2.8, Reanimated's scrollTo on the UI thread): while set, every change of v moves the element's
 * scroll position there at once, on the UI thread (an alphabet side bar, a tab bar synced to a list). Smoothness comes
 * from v itself (a spring, a drag). The user can still scroll; the next change of v wins.
 */
@Composable
internal fun ZnFollow(e: ZnElementMotion, apply: suspend (Float) -> Unit) {
    val src = e.follow.value ?: return
    LaunchedEffect(e, src) {
        snapshotFlow { src.read(null) }.collect { if (it.isFinite()) apply(it) }
    }
}

/** A Pressable's press as 0 → 1 (a quick spring down, a softer one back), for `pressed` of its element motion. */
@Composable
internal fun ZnPressMotion(e: ZnElementMotion, interactions: MutableInteractionSource) {
    if (e.lambda("pressed") == null) return
    val p = remember(e) { Animatable(0f) }
    LaunchedEffect(e, interactions) {
        interactions.interactions.collect { i ->
            val target = when (i) {
                is PressInteraction.Press -> 1f
                is PressInteraction.Release, is PressInteraction.Cancel -> 0f
                else -> return@collect
            }
            launch { p.animateTo(target, spring(dampingRatio = if (target > 0f) 1f else 0.6f, stiffness = 1500f)) }
        }
    }
    ZnProvide(e, "pressed") { p.value }
}

/** Writes the element's box in the window (dp) into x, y, width, height when it is placed. */
internal fun Modifier.znElementBox(e: ZnElementMotion, view: View): Modifier {
    val x = e.value("x")
    val y = e.value("y")
    val w = e.value("width")
    val h = e.value("height")
    if (x == null && y == null && w == null && h == null) return this
    return onGloballyPositioned { c ->
        val d = view.resources.displayMetrics.density
        val p = c.positionInWindow()
        x?.value = p.x / d
        y?.value = p.y / d
        w?.value = c.size.width / d
        h?.value = c.size.height / d
    }
}

/**
 * Corners that follow motion values (pillar 4: a full-screen view rounding into a mini player). Each corner reads its
 * slot (a number or a motion value) or the static value, in the order RN uses (a corner of its own beats
 * borderRadius). Read where the shape is used: background and border in the draw phase; the clip in a layer block
 * that makes the shape again ([now]).
 */
internal class ZnMotionShape(
    private val ts: () -> Float,
    private val te: () -> Float,
    private val be: () -> Float,
    private val bs: () -> Float,
) : Shape {
    fun now(): Shape = RoundedCornerShape(ts().dp, te().dp, be().dp, bs().dp)

    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline =
        now().createOutline(size, layoutDirection, density)
}

/** A [ZnMotionShape] when any radius slot of the node holds a motion value now; else null (the usual shape). */
internal fun znMotionShape(s: ZnNodeSpec, inst: ZnInstance): ZnMotionShape? {
    val slots = intArrayOf(
        s.borderRadiusSlot, s.borderTopStartRadiusSlot, s.borderTopEndRadiusSlot, s.borderBottomEndRadiusSlot,
        s.borderBottomStartRadiusSlot,
    )
    if (slots.none { it >= 0 && ZnMotion.isRef(inst.slot(it).value) }) return null
    fun read(slot: Int): (() -> Float)? {
        if (slot < 0) return null
        val cell = inst.slot(slot)
        return {
            val v = when (val x = cell.value) {
                is Number -> x.toFloat()
                is String -> ZnMotion.ref(x)?.read(null) ?: 0f
                else -> 0f
            }
            if (v.isFinite()) v.coerceAtLeast(0f) else 0f
        }
    }
    val all = read(s.borderRadiusSlot)
    fun corner(slot: Int, own: Int, own2: Int, static: Float): () -> Float =
        read(slot) ?: if (s.has(own) || s.has(own2)) ({ static }) else all ?: { static }
    return ZnMotionShape(
        corner(s.borderTopStartRadiusSlot, Registry.Prop.BORDER_TOP_START_RADIUS, Registry.Prop.BORDER_TOP_LEFT_RADIUS, s.topStart),
        corner(s.borderTopEndRadiusSlot, Registry.Prop.BORDER_TOP_END_RADIUS, Registry.Prop.BORDER_TOP_RIGHT_RADIUS, s.topEnd),
        corner(s.borderBottomEndRadiusSlot, Registry.Prop.BORDER_BOTTOM_END_RADIUS, Registry.Prop.BORDER_BOTTOM_RIGHT_RADIUS, s.bottomEnd),
        corner(s.borderBottomStartRadiusSlot, Registry.Prop.BORDER_BOTTOM_START_RADIUS, Registry.Prop.BORDER_BOTTOM_LEFT_RADIUS, s.bottomStart),
    )
}

/**
 * `animateLayout` (Reanimated's layout transitions): when the element's size changes it grows or shrinks to the new
 * size, and when its place changes (a row above it went, chips reflow) it glides there, with [t] (spring or tween).
 */
internal fun Modifier.znAnimateLayout(t: ZnTiming): Modifier = composed {
    val scope = rememberCoroutineScope()
    var target by remember { mutableStateOf<IntOffset?>(null) }
    val anim = remember { mutableStateOf<Animatable<IntOffset, AnimationVector2D>?>(null) }
    this.onPlaced { target = it.positionInParent().round() }
        .offset {
            val to = target ?: return@offset IntOffset.Zero
            val a = anim.value ?: Animatable(to, IntOffset.VectorConverter).also { anim.value = it }
            if (a.targetValue != to) scope.launch { a.animateTo(to, t.spec()) }
            a.value - to
        }
        .animateContentSize(t.finiteSpec())
}

/** <List itemAnimation>: "fade" (fade in and out, glide to new places) or "move" (glide only). */
internal fun LazyItemScope.znItemAnimation(kind: String?): Modifier = when (kind) {
    "fade" -> Modifier.animateItem()
    "move" -> Modifier.animateItem(fadeInSpec = null, fadeOutSpec = null)
    else -> Modifier
}
