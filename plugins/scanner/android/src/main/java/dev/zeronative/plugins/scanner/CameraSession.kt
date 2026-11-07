package dev.zeronative.plugins.scanner

import android.animation.ValueAnimator
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.util.Size
import android.view.animation.DecelerateInterpolator
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
import com.google.mlkit.vision.barcode.ZoomSuggestionOptions
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal const val TAG = "zn"

/** The longest the preview stays hidden for a starting zoom. */
private const val REVEAL_MS = 600L
/** CameraX refuses a zoom just before the camera is active: try again after this. */
private const val RETRY_MS = 120L
/** How long a zoom change from ML Kit takes: a glide, not a jump. */
private const val GLIDE_MS = 300L

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
    private val zoom: ZoomWish,
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
    /** The zoom we want (the start, then the user's or ML Kit's). Null: leave the camera's own. */
    private var ratio: Float? = zoom.start
    /** The user pinched: ML Kit's suggestions stop for this scan. Read on the camera's thread too. */
    @Volatile private var pinched = false
    /** For ML Kit's suggestions; read when the reader is made, on the camera's thread. */
    @Volatile private var maxRatio = 1f
    private val reveal = Runnable { surface.alpha = 1f }
    /** The zoom gliding to ML Kit's suggestion (main thread). */
    private var glide: ValueAnimator? = null

    private val stateObserver = Observer<CameraState> { state ->
        val open = state.type == CameraState.Type.OPEN
        if (open) applyTorch() // a torch asked for before the camera opened has failed: ask again
        if (open && !opened) applyZoom(tries = 3) // CameraX goes back to 1x each time the camera closes
        // Hidden until the zoom is on again, so a return doesn't show 1x for a moment, then a jump.
        if (!open && opened && ratio != null) surface.alpha = 0f
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
        // A starting zoom: the preview stays hidden (the black behind it) until the zoom is on, so no 1x frame shows.
        surface.alpha = if (ratio != null) 0f else 1f
        val camera = provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        this.camera = camera
        maxRatio = camera.cameraInfo.zoomState.value?.maxZoomRatio ?: 1f
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

    /**
     * Sets [ratio] on the camera, inside its range. CameraX refuses a zoom while the camera isn't active yet (the future
     * fails, and the value isn't kept), so a failure tries again a moment later. The preview shows when it's done, or
     * after [REVEAL_MS] whatever happens: a black view would look like a dead camera.
     */
    private fun applyZoom(tries: Int) {
        val camera = camera ?: return
        val want = ratio ?: return
        main.removeCallbacks(reveal)
        main.postDelayed(reveal, REVEAL_MS)
        val range = camera.cameraInfo.zoomState.value
        val value = if (range != null) ZoomRule.clamp(want, range.minZoomRatio, range.maxZoomRatio) else want
        val future = camera.cameraControl.setZoomRatio(value)
        future.addListener({
            if (closed) return@addListener
            val ok = try {
                future.get()
                true
            } catch (_: Exception) {
                false
            }
            if (ok || tries <= 1) {
                main.removeCallbacks(reveal)
                surface.alpha = 1f
                if (ok) Log.i(TAG, "scanner: zoom ${"%.1f".format(value)}x on") else Log.w(TAG, "scanner: the zoom ${"%.1f".format(value)}x didn't take")
            } else main.postDelayed({
                // Shown already (the [REVEAL_MS] limit came first): glide there, don't jump in front of the user.
                if (!closed) if (surface.alpha == 1f) glideTo(want) else applyZoom(tries - 1)
            }, RETRY_MS)
        }, ContextCompat.getMainExecutor(context))
    }

    /**
     * Main thread: moves the zoom to [target] over [GLIDE_MS], easing out. CameraX 1.4 has no smooth zoom (only
     * setZoomRatio / setLinearZoom), so this sets it once per frame; each call replaces the one before. A new target
     * during a glide goes on from where the zoom is now. ML Kit's suggestions were single jumps (1.4x, 1.6x, 4x).
     */
    private fun glideTo(target: Float) {
        val camera = camera ?: return
        val from = (glide?.animatedValue as? Float) ?: camera.cameraInfo.zoomState.value?.zoomRatio ?: target
        glide?.cancel()
        ratio = target
        glide = ValueAnimator.ofFloat(from, target).apply {
            duration = GLIDE_MS
            interpolator = DecelerateInterpolator()
            addUpdateListener { if (!closed) camera.cameraControl.setZoomRatio(it.animatedValue as Float) }
            start()
        }
    }

    /** Main thread: two fingers on the preview. [factor]: how much they spread since the last call. */
    fun pinch(factor: Float) {
        val camera = camera ?: return
        if (closed || !zoom.pinch) return
        pinched = true
        glide?.cancel() // the fingers lead now
        glide = null
        val range = camera.cameraInfo.zoomState.value ?: return
        val now = ratio ?: range.zoomRatio
        ratio = ZoomRule.clamp(now * factor, range.minZoomRatio, range.maxZoomRatio)
        camera.cameraControl.setZoomRatio(ratio!!) // a refusal (camera not open) is fine: the next open sets it
    }

    /** ML Kit's suggestion, on its thread. True: we take it (on the main thread, right after). */
    private fun suggested(value: Float): Boolean {
        if (closed || !ZoomRule.autoAllowed(zoom, pinched)) return false
        main.post {
            val camera = camera ?: return@post
            if (closed || pinched) return@post
            val range = camera.cameraInfo.zoomState.value ?: return@post
            val target = ZoomRule.clamp(value, range.minZoomRatio, range.maxZoomRatio)
            Log.i(TAG, "scanner: zoom ${"%.1f".format(target)}x (ML Kit's suggestion)")
            glideTo(target)
        }
        return true
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
        val options = BarcodeScannerOptions.Builder().setBarcodeFormats(first, *rest)
        // ML Kit's auto-zoom: it asks for more zoom when a code is too small to read (a far or small QR).
        if (zoom.auto && maxRatio > 1f) {
            options.setZoomSuggestionOptions(ZoomSuggestionOptions.Builder(::suggested).setMaxSupportedZoomRatio(maxRatio).build())
            Log.i(TAG, "scanner: auto-zoom on, up to ${"%.1f".format(maxRatio)}x")
        } else if (zoom.auto) Log.i(TAG, "scanner: auto-zoom off: this camera can't zoom")
        return BarcodeScanning.getClient(options.build())
    }

    fun close() {
        if (closed) return
        closed = true
        main.removeCallbacks(reveal)
        glide?.cancel()
        surface.alpha = 1f // the next session starts from a shown view
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
