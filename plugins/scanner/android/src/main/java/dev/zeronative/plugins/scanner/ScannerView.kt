package dev.zeronative.plugins.scanner

import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import dev.zeronative.runtime.ZnViewScope
import org.json.JSONObject

/**
 * The camera inside a JS screen: `<NativeView name="scanner.qr">`, or `QrScanner` from the package. After one code it stops
 * and waits: JS shows its own sheet over it, and a new `scanKey` scans again. So a wrong code can get "Scan again" with the
 * camera behind it, which the full screen can't do: it closes when it answers.
 *
 * Saved values, not plain state: this composable leaves when the screen is covered and comes back on return.
 */
@Composable
internal fun ScannerView(scope: ZnViewScope) {
    val props = scope.props
    val raw = props.toString()
    val texts = remember(raw) { ScannerTexts(props) }
    val wanted = props.optBoolean("torch", false)
    val active = props.optBoolean("active", true)
    val scanKey = props.optString("scanKey", "")
    val permission = rememberCameraPermission(ask = props.optBoolean("askPermission", true))
    val gate = remember { ScanGate(SystemClock::elapsedRealtime) }
    var locked by rememberSaveable(scope.id) { mutableStateOf(false) }
    var lastKey by rememberSaveable(scope.id) { mutableStateOf(scanKey) }
    var held by rememberSaveable(scope.id) { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }

    LaunchedEffect(scanKey) {
        if (scanKey != lastKey) {
            lastKey = scanKey
            locked = false
            gate.release()
        }
    }
    LaunchedEffect(wanted) { held = TorchRule.heldAfterProp(wanted, held) }
    LaunchedEffect(permission.state) {
        if (permission.state != ScannerRules.Permission.ASKING) {
            scope.emit("permission", JSONObject().put("state", permission.state.jsName))
        }
    }
    LaunchedEffect(failed) {
        if (failed) scope.emit("error", JSONObject().put("code", "camera_failed").put("message", "the camera can't start"))
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (permission.state != ScannerRules.Permission.GRANTED) {
            PermissionMessage(permission, texts)
            return@Box
        }
        ScannerCamera(
            gate = gate,
            running = active && !locked,
            torch = TorchRule.isOn(wanted, held),
            formats = texts.formats,
            zoom = texts.zoom,
            attempt = attempt,
            onCode = { value, format ->
                locked = true
                scope.emit("scanned", JSONObject().put("value", value).put("format", format))
            },
            onFailed = { failed = it },
            onFlash = {},
            onLeft = {
                if (TorchRule.isOn(wanted, held)) scope.emit("torch", JSONObject().put("on", false))
                held = TorchRule.heldAfterLeaving(wanted, held)
            },
        )
        if (failed) {
            ScannerMessage(texts.failedTitle, texts.failedBody, texts.retry, texts) {
                failed = false
                attempt++
            }
        }
    }
}
