package dev.zeronative.runtime

import android.graphics.BlurMaskFilter
import android.graphics.Paint as AndroidPaint
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils
import android.util.Log
import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.ClipOp
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.PaintingStyle
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.DrawStyle
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.toPath
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayList

// <Canvas> (registry 23): draws a command list from JS (core canvas.ts) in the draw phase only.
// Rules, so a bad list never crashes the app (ZeroBill takes payments on this runtime):
// - Everything is checked when the JSON is parsed: numbers must be finite, a gradient needs 2+ colours, a dash an even
//   length. A bad command is dropped (or drawn in a safe way) and named in one warning (Log.w) per command list. JS
//   warns too. A parse problem is not a red dev screen: the rest of the canvas still draws (second-opinions 197).
// - Colours come as ARGB numbers: core's parseColor turns them into numbers in JS. Native never parses colour strings
//   (android.graphics.Color.parseColor reads "#RRGGBBAA" as "#AARRGGBB"). A string is a warning and draws black.
// - A number may follow a motion value ("\u0000m<id>", core motion.ts): it is found once at parse ([ZnMotion.ref]) and
//   read in drawBehind, so a moving value redraws this canvas only (no recompose, no re-measure) and allocates nothing.
// - Brushes, strokes, dashes and paths are built once per command list, not on every draw. A stroke whose width moves
//   is built again only when the width changed.
// - The draw loop runs inside save / restoreToCount, so a transform or clip never moves this node's border or the
//   views after it. If drawing still throws, this canvas stops drawing and reports once (a dev error).

internal const val MAX_CANVAS_COMMANDS = 10000

/** At most this many problems are listed in one warning; the rest are counted. */
private const val MAX_LISTED_ERRORS = 10

/** What a slot holds for a motion value (core motion.ts). */
private const val MOTION_REF = "\u0000m"

/**
 * A number of a command: a constant (already in px, or degrees, or its own unit), or a motion value read on each draw
 * and multiplied by [scale] (density for positions). Reading it in the draw phase lets Compose redraw when it moves.
 */
internal class CNum(private val const: Float, val src: ZnSource?, private val scale: Float) {
    val value: Float get() = if (src == null) const else src.read(null) * scale

    /** The value now, without making the composition follow it (for parse-time sizes, like an image's decode size). */
    fun initial(): Float = if (src == null) const else Snapshot.withoutReadObservation { src.read(null) * scale }

    companion object {
        fun of(v: Float) = CNum(v, null, 1f)
    }
}

/** A colour: a constant, or a motion colour (v.mapColor, a derive ending in interpolateColor) read on each draw. */
internal class CColor(private val const: Color, val src: ZnSource?) {
    val value: Color get() = if (src == null) const else Color(src.readColor(null))
}

/** A gradient round a centre. Built on the first draw: SweepGradient is an Android class. */
internal class CanvasSweep(val cx: Float, val cy: Float, val colors: IntArray, val stops: FloatArray?, val startAngle: Float) {
    fun build(): Brush {
        val shader = android.graphics.SweepGradient(cx, cy, colors, stops)
        if (startAngle != 0f) shader.setLocalMatrix(android.graphics.Matrix().apply { setRotate(startAngle, cx, cy) })
        return ShaderBrush(shader)
    }
}

internal class CanvasShadow(val dx: Float, val dy: Float, val blur: Float, val color: Int)

/**
 * Paint for one command, in px (or dp for a path, which is drawn under scale(density)).
 * [gradient] (linear or radial) is built at parse time (pure Kotlin). [brush], [style] and [pathEffect] need Android
 * classes, so they are built on the first draw and then kept with this command list.
 */
internal class CanvasPaint(
    val color: CColor,
    val opacity: CNum,
    val gradient: Brush?,
    val sweep: CanvasSweep?,
    val isStroke: Boolean,
    val strokeWidth: CNum,
    /** 1 px in this paint's units. */
    val minWidth: Float,
    val cap: StrokeCap,
    val join: StrokeJoin,
    val dash: FloatArray?,
    val fillType: PathFillType,
    val blendMode: BlendMode,
    val shadow: CanvasShadow?,
    /** Blur radius in this paint's units; 0 for none. */
    val blur: Float,
) {
    val pathEffect: PathEffect? by lazy(LazyThreadSafetyMode.NONE) { dash?.let { PathEffect.dashPathEffect(it, 0f) } }

    /**
     * The brush to draw with. A gradient's points are fixed, so its shader is made once: a shape whose size moves
     * doesn't make a new shader each frame (ShaderBrush makes one per size).
     */
    val brush: Brush? by lazy(LazyThreadSafetyMode.NONE) {
        sweep?.build() ?: (gradient as? ShaderBrush)?.let { ShaderBrush(it.createShader(Size(1f, 1f))) } ?: gradient
    }

    /** Below Android 10 Multiply is not a hardware blend mode: Modulate is the same for opaque colours. */
    val blend: BlendMode by lazy(LazyThreadSafetyMode.NONE) {
        if (blendMode == BlendMode.Multiply && Build.VERSION.SDK_INT < 29) BlendMode.Modulate else blendMode
    }

    /** True when it needs [fxPaint] (a shadow or a blur): the DrawScope calls can't do those. */
    val hasFx: Boolean get() = shadow != null || blur > 0f

    fun width(): Float = strokeWidth.value.coerceAtLeast(minWidth)

    fun alpha(): Float = opacity.value.coerceIn(0f, 1f)

    private var madeStroke: Stroke? = null
    private var madeWidth = -1f

    /** Fill, or a stroke kept until its width changes (a moving strokeWidth makes one Stroke per new width). */
    fun style(): DrawStyle {
        if (!isStroke) return Fill
        val w = width()
        val s = madeStroke
        if (s != null && madeWidth == w) return s
        return Stroke(width = w, cap = cap, join = join, pathEffect = pathEffect).also {
            madeStroke = it
            madeWidth = w
        }
    }

    private val fx: Paint? by lazy(LazyThreadSafetyMode.NONE) {
        if (!hasFx) return@lazy null
        Paint().also { p ->
            p.isAntiAlias = true
            p.style = if (isStroke) PaintingStyle.Stroke else PaintingStyle.Fill
            p.strokeCap = cap
            p.strokeJoin = join
            p.pathEffect = pathEffect
            p.blendMode = blend
            val f = p.asFrameworkPaint()
            if (blur > 0f) f.maskFilter = BlurMaskFilter(blur, BlurMaskFilter.Blur.NORMAL)
            shadow?.let { f.setShadowLayer(it.blur, it.dx, it.dy, it.color) }
        }
    }

    /** The paint for a shape with a shadow or a blur, set for this frame. One per command, made on the first draw. */
    fun fxPaint(size: Size): Paint {
        val p = fx!!
        // Also for a fill: a line is drawn with the stroke width whatever its style.
        p.strokeWidth = width()
        val a = alpha()
        val b = brush
        if (b != null) {
            b.applyTo(size, p, a)
        } else {
            if (p.shader != null) p.shader = null
            val c = color.value
            p.color = if (a < 1f) c.copy(alpha = c.alpha * a) else c
        }
        return p
    }
}

internal const val FIT_COVER = 0
internal const val FIT_CONTAIN = 1
internal const val FIT_FILL = 2

/** One parsed command. Positions and sizes are in px (dp × density), except a path's, which stay in dp. */
internal sealed class CanvasOp {
    class RectOp(val x: CNum, val y: CNum, val w: CNum, val h: CNum, val paint: CanvasPaint) : CanvasOp()
    class RoundRectOp(val x: CNum, val y: CNum, val w: CNum, val h: CNum, val r: CNum, val paint: CanvasPaint) : CanvasOp()
    class CircleOp(val cx: CNum, val cy: CNum, val r: CNum, val paint: CanvasPaint) : CanvasOp()
    class OvalOp(val x: CNum, val y: CNum, val w: CNum, val h: CNum, val paint: CanvasPaint) : CanvasOp()
    class LineOp(val x1: CNum, val y1: CNum, val x2: CNum, val y2: CNum, val paint: CanvasPaint) : CanvasOp()
    class ArcOp(val x: CNum, val y: CNum, val w: CNum, val h: CNum, val start: CNum, val sweep: CNum, val useCenter: Boolean, val paint: CanvasPaint) : CanvasOp()

    /**
     * Path data in dp; drawn under scale(density), so its paint is built with 1f (dp units). With a trim, only a piece of
     * it is drawn: cut with PathMeasure into one reused path, as <Svg> trims are (ZnSvg.kt), with no allocation per frame.
     */
    class PathOp(val nodes: List<PathNode>, val paint: CanvasPaint, val trimStart: CNum?, val trimEnd: CNum?, val trimOffset: CNum?) : CanvasOp() {
        val path: Path by lazy(LazyThreadSafetyMode.NONE) { nodes.toPath().also { it.fillType = paint.fillType } }
        val trimmed = trimStart != null || trimEnd != null || trimOffset != null
        private val measure by lazy(LazyThreadSafetyMode.NONE) { android.graphics.PathMeasure() }
        private val piece by lazy(LazyThreadSafetyMode.NONE) { Path().also { it.fillType = paint.fillType } }
        private val range = FloatArray(4)
        private var total = -1f

        /** The path to draw now: all of it, its trimmed piece, or null when nothing of it shows. */
        fun visible(): Path? {
            if (!trimmed) return path
            val s = trimStart?.value ?: 0f
            val e = trimEnd?.value ?: 1f
            val o = trimOffset?.value ?: 0f
            val src = path.asAndroidPath()
            if (total < 0f) total = length(src)
            if (!znTrimRanges(s, e, o, total, range, 0)) return path
            val out = piece.asAndroidPath()
            out.reset() // keeps the fill type
            var any = segment(src, range[0], range[1], out)
            if (range[2] >= 0f && range[3] > range[2] && segment(src, range[2], range[3], out)) any = true
            return if (any) piece else null
        }

        private fun length(src: android.graphics.Path): Float {
            measure.setPath(src, false)
            var t = 0f
            do {
                t += measure.length
            } while (measure.nextContour())
            return t
        }

        /** Adds the piece from [a] to [b] (lengths along all contours) to [out]. */
        private fun segment(src: android.graphics.Path, a: Float, b: Float, out: android.graphics.Path): Boolean {
            if (!(b > a)) return false
            measure.setPath(src, false)
            var c0 = 0f
            var any = false
            do {
                val c1 = c0 + measure.length
                val x0 = maxOf(a, c0)
                val x1 = minOf(b, c1)
                if (x1 > x0 && measure.getSegment(x0 - c0, x1 - c0, out, true)) any = true
                c0 = c1
            } while (c0 < b && measure.nextContour())
            return any
        }
    }

    /** [fontSize] in dp; [x] / [y] in px, [y] is the baseline. */
    class TextOp(val text: String, val x: CNum, val y: CNum, val fontSize: Float, val fontWeight: Int?, val color: CColor, val align: AndroidPaint.Align) : CanvasOp() {
        val typeface: Typeface by lazy(LazyThreadSafetyMode.NONE) { canvasTypeface(fontWeight) }
    }

    /**
     * Text that wraps at [width] px, [y] is the top. The StaticLayout is built once per command list (on the first
     * draw: it is an Android class). [lineHeight] px, 0 for the font's own. [align]: 0 left, 1 center, 2 right.
     */
    class ParagraphOp(
        val text: String, val x: CNum, val y: CNum, val width: Int, val fontSizePx: Float, val fontWeight: Int?,
        val color: CColor, val align: Int, val lineHeight: Float, val maxLines: Int,
    ) : CanvasOp() {
        val paint: TextPaint by lazy(LazyThreadSafetyMode.NONE) {
            TextPaint(AndroidPaint.ANTI_ALIAS_FLAG).apply {
                textSize = fontSizePx
                typeface = canvasTypeface(fontWeight)
            }
        }
        val layout: StaticLayout by lazy(LazyThreadSafetyMode.NONE) {
            val alignment = when (align) {
                1 -> Layout.Alignment.ALIGN_CENTER
                2 -> Layout.Alignment.ALIGN_OPPOSITE
                else -> Layout.Alignment.ALIGN_NORMAL
            }
            val b = StaticLayout.Builder.obtain(text, 0, text.length, paint, width).setAlignment(alignment).setIncludePad(false)
            if (maxLines < Int.MAX_VALUE) b.setMaxLines(maxLines).setEllipsize(TextUtils.TruncateAt.END)
            if (lineHeight > 0f) {
                val fm = paint.fontMetrics
                b.setLineSpacing(lineHeight - (fm.descent - fm.ascent), 1f)
            }
            b.build()
        }
    }

    /**
     * An image from [src] (the same forms as <Image>), loaded by Coil at about [decodeW] × [decodeH] px (ZnCanvasImage.kt).
     * Nothing is drawn while it loads or after an error. [fit]: FIT_COVER, FIT_CONTAIN, FIT_FILL.
     */
    class ImageOp(
        val src: String, val x: CNum, val y: CNum, val w: CNum, val h: CNum, val fit: Int, val radius: CNum?, val opacity: CNum,
        val decodeW: Int, val decodeH: Int,
    ) : CanvasOp() {
        /** Main thread only. */
        var bitmap: ImageBitmap? = null
        val clip: Path by lazy(LazyThreadSafetyMode.NONE) { Path() }
        val key: String get() = "$src|${decodeW}x$decodeH"
    }

    class TranslateOp(val dx: CNum, val dy: CNum) : CanvasOp()
    class ScaleOp(val sx: CNum, val sy: CNum) : CanvasOp()
    class RotateOp(val degrees: CNum, val px: CNum, val py: CNum) : CanvasOp()
    class ClipRectOp(val x: CNum, val y: CNum, val w: CNum, val h: CNum, val op: ClipOp) : CanvasOp()
    class ClipRoundRectOp(val x: CNum, val y: CNum, val w: CNum, val h: CNum, val r: CNum, val op: ClipOp) : CanvasOp() {
        /** Filled again on each draw (its numbers may move); no allocation. */
        val path: Path by lazy(LazyThreadSafetyMode.NONE) { Path() }
    }

    /** Path data in dp, turned into px ([scale]) once on the first draw: a clip must stay after this command. */
    class ClipPathOp(val nodes: List<PathNode>, val scale: Float, val fillType: PathFillType, val op: ClipOp) : CanvasOp() {
        val path: Path by lazy(LazyThreadSafetyMode.NONE) {
            nodes.toPath().also {
                it.fillType = fillType
                it.asAndroidPath().transform(android.graphics.Matrix().apply { setScale(scale, scale) })
            }
        }
    }

    object SaveOp : CanvasOp()
    object RestoreOp : CanvasOp()
}

/** A parsed command list: what to draw, and the problems found (empty when all is well). */
internal class CanvasCommands(val ops: List<CanvasOp>, val errors: List<String>, val needsLayer: Boolean = false) {
    /** Set when drawing threw: this canvas then draws nothing until its command list changes. */
    var failed = false
}

private val EMPTY_COMMANDS = CanvasCommands(emptyList(), emptyList())

/** A command that can't be drawn at all; its message names the field. */
private class BadCommand(message: String) : Exception(message)

/** API 28+ takes any weight; below, the nearest of regular and bold. */
private fun canvasTypeface(weight: Int?): Typeface = when {
    weight == null -> Typeface.DEFAULT
    Build.VERSION.SDK_INT >= 28 -> Typeface.create(Typeface.DEFAULT, weight, false)
    weight >= 600 -> Typeface.DEFAULT_BOLD
    else -> Typeface.DEFAULT
}

/** Blend modes by their JS names. Every one maps to a PorterDuff mode below Android 10 (multiply through Modulate). */
private val BLEND_MODES = mapOf(
    "srcOver" to BlendMode.SrcOver,
    "multiply" to BlendMode.Multiply,
    "screen" to BlendMode.Screen,
    "overlay" to BlendMode.Overlay,
    "darken" to BlendMode.Darken,
    "lighten" to BlendMode.Lighten,
    "plus" to BlendMode.Plus,
    "clear" to BlendMode.Clear,
    "srcIn" to BlendMode.SrcIn,
    "srcOut" to BlendMode.SrcOut,
    "srcAtop" to BlendMode.SrcAtop,
    "dstIn" to BlendMode.DstIn,
    "dstOut" to BlendMode.DstOut,
    "dstOver" to BlendMode.DstOver,
    "dstAtop" to BlendMode.DstAtop,
    "xor" to BlendMode.Xor,
)

/**
 * Parses the command list once per change. [density] turns dp into px (paths stay in dp). Never throws: bad JSON or a
 * list over [MAX_CANVAS_COMMANDS] gives nothing to draw and an error; a bad command is dropped (or made safe) and named.
 */
internal fun parseCanvasCommands(json: String?, density: Float = 1f): CanvasCommands {
    if (json.isNullOrEmpty() || json == "[]" || json == "null") return EMPTY_COMMANDS
    val array = try {
        JSONArray(json)
    } catch (e: Exception) {
        return CanvasCommands(emptyList(), listOf("commands are not a JSON array: ${e.message}"))
    }
    // Counted before any command is built.
    if (array.length() > MAX_CANVAS_COMMANDS) {
        return CanvasCommands(emptyList(), listOf("${array.length()} commands, more than the $MAX_CANVAS_COMMANDS allowed; nothing is drawn"))
    }
    return CanvasParser(if (density.isFinite() && density > 0f) density else 1f).parse(array)
}

private class CanvasParser(private val d: Float) {
    private val errors = ArrayList<String>()
    private var errorCount = 0
    private var index = 0
    private val pathParser = PathParser() // reused: pathStringToNodes gives a new list each time
    /** A blend mode other than srcOver: the list draws into its own layer (see the draw loop). */
    private var blends = false

    fun error(message: String) {
        errorCount++
        if (errors.size < MAX_LISTED_ERRORS) errors.add("command $index: $message")
    }

    fun parse(array: JSONArray): CanvasCommands {
        val ops = ArrayList<CanvasOp>(array.length())
        var depth = 0
        for (i in 0 until array.length()) {
            index = i
            val item = array.opt(i)
            // `[a, cond && draw.circle(...)]`: null and false are skipped without an error.
            if (item == null || item == JSONObject.NULL || item == false) continue
            if (item !is JSONObject) {
                error("not a command object")
                continue
            }
            try {
                val op = command(item)
                when (op) {
                    is CanvasOp.SaveOp -> depth++
                    is CanvasOp.RestoreOp -> {
                        if (depth == 0) {
                            error("restore without a save; skipped")
                            continue
                        }
                        depth--
                    }
                    else -> {}
                }
                ops.add(op)
            } catch (e: BadCommand) {
                error("${e.message}; skipped")
            } catch (e: Exception) {
                error("${e.message ?: e::class.simpleName}; skipped")
            }
        }
        if (errorCount > errors.size) errors.add("and ${errorCount - errors.size} more")
        return CanvasCommands(ops, errors, blends)
    }

    private fun command(o: JSONObject): CanvasOp {
        return when (val type = o.optString("type")) {
            "rect" -> CanvasOp.RectOp(pxV(o, "x"), pxV(o, "y"), pxV(o, "w"), pxV(o, "h"), paint(o, d))
            "roundRect" -> CanvasOp.RoundRectOp(pxV(o, "x"), pxV(o, "y"), pxV(o, "w"), pxV(o, "h"), pxV(o, "r"), paint(o, d))
            "circle" -> CanvasOp.CircleOp(pxV(o, "cx"), pxV(o, "cy"), pxV(o, "r"), paint(o, d))
            "oval" -> CanvasOp.OvalOp(pxV(o, "x"), pxV(o, "y"), pxV(o, "w"), pxV(o, "h"), paint(o, d))
            "line" -> CanvasOp.LineOp(pxV(o, "x1"), pxV(o, "y1"), pxV(o, "x2"), pxV(o, "y2"), paint(o, d))
            "arc" -> CanvasOp.ArcOp(
                pxV(o, "x"), pxV(o, "y"), pxV(o, "w"), pxV(o, "h"),
                numV(o, "start"), numV(o, "sweep"), o.optBoolean("useCenter", false), paint(o, d),
            )
            "path" -> {
                val data = o.opt("d") as? String ?: throw BadCommand("\"d\" must be a string")
                val nodes = znAbsoluteMovesAfterClose(pathParser.pathStringToNodes(data, ArrayList()))
                // Drawn under scale(density): the paint is in dp, so its gradient and stroke are not scaled twice.
                CanvasOp.PathOp(nodes, paint(o, 1f), optNumV(o, "trimStart"), optNumV(o, "trimEnd"), optNumV(o, "trimOffset"))
            }
            "text" -> text(o)
            "paragraph" -> paragraph(o)
            "image" -> image(o)
            "save" -> CanvasOp.SaveOp
            "restore" -> CanvasOp.RestoreOp
            "translate" -> CanvasOp.TranslateOp(pxV(o, "dx"), pxV(o, "dy"))
            "scale" -> {
                val sx = numV(o, "sx")
                CanvasOp.ScaleOp(sx, optNumV(o, "sy") ?: sx)
            }
            "rotate" -> CanvasOp.RotateOp(numV(o, "degrees"), optNumV(o, "px", d) ?: ZERO, optNumV(o, "py", d) ?: ZERO)
            "clipRect" -> CanvasOp.ClipRectOp(pxV(o, "x"), pxV(o, "y"), pxV(o, "w"), pxV(o, "h"), clipOp(o))
            "clipRoundRect" -> CanvasOp.ClipRoundRectOp(pxV(o, "x"), pxV(o, "y"), pxV(o, "w"), pxV(o, "h"), pxV(o, "r"), clipOp(o))
            "clipPath" -> {
                val data = o.opt("d") as? String ?: throw BadCommand("\"d\" must be a string")
                CanvasOp.ClipPathOp(znAbsoluteMovesAfterClose(pathParser.pathStringToNodes(data, ArrayList())), d, fillType(o), clipOp(o))
            }
            "" -> throw BadCommand("no \"type\"")
            else -> throw BadCommand("unknown type \"$type\"")
        }
    }

    private fun clipOp(o: JSONObject): ClipOp = when (val op = o.opt("op")) {
        null, JSONObject.NULL, "intersect" -> ClipOp.Intersect
        "difference" -> ClipOp.Difference
        else -> {
            error("op \"$op\" is not known; intersect is used")
            ClipOp.Intersect
        }
    }

    private fun fillType(o: JSONObject): PathFillType = when (val f = o.opt("fillType")) {
        null, JSONObject.NULL, "nonZero" -> PathFillType.NonZero
        "evenOdd" -> PathFillType.EvenOdd
        else -> {
            error("fillType \"$f\" is not known; nonZero is used")
            PathFillType.NonZero
        }
    }

    private fun fontWeight(opts: JSONObject?): Int? = when (val fw = opts?.opt("fontWeight")) {
        null, JSONObject.NULL, "normal" -> null
        "bold" -> 700
        is Number -> finite(fw.toDouble(), "fontWeight").toInt().coerceIn(1, 1000)
        is String -> fw.toIntOrNull()?.coerceIn(1, 1000) ?: run { error("fontWeight \"$fw\" is not known; normal is used"); null }
        else -> null
    }

    private fun fontSize(opts: JSONObject?): Float {
        val fontSize = if (opts != null && opts.has("fontSize") && !opts.isNull("fontSize")) num(opts, "fontSize") else 14f
        if (fontSize <= 0f) throw BadCommand("\"fontSize\" must be above 0")
        return fontSize
    }

    private fun textOf(o: JSONObject): String {
        val content = o.opt("text")
        return if (content is String) content else if (content is Number) content.toString() else throw BadCommand("\"text\" must be a string")
    }

    private fun text(o: JSONObject): CanvasOp.TextOp {
        val text = textOf(o)
        val opts = o.optJSONObject("options")
        val fontSize = fontSize(opts)
        val weight = fontWeight(opts)
        val align = when (opts?.optString("align")) {
            "center" -> AndroidPaint.Align.CENTER
            "right" -> AndroidPaint.Align.RIGHT
            else -> AndroidPaint.Align.LEFT
        }
        return CanvasOp.TextOp(text, pxV(o, "x"), pxV(o, "y"), fontSize, weight, colorV(opts, "color", Color.Black), align)
    }

    private fun paragraph(o: JSONObject): CanvasOp.ParagraphOp {
        val text = textOf(o)
        val width = px(o, "width")
        if (width < 1f) throw BadCommand("\"width\" must be above 0")
        val opts = o.optJSONObject("options")
        val fontSize = fontSize(opts)
        val align = when (opts?.optString("align")) {
            "center" -> 1
            "right" -> 2
            else -> 0
        }
        var lineHeight = 0f
        if (opts != null && opts.has("lineHeight") && !opts.isNull("lineHeight")) {
            val v = (opts.opt("lineHeight") as? Number)?.toDouble()?.toFloat()
            if (v == null || !v.isFinite() || v <= 0f) error("lineHeight must be a finite number above 0; the font's own is used")
            else lineHeight = v * d
        }
        var maxLines = Int.MAX_VALUE
        if (opts != null && opts.has("maxLines") && !opts.isNull("maxLines")) {
            val v = (opts.opt("maxLines") as? Number)?.toDouble()
            if (v == null || !v.isFinite() || v < 1.0) error("maxLines must be 1 or more; no limit")
            else maxLines = minOf(v, Int.MAX_VALUE.toDouble()).toInt()
        }
        return CanvasOp.ParagraphOp(
            text, pxV(o, "x"), pxV(o, "y"), minOf(width, 100_000f).toInt(), fontSize * d, fontWeight(opts),
            colorV(opts, "color", Color.Black), align, lineHeight, maxLines,
        )
    }

    private fun image(o: JSONObject): CanvasOp.ImageOp {
        val src = o.opt("src") as? String ?: throw BadCommand("\"src\" must be a string")
        if (src.isEmpty()) throw BadCommand("\"src\" is empty")
        val x = pxV(o, "x")
        val y = pxV(o, "y")
        val w = pxV(o, "w")
        val h = pxV(o, "h")
        val opts = o.optJSONObject("options")
        val fit = when (val f = opts?.opt("fit")) {
            null, JSONObject.NULL, "cover" -> FIT_COVER
            "contain" -> FIT_CONTAIN
            "fill" -> FIT_FILL
            else -> {
                error("fit \"$f\" is not known; cover is used")
                FIT_COVER
            }
        }
        val radius = if (opts != null) optNumV(opts, "radius", d) else null
        val opacity = (if (opts != null) optNumV(opts, "opacity") else null) ?: ONE
        // Decoded at about the drawn size, never above 4096 px a side. A size that follows a motion value (an image that
        // grows) is decoded at the screen's longer side instead: its size when the list was read may be 1 px, and a
        // decode at that size would stay blurry as it grows (review 2026-11-09). ZnCanvasImage asks Coil for an inexact
        // size, so a small picture is not blown up to it.
        val moving = w.src != null || h.src != null
        val screen = if (!moving) 0f else runCatching {
            android.content.res.Resources.getSystem().displayMetrics.let { maxOf(it.widthPixels, it.heightPixels) }.toFloat()
        }.getOrDefault(2048f)
        val dw = (if (moving) screen else w.initial()).coerceIn(1f, 4096f).toInt()
        val dh = (if (moving) screen else h.initial()).coerceIn(1f, 4096f).toInt()
        return CanvasOp.ImageOp(src, x, y, w, h, fit, radius, opacity, dw, dh)
    }

    /** [scale] is px per unit of this command: density, or 1f for a path (drawn under scale(density)). */
    private fun paint(command: JSONObject, scale: Float): CanvasPaint {
        // The same minimum stroke width everywhere: 1 px, which is scale / d units.
        val minWidth = scale / d
        val o = command.optJSONObject("paint")
            ?: return CanvasPaint(
                CColor(Color.Black, null), ONE, null, null, false, CNum.of(minWidth), minWidth, StrokeCap.Butt, StrokeJoin.Miter,
                null, PathFillType.NonZero, BlendMode.SrcOver, null, 0f,
            )
        var color = colorV(o, "color", Color.Black)
        val isStroke = o.optString("style") == "stroke"
        val width = optNumV(o, "strokeWidth", scale) ?: CNum.of(minWidth)
        val cap = when (o.optString("strokeCap")) {
            "round" -> StrokeCap.Round
            "square" -> StrokeCap.Square
            else -> StrokeCap.Butt
        }
        val join = when (o.optString("strokeJoin")) {
            "round" -> StrokeJoin.Round
            "bevel" -> StrokeJoin.Bevel
            else -> StrokeJoin.Miter
        }
        val opacity = optNumV(o, "opacity") ?: ONE
        val dash = dash(o.opt("dash"), scale)

        var brush: Brush? = null
        var sweep: CanvasSweep? = null
        val lin = o.optJSONObject("linearGradient")
        val rad = o.optJSONObject("radialGradient")
        val swp = o.optJSONObject("sweepGradient")
        if (lin != null) {
            val g = gradient(lin, "linearGradient")
            if (g.colors.size < 2) {
                if (g.colors.size == 1) color = CColor(g.colors[0], null)
            } else {
                val start = Offset(finite(num(lin, "x0").toDouble() * scale, "x0"), finite(num(lin, "y0").toDouble() * scale, "y0"))
                val end = Offset(finite(num(lin, "x1").toDouble() * scale, "x1"), finite(num(lin, "y1").toDouble() * scale, "y1"))
                brush = if (g.stops != null) Brush.linearGradient(colorStops = g.stops, start = start, end = end)
                else Brush.linearGradient(colors = g.colors, start = start, end = end)
            }
        } else if (rad != null) {
            val g = gradient(rad, "radialGradient")
            if (g.colors.size < 2) {
                if (g.colors.size == 1) color = CColor(g.colors[0], null)
            } else {
                val center = Offset(finite(num(rad, "cx").toDouble() * scale, "cx"), finite(num(rad, "cy").toDouble() * scale, "cy"))
                val radius = finite(num(rad, "r").toDouble() * scale, "r").coerceAtLeast(0.1f)
                brush = if (g.stops != null) Brush.radialGradient(colorStops = g.stops, center = center, radius = radius)
                else Brush.radialGradient(colors = g.colors, center = center, radius = radius)
            }
        } else if (swp != null) {
            val g = gradient(swp, "sweepGradient")
            if (g.colors.size < 2) {
                if (g.colors.size == 1) color = CColor(g.colors[0], null)
            } else {
                val cx = finite(num(swp, "cx").toDouble() * scale, "cx")
                val cy = finite(num(swp, "cy").toDouble() * scale, "cy")
                var angle = 0f
                if (swp.has("startAngle") && !swp.isNull("startAngle")) {
                    val a = (swp.opt("startAngle") as? Number)?.toDouble()?.toFloat()
                    if (a == null || !a.isFinite()) error("sweepGradient startAngle must be a finite number; 0 is used") else angle = a
                }
                val stops = g.stops?.let { s -> FloatArray(s.size) { s[it].first } }
                sweep = CanvasSweep(cx, cy, IntArray(g.colors.size) { g.colors[it].toArgb() }, stops, angle)
            }
        }
        val blend = when (val b = o.opt("blendMode")) {
            null, JSONObject.NULL -> BlendMode.SrcOver
            else -> BLEND_MODES[b as? String] ?: run {
                error("blendMode \"$b\" is not known; srcOver is used")
                BlendMode.SrcOver
            }
        }
        if (blend != BlendMode.SrcOver) blends = true
        var blur = 0f
        if (o.has("blur") && !o.isNull("blur")) {
            val v = (o.opt("blur") as? Number)?.toDouble()?.toFloat()
            if (v == null || !v.isFinite() || v < 0f) error("blur must be a finite number ≥ 0; no blur") else blur = v * scale
        }
        return CanvasPaint(
            color, opacity, brush, sweep, isStroke, width, minWidth, cap, join, dash, fillType(o), blend, shadow(o, scale, minWidth), blur,
        )
    }

    /** {dx, dy, blur, color}: anything wrong gives no shadow (the shape still draws). */
    private fun shadow(o: JSONObject, scale: Float, minWidth: Float): CanvasShadow? {
        if (!o.has("shadow") || o.isNull("shadow")) return null
        val s = o.optJSONObject("shadow")
        if (s == null) {
            error("shadow must be an object; no shadow")
            return null
        }
        return try {
            val c = s.opt("color")
            if (c !is Number) throw BadCommand("shadow color must be an ARGB number")
            // Android removes the shadow at radius 0: at least 1 px.
            CanvasShadow(num(s, "dx") * scale, num(s, "dy") * scale, (num(s, "blur") * scale).coerceAtLeast(minWidth), colorValue(c, "shadow color").toArgb())
        } catch (e: BadCommand) {
            error("${e.message}; no shadow")
            null
        }
    }

    private class Gradient(val colors: List<Color>, val stops: Array<Pair<Float, Color>>?)

    /** Under 2 colours: no gradient (the caller draws a solid colour). Stops that don't match the colours: dropped. */
    private fun gradient(g: JSONObject, name: String): Gradient {
        val arr = g.optJSONArray("colors")
        val colors = ArrayList<Color>(arr?.length() ?: 0)
        if (arr != null) for (i in 0 until arr.length()) colors.add(colorValue(arr.opt(i), "$name colour $i"))
        if (colors.size < 2) {
            error("$name needs at least 2 colours, has ${colors.size}; drawn in one colour")
            return Gradient(colors, null)
        }
        val stopsArr = g.optJSONArray("stops") ?: return Gradient(colors, null)
        if (stopsArr.length() != colors.size) {
            error("$name has ${stopsArr.length()} stops for ${colors.size} colours; stops are left out")
            return Gradient(colors, null)
        }
        val stops = ArrayList<Pair<Float, Color>>(colors.size)
        for (i in 0 until colors.size) {
            val f = (stopsArr.opt(i) as? Number)?.toDouble()?.toFloat()
            if (f == null || !f.isFinite()) {
                error("$name stop $i is not a finite number; stops are left out")
                return Gradient(colors, null)
            }
            stops.add(f.coerceIn(0f, 1f) to colors[i])
        }
        return Gradient(colors, stops.toTypedArray())
    }

    /** Android's DashPathEffect throws on an odd length: only an even length ≥ 2, values ≥ 0, a sum > 0. */
    private fun dash(v: Any?, scale: Float): FloatArray? {
        if (v == null || v == JSONObject.NULL) return null
        if (v !is JSONArray) {
            error("dash must be an array; no dash")
            return null
        }
        val n = v.length()
        if (n < 2 || n % 2 != 0) {
            error("dash needs an even number of values (2, 4, ...), has $n; no dash")
            return null
        }
        var sum = 0f
        val out = FloatArray(n)
        for (i in 0 until n) {
            val f = (v.opt(i) as? Number)?.toDouble()?.toFloat()
            if (f == null || !f.isFinite() || f < 0f) {
                error("dash value $i must be a finite number ≥ 0; no dash")
                return null
            }
            out[i] = f * scale
            sum += f
        }
        if (!(sum > 0f) || !sum.isFinite()) {
            error("dash values add up to 0; no dash")
            return null
        }
        return out
    }

    /** A colour that may follow a motion colour. A number motion value, or one that is gone, draws black. */
    private fun colorV(o: JSONObject?, key: String, fallback: Color): CColor {
        if (o == null || !o.has(key) || o.isNull(key)) return CColor(fallback, null)
        val v = o.opt(key)
        if (v is String && v.startsWith(MOTION_REF)) {
            val src = ZnMotion.ref(v)
            if (src == null) {
                error("$key follows motion value ${v.substring(MOTION_REF.length)}, which is gone; black is used")
                return CColor(Color.Black, null)
            }
            if (!src.isColor) {
                error("$key follows a number, not a colour (use v.mapColor(...)); black is used")
                return CColor(Color.Black, null)
            }
            return CColor(Color.Black, src)
        }
        return CColor(colorValue(v, key), null)
    }

    /** An ARGB number (core parseColor). A string is a warning and black: native never parses colour strings. */
    private fun colorValue(v: Any?, what: String): Color {
        if (v is Number) {
            val n = v.toDouble()
            if (n.isFinite() && n == Math.floor(n) && n >= Int.MIN_VALUE.toDouble() && n <= 0xFFFFFFFFL.toDouble()) {
                return Color(n.toLong().toInt())
            }
            error("$what $v is not an ARGB number; black is used")
            return Color.Black
        }
        val shown = if (v is String) "\"$v\"" else v.toString()
        error("$what $shown is not an ARGB number (use core's draw helpers or parseColor); black is used")
        return Color.Black
    }

    private fun finite(v: Double, key: String): Float {
        val f = v.toFloat()
        if (!f.isFinite()) throw BadCommand("\"$key\" is not a finite number")
        return f
    }

    /** A required plain number. JSON.stringify turns NaN and Infinity into null, so they land here too. */
    private fun num(o: JSONObject, key: String): Float {
        val v = o.opt(key)
        if (v !is Number) throw BadCommand(if (v == null) "\"$key\" is missing" else "\"$key\" is not a finite number")
        return finite(v.toDouble(), key)
    }

    private fun px(o: JSONObject, key: String): Float = finite(num(o, key).toDouble() * d, key)

    /** A required number that may follow a motion value, times [scale] (density for positions, 1 for angles). */
    private fun numV(o: JSONObject, key: String, scale: Float = 1f): CNum {
        val v = o.opt(key)
        if (v is String && v.startsWith(MOTION_REF)) {
            val src = ZnMotion.ref(v)
            if (src == null) {
                error("\"$key\" follows motion value ${v.substring(MOTION_REF.length)}, which is gone; 0 is used")
                return CNum(0f, null, scale)
            }
            return CNum(0f, src, scale)
        }
        if (v !is Number) throw BadCommand(if (v == null) "\"$key\" is missing" else "\"$key\" is not a finite number")
        return CNum(finite(v.toDouble() * scale, key), null, scale)
    }

    private fun pxV(o: JSONObject, key: String): CNum = numV(o, key, d)

    /** Null when left out. */
    private fun optNumV(o: JSONObject, key: String, scale: Float = 1f): CNum? =
        if (o.has(key) && !o.isNull(key)) numV(o, key, scale) else null

    companion object {
        val ZERO = CNum.of(0f)
        val ONE = CNum.of(1f)
    }
}

/** Shapes with a shadow or a blur, through their own paint (DrawScope's calls can't do those). */
private fun DrawScope.drawFx(op: CanvasOp, p: CanvasPaint) {
    val c = drawContext.canvas
    when (op) {
        is CanvasOp.RectOp -> {
            val x = op.x.value
            val y = op.y.value
            val w = op.w.value
            val h = op.h.value
            c.drawRect(x, y, x + w, y + h, p.fxPaint(Size(w, h)))
        }
        is CanvasOp.RoundRectOp -> {
            val x = op.x.value
            val y = op.y.value
            val w = op.w.value
            val h = op.h.value
            val r = op.r.value
            c.drawRoundRect(x, y, x + w, y + h, r, r, p.fxPaint(Size(w, h)))
        }
        is CanvasOp.CircleOp -> {
            val r = op.r.value
            c.drawCircle(Offset(op.cx.value, op.cy.value), r, p.fxPaint(Size(r * 2, r * 2)))
        }
        is CanvasOp.OvalOp -> {
            val x = op.x.value
            val y = op.y.value
            val w = op.w.value
            val h = op.h.value
            c.drawOval(x, y, x + w, y + h, p.fxPaint(Size(w, h)))
        }
        is CanvasOp.LineOp -> c.drawLine(Offset(op.x1.value, op.y1.value), Offset(op.x2.value, op.y2.value), p.fxPaint(size))
        is CanvasOp.ArcOp -> {
            val x = op.x.value
            val y = op.y.value
            val w = op.w.value
            val h = op.h.value
            c.drawArc(x, y, x + w, y + h, op.start.value, op.sweep.value, op.useCenter, p.fxPaint(Size(w, h)))
        }
        else -> {}
    }
}

/** Draws [commands] (the body of the canvas's drawBehind). Throws only from Android; the caller catches. */
private fun DrawScope.drawCanvasOps(commands: CanvasCommands, d: Float, textPaint: AndroidPaint) {
    val canvas = drawContext.canvas
    for (op in commands.ops) {
        when (op) {
            is CanvasOp.RectOp -> {
                val p = op.paint
                if (p.hasFx) {
                    drawFx(op, p)
                    continue
                }
                val topLeft = Offset(op.x.value, op.y.value)
                val size = Size(op.w.value, op.h.value)
                val b = p.brush
                if (b != null) drawRect(brush = b, topLeft = topLeft, size = size, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
                else drawRect(color = p.color.value, topLeft = topLeft, size = size, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
            }
            is CanvasOp.RoundRectOp -> {
                val p = op.paint
                if (p.hasFx) {
                    drawFx(op, p)
                    continue
                }
                val topLeft = Offset(op.x.value, op.y.value)
                val size = Size(op.w.value, op.h.value)
                val r = op.r.value
                val cr = CornerRadius(r, r)
                val b = p.brush
                if (b != null) drawRoundRect(brush = b, topLeft = topLeft, size = size, cornerRadius = cr, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
                else drawRoundRect(color = p.color.value, topLeft = topLeft, size = size, cornerRadius = cr, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
            }
            is CanvasOp.CircleOp -> {
                val p = op.paint
                if (p.hasFx) {
                    drawFx(op, p)
                    continue
                }
                val center = Offset(op.cx.value, op.cy.value)
                val b = p.brush
                if (b != null) drawCircle(brush = b, radius = op.r.value, center = center, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
                else drawCircle(color = p.color.value, radius = op.r.value, center = center, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
            }
            is CanvasOp.OvalOp -> {
                val p = op.paint
                if (p.hasFx) {
                    drawFx(op, p)
                    continue
                }
                val topLeft = Offset(op.x.value, op.y.value)
                val size = Size(op.w.value, op.h.value)
                val b = p.brush
                if (b != null) drawOval(brush = b, topLeft = topLeft, size = size, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
                else drawOval(color = p.color.value, topLeft = topLeft, size = size, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
            }
            is CanvasOp.LineOp -> {
                val p = op.paint
                if (p.hasFx) {
                    drawFx(op, p)
                    continue
                }
                val start = Offset(op.x1.value, op.y1.value)
                val end = Offset(op.x2.value, op.y2.value)
                val b = p.brush
                if (b != null) drawLine(brush = b, start = start, end = end, strokeWidth = p.width(), cap = p.cap, pathEffect = p.pathEffect, alpha = p.alpha(), blendMode = p.blend)
                else drawLine(color = p.color.value, start = start, end = end, strokeWidth = p.width(), cap = p.cap, pathEffect = p.pathEffect, alpha = p.alpha(), blendMode = p.blend)
            }
            is CanvasOp.ArcOp -> {
                val p = op.paint
                if (p.hasFx) {
                    drawFx(op, p)
                    continue
                }
                val topLeft = Offset(op.x.value, op.y.value)
                val size = Size(op.w.value, op.h.value)
                val b = p.brush
                if (b != null) drawArc(brush = b, startAngle = op.start.value, sweepAngle = op.sweep.value, useCenter = op.useCenter, topLeft = topLeft, size = size, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
                else drawArc(color = p.color.value, startAngle = op.start.value, sweepAngle = op.sweep.value, useCenter = op.useCenter, topLeft = topLeft, size = size, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
            }
            is CanvasOp.PathOp -> {
                // Path data is in dp: drawn under scale(d). Its paint was built in dp too (scale 1f at parse).
                val path = op.visible() ?: continue
                val p = op.paint
                canvas.save()
                canvas.scale(d, d)
                val b = p.brush
                if (p.hasFx) canvas.drawPath(path, p.fxPaint(size))
                else if (b != null) drawPath(path = path, brush = b, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
                else drawPath(path = path, color = p.color.value, style = p.style(), alpha = p.alpha(), blendMode = p.blend)
                canvas.restore()
            }
            is CanvasOp.TextOp -> {
                textPaint.textSize = op.fontSize * d
                textPaint.color = op.color.value.toArgb()
                textPaint.textAlign = op.align
                textPaint.typeface = op.typeface
                canvas.nativeCanvas.drawText(op.text, op.x.value, op.y.value, textPaint)
            }
            is CanvasOp.ParagraphOp -> {
                val layout = op.layout
                op.paint.color = op.color.value.toArgb()
                canvas.save()
                canvas.translate(op.x.value, op.y.value)
                layout.draw(canvas.nativeCanvas)
                canvas.restore()
            }
            is CanvasOp.ImageOp -> {
                val bmp = op.bitmap ?: continue
                drawCanvasImage(op, bmp)
            }
            is CanvasOp.SaveOp -> canvas.save()
            // Parse drops a restore without a save; restoreToCount below closes saves left open.
            is CanvasOp.RestoreOp -> canvas.restore()
            is CanvasOp.TranslateOp -> canvas.translate(op.dx.value, op.dy.value)
            is CanvasOp.ScaleOp -> canvas.scale(op.sx.value, op.sy.value)
            is CanvasOp.RotateOp -> {
                val px = op.px.value
                val py = op.py.value
                if (px != 0f || py != 0f) {
                    canvas.translate(px, py)
                    canvas.rotate(op.degrees.value)
                    canvas.translate(-px, -py)
                } else {
                    canvas.rotate(op.degrees.value)
                }
            }
            is CanvasOp.ClipRectOp -> {
                val x = op.x.value
                val y = op.y.value
                canvas.clipRect(x, y, x + op.w.value, y + op.h.value, op.op)
            }
            is CanvasOp.ClipRoundRectOp -> {
                val x = op.x.value
                val y = op.y.value
                val r = op.r.value
                val p = op.path.asAndroidPath()
                p.reset()
                p.addRoundRect(x, y, x + op.w.value, y + op.h.value, r, r, android.graphics.Path.Direction.CW)
                canvas.clipPath(op.path, op.op)
            }
            is CanvasOp.ClipPathOp -> canvas.clipPath(op.path, op.op)
        }
    }
}

@Composable
internal fun ZnCanvas(s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    val rawJson = if (s.commandsSlot >= 0) inst.slot(s.commandsSlot).value as? String else s.commands
    val density = LocalDensity.current.density
    // Parsed once per change, not on every re-measure or draw.
    val commands = remember(rawJson, density) { parseCanvasCommands(rawJson, density) }
    val textPaint = remember {
        AndroidPaint().apply {
            isAntiAlias = true
        }
    }
    // One warning per command list (not per draw), naming each bad command's index. The same text again (a chart
    // that updates every 500 ms with the same mistake) is not logged again by this node. A warning, not a dev error:
    // the good commands still draw, and JS has warned already (second-opinions 197).
    val lastReported = remember { arrayOfNulls<String>(1) }
    LaunchedEffect(commands) {
        if (commands.errors.isNotEmpty()) {
            val text = commands.errors.joinToString("\n")
            if (text != lastReported[0]) {
                lastReported[0] = text
                Log.w("zn", "<Canvas> commands:\n$text")
            }
        }
    }
    // Images: loaded per command list, cancelled when the list changes or the node leaves (ZnCanvasImage.kt).
    // [loaded] is read in drawBehind, so a finished load redraws this canvas.
    val context = LocalContext.current
    val loaded = remember { mutableIntStateOf(0) }
    val kept = remember { HashMap<String, ImageBitmap>() }
    DisposableEffect(commands) {
        val loads = startCanvasImages(context, commands, kept) { loaded.intValue++ }
        onDispose { for (l in loads) l.dispose() }
    }

    Spacer(
        modifier = mod.drawBehind {
            loaded.intValue
            if (commands.failed || commands.ops.isEmpty()) return@drawBehind
            val canvas = drawContext.canvas
            // Everything this list does (transforms, clips, saves left open) is undone here, even after a throw.
            val count = canvas.nativeCanvas.save()
            // A blend mode mixes with what this canvas drew before, not with the screen behind it: "clear" must not
            // punch a hole through to the window. Costs one offscreen layer, only for lists that use one.
            if (commands.needsLayer) canvas.nativeCanvas.saveLayer(0f, 0f, size.width, size.height, null)
            try {
                drawCanvasOps(commands, density, textPaint)
            } catch (e: Exception) {
                // Safety net: a command list must never kill the app. Stop drawing this list and report once.
                // Posted, because rendererError writes Compose state, which must not happen inside a draw.
                commands.failed = true
                Handler(Looper.getMainLooper()).post { ZnRuntime.rendererError("<Canvas> draw failed; this canvas is left empty", e) }
            } finally {
                canvas.nativeCanvas.restoreToCount(count)
            }
        }
    )
}
