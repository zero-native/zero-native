package dev.zeronative.runtime

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.view.WindowManager
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.AnimatedContentTransitionScope.SlideDirection
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.ContentTransform
import androidx.compose.animation.EnterExitState
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.imeAnimationTarget
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.plus
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.LayoutDirection
import androidx.core.view.WindowCompat
import androidx.navigation3.runtime.NavEntry
import androidx.navigation3.scene.Scene
import androidx.navigation3.ui.LocalNavAnimatedContentScope
import androidx.navigation3.ui.NavDisplay
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size

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
    ReportWindow()
    ReportKeyboard()
    val top = ZnNav.stack.lastOrNull()
    // The top route at once (the frame it appears), and any secure screen still drawn: one that is leaving or being covered
    // shows for its whole animation (~300 ms), and a screenshot then must not catch it.
    SecureWindow(top?.route?.secure == true || secureDrawn.intValue > 0)
    // Status bar icons: the top screen's <StatusBar barStyle> (registry 15), else the route's `statusBar` option.
    // Navigation bar icons: its <NavigationBar barStyle>, else from what is behind the bar (its <NavigationBar>
    // backgroundColor, else the screen's own background): dark icons on a light screen, so a full-bleed header
    // doesn't get a scrim over the bottom bar.
    val topSpec = top?.route?.templateId?.let { bundle.templates.getOrNull(it)?.nodes?.firstOrNull() }
    val topBackground = topSpec?.let { rootBackground(it, top.let { e -> ZnStore.find(e.id) }) }
    val statusBar = top?.let { ZnSystemBars.merged(it.id, navigation = false) }
    val navBar = top?.let { ZnSystemBars.merged(it.id, navigation = true) }
    BarIcons(
        statusDark = statusBar?.darkIcons ?: top?.route?.darkBarIcons ?: true,
        navDark = navBar?.darkIcons ?: (((navBar?.background ?: topBackground)?.luminance() ?: 1f) > 0.5f),
        statusHidden = statusBar?.hidden == true,
        navColoured = navBar?.background != null,
    )
    // Impressions count only while the app is in front.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> ZnImpressions.resumed = true
                Lifecycle.Event.ON_PAUSE -> ZnImpressions.resumed = false
                else -> Unit
            }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }

    // Keyboard.dismiss() (ZnKeyboard) clears focus in this window.
    val focusManager = LocalFocusManager.current
    DisposableEffect(focusManager) {
        ZnKeyboard.focusManager = focusManager
        onDispose { if (ZnKeyboard.focusManager === focusManager) ZnKeyboard.focusManager = null }
    }

    // Back on the only screen: NavDisplay leaves it to the system, unless the screen asked for it (tabs on a later tab).
    // Registered before the screens, so a sheet inside one still gets Back first.
    androidx.activity.compose.BackHandler(
        enabled = ZnNav.stack.size == 1 && top != null && ZnNav.backWanted.containsKey(top.id),
    ) { ZnNav.systemBack() }

    Box(modifier) {
        // A dev reload bumps the generation: the old screens are dropped at once instead of animating out.
        key(ZnNav.generation) { Screens(bundle, safe) }
        Cover()
        ZnToast.Host()
        ZnAlert.Host()
        if (BuildConfig.DEBUG) ZnDev.Overlay()
    }
}

/** How many `secure: true` screens are drawn right now, an exit or cover animation included (main thread). */
private val secureDrawn = mutableIntStateOf(0)

/** No screenshots or recordings while a `secure: true` route is drawn. A window the app itself made secure stays that way. */
@Composable
private fun SecureWindow(secure: Boolean) {
    val window = ZnActivity.current?.window
    DisposableEffect(secure, window) {
        val ours = secure && window != null && window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0
        if (ours) window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { if (ours) window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }
}

@Composable
private fun Screens(bundle: ZnBundle, safe: WindowInsets) {
    NavDisplay(
        backStack = ZnNav.stack,
        modifier = Modifier.fillMaxSize().znTestTags(),
        onBack = { ZnNav.systemBack() },
        entryProvider = { entry ->
            NavEntry(entry, contentKey = entry.id, metadata = transitions(entry.route.transition)) { e ->
                DisposableEffect(e.id) {
                    ZnNav.shown(e.id)
                    onDispose { ZnNav.hidden(e.id) }
                }
                if (e.route.secure) {
                    DisposableEffect(e.id) {
                        secureDrawn.intValue++
                        onDispose { secureDrawn.intValue-- }
                    }
                }
                e.route.native?.let { name ->
                    NativeScreen(e, name, safe)
                    return@NavEntry
                }
                val root = ZnStore.find(e.id) ?: return@NavEntry
                val template = bundle.templates.getOrNull(root.templateId)
                // The screen's own background fills behind the bars it doesn't avoid (read at runtime when it
                // changes, registry 15), with its <StatusBar> / <NavigationBar> colours over the bars.
                val background = template?.nodes?.firstOrNull()?.let { rootBackground(it, root) } ?: Color.Transparent
                val sides = safeSides(e.route)
                Box(
                    Modifier.fillMaxSize().background(background)
                        .then(barStrips(ZnSystemBars.merged(e.id, false)?.background, ZnSystemBars.merged(e.id, true)?.background))
                        .then(if (sides != null) Modifier.windowInsetsPadding(safe.only(sides)) else Modifier)
                        // keyboard: "resize" (default): the screen ends above the keyboard. The bar padding above has
                        // used up the navigation bar's share, so only the rest of the keyboard's height is added.
                        .then(if (e.route.resizeForKeyboard) Modifier.imePadding() else Modifier),
                ) {
                    // A screen whose JS threw (or an app whose JS didn't start) shows the error screen instead.
                    val appFailed = ZnNav.appFailed
                    val failure = appFailed ?: ZnNav.failed[e.id]
                    if (failure != null) {
                        ZnErrorScreen.Draw(
                            message = failure,
                            startFailed = appFailed != null,
                            hung = failure.startsWith(ZnRuntime.TIME_LIMIT_ERROR),
                            canGoBack = appFailed == null && ZnNav.stack.indexOf(e) > 0,
                            onRetry = { ZnNav.retry(e.id) },
                            onBack = { ZnNav.systemBack() },
                        )
                    } else {
                        // Has this screen's enter transition ended? A TextField's autoFocus waits for it, so Android's
                        // autofill sees the field where it ends up, not off screen mid-slide (R36 on the pilot's login).
                        val visibility = LocalNavAnimatedContentScope.current.transition
                        val settled = remember(visibility) {
                            derivedStateOf { visibility.currentState == EnterExitState.Visible && visibility.targetState == EnterExitState.Visible }
                        }
                        CompositionLocalProvider(LocalZnEntry provides e.id, LocalZnScreenSettled provides settled) {
                            ZnScreen(bundle.templates, root, Modifier.fillMaxSize())
                        }
                    }
                }
            }
        },
    )
}

/** A plugin's native screen (docs/plugins.md §5), with the route's safe area. The bundle needs its plugin's module, so a missing one is rare. */
@Composable
private fun NativeScreen(e: ZnEntry, name: String, safe: WindowInsets) {
    val sides = safeSides(e.route)
    Box(Modifier.fillMaxSize().then(if (sides != null) Modifier.windowInsetsPadding(safe.only(sides)) else Modifier)) {
        val content = ZnNativeScreens.get(name)
        if (content != null) {
            content(remember(e.id) { ZnScreenScope(e) })
        } else {
            ZnErrorScreen.Draw(
                message = "no native screen \"$name\"",
                startFailed = false,
                hung = false,
                canGoBack = ZnNav.stack.indexOf(e) > 0,
                onRetry = { ZnNav.systemBack() },
                onBack = { ZnNav.systemBack() },
            )
        }
    }
}

/**
 * While an update is applied in place ([ZnNav.cover], step 4.6): a plain cover in the top screen's background colour
 * that takes every touch. It appears at once and fades out once the new screens are drawn.
 */
@Composable
private fun Cover() {
    val color = ZnNav.cover
    var last by remember { mutableStateOf(Color.Transparent) }
    if (color != null) last = color
    AnimatedVisibility(visible = color != null, enter = EnterTransition.None, exit = fadeOut(tween(COVER_FADE_MS))) {
        Box(
            Modifier.fillMaxSize().background(last)
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = {}),
        )
    }
}

private const val COVER_FADE_MS = 180

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
    // generation: a dev reload starts a new JS, which must hear the insets again.
    LaunchedEffect(top, bottom, start, end, ZnNav.generation) { ZnNav.reportInsets(top, bottom, start, end) }
}

/** Sends the window's size (dp), density and font scale to JS's `Dimensions` when they change (rotation, split screen). */
@Composable
private fun ReportWindow() {
    val density = LocalDensity.current
    val size = LocalWindowInfo.current.containerSize
    val context = LocalContext.current
    LaunchedEffect(size, density, ZnNav.generation) {
        val (sw, sh) = ZnWindow.screenPx(context)
        val d = density.density
        ZnWindow.reportWindow(ZnWindow.windowJson(size.width / d, size.height / d, d, density.fontScale, sw / d, sh / d))
    }
}

/**
 * Sends the keyboard's height (dp, from the bottom of the window; 0 when hidden) to JS's `Keyboard` listeners. The
 * animation's target, not each frame: one event per show or hide, at its start.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ReportKeyboard() {
    val density = LocalDensity.current
    val height = WindowInsets.imeAnimationTarget.getBottom(density) / density.density
    LaunchedEffect(height, ZnNav.generation) { ZnWindow.reportKeyboard(height) }
}

/**
 * Dark bar icons (true) for light backgrounds, light icons (false) for dark ones. [statusHidden]: <StatusBar hidden>.
 * [navColoured]: a <NavigationBar backgroundColor> is drawn behind the navigation bar, so Android must not lay its
 * own see-through scrim over it (3-button navigation).
 */
@Composable
private fun BarIcons(statusDark: Boolean, navDark: Boolean, statusHidden: Boolean, navColoured: Boolean) {
    val view = LocalView.current
    LaunchedEffect(statusDark, navDark, statusHidden, navColoured) {
        val window = view.context.findActivity()?.window ?: return@LaunchedEffect
        WindowCompat.getInsetsController(window, view).apply {
            isAppearanceLightStatusBars = statusDark
            isAppearanceLightNavigationBars = navDark
            if (statusHidden) {
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                hide(WindowInsetsCompat.Type.statusBars())
            } else {
                show(WindowInsetsCompat.Type.statusBars())
            }
        }
        if (android.os.Build.VERSION.SDK_INT >= 29) window.isNavigationBarContrastEnforced = !navColoured
    }
}

/** A screen's root background now: the slot's value when it changes at runtime, else the template's. */
private fun rootBackground(spec: ZnNodeSpec, root: ZnInstance?): Color? =
    if (spec.backgroundSlot >= 0 && root != null) toColor(root.slot(spec.backgroundSlot).value) else spec.background

/**
 * <StatusBar backgroundColor> / <NavigationBar backgroundColor> (registry 15): the colour drawn over the screen's
 * background behind each bar, under the screen's content (a full-bleed header still covers it).
 */
@Composable
private fun barStrips(status: Color?, navigation: Color?): Modifier {
    if (status == null && navigation == null) return Modifier
    val density = LocalDensity.current
    val top = WindowInsets.statusBars.getTop(density).toFloat()
    val bottom = WindowInsets.navigationBars.getBottom(density).toFloat()
    return Modifier.drawBehind {
        if (status != null && top > 0f) drawRect(status, size = Size(size.width, top))
        if (navigation != null && bottom > 0f) drawRect(navigation, Offset(0f, size.height - bottom), Size(size.width, bottom))
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
