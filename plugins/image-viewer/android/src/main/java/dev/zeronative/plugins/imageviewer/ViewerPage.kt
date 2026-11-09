package dev.zeronative.plugins.imageviewer

import android.util.Log
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import coil3.annotation.ExperimentalCoilApi
import coil3.compose.AsyncImagePainter
import coil3.compose.rememberAsyncImagePainter
import coil3.compose.rememberDrawScopeSizeResolver
import coil3.network.NetworkHeaders
import coil3.network.httpHeaders
import coil3.request.ImageRequest
import dev.zeronative.runtime.ZnViewScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.withContext
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * `imageviewer.page` (module version 3): one picture of the TSX viewer (src/ImageViewerScreen.tsx). JS owns the
 * gestures (useZoom) and passes its values; this view loads the picture (web, asset, file, content, `data:` and headers
 * held natively), draws it moved by those values each frame (no recomposition), and adds a sharp part of the original
 * on top once the zoom rests, as the old Compose screen did (memory: about one screen).
 *
 * Props: `uri`, `held` (ViewerHeld key) and `i` (its index there), `scale`, `x`, `y` (motion values: x / y in dp),
 * `errorText`, `retryLabel`. Events: `loaded` {width, height} (the picture's shape, for useZoom's aspect), `error`.
 */
@OptIn(ExperimentalCoilApi::class)
@Composable
internal fun ViewerPage(scope: ZnViewScope) {
    val props = scope.props
    val uri = props.optString("uri", "")
    val heldKey = props.optString("held", "").ifEmpty { null }
    val index = props.optInt("i", 0)
    val image = remember(uri, heldKey, index) { ViewerImage(uri, null, ViewerHeld.get(heldKey, index)) }
    val errorText = props.optString("errorText", "").ifEmpty { "Couldn't load this photo" }
    val retryLabel = props.optString("retryLabel", "").ifEmpty { "Try again" }
    val scale = remember(props) { scope.motion("scale") }
    val tx = remember(props) { scope.motion("x") }
    val ty = remember(props) { scope.motion("y") }
    val d = LocalDensity.current.density
    val context = LocalContext.current
    val model = remember(image) { imageModel(context, image) }
    // The size on screen, from the first draw: Coil decodes at that size, not the original's (96 MB for 6000 x 4000).
    val size = rememberDrawScopeSizeResolver()
    val request = remember(model, size) {
        ImageRequest.Builder(context).data(model).size(size).apply {
            image.held?.headers?.let { h -> httpHeaders(NetworkHeaders.Builder().apply { for ((k, v) in h) set(k, v) }.build()) }
        }.build()
    }
    val painter = rememberAsyncImagePainter(request, contentScale = ContentScale.Fit)
    val state by painter.state.collectAsState()
    val base = (state as? AsyncImagePainter.State.Success)?.result?.image
    LaunchedEffect(base) {
        if (base != null) scope.emit("loaded", JSONObject().put("width", base.width).put("height", base.height))
    }
    LaunchedEffect(state) {
        val failed = state as? AsyncImagePainter.State.Error ?: return@LaunchedEffect
        Log.w("zn", "image-viewer: failed ${shown(image.uri)}: ${failed.result.throwable}")
        scope.emit("error")
    }
    val screen = remember { mutableStateOf(Dims(0f, 0f)) }
    // The zoom's values, read as plain floats (no object per frame); a Camera is made only where one is kept.
    val zoomZ = { scale?.invoke()?.takeIf { it.isFinite() && it > 0f } ?: 1f }
    val zoomX = { (tx?.invoke() ?: 0f) * d }
    val zoomY = { (ty?.invoke() ?: 0f) * d }
    val camera = { Camera(zoomZ(), zoomX(), zoomY()) }
    val sharp = rememberPageSharp(image, base, screen, camera)
    Box(
        Modifier.fillMaxSize().clipToBounds().onSizeChanged { screen.value = Dims(it.width.toFloat(), it.height.toFloat()) },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            painter = painter,
            contentDescription = null,
            // Read while drawing: the zoom moves the picture each frame with no recomposition.
            modifier = Modifier.fillMaxSize().graphicsLayer {
                // Hidden until the painter knows the picture's size: before that, Fit fills the whole box and the
                // photo shows stretched for a frame or two (seen on the Lava when a page is built again after Back).
                alpha = if (painter.intrinsicSize.isSpecified) 1f else 0f
                val z = zoomZ()
                scaleX = z
                scaleY = z
                translationX = zoomX()
                translationY = zoomY()
            },
            contentScale = ContentScale.Fit,
        )
        Canvas(Modifier.fillMaxSize()) {
            val s = sharp.value ?: return@Canvas
            val c = s.camera
            // Moved since: Coil's copy shows until the next sharp part.
            if (c.z != zoomZ() || c.x != zoomX() || c.y != zoomY()) return@Canvas
            drawImage(
                s.image,
                dstOffset = IntOffset(s.screen.left.roundToInt(), s.screen.top.roundToInt()),
                dstSize = IntSize(s.screen.width.roundToInt(), s.screen.height.roundToInt()),
            )
        }
        when (state) {
            is AsyncImagePainter.State.Error -> LoadError(errorText, retryLabel, onRetry = { painter.restart() })
            is AsyncImagePainter.State.Success -> Unit
            else -> if (model != null) Spinner()
        }
    }
}

/** A sharp part of the original, cut for [camera], to draw at [screen]. */
private class PageSharp(val image: androidx.compose.ui.graphics.ImageBitmap, val screen: Rect4, val camera: Camera)

/** The sharp part for the zoom on screen, made once the zoom has rested [SETTLE_MS] and only while Coil's copy is stretched. */
@Composable
private fun rememberPageSharp(image: ViewerImage, base: coil3.Image?, screen: State<Dims>, camera: () -> Camera): State<PageSharp?> {
    val context = LocalContext.current.applicationContext
    val sharp = remember(image) { mutableStateOf<PageSharp?>(null) }
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
    // Keyed on the screen size too (rare: a turn, split screen), so the flow below only follows the zoom.
    val scr = screen.value
    LaunchedEffect(holder, base, scr) {
        if (base == null) return@LaunchedEffect
        val baseWidth = base.width.toFloat()
        val content = Dims(base.width.toFloat(), base.height.toFloat())
        // collectLatest: a new camera cancels the wait, so the part is made only after the zoom rests.
        // One Camera per change of the zoom; nothing while it rests.
        snapshotFlow { camera() }.collectLatest { c ->
            val fitted = ViewerRules.fitted(content, scr)
            if (!ViewerRules.needsSharp(c, fitted, baseWidth, Float.MAX_VALUE)) {
                sharp.value = null
                return@collectLatest
            }
            delay(SETTLE_MS)
            val made = withContext(Dispatchers.IO) {
                val source = holder.get() ?: return@withContext null
                if (!ViewerRules.needsSharp(c, fitted, baseWidth, source.upright.w)) return@withContext null
                val area = ViewerRules.visibleArea(c, fitted, scr, source.upright)?.let(ViewerRules::snapped) ?: return@withContext null
                val bitmap = source.decode(area, ViewerRules.AREA_SCREENS * scr.w * scr.h) ?: return@withContext null
                PageSharp(bitmap.asImageBitmap(), area.screen, c)
            }
            if (made != null) sharp.value = made
        }
    }
    return sharp
}
