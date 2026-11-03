package dev.zeronative.plugins.scanner

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Size
import androidx.annotation.OptIn
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CameraState
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.Observer
import com.google.mlkit.common.MlKit
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal const val TAG = "zn"

/** Our manifest removes ML Kit's own start. It allows one start per process, and a second one throws, so one scanner after another needs this. */
private object MlKitStart {
    private var done = false

    @Synchronized
    fun once(context: Context) {
        if (done) return
        done = true
        try {
            MlKit.initialize(context.applicationContext)
        } catch (_: IllegalStateException) {
            // Another ML Kit user in this app was first. That is a start too.
        }
    }
}

/**
 * One run of the camera, from [start] to [close]. All calls are on the main thread. [ProcessCameraProvider.bindToLifecycle]
 * ties it to the screen: it stops when the screen is covered or the app leaves, and comes back by itself. [close] takes the
 * camera back when the view goes away, so nothing leaks.
 *
 * [onCamera]: true when the camera can't run (in use by another app, turned off by a policy), false when it works again.
 */
internal class CameraSession(
    private val context: Context,
    private val owner: LifecycleOwner,
    private val surface: PreviewView,
    private val gate: ScanGate,
    private val formats: List<Int>,
    private val onCode: (value: String, format: String) -> Unit,
    private val onCamera: (failed: Boolean) -> Unit,
    private val onFlash: (Boolean) -> Unit,
) {
    private val main = Handler(Looper.getMainLooper())
    private val thread: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "zn-scanner").apply { isDaemon = true } }
    private val preview = Preview.Builder().build()
    private val analysis = ImageAnalysis.Builder()
        // Enough for a dense QR, and light for a slow phone. Frames that come while one is being read are dropped.
        .setResolutionSelector(
            ResolutionSelector.Builder()
                .setResolutionStrategy(ResolutionStrategy(Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                .build(),
        )
        .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
        .build()

    private var provider: ProcessCameraProvider? = null
    private var camera: Camera? = null
    private var reader: BarcodeScanner? = null // the camera's thread only
    private var torch = false
    private var opened = false
    @Volatile private var closed = false

    private val stateObserver = Observer<CameraState> { state ->
        val open = state.type == CameraState.Type.OPEN
        if (open) applyTorch() // a torch asked for before the camera opened has failed: ask again
        if (open && !opened) Log.i(TAG, "scanner: camera on")
        if (!open && opened) Log.i(TAG, "scanner: camera off")
        opened = open
        val error = state.error
        if (error == null) onCamera(false)
        else {
            Log.w(TAG, "scanner: the camera says error ${error.code}")
            onCamera(true)
        }
    }

    fun start() {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            if (closed) return@addListener
            try {
                bind(future.get())
            } catch (e: Exception) { // no camera, or the phone can't run these two together
                Log.w(TAG, "scanner: the camera didn't start", e)
                onCamera(true)
            }
        }, ContextCompat.getMainExecutor(context))
    }

    private fun bind(provider: ProcessCameraProvider) {
        this.provider = provider
        preview.surfaceProvider = surface.surfaceProvider
        analysis.setAnalyzer(thread, ::read)
        val camera = provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        this.camera = camera
        onFlash(camera.cameraInfo.hasFlashUnit())
        // Forever, not with the owner: that would go deaf while the screen is stopped, the moment the camera closes. close() removes it.
        camera.cameraInfo.cameraState.observeForever(stateObserver)
    }

    /** Right away on leaving the screen: the camera must not come back with the old value. */
    fun torch(on: Boolean) {
        if (torch == on) return
        torch = on
        Log.i(TAG, "scanner: torch ${if (on) "on" else "off"}")
        applyTorch()
    }

    private fun applyTorch() {
        // Fails when the camera isn't open, and the answer can be ignored: the state observer asks again when it opens.
        camera?.takeIf { it.cameraInfo.hasFlashUnit() }?.cameraControl?.enableTorch(torch)
    }

    @OptIn(ExperimentalGetImage::class)
    private fun read(image: ImageProxy) {
        val run = gate.frame()
        val media = image.image
        if (closed || run == ScanGate.SKIP || media == null) return image.close()
        val client = reader ?: try {
            makeReader().also { reader = it }
        } catch (t: Throwable) { // this thread has no catch above it: a throw here ends the app
            Log.w(TAG, "scanner: the code reader can't start", t)
            image.close()
            main.post { if (!closed) onCamera(true) }
            return
        }
        // Results come on the main thread: the lock and the answer happen in one step, before anything async.
        client.process(InputImage.fromMediaImage(media, image.imageInfo.rotationDegrees))
            .addOnSuccessListener { codes ->
                val code = codes.firstOrNull { !it.rawValue.isNullOrEmpty() } ?: return@addOnSuccessListener
                if (closed) return@addOnSuccessListener
                val after = gate.sinceFirstFrame()
                if (gate.claim(run)) {
                    Log.i(TAG, "scanner: code read $after ms after the first frame")
                    onCode(code.rawValue!!, ScannerRules.formatName(code.format))
                } else if (gate.droppedOne()) {
                    Log.i(TAG, "scanner: second code dropped")
                }
            }
            .addOnFailureListener { e -> if (!closed) Log.w(TAG, "scanner: a frame couldn't be read: $e") }
            .addOnCompleteListener { image.close() }
    }

    private fun makeReader(): BarcodeScanner {
        MlKitStart.once(context)
        val first = formats.first()
        val rest = formats.drop(1).toIntArray()
        return BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(first, *rest).build())
    }

    fun close() {
        if (closed) return
        closed = true
        camera?.cameraInfo?.cameraState?.removeObserver(stateObserver)
        analysis.clearAnalyzer()
        preview.surfaceProvider = null
        // Only our two: another session may hold the camera by now.
        provider?.unbind(preview, analysis)
        if (opened) Log.i(TAG, "scanner: camera off")
        thread.execute { reader?.close() } // on its own thread: a frame may be making it right now
        thread.shutdown()
    }
}
