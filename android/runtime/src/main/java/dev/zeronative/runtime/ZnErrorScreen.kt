package dev.zeronative.runtime

import android.content.Context
import android.content.Intent
import android.os.Process
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * What the user sees instead of a screen whose JS threw while building it, or when the app's JS didn't start at all
 * (step 3.9, docs/guide-notes.md §26). Drawn natively, so it can't break the way the screen did.
 *
 * Apps change its words and colours in Application.onCreate (their own language, their brand):
 *
 *     ZnErrorScreen.texts = ZnErrorScreen.Texts(title = "कुछ गड़बड़ हो गई", ...)
 *     ZnErrorScreen.colors = ZnErrorScreen.Colors(button = Color(0xFF3D26ED))
 *
 * Release builds never show the error message (it is for developers and may hold internal details); debug builds
 * show it under the text, as well as the red error screen of `zn dev`.
 */
object ZnErrorScreen {
    class Texts(
        val title: String = "Something went wrong",
        /** A screen failed and there is a screen to go back to. */
        val body: String = "This screen couldn't open. You can try again or go back.",
        /** A screen failed and it is the first screen. */
        val bodyFirstScreen: String = "This screen couldn't open. Please try again.",
        /** JS on this screen ran too long and was stopped (the time limit, [ZnRuntime.jsTimeLimitMs]). */
        val bodyHang: String = "This screen stopped responding. Try again to reload it.",
        /** The app's JS didn't start. */
        val bodyStart: String = "The app couldn't start. Restarting it usually helps.",
        val retry: String = "Try again",
        val back: String = "Go back",
        val restart: String = "Restart app",
    )

    class Colors(
        val background: Color = Color(0xFFF8FAFC),
        val title: Color = Color(0xFF0F172A),
        val body: Color = Color(0xFF475569),
        val icon: Color = Color(0xFFE2E8F0),
        val iconMark: Color = Color(0xFF475569),
        val button: Color = Color(0xFF0F172A),
        val buttonText: Color = Color.White,
        val link: Color = Color(0xFF0F172A),
    )

    /** Set these in Application.onCreate, before any screen can fail. */
    var texts = Texts()
    var colors = Colors()

    @Composable
    internal fun Draw(
        message: String,
        startFailed: Boolean,
        hung: Boolean,
        canGoBack: Boolean,
        onRetry: () -> Unit,
        onBack: () -> Unit,
    ) {
        val t = texts
        val c = colors
        val context = LocalContext.current
        Box(
            Modifier.fillMaxSize().background(c.background).windowInsetsPadding(WindowInsets.safeDrawing).padding(32.dp),
            contentAlignment = Alignment.Center,
        ) {
            Column(
                Modifier.widthIn(max = 420.dp).fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center,
            ) {
                Box(Modifier.size(56.dp).clip(CircleShape).background(c.icon), contentAlignment = Alignment.Center) {
                    BasicText("!", style = TextStyle(color = c.iconMark, fontSize = 26.sp, fontWeight = FontWeight.Bold))
                }
                Spacer(Modifier.height(20.dp))
                BasicText(
                    t.title,
                    style = TextStyle(color = c.title, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center),
                    modifier = Modifier.semantics { heading() },
                )
                Spacer(Modifier.height(8.dp))
                val body = when {
                    startFailed -> t.bodyStart
                    hung -> t.bodyHang
                    canGoBack -> t.body
                    else -> t.bodyFirstScreen
                }
                BasicText(body, style = TextStyle(color = c.body, fontSize = 15.sp, lineHeight = 21.sp, textAlign = TextAlign.Center))
                if (BuildConfig.DEBUG && message.isNotEmpty()) {
                    Spacer(Modifier.height(16.dp))
                    BasicText(
                        message,
                        maxLines = 6,
                        overflow = TextOverflow.Ellipsis,
                        style = TextStyle(color = Color(0xFFB91C1C), fontSize = 12.sp, fontFamily = FontFamily.Monospace),
                        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Color(0xFFFEF2F2)).padding(12.dp),
                    )
                }
                Spacer(Modifier.height(28.dp))
                Button(if (startFailed) t.restart else t.retry, c.button, c.buttonText, filled = true) {
                    if (startFailed) restartApp(context) else onRetry()
                }
                if (canGoBack) {
                    Spacer(Modifier.height(8.dp))
                    Button(t.back, Color.Transparent, c.link, filled = false, onClick = onBack)
                }
            }
        }
    }

    @Composable
    private fun Button(label: String, background: Color, text: Color, filled: Boolean, onClick: () -> Unit) {
        Box(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp))
                .then(if (filled) Modifier.background(background) else Modifier)
                .clickable(role = Role.Button, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            BasicText(
                label,
                style = TextStyle(color = text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            )
        }
    }

    /**
     * Starts the app again in a new process. The runtime can be replaced in place since step 4.6 (`ZnRuntime.restart`),
     * but after a failed start a fresh process is the safer clean state (native modules, threads, caches).
     */
    private fun restartApp(context: Context) {
        val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        context.startActivity(intent)
        Process.killProcess(Process.myPid())
    }
}
