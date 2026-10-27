package dev.zeronative.exp1

import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage

private const val TAG = "SmokeActivity"

class SmokeActivity : ComponentActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 1. Run all native SDK touches to prevent R8 from over-stripping
        runSmokeTouches()

        // 2. Set Compose UI content
        setContent {
            SmokeScreen()
        }
    }

    private fun runSmokeTouches() {
        val variant = BuildConfig.ZN_VARIANT
        Log.i(TAG, "Running SmokeTouches for Variant: $variant")

        // --- Hermes Engine Touch (Reflective so Variant D compiles without Hermes) ---
        if (variant != "D") {
            try {
                val bytes = assets.open("smoke.hbc").readBytes()
                val bridgeClass = Class.forName("dev.zeronative.exp1.ZnBridge")
                val instanceField = bridgeClass.getField("INSTANCE")
                val instance = instanceField.get(null)
                val method = bridgeClass.getMethod("evalSmokeBytecode", ByteArray::class.java)
                val result = method.invoke(instance, bytes)
                Log.i(TAG, "Hermes evaluation result: $result")
            } catch (e: Throwable) {
                Log.e(TAG, "Hermes smoke error", e)
            }
        }

        // --- Scanner & CameraX Touches (Reflective so Variant C compiles without Scanner) ---
        if (variant != "C") {
            try {
                val barcodeClass = Class.forName("com.google.mlkit.vision.barcode.BarcodeScanning")
                val getBarcodeClient = barcodeClass.getMethod("getClient")
                val barcodeScanner = getBarcodeClient.invoke(null)
                Log.i(TAG, "ML Kit Barcode client initialized: $barcodeScanner")

                val cameraClass = Class.forName("androidx.camera.lifecycle.ProcessCameraProvider")
                val getCameraInstance = cameraClass.getMethod("getInstance", android.content.Context::class.java)
                val cameraProviderFuture = getCameraInstance.invoke(null, this)
                Log.i(TAG, "CameraX Provider future: $cameraProviderFuture")

                val docClass = Class.forName("com.google.mlkit.vision.documentscanner.GmsDocumentScanning")
                val optionsBuilderClass = Class.forName("com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions\$Builder")
                val optionsBuilder = optionsBuilderClass.getDeclaredConstructor().newInstance()
                val buildMethod = optionsBuilderClass.getMethod("build")
                val options = buildMethod.invoke(optionsBuilder)
                val getDocClient = docClass.getMethod("getClient", Class.forName("com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions"))
                val docScanner = getDocClient.invoke(null, options)
                Log.i(TAG, "Document Scanner client: $docScanner")
            } catch (e: Throwable) {
                Log.e(TAG, "Scanner touches error", e)
            }
        }

        // --- Firebase Touches ---
        try {
            com.google.firebase.FirebaseApp.initializeApp(this)
            com.google.firebase.crashlytics.FirebaseCrashlytics.getInstance().log("smoke_test_log")
            com.google.firebase.analytics.FirebaseAnalytics.getInstance(this).logEvent("smoke_event", null)
            com.google.firebase.messaging.FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    Log.i(TAG, "FCM token retrieved: ${task.result}")
                }
            }
        } catch (e: Throwable) {
            Log.e(TAG, "Firebase touches error", e)
        }

        // --- Google Play Services Touches ---
        try {
            val signInClient = com.google.android.gms.auth.api.identity.Identity.getSignInClient(this)
            Log.i(TAG, "Identity SignInClient: $signInClient")

            val locationClient = com.google.android.gms.location.LocationServices.getFusedLocationProviderClient(this)
            Log.i(TAG, "FusedLocationProviderClient: $locationClient")

            val appUpdateManager = com.google.android.play.core.appupdate.AppUpdateManagerFactory.create(this)
            Log.i(TAG, "AppUpdateManager: $appUpdateManager")

            val referrerClient = com.android.installreferrer.api.InstallReferrerClient.newBuilder(this).build()
            Log.i(TAG, "InstallReferrerClient: $referrerClient")
        } catch (e: Throwable) {
            Log.e(TAG, "Play services touches error", e)
        }

        // --- Production Utilities & Libraries Touches ---
        try {
            com.tencent.mmkv.MMKV.initialize(this)
            val mmkv = com.tencent.mmkv.MMKV.defaultMMKV()
            mmkv?.encode("smoke_key", "smoke_value")
            Log.i(TAG, "MMKV smoke value: ${mmkv?.decodeString("smoke_key")}")

            val zipEntry = org.apache.commons.compress.archivers.zip.ZipArchiveEntry("smoke.txt")
            Log.i(TAG, "Commons Compress ZipArchiveEntry: ${zipEntry.name}")

            val workManager = androidx.work.WorkManager.getInstance(this)
            Log.i(TAG, "WorkManager instance: $workManager")

            val lottieFactory = com.airbnb.lottie.LottieCompositionFactory.fromAsset(this, "dummy.json")
            Log.i(TAG, "Lottie composition task: $lottieFactory")

            val tcOptions = com.truecaller.android.sdk.oAuth.TcSdkOptions.Builder(this, object : com.truecaller.android.sdk.oAuth.TcOAuthCallback {
                override fun onSuccess(tcOAuthData: com.truecaller.android.sdk.oAuth.TcOAuthData) {}
                override fun onFailure(tcOAuthError: com.truecaller.android.sdk.oAuth.TcOAuthError) {}
                override fun onVerificationRequired(tcOAuthError: com.truecaller.android.sdk.oAuth.TcOAuthError?) {}
            }).build()
            val tcSdk = com.truecaller.android.sdk.oAuth.TcSdk.getInstance()
            Log.i(TAG, "Truecaller SDK instance: $tcSdk with options $tcOptions")
        } catch (e: Throwable) {
            Log.e(TAG, "Production helpers touches error", e)
        }
    }
}

@Composable
fun SmokeScreen() {
    val scaleAnim = remember { Animatable(0.8f) }

    LaunchedEffect(Unit) {
        scaleAnim.animateTo(
            targetValue = 1.0f,
            animationSpec = spring(dampingRatio = 0.6f, stiffness = 400f)
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF0F172A))
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        // App title (using standard Compose foundation/ui Text)
        androidx.compose.foundation.text.BasicText(
            text = "zero-native v0: Smoke Test",
            style = androidx.compose.ui.text.TextStyle(
                color = Color.White,
                fontSize = 20.sp,
                fontWeight = androidx.compose.ui.text.font.FontWeight.Bold
            ),
            modifier = Modifier.padding(bottom = 12.dp)
        )

        // Animated Coil AsyncImage
        Box(
            modifier = Modifier
                .size(100.dp)
                .scale(scaleAnim.value)
                .background(Color(0xFF1E293B), shape = RoundedCornerShape(12.dp)),
            contentAlignment = Alignment.Center
        ) {
            AsyncImage(
                model = "https://example.com/logo.png",
                contentDescription = "ZeroBill Logo",
                modifier = Modifier.size(80.dp)
            )
        }

        // LazyColumn with 20 rows
        val itemsList = remember { (1..20).map { "Smoke Row #$it - Verified" } }
        LazyColumn(
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .padding(top = 16.dp)
        ) {
            items(itemsList) { item ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp)
                        .background(Color(0xFF1E293B), shape = RoundedCornerShape(8.dp))
                        .padding(12.dp)
                ) {
                    androidx.compose.foundation.text.BasicText(
                        text = item,
                        style = androidx.compose.ui.text.TextStyle(color = Color(0xFF94A3B8), fontSize = 14.sp)
                    )
                }
            }
        }
    }
}
