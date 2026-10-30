package dev.zeronative.sample

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import dev.zeronative.runtime.ZnModules
import dev.zeronative.runtime.ZnRuntime
import dev.zeronative.runtime.ZnTemplates

class SampleApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Everything below only posts work to other threads and returns at once (startup rules).
        ZnTemplates.preload(this, "main.zn.ui")
        ZnRuntime.start(this)
        ZnModules.register(DeviceModule(this)) // the sample's own native module (src/device.ts)
        // Registered before JS runs, so the first batch is never missed (it can land before MainActivity exists).
        ZnRuntime.addBatchListener { ops, _, _ ->
            if (!firstBatchApplied) {
                firstBatchApplied = true
                Log.i("zn-sample", "first JS batch applied ${SystemClock.uptimeMillis() - Process.getStartUptimeMillis()} ms after process start ($ops ops)")
            }
        }

        // Debug builds only: `adb shell setprop debug.zn.js_delay_ms 2000` delays JS, to watch the template's
        // skeleton draw on its own. Reset with `adb shell setprop debug.zn.js_delay_ms 0`.
        val delay = if (BuildConfig.DEBUG) systemProperty("debug.zn.js_delay_ms")?.toLongOrNull() ?: 0L else 0L
        if (delay > 0) {
            Log.w("zn-sample", "delaying JS by $delay ms (debug.zn.js_delay_ms)")
            Handler(Looper.getMainLooper()).postDelayed({ ZnRuntime.evalAsset("main.hbc") }, delay)
        } else {
            ZnRuntime.evalAsset("main.hbc")
        }
    }

    companion object {
        /** True once JS's first batch is on screen state (main thread only). */
        var firstBatchApplied = false
            private set
    }

    private fun systemProperty(name: String): String? = try {
        Class.forName("android.os.SystemProperties").getMethod("get", String::class.java)
            .invoke(null, name) as String?
    } catch (_: Exception) {
        null
    }
}
