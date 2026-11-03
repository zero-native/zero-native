package dev.zeronative.plugins.pdf

import android.graphics.Bitmap
import android.graphics.Paint
import android.graphics.RectF
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import dev.zeronative.runtime.ZnHandles
import dev.zeronative.runtime.ZnViewScope
import kotlin.math.ceil
import org.json.JSONObject

/** What JS asked for in `props` (api.ts previewProps). */
internal data class PreviewSpec(val source: String?, val page: Int, val contain: Boolean, val background: Int) {
    companion object {
        fun of(p: JSONObject) = PreviewSpec(
            source = if (p.isNull("source")) null else p.optString("source"),
            page = p.optInt("page", 1),
            contain = p.optString("fit") == "contain",
            background = p.color("background", android.graphics.Color.WHITE),
        )
    }
}

/**
 * One page in a box, for a card: no touch, so a tap goes to what is around it. Only what the box shows is drawn, in one
 * bitmap of the box's size, so a 220 dp card costs the same for a long receipt as for one line. At most 1/3 of the budget.
 */
@Composable
internal fun PdfPreviewView(scope: ZnViewScope, views: PdfViews) {
    val context = LocalContext.current
    val spec = remember(scope.props) { PreviewSpec.of(scope.props) }
    var size by remember { mutableStateOf(IntSize.Zero) }
    var bitmap by remember { mutableStateOf<Bitmap?>(null) }
    val file = remember(spec.source) { spec.source?.let { ZnHandles.fileOf(context, it) } }
    val doc = remember(file) { file?.let(::PdfDoc) }
    DisposableEffect(doc) { onDispose { doc?.close() } }
    LaunchedEffect(spec.source, doc) { // the source too: one bad handle after another has no doc either time
        bitmap = null
        if (spec.source == null) return@LaunchedEffect
        if (doc == null) return@LaunchedEffect scope.emit("error", errorJson("not_found"))
        try {
            scope.emit("load", loadJson(scope.id, doc.open()))
        } catch (e: PdfFailure) {
            scope.emit("error", errorJson(e.code))
        }
    }
    LaunchedEffect(doc, size, spec) {
        if (doc == null || size.width <= 0 || size.height <= 0) return@LaunchedEffect
        val pages = try {
            doc.open()
        } catch (e: PdfFailure) {
            return@LaunchedEffect // said above
        }
        val index = (spec.page - 1).coerceIn(0, pages.size - 1)
        val s = PdfRules.areaScale(size.width, size.height, views.budget / 3)
        val place = PdfRules.previewPlace(index, pages[index], size.width, size.height, spec.contain)
        val scaled = Placed(index, place.x * s, place.y * s, place.scale * s)
        try {
            val drawn = doc.area(ceil(size.width * s).toInt().coerceAtLeast(1), ceil(size.height * s).toInt().coerceAtLeast(1), listOf(scaled), spec.background)
            if (drawn != null) {
                bitmap = drawn.bitmap
                if (drawn.failed.isNotEmpty()) scope.emit("error", errorJson("page", index))
            }
        } catch (e: PdfFailure) {
            scope.emit("error", errorJson(e.code, index))
        }
    }
    val paint = remember { Paint(Paint.FILTER_BITMAP_FLAG) }
    val background = remember(spec.background) { Paint().apply { color = spec.background } }
    Canvas(Modifier.fillMaxSize().clipToBounds().onSizeChanged { size = it }.semantics { contentDescription = "PDF preview" }) {
        drawIntoCanvas { canvas ->
            val b = bitmap
            if (b != null) {
                canvas.nativeCanvas.drawBitmap(b, null, RectF(0f, 0f, this.size.width, this.size.height), paint)
            } else {
                canvas.nativeCanvas.drawRect(0f, 0f, this.size.width, this.size.height, background)
            }
        }
    }
}
