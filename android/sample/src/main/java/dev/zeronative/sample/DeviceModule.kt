package dev.zeronative.sample

import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import dev.zeronative.runtime.ZnModuleBase
import org.json.JSONObject

/**
 * A demo native module for the sample app (milestone 2 step 2.6, native module foundations). Shows each part:
 * a plain call (info), a slow call that can be cancelled (slowEcho), an error with a code (fail), and an event
 * (tick, every 50 ms with latestOnly) that only runs while JS listens. JS side: examples/sample/src/device.ts.
 */
class DeviceModule : ZnModuleBase("Device", version = 1) {
    private val main = Handler(Looper.getMainLooper())
    private var ticks = 0
    private var ticking = false

    init {
        function("info") { call ->
            call.resolve(
                JSONObject().put("model", Build.MODEL).put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT),
            )
        }

        // Runs on the I/O pool. Long work checks isCancelled (or uses onCancel) so a cancelled call stops early.
        function("slowEcho") { call ->
            val text = call.args.optString("text")
            val until = SystemClock.uptimeMillis() + call.args.optLong("ms", 1000)
            while (SystemClock.uptimeMillis() < until) {
                if (call.isCancelled) {
                    Log.i(TAG, "slowEcho cancelled; stopped early")
                    return@function
                }
                Thread.sleep(20)
            }
            call.resolve(text)
        }

        function("fail") { call -> call.reject("no_luck", "this call always fails (demo)") }
    }

    // The tick source runs only while some screen listens.
    override fun onListenerCount(event: String, count: Int) {
        if (event != "tick") return
        if (count > 0 && !ticking) {
            ticking = true
            Log.i(TAG, "tick source started")
            main.post(tick)
        } else if (count == 0 && ticking) {
            ticking = false
            main.removeCallbacks(tick)
            Log.i(TAG, "tick source stopped (no listeners)")
        }
    }

    private val tick = object : Runnable {
        override fun run() {
            if (!ticking) return
            emit("tick", ++ticks, latestOnly = true)
            main.postDelayed(this, 50)
        }
    }

    private companion object {
        const val TAG = "zn-sample"
    }
}
