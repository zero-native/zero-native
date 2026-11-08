package dev.zeronative.runtime

import android.graphics.Paint as AndroidPaint
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawStyle
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.toPath
import androidx.compose.ui.platform.LocalDensity
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayList

// <Canvas> (registry 23): draws a command list from JS (core canvas.ts) in the draw phase only.
// Rules, so a bad list never crashes the app (ZeroBill takes payments on this runtime):
// - Everything is checked when the JSON is parsed: numbers must be finite, a gradient needs 2+ colours, a dash an even
//   length. A bad command is dropped (or drawn in a safe way) and named in one dev error per command list.
// - Colours come as ARGB numbers: core's parseColor turns them into numbers in JS. Native never parses colour strings
//   (android.graphics.Color.parseColor reads "#RRGGBBAA" as "#AARRGGBB"). A string is a dev error and draws black.
// - Brushes, strokes, dashes and paths are built once per command list, not on every draw.
// - The draw loop runs inside save / restoreToCount, so a transform or clip never moves this node's border or the
//   views after it. If drawing still throws, this canvas stops drawing and reports once.

internal const val MAX_CANVAS_COMMANDS = 10000

/** At most this many problems are listed in one dev error; the rest are counted. */
private const val MAX_LISTED_ERRORS = 10

/**
 * Paint for one command, in px (or dp for a path, which is drawn under scale(density)).
 * [brush] is built at parse time (pure Kotlin). [style] and [pathEffect] need Android classes, so they are built on the
 * first draw and then kept with this command list.
 */
internal class CanvasPaint(
    val color: Color,
    val opacity: Float,
    val brush: Brush?,
    val isStroke: Boolean,
    val strokeWidth: Float,
    val cap: StrokeCap,
    val join: StrokeJoin,
    val dash: FloatArray?,
) {
    val pathEffect: PathEffect? by lazy(LazyThreadSafetyMode.NONE) { dash?.let { PathEffect.dashPathEffect(it, 0f) } }
    val style: DrawStyle by lazy(LazyThreadSafetyMode.NONE) {
        if (isStroke) Stroke(width = strokeWidth, cap = cap, join = join, pathEffect = pathEffect) else Fill
    }
}

/** One parsed command. Positions and sizes are in px (dp × density), except a path's, which stay in dp. */
internal sealed class CanvasOp {
    class RectOp(val x: Float, val y: Float, val w: Float, val h: Float, val paint: CanvasPaint) : CanvasOp()
    class RoundRectOp(val x: Float, val y: Float, val w: Float, val h: Float, val r: Float, val paint: CanvasPaint) : CanvasOp()
    class CircleOp(val cx: Float, val cy: Float, val r: Float, val paint: CanvasPaint) : CanvasOp()
    class OvalOp(val x: Float, val y: Float, val w: Float, val h: Float, val paint: CanvasPaint) : CanvasOp()
    class LineOp(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val paint: CanvasPaint) : CanvasOp()
    class ArcOp(val x: Float, val y: Float, val w: Float, val h: Float, val start: Float, val sweep: Float, val useCenter: Boolean, val paint: CanvasPaint) : CanvasOp()

    /** Path data in dp; drawn under scale(density), so its paint is built with 1f (dp units). */
    class PathOp(val nodes: List<PathNode>, val paint: CanvasPaint) : CanvasOp() {
        val path: Path by lazy(LazyThreadSafetyMode.NONE) { nodes.toPath() }
    }

    /** [fontSize] in dp; [x] / [y] in px, [y] is the baseline. */
    class TextOp(val text: String, val x: Float, val y: Float, val fontSize: Float, val fontWeight: Int?, val color: Color, val align: AndroidPaint.Align) : CanvasOp() {
        val typeface: Typeface by lazy(LazyThreadSafetyMode.NONE) { canvasTypeface(fontWeight) }
    }

    class TranslateOp(val dx: Float, val dy: Float) : CanvasOp()
    class ScaleOp(val sx: Float, val sy: Float) : CanvasOp()
    class RotateOp(val degrees: Float, val px: Float, val py: Float) : CanvasOp()
    class ClipRectOp(val x: Float, val y: Float, val w: Float, val h: Float) : CanvasOp()
    object SaveOp : CanvasOp()
    object RestoreOp : CanvasOp()
}

/** A parsed command list: what to draw, and the problems found (empty when all is well). */
internal class CanvasCommands(val ops: List<CanvasOp>, val errors: List<String>) {
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
        return CanvasCommands(ops, errors)
    }

    private fun command(o: JSONObject): CanvasOp {
        return when (val type = o.optString("type")) {
            "rect" -> CanvasOp.RectOp(px(o, "x"), px(o, "y"), px(o, "w"), px(o, "h"), paint(o, d))
            "roundRect" -> CanvasOp.RoundRectOp(px(o, "x"), px(o, "y"), px(o, "w"), px(o, "h"), px(o, "r"), paint(o, d))
            "circle" -> CanvasOp.CircleOp(px(o, "cx"), px(o, "cy"), px(o, "r"), paint(o, d))
            "oval" -> CanvasOp.OvalOp(px(o, "x"), px(o, "y"), px(o, "w"), px(o, "h"), paint(o, d))
            "line" -> CanvasOp.LineOp(px(o, "x1"), px(o, "y1"), px(o, "x2"), px(o, "y2"), paint(o, d))
            "arc" -> CanvasOp.ArcOp(
                px(o, "x"), px(o, "y"), px(o, "w"), px(o, "h"),
                num(o, "start"), num(o, "sweep"), o.optBoolean("useCenter", false), paint(o, d),
            )
            "path" -> {
                val data = o.opt("d") as? String ?: throw BadCommand("\"d\" must be a string")
                val nodes = pathParser.pathStringToNodes(data, ArrayList())
                // Drawn under scale(density): the paint is in dp, so its gradient and stroke are not scaled twice.
                CanvasOp.PathOp(nodes, paint(o, 1f))
            }
            "text" -> text(o)
            "save" -> CanvasOp.SaveOp
            "restore" -> CanvasOp.RestoreOp
            "translate" -> CanvasOp.TranslateOp(px(o, "dx"), px(o, "dy"))
            "scale" -> {
                val sx = num(o, "sx")
                CanvasOp.ScaleOp(sx, if (o.has("sy") && !o.isNull("sy")) num(o, "sy") else sx)
            }
            "rotate" -> CanvasOp.RotateOp(num(o, "degrees"), optPx(o, "px", 0f), optPx(o, "py", 0f))
            "clipRect" -> CanvasOp.ClipRectOp(px(o, "x"), px(o, "y"), px(o, "w"), px(o, "h"))
            "" -> throw BadCommand("no \"type\"")
            else -> throw BadCommand("unknown type \"$type\"")
        }
    }

    private fun text(o: JSONObject): CanvasOp.TextOp {
        val content = o.opt("text")
        val text = if (content is String) content else if (content is Number) content.toString() else throw BadCommand("\"text\" must be a string")
        val opts = o.optJSONObject("options")
        val fontSize = if (opts != null && opts.has("fontSize") && !opts.isNull("fontSize")) num(opts, "fontSize") else 14f
        if (fontSize <= 0f) throw BadCommand("\"fontSize\" must be above 0")
        val weight = when (val fw = opts?.opt("fontWeight")) {
            null, JSONObject.NULL, "normal" -> null
            "bold" -> 700
            is Number -> finite(fw.toDouble(), "fontWeight").toInt().coerceIn(1, 1000)
            is String -> fw.toIntOrNull()?.coerceIn(1, 1000) ?: run { error("fontWeight \"$fw\" is not known; normal is used"); null }
            else -> null
        }
        val align = when (opts?.optString("align")) {
            "center" -> AndroidPaint.Align.CENTER
            "right" -> AndroidPaint.Align.RIGHT
            else -> AndroidPaint.Align.LEFT
        }
        return CanvasOp.TextOp(text, px(o, "x"), px(o, "y"), fontSize, weight, color(opts, "color", Color.Black), align)
    }

    /** [scale] is px per unit of this command: density, or 1f for a path (drawn under scale(density)). */
    private fun paint(command: JSONObject, scale: Float): CanvasPaint {
        // The same minimum stroke width everywhere: 1 px, which is scale / d units.
        val minWidth = scale / d
        val o = command.optJSONObject("paint")
            ?: return CanvasPaint(Color.Black, 1f, null, false, minWidth, StrokeCap.Butt, StrokeJoin.Miter, null)
        var color = color(o, "color", Color.Black)
        val isStroke = o.optString("style") == "stroke"
        val width = if (o.has("strokeWidth") && !o.isNull("strokeWidth")) num(o, "strokeWidth") * scale else minWidth
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
        val opacity = if (o.has("opacity") && !o.isNull("opacity")) num(o, "opacity").coerceIn(0f, 1f) else 1f
        val dash = dash(o.opt("dash"), scale)

        var brush: Brush? = null
        val lin = o.optJSONObject("linearGradient")
        val rad = o.optJSONObject("radialGradient")
        if (lin != null) {
            val g = gradient(lin, "linearGradient")
            if (g.colors.size < 2) {
                if (g.colors.size == 1) color = g.colors[0]
            } else {
                val start = Offset(finite(num(lin, "x0").toDouble() * scale, "x0"), finite(num(lin, "y0").toDouble() * scale, "y0"))
                val end = Offset(finite(num(lin, "x1").toDouble() * scale, "x1"), finite(num(lin, "y1").toDouble() * scale, "y1"))
                brush = if (g.stops != null) Brush.linearGradient(colorStops = g.stops, start = start, end = end)
                else Brush.linearGradient(colors = g.colors, start = start, end = end)
            }
        } else if (rad != null) {
            val g = gradient(rad, "radialGradient")
            if (g.colors.size < 2) {
                if (g.colors.size == 1) color = g.colors[0]
            } else {
                val center = Offset(finite(num(rad, "cx").toDouble() * scale, "cx"), finite(num(rad, "cy").toDouble() * scale, "cy"))
                val radius = finite(num(rad, "r").toDouble() * scale, "r").coerceAtLeast(0.1f)
                brush = if (g.stops != null) Brush.radialGradient(colorStops = g.stops, center = center, radius = radius)
                else Brush.radialGradient(colors = g.colors, center = center, radius = radius)
            }
        }
        return CanvasPaint(color, opacity, brush, isStroke, finite(width.toDouble(), "strokeWidth").coerceAtLeast(minWidth), cap, join, dash)
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

    private fun color(o: JSONObject?, key: String, fallback: Color): Color {
        if (o == null || !o.has(key) || o.isNull(key)) return fallback
        return colorValue(o.opt(key), key)
    }

    /** An ARGB number (core parseColor). A string is a dev error and black: native never parses colour strings. */
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

    /** A required number. JSON.stringify turns NaN and Infinity into null, so they land here too. */
    private fun num(o: JSONObject, key: String): Float {
        val v = o.opt(key)
        if (v !is Number) throw BadCommand(if (v == null) "\"$key\" is missing" else "\"$key\" is not a finite number")
        return finite(v.toDouble(), key)
    }

    private fun px(o: JSONObject, key: String): Float = finite(num(o, key).toDouble() * d, key)

    private fun optPx(o: JSONObject, key: String, fallback: Float): Float =
        if (o.has(key) && !o.isNull(key)) px(o, key) else fallback
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
    // One dev error per command list (not per draw), naming each bad command's index. The same text again (a chart
    // that updates every 500 ms with the same mistake) is not reported again by this node.
    val lastReported = remember { arrayOfNulls<String>(1) }
    LaunchedEffect(commands) {
        if (commands.errors.isNotEmpty()) {
            val text = commands.errors.joinToString("\n")
            if (text != lastReported[0]) {
                lastReported[0] = text
                ZnRuntime.rendererError("<Canvas> commands", IllegalArgumentException(text))
            }
        }
    }

    Spacer(
        modifier = mod.drawBehind {
            if (commands.failed || commands.ops.isEmpty()) return@drawBehind
            val d = density
            val canvas = drawContext.canvas
            // Everything this list does (transforms, clips, saves left open) is undone here, even after a throw.
            val count = canvas.nativeCanvas.save()
            try {
                for (op in commands.ops) {
                    when (op) {
                        is CanvasOp.RectOp -> {
                            val p = op.paint
                            val topLeft = Offset(op.x, op.y)
                            val size = Size(op.w, op.h)
                            if (p.brush != null) drawRect(brush = p.brush, topLeft = topLeft, size = size, style = p.style, alpha = p.opacity)
                            else drawRect(color = p.color, topLeft = topLeft, size = size, style = p.style, alpha = p.opacity)
                        }
                        is CanvasOp.RoundRectOp -> {
                            val p = op.paint
                            val topLeft = Offset(op.x, op.y)
                            val size = Size(op.w, op.h)
                            val cr = CornerRadius(op.r, op.r)
                            if (p.brush != null) drawRoundRect(brush = p.brush, topLeft = topLeft, size = size, cornerRadius = cr, style = p.style, alpha = p.opacity)
                            else drawRoundRect(color = p.color, topLeft = topLeft, size = size, cornerRadius = cr, style = p.style, alpha = p.opacity)
                        }
                        is CanvasOp.CircleOp -> {
                            val p = op.paint
                            val center = Offset(op.cx, op.cy)
                            if (p.brush != null) drawCircle(brush = p.brush, radius = op.r, center = center, style = p.style, alpha = p.opacity)
                            else drawCircle(color = p.color, radius = op.r, center = center, style = p.style, alpha = p.opacity)
                        }
                        is CanvasOp.OvalOp -> {
                            val p = op.paint
                            val topLeft = Offset(op.x, op.y)
                            val size = Size(op.w, op.h)
                            if (p.brush != null) drawOval(brush = p.brush, topLeft = topLeft, size = size, style = p.style, alpha = p.opacity)
                            else drawOval(color = p.color, topLeft = topLeft, size = size, style = p.style, alpha = p.opacity)
                        }
                        is CanvasOp.LineOp -> {
                            val p = op.paint
                            val start = Offset(op.x1, op.y1)
                            val end = Offset(op.x2, op.y2)
                            if (p.brush != null) drawLine(brush = p.brush, start = start, end = end, strokeWidth = p.strokeWidth, cap = p.cap, pathEffect = p.pathEffect, alpha = p.opacity)
                            else drawLine(color = p.color, start = start, end = end, strokeWidth = p.strokeWidth, cap = p.cap, pathEffect = p.pathEffect, alpha = p.opacity)
                        }
                        is CanvasOp.ArcOp -> {
                            val p = op.paint
                            val topLeft = Offset(op.x, op.y)
                            val size = Size(op.w, op.h)
                            if (p.brush != null) drawArc(brush = p.brush, startAngle = op.start, sweepAngle = op.sweep, useCenter = op.useCenter, topLeft = topLeft, size = size, style = p.style, alpha = p.opacity)
                            else drawArc(color = p.color, startAngle = op.start, sweepAngle = op.sweep, useCenter = op.useCenter, topLeft = topLeft, size = size, style = p.style, alpha = p.opacity)
                        }
                        is CanvasOp.PathOp -> {
                            // Path data is in dp: drawn under scale(d). Its paint was built in dp too (scale 1f at parse).
                            val p = op.paint
                            canvas.save()
                            canvas.scale(d, d)
                            if (p.brush != null) drawPath(path = op.path, brush = p.brush, style = p.style, alpha = p.opacity)
                            else drawPath(path = op.path, color = p.color, style = p.style, alpha = p.opacity)
                            canvas.restore()
                        }
                        is CanvasOp.TextOp -> {
                            textPaint.textSize = op.fontSize * d
                            textPaint.color = op.color.toArgb()
                            textPaint.textAlign = op.align
                            textPaint.typeface = op.typeface
                            canvas.nativeCanvas.drawText(op.text, op.x, op.y, textPaint)
                        }
                        is CanvasOp.SaveOp -> canvas.save()
                        // Parse drops a restore without a save; restoreToCount below closes saves left open.
                        is CanvasOp.RestoreOp -> canvas.restore()
                        is CanvasOp.TranslateOp -> canvas.translate(op.dx, op.dy)
                        is CanvasOp.ScaleOp -> canvas.scale(op.sx, op.sy)
                        is CanvasOp.RotateOp -> {
                            if (op.px != 0f || op.py != 0f) {
                                canvas.translate(op.px, op.py)
                                canvas.rotate(op.degrees)
                                canvas.translate(-op.px, -op.py)
                            } else {
                                canvas.rotate(op.degrees)
                            }
                        }
                        is CanvasOp.ClipRectOp -> canvas.clipRect(op.x, op.y, op.x + op.w, op.y + op.h)
                    }
                }
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
