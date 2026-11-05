package dev.zeronative.plugins.imageviewer

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.DecayAnimationSpec
import androidx.compose.animation.core.animate
import androidx.compose.animation.rememberSplineBasedDecay
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.traversalIndex
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import coil3.annotation.ExperimentalCoilApi
import coil3.compose.AsyncImagePainter
import coil3.compose.rememberAsyncImagePainter
import coil3.compose.rememberDrawScopeSizeResolver
import coil3.network.NetworkHeaders
import coil3.network.httpHeaders
import coil3.request.ImageRequest
import dev.zeronative.runtime.ZnBundles
import dev.zeronative.runtime.ZnHandles
import dev.zeronative.runtime.ZnScreenScope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import kotlin.math.roundToInt

/**
 * The full-screen viewer, opened with `ImageViewer.open` (a `nav.pushForResult` underneath). It answers `{ index }`, the
 * picture on screen, when the user closes it: the close button, a swipe up or down, or Back. The app's route needs
 * `safeArea: "none"`: the pictures go under the status bar.
 */
@Composable
internal fun ImageViewerScreen(scope: ZnScreenScope) {
    val spec = remember { ViewerSpec(scope.params) }
    val background = Color(spec.background)
    if (spec.images.isEmpty()) {
        // JS refuses an empty list, so only a broken bundle gets here: close, with nothing to show.
        LaunchedEffect(Unit) { scope.cancel() }
        Box(Modifier.fillMaxSize().background(background))
        return
    }
    val count = spec.images.size
    // Kept across a turn of the screen and a restore after a kill (rememberSaveable inside).
    val pager = rememberPagerState(initialPage = spec.index) { count }
    val ui = rememberCoroutineScope()
    val zooms = remember { HashMap<Int, ZoomState>() }
    val zoomOf = { page: Int -> zooms.getOrPut(page) { ZoomState(ui) } }
    val zoomed by remember { derivedStateOf { zoomOf(pager.currentPage).zoomed } }
    var closing by remember { mutableStateOf(false) }
    var drag by remember { mutableFloatStateOf(0f) }
    var height by remember { mutableFloatStateOf(0f) }
    val closeSpeed = with(LocalDensity.current) { ViewerRules.CLOSE_SPEED_DP.dp.toPx() }
    val decay = rememberSplineBasedDecay<Float>()
    val close = {
        if (!closing) {
            closing = true
            spec.heldKey?.let { ViewerHeld.release(it) } // the pages already have theirs; the memory goes when they leave
            scope.finish(JSONObject().put("index", pager.currentPage))
        }
    }
    // Back answers like the close button. Registered inside the screen, so it comes before the host's own Back.
    BackHandler(enabled = !closing) { close() }
    DarkBars()
    // A picture left zoomed goes back to fit once another one is chosen.
    LaunchedEffect(pager) {
        snapshotFlow { pager.settledPage }.collect { settled -> for ((page, z) in zooms) if (page != settled) z.reset() }
    }

    Box(
        Modifier.fillMaxSize()
            .onSizeChanged { height = it.height.toFloat() }
            .drawBehind { drawRect(background.copy(alpha = background.alpha * ViewerRules.backgroundAlpha(drag, height))) }
            // Up or down, one finger, not zoomed: the picture follows, and a long or quick swipe closes the viewer.
            .draggable(
                state = rememberDraggableState { d -> drag += d },
                orientation = Orientation.Vertical,
                enabled = spec.swipeToClose && !zoomed && !closing,
                onDragStopped = { speed ->
                    if (ViewerRules.closes(drag, speed, height, closeSpeed)) {
                        close()
                        animate(drag, if (drag < 0) -height else height, animationSpec = tween(180)) { v, _ -> drag = v }
                    } else {
                        animate(drag, 0f, animationSpec = spring()) { v, _ -> drag = v }
                    }
                },
            ),
    ) {
        HorizontalPager(
            state = pager,
            modifier = Modifier.fillMaxSize().graphicsLayer { translationY = drag },
            pageSpacing = 16.dp,
            beyondViewportPageCount = 1, // the next picture is ready before the swipe
            userScrollEnabled = !zoomed && !closing,
            key = { it },
        ) { page ->
            Page(spec, page, zoomOf(page), decay) { to -> ui.launch { pager.animateScrollToPage(to) } }
        }
        // The same bar as ZeroBill's React Native viewer: a 56 dp row under the status bar, over a black 55 % → clear
        // scrim that reaches 24 dp below it.
        Box(
            Modifier.fillMaxWidth()
                .graphicsLayer { alpha = ViewerRules.backgroundAlpha(drag, height) }
                .background(Brush.verticalGradient(listOf(Color(0x8C000000), Color.Transparent)))
                .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                .padding(bottom = 24.dp)
                .semantics {
                    isTraversalGroup = true
                    traversalIndex = -1f // TalkBack reads the close button and the count before the picture
                },
        ) {
            Box(Modifier.fillMaxWidth().height(56.dp).padding(start = 4.dp)) {
                CloseButton(spec.close, close, Modifier.align(Alignment.CenterStart))
                if (count > 1) {
                    val n = pager.currentPage
                    Counter("${n + 1} / $count", ViewerRules.label(spec.photo, n, count), Modifier.align(Alignment.Center))
                }
            }
        }
    }
}

/** One picture: Coil's copy that fits the page, moved by the zoom, and a sharp part on top once the zoom rests. */
@OptIn(ExperimentalCoilApi::class) // rememberDrawScopeSizeResolver: stable since Coil 3.0, still marked
@Composable
private fun Page(spec: ViewerSpec, page: Int, zoom: ZoomState, decay: DecayAnimationSpec<Float>, moveTo: (Int) -> Unit) {
    val image = spec.images[page]
    val count = spec.images.size
    val context = LocalContext.current
    val model = remember(image) { imageModel(context, image) }
    // The size on screen, from the first draw. Without it, Coil's painter decodes at the original size: 96 MB for a
    // 6000 x 4000 photo. The zoom is a graphicsLayer, so the draw size stays the page's size.
    val size = rememberDrawScopeSizeResolver()
    val request = remember(model, size) {
        ImageRequest.Builder(context).data(model).size(size).apply {
            // Only for https: Coil sends them with the request. Their values are never logged.
            image.held?.headers?.let { h -> httpHeaders(NetworkHeaders.Builder().apply { for ((k, v) in h) set(k, v) }.build()) }
        }.build()
    }
    val painter = rememberAsyncImagePainter(request, contentScale = ContentScale.Fit)
    val state by painter.state.collectAsState()
    val base = (state as? AsyncImagePainter.State.Success)?.result?.image
    LaunchedEffect(base) {
        zoom.content = base?.let { Dims(it.width.toFloat(), it.height.toFloat()) }
        if (base == null) zoom.reset()
    }
    LaunchedEffect(state) {
        val failed = state as? AsyncImagePainter.State.Error ?: return@LaunchedEffect
        Log.w("zn", "image-viewer: failed ${shown(image.uri)}: ${failed.result.throwable}")
    }
    val sharp = rememberSharp(image, zoom, base)
    val label = image.alt ?: ViewerRules.label(spec.photo, page, count)
    Box(
        Modifier.fillMaxSize()
            .clipToBounds()
            .onSizeChanged {
                val size = Dims(it.width.toFloat(), it.height.toFloat())
                if (size != zoom.screen) {
                    zoom.screen = size
                    zoom.reset() // a turn of the screen starts again from fit
                }
            }
            .then(if (spec.doubleTap) Modifier.pointerInput(zoom) { detectTapGestures(onDoubleTap = { zoom.doubleTap(it.x, it.y) }) } else Modifier)
            .pointerInput(zoom) { with(zoom) { gestures(decay) } }
            .semantics {
                contentDescription = label
                role = Role.Image
                customActions = buildList {
                    if (page < count - 1) add(CustomAccessibilityAction(spec.next) { moveTo(page + 1); true })
                    if (page > 0) add(CustomAccessibilityAction(spec.previous) { moveTo(page - 1); true })
                }
            },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painter,
            contentDescription = null,
            modifier = Modifier.fillMaxSize().graphicsLayer {
                val c = zoom.camera
                scaleX = c.z
                scaleY = c.z
                translationX = c.x
                translationY = c.y
            },
            contentScale = ContentScale.Fit,
        )
        Canvas(Modifier.fillMaxSize()) {
            val s = sharp.value ?: return@Canvas
            if (s.camera != zoom.camera) return@Canvas // moved since: Coil's copy shows until the next sharp part
            drawImage(
                s.image,
                dstOffset = IntOffset(s.screen.left.roundToInt(), s.screen.top.roundToInt()),
                dstSize = IntSize(s.screen.width.roundToInt(), s.screen.height.roundToInt()),
            )
        }
        when (state) {
            is AsyncImagePainter.State.Error -> LoadError(spec.error, spec.retry, onRetry = { painter.restart() })
            is AsyncImagePainter.State.Success -> Unit
            else -> if (model != null) Spinner()
        }
    }
}

/** A sharp part of the original, cut for [camera], to draw at [screen]. */
private class Sharp(val image: ImageBitmap, val screen: Rect4, val camera: Camera)

/**
 * The sharp part for the zoom on screen, made once the zoom rests ([SETTLE_MS]) and only while Coil's copy would be
 * stretched. Null otherwise, and when Android is short of memory.
 */
@Composable
private fun rememberSharp(image: ViewerImage, zoom: ZoomState, base: coil3.Image?): State<Sharp?> {
    val context = LocalContext.current.applicationContext
    val sharp = remember(image) { mutableStateOf<Sharp?>(null) }
    val holder = remember(image) { SourceHolder(context, image) }
    DisposableEffect(holder) {
        val trim = { sharp.value = null }
        ViewerMemory.add(trim)
        onDispose {
            ViewerMemory.remove(trim)
            sharp.value = null
            holder.close()
        }
    }
    LaunchedEffect(holder, base) {
        if (base == null) return@LaunchedEffect
        val baseWidth = base.width.toFloat()
        snapshotFlow { Triple(zoom.camera, zoom.still, zoom.screen) }.collectLatest { (camera, still, screen) ->
            if (!still) return@collectLatest
            val fitted = zoom.fitted()
            if (!ViewerRules.needsSharp(camera, fitted, baseWidth, Float.MAX_VALUE)) {
                sharp.value = null
                return@collectLatest
            }
            delay(SETTLE_MS)
            val made = withContext(Dispatchers.IO) {
                val source = holder.get() ?: return@withContext null
                if (!ViewerRules.needsSharp(camera, fitted, baseWidth, source.upright.w)) return@withContext null
                val area = ViewerRules.visibleArea(camera, fitted, screen, source.upright)?.let(ViewerRules::snapped) ?: return@withContext null
                val bitmap = source.decode(area, ViewerRules.AREA_SCREENS * screen.w * screen.h) ?: return@withContext null
                Sharp(bitmap.asImageBitmap(), area.screen, camera)
            }
            if (made != null) sharp.value = made
        }
    }
    return sharp
}

/** Opens the original once, on first need; closes it off the main thread (a decode may still hold it). */
private class SourceHolder(private val context: Context, private val image: ViewerImage) {
    private var source: SharpSource? = null
    private var tried = false
    private var closed = false

    @Synchronized
    fun get(): SharpSource? {
        if (closed) return null
        if (!tried) {
            tried = true
            source = SharpSource.open(context, image)
        }
        return source
    }

    fun close() {
        val s = synchronized(this) {
            closed = true
            source.also { source = null }
        } ?: return
        cleanup.launch { s.close() }
    }
}

private val cleanup = CoroutineScope(SupervisorJob() + Dispatchers.IO)

/** The zoom must rest this long before a sharp part is made: a pinch often pauses for a moment. */
private const val SETTLE_MS = 120L

/** What Coil loads for [image], or null for a link the viewer refuses (the page then shows its error). */
internal fun imageModel(context: Context, image: ViewerImage): Any? {
    val uri = image.uri
    return when (ViewerRules.kind(uri)) {
        ViewerRules.Source.WEB -> uri
        ViewerRules.Source.ASSET -> ZnBundles.assetModel(ViewerRules.assetPath(uri))
        ViewerRules.Source.FILE -> ZnHandles.fileOf(context, uri)
        ViewerRules.Source.FILE_URI -> appFile(context, uri)
        // Android's own grants apply: a link the app may not read fails, and the page shows its error.
        ViewerRules.Source.CONTENT -> Uri.parse(uri)
        ViewerRules.Source.HELD -> image.held?.bytes ?: run {
            Log.w("zn", "image-viewer: no data for a data: picture (a bad link, or gone after Android restarted the app)")
            null
        }
        ViewerRules.Source.REFUSED -> {
            Log.w("zn", "image-viewer: refused ${shown(uri)}: see the README, \"Links that load\"")
            null
        }
    }
}

/**
 * The file of a `file://` link, only if it is inside the app's own folders: cache, files, and the app's external files
 * and cache folders. Checked on the canonical path, so `../` and links can't leave them. A bundle comes over the air, so
 * it must not read any file it likes (the same rule as `zn://file`).
 */
internal fun appFile(context: Context, uri: String): File? {
    val path = ViewerRules.filePath(uri)
    val file = path?.let { runCatching { File(it).canonicalFile }.getOrNull() }
    val roots = listOfNotNull(context.cacheDir, context.filesDir, context.getExternalFilesDir(null), context.externalCacheDir)
        .mapNotNull { runCatching { it.canonicalPath }.getOrNull() }
    if (file != null && ViewerRules.insideRoots(file.path, roots) && file.isFile) return file
    Log.w("zn", "image-viewer: refused ${shown(uri)}: a file:// link must be a file in the app's own folders")
    return null
}

/** A link for a log line: never a whole `data:` text, never more than 120 characters. */
internal fun shown(uri: String): String = if (uri.startsWith("data:", true)) uri.substringBefore(',').take(60) + ",..." else uri.take(120)
