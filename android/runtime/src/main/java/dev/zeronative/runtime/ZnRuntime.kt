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

    private val jsThread = HandlerThread("zn-js").apply { start() }
    private val js = Handler(jsThread.looper)
    private val main = Handler(Looper.getMainLooper())

    private lateinit var appContext: Context
    @Volatile private var runtime = 0L // created on the JS thread; takeBatch reads it on main after creation
    private var started = false
    private val listeners = ArrayList<BatchListener>()

    /** Counts runtimes created in this process. Stays 1 for the life of the process (checked by the sample app). */
    val createdCount = AtomicInteger(0)

    /** Starts the runtime. Safe to call more than once; never blocks the caller. */
    @Synchronized
    fun start(context: Context) {
        if (started) return
        started = true
        appContext = context.applicationContext
        js.post {
            val t0 = SystemClock.uptimeMillis()
            runtime = ZnNative.createRuntime()
            val n = createdCount.incrementAndGet()
            Log.i(TAG, "runtime #$n started in ${SystemClock.uptimeMillis() - t0} ms (pid ${Process.myPid()})")
        }
    }

    /** Runs a bytecode asset on the JS thread and reports the result on the main thread. */
    fun evalAsset(name: String, onResult: (EvalResult) -> Unit = {}) {
        checkStarted()
        js.post {
            val t0 = SystemClock.uptimeMillis()
            val raw = ZnNative.evalAsset(runtime, appContext.assets, name)
            val millis = SystemClock.uptimeMillis() - t0
            val result = if (raw.startsWith("ok:")) {
                EvalResult(true, raw.removePrefix("ok:"), millis)
            } else {
                EvalResult(false, raw.removePrefix("error:"), millis)
            }
            if (result.ok) Log.i(TAG, "$name evaluated in $millis ms") else Log.e(TAG, "$name failed: ${result.value}")
            main.post { onResult(result) }
        }
    }

    /** Sends an event to JS (for example a tap). Payload: null, Boolean, Number or String. */
    fun dispatchEvent(instance: Int, eventId: Int, payload: Any? = null) {
        checkStarted()
        js.post {
            when (payload) {
                null -> ZnNative.dispatchEvent(runtime, instance, eventId, 0, 0.0, null)
                is Boolean -> ZnNative.dispatchEvent(runtime, instance, eventId, 1, if (payload) 1.0 else 0.0, null)
                is Number -> ZnNative.dispatchEvent(runtime, instance, eventId, 2, payload.toDouble(), null)
                is String -> ZnNative.dispatchEvent(runtime, instance, eventId, 3, 0.0, payload)
                else -> Log.e(TAG, "event payload must be null, Boolean, Number or String, got ${payload::class}")
            }
        }
    }

    fun addBatchListener(listener: BatchListener) {
        listeners += listener
    }

    fun removeBatchListener(listener: BatchListener) {
        listeners -= listener
    }

    // ---- Called by ZnNative on the JS thread ---------------------------------------------------------------------

    internal fun scheduleTimer(handle: Int, delayMs: Double) {
        js.postDelayed({ ZnNative.fireTimer(runtime, handle) }, delayMs.toLong().coerceAtLeast(0))
    }

    internal fun requestApply() {
        main.post(::applyPending)
    }

    // ---- Main thread ---------------------------------------------------------------------------------------------

    private fun applyPending() {
        val start = System.nanoTime()
        val bytes = ZnNative.takeBatch(runtime) ?: return
        val ops = BatchReader.read(bytes)
        ZnStore.apply(ops)
        val end = System.nanoTime()
        for (l in listeners.toList()) l.onApplied(ops.size, start, end)
    }

    private fun checkStarted() =
        check(started) { "ZnRuntime.start() must be called first (from Application.onCreate)" }
}
