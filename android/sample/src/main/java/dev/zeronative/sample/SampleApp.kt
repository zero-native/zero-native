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
        // The app's own native modules first: choosing the bundle (an OTA one needs them) starts with preload / eval.
        ZnModules.register(DeviceModule(this)) // the sample's own native module (src/device.ts)
        // Every JS error, hang or start failure, with the screen and the running bundle: where an app would call
        // Crashlytics' recordException. The sample only logs it.
        ZnRuntime.onJsError = { e ->
            Log.w("zn-sample", "onJsError kind=${e.kind} where=${e.where} screen=${e.screen} bundle=${e.bundle}: " +
                e.details.substringBefore('\n'))
        }
        // Debug builds only: `adb shell setprop debug.zn.js_time_limit_ms 60000` changes the JS time limit (3 s in
        // debug builds), e.g. to pause in a debugger. Reset with `adb shell setprop debug.zn.js_time_limit_ms 0`.
        if (BuildConfig.DEBUG) {
            systemProperty("debug.zn.js_time_limit_ms")?.toIntOrNull()?.takeIf { it > 0 }?.let { ZnRuntime.jsTimeLimitMs = it }
        }
        ZnTemplates.preload(this, "main.zn.ui")
        ZnRuntime.start(this)
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
