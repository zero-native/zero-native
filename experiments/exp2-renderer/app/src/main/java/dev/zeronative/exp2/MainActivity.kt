package dev.zeronative.exp2

import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp

class MainActivity : ComponentActivity() {
    private val TAG = "zn"
    private var activityCreateTime: Long = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityCreateTime = SystemClock.uptimeMillis()
        Log.i(TAG, "[COLD_START] MainActivity onCreate at $activityCreateTime ms")

        ZnBridge.onJsErrorListener = { err ->
            Log.e(TAG, "Uncaught JS Exception: $err")
        }

        // 1. Boot background Hermes thread
        ZnBridge.start()

        // 2. Eval compiled AmountScreen bytecode
        ZnBridge.evalAssetBytecode(this, "screen.hbc") { ok ->
            if (ok) {
                Log.i(TAG, "[COLD_START] screen.hbc evaluated successfully")
            } else {
                Log.e(TAG, "[COLD_START] Failed to evaluate screen.hbc")
            }
        }

        // 3. Set Compose UI
        setContent {
            val hasRoot = NodeStore.hasRoot.value

            if (hasRoot) {
                LaunchedEffect(Unit) {
                    val fullyDrawnTime = SystemClock.uptimeMillis()
                    val totalColdStartMs = fullyDrawnTime - activityCreateTime
                    Log.i(TAG, "[COLD_START] reportFullyDrawn: Amount screen rendered in $totalColdStartMs ms")
                    try {
                        reportFullyDrawn()
                    } catch (_: Exception) {}
                }

                ZnView(id = 0, modifier = Modifier.fillMaxSize())
            } else {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color(0xFFF8FAFC)),
                    contentAlignment = Alignment.Center
                ) {
                    BasicText(
                        text = "Loading ZeroBill...",
                        style = TextStyle(color = Color(0xFF64748B), fontSize = 16.sp)
                    )
                }
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        ZnBridge.destroy()
        NodeStore.clear()
    }
}
