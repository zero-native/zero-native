package dev.zeronative.runtime

import android.app.Activity
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewTreeObserver

/**
 * Keeps Android's launch screen up until JS has built the first screens (R53, 2026-11-07).
 *
 * Without it, Android takes its launch screen away at the app's first frame. On a cold start that frame can come
 * before the templates are ready (an empty box in the app's background colour) or before JS has filled the screen
 * (the template's skeleton). With it, the first frame the user sees is the filled start screen.
 *
 *   setContent { ... }
 *   ZnSplash.holdUntilReady(this)            // in Activity.onCreate, after setContent
 *
 * - "Launch screen": the system splash on Android 12+ (app icon on the theme's background), and the theme's
 *   `android:windowBackground` on Android 7-11. Make that background match the start screen's.
 * - "Ready": JS sent NAV STARTED, the same signal the OTA safety nets use (a bundle for host API 2: the JS thread
 *   handled START).
 * - [capMs] is the longest it waits: the app draws then even if JS isn't done (slow phone, JS failed to start: the
 *   error screen must show).
 * - A recreated Activity (rotation, dark mode, back from the background) whose screens are built doesn't wait.
 *   An Activity that starts the app fresh (closed from Recents, process kept) waits for its new screens.
 * - Android shows its splash only for some starts (a launcher tap, not always a link or a notification). Then the
 *   theme's background stays up while it waits.
 */
object ZnSplash {
    private const val TAG = "zn"

    /** JS's `Splash.holdUntil` holds still open: id to its maxMs (main thread). */
    private val appHolds = LinkedHashMap<Int, Long>()
    /** The longest maxMs any app hold asked for in this start: it counts from the first screens being up. */
    private var appMaxMs = 0L

    /** Main thread: the splash is still up, held by [holdUntilReady]. A screen pushed now comes in with no slide. */
    internal var holding = false
        private set

    /** Call it in `Activity.onCreate`, after `setContent`. Main thread. */
    fun holdUntilReady(activity: Activity, capMs: Long = 1000) {
        val content = activity.findViewById<View>(android.R.id.content)
        val t0 = SystemClock.uptimeMillis()
        holding = true
        content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            private var heldFrames = 0
            private var readyAt = 0L

            override fun onPreDraw(): Boolean {
                val now = SystemClock.uptimeMillis()
                val ready = ZnNav.firstScreensUp
                if (ready && readyAt == 0L) readyAt = now
                val waited = now - t0
                // The app asked for more time (Splash.holdUntil): up to its maxMs after the first screens are up.
                // Then, once the work is done, until the screen it pushed is composed: a push shows a frame after it
                // lands, and lifting before that showed Home for one frame (emulator, 2026-11-07).
                val appWaits = ready && appMaxMs > 0 && now - readyAt < appMaxMs && (appHolds.isNotEmpty() || !ZnNav.topComposed)
                // The OTA launch gate: the update check is still out (a short wait), or the update screen isn't
                // composed yet (ZnOtaGate). It ends by itself within its own time limit.
                val gateWaits = ready && ZnOtaGate.holdsSplash()
                // false: this frame isn't drawn, and Android tries again at the next one.
                if ((!ready || appWaits || gateWaits) && waited < capMs) {
                    heldFrames++
                    return false
                }
                content.viewTreeObserver.removeOnPreDrawListener(this)
                holding = false
                val askedMore = appMaxMs > 0
                val stillOpen = appHolds.isNotEmpty()
                appHolds.clear()
                appMaxMs = 0L
                if (heldFrames == 0) return true // screens already built (a recreated Activity): nothing was held
                val since = now - Process.getStartUptimeMillis()
                when {
                    !ready -> Log.w(TAG, "splash: first screens not built after $capMs ms; drawing anyway ($since ms after process start)")
                    askedMore && stillOpen && waited >= capMs ->
                        Log.w(TAG, "splash: the app's hold hit the $capMs ms limit; drawing ($since ms after process start)")
                    askedMore && stillOpen ->
                        Log.w(TAG, "splash: the app's hold hit its maxMs, ${now - readyAt} ms after the first screens ($since ms after process start)")
                    askedMore -> Log.i(TAG, "splash: held until the app said ready, ${now - readyAt} ms after the first screens ($since ms after process start)")
                    else -> Log.i(TAG, "splash: held $heldFrames frame(s), first screens built; first frame $since ms after process start")
                }
                return true
            }
        })
    }

    /** JS `Splash.holdUntil` (packages/core/src/splash.ts). Main thread. Too late (the splash is gone): ignored. */
    internal fun appHold(id: Int, maxMs: Long) {
        if (!holding) {
            Log.i(TAG, "splash: an app hold came after the splash went; ignored")
            return
        }
        appHolds[id] = maxMs
        appMaxMs = maxOf(appMaxMs, maxMs)
    }

    internal fun appRelease(id: Int) {
        appHolds.remove(id)
    }

    /** The built-in Splash module: `hold` and `release` (packages/core/src/splash.ts). */
    internal object Module : ZnModuleBase("Splash", version = 1) {
        init {
            function("hold", onMain = true) { call ->
                appHold(call.long("id").toInt(), call.long("maxMs"))
                call.resolve()
            }
            function("release", onMain = true) { call ->
                appRelease(call.long("id").toInt())
                call.resolve()
            }
        }
    }
}
