package dev.zeronative.exp3

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

    private val jsThread = HandlerThread("zn-js")
    private var jsHandler: Handler? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private val activeTimers = HashMap<Int, Runnable>()

    var onLaunchUpiListener: ((pkg: String, name: String, toPayPaise: Long) -> Unit)? = null

    fun init() {
        val thread = jsThread
        if (!thread.isAlive) {
            thread.start()
        }
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

    // --- Host Functions called from C++ ---

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
        jsHandler?.post {
            nativeDestroy()
        }
        jsThread.quitSafely()
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
    private external fun nativeDestroy()
}
