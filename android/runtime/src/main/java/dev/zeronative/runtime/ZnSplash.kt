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

    /** Call it in `Activity.onCreate`, after `setContent`. Main thread. */
    fun holdUntilReady(activity: Activity, capMs: Long = 1000) {
        val content = activity.findViewById<View>(android.R.id.content)
        val t0 = SystemClock.uptimeMillis()
        content.viewTreeObserver.addOnPreDrawListener(object : ViewTreeObserver.OnPreDrawListener {
            private var heldFrames = 0

            override fun onPreDraw(): Boolean {
                val ready = ZnNav.firstScreensUp
                val waited = SystemClock.uptimeMillis() - t0
                // false: this frame isn't drawn, and Android tries again at the next one.
                if (!ready && waited < capMs) {
                    heldFrames++
                    return false
                }
                content.viewTreeObserver.removeOnPreDrawListener(this)
                if (heldFrames == 0) return true // screens already built (a recreated Activity): nothing was held
                val since = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()
                if (ready) Log.i(TAG, "splash: held $heldFrames frame(s), first screens built; first frame $since ms after process start")
                else Log.w(TAG, "splash: first screens not built after $capMs ms; drawing anyway ($since ms after process start)")
                return true
            }
        })
    }
}
