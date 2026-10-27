package dev.zeronative.exp2

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap

object ZnBridge {
    private const val TAG = "zn"

    init {
        System.loadLibrary("zn")
    }

    private var jsThread: HandlerThread? = null
    private var jsHandler: Handler? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    private val activeTimers = ConcurrentHashMap<Int, Runnable>()

    var onJsErrorListener: ((String) -> Unit)? = null

    fun start() {
        if (jsThread != null) return
        val thread = HandlerThread("zn-js").apply { start() }
        jsThread = thread
        val handler = Handler(thread.looper)
        jsHandler = handler

        handler.post {
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

    fun destroy() {
        val handler = jsHandler
        handler?.post {
            nativeDestroy()
        }
        jsThread?.quitSafely()
        jsThread = null
        jsHandler = null
        activeTimers.clear()
    }

    // --- JNI Callbacks from C++ Host Functions ---

    @JvmStatic
    fun onFlush(opsJson: String) {
        // Called on "zn-js" thread from __zn_flush. Post to Main Thread Looper!
        mainHandler.post {
            NodeStore.applyBatch(opsJson)
        }
    }

    @JvmStatic
    fun onJsError(msg: String) {
        Log.e(TAG, "JS Error reported to Kotlin: $msg")
        mainHandler.post {
            onJsErrorListener?.invoke(msg)
        }
    }

    @JvmStatic
    fun postTimer(id: Int, delayMs: Long) {
        val handler = jsHandler ?: return
        val runnable = Runnable {
            activeTimers.remove(id)
            nativeTimerFired(id)
        }
        activeTimers[id] = runnable
        handler.postDelayed(runnable, delayMs)
    }

    @JvmStatic
    fun clearTimer(id: Int) {
        val runnable = activeTimers.remove(id) ?: return
        jsHandler?.removeCallbacks(runnable)
    }

    // --- Native JNI declarations ---

    @JvmStatic private external fun nativeInit()
    @JvmStatic private external fun nativeEvalBytecode(bytecode: ByteArray, sourceUrl: String): Boolean
    @JvmStatic private external fun nativeDispatchEvent(nodeId: Int, eventName: String, payloadJson: String)
    @JvmStatic private external fun nativeTimerFired(timerId: Int)
    @JvmStatic private external fun nativeDestroy()
}
