package dev.zeronative.exp4

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionLayout
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier

@OptIn(ExperimentalSharedTransitionApi::class)
val LocalSharedTransitionScope = staticCompositionLocalOf<SharedTransitionScope?> { null }
val LocalAnimatedVisibilityScope = staticCompositionLocalOf<AnimatedVisibilityScope?> { null }

/**
 * Top-level Animated Screen Navigation Host with Shared Element Transition Support
 * Handles 90/120 FPS slide, fade, and hero transitions between Zero-Native screens
 */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun NavigationHost(modifier: Modifier = Modifier) {
    val currentEntry = NavigationManager.currentEntry
    val isForward = NavigationManager.isForwardTransition

    SharedTransitionLayout(modifier = modifier) {
        CompositionLocalProvider(
            LocalSharedTransitionScope provides this
        ) {
            AnimatedContent(
                targetState = currentEntry,
                transitionSpec = {
                    if (isForward) {
                        (slideInHorizontally(
                            initialOffsetX = { fullWidth -> fullWidth },
                            animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing)
                        ) + fadeIn(animationSpec = tween(280))).togetherWith(
                            slideOutHorizontally(
                                targetOffsetX = { fullWidth -> -fullWidth / 3 },
                                animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing)
                            ) + fadeOut(animationSpec = tween(280))
                        )
                    } else {
                        (slideInHorizontally(
                            initialOffsetX = { fullWidth -> -fullWidth / 3 },
                            animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing)
                        ) + fadeIn(animationSpec = tween(280))).togetherWith(
                            slideOutHorizontally(
                                targetOffsetX = { fullWidth -> fullWidth },
                                animationSpec = tween(durationMillis = 280, easing = FastOutSlowInEasing)
                            ) + fadeOut(animationSpec = tween(280))
                        )
                    }
                },
                label = "zn_nav_transition",
                modifier = Modifier.fillMaxSize()
            ) { targetEntry ->
                CompositionLocalProvider(
                    LocalAnimatedVisibilityScope provides this@AnimatedContent
                ) {
                    ZnView(id = targetEntry.entryId, modifier = Modifier.fillMaxSize())
                }
            }
        }
    }
}
