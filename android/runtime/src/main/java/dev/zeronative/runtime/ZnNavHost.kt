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
import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt

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
    // While startApp's `top` layer shows, it is under the status bar: its <StatusBar>, else its background, picks the icons.
    val layer = ZnNav.layers[ZnNav.LAYER_TOP]?.let { ZnStore.find(it) }?.takeIf { topLayerShown.value }
    val layerDark = layer?.let { ZnSystemBars.merged(it.id, navigation = false)?.darkIcons ?: ((layerBackground(bundle, it).luminance()) > 0.5f) }
    BarIcons(
        statusDark = layerDark ?: statusBar?.darkIcons ?: top?.route?.darkBarIcons ?: true,
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
        key(ZnNav.generation) {
            TopLayerAndScreens(bundle, safe)
            OverlayLayer(bundle)
        }
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

/** Does startApp's `top` layer have any height now (for the status bar icons)? */
private val topLayerShown = mutableStateOf(false)

/** The `top` layer's height animations (RN's offline strip: opens in 200 ms, closes in 250 ms). */
private const val LAYER_OPEN_MS = 200
private const val LAYER_CLOSE_MS = 250

private fun layerBackground(bundle: ZnBundle, root: ZnInstance): Color =
    bundle.templates.getOrNull(root.templateId)?.nodes?.firstOrNull()?.let { rootBackground(it, root) } ?: Color.Transparent

/**
 * The screens, with startApp's `top` layer above them (host API 9). The layer's content takes its own height c. While
 * c > 0 the layer is the status bar area (filled with the layer root's background) plus the content, and the screens
 * move down by c: they keep their own status bar padding, which is now under the layer. So the layer covers nothing
 * and no screen's insets change. Native screens move with them.
 * The layer's height animates to its new size (open 200 ms, close 250 ms) and clips the content; the screens follow
 * frame by frame. Content removed when it closes is gone at once: the layer shrinks in its root's background colour.
 */
@Composable
private fun TopLayerAndScreens(bundle: ZnBundle, safe: WindowInsets) {
    val root = ZnNav.layers[ZnNav.LAYER_TOP]?.let { ZnStore.find(it) }
    val inset = safe.getTop(LocalDensity.current)
    val content = remember { mutableIntStateOf(0) }
    val c = if (root == null) 0 else content.intValue
    val target = if (c > 0) c + inset else 0
    val height = remember { Animatable(0f) }
    LaunchedEffect(target) {
        height.animateTo(target.toFloat(), tween(if (target > height.value) LAYER_OPEN_MS else LAYER_CLOSE_MS, easing = FastOutSlowInEasing))
    }
    LaunchedEffect(Unit) { snapshotFlow { height.value > 0f }.collect { topLayerShown.value = it } }
    Layout(
        contents = listOf(
            { Screens(bundle, safe) },
            {
                if (root != null) {
                    Box(Modifier.background(layerBackground(bundle, root)).clipToBounds()) {
                        CompositionLocalProvider(LocalZnEntry provides root.id) {
                            ZnScreen(
                                bundle.templates,
                                root,
                                Modifier.offset { IntOffset(0, inset) }
                                    .wrapContentHeight(Alignment.Top, unbounded = true)
                                    .onSizeChanged { content.intValue = it.height },
                            )
                        }
                    }
                }
            },
        ),
        modifier = Modifier.fillMaxSize(),
    ) { (screens, layer), k ->
        val width = k.maxWidth
        // Read here (layout), so the animation moves things without composing again.
        val h = height.value.roundToInt().coerceIn(0, k.maxHeight)
        val down = (h - inset).coerceAtLeast(0)
        val screensPlaced = screens.map { it.measure(Constraints.fixed(width, k.maxHeight - down)) }
        // Measured also at height 0: its content must report its own height to open the layer.
        val layerPlaced = layer.firstOrNull()?.measure(Constraints.fixed(width, h))
        layout(width, k.maxHeight) {
            screensPlaced.forEach { it.place(0, down) }
            layerPlaced?.place(0, 0) // last: drawn over the screens' own status bar padding
        }
    }
}

/**
 * startApp's `overlay` layer (host API 9): over the whole window, under toasts and alerts. Where it draws nothing it
 * takes no touches (no node of it handles them), so the screen under it works. A <Sheet> in it is its own window.
 */
@Composable
private fun OverlayLayer(bundle: ZnBundle) {
    val root = ZnNav.layers[ZnNav.LAYER_OVERLAY]?.let { ZnStore.find(it) } ?: return
    CompositionLocalProvider(LocalZnEntry provides root.id) {
        ZnScreen(bundle.templates, root, Modifier.fillMaxSize())
    }
}

@Composable
private fun Screens(bundle: ZnBundle, safe: WindowInsets) {
    NavDisplay(
        backStack = ZnNav.stack,
        modifier = Modifier.fillMaxSize().znTestTags(),
        onBack = { ZnNav.systemBack() },
        entryProvider = { entry ->
            NavEntry(entry, contentKey = entry.id, metadata = transitions(entry.route.transition, entry.openedAtStart)) { e ->
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
private fun transitions(t: ZnRoute.Transition, atStart: Boolean = false): Map<String, Any> {
    var push: AnimatedContentTransitionScope<Scene<*>>.() -> ContentTransform
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
    // One of the first screens (ZnEntry.openedAtStart): it is simply there, under the splash hold.
    if (atStart) push = { EnterTransition.None togetherWith ExitTransition.None }
    return NavDisplay.transitionSpec(push) +
        NavDisplay.popTransitionSpec(pop) +
        NavDisplay.predictivePopTransitionSpec { _ -> pop() }
}
