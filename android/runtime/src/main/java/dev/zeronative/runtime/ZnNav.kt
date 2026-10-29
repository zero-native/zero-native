package dev.zeronative.runtime

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import org.json.JSONArray
import org.json.JSONObject

/** One back-stack entry: a screen. Its id is the screen's root instance id (ARCHITECTURE §8.3). */
class ZnEntry(val id: Int, val route: ZnRoute, val params: String) {
    override fun equals(other: Any?) = other is ZnEntry && other.id == id
    override fun hashCode() = id
    override fun toString() = "zn-entry-$id(${route.name})"
}

/**
 * The native side of navigation (ARCHITECTURE §11). The back stack is **owned by JS**: native only applies the
 * NAV ops JS sends (BatchReader, core/include/zn/batch.h) and reports system back presses as events. Process-wide,
 * like [ZnStore], so a recreated Activity shows the same stack. Main thread only.
 *
 * App-level events to JS use instance 0 (packages/core/src/nav.ts): START, BACK, FORCED_BACK, OPEN, INSETS,
 * IMPRESSIONS (6, ZnImpressions).
 */
object ZnNav {
    private const val TAG = "zn"
    private const val APP = 0
    private const val EVENT_START = 1
    private const val EVENT_BACK = 2
    private const val EVENT_FORCED_BACK = 3
    private const val EVENT_OPEN = 4
    private const val EVENT_INSETS = 5
    /** How long native waits for JS to answer a back press before going back by itself. */
    private const val BACK_TIMEOUT_MS = 300L

    /** The back stack, bottom first. Observable: the host draws its top. */
    val stack: SnapshotStateList<ZnEntry> = mutableStateListOf()

    /** Called when JS says the last screen was backed out of (the host lets the system handle back). */
    var onExit: (() -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private var bundle: ZnBundle? = null
    private var started = false
    /** Native-allocated ids have the top bit set (JS ids start at 1). */
    private var nextNativeId = 0x80000001.toInt()
    /** Entries whose screen is on screen now (including during an exit animation). */
    private val composed = HashSet<Int>()
    private var backFallback: Runnable? = null

    /**
     * Opens the first screens once per process: the start route ("/"), plus the [link]'s route on top of it if it
     * matches a route that allows deep links. Later calls (Activity recreated, or opened again by a link) keep the
     * stack and only open [link], by asking JS to push it.
     */
    fun start(bundle: ZnBundle, link: Uri?) {
        this.bundle = bundle
        if (started) {
            if (link != null) open(link)
            return
        }
        started = true
        val home = bundle.routes.start ?: error("the bundle has no route with path \"/\"")
        val first = ArrayList<Pair<ZnRoute, String>>()
        first += home to "{}"
        val match = link?.let { match(it) }
        if (match != null && match.route != home) first += match.route to JSONObject(match.params).toString()
        startWith(bundle, first)
    }

    private fun startWith(bundle: ZnBundle, first: List<Pair<ZnRoute, String>>) {
        val payload = JSONArray()
        for ((route, json) in first) {
            val id = nextNativeId++
            ZnStore.mountRoot(id, route.templateId, bundle.templates[route.templateId])
            stack += ZnEntry(id, route, json)
            payload.put(JSONObject().put("entry", id.u32()).put("route", route.index).put("params", JSONObject(json)))
        }
        ZnRuntime.dispatchEvent(APP, EVENT_START, payload.toString())
    }

    /**
     * Bumped by a dev reload. The host keys its screens on it, so the old screens are dropped at once (no exit
     * animation over screens whose instances are gone).
     */
    var generation by mutableIntStateOf(0)
        private set

    /**
     * Debug builds (`zn dev` reload), main thread: forgets the stack and returns it as (route name, params JSON),
     * bottom first, for [restart].
     */
    internal fun resetForReload(): List<Pair<String, String>> {
        val saved = stack.map { it.route.name to it.params }
        backFallback?.let(main::removeCallbacks)
        backFallback = null
        stack.clear()
        composed.clear()
        lastInsets = "" // the new JS must hear the insets again
        started = false
        generation++
        return saved
    }

    /**
     * Debug builds (`zn dev` reload): opens the [saved] stack again with the new [bundle], so you stay on the screen
     * you were on. Routes that no longer exist are skipped; the start route is always at the bottom.
     */
    internal fun restart(bundle: ZnBundle, saved: List<Pair<String, String>>) {
        this.bundle = bundle
        started = true
        val home = bundle.routes.start ?: error("the bundle has no route with path \"/\"")
        val first = ArrayList<Pair<ZnRoute, String>>()
        for ((name, params) in saved) bundle.routes.all.firstOrNull { it.name == name }?.let { first += it to params }
        if (first.firstOrNull()?.first != home) first.add(0, home to "{}")
        startWith(bundle, first)
    }

    /** A link while the app runs: JS pushes its route (JS owns the stack). */
    private fun open(link: Uri) {
        val m = match(link) ?: return
        val payload = JSONObject().put("route", m.route.index).put("params", JSONObject(m.params))
        ZnRuntime.dispatchEvent(APP, EVENT_OPEN, payload.toString())
    }

    private fun match(link: Uri): ZnRouteMatch? {
        val m = bundle?.routes?.matchDeepLink(link.encodedPath ?: "/")
        Log.i(TAG, "deep link $link → ${m?.let { "${it.route.name} ${it.params}" } ?: "no route"}")
        return m
    }

    /**
     * The system back button or gesture. JS decides (pops, or a `useBack` handler keeps the screen). If JS doesn't
     * answer in [BACK_TIMEOUT_MS] (it is stuck), native goes back by itself and tells JS which entry it removed.
     */
    fun systemBack() {
        val top = stack.lastOrNull() ?: return
        ZnRuntime.dispatchEvent(APP, EVENT_BACK, top.id.u32())
        backFallback?.let(main::removeCallbacks)
        backFallback = Runnable {
            backFallback = null
            Log.w(TAG, "JS didn't answer a back press in $BACK_TIMEOUT_MS ms; going back natively")
            if (stack.size > 1) {
                val e = stack.removeAt(stack.lastIndex)
                release(e.id)
                ZnRuntime.dispatchEvent(APP, EVENT_FORCED_BACK, e.id.u32())
            } else {
                onExit?.invoke()
            }
        }.also { main.postDelayed(it, BACK_TIMEOUT_MS) }
    }

    /** Applies one NAV op. Runs inside [ZnStore.apply]'s snapshot, so the whole batch shows in one frame. */
    internal fun apply(op: BatchOp.Nav) {
        when (op.kind) {
            BatchOp.Nav.PUSH -> {
                val b = bundle
                val route = b?.routes?.at(op.route)
                if (b == null || route == null) {
                    Log.e(TAG, "nav: can't push route ${op.route} (bundle ready: ${b != null})")
                    return
                }
                ZnStore.mountRoot(op.entry, route.templateId, b.templates[route.templateId])
                stack += ZnEntry(op.entry, route, op.params ?: "{}")
            }
            BatchOp.Nav.REMOVE -> {
                if (stack.removeAll { it.id == op.entry }) release(op.entry)
            }
            BatchOp.Nav.CLEAR -> {
                val ids = stack.map { it.id }
                stack.clear()
                ids.forEach(::release)
            }
            BatchOp.Nav.EXIT -> main.post { onExit?.invoke() }
            BatchOp.Nav.BACK_ANSWERED -> backFallback?.let { main.removeCallbacks(it); backFallback = null }
            BatchOp.Nav.IMPRESSIONS -> ZnImpressions.configure(op.entry, op.params)
            else -> Log.e(TAG, "nav: unknown kind ${op.kind}")
        }
        // The top screen may have changed: impressions count only on the top screen.
        if (op.kind == BatchOp.Nav.PUSH || op.kind == BatchOp.Nav.REMOVE || op.kind == BatchOp.Nav.CLEAR) {
            main.post { ZnImpressions.refresh() }
        }
    }

    private var lastInsets = ""

    /** Safe-area insets in dp, sent to JS's `insets()` when they change (rare: start, rotation, cutout). */
    fun reportInsets(top: Float, bottom: Float, start: Float, end: Float) {
        fun r(v: Float) = Math.round(v * 10) / 10.0
        val json = JSONObject().put("top", r(top)).put("bottom", r(bottom)).put("start", r(start)).put("end", r(end))
            .toString()
        if (json == lastInsets) return
        lastInsets = json
        ZnRuntime.dispatchEvent(APP, EVENT_INSETS, json)
    }

    /** The host shows an entry's screen. */
    internal fun shown(id: Int) {
        composed += id
    }

    /** An entry's screen left the screen (after its exit animation, or the Activity went away). */
    internal fun hidden(id: Int) {
        composed -= id
        if (stack.none { it.id == id }) ZnStore.removeRoot(id)
    }

    /** An entry left the stack: free its instances now, or after its exit animation if it is on screen. */
    private fun release(id: Int) {
        ZnImpressions.release(id)
        if (id !in composed) ZnStore.removeRoot(id)
    }

    /**
     * An instance id as JS sees it. Ids are u32 on the wire; native-allocated ones have the top bit set, so as a
     * Kotlin Int they are negative. JS must get the unsigned number (0x80000001, not -2147483647).
     */
    private fun Int.u32(): Long = toLong() and 0xFFFFFFFFL
}
