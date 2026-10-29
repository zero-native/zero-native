package dev.zeronative.runtime

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.plus
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.view.WindowCompat
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.scene.Scene
import androidx.navigation3.ui.NavDisplay

/**
 * Draws the back stack ([ZnNav.stack]) with Navigation 3 (ARCHITECTURE §11). Transitions are native and chosen per
 * route; JS never animates a page change. Back presses go to JS through [ZnNav.systemBack].
 *
 * Safe areas are native and per route (`safeArea`, docs/styling-and-layout.md §6): each screen is padded away from
 * the system bars on the edges its route asks for, and its root background fills behind the bars. The host Activity
 * must draw edge to edge (`enableEdgeToEdge()`). The insets are also sent to JS for full-bleed screens (`insets()`).
 *
 * Shared elements (`heroTag`, ARCHITECTURE §11) are not built yet: when they are, wrap this in
 * `SharedTransitionLayout` and pass it as `sharedTransitionScope`.
 */
@Composable
fun ZnNavHost(bundle: ZnBundle, modifier: Modifier = Modifier) {
    // System bars and display cutouts. The keyboard is not part of it (it comes with text fields).
    val safe = WindowInsets.systemBars.union(WindowInsets.displayCutout)
    ReportInsets(safe)
    val top = ZnNav.stack.lastOrNull()
    // Status bar icons: the route's `statusBar` option. Navigation bar icons: from the screen's own background
    // (dark icons on a light screen), so a full-bleed header doesn't get a scrim over the bottom bar.
    val topBackground = top?.route?.templateId?.let { bundle.templates.getOrNull(it)?.nodes?.firstOrNull()?.background }
    BarIcons(statusDark = top?.route?.darkBarIcons ?: true, navDark = (topBackground?.luminance() ?: 1f) > 0.5f)

    NavDisplay(
        backStack = ZnNav.stack,
        modifier = modifier,
        onBack = { ZnNav.systemBack() },
        entryProvider = { entry ->
            NavEntry(entry, contentKey = entry.id, metadata = transitions(entry.route.transition)) { e ->
                DisposableEffect(e.id) {
                    ZnNav.shown(e.id)
                    onDispose { ZnNav.hidden(e.id) }
                }
                val root = ZnStore.find(e.id) ?: return@NavEntry
                val template = bundle.templates.getOrNull(root.templateId)
                // The screen's own background fills behind the bars it doesn't avoid.
                val background = template?.nodes?.firstOrNull()?.background ?: Color.Transparent
                val sides = safeSides(e.route)
                Box(
                    Modifier.fillMaxSize().background(background)
                        .then(if (sides != null) Modifier.windowInsetsPadding(safe.only(sides)) else Modifier),
                ) {
                    ZnScreen(bundle.templates, root, Modifier.fillMaxSize())
                }
            }
        },
    )
}

/** Edges a route keeps clear of the system bars: "all", "none", or { top, bottom } (start / end follow "all"). */
private fun safeSides(route: ZnRoute): WindowInsetsSides? = when {
    route.safeTop && route.safeBottom -> WindowInsetsSides.Horizontal + WindowInsetsSides.Vertical
    route.safeTop -> WindowInsetsSides.Horizontal + WindowInsetsSides.Top
    route.safeBottom -> WindowInsetsSides.Horizontal + WindowInsetsSides.Bottom
    else -> null
}

/** Sends the safe-area insets (dp) to JS whenever they change (rotation, cutout, bar mode). */
@Composable
private fun ReportInsets(safe: WindowInsets) {
    val density = LocalDensity.current
    val ltr = LocalLayoutDirection.current == LayoutDirection.Ltr
    fun dp(px: Int) = px / density.density
    val top = dp(safe.getTop(density))
    val bottom = dp(safe.getBottom(density))
    val left = dp(safe.getLeft(density, LayoutDirection.Ltr))
    val right = dp(safe.getRight(density, LayoutDirection.Ltr))
    val start = if (ltr) left else right
    val end = if (ltr) right else left
    LaunchedEffect(top, bottom, start, end) { ZnNav.reportInsets(top, bottom, start, end) }
}

/** Dark bar icons (true) for light backgrounds, light icons (false) for dark ones. */
@Composable
private fun BarIcons(statusDark: Boolean, navDark: Boolean) {
    val view = LocalView.current
    LaunchedEffect(statusDark, navDark) {
        val window = view.context.findActivity()?.window ?: return@LaunchedEffect
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = statusDark
            isAppearanceLightNavigationBars = navDark
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

private const val DURATION_MS = 300
private fun <T> spec() = tween<T>(DURATION_MS, easing = FastOutSlowInEasing)

/** A route's transition as Navigation 3 metadata: how it comes in, how it leaves on back (also predictive back). */
private fun transitions(t: ZnRoute.Transition): Map<String, Any> {
    val push: AnimatedContentTransitionScope<Scene<*>>.() -> ContentTransform
    val pop: AnimatedContentTransitionScope<Scene<*>>.() -> ContentTransform
    when (t) {
        // Slides from the end edge (right in LTR, left in RTL); the old screen moves a little behind it.
        ZnRoute.Transition.PUSH -> {
            push = {
                slideIntoContainer(SlideDirection.Start, spec()) togetherWith
                    slideOutOfContainer(SlideDirection.Start, spec()) { it / 4 }
            }
            pop = {
                ContentTransform(
                    slideIntoContainer(SlideDirection.End, spec()) { it / 4 },
                    slideOutOfContainer(SlideDirection.End, spec()),
                    targetContentZIndex = -1f, // the leaving screen stays on top while it slides away
                )
            }
        }
        // Comes up from the bottom over the old screen, goes back down.
        ZnRoute.Transition.MODAL -> {
            push = { slideIntoContainer(SlideDirection.Up, spec()) togetherWith ExitTransition.KeepUntilTransitionsFinished }
            pop = {
                ContentTransform(EnterTransition.None, slideOutOfContainer(SlideDirection.Down, spec()), targetContentZIndex = -1f)
            }
        }
        ZnRoute.Transition.FADE -> {
            push = { fadeIn(spec()) togetherWith fadeOut(spec()) }
            pop = push
        }
        ZnRoute.Transition.NONE -> {
            push = { EnterTransition.None togetherWith ExitTransition.None }
            pop = push
        }
    }
    return NavDisplay.transitionSpec(push) +
        NavDisplay.popTransitionSpec(pop) +
        NavDisplay.predictivePopTransitionSpec { _ -> pop() }
}
