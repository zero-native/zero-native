package dev.zeronative.runtime

import android.provider.Settings
import android.util.Log
import androidx.compose.animation.core.Animation
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.DecayAnimation
import androidx.compose.animation.core.FloatExponentialDecaySpec
import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.VectorConverter
import androidx.compose.animation.core.generateDecayAnimationSpec
import androidx.compose.animation.core.getVelocityFromNanos
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.platform.AndroidUiDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.ln
import kotlin.math.sqrt

// Motion values (docs/gestures-and-motion-v1.md §2.1, §2.2, §2.4). Numbers owned by native and moved on the UI thread:
// by a finger (ZnGesture.kt), by an animation JS asked for, or by a formula of other values. Bindings read them in the
// draw phase (ZnAnimation.kt znLayer), so a moving value redraws its nodes and never recomposes. JS only creates
// them, sends commands, and reads them (at most once per frame, and only the ones it reads).
//
// A slot that follows a value holds "\u0000m<id>" (core motion.ts): a number prop never holds a string otherwise,
// so an older renderer shows the static value. All of this runs on the main thread.

/** The sizes a formula's `self` / `parent` read (dp): the node it is bound on, or the node of the gesture that uses it. */
internal class ZnSite {
    val selfW = mutableFloatStateOf(0f)
    val selfH = mutableFloatStateOf(0f)
    val parentW = mutableFloatStateOf(0f)
    val parentH = mutableFloatStateOf(0f)

    fun update(w: Float, h: Float, pw: Float, ph: Float) {
        if (selfW.floatValue != w) selfW.floatValue = w
        if (selfH.floatValue != h) selfH.floatValue = h
        if (parentW.floatValue != pw) parentW.floatValue = pw
        if (parentH.floatValue != ph) parentH.floatValue = ph
    }
}

/** Something a binding can follow: read in the draw or layout phase, so Compose tracks the states it reads. */
internal abstract class ZnSource(val id: Int) {
    /** The number now. Never NaN or infinite (rule 5 of the plan): a source that can't say gives its last good value. */
    abstract fun read(site: ZnSite?): Float
    /** ARGB, for colour sources ([isColor]). */
    open fun readColor(site: ZnSite?): Int = 0
    open val isColor: Boolean get() = false
    /** Uses `self` / `parent` (only formulas). */
    open val usesSite: Boolean get() = false
    open fun dispose() {}
}

/** A value JS made with useMotion (or a gesture's x, y, scale...). */
internal class ZnValue(id: Int, initial: Float) : ZnSource(id) {
    val state = mutableFloatStateOf(initial)
    /** dp (or units) per second of the animation that moves it now, or that moved it last (for velocity hand-off). */
    var velocity = 0f
    var job: Job? = null
    /** The command whose promise is still open, and its sequence number. */
    var command: ZnCall? = null
    var seq = 0
    /** The gesture whose finger holds this value, or null. */
    var heldBy: ZnGestureTouch? = null

    var value: Float
        get() = state.floatValue
        set(v) {
            if (v.isFinite()) state.floatValue = v
        }

    override fun read(site: ZnSite?): Float = state.floatValue

    /** Stops what moves it (an animation); its promise says finished: false. Keeps the velocity it had. */
    fun interrupt() {
        job?.cancel()
        job = null
        command?.resolve(JSONObject().put("finished", false))
        command = null
    }

    override fun dispose() = interrupt()
}

/** A window value (§2.2): width, height, insets, keyboard. Written by ZnNavHost. */
internal class ZnEnvValue(id: Int) : ZnSource(id) {
    val state = mutableFloatStateOf(0f)
    override fun read(site: ZnSite?): Float = state.floatValue
    fun set(v: Float) {
        if (v.isFinite() && state.floatValue != v) state.floatValue = v
    }
}

/** `v.map([in], [out], { extrapolate })`: piecewise straight lines. */
internal class ZnMapSource(id: Int, private val src: ZnSource, private val ins: FloatArray, private val outs: FloatArray, private val ex: Int) :
    ZnSource(id) {
    override fun read(site: ZnSite?): Float = znInterpolate(src.read(site), ins, outs, ex)
    override val usesSite: Boolean get() = src.usesSite
}

/** `v.mapColor([in], [colours])`: RGBA mixed along the input. */
internal class ZnColorMapSource(id: Int, private val src: ZnSource, private val ins: FloatArray, private val colors: IntArray) : ZnSource(id) {
    override val isColor: Boolean get() = true
    override val usesSite: Boolean get() = src.usesSite
    override fun read(site: ZnSite?): Float = src.read(site)
    override fun readColor(site: ZnSite?): Int = znMixColors(src.read(site), ins, colors)
}

/** `derive(() => ...)`: a formula of other sources (ZnFormula.kt). */
internal class ZnFormulaSource(id: Int, private val f: ZnFormula) : ZnSource(id) {
    private var last = 0f
    override val isColor: Boolean get() = f.isColor
    override val usesSite: Boolean get() = f.usesSite
    override fun read(site: ZnSite?): Float {
        val v = f.eval(site)
        if (v.isFinite()) last = v
        return last
    }
    override fun readColor(site: ZnSite?): Int = f.evalColor(site)
}

/** `follow(source, spring)`: chases [src] with spring physics, keeping its speed when the target moves (§2.1). */
internal class ZnFollowSource(id: Int, private val src: ZnSource, private val spring: ZnTimingSpec) : ZnSource(id) {
    private val v = ZnValue(-id, src.read(null))
    private val job: Job = ZnMotion.scope.launch {
        snapshotFlow { src.read(null) }.collectLatest { target ->
            v.animate(target, spring)
        }
    }
    override fun read(site: ZnSite?): Float = v.read(site)
    override fun dispose() = job.cancel()
}

/**
 * How a value moves to a target. [ms] ≥ 0: a tween with [easing] ([bezier] for 4); else a spring with [ratio] and
 * [stiffness]. [clamp]: a spring stops at the target the first time it gets there (Reanimated overshootClamp).
 */
internal class ZnTimingSpec(val ms: Int, val easing: Int, val bezier: FloatArray?, val ratio: Float, val stiffness: Float, val clamp: Boolean) {
    fun animation(from: Float, to: Float, velocity: Float): Animation<Float, AnimationVector1D> {
        val spec = if (ms >= 0) tween<Float>(ms, easing = znEasing(easing, bezier)) else spring(ratio, stiffness, 0.01f)
        return TargetBasedAnimation(spec, Float.VectorConverter, from, to, if (ms >= 0) 0f else velocity)
    }

    companion object {
        /** The default spring (as `animate="spring"`). */
        val SPRING = ZnTimingSpec(-1, 0, null, 0.75f, 400f, false)

        /**
         * {"t":ms,"e":easing,"b":[x1,y1,x2,y2]} | {"r":dampingRatio,"k":stiffness,"c":true}. JS turns Reanimated's
         * damping / stiffness / mass and duration + dampingRatio into these (core motion.ts springOf).
         */
        fun parse(o: JSONObject?): ZnTimingSpec {
            if (o == null) return SPRING
            if (o.has("t")) {
                val b = o.optJSONArray("b")?.let { a -> FloatArray(4) { a.optDouble(it, 0.0).toFloat() } }
                return ZnTimingSpec(o.optInt("t", 250).coerceIn(0, 60_000), o.optInt("e", 0), b, 1f, 0f, false)
            }
            val ratio = o.optDouble("r", 0.75).toFloat().takeIf { it.isFinite() && it > 0f } ?: 0.75f
            val k = o.optDouble("k", 400.0).toFloat().takeIf { it.isFinite() && it > 0f } ?: 400f
            return ZnTimingSpec(-1, 0, null, ratio, k, o.optBoolean("c", false))
        }
    }
}

/** Runs [anim] on this value frame by frame. Returns true if it ran to the end. Keeps the velocity it reached. */
internal suspend fun ZnValue.run(anim: Animation<Float, AnimationVector1D>, clampAt: Float? = null): Boolean {
    val start = withFrameNanos { it }
    val from = value
    while (true) {
        val done = withFrameNanos { now ->
            val t = now - start
            val v = anim.getValueFromNanos(t)
            velocity = anim.getVelocityFromNanos(t)
            if (clampAt != null && (v - clampAt) * (from - clampAt) <= 0f) {
                value = clampAt
                velocity = 0f
                true
            } else {
                value = v
                anim.isFinishedFromNanos(t)
            }
        }
        if (done) break
    }
    velocity = 0f
    return true
}

/** Moves to [to] with [t], starting from where it is and at the speed it has. */
internal suspend fun ZnValue.animate(to: Float, t: ZnTimingSpec): Boolean {
    if (!to.isFinite()) return false
    if (ZnMotion.animationsOff()) {
        value = to
        velocity = 0f
        return true
    }
    return run(t.animation(value, to, velocity), if (t.clamp) to else null)
}

/** Slows down from [v0] (or its own velocity) with [friction]; stops at [lo] / [hi]. */
internal suspend fun ZnValue.decay(v0: Float, friction: Float, lo: Float?, hi: Float?): Boolean {
    if (ZnMotion.animationsOff()) {
        velocity = 0f
        return true
    }
    val anim = DecayAnimation(FloatExponentialDecaySpec(friction).generateDecayAnimationSpec(), Float.VectorConverter, value, v0)
    val start = withFrameNanos { it }
    while (true) {
        val done = withFrameNanos { now ->
            val t = now - start
            var v = anim.getValueFromNanos(t)
            velocity = anim.getVelocityFromNanos(t)
            var stop = anim.isFinishedFromNanos(t)
            if (lo != null && v < lo) { v = lo; stop = true }
            if (hi != null && v > hi) { v = hi; stop = true }
            value = v
            stop
        }
        if (done) break
    }
    velocity = 0f
    return true
}

/** Reanimated's withDecay `deceleration` (velocity kept per ms, 0.998) → Compose's exponential decay friction. */
internal fun znFriction(deceleration: Double): Float {
    val d = deceleration.takeIf { it.isFinite() && it > 0.9 && it < 1.0 } ?: 0.998
    return (-1000.0 * ln(d) / 4.2).toFloat()
}

/**
 * Piecewise straight lines through ([ins], [outs]). [ex]: 0 clamp (hold the end values), 1 extend (keep the end
 * slopes), 2 identity (outside the inputs the output is the input).
 */
internal fun znInterpolate(x: Float, ins: FloatArray, outs: FloatArray, ex: Int): Float {
    val n = ins.size
    if (n == 0) return x
    if (n == 1) return outs[0]
    if (x <= ins[0] || x >= ins[n - 1]) {
        val low = x <= ins[0]
        when (ex) {
            0 -> return if (low) outs[0] else outs[n - 1]
            2 -> return x
        }
        val i = if (low) 0 else n - 2
        return segment(x, ins[i], ins[i + 1], outs[i], outs[i + 1])
    }
    var i = 0
    while (i < n - 2 && x > ins[i + 1]) i++
    return segment(x, ins[i], ins[i + 1], outs[i], outs[i + 1])
}

private fun segment(x: Float, x0: Float, x1: Float, y0: Float, y1: Float): Float {
    val span = x1 - x0
    if (span == 0f) return y0
    return y0 + (y1 - y0) * (x - x0) / span
}

/** ARGB colours mixed channel by channel along [ins] (clamped at the ends). */
internal fun znMixColors(x: Float, ins: FloatArray, colors: IntArray): Int {
    val n = ins.size
    if (n == 0) return 0
    if (n == 1 || x <= ins[0]) return colors[0]
    if (x >= ins[n - 1]) return colors[n - 1]
    var i = 0
    while (i < n - 2 && x > ins[i + 1]) i++
    val span = ins[i + 1] - ins[i]
    val t = if (span == 0f) 0f else (x - ins[i]) / span
    return mixArgb(colors[i], colors[i + 1], t)
}

internal fun mixArgb(a: Int, b: Int, t: Float): Int {
    fun ch(shift: Int): Int {
        val x = (a ushr shift) and 0xFF
        val y = (b ushr shift) and 0xFF
        return (x + (y - x) * t).toInt().coerceIn(0, 255) shl shift
    }
    return ch(24) or ch(16) or ch(8) or ch(0)
}

/**
 * The built-in `Motion` module (JS: core motion.ts). JS gives every object an id; native keeps them here until JS
 * disposes them (their owner, a screen or a component, went away). Ids 1–15 are the window values (§2.2).
 */
internal object ZnMotion : ZnModuleBase("Motion", version = 1) {
    private const val TAG = "zn"
    private const val REF = "\u0000m"

    // Window values. Ids fixed with core motion.ts `env`.
    const val ENV_WIDTH = 1
    const val ENV_HEIGHT = 2
    const val ENV_INSET_TOP = 3
    const val ENV_INSET_BOTTOM = 4
    const val ENV_INSET_START = 5
    const val ENV_INSET_END = 6
    const val ENV_KEYBOARD = 7
    const val ENV_KEYBOARD_TARGET = 8
    private const val ENV_LAST = 15

    /** Main thread, with Compose's frame clock (withFrameNanos). Made on first use, on the main thread. */
    val scope: CoroutineScope by lazy { CoroutineScope(SupervisorJob() + AndroidUiDispatcher.Main) }

    private val sources = HashMap<Int, ZnSource>()
    private val env = HashMap<Int, ZnEnvValue>()
    /** Slot text → its source, so a draw-phase read doesn't parse the id each frame. */
    private val refs = HashMap<String, ZnSource>()
    /** Watched sources (JS reads them) → their collecting job. */
    private val watching = HashMap<Int, Job>()
    private val toJs = HashMap<Int, Float>()
    private var toJsQueued = false

    init {
        for (i in 1..ENV_LAST) env[i] = ZnEnvValue(i).also { sources[i] = it }

        function("value", onMain = true) { c ->
            val id = c.int("id")
            put(id, ZnValue(id, c.double("v").toFloat().finiteOr(0f)))
            c.resolve()
        }
        function("map", onMain = true) { c ->
            val id = c.int("id")
            val (ins, outs) = mapArrays(c.args, "in", "out")
            put(id, ZnMapSource(id, source(c.int("src")), ins, outs, c.intOrNull("ex") ?: 0))
            c.resolve()
        }
        function("mapColor", onMain = true) { c ->
            val id = c.int("id")
            val ins = floats(c.args.optJSONArray("in"))
            val colors = c.args.optJSONArray("out")?.let { a -> IntArray(a.length()) { a.optLong(it).toInt() } } ?: IntArray(0)
            if (ins.size != colors.size || ins.isEmpty()) throw ZnInvalidArgs("mapColor needs as many colours as inputs")
            checkRising(ins)
            put(id, ZnColorMapSource(id, source(c.int("src")), ins, colors))
            c.resolve()
        }
        function("formula", onMain = true) { c ->
            val id = c.int("id")
            val srcs = c.args.optJSONArray("srcs") ?: JSONArray()
            val inputs = Array(srcs.length()) { i ->
                when (val s = srcs.get(i)) {
                    is Number -> ZnFormula.Input.Const(s.toFloat())
                    is JSONObject -> ZnFormula.Input.Src(source(s.getInt("m")))
                    else -> throw ZnInvalidArgs("formula input $i is not a number or a motion value")
                }
            }
            val f = ZnFormula.compile(c.args.getJSONArray("code"), inputs, c.args.optJSONArray("tables"))
            put(id, ZnFormulaSource(id, f))
            c.resolve()
        }
        function("follow", onMain = true) { c ->
            val id = c.int("id")
            put(id, ZnFollowSource(id, source(c.int("src")), ZnTimingSpec.parse(c.args.optJSONObject("t"))))
            c.resolve()
        }
        function("dispose", onMain = true) { c ->
            val ids = c.args.optJSONArray("ids") ?: JSONArray()
            for (i in 0 until ids.length()) dispose(ids.optInt(i))
            c.resolve()
        }
        function("set", onMain = true) { c ->
            val v = value(c.int("id"))
            if (v.heldBy != null && !c.args.optBoolean("interrupt")) return@function c.resolve()
            v.heldBy?.cancel()
            v.interrupt()
            v.velocity = 0f
            v.value = c.double("v").toFloat()
            c.resolve()
        }
        function("stop", onMain = true) { c ->
            value(c.int("id")).interrupt()
            c.resolve()
        }
        function("animate", onMain = true) { c -> animate(c) }
        function("watch", onMain = true) { c ->
            watch(c.int("id"), c.args.optBoolean("on", true))
            c.resolve()
        }
        ZnGestures.install(this)
    }

    // Lets ZnGestures add its functions to this module (one "Motion" module for the whole feature).
    internal fun addFunction(method: String, body: (ZnCall) -> Unit) = function(method, onMain = true, body)

    private fun Float.finiteOr(d: Float) = if (isFinite()) this else d

    private fun put(id: Int, s: ZnSource) {
        if (id <= ENV_LAST) throw ZnInvalidArgs("motion id $id is reserved")
        sources.remove(id)?.dispose()
        sources[id] = s
    }

    fun find(id: Int): ZnSource? = sources[id]

    fun source(id: Int): ZnSource = sources[id] ?: throw ZnInvalidArgs("no motion value $id (made after it was used, or disposed)")

    fun value(id: Int): ZnValue = sources[id] as? ZnValue ?: throw ZnInvalidArgs("motion $id is not a value you can move")

    /** Ids JS made itself (gestures' values come in through [put] too). */
    fun putValue(id: Int, initial: Float): ZnValue = ZnValue(id, initial).also { put(id, it) }

    fun putSource(s: ZnSource) = put(s.id, s)

    fun dispose(id: Int) {
        if (id <= ENV_LAST) return
        watching.remove(id)?.cancel()
        sources.remove(id)?.dispose()
        ZnGestures.dispose(id)
    }

    fun env(id: Int): ZnEnvValue = env.getValue(id)

    /** Dev reload: the JS that made these is gone. */
    fun reset() {
        for (id in sources.keys.filter { it > ENV_LAST }) dispose(id)
        refs.clear()
        toJs.clear()
    }

    /** True when the phone's animations are off ("Remove animations"): values jump to where they end. */
    fun animationsOff(): Boolean {
        val ctx = ZnActivity.current ?: return false
        return try {
            Settings.Global.getFloat(ctx.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        } catch (e: Exception) {
            false
        }
    }

    // ---- Slots that follow a source -----------------------------------------------------------------------------------

    /** True when a slot holds a reference to a motion source. */
    fun isRef(v: Any?): Boolean = v is String && v.startsWith(REF)

    /** The source a slot value refers to, or null (not a reference, or the source is gone). */
    fun ref(v: Any?): ZnSource? {
        if (v !is String || !v.startsWith(REF)) return null
        refs[v]?.let { if (sources[it.id] === it) return it }
        val id = v.substring(REF.length).toIntOrNull() ?: return null
        val s = sources[id] ?: return null
        refs[v] = s
        return s
    }

    // ---- Commands -----------------------------------------------------------------------------------------------------

    /**
     * {"id", "steps":[{"to":x,"t":timing,"delay":ms} | {"decay":{"v","f","lo","hi"},"delay"} | {"set":x,"delay"}],
     * "repeat":n (-1 forever), "reverse":bool, "interrupt":bool}. Answers {finished}. A command to a value a finger
     * holds is dropped (finished: false) unless "interrupt" (D2, Argon). A new command ends the one before it first
     * (its promise says finished: false), so chained `.then()` never run out of order.
     */
    private fun animate(c: ZnCall) {
        val v = value(c.int("id"))
        if (v.heldBy != null) {
            if (!c.args.optBoolean("interrupt")) return c.resolve(JSONObject().put("finished", false))
            v.heldBy?.cancel()
        }
        val steps = c.args.optJSONArray("steps") ?: JSONArray()
        val repeat = c.args.optInt("repeat", 1)
        val reverse = c.args.optBoolean("reverse")
        v.interrupt()
        val seq = ++v.seq
        v.command = c
        v.job = scope.launch {
            var finished = true
            try {
                val start = v.value
                // A forever loop with animations off would spin: one play, then stop where it ends.
                val plays = if (animationsOff() && repeat != 1) 1 else repeat
                var play = 0
                while (plays < 0 || play < plays) {
                    val backwards = reverse && play % 2 == 1
                    if (!runSteps(v, steps, backwards, start)) {
                        finished = false
                        break
                    }
                    play++
                }
            } finally {
                if (v.seq == seq && v.command === c) {
                    v.command = null
                    v.job = null
                    c.resolve(JSONObject().put("finished", finished))
                }
            }
        }
    }

    /** One play of [steps]; [backwards] plays them in reverse, back to [start]. */
    private suspend fun runSteps(v: ZnValue, steps: JSONArray, backwards: Boolean, start: Float): Boolean {
        val n = steps.length()
        if (!backwards) {
            for (i in 0 until n) if (!runStep(v, steps.getJSONObject(i), null)) return false
            return true
        }
        // Each step's target in reverse is where the step before it ended (the first step's: the start).
        val ends = FloatArray(n)
        var at = start
        for (i in 0 until n) {
            val s = steps.getJSONObject(i)
            at = when {
                s.has("to") -> s.getDouble("to").toFloat()
                s.has("set") -> s.getDouble("set").toFloat()
                else -> at
            }
            ends[i] = at
        }
        for (i in n - 1 downTo 0) {
            val back = if (i == 0) start else ends[i - 1]
            if (!runStep(v, steps.getJSONObject(i), back)) return false
        }
        return true
    }

    private suspend fun runStep(v: ZnValue, s: JSONObject, overrideTo: Float?): Boolean {
        val wait = s.optInt("delay", 0)
        if (wait > 0 && !animationsOff()) delay(wait.toLong())
        return when {
            s.has("set") -> {
                v.velocity = 0f
                v.value = overrideTo ?: s.getDouble("set").toFloat()
                true
            }
            s.has("decay") -> {
                if (overrideTo != null) return v.animate(overrideTo, ZnTimingSpec.SPRING)
                val d = s.getJSONObject("decay")
                val v0 = if (d.has("v") && !d.isNull("v")) d.getDouble("v").toFloat() else v.velocity
                val lo = if (d.has("lo")) d.getDouble("lo").toFloat() else null
                val hi = if (d.has("hi")) d.getDouble("hi").toFloat() else null
                v.decay(v0, d.optDouble("f", 0.476).toFloat(), lo, hi)
            }
            else -> v.animate(overrideTo ?: s.getDouble("to").toFloat(), ZnTimingSpec.parse(s.optJSONObject("t")))
        }
    }

    // ---- Values to JS ---------------------------------------------------------------------------------------------------

    /** JS reads [id]: send it each time it changes (once per frame at most, newest only). */
    private fun watch(id: Int, on: Boolean) {
        if (!on) {
            watching.remove(id)?.cancel()
            return
        }
        if (watching.containsKey(id)) return
        val s = sources[id] ?: return
        watching[id] = scope.launch {
            snapshotFlow { s.read(null) }.collectLatest { queueToJs(id, it) }
        }
    }

    private fun queueToJs(id: Int, v: Float) {
        val first = synchronized(toJs) {
            toJs[id] = v
            !toJsQueued.also { toJsQueued = true }
        }
        if (!first) return
        // One delivery queued at a time; it takes every value that changed by the time the JS thread gets to it.
        ZnRuntime.dispatchLatest(0, ZnAppEvent.MODULE_EVENT) {
            val payload = JSONObject()
            synchronized(toJs) {
                toJsQueued = false
                for ((k, x) in toJs) payload.put(k.toString(), x.toDouble())
                toJs.clear()
            }
            // (a reload in between: reset() cleared toJs, so this sends nothing)
            if (payload.length() == 0) null
            else JSONObject().put("module", "Motion").put("event", "values").put("payload", payload).toString()
        }
    }

    /** A gesture event (each one once, in order), after any values still waiting, so JS reads them first. */
    fun sendEvent(payload: JSONObject) {
        val json = JSONObject().put("module", "Motion").put("event", "gesture").put("payload", payload).toString()
        ZnRuntime.dispatchLatest(0, ZnAppEvent.MODULE_EVENT) { json }
    }

    /** Reads a value of [a] as floats. */
    fun floats(a: JSONArray?): FloatArray =
        if (a == null) FloatArray(0) else FloatArray(a.length()) { a.optDouble(it, 0.0).toFloat().let { v -> if (v.isFinite()) v else 0f } }

    private fun checkRising(ins: FloatArray) {
        for (i in 1 until ins.size) if (ins[i] < ins[i - 1]) throw ZnInvalidArgs("map inputs must go up: ${ins.joinToString()}")
    }

    private fun mapArrays(o: JSONObject, a: String, b: String): Pair<FloatArray, FloatArray> {
        val ins = floats(o.optJSONArray(a))
        val outs = floats(o.optJSONArray(b))
        if (ins.size != outs.size || ins.size < 2) throw ZnInvalidArgs("map needs 2 or more inputs and as many outputs")
        checkRising(ins)
        return ins to outs
    }

    internal fun log(msg: String) = Log.w(TAG, "motion: $msg")
}
