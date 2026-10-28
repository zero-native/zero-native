package dev.zeronative.exp4

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log

object ZnBridge {
    private const val TAG = "zn"

    init {
        try {
            System.loadLibrary("zn")
            Log.i(TAG, "libzn.so loaded successfully in exp3")
        } catch (e: UnsatisfiedLinkError) {
            Log.e(TAG, "Failed to load libzn.so in exp3", e)
        }
    }

    private var jsThread: HandlerThread? = null
    private var jsHandler: Handler? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val activeTimers = HashMap<Int, Runnable>()

    private var appContext: Context? = null
    var onLaunchUpiListener: ((pkg: String, name: String, toPayPaise: Long) -> Unit)? = null

    fun setContext(context: Context) {
        appContext = context.applicationContext
    }

    fun init() {
        var thread = jsThread
        if (thread == null || !thread.isAlive) {
            thread = HandlerThread("zn-js")
            thread.start()
            jsThread = thread
            jsHandler = Handler(thread.looper)
        }

        jsHandler?.post {
            nativeInit()
        }
    }

    fun evalAssetBytecode(context: Context, assetName: String, onComplete: ((Boolean) -> Unit)? = null) {
        val handler = jsHandler ?: run {
            Log.e(TAG, "Cannot eval asset, jsHandler is null")
            onComplete?.invoke(false)
            return
        }

        handler.post {
            try {
                val bytes = context.assets.open(assetName).use { it.readBytes() }
                val ok = nativeEvalBytecode(bytes, assetName)
                mainHandler.post { onComplete?.invoke(ok) }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to load asset bytecode $assetName", e)
                mainHandler.post { onComplete?.invoke(false) }
            }
        }
    }

    fun dispatchEvent(nodeId: Int, eventName: String, payloadJson: String = "{}") {
        jsHandler?.post {
            nativeDispatchEvent(nodeId, eventName, payloadJson)
        }
    }

    // --- Host Functions called from C++ ---

    @JvmStatic
    fun onHttp(reqId: Int, method: String, url: String, headersJson: String, bodyJson: String) {
        Thread {
            try {
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.requestMethod = method
                conn.connectTimeout = 3000
                conn.readTimeout = 3000
                if (headersJson.isNotEmpty() && headersJson != "{}") {
                    val headersObj = org.json.JSONObject(headersJson)
                    for (k in headersObj.keys()) {
                        conn.setRequestProperty(k, headersObj.getString(k))
                    }
                }
                if (method == "POST" || method == "PUT") {
                    conn.doOutput = true
                    conn.setRequestProperty("Content-Type", "application/json")
                    if (bodyJson.isNotEmpty()) {
                        conn.outputStream.use { os ->
                            os.write(bodyJson.toByteArray(Charsets.UTF_8))
                        }
                    }
                }
                val code = conn.responseCode
                val stream = if (code in 200..299) conn.inputStream else conn.errorStream
                val responseText = stream?.bufferedReader()?.use { it.readText() } ?: ""
                conn.disconnect()

                jsHandler?.post {
                    nativeHttpResponse(reqId, code, responseText, "")
                }
            } catch (e: Exception) {
                Log.e(TAG, "[HTTP_ERROR] $method $url failed", e)
                jsHandler?.post {
                    nativeHttpResponse(reqId, 0, "", e.message ?: "Network error")
                }
            }
        }.start()
    }

    @JvmStatic
    fun onFlowSave(flowJson: String) {
        val ctx = appContext ?: return
        try {
            val name = org.json.JSONObject(flowJson).optString("name", "flow")
            val store = FlowStore.getStore(ctx.filesDir, name)
            store.write(flowJson)
            Log.i(TAG, "[FlowStore] Persisted flow '$name' (${flowJson.length} bytes)")
        } catch (e: Exception) {
            Log.e(TAG, "[FlowStore] Error saving flow", e)
        }
    }

    @JvmStatic
    fun onFlowLoad(name: String): String? {
        val ctx = appContext ?: return null
        return try {
            val store = FlowStore.getStore(ctx.filesDir, name)
            store.read()
        } catch (e: Exception) {
            Log.e(TAG, "[FlowStore] Error loading flow '$name'", e)
            null
        }
    }

    @JvmStatic
    fun onFlowDelete(name: String) {
        val ctx = appContext ?: return
        try {
            val store = FlowStore.getStore(ctx.filesDir, name)
            store.delete()
            Log.i(TAG, "[FlowStore] Deleted flow '$name'")
        } catch (e: Exception) {
            Log.e(TAG, "[FlowStore] Error deleting flow '$name'", e)
        }
    }

    @JvmStatic
    fun onFlush(opsJson: String) {
        mainHandler.post {
            NodeStore.applyBatch(opsJson)
        }
    }

    @JvmStatic
    fun onLaunchUpi(pkg: String, name: String, toPayPaise: Long) {
        mainHandler.post {
            Log.i(TAG, "[UPI_DISPATCH] Launch requested for $pkg ($name), toPay=$toPayPaise paise")
            onLaunchUpiListener?.invoke(pkg, name, toPayPaise)
        }
    }

    @JvmStatic
    fun onJsError(msg: String) {
        Log.e(TAG, "[JS_ERROR] $msg")
    }

    @JvmStatic
    fun postTimer(timerId: Int, delayMs: Long) {
        val runnable = Runnable {
            activeTimers.remove(timerId)
            jsHandler?.post {
                nativeTimerFired(timerId)
            }
        }
        activeTimers[timerId] = runnable
        jsHandler?.postDelayed(runnable, delayMs)
    }

    @JvmStatic
    fun clearTimer(timerId: Int) {
        val runnable = activeTimers.remove(timerId)
        if (runnable != null) {
            jsHandler?.removeCallbacks(runnable)
        }
    }

    fun destroy() {
        val thread = jsThread
        jsHandler?.post {
            nativeDestroy()
        }
        thread?.quitSafely()
        jsThread = null
        jsHandler = null
        activeTimers.clear()
    }

    // --- Native JNI declarations ---
    @JvmStatic
    private external fun nativeInit()

    @JvmStatic
    private external fun nativeEvalBytecode(bytecode: ByteArray, sourceUrl: String): Boolean

    @JvmStatic
    private external fun nativeDispatchEvent(nodeId: Int, eventName: String, payloadJson: String)

    @JvmStatic
    private external fun nativeTimerFired(timerId: Int)

    @JvmStatic
    private external fun nativeHttpResponse(reqId: Int, statusCode: Int, body: String, error: String)

    @JvmStatic
    private external fun nativeDestroy()
}

