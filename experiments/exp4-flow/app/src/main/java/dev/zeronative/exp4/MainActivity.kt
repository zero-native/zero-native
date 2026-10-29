package dev.zeronative.exp4

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.sp
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    companion object {
        private const val TAG = "zn"
        private const val SAFE_MODE_PREF = "zn_safe_mode"
        private const val KEY_RESTORE_ATTEMPTS = "restore_attempts"
        private const val KEY_LAST_RESTORE_TIME = "last_restore_time"
    }

    private var activityCreateTime: Long = 0
    private var isSafeModeTriggered = false

    // Registered BEFORE JS runtime boots (ARCHITECTURE §12.4)
    private val upiLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val resultCode = result.resultCode
        val data = result.data
        val extrasMap = HashMap<String, Any?>()
        extrasMap["resultCode"] = resultCode
        data?.extras?.let { bundle ->
            for (key in bundle.keySet()) {
                extrasMap[key] = bundle.get(key)
            }
        }
        val responseQuery = data?.data?.query ?: data?.getStringExtra("response")
        if (responseQuery != null) {
            extrasMap["response"] = responseQuery
        }

        val jsonResult = JSONObject(extrasMap as Map<*, *>).toString()
        Log.i(TAG, "[UPI_RESULT] Activity result received: $jsonResult")

        // 1. Commit result to FlowStore FIRST before JS (ARCHITECTURE §12.4)
        commitNativeResultToFlowStore(jsonResult)

        // 2. Dispatch to JS runtime
        ZnBridge.dispatchEvent(0, "upiResult", jsonResult)
    }

    private fun commitNativeResultToFlowStore(resultJson: String) {
        try {
            val store = FlowStore.getStore(filesDir, "checkout")
            val currentFlow = store.read()
            if (currentFlow != null) {
                val flowObj = JSONObject(currentFlow)
                val effectsObj = flowObj.optJSONObject("effects") ?: JSONObject()
                val resultObj = JSONObject(resultJson)

                val upiEff = effectsObj.optJSONObject("launchUpi") ?: JSONObject().apply {
                    put("id", "launchUpi")
                    put("kind", "once")
                }
                upiEff.put("status", "done")
                upiEff.put("result", resultObj)
                effectsObj.put("launchUpi", upiEff)
                flowObj.put("effects", effectsObj)

                val dataObj = flowObj.optJSONObject("data") ?: JSONObject()
                dataObj.put("upiResult", resultObj)
                flowObj.put("data", dataObj)

                store.write(flowObj.toString())
                Log.i(TAG, "[FlowStore] Pre-cached UPI result into FlowStore: $resultJson")
            }
        } catch (e: Exception) {
            Log.e(TAG, "[FlowStore] Error pre-caching result", e)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityCreateTime = SystemClock.uptimeMillis()
        Log.i(TAG, "[LIFECYCLE] onCreate at $activityCreateTime ms (PID=${android.os.Process.myPid()})")

        // 1. Check Safe Mode Crash-Loop Guard (ARCHITECTURE §12.7)
        checkSafeMode()

        // 2. Log installed UPI apps for verification
        UpiAppManager.getInstalledUpiApps(this)

        // 3. Hardware Back Button handler (Delegated to Hermes JS Router as Single Source of Truth)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                Log.i(TAG, "[BACK_PRESSED] Hardware back pressed, delegating to Hermes JS router")
                ZnBridge.dispatchEvent(0, "hardwareBack")
            }
        })

        // 3b. Register App Exit listener from Hermes
        ZnBridge.onExitAppListener = {
            runOnUiThread {
                Log.i(TAG, "[APP] moveTaskToBack requested by Hermes root router")
                moveTaskToBack(true)
            }
        }

        // 4. Register UPI launch listener
        ZnBridge.onLaunchUpiListener = { pkg, name, toPayPaise ->
            launchUpiIntent(pkg, name, toPayPaise)
        }

        // 5. Provide Application Context to FlowStore bridge
        ZnBridge.setContext(this)

        // 6. Boot background Hermes thread
        ZnBridge.init()

        // 7. Eval compiled multi-screen bytecode
        ZnBridge.evalAssetBytecode(this, "screen.hbc") { ok ->
            if (ok) {
                Log.i(TAG, "[COLD_START] screen.hbc evaluated successfully")
            } else {
                Log.e(TAG, "[COLD_START] Failed to evaluate screen.hbc")
            }
        }

        // 7b. In DEBUG builds, connect DevClient for Sub-Second Fast Refresh
        if (BuildConfig.DEBUG) {
            DevClient.start()
        }

        // 8. Set Compose UI with NavigationHost
        setContent {
            val hasRoot = NodeStore.hasRoot.value

            if (isSafeModeTriggered) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(Color(0xFFFEF2F2)),
                    contentAlignment = Alignment.Center
                ) {
                    BasicText(
                        text = "ZeroBill Safe Mode: Crash loop prevented. Flow quarantined.",
                        style = TextStyle(color = Color(0xFFDC2626), fontSize = 16.sp)
                    )
                }
            } else if (hasRoot) {
                LaunchedEffect(Unit) {
                    val fullyDrawnTime = SystemClock.uptimeMillis()
                    val totalColdStartMs = fullyDrawnTime - activityCreateTime
                    Log.i(TAG, "[COLD_START] reportFullyDrawn: Initial screen rendered in $totalColdStartMs ms")
                    // Successful render resets crash loop attempt counter
                    getSharedPreferences(SAFE_MODE_PREF, Context.MODE_PRIVATE)
                        .edit().putInt(KEY_RESTORE_ATTEMPTS, 0).apply()
                    try {
                        reportFullyDrawn()
                    } catch (_: Exception) {}
                }

                key(NodeStore.treeVersion.value) {
                    NavigationHost(modifier = Modifier.fillMaxSize())
                }
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

    private fun checkSafeMode() {
        val store = FlowStore.getStore(filesDir, "checkout")
        if (store.read() == null) {
            // No flow to restore; cannot be a restore crash loop
            return
        }

        val prefs = getSharedPreferences(SAFE_MODE_PREF, Context.MODE_PRIVATE)
        val now = System.currentTimeMillis()
        val lastRestore = prefs.getLong(KEY_LAST_RESTORE_TIME, 0L)
        val attempts = prefs.getInt(KEY_RESTORE_ATTEMPTS, 0)

        if (now - lastRestore < 10000) {
            val nextAttempts = attempts + 1
            prefs.edit().putInt(KEY_RESTORE_ATTEMPTS, nextAttempts).putLong(KEY_LAST_RESTORE_TIME, now).apply()
            if (nextAttempts >= 2) {
                Log.w(TAG, "[SAFE_MODE] CRASH LOOP DETECTED ($nextAttempts crashes in 10s). Quarantining flows!")
                isSafeModeTriggered = true
                store.delete()
                return
            }
        } else {
            // Reset counter after 10s clean execution
            prefs.edit().putInt(KEY_RESTORE_ATTEMPTS, 1).putLong(KEY_LAST_RESTORE_TIME, now).apply()
        }
    }

    private fun launchUpiIntent(pkg: String, name: String, toPayPaise: Long) {
        val amountRupees = (toPayPaise / 100.0).toString()
        val uriString = "upi://pay?pa=zntest@upi&pn=ZN%20Test&am=${amountRupees}&cu=INR&tn=zn-exp4"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(uriString)).apply {
            setPackage(pkg)
        }
        val launchTime = System.nanoTime()
        Log.i(TAG, "[UPI_INTENT] Launching intent for $pkg ($name) at $launchTime ns: $uriString")

        // S4b: Debug-only crash point right after launchUpi effect record is written, before startActivity
        ZnBridge.checkCrashPoint("S4b")

        try {
            upiLauncher.launch(intent)
        } catch (e: Exception) {
            Log.e(TAG, "[UPI_INTENT] Failed to launch UPI intent for $pkg", e)
        }
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
        if (BuildConfig.DEBUG) {
            DevClient.stop()
        }
        ZnBridge.destroy()
        NodeStore.clear()
    }
}
