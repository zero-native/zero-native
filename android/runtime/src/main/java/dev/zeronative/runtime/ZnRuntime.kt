package dev.zeronative.runtime

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.util.concurrent.atomic.AtomicInteger

/** Result of running JS: [value] is the result as text when [ok], else the error message. */
data class EvalResult(val ok: Boolean, val value: String, val millis: Long)

/**
 * An error JS reported, or JS that hung or didn't start ([ZnRuntime.onJsError]; step 3.9). For crash reporting:
 * Crashlytics' `recordException`, or the app's backend.
 */
class ZnJsError(
    /**
     * What was running: "screen" (building a screen: the user sees the error screen), "part" (building a part of a
     * screen: it stays empty), "async" (a Promise nobody caught), "handler" (a tap or other event handler, a
     * timer, an effect, a listener), "hang" (stopped by the time limit), "start" (the app's JS didn't start),
     * "renderer" (native refused or skipped something JS sent).
     */
    val kind: String,
    /** Where, in words (`screen "amount" threw`, `event handler failed`, ...). */
    val where: String,
    /** The message and the JS stack. */
    val details: String,
    /** The top screen's route name when it was reported (null before the first screen). */
    val screen: String?,
    /** The running bundle id (`app_12`; [ZnBundles]), so a report says which OTA bundle it came from. */
    val bundle: String?,
)

/** Called on the main thread after each batch is applied (timestamps from System.nanoTime, a monotonic clock). */
fun interface BatchListener {
    fun onApplied(opCount: Int, applyStartNanos: Long, applyEndNanos: Long)
}

/**
 * The one JS runtime of this app process (ARCHITECTURE.md §8.2).
 *
 * - Created once per process, from the Application. Activities only attach to it: recreating an Activity never
 *   restarts JS, and [ZnStore] keeps every slot value.
 * - All engine calls run on the dedicated "zn-js" thread. The main thread never waits for JS: it only takes
 *   finished batches.
 */
object ZnRuntime {
    private const val TAG = "zn"
    /** Start of the error text of JS stopped by the time limit (kTimeLimitError in core/include/zn/engine.h). */
    internal const val TIME_LIMIT_ERROR = "zero-native time limit:"
    /** A screen that threw while being built reports `screen "<route>" threw` (packages/core/src/nav.ts). */
    private val SCREEN_ERROR = Regex("^screen \"(.+)\" threw$")

    private val jsThread = HandlerThread("zn-js").apply { start() }
    private val js = Handler(jsThread.looper)
    private val main = Handler(Looper.getMainLooper())

    private lateinit var appContext: Context
    /** The runtime the main thread takes batches from (0 while a dev reload swaps runtimes). */
    @Volatile private var runtime = 0L
    /** The runtime JS-thread work runs on. JS thread only. */
    private var jsRuntime = 0L
    /** Bumped when a dev reload replaces the runtime: timers and events queued for the old one are dropped. */
    private var generation = 0

    /** The runtime generation; read it on the JS thread only. Native call answers carry it (ZnModules). */
    internal val currentGeneration: Int get() = generation
    /** True while a dev reload swaps runtimes: UI events in that window are dropped. */
    @Volatile private var reloading = false
    private var started = false
    private val listeners = ArrayList<BatchListener>()

    /**
     * The longest one piece of JS (a tap handler, a timer, building a screen) may run before it is stopped and
     * reported as a hang; 0 = no limit. Default 2 s in release builds, 3 s in debug builds (debug code is slower).
     * Taps wait while JS is busy (the UI itself keeps scrolling and animating), so a task this long is already a
     * bug; anything over 200 ms is logged as "slow JS" to catch it early. Raise it while pausing in a debugger.
     * Set it in Application.onCreate before [start]. A hang shows the error screen on the top screen
     * ("Try again" builds it again); the framework does nothing more by itself: an app that wants more (for example
     * a restart after several hangs) does it in [onJsError].
     */
    @Volatile var jsTimeLimitMs: Int = if (BuildConfig.DEBUG) 3_000 else 2_000

    /** Hears every error JS reported, and JS that hung or didn't start, on the main thread (crash reporting). */
    @Volatile var onJsError: ((ZnJsError) -> Unit)? = null

    /** Counts runtimes created in this process. Stays 1 for the life of the process (checked by the sample app). */
    val createdCount = AtomicInteger(0)

    /** Starts the runtime. Safe to call more than once; never blocks the caller. */
    @Synchronized
    fun start(context: Context) {
        if (started) return
        // Application.onCreate runs in every process of the app; an SDK's extra process must not start a second JS
        // runtime (startup cost, and two processes opening the same storage files).
        if (!ZnProcess.isMain(context)) {
            Log.i(TAG, "not starting the JS runtime in process ${ZnProcess.name()} (main process only)")
            return
        }
        started = true
        appContext = context.applicationContext
        ZnBundles.init(appContext) // which bundle runs is chosen on first use, off the main thread
        js.post {
            val t0 = SystemClock.uptimeMillis()
            jsRuntime = createOnJsThread()
            runtime = jsRuntime
            val n = createdCount.get()
            Log.i(TAG, "runtime #$n started in ${SystemClock.uptimeMillis() - t0} ms (pid ${Process.myPid()})")
        }
        // Built-in modules (Keyboard, Fetch, SecureStore, Toast) are registered by ZnModules itself; two need a Context.
        ZnFetch.init(appContext) // built-in module behind the global fetch()
        ZnSecureStore.init(appContext) // built-in module: SecureStore (Keystore-encrypted secrets)
        if (BuildConfig.DEBUG) ZnDev.start(appContext)
    }

    private fun createOnJsThread(): Long {
        // FlowStore files (ARCHITECTURE §13.2) live in noBackupFilesDir: never in backups or cloud restore.
        val flowDir = java.io.File(appContext.noBackupFilesDir, "zn").apply { mkdirs() }.absolutePath
        // App storage (MMKV, docs/storage.md): not in backups either. Restoring it to a new phone would bring back
        // stale state and, with an old backup, mixed versions of it; apps keep what must follow the user on a server.
        val storageDir = ZnStorage.dir(appContext).apply { mkdirs() }.absolutePath // the folder Kotlin's ZnStorage uses
        return ZnNative.createRuntime(flowDir, storageDir).also {
            ZnNative.setTimeLimit(it, jsTimeLimitMs)
            createdCount.incrementAndGet()
        }
    }

    /**
     * Runs bytecode file [name] of the running bundle on the JS thread and reports the result on the main thread.
     * The running bundle is the APK's assets or a downloaded OTA bundle ([ZnBundles], docs/ota.md).
     */
    fun evalAsset(name: String, onResult: (EvalResult) -> Unit = {}) {
        checkStarted()
        js.post {
            val t0 = SystemClock.uptimeMillis()
            val file = ZnBundles.file(name)
            val raw = if (file != null) ZnNative.evalFile(jsRuntime, file.path, name)
                else ZnNative.evalAsset(jsRuntime, appContext.assets, name)
            val result = evalResult(raw, t0)
            // The app's JS didn't start: no screen can be built. Show the error screen with "Restart app" instead of a
            // screen that stays half drawn (step 3.9).
            if (!result.ok) main.post { ZnNav.startFailed(result.value) }
            if (result.ok) Log.i(TAG, "$name evaluated in ${result.millis} ms") else Log.e(TAG, "$name failed: ${result.value}")
            main.post { onResult(result) }
        }
    }

    private fun evalResult(raw: String, t0: Long): EvalResult {
        val millis = SystemClock.uptimeMillis() - t0
        return if (raw.startsWith("ok:")) EvalResult(true, raw.removePrefix("ok:"), millis)
        else EvalResult(false, raw.removePrefix("error:"), millis)
    }

    /**
     * Debug builds only (`zn dev`, ARCHITECTURE §17): replaces the JS runtime with a fresh one running [bytecode].
     * The only exception to "one runtime per process" (§8.2). Main thread. The main thread stops taking batches
     * now; [onLoaded] runs on the main thread once the new code has run. It must reset the screens, then call the
     * `attach` function it is given (batches and UI events flow again), then start the screens.
     */
    internal fun reload(bytecode: ByteArray, onLoaded: (result: EvalResult, attach: () -> Unit) -> Unit) {
        check(BuildConfig.DEBUG) { "reload is for debug builds only" }
        checkStarted()
        reloading = true
        runtime = 0L
        ZnModules.resetForReload()
        js.post {
            val t0 = SystemClock.uptimeMillis()
            ZnNative.destroyRuntime(jsRuntime)
            generation++
            val fresh = createOnJsThread()
            jsRuntime = fresh
            val result = evalResult(ZnNative.evalBytes(fresh, bytecode, "main.hbc"), t0)
            main.post {
                onLoaded(result) {
                    runtime = fresh
                    reloading = false
                }
            }
        }
    }

    /** Sends an event to JS (for example a tap). Payload: null, Boolean, Number or String. */
    fun dispatchEvent(instance: Int, eventId: Int, payload: Any? = null) {
        checkStarted()
        if (reloading) return // dev reload: the screens this event came from are being replaced
        js.post {
            val rt = jsRuntime
            when (payload) {
                null -> ZnNative.dispatchEvent(rt, instance, eventId, 0, 0.0, null)
                is Boolean -> ZnNative.dispatchEvent(rt, instance, eventId, 1, if (payload) 1.0 else 0.0, null)
                is Number -> ZnNative.dispatchEvent(rt, instance, eventId, 2, payload.toDouble(), null)
                is String -> ZnNative.dispatchEvent(rt, instance, eventId, 3, 0.0, payload)
                else -> Log.e(TAG, "event payload must be null, Boolean, Number or String, got ${payload::class}")
            }
        }
    }

    /**
     * Sends an event to JS whose String payload is read **when the JS thread runs it**, not now: a busy JS thread gets
     * the newest value once instead of a queue of old ones (native module events with latestOnly).
     */
    internal fun dispatchLatest(instance: Int, eventId: Int, payload: () -> String?) {
        checkStarted()
        if (reloading) return
        js.post {
            val p = payload() ?: return@post
            ZnNative.dispatchEvent(jsRuntime, instance, eventId, 3, 0.0, p)
        }
    }

    /** A native call's answer (JSON) for the runtime of [gen]; dropped if a dev reload replaced that runtime. */
    internal fun dispatchAnswer(eventId: Int, json: String, gen: Int) {
        checkStarted()
        if (reloading) return
        js.post { if (gen == generation) ZnNative.dispatchEvent(jsRuntime, 0, eventId, 3, 0.0, json) }
    }

    /** Same, with binary data: JS gets one ArrayBuffer [u32 LE head size][head][body] (jni_bridge.cpp). */
    internal fun dispatchAnswerBytes(eventId: Int, head: ByteArray, body: ByteArray, gen: Int) {
        checkStarted()
        if (reloading) return
        js.post { if (gen == generation) ZnNative.dispatchBytes(jsRuntime, 0, eventId, head, body) }
    }

    fun addBatchListener(listener: BatchListener) {
        listeners += listener
    }

    fun removeBatchListener(listener: BatchListener) {
        listeners -= listener
    }

    // ---- Called by ZnNative on the JS thread ---------------------------------------------------------------------

    internal fun scheduleTimer(handle: Int, delayMs: Double) {
        val gen = generation
        js.postDelayed({ if (gen == generation) ZnNative.fireTimer(jsRuntime, handle) }, delayMs.toLong().coerceAtLeast(0))
    }

    internal fun requestApply() {
        main.post(::applyPending)
    }

    /**
     * JS threw and nothing caught it, or it hung, or didn't start ("kind\nwhere\nmessage and stack"). Already logged.
     * Debug builds show it on screen; a hang shows the error screen on the top screen; [onJsError] hears it.
     */
    internal fun jsError(text: String) {
        val kind = text.substringBefore('\n')
        val rest = text.substringAfter('\n', "")
        val where = rest.substringBefore('\n')
        val details = rest.substringAfter('\n', "")
        main.post {
            if (kind == "hang") ZnNav.hung(details.substringBefore('\n'))
            if (BuildConfig.DEBUG) ZnDev.onJsError(rest)
            val hook = onJsError ?: return@post
            // A screen that failed while being built isn't the top of native's stack yet: its name is in the report.
            val screen = SCREEN_ERROR.find(where)?.groupValues?.get(1) ?: ZnNav.stack.lastOrNull()?.route?.name
            val error = ZnJsError(kind, where, details, screen, ZnBundles.running.info?.id)
            try {
                hook(error)
            } catch (e: Exception) {
                Log.e(TAG, "onJsError threw", e)
            }
        }
    }

    /**
     * Main thread: the renderer refused or skipped something JS sent (a bad op). Logged, shown on the dev error
     * screen in debug builds, and passed to [onJsError] as kind "renderer". The app keeps running.
     */
    internal fun rendererError(where: String, e: Throwable) {
        Log.e(TAG, "renderer: $where", e)
        val details = "${e::class.simpleName}: ${e.message}"
        if (BuildConfig.DEBUG) ZnDev.onJsError("renderer: $where\n$details")
        val hook = onJsError ?: return
        try {
            hook(ZnJsError("renderer", where, details, ZnNav.stack.lastOrNull()?.route?.name, ZnBundles.running.info?.id))
        } catch (t: Exception) {
            Log.e(TAG, "onJsError threw", t)
        }
    }

    // ---- Main thread ---------------------------------------------------------------------------------------------

    private fun applyPending() {
        val start = System.nanoTime()
        val rt = runtime
        if (rt == 0L) return // dev reload in progress; the new runtime's batches are taken after it attaches
        val bytes = ZnNative.takeBatch(rt) ?: return
        val ops = BatchReader.read(bytes)
        ZnStore.apply(ops)
        val end = System.nanoTime()
        for (l in listeners.toList()) l.onApplied(ops.size, start, end)
    }

    private fun checkStarted() =
        check(started) { "ZnRuntime.start() must be called first (from Application.onCreate)" }
}
