package dev.zeronative.sample

import android.app.Application
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import dev.zeronative.plugins.analytics.AnalyticsPlugin
import dev.zeronative.plugins.auth.AuthPlugin
import dev.zeronative.plugins.crashlytics.CrashlyticsPlugin
import dev.zeronative.plugins.devicetest.DeviceTestPlugin
import dev.zeronative.plugins.firebase.FirebaseAppPlugin
import dev.zeronative.plugins.location.LocationPlugin
import dev.zeronative.plugins.lottie.LottiePlugin
import dev.zeronative.plugins.media.MediaPlugin
import dev.zeronative.plugins.pdf.PdfPlugin
import dev.zeronative.plugins.perf.PerfPlugin
import dev.zeronative.plugins.push.PushPlugin
import dev.zeronative.plugins.remoteconfig.RemoteConfigPlugin
import dev.zeronative.plugins.scanner.ScannerPlugin
import dev.zeronative.plugins.webview.WebViewPlugin
import dev.zeronative.runtime.ZnBundles
import dev.zeronative.runtime.ZnOta
import dev.zeronative.runtime.ZnPlugins
import dev.zeronative.runtime.ZnRuntime
import dev.zeronative.runtime.ZnTemplates

/** The sample's OTA public key (examples/sample/zn-ota.json; id 1947e1d330fa4904). */
private const val SAMPLE_OTA_KEY =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEyDRVX10DZWMDeefhkH4saosxvE6AwYffTsDANIEemGkrKcGD/8Cj5SEzM0NZVjWHWl0Y1hTlsVxJQBdqxIvfxw=="

class SampleApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Everything below only posts work to other threads and returns at once (startup rules).
        // Plugins first: choosing the bundle (an OTA one needs their modules) starts with preload / eval.
        ZnPlugins.register(this, DeviceTestPlugin(), ScannerPlugin(), MediaPlugin(), AuthPlugin(), WebViewPlugin())
        ZnPlugins.register(this, PdfPlugin()) // its own line, so plugins added in parallel merge cleanly
        ZnPlugins.register(this, LocationPlugin())
        ZnPlugins.register(this, FirebaseAppPlugin()) // Firebase.app() and Installations for JS
        // JS errors, OTA outcomes, bundle and route keys go to Crashlytics by themselves. Off with no google-services.json.
        ZnPlugins.register(this, CrashlyticsPlugin())
        ZnPlugins.register(this, PushPlugin())
        ZnPlugins.register(this, AnalyticsPlugin()) // on from the first start; screen views by route
        ZnPlugins.register(this, RemoteConfigPlugin())
        ZnPlugins.register(this, PerfPlugin()) // before the first fetch: it adds an interceptor to core's client
        ZnPlugins.register(this, LottiePlugin())
        // Every JS error, hang or start failure, with the screen and the running bundle: where an app would call
        // Crashlytics' recordException(e.asThrowable()). The sample logs the full JS stack (with columns: the exact
        // TSX line with `bun run ota symbolicate`) and the Throwable a crash reporter would get.
        ZnRuntime.onJsError = { e ->
            Log.w("zn-sample", "onJsError kind=${e.kind} where=${e.where} screen=${e.screen} bundle=${e.bundleLabel}:\n${e.details}",
                e.asThrowable())
        }
        // The bundle that runs, at start and after an update or rollback switches it: an app would set it as a
        // Crashlytics custom key (setCustomKey("zn_bundle", it)), so every crash says which bundle it came from.
        ZnBundles.watchRunning { Log.i("zn-sample", "running bundle $it") }
        // Debug builds only: `adb shell setprop debug.zn.js_time_limit_ms 60000` changes the JS time limit (3 s in
        // debug builds), e.g. to pause in a debugger. Reset with `adb shell setprop debug.zn.js_time_limit_ms 0`.
        if (BuildConfig.DEBUG) {
            systemProperty("debug.zn.js_time_limit_ms")?.toIntOrNull()?.takeIf { it > 0 }?.let { ZnRuntime.jsTimeLimitMs = it }
            // `adb shell setprop debug.zn.ota_free_bytes 1000000` makes OTA see a nearly full phone (low-storage test,
            // step 4.9; read at start). Reset with `adb shell setprop debug.zn.ota_free_bytes 0`.
            systemProperty("debug.zn.ota_free_bytes")?.toLongOrNull()?.takeIf { it > 0 }?.let {
                ZnOta.freeSpaceOverride = it
                Log.w("zn-sample", "OTA sees $it bytes free (debug.zn.ota_free_bytes)")
            }
        }
        // OTA updates from the reference server on this computer (`bun run ota serve`, reached over
        // `adb reverse tcp:8790 tcp:8790`), staging channel, signed with the sample's key (`bun run ota keygen`; the
        // private key stays in ~/.zero-native/keys). A real app uses its HTTPS server and a main + backup key.
        ZnOta.configure(this, ZnOta.Config(
            server = "http://127.0.0.1:8790",
            channel = "staging",
            publicKeys = listOf(SAMPLE_OTA_KEY),
            // Every update outcome (rollbacks and blocked bundles too): where an app would log to Crashlytics, e.g.
            // recordException for a serious one. The sample only logs it.
            onReport = { r -> Log.println(if (r.serious) Log.WARN else Log.INFO, "zn-sample", "onReport $r (serious=${r.serious})") },
        ))
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
