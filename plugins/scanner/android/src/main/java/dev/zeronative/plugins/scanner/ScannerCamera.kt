package dev.zeronative.plugins.scanner

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.view.ViewGroup
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.zeronative.runtime.ZnActivity

/**
 * The live camera and its code reader, for the screen and the view. It follows the screen it is on through
 * [LocalLifecycleOwner]: a covered screen gets the same pause as an app in the background.
 *
 * [running] false stops the camera: the app is handling a code, or JS turned it off. [attempt]: a new value tries again.
 * [onLeft] runs when the screen stops being in front, so the torch can go off.
 */
@Composable
internal fun ScannerCamera(
    gate: ScanGate,
    running: Boolean,
    torch: Boolean,
    formats: List<Int>,
    attempt: Int,
    onCode: (value: String, format: String) -> Unit,
    onFailed: (Boolean) -> Unit,
    onFlash: (Boolean) -> Unit,
    onLeft: () -> Unit,
) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    val code by rememberUpdatedState(onCode)
    val failed by rememberUpdatedState(onFailed)
    val flash by rememberUpdatedState(onFlash)
    val left by rememberUpdatedState(onLeft)
    val surface = remember { previewView(context) }
    var session by remember { mutableStateOf<CameraSession?>(null) }

    AndroidView({ surface }, Modifier.fillMaxSize())

    // Before the camera starts, so a return opens the gate before the first frame can come.
    DisposableEffect(owner, gate) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> gate.start()
                Lifecycle.Event.ON_PAUSE -> {
                    gate.stop()
                    session?.torch(false)
                    left()
                }
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            gate.stop()
        }
    }

    DisposableEffect(owner, running, attempt, formats) {
        if (!running) return@DisposableEffect onDispose {}
        if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) gate.start() // "scan again": a new stale window
        val next = CameraSession(context, owner, surface, gate, formats, { v, f -> code(v, f) }, { failed(it) }, { flash(it) })
        session = next
        next.start()
        onDispose {
            session = null
            next.close()
        }
    }

    LaunchedEffect(session, torch) { session?.torch(torch) }
}

private fun previewView(context: Context) = PreviewView(context).apply {
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    // A TextureView: it moves with the screen in a transition, where a SurfaceView would show a black gap.
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
    keepScreenOn = true
}

/** What a screen knows about the camera permission. [request] shows Android's dialog. */
internal class CameraPermission(val state: ScannerRules.Permission, val request: () -> Unit)

/**
 * Reads the permission when the screen opens and at every return, as the user may have changed it in settings. With [ask],
 * Android's dialog comes by itself the first time. Saved state: Android can rebuild the screen under the dialog.
 */
@Composable
internal fun rememberCameraPermission(ask: Boolean): CameraPermission {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var asking by rememberSaveable { mutableStateOf(false) }
    var asked by rememberSaveable { mutableStateOf(false) }
    var reads by remember { mutableIntStateOf(0) } // Android's answer isn't Compose state, so a new value reads it again
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        asking = false
        asked = true
        reads++
    }
    val granted = remember(reads) { ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED }
    val rationale = remember(reads) { ZnActivity.current?.shouldShowRequestPermissionRationale(Manifest.permission.CAMERA) == true }
    val state = ScannerRules.permission(granted, asking, asked, rationale)
    val request = {
        asking = true
        launcher.launch(Manifest.permission.CAMERA)
    }

    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                if (asking) { // back from the dialog and no answer came (a rebuilt screen): what is true now is the answer
                    asking = false
                    asked = true
                }
                reads++
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }

    LaunchedEffect(state, reads) {
        if (ask && state == ScannerRules.Permission.ASK && owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) request()
    }
    // ASK with [ask] is a moment before the dialog: no message for that one frame.
    val shown = if (ask && state == ScannerRules.Permission.ASK) ScannerRules.Permission.ASKING else state
    return remember(shown) { CameraPermission(shown, request) }
}
