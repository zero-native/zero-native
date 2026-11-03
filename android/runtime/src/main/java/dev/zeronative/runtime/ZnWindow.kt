package dev.zeronative.runtime

import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Build
import android.util.DisplayMetrics
import android.view.Display
import org.json.JSONObject

/**
 * Facts about the phone, the window and the keyboard for JS (RN basics pack): `Platform`, `Dimensions`, `PixelRatio`
 * and `Keyboard` listeners (packages/core/src/platform.ts, dimensions.ts, keyboard.ts). All sizes are dp, as everywhere.
 * - DEVICE: fixed facts, sent once right after the main script (before any screen), so `Platform.Version` can be read
 *   in any screen or handler.
 * - WINDOW: the window's size, density and font scale. [ZnNavHost] measures it; until it has, a first value from the
 *   display goes with DEVICE.
 * - KEYBOARD: shown or hidden and its height, sent once per show or hide (not on every frame of its animation).
 */
internal object ZnWindow {
    /** The last WINDOW and KEYBOARD sent, so the same value is not sent twice. Written on the main thread. */
    @Volatile private var lastWindow = ""
    private var lastKeyboard = ""

    /** The pure part of DEVICE (ZnWindowTest). */
    fun deviceJson(sdk: Int, release: String, model: String, brand: String, manufacturer: String): String =
        JSONObject().put("sdk", sdk).put("release", release).put("model", model).put("brand", brand)
            .put("manufacturer", manufacturer).toString()

    /** One decimal: enough for dp, and small changes from rounding don't send events. */
    private fun r(v: Float) = Math.round(v * 10) / 10.0

    /** Three decimals: density and font scale must stay exact (2.75, 1.15) for PixelRatio's pixel math. */
    private fun r3(v: Float) = Math.round(v * 1000) / 1000.0

    fun windowJson(width: Float, height: Float, scale: Float, fontScale: Float, screenWidth: Float, screenHeight: Float): String =
        JSONObject().put("width", r(width)).put("height", r(height)).put("scale", r3(scale)).put("fontScale", r3(fontScale))
            .put("screenWidth", r(screenWidth)).put("screenHeight", r(screenHeight)).toString()

    fun keyboardJson(height: Float): String = JSONObject().put("visible", height > 0f).put("height", r(height)).toString()

    /** JS thread, right after the main script ran on [rt] (ZnRuntime.afterMainScript). */
    fun afterMainScript(rt: Long, context: Context) {
        val device = deviceJson(Build.VERSION.SDK_INT, Build.VERSION.RELEASE, Build.MODEL, Build.BRAND, Build.MANUFACTURER)
        ZnNative.dispatchEvent(rt, ZnAppEvent.APP, ZnAppEvent.DEVICE, 3, 0.0, device)
        // A window already measured (a dev reload, or the Activity came first) wins over the display's guess.
        val window = lastWindow.ifEmpty { firstGuess(context) }
        ZnNative.dispatchEvent(rt, ZnAppEvent.APP, ZnAppEvent.WINDOW, 3, 0.0, window)
    }

    /** Before the window is measured: the display (the whole screen, an app window in split screen is smaller). */
    private fun firstGuess(context: Context): String {
        val res = context.resources
        val metrics = res.displayMetrics
        val (sw, sh) = screenPx(context)
        val d = metrics.density
        return windowJson(sw / d, sh / d, d, res.configuration.fontScale, sw / d, sh / d)
    }

    /** The whole display in px, bars included. DisplayManager works from any Context (WindowManager wants an Activity). */
    fun screenPx(context: Context): Pair<Float, Float> {
        val display = (context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).getDisplay(Display.DEFAULT_DISPLAY)
            ?: return context.resources.displayMetrics.let { it.widthPixels.toFloat() to it.heightPixels.toFloat() }
        val real = DisplayMetrics()
        @Suppress("DEPRECATION")
        display.getRealMetrics(real)
        return real.widthPixels.toFloat() to real.heightPixels.toFloat()
    }

    /** Main thread: the measured window (ZnNavHost). */
    fun reportWindow(json: String) {
        if (json == lastWindow) return
        lastWindow = json
        ZnRuntime.dispatchEvent(ZnAppEvent.APP, ZnAppEvent.WINDOW, json)
    }

    /** Main thread: the keyboard's final height in dp, 0 when hidden (ZnNavHost). */
    fun reportKeyboard(height: Float) {
        val json = keyboardJson(height)
        if (json == lastKeyboard) return
        lastKeyboard = json
        ZnRuntime.dispatchEvent(ZnAppEvent.APP, ZnAppEvent.KEYBOARD, json)
    }

    /** Main thread, when the JS runtime is replaced: the new JS must hear the keyboard again (the window goes with DEVICE). */
    fun resetForReload() {
        lastKeyboard = ""
    }
}
