package dev.zeronative.runtime

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * One call from JS to a native module. Finish it exactly once with [resolve] or [reject], from any thread.
 * [isCancelled] turns true if JS gives up (AbortSignal, or the screen that asked closed); then any answer is dropped,
 * so long work should check it, or stop in [onCancel].
 */
interface ZnCall {
    val args: JSONObject
    /** Binary input from JS (an ArrayBuffer or typed array passed to `callNative` as `bytes`), or null. */
    val bytes: ByteArray?
    val isCancelled: Boolean

    /** [value]: null, Boolean, Number, String, JSONObject or JSONArray. */
    fun resolve(value: Any? = null)

    /**
     * Answers with binary data: JS gets `{ value, bytes }`, where `bytes` is a Uint8Array (no base64, no JSON
     * escaping; copied once on the way to JS). For bodies, files, images.
     */
    fun resolveBytes(value: Any?, bytes: ByteArray)

    /** [code]: "invalid_args", "failed", "unavailable", or the module's own code; JS gets NativeError(code, message). */
    fun reject(code: String, message: String)

    /** Runs [block] (once, on any thread) if JS cancels this call. Runs at once if it already did. */
    fun onCancel(block: () -> Unit)
}

/** A wrong or missing argument, from the helpers below: JS gets NativeError("invalid_args", ...). */
class ZnInvalidArgs(message: String) : Exception(message)

/**
 * Typed arguments: `call.string("uri")`, `call.intOrNull("limit") ?: 20`. The plain form rejects the call if the value
 * is missing; the `OrNull` form gives null for a missing value or a JS null. A value of the wrong type rejects in both:
 * a number is not a string, and 1.5 is not an int. Read them at the top of the function: [ZnInvalidArgs] only rejects
 * the call from the function's own thread.
 */
fun ZnCall.stringOrNull(name: String): String? = arg(name)?.let { it as? String ?: throw wrongType(name, "a string", it) }
fun ZnCall.booleanOrNull(name: String): Boolean? = arg(name)?.let { it as? Boolean ?: throw wrongType(name, "a boolean", it) }
fun ZnCall.doubleOrNull(name: String): Double? = arg(name)?.let { (it as? Number ?: throw wrongType(name, "a number", it)).toDouble() }
fun ZnCall.intOrNull(name: String): Int? = whole(name, Int.MIN_VALUE.toLong(), Int.MAX_VALUE.toLong(), "an int")?.toInt()
fun ZnCall.longOrNull(name: String): Long? = whole(name, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER, "a whole number")

fun ZnCall.string(name: String): String = stringOrNull(name) ?: throw missing(name)
fun ZnCall.boolean(name: String): Boolean = booleanOrNull(name) ?: throw missing(name)
fun ZnCall.double(name: String): Double = doubleOrNull(name) ?: throw missing(name)
fun ZnCall.int(name: String): Int = intOrNull(name) ?: throw missing(name)
fun ZnCall.long(name: String): Long = longOrNull(name) ?: throw missing(name)

/** JS numbers are exact only up to here (Number.MAX_SAFE_INTEGER), so a bigger one has already lost digits. */
private const val MAX_SAFE_INTEGER = 9007199254740991L

private fun ZnCall.arg(name: String): Any? = args.opt(name).takeUnless { it == JSONObject.NULL }

private fun ZnCall.whole(name: String, min: Long, max: Long, type: String): Long? {
    val value = arg(name) ?: return null
    val number = (value as? Number)?.toDouble() ?: throw wrongType(name, type, value)
    if (number != Math.rint(number) || number < min || number > max) throw wrongType(name, type, value)
    return number.toLong()
}

private fun missing(name: String) = ZnInvalidArgs("\"$name\" is missing")
private fun wrongType(name: String, type: String, value: Any) = ZnInvalidArgs("\"$name\" must be $type, got $value")

/**
 * A native module JS can call (ARCHITECTURE §15.1, docs/native-modules.md). Most modules extend [ZnModuleBase]
 * instead of implementing this directly.
 */
interface ZnModule {
    val name: String
    /** Raised when the module gains methods or changes behaviour; JS declares the lowest version it needs. */
    val version: Int get() = 1

    /** True: [call] runs on the main thread (UI work: starting activities). Default: the I/O pool. */
    fun runsOnMain(method: String): Boolean = false

    fun call(method: String, call: ZnCall)

    /** How many JS listeners [event] has now (sent on every change). Start or stop the source accordingly. */
    fun onListenerCount(event: String, count: Int) {}
}

/**
 * A module as a table of named functions:
 *
 *     class DeviceModule : ZnModuleBase("Device", version = 1) {
 *         init {
 *             function("info") { it.resolve(JSONObject().put("model", Build.MODEL)) }
 *             function("open", onMain = true) { ... }
 *         }
 *         override fun onListenerCount(event: String, count: Int) { if (count > 0) start() else stop() }
 *         private fun tick(n: Int) = emit("tick", n, latestOnly = true)
 *     }
 *
 * Unknown methods are rejected with "unavailable"; an exception in a function rejects with "failed"; a wrong argument
 * read with the typed helpers ([string], [int]) rejects with "invalid_args".
 */
abstract class ZnModuleBase(override val name: String, override val version: Int = 1) : ZnModule {
    private class Fn(val onMain: Boolean, val body: (ZnCall) -> Unit)
    private val fns = HashMap<String, Fn>()

    protected fun function(method: String, onMain: Boolean = false, body: (ZnCall) -> Unit) {
        fns[method] = Fn(onMain, body)
    }

    override fun runsOnMain(method: String) = fns[method]?.onMain == true

    override fun call(method: String, call: ZnCall) {
        val fn = fns[method] ?: return call.reject("unavailable", "$name has no method \"$method\"")
        fn.body(call)
    }

    /** Sends [event] to JS listeners. [latestOnly]: if JS is busy, only the newest value of this event is delivered. */
    protected fun emit(event: String, payload: Any? = null, latestOnly: Boolean = false) =
        ZnModules.emit(name, event, payload, latestOnly)
}

/**
 * Registered native modules and the call path: JS `__zn_call` → C++ → [call] (on the JS thread) → the module, on the
 * I/O pool or the main thread → the answer goes back to JS as app event 7 (`{ id, ok, value | code, error }`), which
 * settles the JS Promise (packages/core/src/calls.ts); an answer with bytes goes as app event 9, one ArrayBuffer
 * (ZnNative.dispatchBytes). JS `__zn_cancel` → [cancel]. Module events → app event 8.
 * The JS thread and the UI thread never wait for a module.
 */
object ZnModules {
    private const val TAG = "zn"
    private const val APP = 0
    private const val EVENT_RESULT = ZnAppEvent.CALL_RESULT
    private const val EVENT_MODULE = ZnAppEvent.MODULE_EVENT
    private const val EVENT_RESULT_BYTES = ZnAppEvent.CALL_RESULT_BYTES
    private const val NO_REPLY = 0

    private val modules = ConcurrentHashMap<String, ZnModule>()
    private val active = ConcurrentHashMap<Int, CallImpl>()
    private val latest = HashMap<String, String>() // module\u0000event → newest payload JSON (latestOnly events)
    private val listening = HashMap<String, Int>() // module\u0000event → JS listener count; main thread only
    private val io = Executors.newFixedThreadPool(2) { r -> Thread(r, "zn-call").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    /** Set once the running bundle is chosen: the module list has been compared with the bundle's needs. */
    @Volatile private var chosen = false

    init {
        // Built-in modules are always there, whatever order the app starts things in: the bundle check needs them.
        // Their setup with a Context (ZnFetch.init, ZnSecureStore.init) stays in ZnRuntime.start.
        for (m in listOf<ZnModule>(ZnKeyboard, ZnFetch, ZnSecureStore, ZnToast, ZnOta.Module, ZnPermissions, ZnLaunch, ZnOs)) modules[m.name] = m
    }

    /**
     * Registers [module] under its name (the app's own modules). Replaces one with the same name. Call it in
     * Application.onCreate **before** `ZnTemplates.preload` / `ZnRuntime.evalAsset`: the OTA check compares the
     * modules registered by then with what a downloaded bundle needs (docs/ota.md §3.2).
     */
    fun register(module: ZnModule) {
        if (chosen && modules[module.name]?.version != module.version) {
            val message = "native module ${module.name} v${module.version} was registered after the running bundle " +
                "was chosen; register native modules before ZnTemplates.preload / ZnRuntime.evalAsset"
            if (BuildConfig.DEBUG) throw IllegalStateException(message)
            Log.e(TAG, message)
        }
        modules[module.name] = module
    }

    /** True if a module has this name (built-in or registered). */
    internal fun has(name: String) = modules.containsKey(name)

    /** Module name → version, for the capability check. Marks the module list as used ([register] warns after). */
    internal fun versions(): Map<String, Int> {
        chosen = true
        return modules.mapValues { it.value.version }
    }

    /** Sends a module event to JS (any thread). See [ZnModuleBase.emit]. */
    fun emit(module: String, event: String, payload: Any?, latestOnly: Boolean) {
        val json = JSONObject().put("module", module).put("event", event).put("payload", payload ?: JSONObject.NULL).toString()
        if (!latestOnly) return ZnRuntime.dispatchEvent(APP, EVENT_MODULE, json)
        val key = "$module\u0000$event"
        val first = synchronized(latest) { latest.put(key, json) == null }
        // One delivery is queued at a time per event; it takes whatever is newest when the JS thread gets to it.
        if (first) ZnRuntime.dispatchLatest(APP, EVENT_MODULE) { synchronized(latest) { latest.remove(key) } }
    }

    /** JS thread (called through ZnNative). */
    internal fun call(module: String, method: String, argsJson: String, bytes: ByteArray?, callbackId: Int) {
        val m = modules[module]
        // Answers belong to the runtime that asked: after a dev reload they are dropped, never sent to the new one.
        val generation = ZnRuntime.currentGeneration
        val args = try {
            JSONObject(argsJson.ifEmpty { "{}" })
        } catch (e: Exception) {
            if (callbackId != NO_REPLY) CallImpl(callbackId, "$module.$method", JSONObject(), null, generation).reject("invalid_args", "arguments are not a JSON object")
            return
        }
        // Internal: JS listener counts for module events (no reply).
        if (method == "__listeners") {
            if (m != null) main.post {
                val event = args.optString("event")
                val count = args.optInt("count")
                if (count > 0) listening["$module\u0000$event"] = count else listening.remove("$module\u0000$event")
                m.onListenerCount(event, count)
            }
            return
        }
        val call = CallImpl(callbackId, "$module.$method", args, bytes, generation)
        if (m == null) return call.reject("unavailable", "no native module \"$module\" in this app")
        val needs = args.optInt("__v", 1)
        args.remove("__v")
        if (m.version < needs) {
            return call.reject("unavailable", "this app has $module v${m.version}; the code needs v$needs")
        }
        active[callbackId] = call
        val run = Runnable {
            if (call.isCancelled) return@Runnable
            try {
                m.call(method, call)
            } catch (e: ZnInvalidArgs) {
                call.reject("invalid_args", "$module.$method: ${e.message}")
            } catch (e: Exception) {
                Log.e(TAG, "$module.$method threw", e)
                call.reject("failed", "$module.$method failed: ${e.message ?: e::class.java.simpleName}")
            }
        }
        if (m.runsOnMain(method)) main.post(run) else io.execute(run)
    }

    internal fun cancel(callbackId: Int) {
        active.remove(callbackId)?.cancel()
    }

    /**
     * Debug builds (`zn dev` reload), main thread: the old JS is gone, so every running call is cancelled (its answer
     * is dropped) and every event source is told it has no listeners left.
     */
    internal fun resetForReload() {
        for (id in active.keys.toList()) cancel(id)
        for ((key, _) in listening.toList()) {
            val (module, event) = key.split('\u0000', limit = 2)
            modules[module]?.onListenerCount(event, 0)
        }
        listening.clear()
        synchronized(latest) { latest.clear() }
    }

    private class CallImpl(
        private val id: Int,
        private val what: String,
        override val args: JSONObject,
        override val bytes: ByteArray?,
        private val generation: Int,
    ) : ZnCall {
        @Volatile private var done = false
        @Volatile override var isCancelled = false
            private set
        private val cancelHooks = ArrayList<() -> Unit>()

        override fun resolve(value: Any?) =
            send(JSONObject().put("id", id).put("ok", true).put("value", value ?: JSONObject.NULL))

        override fun reject(code: String, message: String) =
            send(JSONObject().put("id", id).put("ok", false).put("code", code).put("error", message))

        override fun resolveBytes(value: Any?, bytes: ByteArray) =
            send(JSONObject().put("id", id).put("ok", true).put("value", value ?: JSONObject.NULL), bytes)

        override fun onCancel(block: () -> Unit) {
            val runNow = synchronized(cancelHooks) {
                if (!isCancelled) cancelHooks += block
                isCancelled
            }
            if (runNow) block()
        }

        fun cancel() {
            val hooks = synchronized(cancelHooks) {
                isCancelled = true
                cancelHooks.toList().also { cancelHooks.clear() }
            }
            hooks.forEach { runCatching(it).onFailure { e -> Log.e(TAG, "$what: onCancel threw", e) } }
        }

        private fun send(payload: JSONObject, body: ByteArray? = null) {
            synchronized(this) {
                if (done) {
                    Log.w(TAG, "$what answered twice; the second answer is ignored")
                    return
                }
                done = true
            }
            active.remove(id)
            if (isCancelled || id == NO_REPLY) return // JS gave up on it: drop the answer
            if (body == null) ZnRuntime.dispatchAnswer(EVENT_RESULT, payload.toString(), generation)
            else ZnRuntime.dispatchAnswerBytes(EVENT_RESULT_BYTES, payload.toString().toByteArray(), body, generation)
        }
    }
}
