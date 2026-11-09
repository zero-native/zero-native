package dev.zeronative.sample

import android.content.Intent
import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import dev.zeronative.plugins.appupdates.AppUpdatesModule
import dev.zeronative.runtime.BatchListener
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnDebug
import dev.zeronative.runtime.ZnNav
import dev.zeronative.runtime.ZnNavHost
import dev.zeronative.runtime.ZnRuntime
import dev.zeronative.runtime.ZnSplash
import dev.zeronative.runtime.ZnTemplates
import java.util.concurrent.atomic.AtomicLong

/**
 * A thin host: the screens, the back stack and back handling all come from the zn runtime (ZnNavHost / ZnNav).
 * Launched in `singleTop` mode: a deep link while this Activity is on top arrives in [onNewIntent]; while another app is
 * on top it makes a second Activity, which [ZnNav.handleExtraActivity] forwards and closes.
 * To test Activity recreation: `adb shell cmd uimode night yes` (and `no`).
 */
class MainActivity : ComponentActivity() {
    private val tapStartNanos = AtomicLong(0)
    private var fullyDrawnPending = false
    /** Back on the last screen: the same as the system's own back there (Android 12+ keeps the app in memory). */
    private val exit: () -> Unit = { moveTaskToBack(true) }

    private val batchListener = BatchListener { ops, applyStart, applyEnd ->
        if (fullyDrawnPending) {
            fullyDrawnPending = false
            reportFullyDrawn()
        }
        val t0 = tapStartNanos.getAndSet(0)
        if (t0 != 0L) {
            Log.i(TAG, "tap→applied %.2f ms (apply %.2f ms, %d ops)".format((applyEnd - t0) / 1e6, (applyEnd - applyStart) / 1e6, ops))
            // The frame that shows the change (for a push: the new screen's first frame).
            window.decorView.postOnAnimation { Log.i(TAG, "tap→frame %.2f ms".format((System.nanoTime() - t0) / 1e6)) }
        }
        if (ZnDebug.countRecompositions) {
            // Recomposition happens in the next frame; read the counter two frames later.
            val v = window.decorView
            v.postOnAnimation { v.postOnAnimation { Log.i(TAG, "recomposed: ${ZnDebug.drain()}") } }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Draw behind the status and navigation bars; each route decides which edges stay clear (ZnNavHost).
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (ZnNav.handleExtraActivity(this, savedInstanceState)) {
            finish()
            return
        }
        ZnActivity.attach(this)
        ZnDebug.countRecompositions = BuildConfig.DEBUG
        ZnRuntime.addBatchListener(batchListener)
        ZnNav.onExit = exit

        // A recreated Activity has the same intent: its link was already handled.
        val link = if (savedInstanceState == null) intent?.data else null
        // savedInstanceState: after Android killed the app in the background, the screens that were open come back.
        ZnTemplates.whenReady(ASSET) { bundle -> ZnNav.start(bundle, link, savedInstanceState) }

        setContent {
            val bundle = ZnTemplates.get(ASSET)
            Box(Modifier.fillMaxSize().background(Color(0xFFF8FAFC))) {
                if (bundle != null) {
                    ZnNavHost(bundle, Modifier.fillMaxSize())
                    LaunchedEffect(bundle) {
                        Log.i(TAG, "template skeleton composed ${sinceProcessStart()} ms after process start")
                        // "Fully drawn" = JS has filled the screen. Its first batch may land before or after this.
                        if (SampleApp.firstBatchApplied) reportFullyDrawn() else fullyDrawnPending = true
                    }
                }
            }
        }
        // Off by default, so the sample's cold-start numbers keep meaning "first frame = template skeleton".
        // `adb shell setprop debug.zn.splash_hold_ms 1000` keeps Android's splash until JS built the first screens
        // (ZnSplash, R53); `... 0` turns it off again.
        val hold = (application as SampleApp).systemProperty("debug.zn.splash_hold_ms")?.toLongOrNull() ?: 0L
        if (hold > 0) ZnSplash.holdUntilReady(this, capMs = hold)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        ZnNav.saveState(outState) // the open screens, for when Android brings the app back after killing it
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val link = intent.data ?: return
        ZnTemplates.whenReady(ASSET) { ZnNav.openLink(link) }
    }

    // Play's in-app update sheet answers only here (startUpdateFlowForResult with a request code)
    @Deprecated("Play Core's update sheet still answers through onActivityResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        AppUpdatesModule.onActivityResult(this, requestCode, resultCode)
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        // Timestamp every touch-up; the next batch tells how long tap → JS → screen took.
        if (ev.actionMasked == MotionEvent.ACTION_UP) tapStartNanos.set(System.nanoTime())
        return super.dispatchTouchEvent(ev)
    }

    override fun onDestroy() {
        ZnRuntime.removeBatchListener(batchListener)
        if (ZnNav.onExit === exit) ZnNav.onExit = null
        super.onDestroy()
    }

    private fun sinceProcessStart() = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()

    companion object {
        private const val TAG = "zn-sample"
        private const val ASSET = "main.zn.ui"
    }
}
