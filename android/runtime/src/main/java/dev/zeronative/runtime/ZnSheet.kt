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
import androidx.compose.ui.layout.layout
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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/** How long native waits for JS to close a dismissed sheet before springing it back (JS kept `visible` true). */
private const val KEEP_OPEN_MS = 400L
/** A fling faster than this (px/s) goes to the next detent or closes. */
private const val FLING_VELOCITY = 1200f
/** Dragged down more than this part of its lowest height: it closes on release. */
private const val DISMISS_FRACTION = 0.35f
/** How far down (part of its height) the sheet follows a predictive back gesture; less when it can't be dismissed. */
private const val BACK_TRAVEL = 0.33f
private const val BACK_TRAVEL_FIXED = 0.08f

/**
 * A Sheet's or Modal's window while it closes (its exit animation still plays): touches and Back go to the screen
 * below at once, as in RN, so the first tap after the close isn't lost. Set back if it opens again.
 */
private tailrec fun android.content.Context.findActivityWindow(): Window? = when (this) {
    is android.app.Activity -> window
    is android.content.ContextWrapper -> baseContext.findActivityWindow()
    else -> null
}

/** Drops the window's dim layer (we draw our own scrim). Only when set: each change re-lays out the window. */
internal fun Window.noDimLayer() {
    val dim = WindowManager.LayoutParams.FLAG_DIM_BEHIND
    if (attributes.flags and dim != 0) clearFlags(dim)
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
 * - **Detents:** "content" (its content's height), "half", "full"; the first one is where it opens. "content" follows
 *   the content while open: it grows (up to "full") and shrinks with a spring.
 * - Content that scrolls (a list inside) scrolls first; at its top, pulling down moves the sheet (nested scroll).
 * - Its content keeps clear of the navigation bar; "full" stops below the status bar.
 */
@Composable
internal fun ZnSheet(f: List<ZnTemplate>, t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance) {
    val visible = if (s.visibleSlot >= 0) inst.slot(s.visibleSlot).value == true else s.visible
    // animateIn={expr} (registry 22): the value when the sheet opens counts, so read it then, not on every change.
    val animateInNow = { if (s.animateInSlot >= 0) inst.slot(s.animateInSlot).value != false else s.animateIn }
    var shown by remember { mutableStateOf(false) } // the window exists (open, or animating)
    var animateIn by remember { mutableStateOf(true) } // read when the window opens (its fade-in)
    if (visible && !shown) {
        shown = true
        animateIn = animateInNow()
    }
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
            // No dim layer at all: Android 14 drops a tap that passes through a closing sheet when its window keeps
            // FLAG_DIM_BEHIND, even at 0 dim ("untrusted touch", Lava 2026-11-07: the keypad after the offers sheet).
            window?.noDimLayer()
            window?.let { WindowCompat.setDecorFitsSystemWindows(it, false) }
            // animateIn={false}: no window fade-in either (the sheet is already there, as part of a restored screen).
            if (!animateIn) window?.setWindowAnimations(0)
        }
        SheetBody(f, t, s, inst, visible, window, animateInNow, onGone = { shown = false }) { closing ->
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
    animateInNow: () -> Boolean, onGone: () -> Unit, bars: (closing: Boolean) -> Unit,
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
        // The sheet's box is as tall as its tallest detent. `sheetTop` is where its top edge is, from the top of the
        // window (screenH = closed, just below the screen). In screen terms, not as a shift of a box pinned to the bottom:
        // when the content grows or shrinks while the sheet is open, the edge stays where it is for that frame and then
        // springs to its new rest (2026-11-12, ZeroBill's offers sheet: "View all" added rows and the sheet didn't grow).
        val boxH = s.detents.maxOf { height(it) }
        val restTops = s.detents.associateWith { screenH - height(it) }
        val closed = screenH
        val sheetTop = remember { Animatable(screenH) }
        var detent by remember { mutableStateOf(s.detents.first()) }
        var gesture by remember { mutableStateOf(false) }
        // The open / close effect below saw the sheet open already (a size change then is not an opening).
        val wasOpen = remember { booleanArrayOf(false) }

        fun nearest(v: Float): String {
            val current = sheetTop.value
            val sorted = restTops.entries.sortedBy { it.value } // tallest first
            return when {
                v < -FLING_VELOCITY -> sorted.lastOrNull { it.value < current - 1f }?.key ?: sorted.first().key
                v > FLING_VELOCITY -> sorted.firstOrNull { it.value > current + 1f }?.key ?: sorted.last().key
                else -> sorted.minBy { abs(it.value - current) }.key
            }
        }

        // The user may move the sheet only while it is open: not once JS closed it, and not while the user's close waits
        // for JS's answer. Else a drag still running stops the close animation, the sheet springs back to rest and
        // onGone never runs: an empty sheet and its scrim stay over the app, and taps pass through them (ZeroBill,
        // Lava 2026-11-09: the referral reward sheet, closed by a swipe while JS was busy after login).
        // Reads state, not composition values: the nested-scroll object below keeps these functions for a while.
        fun userCanMove() = currentVisible && !dismissing

        // The user asks to close: animate down, tell JS, spring back if JS keeps it open.
        fun askToClose(velocity: Float = 0f) {
            if (!currentVisible) return // JS closed it already: its close animation runs (LaunchedEffect below)
            if (!s.dismissible) {
                scope.launch { sheetTop.animateTo(restTops.getValue(detent), springOpen, velocity) }
                return
            }
            if (dismissing || !currentVisible) return // already closing: one onDismiss per close
            dismissing = true
            scope.launch {
                if (s.onDismiss != 0) ZnRuntime.dispatchEvent(inst.id, s.onDismiss)
                sheetTop.animateTo(closed, springClose, velocity)
                delay(KEEP_OPEN_MS)
                if (currentVisible) {
                    dismissing = false // JS kept it open: it takes touches again
                    sheetTop.animateTo(restTops.getValue(detent), springOpen)
                }
            }
        }

        fun settle(velocity: Float) {
            if (!userCanMove()) return // closing: the close animation decides where it goes
            val lowest = restTops.values.max()
            val dragged = sheetTop.value - lowest
            if (velocity > FLING_VELOCITY * 1.5f || (dragged > (closed - lowest) * DISMISS_FRACTION && velocity > -FLING_VELOCITY)) {
                askToClose(velocity)
                return
            }
            val target = nearest(velocity)
            scope.launch { sheetTop.animateTo(restTops.getValue(target), springOpen, velocity) }
            if (target != detent) {
                detent = target
                if (s.onDetentChange != 0) ZnRuntime.dispatchEvent(inst.id, s.onDetentChange, target)
            }
        }

        fun dragBy(dy: Float): Float {
            if (!userCanMove()) return 0f // closing: a drag that began before must not move it
            val highest = restTops.values.min()
            val next = sheetTop.value + dy
            val applied = if (next < highest) sheetTop.value + dy * 0.25f else next // rubber-band above the top
            scope.launch { sheetTop.snapTo(applied) }
            return dy
        }

        // JS opens / closes it; a new size (content, insets, screen) moves it to its new rest.
        LaunchedEffect(visible, restTops) {
            if (contentH <= 0f) return@LaunchedEffect
            if (visible) {
                val opening = !wasOpen[0]
                wasOpen[0] = true
                // A new size while open: not while the user drags it or their close waits for JS (their gesture or the
                // close decides where it goes, with the new rests).
                if (!opening && (gesture || dismissing)) return@LaunchedEffect
                if (opening) dismissing = false // opened again while a user's dismiss waited (its wait was cancelled)
                // animateIn={false}: from closed (opening), it is at rest at once; later size changes still animate.
                // Read here, as it opens: a later change of the value doesn't move an open sheet.
                if (sheetTop.value >= closed - 1f && !animateInNow()) sheetTop.snapTo(restTops.getValue(detent))
                else sheetTop.animateTo(restTops.getValue(detent), springOpen)
            } else {
                wasOpen[0] = false
                // JS closed it: the window must always go. If something else stops this animation (another animation
                // of `sheetTop`), close at once rather than leave a scrim that lets taps through. Only a restart of this
                // effect (new size: it closes again from there) or the sheet leaving the screen ends it without onGone.
                try {
                    sheetTop.animateTo(closed, springClose)
                } catch (e: CancellationException) {
                    if (!isActive) throw e
                }
                onGone()
            }
        }

        // A list inside scrolls first; at its top, pulling down moves the sheet; pushing up opens it to the top.
        val nested = remember(restTops) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    val highest = restTops.values.min()
                    return if (available.y < 0f && sheetTop.value > highest) Offset(0f, dragBy(available.y)) else Offset.Zero
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset =
                    if (available.y > 0f && source == NestedScrollSource.UserInput) Offset(0f, dragBy(available.y)) else Offset.Zero

                override suspend fun onPreFling(available: Velocity): Velocity {
                    if (restTops.values.none { abs(it - sheetTop.value) < 1f }) {
                        settle(available.y)
                        return available
                    }
                    return Velocity.Zero
                }
            }
        }

        // Registry 24: `<Sheet motion={m}>` gives m.progress, 0 closed → 1 at its tallest detent, read frame by frame
        // (a backdrop, a header or a map that fades as the sheet rises).
        // Shown height over the tallest detent's height (the same number as before the sheet kept its top edge in
        // screen terms).
        fun progressOf(top: Float, tallest: Float, bottom: Float) = if (tallest > 0f) ((bottom - top) / tallest).coerceIn(0f, 1f) else 0f
        val boxHNow by rememberUpdatedState(boxH)
        val screenHNow by rememberUpdatedState(screenH)
        znElementOf(s, inst)?.let { e ->
            ZnProvide(e, "progress") { progressOf(sheetTop.value, boxHNow, screenHNow) }
        }
        val progress = progressOf(sheetTop.value, boxH, screenH)
        // Scrim: darkens with the sheet; a tap asks to close.
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.5f * progress)).clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { askToClose() },
        )
        // Back closes the sheet. With Android 13+ predictive back, the sheet follows the back gesture down (a third of
        // its height; a sheet that can't be dismissed only gives a little) and springs back if the user cancels.
        androidx.activity.compose.PredictiveBackHandler(enabled = true) { events ->
            val rest = restTops.getValue(detent)
            val travel = (closed - rest) * if (s.dismissible) BACK_TRAVEL else BACK_TRAVEL_FIXED
            try {
                events.collect { e -> if (userCanMove()) sheetTop.snapTo(rest + travel * e.progress) }
                askToClose()
            } catch (e: CancellationException) {
                if (userCanMove()) scope.launch { sheetTop.animateTo(restTops.getValue(detent), springOpen) }
                throw e
            }
        }

        val radius = (if (s.radius > 0f) s.radius else 24f).dp
        val shape = RoundedCornerShape(topStart = radius, topEnd = radius)
        // At least down to the screen's bottom edge: while it springs down to a new, shorter rest (content shrank) or is
        // pulled above its top, no gap shows under it.
        val surfaceH = max(boxH, screenH - sheetTop.value)
        Box(
            Modifier.align(Alignment.TopCenter)
                .fillMaxWidth()
                .then(if (contentH > 0f) Modifier.height(with(density) { surfaceH.toDp() }) else Modifier.heightIn(max = with(density) { maxH.toDp() }))
                .offset { IntOffset(0, sheetTop.value.roundToInt()) }
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
                // The sheet node's own children (its style applies here: padding, gap, ...). With a "content" detent they
                // are measured up to the tallest the sheet may be, not the sheet's height now: else content that grows
                // after the sheet opened is held to its first height (its bottom cut) and the sheet never grows
                // (2026-11-12). It still takes no more room than the sheet has; the extra is clipped until it grows.
                // Half / full sheets keep the sheet's own height (content that fills them stays as it was).
                val maxContent = (maxH - handleH - bottomInset).coerceAtLeast(0f).roundToInt()
                val growing = if ("content" !in s.detents) Modifier else Modifier.layout { m, c ->
                    val p = m.measure(c.copy(minHeight = 0, maxHeight = max(maxContent, c.minHeight)))
                    layout(p.width, p.height.coerceIn(c.minHeight, c.maxHeight)) { p.place(0, 0) }
                }
                Box(Modifier.fillMaxWidth().then(growing).onSizeChanged { size ->
                    val h = size.height.toFloat()
                    if (h > 0f && abs(h - contentH) > 0.5f) {
                        val first = contentH <= 0f
                        contentH = h
                        if (first) scope.launch { sheetTop.snapTo(screenH) }
                    }
                }) {
                    ZnColumn(f, t, inst, s, Modifier.fillMaxWidth().then(nodeChain(s, inst)), definiteWidth = true)
                }
            }
        }
    }
}
