package dev.zeronative.plugins.pdf

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.util.Log
import java.io.File
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.withContext

private const val TAG = "zn"

/**
 * The one thread every PdfRenderer of the app runs on. PdfRenderer is not thread-safe, and the pdfium code under it keeps
 * state for the whole process, so two views (a card and the full receipt) must not draw at the same time.
 */
internal object PdfThread {
    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "zn-pdf").apply { isDaemon = true } }
    val dispatcher = executor.asCoroutineDispatcher()

    fun run(block: () -> Unit) = executor.execute(block)

    /** For a thread that may wait, like a download's: runs [block] here and gives back its answer. */
    fun <T> await(block: () -> T): T = try {
        executor.submit(block).get()
    } catch (e: ExecutionException) {
        throw e.cause ?: e
    }
}

/** A page bitmap and the pages that failed to draw in it. */
internal class Drawn(val bitmap: Bitmap, val failed: List<Int>)

/**
 * One open PDF, for one view. Made on the main thread, opened and drawn on [PdfThread]. [close] can come at any time,
 * also while a draw waits: what runs after it does nothing.
 */
internal class PdfDoc(private val file: File) {
    private var fd: ParcelFileDescriptor? = null
    private var renderer: PdfRenderer? = null
    private var sizes: List<PageSize>? = null
    @Volatile private var closed = false

    /** The page sizes. Throws [PdfFailure]. Safe to call again. */
    suspend fun open(): List<PageSize> = withContext(PdfThread.dispatcher) { openHere() }

    private fun openHere(): List<PageSize> {
        sizes?.let { return it }
        if (closed) throw PdfFailure("failed", "closed")
        val (f, r) = openRenderer(file)
        fd = f
        renderer = r
        return readSizes(r).also { sizes = it }
    }

    /** Page [index] at [width] px wide, white behind it. Null after [close]. Throws [PdfFailure] "page" or "memory". */
    suspend fun page(index: Int, width: Int): Bitmap? = withContext(PdfThread.dispatcher) {
        val r = renderer?.takeIf { !closed } ?: return@withContext null
        val size = sizes!![index]
        val height = max(1, (width * size.aspect).roundToInt())
        val bitmap = newBitmap(width, height)
        bitmap.eraseColor(Color.WHITE)
        drawPage(r, index, bitmap, null, Matrix().apply { setScale(width / size.width, height / size.height) })
        bitmap
    }

    /**
     * A [width] × [height] bitmap with [places] drawn in it, each on white, the rest [background] (0: see-through). A page
     * that fails is left white and named in [Drawn.failed]. Null after [close].
     */
    suspend fun area(width: Int, height: Int, places: List<Placed>, background: Int): Drawn? = withContext(PdfThread.dispatcher) {
        val r = renderer?.takeIf { !closed } ?: return@withContext null
        val bitmap = newBitmap(width, height)
        bitmap.eraseColor(background)
        val canvas = Canvas(bitmap)
        val white = Paint().apply { color = Color.WHITE }
        val failed = ArrayList<Int>()
        for (p in places) {
            val size = sizes!![p.index]
            val clip = Rect(
                max(0, floor(p.x).toInt()),
                max(0, floor(p.y).toInt()),
                min(width, ceil(p.x + size.width * p.scale).toInt()),
                min(height, ceil(p.y + size.height * p.scale).toInt()),
            )
            if (clip.isEmpty) continue
            canvas.drawRect(clip, white)
            val matrix = Matrix().apply {
                setScale(p.scale, p.scale)
                postTranslate(p.x, p.y)
            }
            try {
                drawPage(r, p.index, bitmap, clip, matrix)
            } catch (e: PdfFailure) {
                failed += p.index
            }
        }
        Drawn(bitmap, failed)
    }

    /** Can come from any thread. The file closes after any draw already running. */
    fun close() {
        closed = true
        PdfThread.run {
            try {
                renderer?.close()
                fd?.close()
            } catch (e: Exception) {
                Log.w(TAG, "pdf: close failed: $e")
            }
            renderer = null
            fd = null
        }
    }

    companion object {
        /** Opens [file] to check it: pages and the first page's size. On [PdfThread] only. Throws [PdfFailure]. */
        fun check(file: File): List<PageSize> {
            val (f, r) = openRenderer(file)
            try {
                return readSizes(r)
            } finally {
                r.close()
                f.close()
            }
        }

        private fun openRenderer(file: File): Pair<ParcelFileDescriptor, PdfRenderer> {
            val f = try {
                ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            } catch (e: IOException) {
                throw PdfFailure("not_found", "can't open the file: $e")
            }
            try {
                val r = PdfRenderer(f)
                if (r.pageCount == 0) {
                    r.close()
                    throw PdfFailure("broken", "no pages")
                }
                return f to r
            } catch (e: Throwable) {
                f.close()
                throw when (e) {
                    is PdfFailure -> e
                    // Android says "password required or incorrect password" with this, before Android 15 and after.
                    is SecurityException -> PdfFailure("password", "the PDF needs a password")
                    is IOException -> PdfFailure("broken", "not a readable PDF: ${e.message}")
                    is OutOfMemoryError -> PdfFailure("memory", "the PDF is too big to open")
                    else -> PdfFailure("broken", "not a readable PDF: $e")
                }
            }
        }

        private fun readSizes(r: PdfRenderer): List<PageSize> = (0 until r.pageCount).map { i ->
            try {
                r.openPage(i).use { PageSize(max(1, it.width).toFloat(), max(1, it.height).toFloat()) }
            } catch (e: Exception) { // one bad page must not lose the rest: it draws as a blank A4 page
                Log.w(TAG, "pdf: page ${i + 1} has no size: $e")
                PageSize(595f, 842f)
            }
        }

        private fun newBitmap(width: Int, height: Int): Bitmap = try {
            // PdfRenderer draws only into ARGB_8888.
            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        } catch (e: OutOfMemoryError) {
            throw PdfFailure("memory", "no memory for a $width x $height page")
        }

        private fun drawPage(r: PdfRenderer, index: Int, bitmap: Bitmap, clip: Rect?, matrix: Matrix) {
            try {
                r.openPage(index).use { it.render(bitmap, clip, matrix, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY) }
            } catch (e: Exception) { // a broken page: IllegalStateException or IllegalArgumentException from pdfium's wrapper
                Log.w(TAG, "pdf: page ${index + 1} failed to draw: $e")
                throw PdfFailure("page", "page ${index + 1} failed: $e")
            }
        }
    }
}
