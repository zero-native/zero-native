package dev.zeronative.runtime

import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.Executors
import org.json.JSONObject

/** The answer to one native call. Call exactly one of the two, from any thread. */
interface ZnReply {
    /** [value]: null, Boolean, Number, String, JSONObject or JSONArray. */
    fun ok(value: Any?)
    fun error(message: String)
}

/**
 * A native module JS can call (ARCHITECTURE §15.1): `callNative("os", "upiApps", {...})` in JS ends up in
 * [call] with method "upiApps". Runs on the I/O pool unless [onMainThread]; it must never block the UI thread.
 */
interface ZnModule {
    val name: String
    val onMainThread: Boolean get() = false
    fun call(method: String, args: JSONObject, reply: ZnReply)
}

/**
 * Registered native modules and the call path: JS `__zn_call` → C++ → [call] (on the JS thread) → the module, on the
 * I/O pool → the reply goes back to JS as app event 7 (`{ id, ok, value | error }`), which resolves the JS Promise
 * (packages/core/src/calls.ts). The JS thread and the UI thread never wait for a module.
 */
object ZnModules {
    private const val TAG = "zn"
    private const val APP = 0
    private const val EVENT_RESULT = 7

    private val modules = HashMap<String, ZnModule>()
    private val io = Executors.newFixedThreadPool(2) { r -> Thread(r, "zn-call").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())

    /** Registers [module] under its name (the app, or the runtime for built-ins). Replaces one with the same name. */
    @Synchronized
    fun register(module: ZnModule) {
        modules[module.name] = module
    }

    internal fun call(module: String, method: String, argsJson: String, callbackId: Int) {
        val m = synchronized(this) { modules[module] }
        val reply = Reply(callbackId, "$module.$method")
        if (m == null) return reply.error("no native module \"$module\"")
        val args = try {
            JSONObject(argsJson.ifEmpty { "{}" })
        } catch (e: Exception) {
            return reply.error("$module.$method: arguments are not a JSON object")
        }
        val run = Runnable {
            try {
                m.call(method, args, reply)
            } catch (e: Exception) {
                Log.e(TAG, "$module.$method threw", e)
                reply.error("$module.$method failed: ${e.message ?: e::class.java.simpleName}")
            }
        }
        if (m.onMainThread) main.post(run) else io.execute(run)
    }

    private class Reply(private val id: Int, private val what: String) : ZnReply {
        @Volatile private var done = false

        override fun ok(value: Any?) = send(JSONObject().put("id", id).put("ok", true).put("value", value ?: JSONObject.NULL))

        override fun error(message: String) = send(JSONObject().put("id", id).put("ok", false).put("error", message))

        private fun send(payload: JSONObject) {
            if (done) {
                Log.w(TAG, "$what replied twice; the second reply is ignored")
                return
            }
            done = true
            ZnRuntime.dispatchEvent(APP, EVENT_RESULT, payload.toString())
        }
    }
}
