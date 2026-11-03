package dev.zeronative.plugins.pdf

import java.net.URI
import java.security.MessageDigest
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** Why there is no PDF. [code] reaches JS as `reason`. */
internal class PdfFailure(val code: String, message: String = code, val httpStatus: Int? = null) : Exception(message)

/** A page's size in PDF points (1/72 inch). */
internal data class PageSize(val width: Float, val height: Float) {
    val aspect: Float get() = height / width
}

/** Where one page lands in a bitmap: its top-left corner in pixels, and pixels per point. */
internal data class Placed(val index: Int, val x: Float, val y: Float, val scale: Float)

/** A file in the folder, for [PdfRules.toDelete]. */
internal data class Stored(val name: String, val modified: Long)

/** Where the viewer looks: zoom [z], and the scroll [x], [y] in zoomed pixels from the document's top-left. */
internal data class Camera(val z: Float, val x: Float, val y: Float)

/** The pdf rules, apart from Android, so they run on the JVM (PdfRulesTest). */
internal object PdfRules {
    const val DEFAULT_MAX_BYTES = 20L * 1024 * 1024
    const val MAX_BYTES = 100L * 1024 * 1024
    const val KEEP_MS = 7L * 24 * 3600 * 1000
    const val MAX_ZOOM = 10f
    const val DOUBLE_TAP_ZOOM = 2.5f
    /** No bitmap side over this. Android refuses to draw very big bitmaps, and the RN library caps at the same number. */
    const val MAX_SIDE = 2048
    const val MAX_REDIRECTS = 5
    private const val PREFIX = "pdf-"
    private const val PART_PREFIX = ".pdf-"
    private const val MB = 1024L * 1024
    private val MAGIC = "%PDF-".toByteArray()

    /** The file for [url] + [key]. The headers are not in it: see the README on logout. */
    fun fileName(url: String, key: String?): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$url\n${key.orEmpty()}".toByteArray())
        return PREFIX + digest.take(16).joinToString("") { "%02x".format(it) } + ".pdf"
    }

    /** A dot name: a handle can never point at a half-written file (ZnHandles takes no leading dot). */
    fun partName(name: String) = ".$name.part"

    fun ours(name: String) = name.startsWith(PREFIX) || name.startsWith(PART_PREFIX)

    /** https. Debug builds also take http to this computer, for the phone test's server (through adb reverse). */
    fun urlAllowed(url: String, debug: Boolean): Boolean {
        val uri = try {
            URI(url)
        } catch (e: Exception) {
            return false
        }
        val host = uri.host ?: return false
        if (uri.rawUserInfo != null) return false // "https://user:pass@host": a password in a link ends up in logs
        return when (uri.scheme?.lowercase()) {
            "https" -> true
            "http" -> debug && (host == "localhost" || host == "127.0.0.1")
            else -> false
        }
    }

    /** A redirect to the same scheme, host and port keeps the app's headers. Anywhere else it goes without them. */
    fun sameOrigin(a: String, b: String): Boolean {
        val x = URI(a)
        val y = URI(b)
        return x.scheme.equals(y.scheme, true) && x.host.equals(y.host, true) && port(x) == port(y)
    }

    private fun port(u: URI) = if (u.port != -1) u.port else if (u.scheme.equals("https", true)) 443 else 80

    /** `%PDF-` in the first 1024 bytes: readers allow some junk before it. An HTML error page sent with 200 fails here. */
    fun looksLikePdf(head: ByteArray, size: Int): Boolean {
        val end = min(size, 1024) - MAGIC.size
        for (i in 0..end) {
            if (MAGIC.indices.all { head[i + it] == MAGIC[it] }) return true
        }
        return false
    }

    /** Bytes of page bitmaps for one view: 1/8 of the app's heap limit, 16 to 48 MB. 16 MB on low-RAM phones. */
    fun budget(memoryClassMb: Int, lowRam: Boolean): Long =
        if (lowRam) 16 * MB else (memoryClassMb * MB / 8).coerceIn(16 * MB, 48 * MB)

    /**
     * The width to draw one page at, for the list: the view's width, smaller if the bitmap would be over a third of
     * [budget] (so three pages fit) or a side over [MAX_SIDE]. A long receipt page gets a narrower bitmap; the sharp layer
     * covers that when the list stops.
     */
    fun baseWidth(viewWidth: Int, page: PageSize, budget: Long): Int {
        val aspect = page.aspect.coerceAtLeast(0.01f)
        val byBytes = sqrt((budget / 3).toDouble() / 4 / aspect)
        val bySide = MAX_SIDE / max(1f, aspect)
        return floor(minOf(viewWidth.toDouble(), byBytes, bySide.toDouble(), MAX_SIDE.toDouble())).toInt().coerceAtLeast(1)
    }

    /** How much smaller than [width] × [height] an area bitmap is drawn, so it stays within [limit] bytes and [MAX_SIDE]. 1: full size. */
    fun areaScale(width: Int, height: Int, limit: Long): Float {
        if (width <= 0 || height <= 0) return 1f
        val byBytes = sqrt(limit.toDouble() / 4 / width / height)
        val bySide = MAX_SIDE.toDouble() / max(width, height)
        return minOf(1.0, byBytes, bySide).toFloat()
    }

    /** One page in a box, for the preview. width: as wide as the box, from the top. contain: all of it, in the middle. */
    fun previewPlace(index: Int, page: PageSize, boxWidth: Int, boxHeight: Int, contain: Boolean): Placed {
        val byWidth = boxWidth / page.width
        if (!contain) return Placed(index, 0f, 0f, byWidth)
        val scale = min(byWidth, boxHeight / page.height)
        return Placed(index, (boxWidth - page.width * scale) / 2, (boxHeight - page.height * scale) / 2, scale)
    }

    /** Files of this plugin older than [maxAgeMs], except [keep]. */
    fun toDelete(files: List<Stored>, now: Long, maxAgeMs: Long, keep: (String) -> Boolean): List<String> =
        files.filter { ours(it.name) && !keep(it.name) && now - it.modified >= maxAgeMs }.map { it.name }

    /** Pages to drop so the rest fit in [limit]: the ones farthest from [center] first, never one in [keep]. */
    fun evict(bytes: Map<Int, Long>, keep: IntRange, center: Int, limit: Long): List<Int> {
        var total = bytes.values.sum()
        val out = ArrayList<Int>()
        for (page in bytes.keys.filter { it !in keep }.sortedByDescending { abs(it - center) }) {
            if (total <= limit) break
            total -= bytes.getValue(page)
            out += page
        }
        return out
    }

    fun maxZoom(asked: Double?): Float = (asked?.toFloat() ?: 5f).takeIf { !it.isNaN() }?.coerceIn(1f, MAX_ZOOM) ?: 5f

    /** Keeps the camera on the document: zoom within 1 to [maxZoom], no scrolling past an edge. A short document sits at the top. */
    fun clamp(c: Camera, layout: PdfLayout, viewWidth: Float, viewHeight: Float, maxZoom: Float): Camera {
        val z = c.z.coerceIn(1f, maxZoom)
        val maxX = max(0f, layout.width * z - viewWidth)
        val maxY = max(0f, layout.height * z - viewHeight)
        return Camera(z, c.x.coerceIn(0f, maxX), c.y.coerceIn(0f, maxY))
    }

    /** Zooms by [factor] so the point under ([fx], [fy]) in the view stays under it. Not clamped: call [clamp] after. */
    fun zoomAround(c: Camera, factor: Float, fx: Float, fy: Float, maxZoom: Float): Camera {
        val z = (c.z * factor).coerceIn(1f, maxZoom)
        val k = z / c.z
        return Camera(z, (c.x + fx) * k - fx, (c.y + fy) * k - fy)
    }

    /** Each visible page placed in a view-sized bitmap drawn [scale] times smaller than the view. */
    fun areaPlaces(layout: PdfLayout, c: Camera, viewHeight: Float, scale: Float): List<Placed> =
        layout.visible(c.z, c.y, viewHeight).map { i ->
            Placed(i, -c.x * scale, (layout.tops[i] * c.z - c.y) * scale, layout.width * c.z / layout.pages[i].width * scale)
        }
}

/** Pages one under the other at zoom 1: [width] px wide, [gap] px apart. Zoom multiplies all of it. */
internal class PdfLayout(val pages: List<PageSize>, val width: Float, val gap: Float) {
    val tops = FloatArray(pages.size)
    val heights = FloatArray(pages.size)
    val height: Float

    init {
        var y = 0f
        pages.forEachIndexed { i, p ->
            tops[i] = y
            heights[i] = width * p.aspect
            y += heights[i] + gap
        }
        height = if (pages.isEmpty()) 0f else y - gap
    }

    /** Pages that show between [y] and [y] + [viewHeight], zoomed pixels. */
    fun visible(z: Float, y: Float, viewHeight: Float): IntRange {
        if (pages.isEmpty()) return IntRange.EMPTY
        val top = y / z
        val bottom = (y + viewHeight) / z
        val first = indexAt(top)
        var last = first
        while (last + 1 < pages.size && tops[last + 1] < bottom) last++
        return first..last
    }

    /** The page in the middle of the view. At the very end, the last page, so a short last page can still be "current". */
    fun current(z: Float, y: Float, viewHeight: Float): Int {
        if (pages.isEmpty()) return 0
        if (y + viewHeight >= height * z - 1f) return pages.size - 1
        return indexAt((y + viewHeight / 2) / z)
    }

    /** The page at [y] (zoom 1), or the one before the gap it is in. */
    private fun indexAt(y: Float): Int {
        var lo = 0
        var hi = pages.size - 1
        while (lo < hi) {
            val mid = (lo + hi + 1) / 2
            if (tops[mid] <= y) lo = mid else hi = mid - 1
        }
        return lo
    }
}
