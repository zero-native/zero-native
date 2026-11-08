package dev.zeronative.runtime

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView

// Shared elements (registry 24, docs/gestures-and-motion-v1.md §2.7, D7): `sharedTag` on an element of two screens.
// ZnNavHost wraps the screens in a SharedTransitionLayout and gives each screen Navigation 3's AnimatedContent scope,
// so a push moves the element from one screen to the other, and Back plays it backwards. Navigation 3's predictive
// back seeks that same transition, so the shared element follows the back gesture with no code of ours.

/** The screens' SharedTransitionScope and the window it draws in (ZnNavHost); null outside the screens. */
@OptIn(ExperimentalSharedTransitionApi::class)
internal class ZnSharedHost(val scope: SharedTransitionScope, val root: android.view.View)

internal val LocalZnShared = staticCompositionLocalOf<ZnSharedHost?> { null }

/** The screen's enter / exit scope (Navigation 3's LocalNavAnimatedContentScope), set per screen by ZnNavHost. */
internal val LocalZnSharedVisibility = compositionLocalOf<AnimatedVisibilityScope?> { null }

/**
 * The shared-element modifier for a node with `sharedTag`, or null. An <Image> moves as it is (sharedElement: the
 * same picture on both screens); any other element moves its bounds and cross-fades its two contents (sharedBounds).
 * Outside a screen, or with an empty tag, nothing.
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
internal fun znSharedModifier(s: ZnNodeSpec, inst: ZnInstance): Modifier? {
    if (s.sharedTagSlot < 0 && s.sharedTag == null) return null
    val tag = if (s.sharedTagSlot >= 0) inst.slot(s.sharedTagSlot).value as? String else s.sharedTag
    val host = LocalZnShared.current ?: return null
    val visibility = LocalZnSharedVisibility.current ?: return null
    // A Sheet or Modal is its own window, but composition locals reach it: no shared element across windows.
    if (LocalView.current.rootView !== host.root) return null
    val scope = host.scope
    if (tag.isNullOrEmpty()) return null
    return with(scope) {
        val state = rememberSharedContentState(tag)
        if (s.type == Registry.Component.IMAGE) Modifier.sharedElement(state, visibility)
        else Modifier.sharedBounds(state, visibility)
    }
}
