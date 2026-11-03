package dev.zeronative.plugins.pdf

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.RectF
import androidx.compose.animation.core.AnimationState
import androidx.compose.animation.core.DecayAnimationSpec
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.animateDecay
import androidx.compose.animation.rememberSplineBasedDecay
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Velocity
import dev.zeronative.runtime.ZnHandles
import dev.zeronative.runtime.ZnViewScope
import kotlin.math.abs
import kotlin.math.ceil
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import org.json.JSONObject

/** How long the fingers must rest before the sharp layer is drawn, and a zoom is reported. */
private const val SETTLE_MS = 150L

/** What JS asked for in `props` (api.ts viewerProps). */
internal data class ViewerSpec(val source: String?, val maxZoom: Float, val gap: Float, val background: Int, val initialPage: Int) {
    companion object {
        fun of(p: JSONObject) = ViewerSpec(
            source = if (p.isNull("source")) null else p.optString("source"),
            maxZoom = PdfRules.maxZoom(if (p.isNull("maxZoom")) null else p.optDouble("maxZoom")),
            gap = p.optDouble("pageGap", 16.0).toFloat().coerceIn(0f, 200f),
            background = p.color("background", 0xFFE5E7EB.toInt()),
            initialPage = p.optInt("initialPage", 1),
        )
    }
}

/**
 * Every page of a PDF, one under the other, with scroll, pinch and double tap. Two layers:
 * - Pages: one bitmap per page as wide as the view (smaller if it would be big, [PdfRules.baseWidth]), drawn only for the
 *   pages on screen and one on each side, within 2/3 of the view's budget. Zoom scales them: quick, a bit soft.
 * - Sharp layer: when the fingers rest and the pages are scaled, one view-sized bitmap of just what is on screen, at the
 *   real zoom, within 1/3 of the budget. So zoom is sharp at 5x, and memory doesn't grow with it.
 */
@Composable
internal fun PdfViewer(scope: ZnViewScope, views: PdfViews) {
    val context = LocalContext.current
    val spec = remember(scope.props) { ViewerSpec.of(scope.props) }
    // clipToBounds: a zoomed or scrolled page is drawn past the view's edges, and a Canvas doesn't cut it by itself.
    Box(Modifier.fillMaxSize().clipToBounds().background(Color(spec.background))) {
        val source = spec.source ?: return@Box
        val file = remember(source) { ZnHandles.fileOf(context, source) }
        if (file == null) {
            LaunchedEffect(source) { scope.emit("error", errorJson("not_found")) }
            return@Box
        }
        val doc = remember(file) { PdfDoc(file) }
        DisposableEffect(doc) { onDispose { doc.close() } }
        var pages by remember(doc) { mutableStateOf<List<PageSize>?>(null) }
        LaunchedEffect(doc) {
            try {
                val all = doc.open()
                pages = all
                scope.emit("load", loadJson(scope.id, all))
            } catch (e: PdfFailure) {
                scope.emit("error", errorJson(e.code))
            }
        }
        pages?.let { Pages(scope, views, doc, it, spec) }
    }
}

@Composable
private fun Pages(scope: ZnViewScope, views: PdfViews, doc: PdfDoc, pages: List<PageSize>, spec: ViewerSpec) {
    val ui = rememberCoroutineScope()
    val gap = with(LocalDensity.current) { spec.gap * density }
    val v = remember(doc) { ViewerState(scope, doc, pages, views.budget, ui) }
    v.maxZoom = spec.maxZoom
    val decay = rememberSplineBasedDecay<Float>()
    DisposableEffect(v) {
        views.add(scope.id, v)
        onDispose {
            views.remove(scope.id, v)
            v.trim()
        }
    }
    LaunchedEffect(v) { snapshotFlow { v.wanted() }.collectLatest { w -> if (w != null) v.drawPages(w) } }
    LaunchedEffect(v) { snapshotFlow { v.areaKey() }.collectLatest { k -> v.drawArea(k) } }
    LaunchedEffect(v) {
        snapshotFlow { v.currentPage() }.distinctUntilChanged().collect { page ->
            if (page != null) scope.emit("page", JSONObject().put("page", page + 1).put("total", pages.size))
        }
    }
    LaunchedEffect(v) {
        var sent = 1f
        snapshotFlow { v.camera.z }.collectLatest { z ->
            delay(SETTLE_MS)
            if (abs(z - sent) > 0.001f) {
                sent = z
                scope.emit("zoom", JSONObject().put("scale", z.toDouble()))
            }
        }
    }
    val page = v.currentPage()
    Canvas(
        Modifier.fillMaxSize()
            .onSizeChanged { v.resize(it.width, it.height, gap, spec.initialPage) }
            .semantics { contentDescription = if (page == null) "PDF" else "PDF, page ${page + 1} of ${pages.size}" }
            // Taps outside the drag: the drag consumes a move first, and a consumed move ends a tap.
            .pointerInput(v) {
                detectTapGestures(onDoubleTap = { at ->
                    val to = if (v.camera.z > 1.05f) 1f else minOf(PdfRules.DOUBLE_TAP_ZOOM, v.maxZoom)
                    v.animateZoom(to, at)
                })
            }
            .pointerInput(v) { moves(v, decay) },
    ) { v.draw(this) }
}

/** One finger scrolls, two zoom around the fingers and pan. A fling goes on after the fingers leave. */
private suspend fun androidx.compose.ui.input.pointer.PointerInputScope.moves(v: ViewerState, decay: DecayAnimationSpec<Float>) {
    awaitEachGesture {
        awaitFirstDown(requireUnconsumed = false)
        v.stop()
        val tracker = VelocityTracker()
        var at = Offset.Zero // where the fingers' middle would be, from the pans: no jump when a finger comes or goes
        var moving = false
        var zoomed = 1f
        var travel = Offset.Zero
        while (true) {
            val e = awaitPointerEvent()
            val down = e.changes.filter { it.pressed }
            if (down.isEmpty()) break
            val zoom = e.calculateZoom()
            val pan = e.calculatePan()
            if (!moving) {
                zoomed *= zoom
                travel += pan
                val spread = abs(1 - zoomed) * e.calculateCentroidSize(useCurrent = false)
                if (spread > viewConfiguration.touchSlop || travel.getDistance() > viewConfiguration.touchSlop) moving = true
            }
            if (moving) {
                val centroid = e.calculateCentroid(useCurrent = false)
                if (zoom != 1f && centroid.isSpecified()) v.zoomBy(zoom, centroid)
                v.scrollBy(-pan.x, -pan.y)
                for (c in e.changes) if (c.positionChanged()) c.consume()
            }
            at += pan
            tracker.addPosition(down.first().uptimeMillis, at)
        }
        if (moving) v.fling(tracker.calculateVelocity(), decay)
    }
}

private fun Offset.isSpecified() = x.isFinite() && y.isFinite()

/** Pages to have bitmaps for: those on screen and one each side. [width] and [clears] make a new set when they change. */
private data class Wanted(val pages: IntRange, val center: Int, val width: Int, val clears: Int)

private data class AreaKey(val camera: Camera, val width: Int, val height: Int, val clears: Int)

private class Area(val key: AreaKey, val bitmap: Bitmap)

/** Main thread, but for the draws, which run on PdfThread inside [PdfDoc]. */
private class ViewerState(
    private val scope: ZnViewScope,
    private val doc: PdfDoc,
    private val pages: List<PageSize>,
    budget: Long,
    private val ui: CoroutineScope,
) : PdfLive {
    var camera by mutableStateOf(Camera(1f, 0f, 0f))
    var maxZoom = 5f
    private var layout by mutableStateOf<PdfLayout?>(null)
    private var width by mutableIntStateOf(0)
    private var height by mutableIntStateOf(0)
    private var version by mutableIntStateOf(0)
    private var clears by mutableIntStateOf(0)
    private var area by mutableStateOf<Area?>(null)
    private val bitmaps = HashMap<Int, Bitmap>()
    private val failed = HashSet<Int>()
    private val pagesBudget = budget * 2 / 3
    private val areaBudget = budget / 3
    private var motion: Job? = null
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val white = Paint().apply { color = android.graphics.Color.WHITE }

    fun resize(w: Int, h: Int, gap: Float, initialPage: Int) {
        if (w <= 0 || h <= 0) return
        val first = layout == null
        if (first || w != width || layout?.gap != gap) {
            if (!first && w != width) trim() // a bitmap of the old width would show soft or cut
            layout = PdfLayout(pages, w.toFloat(), gap)
        }
        width = w
        height = h
        val l = layout!!
        camera = if (first) {
            val start = (initialPage - 1).coerceIn(0, pages.size - 1)
            clamp(Camera(1f, 0f, l.tops[start]))
        } else {
            clamp(camera)
        }
    }

    private fun clamp(c: Camera) = layout?.let { PdfRules.clamp(c, it, width.toFloat(), height.toFloat(), maxZoom) } ?: c

    fun currentPage(): Int? = layout?.let { it.current(camera.z, camera.y, height.toFloat()) }

    fun wanted(): Wanted? {
        val l = layout ?: return null
        val c = camera
        val seen = l.visible(c.z, c.y, height.toFloat())
        if (seen.isEmpty()) return null
        val range = (seen.first - 1).coerceAtLeast(0)..(seen.last + 1).coerceAtMost(pages.size - 1)
        return Wanted(range, l.current(c.z, c.y, height.toFloat()), width, clears)
    }

    /** The sharp layer is needed when the fingers rest and what shows is scaled: zoomed, or pages drawn narrower than the view. */
    fun areaKey(): AreaKey? {
        val l = layout ?: return null
        val c = camera
        val narrow = l.visible(c.z, c.y, height.toFloat()).any { PdfRules.baseWidth(width, pages[it], pagesBudget) < width * 0.98f }
        if (c.z <= 1.01f && !narrow) return null
        return AreaKey(c, width, height, clears)
    }

    suspend fun drawPages(w: Wanted) {
        // On screen first, then the ones on each side.
        val order = w.pages.sortedBy { abs(it - w.center) }
        for (i in order) {
            if (i in bitmaps || i in failed) continue
            val bitmap = pageBitmap(i) ?: return
            bitmaps[i] = bitmap
            for (gone in PdfRules.evict(bitmaps.mapValues { it.value.allocationByteCount.toLong() }, w.pages, w.center, pagesBudget)) {
                bitmaps.remove(gone) // dropped, not recycle(): a recycled bitmap Compose still draws would crash. GC frees it
            }
            version++
        }
    }

    /** Null after the view closed, or for a page that failed (it then shows white, and JS hears once). */
    private suspend fun pageBitmap(i: Int): Bitmap? {
        val w = PdfRules.baseWidth(width, pages[i], pagesBudget)
        return try {
            doc.page(i, w)
        } catch (e: PdfFailure) {
            if (e.code == "memory") {
                // Make room, and try once at half the width: soft is better than nothing.
                bitmaps.keys.retainAll(wanted()?.pages?.toSet() ?: emptySet())
                try {
                    return doc.page(i, (w / 2).coerceAtLeast(1))
                } catch (_: PdfFailure) {
                }
            }
            failed += i
            scope.emit("error", errorJson(e.code, i))
            null
        }
    }

    suspend fun drawArea(k: AreaKey?) {
        if (k == null) {
            area = null
            return
        }
        delay(SETTLE_MS)
        val l = layout ?: return
        val s = PdfRules.areaScale(k.width, k.height, areaBudget)
        val places = PdfRules.areaPlaces(l, k.camera, k.height.toFloat(), s).filter { it.index !in failed }
        val drawn = try {
            doc.area(ceil(k.width * s).toInt().coerceAtLeast(1), ceil(k.height * s).toInt().coerceAtLeast(1), places, 0)
        } catch (e: PdfFailure) { // memory: the scaled pages still show
            null
        }
        area = drawn?.let { Area(k, it.bitmap) }
    }

    fun draw(d: DrawScope) {
        val l = layout ?: return
        version // read, so a new page bitmap draws again
        val c = camera
        d.drawIntoCanvas { canvas ->
            val nc = canvas.nativeCanvas
            for (i in l.visible(c.z, c.y, height.toFloat())) {
                val top = l.tops[i] * c.z - c.y
                val rect = RectF(-c.x, top, -c.x + l.width * c.z, top + l.heights[i] * c.z)
                val b = bitmaps[i]
                if (b != null) nc.drawBitmap(b, null, rect, paint) else nc.drawRect(rect, white)
            }
            val a = area
            if (a != null && a.key == areaKey()) nc.drawBitmap(a.bitmap, null, RectF(0f, 0f, width.toFloat(), height.toFloat()), paint)
        }
    }

    fun scrollBy(dx: Float, dy: Float) {
        camera = clamp(camera.copy(x = camera.x + dx, y = camera.y + dy))
    }

    fun zoomBy(factor: Float, focus: Offset) {
        camera = clamp(PdfRules.zoomAround(camera, factor, focus.x, focus.y, maxZoom))
    }

    fun stop() {
        motion?.cancel()
        motion = null
    }

    fun fling(velocity: Velocity, decay: DecayAnimationSpec<Float>) {
        stop()
        motion = ui.launch {
            launch { glide(-velocity.y, decay) { scrollBy(0f, it) } }
            launch { glide(-velocity.x, decay) { scrollBy(it, 0f) } }
        }
    }

    /** Moves by a decaying speed until it stops or hits an edge. */
    private suspend fun glide(speed: Float, decay: DecayAnimationSpec<Float>, move: (Float) -> Unit) {
        if (abs(speed) < 50f) return
        var last = 0f
        AnimationState(0f, speed).animateDecay(decay) {
            val before = camera
            move(value - last)
            last = value
            if (camera == before) cancelAnimation()
        }
    }

    fun animateZoom(to: Float, focus: Offset) {
        stop()
        motion = ui.launch {
            var z = camera.z
            animate(z, to) { value, _ ->
                zoomBy(value / z, focus)
                z = value
            }
        }
    }

    override fun zoom(scale: Float): Boolean {
        if (layout == null) return false
        stop()
        zoomBy(scale / camera.z, Offset(width / 2f, height / 2f))
        return true
    }

    override fun trim() {
        bitmaps.clear()
        area = null
        clears++
        version++
    }
}
