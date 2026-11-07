package dev.zeronative.runtime

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat

/** RN's Modal animation lengths on Android (its fade and slide take about this long). */
private const val MODAL_ANIM_MS = 250

/**
 * React Native's `<Modal>` (registry 15, docs/guide-notes.md §43): a full-screen window over the app, in which the
 * app draws its own content (a centred dialog, a bottom sheet of its own, a loading layer). As in RN on Android:
 * - **Controlled by JS:** shown while `visible` is true (true when not written). Back sends `onRequestClose`; the
 *   Modal stays until JS sets `visible` to false. Native never closes it.
 * - `transparent`: the window has no background, so the screen shows through where the content draws nothing
 *   (else it is white). `animationType`: "none" (default), "fade", "slide" (up from the bottom).
 * - The content stays below the status bar and above the navigation bar, unless `statusBarTranslucent` /
 *   `navigationBarTranslucent`. It always stays above the keyboard. The bar icons follow the app's window.
 * - `onShow` once it is on screen (after its animation).
 * Its children are laid out like a Column that fills the window: `flex: 1`, `justifyContent: "center"` work as in RN.
 */
@Composable
internal fun ZnModal(f: List<ZnTemplate>, t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance) {
    val visible = when {
        s.visibleSlot >= 0 -> inst.slot(s.visibleSlot).value == true
        s.hasVisibleProp -> s.visible
        else -> true // RN: a Modal with no `visible` prop is shown
    }
    var shown by remember { mutableStateOf(false) } // the window exists (open, or animating out)
    if (visible && !shown) shown = true
    if (!shown) return

    val activityView = LocalView.current
    Dialog(
        onDismissRequest = { /* back is handled below: it asks JS (onRequestClose) */ },
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false,
            usePlatformDefaultWidth = false,
            decorFitsSystemWindows = false,
        ),
    ) {
        val view = LocalView.current
        val window = (view.parent as? DialogWindowProvider)?.window
        SideEffect {
            window?.let {
                it.setDimAmount(0f) // RN draws no dim: a transparent Modal's content brings its own
                @Suppress("DEPRECATION") // still how a window resizes for the keyboard (imePadding below)
                it.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
                WindowCompat.setDecorFitsSystemWindows(it, false)
                // The bar icons as the app's window has them (RN: the Modal doesn't change the status bar).
                val app = activityView.context.findActivity()?.window
                if (app != null) {
                    val from = WindowCompat.getInsetsController(app, activityView)
                    val to = WindowCompat.getInsetsController(it, view)
                    to.isAppearanceLightStatusBars = from.isAppearanceLightStatusBars
                    to.isAppearanceLightNavigationBars = from.isAppearanceLightNavigationBars
                }
            }
        }
        // Closing (fade / slide out): the screen below takes the next tap at once (ZnSheet's passTouchesThrough).
        SideEffect { window?.passTouchesThrough(!visible) }
        ModalBody(f, t, s, inst, visible, onGone = { shown = false })
        // A toast shown while the Modal is open draws in its window, above it (ZnToast.Host), as for a Sheet.
        val toastWindow = remember { ZnToast.openWindow() }
        DisposableEffect(toastWindow) { onDispose { ZnToast.closeWindow(toastWindow) } }
        ZnToast.Host(toastWindow)
    }
}

@Composable
private fun ModalBody(f: List<ZnTemplate>, t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance, visible: Boolean, onGone: () -> Unit) {
    val anim = s.animationType
    // 0 = hidden, 1 = shown: alpha for "fade", the slide for "slide" (as a fraction of the window's height).
    val progress = remember { Animatable(if (anim == Registry.AnimationType.NONE || anim == -1) 1f else 0f) }
    var height by remember { mutableStateOf(0) }
    val currentVisible by rememberUpdatedState(visible)
    LaunchedEffect(visible) {
        if (visible) {
            if (anim == Registry.AnimationType.FADE || anim == Registry.AnimationType.SLIDE) progress.animateTo(1f, tween(MODAL_ANIM_MS))
            if (currentVisible && s.onShow != 0) ZnRuntime.dispatchEvent(inst.id, s.onShow)
        } else {
            if (anim == Registry.AnimationType.FADE || anim == Registry.AnimationType.SLIDE) progress.animateTo(0f, tween(MODAL_ANIM_MS))
            onGone()
        }
    }
    androidx.activity.compose.BackHandler(enabled = true) {
        if (s.onRequestClose != 0) ZnRuntime.dispatchEvent(inst.id, s.onRequestClose)
    }

    // Edges the content keeps clear of; the keyboard always.
    val bars = when {
        s.statusBarTranslucent && s.navigationBarTranslucent -> null
        s.statusBarTranslucent -> WindowInsets.navigationBars
        s.navigationBarTranslucent -> WindowInsets.statusBars
        else -> WindowInsets.statusBars.union(WindowInsets.navigationBars)
    }
    Box(
        Modifier.fillMaxSize().znTestTags() // its own window: testID needs its own root
            .onSizeChanged { height = it.height }
            .graphicsLayer {
                when (anim) {
                    Registry.AnimationType.FADE -> alpha = progress.value
                    Registry.AnimationType.SLIDE -> translationY = (1f - progress.value) * height
                    else -> Unit
                }
            }
            .then(if (s.transparent) Modifier else Modifier.background(Color.White)),
    ) {
        val content = Modifier.fillMaxSize()
            .then(if (bars != null) Modifier.windowInsetsPadding(bars.only(WindowInsetsSides.Vertical + WindowInsetsSides.Horizontal)) else Modifier)
            .imePadding()
            .then(nodeChain(s, inst))
        ZnColumn(f, t, inst, s, content, definiteWidth = true)
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
