package dev.zeronative.plugins.scanner

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Log
import androidx.compose.animation.core.EaseInOut
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.zeronative.runtime.ZnActivity

private val PANEL = Color(0xFF14161A)
private val MUTED = Color(0xFFA6ACB5)
private val CUTOUT_RADIUS = 6.dp
private val BRACKET_EXTRA = 25.dp
private val BRACKET_STROKE = 4.dp
private val BRACKET_RADIUS = 10.dp
private val BRACKET_CLIP = 30.dp

/** The dark shade with a clear square, corner marks and the moving line: the size and timing of the React Native screen. */
@Composable
internal fun ScanFrame(accent: Color, modifier: Modifier = Modifier) {
    val line = rememberInfiniteTransition(label = "scan line").animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(2500, easing = EaseInOut), RepeatMode.Reverse),
        label = "scan line",
    )
    Canvas(modifier.fillMaxSize()) {
        val side = minOf(size.width, size.height) * 0.75f
        val left = (size.width - side) / 2
        val top = (size.height - side) / 2
        val clear = RoundRect(Rect(left, top, left + side, top + side), CornerRadius(CUTOUT_RADIUS.toPx()))
        val shade = Path().apply {
            fillType = PathFillType.EvenOdd
            addRect(Rect(Offset.Zero, size))
            addRoundRect(clear)
        }
        drawPath(shade, Color(0x66000000))
        corners(left, top, side, accent)
        val inset = 24.dp.toPx()
        val y = top + inset + (side - inset * 2) * line.value
        val half = side * 0.4f
        drawLine(accent.copy(alpha = 0.25f), Offset(size.width / 2 - half, y), Offset(size.width / 2 + half, y), 6.dp.toPx())
        drawLine(accent, Offset(size.width / 2 - half, y), Offset(size.width / 2 + half, y), 2.dp.toPx())
    }
}

private fun DrawScope.corners(left: Float, top: Float, side: Float, color: Color) {
    val extra = BRACKET_EXTRA.toPx() / 2
    val stroke = BRACKET_STROKE.toPx()
    val clip = BRACKET_CLIP.toPx()
    val x0 = left - extra
    val y0 = top - extra
    val x1 = left + side + extra
    val y1 = top + side + extra
    val box = { drawRoundRect(color, Offset(x0 + stroke, y0 + stroke), Size(x1 - x0 - 2 * stroke, y1 - y0 - 2 * stroke), CornerRadius(BRACKET_RADIUS.toPx()), Stroke(stroke)) }
    clipRect(x0, y0, x0 + clip, y0 + clip) { box() }
    clipRect(x1 - clip, y0, x1, y0 + clip) { box() }
    clipRect(x0, y1 - clip, x0 + clip, y1) { box() }
    clipRect(x1 - clip, y1 - clip, x1, y1) { box() }
}

/** A round button on the camera. [label] is what a screen reader says, and what the phone test taps. */
@Composable
internal fun RoundButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, icon: DrawScope.() -> Unit) {
    Box(
        modifier.size(44.dp).clip(CircleShape).background(Color(0x4D000000)).border(1.dp, Color(0x33FFFFFF), CircleShape)
            .clickable(onClick = onClick).semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(24.dp), onDraw = icon)
    }
}

internal fun DrawScope.closeIcon() {
    val u = size.width / 24
    val line = Stroke(2 * u, cap = StrokeCap.Round, join = StrokeJoin.Round)
    val back = Path().apply {
        moveTo(11 * u, 5 * u)
        lineTo(4 * u, 12 * u)
        lineTo(11 * u, 19 * u)
        moveTo(4 * u, 12 * u)
        lineTo(20 * u, 12 * u)
    }
    drawPath(back, Color.White, style = line)
}

internal fun DrawScope.flashIcon(on: Boolean) {
    val u = size.width / 24
    val bolt = Path().apply {
        moveTo(13 * u, 2 * u)
        lineTo(5 * u, 14 * u)
        lineTo(11 * u, 14 * u)
        lineTo(10 * u, 22 * u)
        lineTo(19 * u, 9 * u)
        lineTo(13 * u, 9 * u)
        close()
    }
    if (on) return drawPath(bolt, Color(0xFFFFEB3B))
    drawPath(bolt, Color.White, style = Stroke(1.8f * u, join = StrokeJoin.Round))
    drawLine(Color.White, Offset(3 * u, 3 * u), Offset(21 * u, 21 * u), 2 * u, StrokeCap.Round)
}

private fun DrawScope.cameraIcon() {
    val u = size.width / 24
    val line = Stroke(1.8f * u, join = StrokeJoin.Round)
    val body = Path().apply {
        moveTo(3 * u, 8 * u)
        lineTo(7.5f * u, 8 * u)
        lineTo(9.5f * u, 5 * u)
        lineTo(14.5f * u, 5 * u)
        lineTo(16.5f * u, 8 * u)
        lineTo(21 * u, 8 * u)
        lineTo(21 * u, 19 * u)
        lineTo(3 * u, 19 * u)
        close()
    }
    drawPath(body, Color.White, style = line)
    drawCircle(Color.White, 3.5f * u, Offset(12 * u, 13 * u), style = line)
}

/** The page shown instead of a black camera: why it is off and what to do. A small view gets it without the icon. */
@Composable
internal fun ScannerMessage(title: String, body: String, action: String, texts: ScannerTexts, onAction: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().background(PANEL).padding(24.dp), contentAlignment = Alignment.Center) {
        val compact = maxHeight < 260.dp
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (!compact) {
                Box(Modifier.size(72.dp).background(Color(0x1AFFFFFF), CircleShape), contentAlignment = Alignment.Center) {
                    Canvas(Modifier.size(36.dp)) { cameraIcon() }
                }
                Box(Modifier.height(12.dp))
            }
            BasicText(title, style = TextStyle(color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center))
            BasicText(body, style = TextStyle(color = MUTED, fontSize = 14.sp, lineHeight = 20.sp, textAlign = TextAlign.Center))
            Box(Modifier.height(16.dp))
            BasicText(
                action,
                modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(texts.button).clickable(onClick = onAction)
                    .semantics { role = Role.Button }.padding(horizontal = 28.dp, vertical = 14.dp),
                style = TextStyle(color = texts.buttonText, fontSize = 16.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center),
            )
        }
    }
}

/** The page for a permission that isn't granted. While Android's dialog is open it stays plain. */
@Composable
internal fun PermissionMessage(permission: CameraPermission, texts: ScannerTexts) {
    val context = LocalContext.current
    when (permission.state) {
        ScannerRules.Permission.DENIED, ScannerRules.Permission.ASK ->
            ScannerMessage(texts.permissionTitle, texts.permissionBody, texts.allow, texts, permission.request)
        ScannerRules.Permission.BLOCKED ->
            ScannerMessage(texts.permissionTitle, texts.blockedBody, texts.settings, texts) { openSettings(context) }
        else -> Box(Modifier.fillMaxSize().background(PANEL))
    }
}

private fun openSettings(context: Context) {
    val page = Uri.fromParts("package", context.packageName, null)
    openOtherApp(context, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, page))
}

/** An Activity if we have one, so the other app opens on top of ours. */
internal fun openOtherApp(context: Context, intent: Intent) {
    try {
        val activity = ZnActivity.current
        if (activity != null) activity.startActivity(intent) else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (e: ActivityNotFoundException) {
        Log.w(TAG, "scanner: nothing can open this: $e")
    }
}

@Composable
internal fun ScanText(text: String, modifier: Modifier = Modifier, weight: FontWeight = FontWeight.Normal) {
    BasicText(
        text,
        modifier.fillMaxWidth(),
        style = TextStyle(
            color = Color.White,
            fontSize = 14.sp,
            lineHeight = 20.sp,
            fontWeight = weight,
            textAlign = TextAlign.Center,
            shadow = Shadow(Color(0x80000000), Offset(0f, 2f), 6f),
        ),
    )
}
