package dev.zeronative.runtime

import android.os.Build
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.View
import androidx.compose.animation.splineBasedDecay
import androidx.compose.animation.core.calculateTargetValue
import androidx.compose.foundation.systemGestureExclusion
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onPlaced
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Velocity
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

// Gestures (docs/gestures-and-motion-v1.md §2.3). A gesture is an object JS made (core motion.ts usePan, usePinch,
// ...); a node takes it with `gesture={g}`. Under the finger everything is native: the values it moves, the release
// (snap points, fling projection, magnets, decay) and haptics. JS hears events once each, in order, and only the ones
// it asked for. Combined gestures (Gesture.simultaneous / exclusive / race) share one pointer handler per node.

internal object ZnGestures {
    private val all = HashMap<Int, ZnGesture>()

    fun find(id: Int): ZnGesture? = all[id]

    fun dispose(id: Int) {
        all.remove(id)?.dispose()
    }

    /** Is [a] linked with [b] by simultaneousWith (either side named the other)? */
    fun simultaneous(a: ZnGesture, b: ZnGesture): Boolean = b.id in a.simWith || a.id in b.simWith

    /** Gestures in a touch now, on any element (for links between elements). */
    fun live(): Collection<ZnGesture> = all.values

    const val MANUAL_NONE = 0
    const val MANUAL_ACTIVATE = 1
    const val MANUAL_FAIL = 2

    /** The gesture functions of the `Motion` module. */
    fun install(m: ZnMotion) {
        // {"id", "kind": "pan"|"pinch"|"rotate"|"tap"|"longPress"|"fling", "values": {name: id}, ...options}
        m.addFunction("gesture") { c ->
            val id = c.int("id")
            all.remove(id)?.dispose()
            all[id] = ZnGesture.make(id, c.args)
            c.resolve()
        }
        // {"id", "mode": "simultaneous"|"exclusive"|"race", "of": [ids]}
        m.addFunction("gestureGroup") { c ->
            val id = c.int("id")
            val of = c.args.optJSONArray("of") ?: JSONArray()
            val members = List(of.length()) { i -> all[of.getInt(i)] ?: throw ZnInvalidArgs("gesture ${of.getInt(i)} doesn't exist") }
            if (members.isEmpty()) throw ZnInvalidArgs("a gesture group needs gestures")
            val mode = when (c.args.optString("mode")) {
                "simultaneous" -> ZnGesture.SIMULTANEOUS
                "exclusive" -> ZnGesture.EXCLUSIVE
                else -> ZnGesture.RACE
            }
            all.remove(id)?.dispose()
            all[id] = ZnGesture.group(id, mode, members)
            c.resolve()
        }
        // {"id", "s": "activate" | "fail"} (phase 3, RNGH's manualActivation + stateManager): for a gesture made with
        // manualActivation, JS decides when it starts. Applies to the touch in progress (it waits for JS's answer).
        m.addFunction("gestureState") { c ->
            val g = all[c.int("id")] ?: return@addFunction c.resolve()
            val want = if (c.string("s") == "activate") MANUAL_ACTIVATE else MANUAL_FAIL
            for (leaf in g.leaves) leaf.manualWant = want
            c.resolve()
        }
        // useZoom's zoomTo / reset: {"id", "s": scale, "x"?, "y"? (the point to zoom around, dp in the element; default
        // its centre), "t"?: timing}. Kept inside the edges. A touch in progress is cancelled (as snapTo). Answers {finished}.
        m.addFunction("zoomTo") { c ->
            val g = all[c.int("id")]?.leaves?.firstOrNull { it.kind == ZnGesture.ZOOM }
                ?: throw ZnInvalidArgs("gesture ${c.int("id")} is not a useZoom")
            g.touch?.cancel()
            val (cw, ch) = g.zoomContent()
            val s = c.args.optDouble("s", 1.0).toFloat().takeIf { it.isFinite() }?.coerceIn(g.zoomMin, g.zoomMax) ?: g.zoomMin
            val qx = c.args.optDouble("x", (g.selfW / 2f).toDouble()).toFloat()
            val qy = c.args.optDouble("y", (g.selfH / 2f).toDouble()).toFloat()
            val (ns, tx, ty) = ZnZoomMath.zoomTo(g.scale?.value ?: 1f, g.x?.value ?: 0f, g.y?.value ?: 0f, qx, qy, g.selfW, g.selfH, cw, ch, s)
            val spec = c.args.optJSONObject("t")?.let { ZnTimingSpec.parse(it) } ?: ZnGesture.ZOOM_TWEEN
            g.zoomAnimate(ns, tx, ty, spec, c)
        }
        // {"id", "anchor": anchor id, "t": timing}: answers {finished}.
        m.addFunction("snapTo") { c ->
            val g = all[c.int("id")] ?: throw ZnInvalidArgs("no gesture ${c.int("id")}")
            g.snapTo(c.string("anchor"), ZnTimingSpec.parse(c.args.optJSONObject("t")), c)
        }
    }
}

/** A coordinate in a gesture's options: dp, a share of the travel room, of its own size, of its parent's, or a value. */
internal class ZnSpec(private val dp: Float, private val share: Float, private val of: Int, private val src: ZnSource?) {
    /** [self] / [parent]: the node's and its parent's size along this axis (dp). */
    fun resolve(self: Float, parent: Float, site: ZnSite?): Float = when {
        src != null -> src.read(site)
        of == TRAVEL -> share * max(0f, parent - self)
        of == SELF -> share * self
        of == PARENT -> share * parent
        else -> dp
    }

    companion object {
        private const val DP = 0
        private const val TRAVEL = 1
        private const val SELF = 2
        private const val PARENT = 3

        /** A number, "N%" (of the travel room: parent minus own size), "N%self", "N%parent", or {"m": source id}. */
        fun parse(v: Any?): ZnSpec? = when (v) {
            null, JSONObject.NULL -> null
            is Number -> v.toFloat().takeIf { it.isFinite() }?.let { ZnSpec(it, 0f, DP, null) }
            is JSONObject -> ZnSpec(0f, 0f, DP, ZnMotion.source(v.getInt("m")))
            is String -> {
                val m = Regex("""^(-?\d+(?:\.\d+)?)%(self|parent)?$""").find(v.trim())
                    ?: throw ZnInvalidArgs("\"$v\": use a number of dp, \"N%\", \"N%self\" or \"N%parent\"")
                val share = m.groupValues[1].toFloat() / 100f
                ZnSpec(0f, share, when (m.groupValues[2]) { "self" -> SELF; "parent" -> PARENT; else -> TRAVEL }, null)
            }
            else -> throw ZnInvalidArgs("bad coordinate $v")
        }
    }
}

/** A snap point. 1D gestures use only the coordinate of their axis. */
internal class ZnAnchor(val id: String, val x: ZnSpec?, val y: ZnSpec?)

/** A magnetic zone (pillar 2): pulls the dragged node toward its centre inside [radius]; releasing inside snaps there. */
internal class ZnMagnet(val id: String, val x: ZnSpec, val y: ZnSpec, val radius: Float, val pull: Float) {
    var inside = false
}

/**
 * One gesture, or a group of them ([members], [mode]). Holds what it moves and how it releases; the per-touch state
 * lives in the recognizers (ZnRecognizer) made for each touch.
 */
internal class ZnGesture private constructor(
    val id: Int,
    val kind: Int,
    val o: JSONObject,
    val members: List<ZnGesture>,
    val mode: Int,
) {
    val site = ZnSite()
    val events: Set<String> = o.optJSONArray("ev")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()

    // Values it moves (JS made the ids; native owns them). Null when the kind doesn't have it.
    val x: ZnValue? = valueOf("x")
    val y: ZnValue? = valueOf("y")
    val scale: ZnValue? = valueOf("scale", 1f)
    val focalX: ZnValue? = valueOf("focalX")
    val focalY: ZnValue? = valueOf("focalY")
    val angle: ZnValue? = valueOf("angle")
    val pressed: ZnValue? = valueOf("pressed")
    val held: ZnValue? = valueOf("held")
    /** Where the finger is in the element (dp): for a dial (atan2 of it) or a chart crosshair. */
    val touchX: ZnValue? = valueOf("touchX")
    val touchY: ZnValue? = valueOf("touchY")

    /**
     * After a release that ended on an anchor, the gesture rests there and follows the anchor if it moves (the keyboard
     * opens, the phone turns): a floating video stays above the keyboard with no JS. Ends at the next touch, snapTo,
     * or a JS command to its values.
     */
    private var attached: kotlinx.coroutines.Job? = null

    fun detach() {
        attached?.cancel()
        attached = null
    }

    fun attach(anchorId: String) {
        detach()
        val a = anchors.firstOrNull { it.id == anchorId } ?: return
        val spring = ZnTimingSpec.parse(release.optJSONObject("spring"))
        attached = ZnMotion.scope.launch {
            androidx.compose.runtime.snapshotFlow { anchorPoint(a) }.collect { (ax, ay) ->
                for ((v, to) in listOf(x to ax, y to ay)) {
                    if (v == null || to == null || v.heldBy != null || kotlin.math.abs(v.value - to) < 0.5f) continue
                    v.job?.cancel()
                    v.job = launch { v.animate(to, spring) }
                }
            }
        }
        // A JS command to x or y ends it.
        for (v in listOfNotNull(x, y)) v.onCommand = { detach() }
    }

    val axis: Int = when (o.optString("axis", "xy")) { "x" -> AXIS_X; "y" -> AXIS_Y; else -> AXIS_XY }
    val boundsX: Pair<ZnSpec, ZnSpec>? = boundsOf("x")
    val boundsY: Pair<ZnSpec, ZnSpec>? = boundsOf("y")
    val rubber: Boolean = o.optBoolean("rubber", true)
    val anchors: List<ZnAnchor> = o.optJSONArray("anchors")?.let { a ->
        List(a.length()) { i ->
            val e = a.getJSONObject(i)
            ZnAnchor(e.optString("id", i.toString()), ZnSpec.parse(e.opt("x")), ZnSpec.parse(e.opt("y")))
        }
    } ?: emptyList()
    val magnets: List<ZnMagnet> = o.optJSONArray("magnets")?.let { a ->
        List(a.length()) { i ->
            val e = a.getJSONObject(i)
            ZnMagnet(
                e.getString("id"),
                ZnSpec.parse(e.opt("x")) ?: throw ZnInvalidArgs("magnet needs x"),
                ZnSpec.parse(e.opt("y")) ?: throw ZnInvalidArgs("magnet needs y"),
                e.optDouble("radius", 80.0).toFloat().coerceAtLeast(1f),
                e.optDouble("pull", 0.5).toFloat().coerceIn(0f, 1f),
            )
        }
    } ?: emptyList()
    val release: JSONObject = o.optJSONObject("release") ?: JSONObject()
    val haptic: JSONObject = o.optJSONObject("haptic") ?: JSONObject()
    val crosses: FloatArray = ZnMotion.floats(o.optJSONArray("cross"))
    val withParent: String = o.optString("withParent", "")
    val a11yLabel: String? = o.optString("a11yLabel").takeIf { it.isNotEmpty() }

    // ---- useZoom (kind "zoom"; maths in ZnZoom.kt) ------------------------------------------------------------------------

    val zoomMin: Float = o.optDouble("min", 1.0).toFloat().let { if (it.isFinite() && it > 0f) it else 1f }
    val zoomMax: Float = o.optDouble("max", 4.0).toFloat().let { if (it.isFinite() && it >= zoomMin) it else max(zoomMin, 4f) }
    /** The scale a double tap zooms to (0: a double tap does nothing). */
    val zoomDouble: Float = o.optDouble("doubleTap", 2.5).toFloat().let { if (it.isFinite() && it > 0f) it else 0f }
    /** The content's shape (width / height), fitted inside the element; null or 0: the content fills the element. */
    private val zoomAspect: ZnSpec? = if (o.has("aspect")) ZnSpec.parse(o.opt("aspect")) else null

    /** The content's size (dp) in the element now. */
    fun zoomContent(): Pair<Float, Float> = ZnZoomMath.fitted(selfW, selfH, zoomAspect?.resolve(0f, 0f, site) ?: 0f)

    /** A point of the element (local dp, inside the node's own layer) in its box (not moved by the zoom). */
    fun zoomBox(lx: Float, ly: Float, layer: ZnLayer?): Pair<Float, Float> {
        if (layer == null) return lx to ly
        val sx = layer.scaleX().takeIf { it.isFinite() && it != 0f } ?: 1f
        val sy = layer.scaleY().takeIf { it.isFinite() && it != 0f } ?: 1f
        return ZnZoomMath.toBox(lx, selfW / 2f, sx, layer.translateX()) to ZnZoomMath.toBox(ly, selfH / 2f, sy, layer.translateY())
    }

    /**
     * Moves scale, x and y to ([s], [tx], [ty]) together: one tween for the three, so the point zoomed around stays put
     * on the way. Answers [c] with {finished} at the end.
     */
    /**
     * Animates the zoom to ([s], [tx], [ty]); "settle" when it rests. [sendEnd]: also "end" then (a zoom from JS or a
     * double tap, which have no finger lift); a pinch released past a limit sends its own "end" at the lift.
     */
    fun zoomAnimate(s: Float, tx: Float, ty: Float, spec: ZnTimingSpec = ZOOM_TWEEN, c: ZnCall? = null, sendEnd: Boolean = true) {
        val parts = listOfNotNull(scale?.to(s), x?.to(tx), y?.to(ty))
        ZnMotion.scope.launch {
            var finished = true
            val jobs = parts.map { (v, to) ->
                v.interrupt()
                v.velocity = 0f
                launch { if (!v.animate(to, spec)) finished = false }.also { v.job = it }
            }
            jobs.forEach { it.join() }
            val at = JSONObject().put("scale", (scale?.value ?: 1f).toDouble()).put("x", (x?.value ?: 0f).toDouble())
                .put("y", (y?.value ?: 0f).toDouble())
            if (sendEnd) send("end", JSONObject(at.toString()).put("cancelled", !finished))
            send("settle", at)
            c?.resolve(JSONObject().put("finished", finished))
        }
    }

    /** A double tap at ([bx], [by]) in the box: zoom in there, or back out. */
    fun zoomDoubleTap(bx: Float, by: Float) {
        if (zoomDouble <= 0f) return
        val (cw, ch) = zoomContent()
        val (s, tx, ty) = ZnZoomMath.doubleTap(
            scale?.value ?: 1f, x?.value ?: 0f, y?.value ?: 0f, bx, by, selfW, selfH, cw, ch, zoomMin, zoomDouble.coerceIn(zoomMin, zoomMax),
        )
        zoomAnimate(s, tx, ty)
    }

    /** The touch in progress (a JS command with interruptGesture cancels it). */
    var touch: ZnGestureTouch? = null

    // Links with gestures on other elements (phase 3, D3; RNGH's requireExternalGestureToFail /
    // simultaneousWithExternalGesture / manualActivation).
    /** It starts only once these have failed (or aren't touched); if one starts, this fails. */
    val requireFail: IntArray = ints(o.optJSONArray("fails"))
    /** These may run with it although they are on other elements (neither takes the touch from the other). */
    val simWith: IntArray = ints(o.optJSONArray("with"))
    /** JS decides when it starts: Gesture.activate(g) / Gesture.fail(g) (it still follows the finger once started). */
    val manual: Boolean = o.optBoolean("manual", false)
    var manualWant = ZnGestures.MANUAL_NONE
    /** Its recognizer's state in the touch now (-1: not touched), for the links above. Main thread. */
    var live = -1

    /** Drop zones (phase 3, §2.9): useElementMotion() ids whose boxes the finger may be over; the one it is over. */
    val dropZones: IntArray = ints(o.optJSONArray("zones"))
    var zone = -1
    /** The node's coordinates, to put the finger in the window (drop zones). */
    var coords: androidx.compose.ui.layout.LayoutCoordinates? = null
    /** The node's own size and its parent's (dp), for "%" coordinates. */
    val selfW get() = site.selfW.floatValue
    val selfH get() = site.selfH.floatValue

    private fun ints(a: JSONArray?): IntArray = if (a == null) IntArray(0) else IntArray(a.length()) { a.optInt(it) }

    /**
     * May this gesture start now, as far as gestures on other elements go? null: wait (one it must outlast is still
     * possible); false: it must fail (one it must outlast started).
     */
    fun externalOk(): Boolean? {
        for (id in requireFail) {
            val other = ZnGestures.find(id) ?: continue
            for (leaf in other.leaves) {
                if (leaf.live == 1 || leaf.live == 3) return false // ACTIVE / DONE
                if (leaf.live == 0) return null // POSSIBLE
            }
        }
        return true
    }

    /** The drop zone (index in [dropZones]) at window point ([wx], [wy]) in dp, or -1. */
    fun zoneAt(wx: Float, wy: Float): Int {
        for (i in dropZones.indices) {
            val e = ZnMotion.element(dropZones[i]) ?: continue
            val x = e.value("x")?.value ?: continue
            val y = e.value("y")?.value ?: continue
            val w = e.value("width")?.value ?: continue
            val h = e.value("height")?.value ?: continue
            if (wx >= x && wx <= x + w && wy >= y && wy <= y + h) return i
        }
        return -1
    }

    private fun valueOf(name: String, initial: Float = 0f): ZnValue? {
        val ids = o.optJSONObject("values") ?: return null
        if (!ids.has(name)) return null
        val id = ids.getInt(name)
        return (ZnMotion.find(id) as? ZnValue) ?: ZnMotion.putValue(id, ids.optDouble("$name.v", initial.toDouble()).toFloat())
    }

    private fun boundsOf(axis: String): Pair<ZnSpec, ZnSpec>? {
        val a = o.optJSONObject("bounds")?.optJSONArray(axis) ?: return null
        val lo = ZnSpec.parse(a.opt(0)) ?: return null
        val hi = ZnSpec.parse(a.opt(1)) ?: return null
        return lo to hi
    }

    fun lo(onX: Boolean): Float? = (if (onX) boundsX else boundsY)?.first?.let { resolve(it, onX) }
    fun hi(onX: Boolean): Float? = (if (onX) boundsX else boundsY)?.second?.let { resolve(it, onX) }

    fun resolve(s: ZnSpec, onX: Boolean): Float =
        if (onX) s.resolve(site.selfW.floatValue, site.parentW.floatValue, site)
        else s.resolve(site.selfH.floatValue, site.parentH.floatValue, site)

    /** Every gesture in this one (itself, or a group's members, in order). */
    val leaves: List<ZnGesture> get() = if (kind == GROUP) members.flatMap { it.leaves } else listOf(this)

    fun dispose() {
        touch?.cancel()
        detach()
        if (kind == GROUP) return // members are their own objects (JS disposes them)
        // The values belong to the gesture: JS disposed it, so they go too. (JS holds no other handle on them.)
        for (v in listOfNotNull(x, y, scale, focalX, focalY, angle, pressed, held, touchX, touchY)) ZnMotion.dispose(v.id)
    }

    fun send(type: String, data: JSONObject = JSONObject()) {
        if (type !in events) return
        ZnMotion.sendEvent(data.put("g", id).put("t", type))
    }

    // ---- Release (pan) --------------------------------------------------------------------------------------------------

    /** Where a release ends (dp): the anchor and its point, or null (no anchors: stay, or decay). */
    class Target(val id: String, val x: Float?, val y: Float?)

    fun anchorPoint(a: ZnAnchor): Pair<Float?, Float?> =
        (if (axis != AXIS_Y) a.x?.let { resolve(it, true) } else null) to (if (axis != AXIS_X) a.y?.let { resolve(it, false) } else null)

    /** Chooses where a release at ([px], [py]) with velocity ([vx], [vy]) (dp, dp/s) ends. */
    fun chooseTarget(px: Float, py: Float, vx: Float, vy: Float, startX: Float, startY: Float, density: Density): Target? {
        // Released inside a magnet: it wins.
        for (m in magnets) {
            val cx = resolve(m.x, true)
            val cy = resolve(m.y, false)
            if (hypot(px - cx, py - cy) <= m.radius) return Target(m.id, cx, cy)
        }
        if (anchors.isEmpty()) return null
        val project = release.optBoolean("project", false)
        if (project || axis == AXIS_XY) {
            // Where a fling would stop (the platform's own curve), then the nearest anchor to that point.
            val (tx, ty) = if (project) (px + flingDistance(vx, density)) to (py + flingDistance(vy, density)) else px to py
            return anchors.minByOrNull { a ->
                val (ax, ay) = anchorPoint(a)
                hypot((ax ?: tx) - tx, (ay ?: ty) - ty)
            }?.let { a -> anchorPoint(a).let { (ax, ay) -> Target(a.id, ax, ay) } }
        }
        // One axis: a fast enough flick goes to the next anchor its way; else the nearest one, unless it moved less than
        // threshold.distance from where it started (then back there).
        val onX = axis == AXIS_X
        val pos = if (onX) px else py
        val v = if (onX) vx else vy
        val start = if (onX) startX else startY
        val points = anchors.map { a -> a to (anchorPoint(a).let { if (onX) it.first else it.second } ?: pos) }
        val th = release.optJSONObject("threshold")
        val minV = th?.optDouble("velocity", 400.0)?.toFloat() ?: 400f
        val minD = th?.optDouble("distance", -1.0)?.toFloat() ?: -1f
        val chosen = (if (abs(v) >= minV) {
            val ahead = points.filter { (_, p) -> if (v > 0) p > pos + 0.5f else p < pos - 0.5f }
            ahead.minByOrNull { (_, p) -> abs(p - pos) } ?: points.minByOrNull { (_, p) -> abs(p - pos) }
        } else if (minD >= 0f && abs(pos - start) < minD) {
            points.minByOrNull { (_, p) -> abs(p - start) }
        } else {
            points.minByOrNull { (_, p) -> abs(p - pos) }
        }) ?: return null
        val p = chosen.second
        return Target(chosen.first.id, if (onX) p else null, if (onX) null else p)
    }

    private fun flingDistance(v: Float, density: Density): Float {
        if (v == 0f) return 0f
        val px = splineBasedDecay<Float>(density).calculateTargetValue(0f, v * density.density)
        return px / density.density
    }

    /** Springs (or decays) after a release; calls back with the anchor it went to. */
    fun settle(t: Target?, vx: Float, vy: Float, done: ((String?) -> Unit)? = null) {
        val spring = ZnTimingSpec.parse(release.optJSONObject("spring"))
        val decay = release.optBoolean("decay", false)
        val xv = x
        val yv = y
        ZnMotion.scope.launch {
            val jobs = ArrayList<kotlinx.coroutines.Job>()
            fun go(v: ZnValue?, onX: Boolean, to: Float?, vel: Float) {
                v ?: return
                v.velocity = vel
                val lo = lo(onX)
                val hi = hi(onX)
                val job = launch {
                    when {
                        to != null -> v.animate(to, spring)
                        decay -> {
                            v.decay(vel, znFriction(release.optDouble("deceleration", 0.998)), lo, hi)
                        }
                        else -> {
                            // Rubber-banded past a bound: back inside.
                            val inside = v.value.let { cur -> if (lo != null && cur < lo) lo else if (hi != null && cur > hi) hi else null }
                            if (inside != null) v.animate(inside, spring)
                        }
                    }
                }
                v.job = job
                jobs += job
            }
            go(xv, true, t?.x, vx)
            go(yv, false, t?.y, vy)
            jobs.forEach { it.join() }
            if (t != null && anchors.any { it.id == t.id }) attach(t.id)
            done?.invoke(t?.id)
        }
    }

    /** JS asked to go to an anchor (a failed payment springs the slider back). */
    fun snapTo(anchorId: String, spec: ZnTimingSpec, c: ZnCall) {
        val target = leaves.firstNotNullOfOrNull { g -> g.anchors.firstOrNull { it.id == anchorId }?.let { g to it } }
            ?: leaves.firstNotNullOfOrNull { g -> g.magnets.firstOrNull { it.id == anchorId }?.let { m -> g to ZnAnchor(m.id, m.x, m.y) } }
            ?: throw ZnInvalidArgs("gesture $id has no anchor \"$anchorId\"")
        val (g, a) = target
        g.touch?.cancel()
        g.detach()
        val (ax, ay) = g.anchorPoint(a)
        val values = listOfNotNull(ax?.let { g.x?.to(it) }, ay?.let { g.y?.to(it) })
        if (values.isEmpty()) return c.resolve(JSONObject().put("finished", true))
        ZnMotion.scope.launch {
            var finished = true
            val jobs = values.map { (v, to) ->
                v.interrupt()
                launch { if (!v.animate(to, spec)) finished = false }.also { v.job = it }
            }
            jobs.forEach { it.join() }
            c.resolve(JSONObject().put("finished", finished))
        }
    }

    companion object {
        const val PAN = 1
        const val PINCH = 2
        const val ROTATE = 3
        const val TAP = 4
        const val LONG_PRESS = 5
        const val FLING = 6
        const val GROUP = 7
        const val ZOOM = 8

        /** A zoom moved by a double tap, zoomTo or a release past its limits: the three values in one tween. */
        val ZOOM_TWEEN = ZnTimingSpec(280, 0, null, 1f, 0f, false)

        const val SIMULTANEOUS = 1
        const val EXCLUSIVE = 2
        const val RACE = 3

        const val AXIS_X = 1
        const val AXIS_Y = 2
        const val AXIS_XY = 3

        fun make(id: Int, o: JSONObject): ZnGesture {
            val kind = when (o.optString("kind")) {
                "pan" -> PAN
                "pinch" -> PINCH
                "rotate" -> ROTATE
                "tap" -> TAP
                "longPress" -> LONG_PRESS
                "fling" -> FLING
                "zoom" -> ZOOM
                else -> throw ZnInvalidArgs("unknown gesture kind \"${o.optString("kind")}\"")
            }
            return ZnGesture(id, kind, o, emptyList(), 0).also { g ->
                // Sources JS reads from the gesture: progress along the axis, and each magnet's closeness.
                o.optJSONObject("values")?.let { ids ->
                    if (ids.has("progress")) ZnMotion.putSource(ZnProgressSource(ids.getInt("progress"), g))
                }
                o.optJSONArray("magnets")?.let { a ->
                    for (i in 0 until a.length()) {
                        val e = a.getJSONObject(i)
                        if (e.has("src")) ZnMotion.putSource(ZnMagnetSource(e.getInt("src"), g, g.magnets[i]))
                    }
                }
            }
        }

        fun group(id: Int, mode: Int, members: List<ZnGesture>) = ZnGesture(id, GROUP, JSONObject(), members, mode)

        /** A rubber band: pulling [d] past a bound moves it less and less (iOS's curve), [dim] the scale. */
        fun rubber(d: Float, dim: Float): Float {
            val size = if (dim > 1f) dim else 200f
            return (1f - 1f / (d * 0.55f / size + 1f)) * size
        }
    }
}

/** `pan.progress`: 0 → 1 between the bounds of its axis (x for "x" and "xy", y for "y"). */
internal class ZnProgressSource(id: Int, private val g: ZnGesture) : ZnSource(id) {
    override fun read(site: ZnSite?): Float {
        val onX = g.axis != ZnGesture.AXIS_Y
        val v = (if (onX) g.x else g.y)?.read(site) ?: return 0f
        val lo = g.lo(onX) ?: 0f
        val hi = g.hi(onX) ?: return 0f
        if (hi == lo) return 0f
        return (v - lo) / (hi - lo)
    }
}

/** `pan.magnet(id)`: 0 far away → 1 at the centre. */
internal class ZnMagnetSource(id: Int, private val g: ZnGesture, private val m: ZnMagnet) : ZnSource(id) {
    override fun read(site: ZnSite?): Float {
        val px = g.x?.read(site) ?: 0f
        val py = g.y?.read(site) ?: 0f
        val d = hypot(px - g.resolve(m.x, true), py - g.resolve(m.y, false))
        return (1f - d / m.radius).coerceIn(0f, 1f)
    }
}

/** One touch on a gesture's node (one finger-down to all-up, or longer for multi-tap). */
internal class ZnGestureTouch {
    @Volatile var cancelled = false
        private set

    fun cancel() {
        cancelled = true
    }
}

/** Plays a haptic named in a gesture's options. */
internal fun znHaptic(view: View, kind: String?) {
    val c = when (kind) {
        null, "", "none" -> return
        "light" -> HapticFeedbackConstants.KEYBOARD_TAP
        "medium" -> HapticFeedbackConstants.VIRTUAL_KEY
        "heavy" -> HapticFeedbackConstants.LONG_PRESS
        "selection" -> HapticFeedbackConstants.CLOCK_TICK
        "success" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
        "error" -> if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS
        else -> HapticFeedbackConstants.KEYBOARD_TAP
    }
    view.performHapticFeedback(c)
}

// ---- Recognizers ----------------------------------------------------------------------------------------------------

private const val POSSIBLE = 0
private const val ACTIVE = 1
private const val FAILED = 2
private const val DONE = 3

/** What a recognizer gets with each event: pixels → dp, the layer's scale and turn (local deltas → parent space). */
private class ZnTouchCtx(val density: Density, val view: View, val layer: ZnLayer?, val slopPx: Float) {
    val d get() = density.density

    /** A local delta in px → the parent's dp (undoes this node's own scale and rotation). */
    fun toParent(dx: Float, dy: Float): Offset {
        val l = layer ?: return Offset(dx / d, dy / d)
        val sx = l.scaleX()
        val sy = l.scaleY()
        val r = l.rotate() * (PI / 180.0).toFloat()
        val x = dx * sx
        val y = dy * sy
        val c = kotlin.math.cos(r)
        val s = kotlin.math.sin(r)
        return Offset((x * c - y * s) / d, (x * s + y * c) / d)
    }
}

private abstract class ZnRecognizer(val g: ZnGesture) {
    var state = POSSIBLE
    /** It met its conditions and waits for the arbiter (exclusive: until the ones before it fail). */
    var wants = false
    /** Continuous gestures take the touch once active (the parent scroll stops). */
    open val consumes: Boolean get() = true
    /** Ends when the fingers lift (pan, pinch, rotate, long press); tap and fling are decided at the lift. */
    open val continuous: Boolean get() = true
    /** Uptime ms when it needs [tick], or Long.MAX_VALUE. */
    open fun deadline(): Long = Long.MAX_VALUE
    abstract fun onEvent(e: PointerEvent, ctx: ZnTouchCtx)
    open fun tick(now: Long, ctx: ZnTouchCtx) {}
    /** The arbiter made it active. */
    open fun activate(ctx: ZnTouchCtx) {}
    /** The touch ended (all fingers up) or was cancelled / taken by someone else. */
    open fun finish(ctx: ZnTouchCtx, cancelled: Boolean) {}
    /** Still waiting for more touches (a double tap between its taps). */
    open val waitsForMore: Boolean get() = false

    fun fail() {
        if (state == POSSIBLE) state = FAILED
        wants = false
    }
}

private fun pressedCentroid(e: PointerEvent, previous: Boolean): Offset? {
    var x = 0f
    var y = 0f
    var n = 0
    for (c in e.changes) {
        val down = if (previous) c.previousPressed else c.pressed
        if (!down || !(c.pressed && c.previousPressed)) continue
        val p = if (previous) c.previousPosition else c.position
        x += p.x
        y += p.y
        n++
    }
    return if (n == 0) null else Offset(x / n, y / n)
}

private fun pressedCount(e: PointerEvent) = e.changes.count { it.pressed }

/** Pan (RNGH Pan): x / y follow the finger, with bounds, rubber edges, magnets; releases to anchors or decays. */
private class PanRec(g: ZnGesture, private val downAt: Long) : ZnRecognizer(g) {
    private var tx = 0f // total movement since down (local px), for activation
    private var ty = 0f
    private var rawX = 0f // dp, before bounds / magnets
    private var rawY = 0f
    private var startX = 0f
    private var startY = 0f
    private val vt = VelocityTracker()
    private var trackX = 0f // parent-space dp travelled, for the velocity tracker
    private var trackY = 0f
    private var crossedSide = BooleanArray(g.crosses.size)
    private val longPressMs = g.o.optLong("activateAfterLongPress", 0L)
    private val minPointers = g.o.optInt("minPointers", 1)
    private val maxPointers = g.o.optInt("maxPointers", 10)
    private val minDistDp = g.o.optDouble("minDistance", -1.0).toFloat()

    override fun deadline(): Long = if (longPressMs > 0 && state == POSSIBLE && !wants) downAt + longPressMs else Long.MAX_VALUE

    override fun tick(now: Long, ctx: ZnTouchCtx) {
        if (longPressMs > 0 && state == POSSIBLE && now >= downAt + longPressMs) wants = true
    }

    private fun range(name: String): FloatArray? = g.o.optJSONArray(name)?.let { a -> floatArrayOf(a.optDouble(0, Double.NaN).toFloat(), a.optDouble(1, Double.NaN).toFloat()) }

    private fun outside(r: FloatArray?, v: Float): Boolean = r != null && ((!r[0].isNaN() && v < r[0]) || (!r[1].isNaN() && v > r[1]))

    override fun onEvent(e: PointerEvent, ctx: ZnTouchCtx) {
        val now = pressedCentroid(e, false)
        val before = pressedCentroid(e, true)
        val count = pressedCount(e)
        // The finger's place in the element, also before the pan starts (a dial turns from the first touch).
        e.changes.firstOrNull { it.pressed }?.let { c ->
            g.touchX?.value = c.position.x / ctx.d
            g.touchY?.value = c.position.y / ctx.d
        }
        if (state == POSSIBLE && count > maxPointers) return fail()
        if (now != null && before != null) {
            val dx = now.x - before.x
            val dy = now.y - before.y
            tx += dx
            ty += dy
            if (state == ACTIVE) move(dx, dy, e, ctx)
        }
        if (state != POSSIBLE || wants) return
        if (count < minPointers) return
        val d = ctx.d
        val ax = tx / d
        val ay = ty / d
        val slop = if (minDistDp >= 0f) minDistDp else ctx.slopPx / d
        if (longPressMs > 0) {
            // Long press first: moving before the time is up means it was a scroll or a swipe, not this.
            if (hypot(ax, ay) > slop) fail()
            return
        }
        if (outside(range("failOffsetX"), ax) || outside(range("failOffsetY"), ay)) return fail()
        val activeX = range("activeOffsetX")
        val activeY = range("activeOffsetY")
        if (activeX != null || activeY != null) {
            if (outside(activeX, ax) || outside(activeY, ay)) wants = true
            return
        }
        when (g.axis) {
            ZnGesture.AXIS_X -> if (abs(ax) > slop && abs(ax) > abs(ay)) wants = true else if (abs(ay) > slop) fail()
            ZnGesture.AXIS_Y -> if (abs(ay) > slop && abs(ay) > abs(ax)) wants = true else if (abs(ax) > slop) fail()
            else -> if (hypot(ax, ay) > slop) wants = true
        }
    }

    override fun activate(ctx: ZnTouchCtx) {
        g.detach()
        // The finger takes the values where they are (an animation running on them stops; JS's promise says
        // finished: false). Movement counts from here, so nothing jumps by the touch slop.
        for (v in listOfNotNull(g.x, g.y)) {
            v.interrupt()
            v.heldBy = g.touch
        }
        startX = g.x?.value ?: 0f
        startY = g.y?.value ?: 0f
        rawX = startX
        rawY = startY
        trackX = 0f
        trackY = 0f
        if (longPressMs > 0) znHaptic(ctx.view, g.haptic.optString("longPress", "medium"))
        znHaptic(ctx.view, g.haptic.optString("start"))
        g.send("start", JSONObject().put("x", startX.toDouble()).put("y", startY.toDouble()))
    }

    private fun bounded(raw: Float, onX: Boolean): Float {
        val lo = g.lo(onX)
        val hi = g.hi(onX)
        val dim = if (onX) g.selfW else g.selfH
        return when {
            lo != null && raw < lo -> if (g.rubber) lo - ZnGesture.rubber(lo - raw, dim) else lo
            hi != null && raw > hi -> if (g.rubber) hi + ZnGesture.rubber(raw - hi, dim) else hi
            else -> raw
        }
    }

    private fun move(dx: Float, dy: Float, e: PointerEvent, ctx: ZnTouchCtx) {
        val p = ctx.toParent(dx, dy)
        if (g.axis != ZnGesture.AXIS_Y) rawX += p.x
        if (g.axis != ZnGesture.AXIS_X) rawY += p.y
        trackX += p.x
        trackY += p.y
        vt.addPosition(e.changes.first().uptimeMillis, Offset(trackX, trackY))
        var sx = bounded(rawX, true)
        var sy = bounded(rawY, false)
        // Magnets pull it toward their centre, more the closer it is.
        for (m in g.magnets) {
            val cx = g.resolve(m.x, true)
            val cy = g.resolve(m.y, false)
            val dist = hypot(sx - cx, sy - cy)
            val inside = dist <= m.radius
            if (inside) {
                val s = (1f - dist / m.radius) * m.pull
                sx += (cx - sx) * s
                sy += (cy - sy) * s
            }
            if (inside != m.inside) {
                m.inside = inside
                if (inside) znHaptic(ctx.view, g.haptic.optString("magnet", "light"))
                g.send("magnet", JSONObject().put("id", m.id).put("inside", inside))
            }
        }
        g.x?.value = sx
        g.y?.value = sy
        // Thresholds crossed on the axis (onCross), each way once per crossing.
        val pos = if (g.axis == ZnGesture.AXIS_Y) sy else sx
        g.crosses.forEachIndexed { i, at ->
            val past = pos >= at
            if (past != crossedSide[i]) {
                crossedSide[i] = past
                znHaptic(ctx.view, g.haptic.optString("cross"))
                g.send("cross", JSONObject().put("at", at.toDouble()).put("forward", past))
            }
        }
        if ("update" in g.events) g.send("update", JSONObject().put("x", sx.toDouble()).put("y", sy.toDouble()))
        // Drop zones: which one the finger is over, in the window (the boxes come from useElementMotion).
        if (g.dropZones.isNotEmpty()) {
            val c = e.changes.firstOrNull { it.pressed }
            val coords = g.coords
            if (c != null && coords != null && coords.isAttached) {
                val w = coords.localToWindow(c.position)
                val z = g.zoneAt(w.x / ctx.d, w.y / ctx.d)
                if (z != g.zone) {
                    g.zone = z
                    if (z >= 0) znHaptic(ctx.view, g.haptic.optString("zone", "light"))
                    g.send("zone", JSONObject().put("zone", if (z >= 0) z else JSONObject.NULL))
                }
            }
        }
    }

    init {
        // Which side of each threshold it starts on.
        val pos = if (g.axis == ZnGesture.AXIS_Y) g.y?.value ?: 0f else g.x?.value ?: 0f
        crossedSide = BooleanArray(g.crosses.size) { pos >= g.crosses[it] }
    }

    override fun finish(ctx: ZnTouchCtx, cancelled: Boolean) {
        for (v in listOfNotNull(g.x, g.y)) if (v.heldBy === g.touch) v.heldBy = null
        if (state != ACTIVE) return
        state = DONE
        val vel = vt.calculateVelocity()
        val vx = if (g.axis == ZnGesture.AXIS_Y) 0f else vel.x
        val vy = if (g.axis == ZnGesture.AXIS_X) 0f else vel.y
        val px = g.x?.value ?: 0f
        val py = g.y?.value ?: 0f
        for (m in g.magnets) m.inside = false
        if (cancelled) {
            g.send("end", JSONObject().put("x", px.toDouble()).put("y", py.toDouble()).put("cancelled", true))
            g.send("finalize")
            return
        }
        val target = g.chooseTarget(px, py, vx, vy, startX, startY, ctx.density)
        if (target != null) znHaptic(ctx.view, g.haptic.optString("snap"))
        val end = JSONObject().put("x", px.toDouble()).put("y", py.toDouble()).put("vx", vx.toDouble()).put("vy", vy.toDouble())
            .put("cancelled", false)
        if (g.dropZones.isNotEmpty()) end.put("zone", if (g.zone >= 0) g.zone else JSONObject.NULL)
        target?.let { t ->
            end.put("anchor", t.id)
            t.x?.let { end.put("toX", it.toDouble()) }
            t.y?.let { end.put("toY", it.toDouble()) }
        }
        g.send("end", end)
        g.settle(target, vx, vy) { anchor -> g.send("settle", JSONObject().put("anchor", anchor ?: JSONObject.NULL)) }
        g.send("finalize")
    }

}

/** Pinch (RNGH Pinch): scale from the finger spread, focal point; springs back inside min / max on release. */
private class PinchRec(g: ZnGesture) : ZnRecognizer(g) {
    private var dist0 = 0f
    private var s0 = 1f
    private val min = g.o.optDouble("min", 0.0).toFloat()
    private val max = g.o.optDouble("max", Double.MAX_VALUE).toFloat()

    private fun spread(e: PointerEvent): Float? {
        val p = e.changes.filter { it.pressed }
        if (p.size < 2) return null
        return hypot(p[0].position.x - p[1].position.x, p[0].position.y - p[1].position.y)
    }

    override fun onEvent(e: PointerEvent, ctx: ZnTouchCtx) {
        val d = spread(e)
        if (d == null) {
            dist0 = 0f
            return
        }
        if (dist0 == 0f) {
            dist0 = d
            s0 = g.scale?.value ?: 1f
            return
        }
        if (state == POSSIBLE && !wants && abs(d - dist0) > ctx.slopPx) wants = true
        if (state != ACTIVE) return
        var s = s0 * d / dist0
        if (s < min) s = min - ZnGesture.rubber(min - s, 1f) * 0.5f
        if (s > max) s = max + ZnGesture.rubber(s - max, max) * 0.5f
        g.scale?.value = s
        val p = e.changes.filter { it.pressed }
        g.focalX?.value = (p[0].position.x + p[1].position.x) / 2f / ctx.d
        g.focalY?.value = (p[0].position.y + p[1].position.y) / 2f / ctx.d
        if ("update" in g.events) g.send("update", JSONObject().put("scale", s.toDouble()))
    }

    override fun activate(ctx: ZnTouchCtx) {
        g.scale?.let {
            it.interrupt()
            it.heldBy = g.touch
            s0 = it.value
        }
        dist0 = spread(lastEvent ?: return) ?: dist0
        g.send("start")
    }

    var lastEvent: PointerEvent? = null

    override fun finish(ctx: ZnTouchCtx, cancelled: Boolean) {
        g.scale?.let { if (it.heldBy === g.touch) it.heldBy = null }
        if (state != ACTIVE) return
        state = DONE
        val s = g.scale?.value ?: 1f
        g.send("end", JSONObject().put("scale", s.toDouble()).put("cancelled", cancelled))
        val back = if (s < min) min else if (s > max) max else null
        if (back != null) g.scale?.let { v -> ZnMotion.scope.launch { v.animate(back, ZnTimingSpec.SPRING) }.also { v.job = it } }
        g.send("finalize")
    }
}

/** Rotation (RNGH Rotation): degrees the two fingers turned. */
private class RotateRec(g: ZnGesture) : ZnRecognizer(g) {
    private var a0 = Float.NaN
    private var v0 = 0f

    private fun angleOf(e: PointerEvent): Float? {
        val p = e.changes.filter { it.pressed }
        if (p.size < 2) return null
        return (atan2(p[1].position.y - p[0].position.y, p[1].position.x - p[0].position.x) * 180.0 / PI).toFloat()
    }

    override fun onEvent(e: PointerEvent, ctx: ZnTouchCtx) {
        val a = angleOf(e)
        if (a == null) {
            a0 = Float.NaN
            return
        }
        if (a0.isNaN()) {
            a0 = a
            v0 = g.angle?.value ?: 0f
            return
        }
        var delta = a - a0
        while (delta > 180f) delta -= 360f
        while (delta < -180f) delta += 360f
        if (state == POSSIBLE && !wants && abs(delta) > 4f) wants = true
        if (state != ACTIVE) return
        g.angle?.value = v0 + delta
        if ("update" in g.events) g.send("update", JSONObject().put("angle", (v0 + delta).toDouble()))
    }

    override fun activate(ctx: ZnTouchCtx) {
        g.angle?.let {
            it.interrupt()
            it.heldBy = g.touch
        }
        g.send("start")
    }

    override fun finish(ctx: ZnTouchCtx, cancelled: Boolean) {
        g.angle?.let { if (it.heldBy === g.touch) it.heldBy = null }
        if (state != ACTIVE) return
        state = DONE
        g.send("end", JSONObject().put("angle", (g.angle?.value ?: 0f).toDouble()).put("cancelled", cancelled))
        g.send("finalize")
    }
}

/** Tap (RNGH Tap): [taps] taps, each short and still, close enough in time. Discrete: fires once, at the last up. */
private class TapRec(g: ZnGesture) : ZnRecognizer(g) {
    private val taps = g.o.optInt("taps", 1).coerceAtLeast(1)
    private val maxDuration = g.o.optLong("maxDuration", 500L)
    private val maxDelay = g.o.optLong("maxDelay", 300L)
    private val maxDistDp = g.o.optDouble("maxDistance", -1.0).toFloat()
    private var count = 0
    private var downAt = 0L
    private var upAt = 0L
    private var moved = 0f
    private var down = false
    private var x = 0f
    private var y = 0f

    override val consumes: Boolean get() = false
    override val continuous: Boolean get() = false
    override val waitsForMore: Boolean get() = state == POSSIBLE && !down && count in 1 until taps

    override fun deadline(): Long = when {
        state != POSSIBLE || wants -> Long.MAX_VALUE
        down -> downAt + maxDuration
        count > 0 -> upAt + maxDelay
        else -> Long.MAX_VALUE
    }

    override fun tick(now: Long, ctx: ZnTouchCtx) {
        if (now >= deadline()) {
            press(false)
            fail()
        }
    }

    private fun press(on: Boolean) {
        val p = g.pressed ?: return
        p.interrupt()
        p.job = ZnMotion.scope.launch { p.animate(if (on) 1f else 0f, ZnTimingSpec(-1, 0, null, 1f, 1500f, false)) }
    }

    override fun onEvent(e: PointerEvent, ctx: ZnTouchCtx) {
        if (state != POSSIBLE || wants) return
        val c = e.changes.firstOrNull() ?: return
        if (e.changes.count { it.pressed } > 1) {
            press(false)
            return fail()
        }
        if (c.pressed && !c.previousPressed) {
            down = true
            downAt = c.uptimeMillis
            moved = 0f
            x = c.position.x / ctx.d
            y = c.position.y / ctx.d
            press(true)
        } else if (c.pressed) {
            moved += hypot(c.position.x - c.previousPosition.x, c.position.y - c.previousPosition.y)
            val limit = if (maxDistDp >= 0f) maxDistDp * ctx.d else ctx.slopPx
            if (moved > limit) {
                press(false)
                fail()
            }
        } else if (c.previousPressed) {
            down = false
            upAt = c.uptimeMillis
            press(false)
            if (upAt - downAt > maxDuration) return fail()
            count++
            if (count >= taps) wants = true
        }
    }

    /** useZoom's own double tap: the zoom gesture it moves (0: none). */
    private val zoomId = g.o.optInt("zoom", 0)

    override fun activate(ctx: ZnTouchCtx) {
        state = DONE
        znHaptic(ctx.view, g.haptic.optString("start"))
        if (zoomId != 0) ZnGestures.find(zoomId)?.let { z ->
            val (bx, by) = z.zoomBox(x, y, ctx.layer)
            z.zoomDoubleTap(bx, by)
        }
        g.send("end", JSONObject().put("x", x.toDouble()).put("y", y.toDouble()).put("cancelled", false))
        g.send("finalize")
    }

    override fun finish(ctx: ZnTouchCtx, cancelled: Boolean) {
        if (state == POSSIBLE && down) press(false)
    }
}

/** Long press (RNGH LongPress): held still for [minDuration]; `held` goes 0 → 1 meanwhile, `pressed` while down. */
private class LongPressRec(g: ZnGesture, private val downAt: Long) : ZnRecognizer(g) {
    private val minDuration = g.o.optLong("minDuration", 500L)
    private val maxDistDp = g.o.optDouble("maxDistance", -1.0).toFloat()
    private var moved = 0f
    private var started = false

    override fun deadline(): Long = if (state == POSSIBLE && !wants) downAt + minDuration else Long.MAX_VALUE

    override fun tick(now: Long, ctx: ZnTouchCtx) {
        if (state == POSSIBLE && now >= downAt + minDuration) wants = true
    }

    private fun begin() {
        if (started) return
        started = true
        g.pressed?.let { p -> p.interrupt(); p.job = ZnMotion.scope.launch { p.animate(1f, ZnTimingSpec(-1, 0, null, 1f, 1500f, false)) } }
        g.held?.let { h -> h.interrupt(); h.value = 0f; h.job = ZnMotion.scope.launch { h.animate(1f, ZnTimingSpec(minDuration.toInt(), 3, null, 1f, 0f, false)) } }
        g.send("begin")
    }

    private fun release() {
        g.pressed?.let { p -> p.interrupt(); p.job = ZnMotion.scope.launch { p.animate(0f, ZnTimingSpec(-1, 0, null, 0.8f, 800f, false)) } }
        g.held?.let { h -> h.interrupt(); if (state != ACTIVE) h.job = ZnMotion.scope.launch { h.animate(0f, ZnTimingSpec(150, 0, null, 1f, 0f, false)) } }
    }

    override fun onEvent(e: PointerEvent, ctx: ZnTouchCtx) {
        begin()
        if (state != POSSIBLE || wants) return
        for (c in e.changes) if (c.pressed && c.previousPressed) moved += hypot(c.position.x - c.previousPosition.x, c.position.y - c.previousPosition.y)
        val limit = if (maxDistDp >= 0f) maxDistDp * ctx.d else ctx.slopPx
        if (moved > limit || e.changes.none { it.pressed }) {
            release()
            fail()
        }
    }

    override fun activate(ctx: ZnTouchCtx) {
        znHaptic(ctx.view, g.haptic.optString("start", "heavy"))
        g.send("start")
    }

    override fun finish(ctx: ZnTouchCtx, cancelled: Boolean) {
        release()
        if (state != ACTIVE) return
        state = DONE
        g.send("end", JSONObject().put("cancelled", cancelled))
        g.send("finalize")
    }
}

/** Fling (RNGH Fling): a quick swipe in one of [directions]; fires once at the up. */
private class FlingRec(g: ZnGesture) : ZnRecognizer(g) {
    private val vt = VelocityTracker()
    private val dirs = g.o.optJSONArray("directions")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: setOf("left", "right", "up", "down")
    private val minVelocity = g.o.optDouble("minVelocity", 800.0).toFloat()
    private var dir: String? = null

    override val consumes: Boolean get() = false
    override val continuous: Boolean get() = false

    override fun onEvent(e: PointerEvent, ctx: ZnTouchCtx) {
        if (state != POSSIBLE || wants) return
        val c = e.changes.firstOrNull() ?: return
        vt.addPosition(c.uptimeMillis, Offset(c.position.x / ctx.d, c.position.y / ctx.d))
        if (!c.pressed && c.previousPressed) {
            val v = vt.calculateVelocity()
            val horizontal = abs(v.x) > abs(v.y)
            val d = if (horizontal) (if (v.x > 0) "right" else "left") else (if (v.y > 0) "down" else "up")
            val speed = if (horizontal) abs(v.x) else abs(v.y)
            if (speed >= minVelocity && d in dirs) {
                dir = d
                wants = true
            } else fail()
        }
    }

    override fun activate(ctx: ZnTouchCtx) {
        state = DONE
        g.send("end", JSONObject().put("direction", dir).put("cancelled", false))
        g.send("finalize")
    }
}

/**
 * useZoom: pinch around the fingers, drag inside the content's edges, fling that stops at the edges, rubber bands.
 * Works in the element's box (ZnZoom.kt), so the fingers stay on the same spot of the picture.
 * Leaves the touch to the parent (a Carousel turns the page, a pan drags the screen down) when one finger drags and the
 * content is not zoomed, or when it drags sideways toward an edge the zoomed content already touches.
 */
private class ZoomRec(g: ZnGesture) : ZnRecognizer(g) {
    private var rawS = 1f // before the rubber band
    private var rawX = 0f
    private var rawY = 0f
    private var movedX = 0f // dp, before it starts
    private var movedY = 0f
    private var spreadMoved = 0f
    private var lastQx = 0f // the fingers' centre in the box, dp
    private var lastQy = 0f
    private var lastCount = 0
    private val vt = VelocityTracker()

    override fun onEvent(e: PointerEvent, ctx: ZnTouchCtx) {
        val w = g.selfW
        val h = g.selfH
        // Pointers down in both this event and the one before (one that just landed or lifted moves nothing).
        var n = 0
        var x0 = 0f; var y0 = 0f; var x1 = 0f; var y1 = 0f
        var ax0 = 0f; var ay0 = 0f; var ax1 = 0f; var ay1 = 0f // the first two, for the spread
        var bx0 = 0f; var by0 = 0f; var bx1 = 0f; var by1 = 0f
        for (c in e.changes) {
            if (!(c.pressed && c.previousPressed)) continue
            val (px0, py0) = g.zoomBox(c.previousPosition.x / ctx.d, c.previousPosition.y / ctx.d, ctx.layer)
            val (px1, py1) = g.zoomBox(c.position.x / ctx.d, c.position.y / ctx.d, ctx.layer)
            if (n == 0) { ax0 = px0; ay0 = py0; ax1 = px1; ay1 = py1 }
            if (n == 1) { bx0 = px0; by0 = py0; bx1 = px1; by1 = py1 }
            x0 += px0; y0 += py0; x1 += px1; y1 += py1
            n++
        }
        if (n == 0) return
        x0 /= n; y0 /= n; x1 /= n; y1 /= n
        val k = if (n >= 2) {
            val d0 = hypot(ax0 - bx0, ay0 - by0)
            val d1 = hypot(ax1 - bx1, ay1 - by1)
            spreadMoved += abs(d1 - d0)
            if (d0 > 1f) d1 / d0 else 1f
        } else 1f
        if (state == POSSIBLE) {
            if (wants) return
            movedX += x1 - x0
            movedY += y1 - y0
            val slop = ctx.slopPx / ctx.d
            if (n >= 2) {
                if (spreadMoved > slop || hypot(movedX, movedY) > slop) wants = true
                return
            }
            if (hypot(movedX, movedY) <= slop) return
            val s = g.scale?.value ?: 1f
            // Not zoomed: one finger belongs to the parent (next photo, drag down to close).
            if (s <= g.zoomMin * 1.01f) return fail()
            // Zoomed, at the edge it drags toward: the parent turns the page.
            if (abs(movedX) > abs(movedY)) {
                val r = ZnZoomMath.range(g.zoomContent().first, s, w)
                val t = g.x?.value ?: 0f
                if ((movedX > 0f && t >= r - 0.5f) || (movedX < 0f && t <= -r + 0.5f)) return fail()
            }
            wants = true
            return
        }
        if (state != ACTIVE) return
        if (n != lastCount) {
            // A finger landed or lifted: the speed so far was a pinch, not a drag.
            vt.resetTracking()
            lastCount = n
        }
        val nS = rawS * k
        rawX = ZnZoomMath.around(rawS, rawX, x0, w / 2f, nS) + (x1 - x0)
        rawY = ZnZoomMath.around(rawS, rawY, y0, h / 2f, nS) + (y1 - y0)
        rawS = nS
        lastQx = x1
        lastQy = y1
        val s = if (g.rubber) ZnZoomMath.rubberS(rawS, g.zoomMin, g.zoomMax) else rawS.coerceIn(g.zoomMin, g.zoomMax)
        val (cw, ch) = g.zoomContent()
        val rx = ZnZoomMath.range(cw, s, w)
        val ry = ZnZoomMath.range(ch, s, h)
        val tx = if (g.rubber) ZnZoomMath.rubberT(rawX, rx, w) else ZnZoomMath.clamp(rawX, rx)
        val ty = if (g.rubber) ZnZoomMath.rubberT(rawY, ry, h) else ZnZoomMath.clamp(rawY, ry)
        g.scale?.value = s
        g.x?.value = tx
        g.y?.value = ty
        vt.addPosition(e.changes.first().uptimeMillis, Offset(tx, ty))
        if ("update" in g.events) g.send("update", JSONObject().put("scale", s.toDouble()).put("x", tx.toDouble()).put("y", ty.toDouble()))
    }

    override fun activate(ctx: ZnTouchCtx) {
        for (v in listOfNotNull(g.scale, g.x, g.y)) {
            v.interrupt()
            v.heldBy = g.touch
        }
        rawS = g.scale?.value ?: 1f
        rawX = g.x?.value ?: 0f
        rawY = g.y?.value ?: 0f
        lastQx = g.selfW / 2f
        lastQy = g.selfH / 2f
        lastCount = 0
        vt.resetTracking()
        g.send("start", JSONObject().put("scale", rawS.toDouble()))
    }

    override fun finish(ctx: ZnTouchCtx, cancelled: Boolean) {
        for (v in listOfNotNull(g.scale, g.x, g.y)) if (v.heldBy === g.touch) v.heldBy = null
        if (state != ACTIVE) return
        state = DONE
        val w = g.selfW
        val h = g.selfH
        val s = g.scale?.value ?: 1f
        val tx = g.x?.value ?: 0f
        val ty = g.y?.value ?: 0f
        val (cw, ch) = g.zoomContent()
        val inS = s.coerceIn(g.zoomMin, g.zoomMax)
        if (inS != s || cancelled) {
            // Pinched past a limit: back inside it, around where the fingers were, and inside the edges.
            val (ns, nx, ny) = ZnZoomMath.zoomTo(s, tx, ty, lastQx, lastQy, w, h, cw, ch, inS)
            // "end" now, at the lift, with the real flag (as the other branch); "settle" when it is back inside.
            g.send("end", JSONObject().put("scale", s.toDouble()).put("x", tx.toDouble()).put("y", ty.toDouble()).put("cancelled", cancelled))
            g.zoomAnimate(ns, nx, ny, sendEnd = false)
        } else {
            val vel = if (lastCount <= 1) vt.calculateVelocity() else Velocity.Zero
            val zoomed = s > g.zoomMin * 1.01f
            val friction = znFriction(g.release.optDouble("deceleration", 0.998))
            val spring = ZnTimingSpec.parse(g.release.optJSONObject("spring"))
            ZnMotion.scope.launch {
                val jobs = ArrayList<kotlinx.coroutines.Job>()
                fun go(v: ZnValue?, t: Float, r: Float, speed: Float) {
                    v ?: return
                    val inside = ZnZoomMath.clamp(t, r)
                    val job = launch {
                        when {
                            // Past an edge (the rubber band), or not zoomed: back inside.
                            inside != t || !zoomed -> { v.velocity = 0f; v.animate(if (zoomed) inside else 0f, spring) }
                            // A fling: slows down and stops at the edge.
                            abs(speed) > 50f -> v.decay(speed, friction, -r, r)
                        }
                    }
                    v.job = job
                    jobs += job
                }
                go(g.x, tx, ZnZoomMath.range(cw, s, w), vel.x)
                go(g.y, ty, ZnZoomMath.range(ch, s, h), vel.y)
                jobs.forEach { it.join() }
                g.send("settle", JSONObject().put("scale", (g.scale?.value ?: 1f).toDouble()).put("x", (g.x?.value ?: 0f).toDouble())
                    .put("y", (g.y?.value ?: 0f).toDouble()))
            }
            g.send("end", JSONObject().put("scale", s.toDouble()).put("x", tx.toDouble()).put("y", ty.toDouble()).put("cancelled", cancelled))
        }
        g.send("finalize")
    }
}

private fun recognizerFor(g: ZnGesture, downAt: Long): ZnRecognizer = when (g.kind) {
    ZnGesture.PAN -> PanRec(g, downAt)
    ZnGesture.PINCH -> PinchRec(g)
    ZnGesture.ROTATE -> RotateRec(g)
    ZnGesture.TAP -> TapRec(g)
    ZnGesture.LONG_PRESS -> LongPressRec(g, downAt)
    ZnGesture.ZOOM -> ZoomRec(g)
    else -> FlingRec(g)
}

/**
 * The arbiter for one node: which recognizers may become active (docs §2.3 composition). A plain gesture is a group
 * of one. Groups nest: simultaneous inside exclusive, and so on; each level applies its own rule.
 */
private class ZnArbiter(root: ZnGesture, downAt: Long) {
    private class Node(val g: ZnGesture, val rec: ZnRecognizer?, val kids: List<Node>)

    private val tree: Node = build(root, downAt)
    val recs: List<ZnRecognizer> = flatten(tree)

    private fun build(g: ZnGesture, downAt: Long): Node =
        if (g.kind == ZnGesture.GROUP) Node(g, null, g.members.map { build(it, downAt) }) else Node(g, recognizerFor(g, downAt), emptyList())

    private fun flatten(n: Node): List<ZnRecognizer> = n.rec?.let { listOf(it) } ?: n.kids.flatMap { flatten(it) }

    /** Activates whoever may; returns those activated now. */
    fun resolve(): List<ZnRecognizer> {
        val out = ArrayList<ZnRecognizer>()
        resolve(tree, out)
        return out
    }

    private fun states(n: Node): List<ZnRecognizer> = flatten(n)
    private fun failed(n: Node) = states(n).all { it.state == FAILED }
    private fun active(n: Node) = states(n).any { it.state == ACTIVE || it.state == DONE }

    private fun failAll(n: Node) = states(n).forEach { if (it.state == POSSIBLE) it.fail() }

    private fun resolve(n: Node, out: MutableList<ZnRecognizer>) {
        val r = n.rec
        if (r != null) {
            if (n.g.manual && r.state == POSSIBLE) {
                // JS decides: its own conditions don't start it.
                when (n.g.manualWant) {
                    ZnGestures.MANUAL_ACTIVATE -> r.wants = true
                    ZnGestures.MANUAL_FAIL -> { r.fail(); return }
                    else -> r.wants = false
                }
            }
            if (r.wants && r.state == POSSIBLE) {
                when (n.g.externalOk()) {
                    false -> { r.fail(); return }
                    null -> return // waits for the other element's gesture to fail
                    true -> Unit
                }
            }
            if (r.wants && r.state == POSSIBLE) {
                r.state = ACTIVE
                r.wants = false
                out += r
            }
            return
        }
        when (n.g.mode) {
            ZnGesture.SIMULTANEOUS -> n.kids.forEach { resolve(it, out) }
            ZnGesture.RACE -> {
                val winner = n.kids.firstOrNull { active(it) } ?: n.kids.firstOrNull { k -> states(k).any { it.wants } }
                if (winner != null) {
                    resolve(winner, out)
                    n.kids.filter { it !== winner }.forEach { failAll(it) }
                }
            }
            ZnGesture.EXCLUSIVE -> {
                // In order: one may start only when every one before it has failed.
                for (k in n.kids) {
                    if (active(k)) {
                        n.kids.filter { it !== k }.forEach { failAll(it) }
                        return
                    }
                    if (states(k).any { it.wants }) {
                        resolve(k, out)
                        if (active(k)) n.kids.filter { it !== k }.forEach { failAll(it) }
                        return
                    }
                    if (!failed(k)) return
                }
            }
        }
    }
}

/**
 * The modifier for a node with `gesture={g}`: its size for "%" coordinates, the pointer handling, the Back-edge
 * exclusion for horizontal drags, nested scroll for "after-edge", and TalkBack actions. Placed inside the node's
 * graphicsLayer, so the touch area moves with the node.
 */
internal fun Modifier.znGesture(g: ZnGesture, view: View, layer: ZnLayer?): Modifier {
    var m = this.onPlaced { c ->
        g.coords = c
        for (leaf in g.leaves) leaf.coords = c
        val d = view.resources.displayMetrics.density
        val parent = c.parentLayoutCoordinates?.size
        g.site.update(c.size.width / d, c.size.height / d, (parent?.width ?: 0) / d, (parent?.height ?: 0) / d)
        for (leaf in g.leaves) if (leaf !== g) leaf.site.update(c.size.width / d, c.size.height / d, (parent?.width ?: 0) / d, (parent?.height ?: 0) / d)
    }
    val leaves = g.leaves
    // Android 10+ gives Back the screen edges; a horizontal drag near one would go Back instead. Android honours at most
    // 200 dp of exclusion per edge (Argon), so: the whole node when it is short, else a 200 dp band at its centre.
    if (Build.VERSION.SDK_INT >= 29 && leaves.any { it.kind == ZnGesture.PAN && it.axis != ZnGesture.AXIS_Y }) {
        m = m.systemGestureExclusion { c ->
            val h = c.size.height.toFloat()
            val band = 200f * view.resources.displayMetrics.density
            if (h <= band) Rect(0f, 0f, c.size.width.toFloat(), h)
            else Rect(0f, (h - band) / 2f, c.size.width.toFloat(), (h + band) / 2f)
        }
    }
    // An inner list's drag moves this pan when the list is at its edge (a sheet with a list in it).
    leaves.firstOrNull { it.kind == ZnGesture.PAN && it.withParent == "after-edge" && it.axis == ZnGesture.AXIS_Y }?.let { pan ->
        m = m.nestedScroll(ZnNestedPan(pan, view))
    }
    val pass = if (leaves.any { it.withParent == "block" }) PointerEventPass.Initial else PointerEventPass.Main
    val shareTouch = leaves.any { it.withParent == "simultaneous" }
    m = m.pointerInput(g) {
        val ctx = ZnTouchCtx(this, view, layer, viewConfiguration.touchSlop)
        awaitPointerEventScope {
            while (true) {
                // A new touch: wait for a finger down.
                var e = awaitPointerEvent(pass)
                val first = e.changes.firstOrNull { it.pressed && !it.previousPressed } ?: continue
                val touch = ZnGestureTouch()
                for (leaf in leaves) {
                    leaf.touch = touch
                    leaf.manualWant = ZnGestures.MANUAL_NONE
                    leaf.zone = -1
                }
                val arbiter = ZnArbiter(g, first.uptimeMillis)
                leaves.forEach { it.send("begin") }
                var takenByOther = false
                while (true) {
                    if (touch.cancelled) break
                    // Someone else (a scroll, a child) used this event before us: we lose the touch.
                    val anyActive = arbiter.recs.any { it.state == ACTIVE }
                    // A gesture on another element linked by simultaneousWith took it: we keep going too.
                    val partnerActive = leaves.any { leaf -> ZnGestures.live().any { o -> o !== leaf && (o.live == ACTIVE) && ZnGestures.simultaneous(leaf, o) } }
                    if (!anyActive && !partnerActive && e.changes.any { it.isConsumed } && arbiter.recs.any { it.consumes && it.state == POSSIBLE }) {
                        arbiter.recs.filter { it.consumes }.forEach { it.fail() }
                        if (arbiter.recs.all { it.state == FAILED }) {
                            takenByOther = true
                            break
                        }
                    }
                    for (r in arbiter.recs) {
                        if (r is PinchRec) r.lastEvent = e
                        if (r.state == POSSIBLE || r.state == ACTIVE) r.onEvent(e, ctx)
                    }
                    for (r in arbiter.resolve()) r.activate(ctx)
                    for (r in arbiter.recs) r.g.live = r.state
                    // Don't take the touch from a linked gesture (simultaneousWith) that is in it too.
                    val partnerTouched = leaves.any { leaf -> ZnGestures.live().any { o -> o !== leaf && o.live >= 0 && o.live != FAILED && ZnGestures.simultaneous(leaf, o) } }
                    if (!shareTouch && !partnerTouched && arbiter.recs.any { it.state == ACTIVE && it.consumes }) e.changes.forEach { it.consume() }
                    if (e.changes.none { it.pressed }) {
                        // All fingers up: continuous gestures end (release, snap, decay); discrete ones may fire now,
                        // or wait (a double tap between its taps, a single tap behind it in an exclusive group).
                        for (r in arbiter.recs) if (r.continuous) {
                            if (r.state == ACTIVE) r.finish(ctx, false) else if (r.state == POSSIBLE && !r.wants) r.fail()
                        }
                        for (r in arbiter.resolve()) r.activate(ctx)
                        if (arbiter.recs.none { it.state == POSSIBLE && (it.wants || it.waitsForMore) }) break
                    }
                    // Wait for the next event, or the first deadline (long press time, double-tap gap).
                    var got: PointerEvent? = null
                    while (got == null) {
                        // A gesture waiting for JS (manualActivation) or for another element's gesture checks each frame.
                        val polls = arbiter.recs.any { it.state == POSSIBLE && (it.g.manual || it.g.requireFail.isNotEmpty()) }
                        val next = minOf(
                            arbiter.recs.filter { it.state == POSSIBLE }.minOfOrNull { it.deadline() } ?: Long.MAX_VALUE,
                            if (polls) SystemClock.uptimeMillis() + 16 else Long.MAX_VALUE,
                        )
                        val wait = next - SystemClock.uptimeMillis()
                        got = when {
                            next == Long.MAX_VALUE -> awaitPointerEvent(pass)
                            wait <= 0 -> null
                            else -> withTimeoutOrNull(wait) { awaitPointerEvent(pass) }
                        }
                        if (got != null) break
                        val now = SystemClock.uptimeMillis()
                        arbiter.recs.forEach { if (it.state == POSSIBLE) it.tick(now, ctx) }
                        for (r in arbiter.resolve()) r.activate(ctx)
                        for (r in arbiter.recs) r.g.live = r.state
                        if (arbiter.recs.none { it.state == ACTIVE || it.state == POSSIBLE }) break
                        if (touch.cancelled) break
                    }
                    e = got ?: break
                }
                val cancelled = touch.cancelled || takenByOther
                for (r in arbiter.recs) if (r.state == ACTIVE || r.state == POSSIBLE) r.finish(ctx, cancelled)
                for (leaf in leaves) {
                    if (leaf.touch === touch) leaf.touch = null
                    leaf.live = -1
                }
            }
        }
    }
    // TalkBack: each anchor is an action ("Slide to pay ₹499: paid"); a tap gesture is a click.
    val actions = leaves.filter { it.a11yLabel != null }
    if (actions.isNotEmpty()) {
        m = m.semantics {
            val list = ArrayList<CustomAccessibilityAction>()
            for (leaf in actions) {
                if (leaf.kind == ZnGesture.TAP) {
                    onClick(leaf.a11yLabel) {
                        leaf.send("end", JSONObject().put("cancelled", false).put("accessibility", true))
                        true
                    }
                }
                if (leaf.kind == ZnGesture.ZOOM) {
                    // useZoom: zoom in at the centre, and back out (TalkBack users can't pinch).
                    val names = leaf.o.optJSONObject("a11yActions")
                    list += CustomAccessibilityAction(names?.optString("zoomIn")?.takeIf { it.isNotEmpty() } ?: "${leaf.a11yLabel}: zoom in") {
                        val (cw, ch) = leaf.zoomContent()
                        val to = (if (leaf.zoomDouble > 0f) leaf.zoomDouble else leaf.zoomMax).coerceIn(leaf.zoomMin, leaf.zoomMax)
                        val (s, tx, ty) = ZnZoomMath.zoomTo(leaf.scale?.value ?: 1f, leaf.x?.value ?: 0f, leaf.y?.value ?: 0f,
                            leaf.selfW / 2f, leaf.selfH / 2f, leaf.selfW, leaf.selfH, cw, ch, to)
                        leaf.zoomAnimate(s, tx, ty)
                        true
                    }
                    list += CustomAccessibilityAction(names?.optString("zoomOut")?.takeIf { it.isNotEmpty() } ?: "${leaf.a11yLabel}: zoom out") {
                        leaf.zoomAnimate(leaf.zoomMin, 0f, 0f)
                        true
                    }
                }
                for (a in leaf.anchors) {
                    val label = leaf.o.optJSONObject("a11yActions")?.optString(a.id)?.takeIf { it.isNotEmpty() } ?: "${leaf.a11yLabel}: ${a.id}"
                    list += CustomAccessibilityAction(label) {
                        val (ax, ay) = leaf.anchorPoint(a)
                        leaf.settle(ZnGesture.Target(a.id, ax, ay), 0f, 0f)
                        leaf.send("end", JSONObject().put("anchor", a.id).put("cancelled", false).put("accessibility", true))
                        true
                    }
                }
            }
            if (list.isNotEmpty()) customActions = list
        }
    }
    return m
}

/** Keeps [site] at the node's size and its parent's (dp), for `self` / `parent` in formulas bound on the node. */
internal fun Modifier.znSite(site: ZnSite, view: View): Modifier = onPlaced { c ->
    val d = view.resources.displayMetrics.density
    val parent = c.parentLayoutCoordinates?.size
    site.update(c.size.width / d, c.size.height / d, (parent?.width ?: 0) / d, (parent?.height ?: 0) / d)
}

/** withParent "after-edge" on a vertical pan: a list inside drags the pan first up to its top bound, then itself. */
private class ZnNestedPan(private val g: ZnGesture, private val view: View) : NestedScrollConnection {
    private var moving = false
    private val d get() = view.resources.displayMetrics.density
    private val vt = VelocityTracker()

    private fun nested(dyPx: Float): Float {
        val v = g.y ?: return 0f
        if (!moving) {
            moving = true
            v.interrupt()
        }
        val lo = g.lo(false) ?: Float.NEGATIVE_INFINITY
        val hi = g.hi(false) ?: Float.POSITIVE_INFINITY
        val to = (v.value + dyPx / d).coerceIn(lo, hi)
        val used = to - v.value
        v.value = to
        vt.addPosition(SystemClock.uptimeMillis(), Offset(0f, to))
        return used * d
    }

    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
        // Content going up (finger up) while the pan isn't at its top: the pan moves first.
        val v = g.y ?: return Offset.Zero
        val lo = g.lo(false) ?: return Offset.Zero
        if (source != NestedScrollSource.UserInput || available.y >= 0f || v.value <= lo) return Offset.Zero
        return Offset(0f, nested(available.y))
    }

    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
        // The list is at its top and the finger pulls down: the pan moves.
        if (source != NestedScrollSource.UserInput || available.y <= 0f) return Offset.Zero
        return Offset(0f, nested(available.y))
    }

    override suspend fun onPreFling(available: Velocity): Velocity {
        if (!moving) return Velocity.Zero
        moving = false
        val vy = available.y / d
        val y = g.y?.value ?: 0f
        val density = Density(d)
        val t = g.chooseTarget(0f, y, 0f, vy, 0f, y, density)
        g.send("end", JSONObject().put("y", y.toDouble()).put("vy", vy.toDouble()).put("cancelled", false).apply { t?.let { put("anchor", it.id) } })
        g.settle(t, 0f, vy)
        return available
    }
}
