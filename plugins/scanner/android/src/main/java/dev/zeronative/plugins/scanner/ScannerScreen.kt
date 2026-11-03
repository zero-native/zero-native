package dev.zeronative.plugins.scanner

import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.windowInsetsBottomHeight
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnScreenScope
import org.json.JSONObject

/**
 * The full scanner, opened with `nav.pushForResult`. It answers `{ value, format }` once; Back and close answer null.
 * The app's route needs `safeArea: "none"`: the camera runs under the status bar.
 */
@Composable
internal fun ScannerScreen(scope: ZnScreenScope) {
    val texts = remember { ScannerTexts(scope.params) }
    val permission = rememberCameraPermission(ask = true)
    val gate = remember { ScanGate(SystemClock::elapsedRealtime) }
    var locked by remember { mutableStateOf(false) }
    var torch by rememberSaveable { mutableStateOf(false) }
    var hasFlash by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    DarkBars()

    Column(Modifier.fillMaxSize().background(Color.Black)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            when {
                permission.state != ScannerRules.Permission.GRANTED -> PermissionMessage(permission, texts)
                else -> {
                    ScannerCamera(
                        gate = gate,
                        running = !locked, // the camera stops while the code is handled, also behind the closing animation
                        torch = torch,
                        formats = texts.formats,
                        attempt = attempt,
                        onCode = { value, format ->
                            locked = true
                            scope.finish(JSONObject().put("value", value).put("format", format))
                        },
                        onFailed = { failed = it },
                        onFlash = { hasFlash = it },
                        onLeft = { torch = false }, // goes off with the camera, and must not come back by surprise on return
                    )
                    ScanFrame(texts.accent)
                    if (failed) {
                        ScannerMessage(texts.failedTitle, texts.failedBody, texts.retry, texts) {
                            failed = false
                            attempt++
                        }
                    } else {
                        TopAndBottom(texts)
                        if (hasFlash) {
                            RoundButton(
                                label = if (torch) texts.torchOff else texts.torchOn,
                                onClick = { torch = !torch },
                                modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 8.dp, end = 16.dp),
                            ) { flashIcon(torch) }
                        }
                    }
                }
            }
            RoundButton(
                label = texts.close,
                onClick = { scope.cancel() },
                modifier = Modifier.statusBarsPadding().padding(top = 8.dp, start = 16.dp),
            ) { closeIcon() }
        }
        // The camera page ends above the navigation bar, which stays black.
        Spacer(Modifier.fillMaxWidth().windowInsetsBottomHeight(WindowInsets.navigationBars))
    }
}

@Composable
private fun TopAndBottom(texts: ScannerTexts) {
    val context = LocalContext.current
    Box(Modifier.fillMaxSize()) {
        Column(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0x99000000), Color.Transparent)))
                .padding(top = 100.dp, bottom = 20.dp, start = 24.dp, end = 24.dp),
        ) {
            ScanText(texts.title)
        }
        if (texts.hint.isNotEmpty() || (texts.linkLabel.isNotEmpty() && texts.linkUrl != null)) {
            Column(
                Modifier.align(Alignment.BottomCenter).fillMaxWidth()
                    .background(Brush.verticalGradient(listOf(Color.Transparent, Color(0xCC000000))))
                    .padding(top = 40.dp, bottom = 42.dp, start = 24.dp, end = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                if (texts.hint.isNotEmpty()) ScanText(texts.hint, weight = FontWeight.Medium)
                if (texts.linkLabel.isNotEmpty() && texts.linkUrl != null) {
                    Spacer(Modifier.height(24.dp))
                    BasicText(
                        texts.linkLabel,
                        modifier = Modifier.clip(RoundedCornerShape(30.dp)).background(Color(0x4D000000))
                            .border(1.dp, texts.accent, RoundedCornerShape(30.dp))
                            .clickable { openOtherApp(context, Intent(Intent.ACTION_VIEW, Uri.parse(texts.linkUrl))) }
                            .semantics { role = Role.Button }.padding(horizontal = 24.dp, vertical = 12.dp),
                        style = TextStyle(color = Color.White, fontSize = 14.sp, fontWeight = FontWeight.Medium),
                    )
                }
            }
        }
    }
}

/**
 * Light bar icons on the black page while this screen is in front. The host picks icons from a screen's template, and a
 * native screen has none, so it would draw dark icons on black. What was there goes back when the screen stops being in front.
 */
@Composable
private fun DarkBars() {
    val view = LocalView.current
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, view) {
        var status: Boolean? = null
        var navigation = true
        val controller = { ZnActivity.current?.window?.let { WindowCompat.getInsetsController(it, view) } }
        val restore = {
            status?.let { was -> controller()?.apply {
                isAppearanceLightStatusBars = was
                isAppearanceLightNavigationBars = navigation
            } }
            status = null
        }
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> controller()?.apply {
                    if (status == null) {
                        status = isAppearanceLightStatusBars
                        navigation = isAppearanceLightNavigationBars
                    }
                    isAppearanceLightStatusBars = false
                    isAppearanceLightNavigationBars = false
                }
                Lifecycle.Event.ON_PAUSE -> restore()
                else -> Unit
            }
        }
        owner.lifecycle.addObserver(observer)
        onDispose {
            owner.lifecycle.removeObserver(observer)
            restore()
        }
    }
}
