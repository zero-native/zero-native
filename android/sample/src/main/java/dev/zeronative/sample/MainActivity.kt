package dev.zeronative.sample

import android.os.Bundle
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.zeronative.runtime.BatchListener
import dev.zeronative.runtime.ZnDebug
import dev.zeronative.runtime.ZnRuntime
import dev.zeronative.runtime.ZnScreen
import dev.zeronative.runtime.ZnStore
import dev.zeronative.runtime.ZnTemplates
import java.util.concurrent.atomic.AtomicLong

/**
 * Step 1.2: the screen is drawn by the zn renderer from main.zn.ui. The small footer (recreate button, runtime info)
 * is plain Compose because it shows native-only facts.
 */
class MainActivity : ComponentActivity() {
    private val tapStartNanos = AtomicLong(0)
    private var fullyDrawnPending = false

    private val batchListener = BatchListener { ops, applyStart, applyEnd ->
        if (fullyDrawnPending) {
            fullyDrawnPending = false
            reportFullyDrawn()
        }
        val t0 = tapStartNanos.getAndSet(0)
        if (t0 != 0L) {
            Log.i(TAG, "tap→applied %.2f ms (apply %.2f ms, %d ops)".format((applyEnd - t0) / 1e6, (applyEnd - applyStart) / 1e6, ops))
        }
        if (ZnDebug.countRecompositions) {
            // Recomposition happens in the next frame; read the counter two frames later.
            val v = window.decorView
            v.postOnAnimation { v.postOnAnimation { Log.i(TAG, "recomposed: ${ZnDebug.drain()}") } }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activitiesCreated++
        ZnDebug.countRecompositions = BuildConfig.DEBUG
        ZnRuntime.addBatchListener(batchListener)

        setContent {
            val bundle = ZnTemplates.get("main.zn.ui")
            Column(Modifier.fillMaxSize().background(Color(0xFFF8FAFC)).safeDrawingPadding()) {
                if (bundle != null) {
                    val templateId = bundle.templateOf("AmountScreen") ?: 0
                    val root = remember(bundle) { ZnStore.mountRoot(ROOT_ID, templateId, bundle.templates[templateId]) }
                    LaunchedEffect(bundle) {
                        Log.i(TAG, "template skeleton composed ${sinceProcessStart()} ms after process start")
                        // "Fully drawn" = JS has filled the screen. Its first batch may land before or after this.
                        if (SampleApp.firstBatchApplied) reportFullyDrawn() else fullyDrawnPending = true
                    }
                    ZnScreen(bundle.templates, root, Modifier.weight(1f).fillMaxWidth())
                } else {
                    Box(Modifier.weight(1f)) // only until the template is prepared (a few ms)
                }
                Footer()
            }
        }
    }

    @Composable
    private fun Footer() {
        Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFF0F172A))
                    .clickable { recreate() }.padding(vertical = 14.dp),
                contentAlignment = Alignment.Center,
            ) { BasicText("Recreate activity", style = TextStyle(fontSize = 15.sp, color = Color.White)) }
            BasicText(
                "runtime #${ZnRuntime.createdCount.get()} · activity #$activitiesCreated · pid ${Process.myPid()}",
                style = TextStyle(fontSize = 13.sp, color = Color(0xFF64748B)),
            )
        }
    }

    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        // Timestamp every touch-up; the next batch tells how long tap → JS → screen took.
        if (ev.actionMasked == MotionEvent.ACTION_UP) tapStartNanos.set(System.nanoTime())
        return super.dispatchTouchEvent(ev)
    }

    override fun onDestroy() {
        ZnRuntime.removeBatchListener(batchListener)
        super.onDestroy()
    }

    private fun sinceProcessStart() = SystemClock.uptimeMillis() - Process.getStartUptimeMillis()

    companion object {
        private const val TAG = "zn-sample"
        /** First screen root; must match ROOT in examples/sample/src/main.ts (top bit = native-allocated id). */
        private const val ROOT_ID = 0x80000001.toInt()
        private var activitiesCreated = 0
    }
}
