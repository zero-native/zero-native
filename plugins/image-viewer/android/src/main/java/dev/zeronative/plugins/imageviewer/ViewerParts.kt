package dev.zeronative.plugins.imageviewer

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material.ripple.RippleAlpha
import androidx.compose.material.ripple.createRippleModifierNode
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.zeronative.runtime.ZnActivity

/**
 * The close button, the same as ZeroBill's React Native viewer: a white Material "arrow back" (rounded) icon, 24 dp, in a
 * 48 dp touch area (TalkBack's smallest), no circle at rest. A press shows a round white ripple (24 %, 28 dp). The arrow
 * turns around in right-to-left layouts.
 */
@Composable
internal fun CloseButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    Box(
        modifier.size(48.dp)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = WhiteRipple, onClick = onClick)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(24.dp)) {
            val k = size.width / 24f
            withTransform({
                if (rtl) scale(-1f, 1f, pivot = center)
                scale(k, k, pivot = Offset.Zero)
            }) { drawPath(BackArrow, Color.White) }
        }
    }
}

/** Material Symbols "arrow_back" rounded, filled, in a 24 x 24 box (the prototype's `icons/arrow-back-rounded.svg`). */
private val BackArrow: Path = PathParser().parsePathString(
    "m7.825 13l4.9 4.9q.3.3.288.7t-.313.7q-.3.275-.7.288t-.7-.288l-6.6-6.6q-.15-.15-.213-.325T4.426 12t.063-.375t.212-.325" +
        "l6.6-6.6q.275-.275.688-.275t.712.275q.3.3.3.713t-.3.712L7.825 11H19q.425 0 .713.288T20 12t-.288.713T19 13z",
).toPath()

/** A round white ripple outside the button's box, as RN's ZIconButton on dark (borderless, size / 2 + 4 = 28 dp). */
private object WhiteRipple : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = createRippleModifierNode(
        interactionSource = interactionSource,
        bounded = false,
        radius = 28.dp,
        color = { Color.White },
        rippleAlpha = { RippleAlpha(draggedAlpha = 0.16f, focusedAlpha = 0.1f, hoveredAlpha = 0.08f, pressedAlpha = 0.24f) },
    )

    override fun equals(other: Any?) = other === this
    override fun hashCode() = 7
}

/** "2 / 5" in white over the dark scrim. TalkBack reads [spoken]. */
@Composable
internal fun Counter(text: String, spoken: String, modifier: Modifier = Modifier) {
    BasicText(
        text,
        modifier = modifier.semantics { contentDescription = spoken },
        style = TextStyle(color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    )
}

/** A small turning white arc while a picture loads. */
@Composable
internal fun Spinner(modifier: Modifier = Modifier) {
    val turn by rememberInfiniteTransition(label = "spinner").animateFloat(
        0f,
        360f,
        infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
        label = "turn",
    )
    Canvas(modifier.size(32.dp)) {
        val w = 3.dp.toPx()
        rotate(turn) {
            drawArc(
                Color.White,
                startAngle = 0f,
                sweepAngle = 270f,
                useCenter = false,
                topLeft = Offset(w / 2, w / 2),
                size = Size(size.width - w, size.height - w),
                style = Stroke(w, cap = StrokeCap.Round),
            )
        }
    }
}

/** A picture that didn't load: a broken picture sign, the words, and a button to try again. */
@Composable
internal fun LoadError(text: String, retry: String, onRetry: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Canvas(Modifier.size(48.dp)) {
            val w = 2.dp.toPx()
            val c = Color(0xB3FFFFFF)
            drawRoundRect(c, Offset(w, size.height * 0.15f), Size(size.width - 2 * w, size.height * 0.7f), CornerRadius(4.dp.toPx()), style = Stroke(w))
            drawCircle(c, size.width * 0.08f, Offset(size.width * 0.32f, size.height * 0.38f))
            drawLine(c, Offset(size.width * 0.15f, size.height * 0.75f), Offset(size.width * 0.45f, size.height * 0.5f), w, StrokeCap.Round)
            drawLine(c, Offset(size.width * 0.45f, size.height * 0.5f), Offset(size.width * 0.85f, size.height * 0.72f), w, StrokeCap.Round)
            drawLine(Color.White, Offset(size.width * 0.1f, size.height * 0.05f), Offset(size.width * 0.9f, size.height * 0.95f), w * 1.5f, StrokeCap.Round)
        }
        Spacer(Modifier.height(12.dp))
        BasicText(text, style = TextStyle(color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center))
        Spacer(Modifier.height(16.dp))
        BasicText(
            retry,
            modifier = Modifier.clip(RoundedCornerShape(50)).background(Color.White).clickable(onClick = onRetry)
                .semantics { role = Role.Button }.padding(horizontal = 24.dp, vertical = 12.dp),
            style = TextStyle(color = Color(0xFF111111), fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
        )
    }
}

/**
 * Light bar icons on the dark page while this screen is in front. The host picks icons from a screen's template, and a
 * native screen has none, so it would draw dark icons on black. What was there goes back when the screen stops being in
 * front. The same as the scanner's.
 */
@Composable
internal fun DarkBars() {
    val view = LocalView.current
    val owner = LocalLifecycleOwner.current
    DisposableEffect(owner, view) {
        var status: Boolean? = null
        var navigation = true
        val controller = { ZnActivity.current?.window?.let { WindowCompat.getInsetsController(it, view) } }
        val restore = {
            status?.let { was ->
                controller()?.apply {
                    isAppearanceLightStatusBars = was
                    isAppearanceLightNavigationBars = navigation
                }
            }
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
