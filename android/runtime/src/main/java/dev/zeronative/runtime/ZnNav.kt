package dev.zeronative.runtime

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.graphics.Color
import org.json.JSONArray
import org.json.JSONObject

/** One back-stack entry: a screen. Its id is the screen's root instance id (ARCHITECTURE §8.3). */
class ZnEntry(val id: Int, val route: ZnRoute, val params: String) {
    /** The screen's `restorableSignal` values (key → JSON value), saved with the back stack (NAV RESTORE). */
    internal val values = JSONObject()
    /** Pushed by JS before the first screens were up: it is one of them, so it comes in with no slide (its back still slides). */
    internal var openedAtStart = false

    override fun equals(other: Any?) = other is ZnEntry && other.id == id
    override fun hashCode() = id
    override fun toString() = "zn-entry-$id(${route.name})"
}

/** A screen as saved in the Activity's state: route name, params JSON, and its `restorableSignal` values (JSON). */
internal data class ZnSavedEntry(val route: String, val params: String, val values: String? = null)

/** Saved state crosses a Binder call with a small size limit; a bigger back stack is not worth a crash. */
internal const val MAX_SAVED_STACK_CHARS = 50_000

/** The saved back stack as JSON: `[{"route":"amount","params":{...},"values":{...}}, ...]` (no "values" if none). */
internal fun savedStackJson(entries: List<ZnSavedEntry>, withValues: Boolean = true): String = JSONArray().apply {
    for (e in entries) {
        val o = JSONObject().put("route", e.route).put("params", JSONObject(e.params))
        if (withValues && e.values != null) o.put("values", JSONObject(e.values))
        put(o)
    }
}.toString()

/** Reads [savedStackJson]'s output; null if it can't be read. Stacks saved before host API 4 have no "values". */
internal fun readSavedStack(json: String): List<ZnSavedEntry>? = try {
    val a = JSONArray(json)
    List(a.length()) { i ->
        val o = a.getJSONObject(i)
        ZnSavedEntry(o.getString("route"), o.getJSONObject("params").toString(), o.optJSONObject("values")?.toString())
    }
} catch (e: Exception) {
    null
}

/**
 * The native side of navigation (ARCHITECTURE §11). The back stack is **owned by JS**: native only applies the
 * NAV ops JS sends (BatchReader, core/include/zn/batch.h) and reports system back presses as events. Process-wide,
 * like [ZnStore], so a recreated Activity shows the same stack. Main thread only.
 *
 * On the only screen, Back goes to the system at once, unless JS asked for it there ([backWanted]: tabs on a tab other
 * than the first); then it goes to JS like any other press ([systemBack]).
 *
 * App-level events to JS use instance 0 (packages/core/src/nav.ts): START, BACK, FORCED_BACK, OPEN, INSETS,
 * IMPRESSIONS (6, ZnImpressions), RETRY (10); the full list is ZnAppEvent.
 *
 * A screen whose JS threw while building it stays on the stack and is drawn as [ZnErrorScreen] (NAV FAILED, step
 * 3.9). If the app's JS failed to start at all ([appFailed]), every screen shows it, with "Restart app".
 */
object ZnNav {
    private const val TAG = "zn"
    private const val APP = ZnAppEvent.APP
    private const val EVENT_START = ZnAppEvent.START
    private const val EVENT_BACK = ZnAppEvent.BACK
    private const val EVENT_FORCED_BACK = ZnAppEvent.FORCED_BACK
    private const val EVENT_OPEN = ZnAppEvent.OPEN
    /** OPEN's route for a link that matches no route (onUnmatchedLink). */
    private const val UNMATCHED_ROUTE = -1
    internal const val LAYER_TOP = "top"
    internal const val LAYER_OVERLAY = "overlay"
    private const val EVENT_INSETS = ZnAppEvent.INSETS
    private const val EVENT_RETRY = ZnAppEvent.RETRY
    private const val EVENT_NAV_RESULT = ZnAppEvent.NAV_RESULT
    /** Key of the saved back stack in the Activity's saved state ([saveState]). */
    private const val SAVED_STACK = "zn.nav.stack"
    /** Key of the bundle (`id@sha12`) that saved it: screen values come back only into the same code. */
    private const val SAVED_BUNDLE = "zn.nav.bundle"
    /** How long native waits for JS to answer a back press before going back by itself. */
    private const val BACK_TIMEOUT_MS = 300L

    /** The back stack, bottom first. Observable: the host draws its top. */
    val stack: SnapshotStateList<ZnEntry> = mutableStateListOf()

    /** Entries whose screen threw while JS built it: entry id → the error message. The host draws [ZnErrorScreen]. */
    val failed: SnapshotStateMap<Int, String> = mutableStateMapOf()

    /**
     * Entries that want Back presses even as the only screen (NAV BACK_WANTED, host API 8): tabs on a tab other than
     * the first. Without it the system takes Back on the last screen at once (the app goes to the background).
     */
    internal val backWanted: SnapshotStateMap<Int, Unit> = mutableStateMapOf()

    /**
     * App layers (startApp's `top` and `overlay`, NAV LAYER, host API 9): layer name → its root instance id. They live
     * as long as the JS that built them; the host draws them around the screens.
     */
    internal val layers: SnapshotStateMap<String, Int> = mutableStateMapOf()

    /** Set when the app's JS failed to start (its bytecode threw): no screen can be built, so all show the error. */
    var appFailed: String? by mutableStateOf(null)
        private set

    /** Called when JS says the last screen was backed out of (the host lets the system handle back). */
    var onExit: (() -> Unit)? = null

    /**
     * Set while an update is applied in place (step 4.6, [ZnOta]): the host draws this colour (the top screen's
     * background) over everything and takes every touch, so the old screens going and the new ones being built are
     * never seen half done. Cleared when the new screens are built (NAV STARTED, step 4.7); then it fades out.
     */
    internal var cover: Color? by mutableStateOf(null)

    /** The template file the screens are drawn from (null before [start]). */
    internal val currentBundle: ZnBundle? get() = bundle

    /** Whether the first screens were opened ([start]). */
    internal val isStarted: Boolean get() = started

    /**
     * Main thread: JS has built the screens opened last by [start] / [restart] (NAV STARTED). False again while new first
     * screens are being built (a fresh start). [ZnSplash] waits for it.
     */
    internal var firstScreensUp = false
        private set

    /** Main thread: JS built the first screens. */
    private fun screensBuilt() {
        firstScreensUp = true
        ZnOta.screensUp()
    }

    private val main = Handler(Looper.getMainLooper())
    private var bundle: ZnBundle? = null
    private var started = false
    /** Native-allocated ids have the top bit set (JS ids start at 1). */
    private var nextNativeId = 0x80000001.toInt()
    /** Entries whose screen is on screen now (including during an exit animation). */
    private val composed = HashSet<Int>()

    /** Main thread: the top screen is composed (its first frame draws now). [ZnSplash] waits for it after an app hold. */
    internal val topComposed: Boolean get() = stack.lastOrNull()?.let { it.id in composed } ?: true
    private var backFallback: Runnable? = null

    /**
     * Call it from `Activity.onCreate` (and use [openLink] in `onNewIntent`). Opens the first screens: the start route
     * ("/"), plus the [link]'s route on top of it if it matches a route that allows deep links.
     *
     * [savedState]: the Activity's saved state (`savedInstanceState`). When Android brings the app back after killing
     * it in the background, it holds the stack [saveState] wrote, and those screens open again instead (step 3.9).
     * The process keeps the stack while it lives, so an Activity recreated with saved state (rotation, dark mode, the
     * system freeing it in the background) shows the same screens.
     *
     * A new Activity **without** saved state while the screens are already up means the user closed the app (swiped
     * it from recents) and this phone kept the process alive (some ROMs do): the app starts fresh, as on a phone that
     * ends the process: a new JS runtime and the start screen ([startFresh]). A host must call [handleExtraActivity]
     * first, so a second Activity made by a link never gets here.
     */
    fun start(bundle: ZnBundle, link: Uri?, savedState: Bundle? = null) {
        this.bundle = bundle
        if (started) {
            if (savedState == null && ZnRuntime.canRestart && !ZnRuntime.isRestarting) startFresh(bundle, link)
            else if (link != null) open(link)
            return
        }
        val savedJson = savedState?.getString(SAVED_STACK)
        var saved = savedJson?.let(::readSavedStack)
        if (savedJson != null && saved == null) Log.w(TAG, "nav: saved back stack can't be read; starting on the start screen")
        if (saved != null) {
            Log.i(TAG, "nav: Android restored the app; reopening ${saved.size} screen(s): ${saved.joinToString { it.route }}")
            // Values written by other code (an update installed meanwhile) may have another shape: the screens start
            // fresh instead (docs/second-opinions.md entry 7).
            val savedBy = savedState?.getString(SAVED_BUNDLE)
            if (saved.any { it.values != null } && savedBy != ZnBundles.running.label) {
                Log.i(TAG, "nav: screen values not restored: saved by $savedBy, running ${ZnBundles.running.label}")
                saved = saved.map { it.copy(values = null) }
            }
            restart(bundle, saved)
            return
        }
        started = true
        val home = bundle.routes.start ?: error("the bundle has no route with path \"/\"")
        val first = ArrayList<Opening>()
        first += Opening(home, "{}")
        val match = link?.let { match(it) }
        if (match != null && match.route != home) first += Opening(match.route, JSONObject(match.params).toString(), link = link.toString())
        // A link to the start screen itself (one of its tabs, say) opens it with the link's params (host API 8). JS
        // asks the app's link guard; refused, the start screen opens as usual.
        else if (match != null) first[0] = Opening(home, JSONObject(match.params).toString(), link = link.toString())
        startWith(bundle, first, unmatched = link?.takeIf { match == null })
    }

    /**
     * Call it in `Activity.onCreate`, right after `super.onCreate` and before setting any hook. If it returns true,
     * call `finish()` and return.
     *
     * With `launchMode="singleTop"` (needed by any app that opens another app for a result), a link that arrives while
     * another app is on top makes a **second** Activity, with no saved state, while the first one lives. That is not
     * the user closing the app: the JS runtime must stay, or a payment open in the other app would lose its JS. A
     * second Activity is not the root of its task; a real new launch is. So the link goes to the running app, and
     * our task comes to the front as it is (the other app stays on top of it). The link's own Activity never shows.
     *
     * While a launch waits for its result ([ZnLaunch]), that holds even if this Activity looks like a new launch, and
     * our task stays where it is: the other app's screen is not taken from the user.
     */
    fun handleExtraActivity(activity: Activity, savedState: Bundle?): Boolean {
        val waiting = ZnLaunch.waitingHere
        if (!started || savedState != null || (activity.isTaskRoot && !waiting)) return false
        val link = activity.intent?.data
        Log.i(TAG, "nav: a second Activity while the app runs: ${if (link != null) "forwarding its link" else "no link"}")
        if (link != null) {
            openLink(link)
            if (waiting) return true
            // A link from an app that doesn't ask for a new task lands in that app's task: without this the user would
            // see nothing. The launcher's intent has no data, so if it makes a second Activity too, this stops there.
            activity.packageManager.getLaunchIntentForPackage(activity.packageName)?.let {
                activity.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
        return true
    }

    /**
     * A screen native opens before JS runs: its route, params JSON, restored `restorableSignal` values, and the [link]
     * that opened it: JS asks the app's link guard before it builds the screen, and removes it if refused.
     */
    private class Opening(val route: ZnRoute, val params: String, val values: String? = null, val link: String? = null)

    private fun startWith(bundle: ZnBundle, first: List<Opening>, unmatched: Uri? = null) {
        firstScreensUp = false
        val payload = JSONArray()
        for (o in first) {
            val id = nextNativeId++
            mount(id, o.route, bundle)
            val entry = ZnEntry(id, o.route, o.params)
            val values = o.values?.let(::JSONObject)
            // Kept natively too: a value whose part of the screen isn't shown yet must survive a second kill.
            values?.keys()?.forEach { entry.values.put(it, values.get(it)) }
            stack += entry
            val item = JSONObject().put("entry", id.u32()).put("route", o.route.index).put("params", JSONObject(o.params))
            if (values != null && values.length() > 0) item.put("values", values)
            if (o.link != null) item.put("link", o.link)
            payload.put(item)
        }
        // After a kill, a screen must read the other app's result when it is built, not "still waiting".
        ZnLaunch.whenSettled {
            ZnRuntime.dispatchEvent(APP, EVENT_START, payload.toString())
            // The app's first screens are there: a start link that matched no route goes to JS now (onUnmatchedLink).
            unmatched?.let { openUnmatched(it, atStart = true) }
            ZnAppState.sendAfterStart()
            // JS answers NAV STARTED once these screens are built (host API 3). A bundle built for host API 2 doesn't, so
            // for it "the JS thread has handled START" stands in (it can't tell a bundle that never calls startApp).
            if ((ZnBundles.running.info?.requires?.hostApi ?: 3) < 3) {
                val gen = generation
                ZnRuntime.afterJs { if (gen == generation) screensBuilt() }
            }
        }
    }

    /** A native screen has no template, and so no root. */
    private fun mount(id: Int, route: ZnRoute, bundle: ZnBundle) {
        if (route.native == null) ZnStore.mountRoot(id, route.templateId, bundle.templates[route.templateId])
    }

    /**
     * Bumped by a dev reload. The host keys its screens on it, so the old screens are dropped at once (no exit
     * animation over screens whose instances are gone).
     */
    var generation by mutableIntStateOf(0)
        private set

    /**
     * Main thread, when the JS runtime is replaced (`zn dev` reload, or an update applied while the app runs): forgets
     * the stack and returns it as (route name, params JSON), bottom first, for [restart]. Screen values are left
     * out: the new code starts its screens fresh.
     */
    internal fun resetForReload(): List<ZnSavedEntry> {
        val saved = stack.map { ZnSavedEntry(it.route.name, it.params) }
        backFallback?.let(main::removeCallbacks)
        backFallback = null
        stack.clear()
        composed.clear()
        failed.clear()
        backWanted.clear()
        layers.values.forEach(ZnStore::removeRoot)
        layers.clear()
        appFailed = null
        lastInsets = "" // the new JS must hear the insets again
        ZnWindow.resetForReload()
        ZnSystemBars.reset()
        started = false
        generation++
        return saved
    }

    /**
     * Opens the [saved] stack (route name, params, screen values) with [bundle]: after a `zn dev` reload (debug
     * builds), an update applied while the app runs ([ZnOta]), or when Android restores the app ([start]). Routes
     * that no longer exist are skipped (an update may have removed them); the start route is always at the bottom.
     */
    internal fun restart(bundle: ZnBundle, saved: List<ZnSavedEntry>) {
        this.bundle = bundle
        started = true
        val home = bundle.routes.start ?: error("the bundle has no route with path \"/\"")
        val first = ArrayList<Opening>()
        for (s in saved) bundle.routes.all.firstOrNull { it.name == s.route }?.let { first += Opening(it, s.params, s.values) }
        if (first.firstOrNull()?.route != home) first.add(0, Opening(home, "{}"))
        startWith(bundle, first)
    }

    /**
     * Saves the back stack (route names, params and `restorableSignal` values) into the Activity's saved state. Call
     * it from `Activity.onSaveInstanceState`. Android hands it back to [start] only when it restores the app after
     * killing it in the background; a normal launch from the launcher has none and starts on the start screen. A
     * screen whose route says `restore: false` is left out, with the screens above it. Other JS state starts fresh.
     */
    fun saveState(out: Bundle) {
        val keep = stack.takeWhile { it.route.restore }
        // Only the start screen, with no values: a fresh start is the same.
        if (keep.isEmpty() || (keep.size == 1 && keep[0].values.length() == 0)) return
        val entries = keep.map { ZnSavedEntry(it.route.name, it.params, it.values.takeIf { v -> v.length() > 0 }?.toString()) }
        var json = savedStackJson(entries)
        if (json.length > MAX_SAVED_STACK_CHARS) {
            Log.w(TAG, "nav: screen values too big to save (${json.length} chars); saving the screens without them")
            json = savedStackJson(entries, withValues = false)
        }
        if (json.length > MAX_SAVED_STACK_CHARS) {
            Log.w(TAG, "nav: back stack too big to save (${json.length} chars); not saved")
            return
        }
        out.putString(SAVED_STACK, json)
        ZnBundles.running.label?.let { out.putString(SAVED_BUNDLE, it) }
    }

    /** NAV RESTORE: a `restorableSignal` of [entry] changed. `{"key":k,"value":v}` keeps v; no "value" forgets k. */
    private fun keepValue(entry: ZnEntry, params: String?) {
        try {
            val o = JSONObject(params ?: return)
            val key = o.getString("key")
            if (o.has("value")) entry.values.put(key, o.get("value")) else entry.values.remove(key)
        } catch (e: Exception) {
            Log.e(TAG, "nav: bad RESTORE params for $entry: $params", e)
        }
    }

    /**
     * A waiting update runs now, as it would on a phone that ends the process ([ZnOta.startFresh]). With none: the same
     * steps as an update applied in place, with the bundle that runs now: the JS runtime is replaced (storage and
     * FlowStore are files: untouched) and the start screen opens, with [link] on top if given.
     */
    private fun startFresh(bundle: ZnBundle, link: Uri?) {
        Log.i(TAG, "nav: a new Activity without saved state while the app still runs (closed from recents?): starting fresh")
        firstScreensUp = false // the old screens go; a splash hold waits for the new ones (ZnSplash)
        ZnOta.startFresh(link) {
            ZnRuntime.restart { result, attach ->
                resetForReload()
                ZnStore.resetForReload()
                ZnImpressions.resetForReload()
                attach()
                start(bundle, link)
                if (!result.ok) startFailed(result.value)
            }
        }
    }

    /** Call it from `Activity.onNewIntent`: a link while the app runs. JS pushes its route (JS owns the stack). */
    fun openLink(link: Uri) {
        if (started) open(link)
    }

    private fun open(link: Uri) {
        val m = match(link) ?: return openUnmatched(link, atStart = false)
        val payload = JSONObject().put("route", m.route.index).put("params", JSONObject(m.params)).put("url", link.toString())
        ZnRuntime.dispatchEvent(APP, EVENT_OPEN, payload.toString())
    }

    /**
     * A link to this app that matches no route: JS's `onUnmatchedLink` (startApp) gets the whole link and opens what it
     * wants. Sent as OPEN with route -1: a bundle from before this ignores it (it logs "unknown route"), as it always did.
     */
    private fun openUnmatched(link: Uri, atStart: Boolean) {
        val payload = JSONObject().put("route", UNMATCHED_ROUTE).put("params", JSONObject()).put("url", link.toString())
            .put("atStart", atStart)
        ZnRuntime.dispatchEvent(APP, EVENT_OPEN, payload.toString())
    }

    /** The route of [link], with its query values as params too (a value from the path wins). */
    private fun match(link: Uri): ZnRouteMatch? {
        val m = bundle?.routes?.matchDeepLink(link.encodedPath ?: "/")?.let { path ->
            if (!link.isHierarchical) return@let path
            val params = HashMap<String, String>()
            for (name in link.queryParameterNames) link.getQueryParameter(name)?.let { params[name] = it }
            path.copy(params = params + path.params)
        }
        Log.i(TAG, "deep link ${link.scheme}://${link.host}${link.path} → ${m?.let { "${it.route.name} ${it.params.keys}" } ?: "no route"}")
        return m
    }

    /**
     * The system back button or gesture. JS decides (pops, or a `useBack` handler keeps the screen). If JS doesn't
     * answer in [BACK_TIMEOUT_MS] (it is stuck), native goes back by itself and tells JS which entry it removed.
     */
    fun systemBack() {
        // The JS runtime is being replaced: the press would be dropped, and the fallback below would pop a screen of
        // the stack that is about to open again.
        if (ZnRuntime.isRestarting) return
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
                mount(op.entry, route, b)
                // Before NAV STARTED, JS is still opening the first screens (nav.ts: a push while START builds them).
                // Or while the splash is still held (Splash.holdUntil): the user sees this screen first, not a slide to it.
                stack += ZnEntry(op.entry, route, op.params ?: "{}").apply { openedAtStart = !firstScreensUp || ZnSplash.holding }
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
            BatchOp.Nav.FAILED -> if (stack.any { it.id == op.entry }) {
                failed[op.entry] = op.params?.let { runCatching { JSONObject(it).optString("message") }.getOrNull() } ?: ""
            }
            // After this batch is drawn the first screens are on screen (OTA safety nets, step 4.7).
            BatchOp.Nav.STARTED -> main.post { screensBuilt() }
            BatchOp.Nav.RESTORE -> stack.firstOrNull { it.id == op.entry }?.let { keepValue(it, op.params) }
            BatchOp.Nav.BACK_WANTED -> {
                if (op.route != 0 && stack.any { it.id == op.entry }) backWanted[op.entry] = Unit else backWanted.remove(op.entry)
            }
            BatchOp.Nav.LAYER -> layer(op)
            else -> Log.e(TAG, "nav: unknown kind ${op.kind}")
        }
        // The top screen may have changed: impressions count only on the top screen.
        if (op.kind == BatchOp.Nav.PUSH || op.kind == BatchOp.Nav.REMOVE || op.kind == BatchOp.Nav.CLEAR) {
            main.post { ZnImpressions.refresh() }
        }
    }

    /** NAV LAYER: makes the layer's root from its template (entry = root id, route = template id); entry 0 removes it. */
    private fun layer(op: BatchOp.Nav) {
        val name = op.params?.let { runCatching { JSONObject(it).optString("layer") }.getOrNull() }
        if (name != LAYER_TOP && name != LAYER_OVERLAY) return Unit.also { Log.e(TAG, "nav: unknown layer $name") }
        layers.remove(name)?.let(ZnStore::removeRoot)
        if (op.entry == 0) return
        val template = bundle?.templates?.getOrNull(op.route)
            ?: return Unit.also { Log.e(TAG, "nav: layer $name has no template ${op.route}") }
        ZnStore.mountRoot(op.entry, op.route, template)
        layers[name] = op.entry
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

    /**
     * Main thread: the native screen [entry] answers with [value] (JSON). The answer is on disk before JS hears it, so a kill
     * can't lose it. JS closes the screen, as it owns the stack. Only the top screen can answer.
     */
    internal fun answer(entry: ZnEntry, value: String) {
        if (stack.lastOrNull()?.id != entry.id) return Unit.also { Log.w(TAG, "nav: $entry answered but isn't on top; dropped") }
        val id = "${entry.id.u32()}.${System.currentTimeMillis()}"
        ZnLaunch.saveScreenResult("nav.${entry.route.name}", id, value)
        val payload = JSONObject().put("entry", entry.id.u32()).put("route", entry.route.name).put("id", id)
        ZnRuntime.dispatchEvent(APP, EVENT_NAV_RESULT, payload.toString())
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

    /**
     * "Try again" on a failed screen: drop what the failed build left under its root, make a fresh root from the
     * template, and ask JS to build the screen again (RETRY).
     */
    internal fun retry(id: Int) {
        val entry = stack.firstOrNull { it.id == id } ?: return
        val b = bundle ?: return
        if (failed.remove(id) == null) return
        ZnStore.removeRoot(id)
        ZnStore.mountRoot(id, entry.route.templateId, b.templates[entry.route.templateId])
        ZnRuntime.dispatchEvent(APP, EVENT_RETRY, id.u32())
    }

    /**
     * JS hung and was stopped by the time limit (main thread). The top screen shows the error screen; its state may
     * be half updated, and "Try again" builds it again from its route and params.
     */
    internal fun hung(message: String) {
        val top = stack.lastOrNull() ?: return
        failed[top.id] = message
    }

    /** The app's JS failed to start (main thread). Every screen now shows the error screen with "Restart app". */
    internal fun startFailed(message: String) {
        appFailed = message
    }

    /** An entry left the stack: free its instances now, or after its exit animation if it is on screen. */
    private fun release(id: Int) {
        failed.remove(id)
        backWanted.remove(id)
        ZnImpressions.release(id)
        if (id !in composed) ZnStore.removeRoot(id)
    }

    /**
     * An instance id as JS sees it. Ids are u32 on the wire; native-allocated ones have the top bit set, so as a
     * Kotlin Int they are negative. JS must get the unsigned number (0x80000001, not -2147483647).
     */
    private fun Int.u32(): Long = toLong() and 0xFFFFFFFFL
}
