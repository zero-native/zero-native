package dev.zeronative.runtime

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import android.view.Window
import android.view.WindowManager
import androidx.core.view.WindowCompat
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.roundToInt

/** How long native waits for JS to close a dismissed sheet before springing it back (JS kept `visible` true). */
private const val KEEP_OPEN_MS = 400L
/** A fling faster than this (px/s) goes to the next detent or closes. */
private const val FLING_VELOCITY = 1200f
/** Dragged down more than this part of its lowest height: it closes on release. */
private const val DISMISS_FRACTION = 0.35f

/**
 * A Sheet's or Modal's window while it closes (its exit animation still plays): touches and Back go to the screen
 * below at once, as in RN, so the first tap after the close isn't lost. Set back if it opens again.
 */
private tailrec fun android.content.Context.findActivityWindow(): Window? = when (this) {
    is android.app.Activity -> window
    is android.content.ContextWrapper -> baseContext.findActivityWindow()
    else -> null
}

internal fun Window.passTouchesThrough(on: Boolean) {
    val flags = WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
    if (on == ((attributes.flags and flags) == flags)) return
    if (on) addFlags(flags) else clearFlags(flags)
    if (BuildConfig.DEBUG) android.util.Log.i("zn", "sheet window: ${if (on) "passes taps to the screen (closing)" else "takes taps"}")
}

/**
 * A <Sheet> (ARCHITECTURE §9.2, §9.7, §10.3): a bottom sheet over the whole screen, in its own window so the scrim
 * covers the status bar and back closes the sheet before the screen.
 *
 * - **Controlled by JS:** `visible` is a JS slot. A drag-down, fling, scrim tap or back press sends `onDismiss` and
 *   animates down; if JS sets `visible` to false the sheet goes away, if JS keeps it true it springs back up. Native
 *   never writes `visible`.
 * - **No JS during a gesture:** drag, rubber-band above the top, fling and settling are native; JS only hears
 *   onDismiss and onDetentChange (when it settles on another detent).
 * - **Detents:** "content" (its content's height), "half", "full"; the first one is where it opens.
 * - Content that scrolls (a list inside) scrolls first; at its top, pulling down moves the sheet (nested scroll).
 * - Its content keeps clear of the navigation bar; "full" stops below the status bar.
 */
@Composable
internal fun ZnSheet(f: List<ZnTemplate>, t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance) {
    val visible = if (s.visibleSlot >= 0) inst.slot(s.visibleSlot).value == true else s.visible
    var shown by remember { mutableStateOf(false) } // the window exists (open, or animating)
    if (visible && !shown) shown = true
    if (!shown) return

    val activityView = LocalView.current
    Dialog(
        onDismissRequest = { /* handled by SheetBody's back handling below */ },
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        val view = LocalView.current
        val window = (view.parent as? DialogWindowProvider)?.window
        val lightSheet = (s.background ?: Color.White).luminance() > 0.5f
        // The status bar icons the sheet's window has when it opens (it draws the scrim under the status bar).
        val openStatusIcons = remember { window?.let { WindowCompat.getInsetsController(it, view).isAppearanceLightStatusBars } }
        SideEffect {
            window?.setDimAmount(0f) // our own scrim follows the drag
            window?.let { WindowCompat.setDecorFitsSystemWindows(it, false) }
            // animateIn={false}: no window fade-in either (the sheet is already there, as part of a restored screen).
            if (!s.animateIn) window?.setWindowAnimations(0)
        }
        SheetBody(f, t, s, inst, visible, window, onGone = { shown = false }) { closing ->
            val w = window ?: return@SheetBody
            val to = WindowCompat.getInsetsController(w, view)
            // Android takes the bar icons from the top full-screen window, and the sheet's stays on top until its slide
            // down ends: while it closes, the icons are the screen's, at once (Pavan saw white icons ~1 s after a close).
            val app = activityView.context.findActivityWindow()?.let { WindowCompat.getInsetsController(it, activityView) }
            if (closing && app != null) {
                to.isAppearanceLightStatusBars = app.isAppearanceLightStatusBars
                to.isAppearanceLightNavigationBars = app.isAppearanceLightNavigationBars
            } else {
                if (openStatusIcons != null) to.isAppearanceLightStatusBars = openStatusIcons
                // The sheet is under the navigation bar: its buttons must contrast with the sheet, not the screen.
                to.isAppearanceLightNavigationBars = lightSheet
            }
        }
        // A toast shown while the sheet is open draws in the sheet's window, above it (ZnToast.Host).
        val toastWindow = remember { ZnToast.openWindow() }
        DisposableEffect(toastWindow) { onDispose { ZnToast.closeWindow(toastWindow) } }
        ZnToast.Host(toastWindow)
    }
}

@Composable
private fun SheetBody(
    f: List<ZnTemplate>, t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance, visible: Boolean, window: Window?,
    onGone: () -> Unit, bars: (closing: Boolean) -> Unit,
) {
    val scope = rememberCoroutineScope()
    // The user asked to close (scrim, Back, drag) and native is waiting for JS's answer (KEEP_OPEN_MS).
    var dismissing by remember { mutableStateOf(false) }
    // Closing: the screen below takes the next tap at once, not after the slide down (ZeroBill payment pass: the
    // first keypad tap after "Continue" was lost on the scrim, and sent onDismiss a second time).
    val closing = !visible || dismissing
    SideEffect {
        window?.passTouchesThrough(closing)
        bars(closing)
    }
    val density = LocalDensity.current
    val currentVisible by rememberUpdatedState(visible)
    val springOpen = remember { spring<Float>(dampingRatio = 0.85f, stiffness = Spring.StiffnessMediumLow) }
    val springClose = remember { spring<Float>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = Spring.StiffnessMedium) }

    BoxWithConstraints(Modifier.fillMaxSize().znTestTags()) { // its own window: testID needs its own root
        val screenH = constraints.maxHeight.toFloat()
        val topInset = WindowInsets.statusBars.getTop(density).toFloat()
        val bottomInset = WindowInsets.navigationBars.getBottom(density).toFloat()
        val handleH = with(density) { 20.dp.toPx() }
        var contentH by remember { mutableFloatStateOf(0f) }
        val maxH = screenH - topInset
        // contentH is the content alone; the handle and the navigation-bar inset are added here, on every composition,
        // because the dialog window learns its insets after the first layout (found on the Lava: the last row was cut).
        fun height(detent: String): Float = when (detent) {
            "half" -> screenH * 0.5f
            "full" -> maxH
            else -> (contentH + handleH + bottomInset).coerceAtMost(maxH)
        }
        // The sheet's box is as tall as its tallest detent; `offset` moves it down from there (0 = tallest).
        val boxH = s.detents.maxOf { height(it) }
        val restOffsets = s.detents.associateWith { boxH - height(it) }
        val closed = boxH
        val offset = remember { Animatable(screenH) }
        var detent by remember { mutableStateOf(s.detents.first()) }
        var gesture by remember { mutableStateOf(false) }

        fun nearest(v: Float): String {
            val current = offset.value
            val sorted = restOffsets.entries.sortedBy { it.value } // tallest first
            return when {
                v < -FLING_VELOCITY -> sorted.lastOrNull { it.value < current - 1f }?.key ?: sorted.first().key
                v > FLING_VELOCITY -> sorted.firstOrNull { it.value > current + 1f }?.key ?: sorted.last().key
                else -> sorted.minBy { abs(it.value - current) }.key
            }
        }

        // The user asks to close: animate down, tell JS, spring back if JS keeps it open.
        fun askToClose(velocity: Float = 0f) {
            if (!s.dismissible) {
                scope.launch { offset.animateTo(restOffsets.getValue(detent), springOpen, velocity) }
                return
            }
            if (dismissing || !currentVisible) return // already closing: one onDismiss per close
            dismissing = true
            scope.launch {
                if (s.onDismiss != 0) ZnRuntime.dispatchEvent(inst.id, s.onDismiss)
                offset.animateTo(closed, springClose, velocity)
                delay(KEEP_OPEN_MS)
                if (currentVisible) {
                    dismissing = false // JS kept it open: it takes touches again
                    offset.animateTo(restOffsets.getValue(detent), springOpen)
                }
            }
        }

        fun settle(velocity: Float) {
            val lowest = restOffsets.values.max()
            val dragged = offset.value - lowest
            if (velocity > FLING_VELOCITY * 1.5f || (dragged > (closed - lowest) * DISMISS_FRACTION && velocity > -FLING_VELOCITY)) {
                askToClose(velocity)
                return
            }
            val target = nearest(velocity)
            scope.launch { offset.animateTo(restOffsets.getValue(target), springOpen, velocity) }
            if (target != detent) {
                detent = target
                if (s.onDetentChange != 0) ZnRuntime.dispatchEvent(inst.id, s.onDetentChange, target)
            }
        }

        fun dragBy(dy: Float): Float {
            val top = restOffsets.values.min()
            val next = offset.value + dy
            val applied = if (next < top) offset.value + dy * 0.25f else next // rubber-band above the top
            scope.launch { offset.snapTo(applied) }
            return dy
        }

        // JS opens / closes it.
        LaunchedEffect(visible, boxH) {
            if (contentH <= 0f) return@LaunchedEffect
            if (visible) {
                dismissing = false // opened again while a user's dismiss waited (its wait was cancelled)
                // animateIn={false}: from closed (opening), it is at rest at once; later size changes still animate.
                if (!s.animateIn && offset.value >= closed - 1f) offset.snapTo(restOffsets.getValue(detent))
                else offset.animateTo(restOffsets.getValue(detent), springOpen)
            } else {
                offset.animateTo(closed, springClose)
                onGone()
            }
        }

        // A list inside scrolls first; at its top, pulling down moves the sheet; pushing up opens it to the top.
        val nested = remember(restOffsets) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    val top = restOffsets.values.min()
                    return if (available.y < 0f && offset.value > top) Offset(0f, dragBy(available.y)) else Offset.Zero
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
                    if (available.y > 0f && source == NestedScrollSource.UserInput) Offset(0f, dragBy(available.y)) else Offset.Zero

                override suspend fun onPreFling(available: Velocity): Velocity {
                    if (restOffsets.values.none { abs(it - offset.value) < 1f }) {
                        settle(available.y)
                        return available
                    }
                    return Velocity.Zero
                }
            }
        }

        val progress = if (closed > 0f) (1f - offset.value / closed).coerceIn(0f, 1f) else 0f
        // Scrim: darkens with the sheet; a tap asks to close.
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f * progress)).clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { askToClose() },
        )
        androidx.activity.compose.BackHandler(enabled = true) { askToClose() }

        val radius = (if (s.radius > 0f) s.radius else 24f).dp
        val shape = RoundedCornerShape(topStart = radius, topEnd = radius)
        Box(
            Modifier.align(Alignment.BottomCenter)
                .fillMaxWidth()
                .then(if (contentH > 0f) Modifier.height(with(density) { boxH.toDp() }) else Modifier.heightIn(max = with(density) { maxH.toDp() }))
                .offset { IntOffset(0, offset.value.roundToInt()) }
                .shadow(16.dp, shape)
                .clip(shape)
                .background(s.background ?: Color.White)
                .draggable(
                    state = rememberDraggableState { dy -> dragBy(dy) },
                    orientation = Orientation.Vertical,
                    onDragStarted = { gesture = true },
                    onDragStopped = { v -> gesture = false; settle(v) },
                )
                .nestedScroll(nested),
        ) {
            Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars)) {
                // Drag handle.
                Box(Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 6.dp), contentAlignment = Alignment.Center) {
                    Box(Modifier.width(40.dp).height(4.dp).clip(RoundedCornerShape(2.dp)).background(Color(0xFFCBD5E1)))
                }
                // The sheet node's own children (its style applies here: padding, gap, ...).
                Box(Modifier.fillMaxWidth().onSizeChanged { size ->
                    val h = size.height.toFloat()
                    if (h > 0f && abs(h - contentH) > 0.5f) {
                        val first = contentH <= 0f
                        contentH = h
                        if (first) scope.launch { offset.snapTo(screenH) }
                    }
                }) {
                    ZnColumn(f, t, inst, s, Modifier.fillMaxWidth().then(nodeChain(s, inst)), definiteWidth = true)
                }
            }
        }
    }
}
