package dev.zeronative.runtime

import androidx.compose.animation.Animatable as ColorAnimatable
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.VectorConverter
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.AnimationVector
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.TwoWayConverter
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.graphics.colorspace.ColorSpaces
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlin.coroutines.coroutineContext
import kotlin.math.roundToInt
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

/**
 * A tween ("t<ms>e<easing>") or a spring ("s<dampingRatio>,<stiffness>"), as the compiler encodes them, and the
 * motion options after "~" (registry 11, compiler `timing()`): "d<ms>" delay, "r<n>" plays in all (-1 forever),
 * "v" reverse, "g<ms>" repeat delay, "f<v>" from, "k<v>:<v>..." keyframes, "m<t>:..." times, "b<x1>:<y1>:<x2>:<y2>"
 * cubic-bezier (easing 4), "z<e>:<e>..." an easing per keyframe segment (from imported .svg animations: an easing id,
 * or "4,x1,y1,x2,y2"). A value is a number, or "#AARRGGBB" for backgroundColor. Easing 5 is a step: it holds, then
 * jumps at the end of its segment (SMIL calcMode="discrete", CSS step-end). Registry 13: "w" waits for a tap on the
 * Svg (SMIL begin="click"): the resting value until then, and each tap plays it again from the start.
 */
internal class ZnTiming(
    private val ms: Int,
    private val easing: Int,
    private val damping: Float,
    private val stiffness: Float,
    val delayMs: Int = 0,
    /** Plays in all; -1 forever. */
    val plays: Int = 1,
    val reverse: Boolean = false,
    val repeatDelayMs: Int = 0,
    /** The start value ("from"), or null. */
    val from: String? = null,
    /** Keyframe values, or null. */
    val keyframes: List<String>? = null,
    /** Keyframe times 0–1, or null (evenly spaced). */
    val times: FloatArray? = null,
    private val bezier: FloatArray? = null,
    /** An easing per keyframe segment, or null (every segment uses this timing's curve). */
    private val segments: List<Easing>? = null,
    /** Starts on a tap on its Svg, not by itself ("w", registry 13). */
    val waitsForTap: Boolean = false,
) {
    /** True when it plays by itself (when the element appears, and on replay), not when a value changes. */
    val selfPlaying = from != null || keyframes != null

    private fun curve(): Easing = easingOf(easing, bezier)

    /** One play, from one value to the next (no delay: callers wait it out, so springs and tweens are the same). */
    fun <T> spec(): AnimationSpec<T> =
        if (ms >= 0) tween(ms, easing = curve()) else spring(dampingRatio = damping, stiffness = stiffness)

    /** One play through [values] (the keyframes), each segment with its own easing, else this timing's curve. */
    fun <T> keyframeSpec(values: List<T>): AnimationSpec<T> {
        val d = ms.coerceAtLeast(0)
        val e = curve()
        return keyframes {
            durationMillis = d
            values.forEachIndexed { i, v ->
                val t = times?.getOrNull(i) ?: (i.toFloat() / (values.size - 1))
                // Rounded, not cut: the compiler writes times as whole ms, and 0.0499 * 1000 must stay 50.
                (v at (t * d).roundToInt()) using (segments?.getOrNull(i) ?: e)
            }
        }
    }

    companion object {
        fun parse(s: String): ZnTiming? {
            val pieces = s.split('~')
            val b = pieces[0]
            var delay = 0
            var plays = 1
            var reverse = false
            var gap = 0
            var from: String? = null
            var keys: List<String>? = null
            var times: FloatArray? = null
            var bezier: FloatArray? = null
            var segments: List<Easing>? = null
            var tap = false
            for (o in pieces.drop(1)) {
                if (o.isEmpty()) continue
                val v = o.substring(1)
                when (o[0]) {
                    'd' -> delay = v.toIntOrNull() ?: return null
                    'r' -> plays = v.toIntOrNull() ?: return null
                    'v' -> reverse = true
                    'w' -> tap = true
                    'g' -> gap = v.toIntOrNull() ?: return null
                    'f' -> from = v
                    'k' -> keys = v.split(':')
                    'm' -> times = v.split(':').map { it.toFloatOrNull() ?: return null }.toFloatArray()
                    'b' -> bezier = v.split(':').map { it.toFloatOrNull() ?: return null }.toFloatArray().takeIf { it.size == 4 }
                    'z' -> segments = v.split(':').map { seg ->
                        val n = seg.split(',')
                        val id = n[0].toIntOrNull() ?: return null
                        val b = if (n.size == 5) n.drop(1).map { it.toFloatOrNull() ?: return null }.toFloatArray() else null
                        easingOf(id, b)
                    }
                    else -> {} // a later option: ignored (the bundle asks for the registry that knows it)
                }
            }
            return when {
                b.startsWith("t") -> {
                    val e = b.indexOf('e')
                    ZnTiming(b.substring(1, if (e > 0) e else b.length).toIntOrNull() ?: return null,
                        if (e > 0) b.substring(e + 1).toIntOrNull() ?: 0 else 0, 1f, 0f,
                        delay, plays, reverse, gap, from, keys, times, bezier, segments, tap)
                }
                b.startsWith("s") -> {
                    val parts = b.substring(1).split(',')
                    ZnTiming(-1, 0, parts.getOrNull(0)?.toFloatOrNull() ?: 0.75f, parts.getOrNull(1)?.toFloatOrNull() ?: 400f,
                        delay, plays, reverse, gap, from, keys, times, bezier, segments, tap)
                }
                else -> null
            }
        }
    }
}

/** Holds, then jumps at the very end (easing 5). */
private val StepEasing = Easing { if (it < 1f) 0f else 1f }

/** An easing by the compiler's id (`EASINGS` in compile.ts; 4 = [bezier], 5 = step). */
private fun easingOf(id: Int, bezier: FloatArray?): Easing = when (id) {
    1 -> LinearOutSlowInEasing // ease-out
    2 -> FastOutLinearInEasing // ease-in
    3 -> LinearEasing
    4 -> bezier?.let { CubicBezierEasing(it[0], it[1], it[2], it[3]) } ?: FastOutSlowInEasing
    5 -> StepEasing
    else -> FastOutSlowInEasing // standard
}

/** `animate`: per prop id, or "*" for every animatable prop of the element. */
internal class ZnAnimate(private val byProp: Map<Int, ZnTiming>, private val all: ZnTiming?) {
    fun timingFor(prop: Int): ZnTiming? = byProp[prop] ?: all
    /** Some prop has a loop or keyframes. */
    val selfPlaying = byProp.values.any { it.selfPlaying }
    /** Some prop starts on a tap on the Svg (registry 13). */
    val waitsForTap = byProp.values.any { it.waitsForTap } || all?.waitsForTap == true

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
    if (s.opacitySlot < 0 && !s.hasTransformSlots && s.enter == null && !hasExit && pressed == null && !s.hasMotion) return null
    val a = s.animate
    val m = znMotionInputs(s, inst)
    val opacity = animatedFloat(inst, s.opacitySlot, s.opacity, a?.timingFor(Registry.Prop.OPACITY), m)
    val scale = animatedFloat(inst, s.scaleSlot, s.scaleBase, a?.timingFor(Registry.Prop.SCALE), m)
    val scaleX = animatedFloat(inst, s.scaleXSlot, s.scaleXOnly, a?.timingFor(Registry.Prop.SCALE_X), m)
    val scaleY = animatedFloat(inst, s.scaleYSlot, s.scaleYOnly, a?.timingFor(Registry.Prop.SCALE_Y), m)
    val rotate = animatedFloat(inst, s.rotateSlot, s.rotate, a?.timingFor(Registry.Prop.ROTATE), m)
    val tx = animatedFloat(inst, s.translateXSlot, s.translateX, a?.timingFor(Registry.Prop.TRANSLATE_X), m)
    val ty = animatedFloat(inst, s.translateYSlot, s.translateY, a?.timingFor(Registry.Prop.TRANSLATE_Y), m)

    // Enter: from the `enter` state to the element's own values, once, when the node first appears.
    val enter = s.enter
    val inP: Animatable<Float, *>? = if (enter != null) {
        val p = remember(inst) { Animatable(0f) }
        LaunchedEffect(inst) {
            znDelay(enter.timing.delayMs)
            p.animateTo(1f, enter.timing.spec())
        }
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
            znDelay(exit.timing.delayMs)
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
internal fun animatedFloat(inst: ZnInstance, slot: Int, static: Float, timing: ZnTiming?, m: ZnMotionInputs): () -> Float {
    val cell: MutableState<Any?>? = if (slot >= 0) inst.slot(slot) else null
    val read: () -> Float = remember(cell, static) {
        if (cell == null) ({ static }) else ({ (cell.value as? Double)?.toFloat() ?: static })
    }
    // A loop or keyframes: plays by itself, also on a value that never changes.
    if (timing != null && timing.selfPlaying) return znMotion(timing, Float.VectorConverter, String::toFloatOrNull, read, m)
    if (cell == null || timing == null) return read
    val anim = remember(cell) { Animatable(read()) }
    LaunchedEffect(cell, timing) {
        snapshotFlow(read).collectLatest {
            znDelay(timing.delayMs)
            anim.animateTo(it, timing.spec())
        }
    }
    return remember(anim) { { anim.value } }
}

/** A dynamic background colour, animated when the element's `animate` covers backgroundColor. */
@Composable
internal fun znBackground(s: ZnNodeSpec, inst: ZnInstance): (() -> Color)? {
    val timing = s.animate?.timingFor(Registry.Prop.BACKGROUND_COLOR)
    if (s.backgroundSlot < 0 && timing?.selfPlaying != true) return null
    val cell = if (s.backgroundSlot >= 0) inst.slot(s.backgroundSlot) else null
    val static = s.background ?: Color.Transparent
    val read: () -> Color = remember(cell) { if (cell == null) ({ static }) else ({ toColor(cell.value) ?: Color.Transparent }) }
    if (timing != null && timing.selfPlaying) {
        return znMotion(timing, Color.VectorConverter(ColorSpaces.Srgb), ::motionColor, read, znMotionInputs(s, inst))
    }
    if (timing == null) return read
    val anim = remember(cell) { ColorAnimatable(read()) }
    LaunchedEffect(cell, timing) {
        snapshotFlow(read).collectLatest {
            znDelay(timing.delayMs)
            anim.animateTo(it, timing.spec())
        }
    }
    return remember(anim) { { anim.value } }
}

/** Where a run of plays is: [time] inside one play (0..length) to show, and whether the run has ended. */
internal class ZnMotionAt(val time: Long, val done: Boolean)

/**
 * The position at [playTime] of a run of [plays] plays (-1 forever) of [length] each, [gap] apart. With [reverse]
 * every second play runs backwards. After the last play: where it ended, and done.
 */
internal fun motionAt(playTime: Long, length: Long, gap: Long, plays: Int, reverse: Boolean): ZnMotionAt {
    val cycle = length + gap
    if (cycle <= 0L) return ZnMotionAt(if (reverse && plays >= 0 && (plays - 1) % 2 == 1) 0L else length, true)
    val index = playTime / cycle
    if (plays >= 0 && index >= plays) {
        val forward = !reverse || (plays - 1) % 2 == 0
        return ZnMotionAt(if (forward) length else 0L, true)
    }
    val within = (playTime - index * cycle).coerceAtMost(length)
    val forward = !reverse || index % 2 == 0L
    return ZnMotionAt(if (forward) within else length - within, false)
}

/**
 * A colour that may be absent (an SvgPart's fill / stroke: null = no override): a constant, a slot, or animated by
 * [timing] (on change, or by itself with from / keyframes). An animation needs a colour to start from, so an
 * animated part without one starts from transparent.
 */
@Composable
internal fun animatedColor(inst: ZnInstance, slot: Int, static: Color?, timing: ZnTiming?, m: ZnMotionInputs): () -> Color? {
    val cell = if (slot >= 0) inst.slot(slot) else null
    val read: () -> Color? = remember(cell, static) { if (cell == null) ({ static }) else ({ toColor(cell.value) ?: static }) }
    if (timing == null || (cell == null && static == null && !timing.selfPlaying)) return read
    val rest: () -> Color = remember(read) { { read() ?: Color.Transparent } }
    if (timing.selfPlaying) return znMotion(timing, Color.VectorConverter(ColorSpaces.Srgb), ::motionColor, rest, m)
    if (cell == null) return read
    val anim = remember(cell) { ColorAnimatable(rest()) }
    LaunchedEffect(cell, timing) {
        snapshotFlow(rest).collectLatest {
            znDelay(timing.delayMs)
            anim.animateTo(it, timing.spec())
        }
    }
    return remember(anim) { { if (read() == null) null else anim.value } }
}

/** "#AARRGGBB" from the compiler's motion options. */
private fun motionColor(s: String): Color? =
    if (s.length == 9 && s[0] == '#') s.substring(1).toLongOrNull(16)?.let { Color(it.toInt()) } else null

/**
 * The element's `paused` and `replay`, read where the motion needs them (both can change at runtime), and how many
 * times its Svg was tapped (for timings that wait for a tap, registry 13).
 */
internal class ZnMotionInputs(val paused: () -> Boolean, val replay: () -> Any?, val taps: () -> Int = { 0 })

@Composable
internal fun znMotionInputs(s: ZnNodeSpec, inst: ZnInstance): ZnMotionInputs = remember(s, inst) {
    val p = if (s.pausedSlot >= 0) inst.slot(s.pausedSlot) else null
    val r = if (s.replaySlot >= 0) inst.slot(s.replaySlot) else null
    val static = s.paused
    ZnMotionInputs(
        paused = if (p == null) ({ static }) else ({ p.value == true }),
        replay = if (r == null) ({ null }) else ({ r.value }),
    )
}

/**
 * An SvgPart's `paused` / `replay` together with its Svg node's: `<Spinner paused={...} />` holds every motion inside
 * the file, including its own SMIL / CSS animations (which have no part props of their own).
 */
@Composable
internal fun znMotionInputs(part: ZnNodeSpec, svg: ZnNodeSpec, inst: ZnInstance, taps: () -> Int = { 0 }): ZnMotionInputs {
    val own = znMotionInputs(part, inst)
    val outer = znMotionInputs(svg, inst)
    return remember(own, outer, taps) { ZnMotionInputs({ own.paused() || outer.paused() }, { own.replay() to outer.replay() }, taps) }
}

/** The phone's animation speed ("Animation duration scale" in developer options): 0 when animations are off. */
private suspend fun motionScale(): Float = coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f

/** Waits [ms] of animation time: scaled like every animation, and not at all when animations are off. */
internal suspend fun znDelay(ms: Int) {
    if (ms <= 0) return
    val scale = motionScale()
    if (scale > 0f) delay((ms * scale).toLong())
}

/**
 * A value that plays by itself (a timing with `from` or `keyframes`, registry 11): when the element appears, again
 * on each new `replay` value, and (with `from`) when the resting value [rest] changes. Time runs only while not
 * `paused`, so a pause holds the value and play goes on from there. A finite run stays where its last play ended.
 * When the phone's animations are off it shows [rest] and runs nothing. Read in the draw phase: no recomposition.
 */
@Composable
internal fun <T, V : AnimationVector> znMotion(
    t: ZnTiming,
    converter: TwoWayConverter<T, V>,
    parse: (String) -> T?,
    rest: () -> T,
    m: ZnMotionInputs,
): () -> T {
    val keys = remember(t) { t.keyframes?.mapNotNull(parse)?.takeIf { it.size >= 2 } }
    val from = remember(t) { t.from?.let(parse) }
    val value = remember(t) { mutableStateOf(keys?.first() ?: from ?: rest()) }
    val off = remember(t) { mutableStateOf(false) }
    LaunchedEffect(t) {
        // Keyframes don't depend on the resting value; `from` plays towards it, so a new one starts again. A timing
        // that waits for a tap also starts again on each tap.
        val taps = { if (t.waitsForTap) m.taps() else 0 }
        val restart = if (keys != null) snapshotFlow { m.replay() to taps() } else snapshotFlow { Triple(m.replay(), rest(), taps()) }
        restart.collectLatest {
            if (t.waitsForTap && taps() == 0) {
                off.value = true // the resting value until the first tap
                return@collectLatest
            }
            if (motionScale() == 0f) {
                off.value = true
                return@collectLatest
            }
            off.value = false
            val to = rest()
            val anim = if (keys != null) TargetBasedAnimation(t.keyframeSpec(keys), converter, keys.first(), keys.last())
            else TargetBasedAnimation(t.spec(), converter, from ?: to, to)
            value.value = anim.getValueFromNanos(0L)
            znDelay(t.delayMs)
            val length = anim.durationNanos
            val gap = t.repeatDelayMs * 1_000_000L
            var playTime = 0L
            var last = -1L
            while (true) {
                if (m.paused()) {
                    snapshotFlow { m.paused() }.first { !it }
                    last = -1L
                }
                val scale = motionScale()
                if (scale == 0f) {
                    off.value = true
                    break
                }
                val at = withFrameNanos { now ->
                    if (last >= 0L) playTime += ((now - last) / scale).toLong()
                    last = now
                    val at = motionAt(playTime, length, gap, t.plays, t.reverse)
                    value.value = anim.getValueFromNanos(at.time)
                    at
                }
                if (at.done) break
            }
        }
    }
    return remember(t) { { if (off.value) rest() else value.value } }
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
