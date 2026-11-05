package dev.zeronative.plugins.imageviewer

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign

/** A width and a height, in pixels. */
internal data class Dims(val w: Float, val h: Float) {
    val empty: Boolean get() = w <= 0f || h <= 0f
}

/** A rectangle, in pixels. */
internal data class Rect4(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
    val empty: Boolean get() = width <= 0f || height <= 0f
}

/**
 * Where the viewer looks: zoom [z] (1 = the picture fits the screen), and a move of [x], [y] pixels of the zoomed
 * picture's middle away from the screen's middle.
 */
internal data class Camera(val z: Float, val x: Float, val y: Float) {
    companion object {
        val FIT = Camera(1f, 0f, 0f)
    }
}

/**
 * The part of the original picture that is on screen: [screen] in screen pixels, [source] in the original's pixels
 * (turned upright, as the user sees it).
 */
internal data class Area(val screen: Rect4, val source: Rect4)

/** The viewer's rules, apart from Android and Compose, so they run on the JVM (ViewerRulesTest). */
internal object ViewerRules {
    const val MAX_ZOOM = 5f
    /** A pinch may go a little under 1, then the picture springs back. The same as the React Native screen. */
    const val UNDER_ZOOM = 0.8f
    const val DOUBLE_TAP_ZOOM = 2.5f
    /** At or under this, the picture counts as not zoomed: swipes move between pictures and close the viewer. */
    const val ZOOMED = 1.01f
    /** A swipe up or down of this part of the screen height closes the viewer. */
    const val CLOSE_DRAG = 0.15f
    /** ... or a quick one, in dp per second. */
    const val CLOSE_SPEED_DP = 1000f
    /**
     * The sharp part shown when zoomed (SharpArea) has at most this many screen's worth of pixels. Its pixels never fall
     * under the screen's, except for a very big picture, where this cap wins (a little soft, never out of memory).
     */
    const val AREA_SCREENS = 2.5f

    /** The size of [content] fitted inside [box], keeping its shape: ContentScale.Fit. */
    fun fitted(content: Dims, box: Dims): Dims {
        if (content.empty || box.empty) return box
        val s = min(box.w / content.w, box.h / content.h)
        return Dims(content.w * s, content.h * s)
    }

    /**
     * [c] kept inside the limits: zoom between [minZ] and [MAX_ZOOM], and no empty space on a side where the zoomed
     * picture is bigger than the screen. Where it is smaller, it stays in the middle.
     */
    fun clamp(c: Camera, fitted: Dims, screen: Dims, minZ: Float = UNDER_ZOOM): Camera {
        val z = c.z.coerceIn(minZ, MAX_ZOOM)
        val mx = max(0f, (fitted.w * z - screen.w) / 2)
        val my = max(0f, (fitted.h * z - screen.h) / 2)
        return Camera(z, c.x.coerceIn(-mx, mx), c.y.coerceIn(-my, my))
    }

    /** Zoom by [factor] around the point [fx], [fy] on screen: what is under the fingers stays under them. Not clamped. */
    fun zoomAround(c: Camera, factor: Float, fx: Float, fy: Float, screen: Dims): Camera {
        val z = (c.z * factor).coerceIn(UNDER_ZOOM, MAX_ZOOM)
        val ratio = z / c.z
        val rx = fx - screen.w / 2
        val ry = fy - screen.h / 2
        return Camera(z, rx - (rx - c.x) * ratio, ry - (ry - c.y) * ratio)
    }

    /** A double tap: zoomed → back to fit; not zoomed → [DOUBLE_TAP_ZOOM] with the tapped point kept under the finger. */
    fun doubleTap(c: Camera, tx: Float, ty: Float, fitted: Dims, screen: Dims): Camera {
        if (c.z > 1.05f) return Camera.FIT
        return clamp(zoomAround(Camera.FIT, DOUBLE_TAP_ZOOM, tx, ty, screen), fitted, screen, 1f)
    }

    /** Where the camera goes when the fingers leave: under 1 springs back to fit; else inside the limits. */
    fun settle(c: Camera, fitted: Dims, screen: Dims): Camera = if (c.z < 1f) Camera.FIT else clamp(c, fitted, screen, 1f)

    /** Whether a swipe up or down that moved [drag] pixels, at [speed] pixels per second, closes the viewer. */
    fun closes(drag: Float, speed: Float, height: Float, closeSpeed: Float): Boolean {
        if (height <= 0f) return false
        if (abs(drag) > height * CLOSE_DRAG) return true
        return abs(speed) > closeSpeed && sign(speed) == sign(drag) && drag != 0f
    }

    /** How much of the background shows while the picture is swiped [drag] pixels: 1 at rest, down to 0.3. */
    fun backgroundAlpha(drag: Float, height: Float): Float =
        if (height <= 0f) 1f else 1f - 0.7f * min(1f, abs(drag) / (height * 0.5f))

    /**
     * The part of the [original] (upright pixels) that is on [screen] under [c], or null if none. [fitted] is the
     * picture's size at zoom 1.
     */
    fun visibleArea(c: Camera, fitted: Dims, screen: Dims, original: Dims): Area? {
        if (fitted.empty || screen.empty || original.empty) return null
        val w = fitted.w * c.z
        val h = fitted.h * c.z
        val left = screen.w / 2 + c.x - w / 2
        val top = screen.h / 2 + c.y - h / 2
        val visible = Rect4(max(0f, left), max(0f, top), min(screen.w, left + w), min(screen.h, top + h))
        if (visible.empty) return null
        val sx = original.w / w
        val sy = original.h / h
        val source = Rect4(
            ((visible.left - left) * sx).coerceIn(0f, original.w),
            ((visible.top - top) * sy).coerceIn(0f, original.h),
            ((visible.right - left) * sx).coerceIn(0f, original.w),
            ((visible.bottom - top) * sy).coerceIn(0f, original.h),
        )
        if (source.empty) return null
        return Area(visible, source)
    }

    /**
     * [a] with its source grown to whole pixels (the decoder takes whole pixels), and its screen part grown by the same
     * amount. Without this the sharp copy would land up to one source pixel off: 5 screen pixels at zoom 5.
     */
    fun snapped(a: Area): Area {
        val s = a.source
        val kx = a.screen.width / s.width
        val ky = a.screen.height / s.height
        val l = floor(s.left)
        val t = floor(s.top)
        val r = ceil(s.right)
        val b = ceil(s.bottom)
        return Area(
            Rect4(a.screen.left - (s.left - l) * kx, a.screen.top - (s.top - t) * ky, a.screen.right + (r - s.right) * kx, a.screen.bottom + (b - s.bottom) * ky),
            Rect4(l, t, r, b),
        )
    }

    /**
     * Whether the picture on screen needs a sharper copy: the copy Coil made ([baseWidth] pixels wide) is stretched on
     * screen, and the original has more pixels to give.
     */
    fun needsSharp(c: Camera, fitted: Dims, baseWidth: Float, originalWidth: Float): Boolean {
        if (fitted.empty || baseWidth <= 0f) return false
        val onScreen = fitted.w * c.z
        return onScreen > baseWidth * 1.1f && originalWidth > baseWidth * 1.1f
    }

    /**
     * Android's region decoder takes every [n]th pixel, n a power of 2. The biggest n that still gives at least one
     * pixel per screen pixel, then bigger while the result is over [maxPixels].
     */
    fun sampleSize(source: Rect4, screen: Rect4, maxPixels: Float): Int {
        if (source.empty || screen.empty) return 1
        val ratio = min(source.width / screen.width, source.height / screen.height)
        var n = 1
        while (n * 2 <= ratio) n *= 2
        while ((source.width / n) * (source.height / n) > maxPixels && n < 64) n *= 2
        return n
    }

    /** EXIF orientations the viewer can turn upright (the rest are mirror images; those get no sharp copy). */
    fun degrees(orientation: Int): Int? = when (orientation) {
        0, 1 -> 0 // 0: unknown, taken as upright, the same as Coil
        3 -> 180
        6 -> 90
        8 -> 270
        else -> null
    }

    /** The upright size of a picture stored as [raw] pixels and turned [degrees]. */
    fun upright(raw: Dims, degrees: Int): Dims = if (degrees == 90 || degrees == 270) Dims(raw.h, raw.w) else raw

    /**
     * [r] in the upright picture ([upright] size) → the same part in the stored pixels, before the turn of [degrees].
     * The decoded part is then turned by [degrees] to stand upright again.
     */
    fun storedRect(r: Rect4, upright: Dims, degrees: Int): Rect4 = when (degrees) {
        90 -> Rect4(r.top, upright.w - r.right, r.bottom, upright.w - r.left)
        180 -> Rect4(upright.w - r.right, upright.h - r.bottom, upright.w - r.left, upright.h - r.top)
        270 -> Rect4(upright.h - r.bottom, r.left, upright.h - r.top, r.right)
        else -> r
    }

    /** "Photo {n} of {count}" filled in, n from 1. */
    fun label(template: String, index: Int, count: Int): String =
        template.replace("{n}", (index + 1).toString()).replace("{count}", count.toString())

    /**
     * What kind of link [uri] is. A `file://` path is checked later ([insideRoots]): a bundle comes over the air, so it
     * may only name files in the app's own folders. [HELD] is a `data:` picture that JS gave natively (`hold`), kept out
     * of the params: they are saved in Android's saved state, which has a size limit.
     */
    fun kind(uri: String): Source = when {
        uri.startsWith("https://", ignoreCase = true) || uri.startsWith("http://", ignoreCase = true) -> Source.WEB
        uri.startsWith("asset://") -> Source.ASSET
        uri.startsWith("asset:") -> Source.ASSET
        uri.startsWith("zn://file/") -> Source.FILE
        uri.startsWith("file://", ignoreCase = true) -> Source.FILE_URI
        uri.startsWith("content://", ignoreCase = true) -> Source.CONTENT
        uri == HELD_DATA -> Source.HELD
        else -> Source.REFUSED // data: in the params (use ImageViewer.open), other zn:// kinds, other schemes
    }

    /** The path inside the bundle of an `asset:` link. */
    fun assetPath(uri: String): String = uri.removePrefix("asset://").removePrefix("asset:")

    enum class Source { WEB, ASSET, FILE, FILE_URI, CONTENT, HELD, REFUSED }

    /** In the params, in place of a `data:` link JS gave natively. index.ts writes the same text. */
    const val HELD_DATA = "held:data"

    /** A `data:` picture's bytes, decoded. More is refused: it must not run the app out of memory. */
    const val MAX_DATA_BYTES = 5 * 1024 * 1024

    /** All held `data:` pictures together (ViewerHeld), across viewers. Over it, the oldest viewer's go first. */
    const val MAX_HELD_BYTES = 20 * 1024 * 1024

    /**
     * Where the base64 text of a `data:image/...;base64,` link starts, or null: not a picture, not base64, or more than
     * [MAX_DATA_BYTES] once decoded (checked from the length, before decoding).
     */
    fun dataStart(uri: String): Int? {
        if (!uri.startsWith("data:image/", ignoreCase = true)) return null
        val comma = uri.indexOf(',')
        if (comma < 0 || comma > 200) return null
        if (!uri.substring(0, comma).endsWith(";base64", ignoreCase = true)) return null
        val text = uri.length - comma - 1
        if (text <= 0 || text / 4L * 3 > MAX_DATA_BYTES) return null
        return comma + 1
    }

    /** The path of a `file://` link (percent signs decoded), or null if it can't be read or names another host. */
    fun filePath(uri: String): String? = try {
        val u = java.net.URI(uri)
        if (!u.scheme.equals("file", true) || !(u.host.isNullOrEmpty() || u.host == "localhost")) null
        else u.path?.takeIf { it.isNotEmpty() }
    } catch (e: Exception) {
        null
    }

    /**
     * Whether [canonical] (a path with `..` and links already resolved) is one of [roots] or inside one. Comparing
     * canonical paths is what stops `../` from leaving the app's folders.
     */
    fun insideRoots(canonical: String, roots: List<String>): Boolean = roots.any { root ->
        val r = root.trimEnd('/', '\\')
        r.isNotEmpty() && (canonical == r || canonical.startsWith("$r/") || canonical.startsWith("$r\\"))
    }

    /**
     * Request headers that may be sent: a token-like name (no spaces, colons or line breaks) and a value with no line
     * breaks. Others are dropped, so a header can't be split into two.
     */
    fun safeHeader(name: String, value: String): Boolean =
        name.isNotEmpty() && name.length <= 256 && name.none { it.isWhitespace() || it == ':' || it.code < 33 || it.code > 126 } &&
            value.length <= 8192 && value.none { it == '\r' || it == '\n' || it == '\u0000' }
}
