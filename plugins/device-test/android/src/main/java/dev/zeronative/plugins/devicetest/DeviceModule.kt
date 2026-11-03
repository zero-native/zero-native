package dev.zeronative.plugins.devicetest

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import dev.zeronative.runtime.ZnBackground
import dev.zeronative.runtime.ZnHandles
import dev.zeronative.runtime.ZnLaunch
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnStorage
import dev.zeronative.runtime.intOrNull
import dev.zeronative.runtime.longOrNull
import dev.zeronative.runtime.string
import java.io.File
import org.json.JSONObject

/**
 * A demo native module for the sample app (milestone 2 step 2.6, native module foundations). Shows each part:
 * a plain call (info), a slow call that can be cancelled (slowEcho), an error with a code (fail), and an event
 * (tick, every 50 ms with latestOnly) that only runs while JS listens. JS side: ../../src/index.ts of this plugin.
 */
class DeviceModule(private val context: Context) : ZnModuleBase("Device", version = 5) {
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
            val text = call.string("text")
            val until = SystemClock.uptimeMillis() + (call.longOrNull("ms") ?: 1000)
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

        // v2: debug builds only, for testing the OTA launch watchdog (step 4.7): the app crashes (an uncaught Kotlin
        // exception on the main thread), as a broken native call would. Release builds refuse it.
        function("crash", onMain = true) { call ->
            if (!BuildConfig.DEBUG) return@function call.reject("debug_only", "crash is for debug builds only")
            Log.w(TAG, "crash: crashing on purpose (Device.crash, debug test)")
            main.post { throw IllegalStateException("Device.crash: a crash on purpose (debug test of the OTA watchdog)") }
        }

        // v3: debug builds only, for testing a second Activity (docs/hardening-plan.md H.1): opens the mock UPI app
        // (test-kit/) for a result, so it sits on top of our task. Never a real UPI app: the package is fixed.
        // v4: through ZnLaunch, under the key "mock-upi", with the id JS gives.
        function("openMockUpi", onMain = true) { call ->
            if (!BuildConfig.DEBUG) return@function call.reject("debug_only", "openMockUpi is for debug builds only")
            val id = call.string("id")
            val pay = Uri.parse("upi://pay?pa=test@mock&pn=Mock&am=1.00&tr=$id&cu=INR")
            call.resolve(ZnLaunch.start("mock-upi", id, Intent(Intent.ACTION_VIEW, pay).setPackage("p2pdops.android.p2pupiapp")).toJson())
        }

        // v4: debug builds only: a launch of an app that isn't there, to test launched: false.
        function("openMissingApp", onMain = true) { call ->
            if (!BuildConfig.DEBUG) return@function call.reject("debug_only", "openMissingApp is for debug builds only")
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("zn-test://none")).setPackage("dev.zeronative.no.such.app")
            call.resolve(ZnLaunch.start("mock-missing", call.string("id"), intent).toJson())
        }

        // v5: runs a background task, as a plugin would.
        function("runTask") { call ->
            ZnBackground.run(call.string("name"), JSONObject().put("from", "lab"), call.longOrNull("timeoutMs") ?: 5_000) { outcome ->
                call.resolve(outcome.name)
            }
        }

        // v5: a small picture in the handle folder, and proof that a file outside it gets no handle.
        function("makeFile") { call ->
            val file = File(ZnHandles.fileDir(context), "lab-${SystemClock.uptimeMillis()}.png")
            val bitmap = Bitmap.createBitmap(48, 48, Bitmap.Config.ARGB_8888).apply { eraseColor(0xFF22AA66.toInt()) }
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            val refused = try {
                ZnHandles.file(context, File(context.filesDir, "secret"))
                false
            } catch (_: IllegalArgumentException) {
                true
            }
            call.resolve(JSONObject().put("handle", ZnHandles.file(context, file)).put("outsideRefused", refused))
        }

        // Storage shared with JS (step 3.5): reads what JS wrote, writes values JS then checks.
        function("storageEcho") { call ->
            val store = ZnStorage.store(context)
            val fromJs = store.getString("dev.fromJs")
            store.set("dev.fromKotlin", "$fromJs ← Kotlin")
            store.set("dev.kotlinNumber", 42.5)
            store.set("dev.kotlinFlag", true)
            val typeError = try {
                store.getNumber("dev.fromJs")
                "no error"
            } catch (e: IllegalStateException) {
                e.message
            }
            call.resolve(JSONObject().put("fromJs", fromJs).put("typeError", typeError))
        }

        // Like a push-notification handler writing while the app is in use: a background thread writes its own
        // counter and a key JS writes too, `count` times, while JS does the same on the JS thread.
        function("storageHammer") { call ->
            val count = call.intOrNull("count") ?: 20000
            val store = ZnStorage.store(context)
            val t0 = SystemClock.uptimeMillis()
            for (i in 1..count) {
                store.set("dev.hammer.kotlin", i)
                store.set("dev.hammer.shared", "kotlin $i:" + "k".repeat(i % 300) + ":$i")
            }
            call.resolve(JSONObject().put("count", count).put("ms", SystemClock.uptimeMillis() - t0))
        }
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
