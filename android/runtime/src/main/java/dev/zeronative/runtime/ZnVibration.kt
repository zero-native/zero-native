package dev.zeronative.runtime

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import org.json.JSONArray

/**
 * The built-in Vibration module: React Native's `Vibration` (packages/core/src/vibration.ts). As in RN, the app must
 * declare the VIBRATE permission itself; without it every call is rejected with "not_declared".
 */
internal object ZnVibration : ZnModuleBase("Vibration", version = 1) {
    private lateinit var app: Context

    const val NOT_DECLARED = "Vibration needs <uses-permission android:name=\"android.permission.VIBRATE\"/> " +
        "in the app's AndroidManifest.xml"

    /** Main process, once. */
    fun init(context: Context) {
        app = context.applicationContext
    }

    /**
     * The pattern JS sent, in ms: [wait, vibrate, wait, vibrate, ...]. Every value a whole number, 0 or more
     * (ZnVibrationTest).
     */
    fun timings(pattern: JSONArray): LongArray = LongArray(pattern.length()) { i ->
        val value = pattern.opt(i)
        val ms = (value as? Number)?.toDouble() ?: throw ZnInvalidArgs("\"pattern\" must hold numbers, got $value")
        if (ms.isNaN() || ms < 0 || ms != Math.rint(ms) || ms > Long.MAX_VALUE) {
            throw ZnInvalidArgs("\"pattern\" must hold whole numbers of ms, 0 or more, got $value")
        }
        ms.toLong()
    }

    /** True if the pattern never turns the motor on: no "vibrate" step (odd index) longer than 0. */
    fun isSilent(timings: LongArray): Boolean = timings.indices.none { it % 2 == 1 && timings[it] > 0 }

    private fun declared() = app.checkSelfPermission(Manifest.permission.VIBRATE) == PackageManager.PERMISSION_GRANTED

    private fun vibrator(): Vibrator? =
        if (Build.VERSION.SDK_INT >= 31) app.getSystemService(VibratorManager::class.java)?.defaultVibrator
        else @Suppress("DEPRECATION") app.getSystemService(Vibrator::class.java)

    init {
        // Resolves true if the phone vibrates, false if it has no vibrator (or the pattern has nothing to feel).
        function("vibrate") { call ->
            val pattern = call.args.optJSONArray("pattern") ?: throw ZnInvalidArgs("\"pattern\" must be an array of ms")
            val timings = timings(pattern)
            val repeat = if (call.booleanOrNull("repeat") == true) 0 else -1 // 0: again from the start, until cancel()
            if (!declared()) return@function call.reject("not_declared", NOT_DECLARED)
            val vibrator = vibrator()
            if (vibrator == null || !vibrator.hasVibrator() || isSilent(timings)) return@function call.resolve(false)
            buzz(vibrator, timings, repeat)
            call.resolve(true)
        }

        function("cancel") { call ->
            if (!declared()) return@function call.reject("not_declared", NOT_DECLARED)
            vibrator()?.let(::stop)
            call.resolve(true)
        }
    }

    // The runtime doesn't declare VIBRATE (the app does, as in React Native), so lint can't see it: callers check declared().
    @SuppressLint("MissingPermission")
    private fun buzz(vibrator: Vibrator, timings: LongArray, repeat: Int) {
        if (Build.VERSION.SDK_INT >= 26) vibrator.vibrate(VibrationEffect.createWaveform(timings, repeat))
        else @Suppress("DEPRECATION") vibrator.vibrate(timings, repeat)
    }

    @SuppressLint("MissingPermission")
    private fun stop(vibrator: Vibrator) = vibrator.cancel()
}
