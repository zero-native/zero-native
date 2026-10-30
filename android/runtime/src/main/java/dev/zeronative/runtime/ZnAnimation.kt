package dev.zeronative.runtime

import androidx.compose.animation.Animatable as ColorAnimatable
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material.ripple.createRippleModifierNode
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.unit.Dp
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.ui.graphics.Color
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

// Animation (ARCHITECTURE §10, step 3.6). JS only ever sends target values; native animates to them with the
// element's own spring or tween. Every animated value is read in the draw phase (graphicsLayer / drawBehind), so a
// running animation redraws one node per frame and never recomposes or re-lays out anything.

/** A tween ("t<ms>e<easing>") or a spring ("s<dampingRatio>,<stiffness>"), as the compiler encodes them. */
internal class ZnTiming(private val ms: Int, private val easing: Int, private val damping: Float, private val stiffness: Float) {
    fun <T> spec(): AnimationSpec<T> =
        if (ms >= 0) {
            tween(ms, easing = when (easing) {
                1 -> LinearOutSlowInEasing // ease-out
                2 -> FastOutLinearInEasing // ease-in
                3 -> LinearEasing
                else -> FastOutSlowInEasing // standard
            })
        } else {
            spring(dampingRatio = damping, stiffness = stiffness)
        }

    companion object {
        fun parse(s: String): ZnTiming? = when {
            s.startsWith("t") -> {
                val e = s.indexOf('e')
                ZnTiming(s.substring(1, if (e > 0) e else s.length).toIntOrNull() ?: return null,
                    if (e > 0) s.substring(e + 1).toIntOrNull() ?: 0 else 0, 1f, 0f)
            }
            s.startsWith("s") -> {
                val parts = s.substring(1).split(',')
                ZnTiming(-1, 0, parts.getOrNull(0)?.toFloatOrNull() ?: 0.75f, parts.getOrNull(1)?.toFloatOrNull() ?: 400f)
            }
            else -> null
        }
    }
}

/** `animate`: per prop id, or "*" for every animatable prop of the element. */
internal class ZnAnimate(private val byProp: Map<Int, ZnTiming>, private val all: ZnTiming?) {
    fun timingFor(prop: Int): ZnTiming? = byProp[prop] ?: all

    companion object {
        fun parse(s: String): ZnAnimate {
            val byProp = HashMap<Int, ZnTiming>()
            var all: ZnTiming? = null
            for (part in s.split(';')) {
                val eq = part.indexOf('=')
                if (eq <= 0) continue
                val timing = ZnTiming.parse(part.substring(eq + 1)) ?: continue
                val key = part.substring(0, eq)
                if (key == "*") all = timing else key.toIntOrNull()?.let { byProp[it] = timing }
            }
            return ZnAnimate(byProp, all)
        }
    }
}

/** `enter` / `exit`: the state the element enters from or leaves to ("opacity,translateX,translateY,scale|timing"). */
internal class ZnTransition(val opacity: Float, val translateX: Float, val translateY: Float, val scale: Float, val timing: ZnTiming) {
    companion object {
        fun parse(s: String): ZnTransition? {
            val bar = s.indexOf('|')
            if (bar < 0) return null
            val v = s.substring(0, bar).split(',').map { it.toFloatOrNull() ?: return null }
            if (v.size != 4) return null
            return ZnTransition(v[0], v[1], v[2], v[3], ZnTiming.parse(s.substring(bar + 1)) ?: return null)
        }
    }
}

/** The values a node's graphicsLayer reads, each a draw-phase read (slot, animation or constant). */
internal class ZnLayer(
    val alpha: () -> Float,
    val scaleX: () -> Float,
    val scaleY: () -> Float,
    val rotate: () -> Float,
    val translateX: () -> Float,
    val translateY: () -> Float,
)

private fun lerp(from: Float, to: Float, t: Float) = from + (to - from) * t

/**
 * The node's layer values, or null when nothing in it changes at runtime (then the static chain is used). [root]: this
 * node is the root of its instance (only a root can play `exit`: it is what JS removes).
 */
@Composable
internal fun znLayer(s: ZnNodeSpec, inst: ZnInstance, root: Boolean, pressed: ZnPressed? = null): ZnLayer? {
    val hasExit = root && s.exit != null
    if (s.opacitySlot < 0 && !s.hasTransformSlots && s.enter == null && !hasExit && pressed == null) return null
    val a = s.animate
    val opacity = animatedFloat(inst, s.opacitySlot, s.opacity, a?.timingFor(Registry.Prop.OPACITY))
    val scale = animatedFloat(inst, s.scaleSlot, s.scaleBase, a?.timingFor(Registry.Prop.SCALE))
    val scaleX = animatedFloat(inst, s.scaleXSlot, s.scaleXOnly, a?.timingFor(Registry.Prop.SCALE_X))
    val scaleY = animatedFloat(inst, s.scaleYSlot, s.scaleYOnly, a?.timingFor(Registry.Prop.SCALE_Y))
    val rotate = animatedFloat(inst, s.rotateSlot, s.rotate, a?.timingFor(Registry.Prop.ROTATE))
    val tx = animatedFloat(inst, s.translateXSlot, s.translateX, a?.timingFor(Registry.Prop.TRANSLATE_X))
    val ty = animatedFloat(inst, s.translateYSlot, s.translateY, a?.timingFor(Registry.Prop.TRANSLATE_Y))

    // Enter: from the `enter` state to the element's own values, once, when the node first appears.
    val enter = s.enter
    val inP: Animatable<Float, *>? = if (enter != null) {
        val p = remember(inst) { Animatable(0f) }
        LaunchedEffect(inst) { p.animateTo(1f, enter.timing.spec()) }
        p
    } else null

    // Exit: JS removed the instance; ZnStore keeps it (exiting) until this ends, then drops it.
    val exit = if (hasExit) s.exit else null
    val outP: Animatable<Float, *>? = if (exit != null) {
        SideEffect { inst.hasExit = true }
        val p = remember(inst) { Animatable(0f) }
        val exiting = inst.exiting.value
        LaunchedEffect(inst, exiting) {
            if (!exiting) return@LaunchedEffect
            p.animateTo(1f, exit.timing.spec())
            ZnStore.finishExit(inst.id)
        }
        p
    } else null

    return remember(inst, opacity, scale, scaleX, scaleY, rotate, tx, ty, inP, outP, pressed) {
        fun inV(from: Float?, rest: Float): Float = if (inP == null || from == null) rest else lerp(from, rest, inP.value)
        fun outV(to: Float?, rest: Float): Float = if (outP == null || to == null) rest else lerp(rest, to, outP.value)
        ZnLayer(
            alpha = { opacity() * inV(enter?.opacity, 1f) * outV(exit?.opacity, 1f) * (pressed?.alpha() ?: 1f) },
            scaleX = { scale() * scaleX() * inV(enter?.scale, 1f) * outV(exit?.scale, 1f) * (pressed?.scale() ?: 1f) },
            scaleY = { scale() * scaleY() * inV(enter?.scale, 1f) * outV(exit?.scale, 1f) * (pressed?.scale() ?: 1f) },
            rotate = rotate,
            translateX = { tx() + inV(enter?.translateX, 0f) + outV(exit?.translateX, 0f) },
            translateY = { ty() + inV(enter?.translateY, 0f) + outV(exit?.translateY, 0f) },
        )
    }
}

/**
 * A float prop: a constant, a slot read in the draw phase, or (with a timing) an animation that follows the slot.
 * The first value is shown as it is; only later changes animate. A new target mid-animation continues from where it is.
 */
@Composable
private fun animatedFloat(inst: ZnInstance, slot: Int, static: Float, timing: ZnTiming?): () -> Float {
    if (slot < 0) return remember(static) { { static } }
    val cell: MutableState<Any?> = inst.slot(slot)
    val read = { (cell.value as? Double)?.toFloat() ?: static }
    if (timing == null) return remember(cell) { read }
    val anim = remember(cell) { Animatable(read()) }
    LaunchedEffect(cell, timing) {
        snapshotFlow(read).collectLatest { anim.animateTo(it, timing.spec()) }
    }
    return remember(anim) { { anim.value } }
}

/** A dynamic background colour, animated when the element's `animate` covers backgroundColor. */
@Composable
internal fun znBackground(s: ZnNodeSpec, inst: ZnInstance): (() -> Color)? {
    if (s.backgroundSlot < 0) return null
    val cell = inst.slot(s.backgroundSlot)
    val read = { toColor(cell.value) ?: Color.Transparent }
    val timing = s.animate?.timingFor(Registry.Prop.BACKGROUND_COLOR) ?: return remember(cell) { read }
    val anim = remember(cell) { ColorAnimatable(read()) }
    LaunchedEffect(cell, timing) {
        snapshotFlow(read).collectLatest { anim.animateTo(it, timing.spec()) }
    }
    return remember(anim) { { anim.value } }
}

/** A Pressable's pressed look, as layer factors: `pressScale` and `pressOpacity`. */
internal class ZnPressed(val scale: () -> Float, val alpha: () -> Float)

/**
 * `pressScale` / `pressOpacity` on a Pressable: one "how pressed" value (0 → 1) driven by the press interactions
 * ZnPress emits, turned into a scale and an opacity. Null when the Pressable uses neither.
 */
@Composable
internal fun znPressed(s: ZnNodeSpec, interactions: MutableInteractionSource): ZnPressed? {
    if (s.pressScale == 1f && s.pressOpacity == 1f) return null
    val p = remember(s) { Animatable(0f) }
    LaunchedEffect(s, interactions) {
        interactions.interactions.collect { i ->
            val target = when (i) {
                is PressInteraction.Press -> 1f
                is PressInteraction.Release, is PressInteraction.Cancel -> 0f
                else -> return@collect
            }
            // Quick and firm going down, a little give coming back (a new press cuts the previous one short).
            launch { p.animateTo(target, spring(dampingRatio = if (target > 0f) 1f else 0.6f, stiffness = 1500f)) }
        }
    }
    return remember(p) {
        ZnPressed(
            scale = { lerp(1f, s.pressScale, p.value) },
            alpha = { lerp(1f, s.pressOpacity, p.value).coerceIn(0f, 1f) }, // the spring's overshoot must not pass 1
        )
    }
}

/**
 * Pressable's ripple (pressFeedback "ripple", the default): from the touch point, inside the node's shape (the chain
 * clips a rounded Pressable), or around the touch when borderless. Built on material-ripple's node, so no Material
 * theme is needed. Default: black at 12 %, right on light surfaces; with a `rippleColor` (white on dark buttons)
 * 24 %; `rippleOpacity` overrides both.
 */
internal class ZnRipple(
    private val color: Color?,
    private val opacity: Float?,
    private val bounded: Boolean,
    private val radius: Float?,
) : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode {
        val c = color ?: Color.Black
        val pressed = opacity ?: if (color == null) 0.12f else 0.24f
        return createRippleModifierNode(
            interactionSource = interactionSource,
            bounded = bounded,
            radius = radius?.let { Dp(it) } ?: Dp.Unspecified,
            color = { c },
            rippleAlpha = { RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.1f, hoveredAlpha = 0.08f, pressedAlpha = pressed) },
        )
    }

    override fun equals(other: Any?) = other is ZnRipple && other.color == color && other.opacity == opacity &&
        other.bounded == bounded && other.radius == radius
    override fun hashCode() = listOf(color, opacity, bounded, radius).hashCode()
}

/** pressFeedback "highlight": a flat overlay in [color] while pressed (RN TouchableHighlight's underlayColor). */
internal class ZnHighlight(private val color: Color) : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = HighlightNode(interactionSource, color)
    override fun equals(other: Any?) = other is ZnHighlight && other.color == color
    override fun hashCode() = color.hashCode()

    private class HighlightNode(private val source: InteractionSource, private val color: Color) :
        Modifier.Node(), DrawModifierNode {
        private var presses = 0

        override fun onAttach() {
            coroutineScope.launch {
                source.interactions.collect { i ->
                    when (i) {
                        is PressInteraction.Press -> presses++
                        is PressInteraction.Release, is PressInteraction.Cancel -> presses = (presses - 1).coerceAtLeast(0)
                        else -> return@collect
                    }
                    invalidateDraw()
                }
            }
        }

        override fun ContentDrawScope.draw() {
            drawContent()
            if (presses > 0) drawRect(color)
        }
    }
}
