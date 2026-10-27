package dev.zeronative.exp3

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
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
    companion object {
        private const val TAG = "zn"
        private const val REQ_UPI = 1001
    }

    private var activityCreateTime: Long = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityCreateTime = SystemClock.uptimeMillis()
        val nowNanos = System.nanoTime()
        Log.i(TAG, "[LIFECYCLE] onCreate at $activityCreateTime ms (uptimeNanos=$nowNanos)")

        // 1. Log installed UPI apps for verification
        UpiAppManager.getInstalledUpiApps(this)

        // 2. Hardware Back Button handler
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (NavigationManager.backStack.size > 1) {
                    Log.i(TAG, "[BACK_PRESSED] Popping backStack via hardware back button")
                    NavigationManager.pop()
                    // Dispatch to JS runtime so JS backStack stays in sync
                    ZnBridge.dispatchEvent(0, "hardwareBack")
                } else {
                    Log.i(TAG, "[BACK_PRESSED] backStack at root, finishing activity")
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })

        // 3. Register UPI launch listener
        ZnBridge.onLaunchUpiListener = { pkg, name, toPayPaise ->
            launchUpiIntent(pkg, name, toPayPaise)
        }

        // 4. Boot background Hermes thread
        ZnBridge.init()

        // 5. Eval compiled multi-screen bytecode
        ZnBridge.evalAssetBytecode(this, "screen.hbc") { ok ->
            if (ok) {
                Log.i(TAG, "[COLD_START] screen.hbc evaluated successfully")
            } else {
                Log.e(TAG, "[COLD_START] Failed to evaluate screen.hbc")
            }
        }

        // 6. Set Compose UI with NavigationHost
        setContent {
            val hasRoot = NodeStore.hasRoot.value

            if (hasRoot) {
                LaunchedEffect(Unit) {
                    val fullyDrawnTime = SystemClock.uptimeMillis()
                    val totalColdStartMs = fullyDrawnTime - activityCreateTime
                    Log.i(TAG, "[COLD_START] reportFullyDrawn: Initial screen rendered in $totalColdStartMs ms")
                    try {
                        reportFullyDrawn()
                    } catch (_: Exception) {}
                }

                NavigationHost(modifier = Modifier.fillMaxSize())
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

    private fun launchUpiIntent(pkg: String, name: String, toPayPaise: Long) {
        val amountRupees = toPayPaise / 100.0
        val uriString = "upi://pay?pa=zntest@upi&pn=ZN%20Test&am=${amountRupees}&cu=INR&tn=zn-exp3"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uriString)).apply {
            setPackage(pkg)
        }
        val launchTime = System.nanoTime()
        Log.i(TAG, "[UPI_INTENT] Launching intent for $pkg ($name) at $launchTime ns: $uriString")

        try {
            startActivityForResult(intent, REQ_UPI)
        } catch (e: Exception) {
            Log.e(TAG, "[UPI_INTENT] Failed to launch UPI intent for $pkg", e)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        val returnTime = System.nanoTime()
        val dataStr = data?.toUri(0) ?: "null"
        Log.i(TAG, "[UPI_INTENT] onActivityResult returned: req=$requestCode, res=$resultCode, data=$dataStr at $returnTime ns")
    }

    override fun onStart() {
        super.onStart()
        Log.i(TAG, "[LIFECYCLE] onStart at ${System.nanoTime()} ns")
    }

    override fun onResume() {
        super.onResume()
        Log.i(TAG, "[LIFECYCLE] onResume at ${System.nanoTime()} ns")
    }

    override fun onPause() {
        super.onPause()
        Log.i(TAG, "[LIFECYCLE] onPause at ${System.nanoTime()} ns")
    }

    override fun onStop() {
        super.onStop()
        Log.i(TAG, "[LIFECYCLE] onStop at ${System.nanoTime()} ns")
    }

    override fun onDestroy() {
        super.onDestroy()
        Log.i(TAG, "[LIFECYCLE] onDestroy at ${System.nanoTime()} ns")
        ZnBridge.destroy()
        NodeStore.clear()
    }
}
