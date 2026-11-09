package dev.zeronative.runtime

import android.content.Context
import android.content.res.Configuration
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Animatable
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.widget.ImageView
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * How the update screen looks (docs/ota-patches.md §8). It carries on from Android's launch screen: the same
 * background and the app icon in the same place, with a title, a line and a progress bar under it.
 * [background] null: the theme's launch background. [accent]: the progress bar (use the app's brand colour).
 * [icon]: a drawable shown where the launch icon was, null: the launch icon. Give one when the launch icon is animated:
 * Android shows an animated icon's last frame, this screen would show its first. An animated one ([icon] an
 * `animated-vector`, e.g. a resting coin with a looping glint) starts when the screen shows. It is drawn as Android 12+
 * draws a splash icon without an icon background: into a 288 dp box, centred (ZeroBill's RN art is made for it).
 */
class ZnUpdateScreen(
    val title: String = "Updating for a better experience",
    val subtitle: String = "This takes only a few seconds",
    val accent: Color = Color(0xFF2563EB),
    val background: Color? = null,
    @androidx.annotation.DrawableRes val icon: Int? = null,
)

/**
 * The launch gate (docs/ota-patches.md §8), like ZeroBill's RN Gate 1. At a start with UI (a cold start, or a fresh
 * start after the user closed the app while the process stayed), the update check runs at once. Then:
 * - While the check runs, Android's launch screen stays up, at most [ZnOta.Config.launchDecisionMs] from the tap.
 *   Most starts have no update, so a slow answer never holds a start longer than that.
 * - The answer has nothing for now (no update, or priority normal): the app opens. A normal update still downloads and
 *   runs from the next cold start.
 * - An update with priority high or critical: the update screen shows (it carries on from the launch screen), the
 *   bundle downloads (a patch when the server has one), and the app swaps to it before the user sees the first screen
 *   ([ZnOta.applyNow]: the same screens open again, so a restored checkout opens again too).
 * - Time limit, from the tap: [ZnOta.Config.launchCapMs] for high, [ZnOta.Config.launchCapCriticalMs] for critical.
 *   After a short grace time the gate also leaves early when the download's pace says it can't end in time. When it
 *   leaves, the app opens on the old bundle; the download goes on and the update runs from the next start (a critical
 *   one sooner: the app's gates call `Updates.applyNow()`, `Updates.status().nextPriority`).
 * - A hold (`Updates.holdApply()`, a payment) or a pending answer from another app (UPI) refuses the swap: the app
 *   opens on the old bundle. Payments come first.
 * Main thread only, except where noted.
 */
internal object ZnOtaGate {
    private const val TAG = "zn-ota"
    /** After the update screen shows, the gate waits this long before it trusts the download's pace (RN: 400 ms). */
    private const val GRACE_MS = 400L
    /** Time an install and swap take after the last byte, for the pace check (unzip, checks, a new JS runtime). */
    private const val APPLY_ALLOWANCE_MS = 600L
    /** A process that started this long before its first Activity was started for something else (a push): the tap is now. */
    private const val LATE_ACTIVITY_MS = 2_000L
    private const val TICK_MS = 50L
    /** After a swap, the update screen stays at most this long if the new screens never say they are up. */
    private const val SWAP_TIMEOUT_MS = 3_000L

    private enum class Phase { OFF, CHECKING, STAGING, READY, SWAPPING }

    private val main = Handler(Looper.getMainLooper())
    private var phase = Phase.OFF
    /** uptimeMillis of the tap. */
    private var tapAt = 0L
    private var priority = 0
    private var screenAt = 0L
    private var downloadAt = 0L
    private var kind = "cold"
    /**
     * uptimeMillis when the launch icon's animation ends (Android 12+ `windowSplashScreenAnimationDuration`). During
     * an update the launch screen stays until then, so the update screen takes over from the icon's last frame (its
     * resting state, [ZnUpdateScreen.icon]) and not from the middle of the animation.
     */
    private var iconEndsAt = 0L

    /** Compose state: the update screen is shown ([UpdateScreenHost]). */
    internal var showing by mutableStateOf(false)
        private set
    /** Compose state: download progress 0..1 for the bar. */
    internal var progress by mutableFloatStateOf(0f)
        private set
    /** The update screen was composed once: Android's launch screen may go now. */
    private var screenComposed = false

    /** ZnSplash asks this at every frame while it holds the launch screen. */
    internal fun holdsSplash(): Boolean = when (phase) {
        Phase.CHECKING -> true
        Phase.STAGING, Phase.READY, Phase.SWAPPING -> !screenComposed || SystemClock.uptimeMillis() < iconEndsAt
        Phase.OFF -> false
    }

    /**
     * A cold start: the first Activity of this process is being created. [check] starts the update check now
     * (instead of the usual few seconds later).
     */
    fun beginCold(check: () -> Unit) {
        val start = Process.getStartUptimeMillis()
        val now = SystemClock.uptimeMillis()
        begin(if (now - start < LATE_ACTIVITY_MS) start else now, "cold", check)
    }

    /** A fresh start in a live process (the user closed the app from Recents and opened it again): the tap is now. */
    fun beginWarm(check: () -> Unit) = begin(SystemClock.uptimeMillis(), "warm", check)

    private fun begin(tap: Long, why: String, check: () -> Unit) {
        val c = ZnOta.configOrNull() ?: return
        if (c.launchDecisionMs <= 0 || phase != Phase.OFF) return
        tapAt = tap
        iconEndsAt = if (why == "cold") tap + ZnOta.launchIconMs() else 0L // a fresh start in a live process has no animated icon
        kind = why
        priority = 0
        screenComposed = false
        progress = 0f
        phase = Phase.CHECKING
        Log.i(TAG, "gate: $why start, checking (waits at most ${c.launchDecisionMs} ms from the tap)")
        check()
        tick()
    }

    /**
     * Any thread: the check found an update and starts its download. [p]: 0 normal, 1 high, 2 critical. Only counts
     * while the gate still waits for the answer.
     */
    fun found(p: Int) = main.post {
        if (phase != Phase.CHECKING) return@post
        priority = p
        if (p < 1) return@post end("normal priority: it runs from the next start")
        phase = Phase.STAGING
        downloadAt = SystemClock.uptimeMillis()
        show()
    }

    /**
     * Any thread: the check ended. [ready]: a bundle is installed and waiting (`current` differs from what runs);
     * [p]: its priority (a kill switch or a switch to a kept bundle counts as found here, with no download).
     */
    fun checkDone(ready: Boolean, p: Int, result: String) = main.post {
        when (phase) {
            Phase.CHECKING -> if (ready && p >= 1) {
                priority = p
                phase = Phase.READY
                show()
            } else end(if (ready) "normal priority: it runs from the next start" else "nothing to apply ($result)")
            Phase.STAGING -> if (ready) phase = Phase.READY else end("the download didn't finish ($result)")
            else -> Unit
        }
        tick()
    }

    /** Main thread, from [ZnOta.screensUp]: the new bundle's screens are built after a swap. */
    fun screensUp() {
        if (phase == Phase.SWAPPING) end(null)
    }

    private fun show() {
        screenAt = SystemClock.uptimeMillis()
        showing = true
        Log.i(TAG, "gate: priority ${if (priority >= 2) "critical" else "high"} update, the update screen shows ${screenAt - tapAt} ms after the tap")
    }

    /** Main thread: [UpdateScreenHost] composed the screen. */
    internal fun composed() {
        if (!screenComposed) Log.i(TAG, "gate: the update screen is composed, ${SystemClock.uptimeMillis() - tapAt} ms after the tap")
        screenComposed = true
    }

    private fun tick() {
        main.removeCallbacks(ticker)
        if (phase == Phase.OFF) return
        val c = ZnOta.configOrNull() ?: return end("updates are off")
        val now = SystemClock.uptimeMillis()
        val cap = tapAt + if (priority >= 2) c.launchCapCriticalMs else c.launchCapMs
        when (phase) {
            Phase.CHECKING -> if (now >= tapAt + c.launchDecisionMs) return end("no answer within ${c.launchDecisionMs} ms")
            Phase.STAGING -> {
                val (ph, prog) = ZnOta.phaseAndProgress()
                progress = if (ph == "installing") 1f else prog.toFloat().coerceIn(0f, 1f)
                val graceEnds = screenAt + GRACE_MS
                if (now >= maxOf(cap, graceEnds)) return end("time limit while $ph (${(prog * 100).toInt()} %)")
                if (now >= graceEnds && ph == "downloading" && prog > 0.0) {
                    val eta = ((now - downloadAt) * (1 - prog) / prog).toLong() + APPLY_ALLOWANCE_MS
                    if (now + eta > cap) return end("the download can't end in time (about $eta ms left)")
                }
            }
            Phase.READY -> {
                progress = 1f
                if (now >= cap) return end("time limit before the swap")
                // applyNow needs the first screens of the running bundle (it opens the same ones again).
                if (ZnNav.firstScreensUp && screenComposed) swap()
            }
            Phase.SWAPPING -> if (now >= tapAt + c.launchCapCriticalMs + SWAP_TIMEOUT_MS) return end("the new screens didn't say they are up")
            Phase.OFF -> return
        }
        main.postDelayed(ticker, TICK_MS)
    }

    private val ticker = Runnable { tick() }

    private fun swap() {
        phase = Phase.SWAPPING
        val t = SystemClock.uptimeMillis()
        ZnOta.applyNow { r ->
            if (!r.optBoolean("applied")) end("the swap was refused: ${r.optString("reason")} ${r.optString("error")}".trim())
            else Log.i(TAG, "gate: swapped to ${r.opt("bundle")} at the update screen, ${SystemClock.uptimeMillis() - tapAt} ms after the tap (swap ${SystemClock.uptimeMillis() - t} ms)")
        }
    }

    /** Ends the gate. [gaveUp]: why it let the app open on the old bundle (null: it swapped). */
    private fun end(gaveUp: String?) {
        if (phase == Phase.OFF) return
        val wasShowing = showing
        phase = Phase.OFF
        main.removeCallbacks(ticker)
        showing = false
        val ms = SystemClock.uptimeMillis() - tapAt
        if (gaveUp == null) {
            ZnOta.gateOutcome("gate_swap", "$kind start, priority $priority, ${ms} ms after the tap")
        } else {
            Log.i(TAG, "gate: the app opens on the bundle it has: $gaveUp (${ms} ms after the tap)")
            // Only a gate that showed the update screen is worth a report (most starts have no update).
            if (wasShowing) ZnOta.gateOutcome("gate_timeout", "$kind start, priority $priority: $gaveUp, ${ms} ms after the tap")
        }
    }
}

/**
 * The update screen, over everything while the gate stages an update (drawn by [ZnNavHost]). It takes every touch.
 */
@Composable
internal fun UpdateScreenHost() {
    val look = ZnOta.configOrNull()?.updateScreen ?: return
    val context = LocalContext.current
    val launch = remember { launchLook(context) }
    AnimatedVisibility(visible = ZnOtaGate.showing, enter = EnterTransition.None, exit = fadeOut(tween(180))) {
        SideEffect { ZnOtaGate.composed() }
        val background = look.background ?: launch.background
        val dark = background.luminance() < 0.5f
        Box(
            Modifier.fillMaxSize().background(background)
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = {}),
        ) {
            // The icon exactly where Android's launch screen drew it (the centre; an adaptive icon in 160 dp with the
            // phone's icon shape, any other drawable in the 288 dp box): the screen carries on.
            val icon = remember(look.icon) { look.icon?.let { runCatching { context.getDrawable(it) }.getOrNull() } ?: launch.icon }
            if (icon != null) {
                val box = if (icon is AdaptiveIconDrawable) ICON_BOX else ICON_BOX_PLAIN
                AndroidView(
                    factory = { ctx -> ImageView(ctx).apply { scaleType = ImageView.ScaleType.FIT_CENTER; setImageDrawable(icon) } },
                    modifier = Modifier.align(Alignment.Center).size(box),
                    // A looping animated-vector (a glint) plays while shown; once (update runs at every recomposition).
                    update = { (icon as? Animatable)?.let { if (!it.isRunning) it.start() } },
                )
            }
            // Under the icon: the words and the bar fade in, so the change from the launch screen is soft.
            var shown by remember { mutableStateOf(false) }
            SideEffect { shown = true }
            val alpha by animateFloatAsState(if (shown) 1f else 0f, tween(220), label = "update-screen")
            val bar by animateFloatAsState(ZnOtaGate.progress, tween(250), label = "update-progress")
            Column(
                Modifier.align(Alignment.Center).offset(y = ICON_BOX / 2 + 72.dp).fillMaxWidth().padding(horizontal = 32.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                BasicText(
                    look.title,
                    style = TextStyle(
                        color = (if (dark) Color(0xFFF3F4F6) else Color(0xFF111827)).copy(alpha = alpha),
                        fontSize = 18.sp, fontWeight = FontWeight.Bold, textAlign = TextAlign.Center, lineHeight = 24.sp,
                    ),
                )
                Spacer(Modifier.height(6.dp))
                BasicText(
                    look.subtitle,
                    style = TextStyle(
                        color = (if (dark) Color(0xFF9CA3AF) else Color(0xFF6B7280)).copy(alpha = alpha),
                        fontSize = 14.sp, textAlign = TextAlign.Center, lineHeight = 20.sp,
                    ),
                )
                Spacer(Modifier.height(20.dp))
                Box(
                    Modifier.width(200.dp).height(6.dp).clip(RoundedCornerShape(3.dp))
                        .background((if (dark) Color(0xFF374151) else Color(0xFFE5E7EB)).copy(alpha = alpha)),
                ) {
                    // A small start, so the bar never looks stuck at 0 before the first bytes.
                    Box(
                        Modifier.fillMaxWidth(bar.coerceIn(0.06f, 1f)).height(6.dp).clip(RoundedCornerShape(3.dp))
                            .background(look.accent.copy(alpha = alpha)),
                    )
                }
            }
        }
    }
}

/** Android 12+ draws an icon with a background in a 240 dp box, its visible part 160 dp (the splash screen spec). */
private val ICON_BOX = 160.dp
/** And an icon without an icon background (an app's own splash drawable) in a 288 dp box, visible within 192 dp. */
private val ICON_BOX_PLAIN = 288.dp

private class LaunchLook(val background: Color, val icon: Drawable?)

/** The launch screen's background and icon, read from the Activity's theme (Android 12+) or the app icon. */
private fun launchLook(context: Context): LaunchLook {
    val theme = context.theme
    // Only a solid colour counts: a theme can resolve these to transparent (the zn sample did, 2026-11-09), and a
    // see-through update screen showed the app under it.
    fun colorAttr(attr: Int): Color? {
        val a = theme.obtainStyledAttributes(intArrayOf(attr))
        return try {
            if (!a.hasValue(0)) null
            else (runCatching { Color(a.getColor(0, 0)) }.getOrNull()
                ?: (a.getDrawable(0) as? ColorDrawable)?.let { Color(it.color) })?.takeIf { it.alpha == 1f }
        } finally {
            a.recycle()
        }
    }
    val night = (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    val background = (if (Build.VERSION.SDK_INT >= 31) colorAttr(android.R.attr.windowSplashScreenBackground) else null)
        ?: colorAttr(android.R.attr.windowBackground)
        ?: if (night) Color(0xFF111827) else Color.White
    val icon = (if (Build.VERSION.SDK_INT >= 31) {
        val a = theme.obtainStyledAttributes(intArrayOf(android.R.attr.windowSplashScreenAnimatedIcon))
        try { a.getDrawable(0) } finally { a.recycle() }
    } else null) ?: runCatching { context.packageManager.getApplicationIcon(context.applicationInfo) }.getOrNull()
    return LaunchLook(background, icon)
}
