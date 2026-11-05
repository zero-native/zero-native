package dev.zeronative.plugins.imageviewer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Matrix
import android.graphics.Rect
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.exifinterface.media.ExifInterface
import coil3.SingletonImageLoader
import dev.zeronative.runtime.ZnBundles
import dev.zeronative.runtime.ZnHandles
import java.io.ByteArrayInputStream
import java.io.Closeable
import java.io.File
import java.io.InputStream
import kotlin.math.ceil

/**
 * The original picture, to cut sharp parts from when the user zooms in. Coil's copy fits the screen, so a 5x zoom would
 * stretch it; this reads only the part on screen from the original, at screen pixels (the pdf viewer does the same).
 * Memory stays about one screen's worth, whatever the picture's size.
 *
 * Opened on a background thread when first needed, closed when its page leaves. Thread safe.
 */
internal class SharpSource private constructor(
    private val decoder: BitmapRegionDecoder,
    private val keep: Closeable?,
    private val degrees: Int,
    /** The picture's upright size, in its own pixels. */
    val upright: Dims,
) {
    private val lock = Any()
    private var closed = false

    /** The part [area] of the original, upright, with at most [maxPixels] pixels; null if it can't be read. */
    fun decode(area: Area, maxPixels: Float): Bitmap? = synchronized(lock) {
        if (closed) return null
        val stored = ViewerRules.storedRect(area.source, upright, degrees)
        val rect = Rect(stored.left.toInt(), stored.top.toInt(), ceil(stored.right).toInt(), ceil(stored.bottom).toInt())
        if (!rect.intersect(0, 0, decoder.width, decoder.height)) return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = ViewerRules.sampleSize(area.source, area.screen, maxPixels)
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        val raw = try {
            decoder.decodeRegion(rect, options)
        } catch (e: Exception) {
            Log.w("zn", "image-viewer: sharp part failed: $e")
            null
        } ?: return null
        if (degrees == 0) return raw
        val turned = Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, Matrix().apply { postRotate(degrees.toFloat()) }, true)
        if (turned !== raw) raw.recycle()
        turned
    }

    fun close() {
        synchronized(lock) {
            if (closed) return
            closed = true
            decoder.recycle()
            runCatching { keep?.close() }
        }
    }

    companion object {
        /**
         * The original behind [image], or null: a web picture not in Coil's disk cache (a `no-store` answer), a mirror
         * image (rare EXIF), a format the region decoder can't read (GIF), a refused link, or a content:// link the app
         * may not read. Then the viewer only shows Coil's copy, a little soft when zoomed in. Background thread.
         */
        fun open(context: Context, image: ViewerImage): SharpSource? = try {
            val uri = image.uri
            when (ViewerRules.kind(uri)) {
                ViewerRules.Source.WEB -> {
                    val snapshot = SingletonImageLoader.get(context).diskCache?.openSnapshot(uri)
                    if (snapshot == null) {
                        Log.i("zn", "image-viewer: no disk copy of $uri, no sharp zoom")
                        null
                    } else {
                        // Kept open while the page shows: Coil doesn't rewrite or remove an entry that is open.
                        fromFile(snapshot.data.toFile(), Closeable { snapshot.close() }) ?: run { snapshot.close(); null }
                    }
                }
                ViewerRules.Source.ASSET -> when (val model = ZnBundles.assetModel(ViewerRules.assetPath(uri))) {
                    is File -> fromFile(model, null)
                    is String -> fromAsset(context, model.removePrefix("file:///android_asset/"))
                    else -> null
                }
                ViewerRules.Source.FILE -> ZnHandles.fileOf(context, uri)?.let { fromFile(it, null) }
                ViewerRules.Source.FILE_URI -> appFile(context, uri)?.let { fromFile(it, null) }
                ViewerRules.Source.CONTENT -> {
                    val u = Uri.parse(uri)
                    fromStreams { context.contentResolver.openInputStream(u) ?: throw java.io.FileNotFoundException("no stream") }
                }
                ViewerRules.Source.HELD -> image.held?.bytes?.let { b -> fromStreams { ByteArrayInputStream(b) } }
                ViewerRules.Source.REFUSED -> null
            }
        } catch (e: Exception) {
            Log.w("zn", "image-viewer: can't open ${shown(image.uri)} for sharp zoom: ${e.javaClass.simpleName}")
            null
        }

        /** A source read twice: once for its EXIF turn, once for the decoder (which copies what it needs). */
        private fun fromStreams(open: () -> InputStream): SharpSource? {
            val degrees = open().use { ViewerRules.degrees(ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)) } ?: return null
            val decoder = open().use { stream ->
                if (Build.VERSION.SDK_INT >= 31) {
                    BitmapRegionDecoder.newInstance(stream)
                } else {
                    @Suppress("DEPRECATION")
                    BitmapRegionDecoder.newInstance(stream, false)
                }
            } ?: return null
            return of(decoder, null, degrees)
        }

        private fun fromFile(file: File, keep: Closeable?): SharpSource? {
            val degrees = ViewerRules.degrees(ExifInterface(file.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1)) ?: return null
            val decoder = if (Build.VERSION.SDK_INT >= 31) {
                BitmapRegionDecoder.newInstance(file.path)
            } else {
                @Suppress("DEPRECATION")
                BitmapRegionDecoder.newInstance(file.path, false)
            }
            return of(decoder, keep, degrees)
        }

        private fun fromAsset(context: Context, path: String): SharpSource? = fromStreams { context.assets.open(path) }

        private fun of(decoder: BitmapRegionDecoder, keep: Closeable?, degrees: Int): SharpSource {
            val raw = Dims(decoder.width.toFloat(), decoder.height.toFloat())
            return SharpSource(decoder, keep, degrees, ViewerRules.upright(raw, degrees))
        }
    }
}
