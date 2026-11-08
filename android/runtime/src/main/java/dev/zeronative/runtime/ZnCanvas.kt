package dev.zeronative.runtime

import android.graphics.Paint as AndroidPaint
import android.graphics.Typeface
import android.util.Log
import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.toPath
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayList

private const val MAX_CANVAS_COMMANDS = 10000

private fun logError(message: String) {
    try {
        Log.e("zn", message)
    } catch (_: Throwable) {
        // In JVM unit tests, android.util.Log may not be mocked
        System.err.println("zn: $message")
    }
}

internal class LinearGradSpec(
    val x0: Float,
    val y0: Float,
    val x1: Float,
    val y1: Float,
    val colors: List<Color>,
    val stops: List<Float>?,
)

internal class RadialGradSpec(
    val cx: Float,
    val cy: Float,
    val r: Float,
    val colors: List<Color>,
    val stops: List<Float>?,
)

internal class ParsedPaint(
    val color: Color = Color.Black,
    val isStroke: Boolean = false,
    val strokeWidth: Float = 1f,
    val strokeCap: StrokeCap = StrokeCap.Butt,
    val strokeJoin: StrokeJoin = StrokeJoin.Miter,
    val dash: FloatArray? = null,
    val opacity: Float = 1f,
    val linearGrad: LinearGradSpec? = null,
    val radialGrad: RadialGradSpec? = null,
) {
    fun toDrawStyle(density: Float): androidx.compose.ui.graphics.drawscope.DrawStyle =
        if (isStroke) {
            val pe = if (dash != null && dash.isNotEmpty()) {
                val scaled = FloatArray(dash.size) { dash[it] * density }
                PathEffect.dashPathEffect(scaled, 0f)
            } else null
            Stroke(width = (strokeWidth * density).coerceAtLeast(1f), cap = strokeCap, join = strokeJoin, pathEffect = pe)
        } else {
            Fill
        }

    fun toBrush(density: Float): Brush? = when {
        linearGrad != null -> {
            val start = Offset(linearGrad.x0 * density, linearGrad.y0 * density)
            val end = Offset(linearGrad.x1 * density, linearGrad.y1 * density)
            if (linearGrad.stops != null && linearGrad.stops.size == linearGrad.colors.size) {
                Brush.linearGradient(colorStops = linearGrad.stops.mapIndexed { idx, s -> s to linearGrad.colors[idx] }.toTypedArray(), start = start, end = end)
            } else {
                Brush.linearGradient(colors = linearGrad.colors, start = start, end = end)
            }
        }
        radialGrad != null -> {
            val center = Offset(radialGrad.cx * density, radialGrad.cy * density)
            val radius = (radialGrad.r * density).coerceAtLeast(0.1f)
            if (radialGrad.stops != null && radialGrad.stops.size == radialGrad.colors.size) {
                Brush.radialGradient(colorStops = radialGrad.stops.mapIndexed { idx, s -> s to radialGrad.colors[idx] }.toTypedArray(), center = center, radius = radius)
            } else {
                Brush.radialGradient(colors = radialGrad.colors, center = center, radius = radius)
            }
        }
        else -> null
    }
}

internal sealed class CanvasOp {
    data class RectOp(val x: Float, val y: Float, val w: Float, val h: Float, val paint: ParsedPaint) : CanvasOp()
    data class RoundRectOp(val x: Float, val y: Float, val w: Float, val h: Float, val r: Float, val paint: ParsedPaint) : CanvasOp()
    data class CircleOp(val cx: Float, val cy: Float, val r: Float, val paint: ParsedPaint) : CanvasOp()
    data class OvalOp(val x: Float, val y: Float, val w: Float, val h: Float, val paint: ParsedPaint) : CanvasOp()
    data class LineOp(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val paint: ParsedPaint) : CanvasOp()
    data class ArcOp(val x: Float, val y: Float, val w: Float, val h: Float, val start: Float, val sweep: Float, val useCenter: Boolean, val paint: ParsedPaint) : CanvasOp()
    data class PathOp(val path: Path, val paint: ParsedPaint) : CanvasOp()
    data class TextOp(val text: String, val x: Float, val y: Float, val fontSize: Float, val fontWeight: FontWeight?, val color: Color, val align: AndroidPaint.Align) : CanvasOp()
    data class TranslateOp(val dx: Float, val dy: Float) : CanvasOp()
    data class ScaleOp(val sx: Float, val sy: Float) : CanvasOp()
    data class RotateOp(val degrees: Float, val px: Float, val py: Float) : CanvasOp()
    data class ClipRectOp(val x: Float, val y: Float, val w: Float, val h: Float) : CanvasOp()
    object SaveOp : CanvasOp()
    object RestoreOp : CanvasOp()
}

internal fun parseCanvasCommands(json: String?): List<CanvasOp> {
    if (json.isNullOrEmpty() || json == "[]" || json == "null") return emptyList()
    val array = try {
        JSONArray(json)
    } catch (e: Exception) {
        logError("Canvas: invalid JSON commands: ${e.message}")
        return emptyList()
    }
    if (array.length() > MAX_CANVAS_COMMANDS) {
        logError("Canvas: command count ${array.length()} exceeds limit of $MAX_CANVAS_COMMANDS; drawing skipped")
        return emptyList()
    }

    val pathParser = PathParser()
    val ops = ArrayList<CanvasOp>(array.length())
    for (i in 0 until array.length()) {
        try {
            val obj = array.getJSONObject(i)
            val type = obj.optString("type")
            when (type) {
                "rect" -> {
                    val p = parsePaint(obj.optJSONObject("paint"))
                    ops.add(CanvasOp.RectOp(obj.getDouble("x").toFloat(), obj.getDouble("y").toFloat(), obj.getDouble("w").toFloat(), obj.getDouble("h").toFloat(), p))
                }
                "roundRect" -> {
                    val p = parsePaint(obj.optJSONObject("paint"))
                    ops.add(CanvasOp.RoundRectOp(obj.getDouble("x").toFloat(), obj.getDouble("y").toFloat(), obj.getDouble("w").toFloat(), obj.getDouble("h").toFloat(), obj.getDouble("r").toFloat(), p))
                }
                "circle" -> {
                    val p = parsePaint(obj.optJSONObject("paint"))
                    ops.add(CanvasOp.CircleOp(obj.getDouble("cx").toFloat(), obj.getDouble("cy").toFloat(), obj.getDouble("r").toFloat(), p))
                }
                "oval" -> {
                    val p = parsePaint(obj.optJSONObject("paint"))
                    ops.add(CanvasOp.OvalOp(obj.getDouble("x").toFloat(), obj.getDouble("y").toFloat(), obj.getDouble("w").toFloat(), obj.getDouble("h").toFloat(), p))
                }
                "line" -> {
                    val p = parsePaint(obj.optJSONObject("paint"))
                    ops.add(CanvasOp.LineOp(obj.getDouble("x1").toFloat(), obj.getDouble("y1").toFloat(), obj.getDouble("x2").toFloat(), obj.getDouble("y2").toFloat(), p))
                }
                "arc" -> {
                    val p = parsePaint(obj.optJSONObject("paint"))
                    ops.add(CanvasOp.ArcOp(obj.getDouble("x").toFloat(), obj.getDouble("y").toFloat(), obj.getDouble("w").toFloat(), obj.getDouble("h").toFloat(), obj.getDouble("start").toFloat(), obj.getDouble("sweep").toFloat(), obj.optBoolean("useCenter", false), p))
                }
                "path" -> {
                    val p = parsePaint(obj.optJSONObject("paint"))
                    val d = obj.getString("d")
                    val path = pathParser.pathStringToNodes(d, ArrayList()).toPath()
                    ops.add(CanvasOp.PathOp(path, p))
                }
                "text" -> {
                    val text = obj.getString("text")
                    val x = obj.getDouble("x").toFloat()
                    val y = obj.getDouble("y").toFloat()
                    val opts = obj.optJSONObject("options")
                    val fontSize = opts?.optDouble("fontSize", 14.0)?.toFloat() ?: 14f
                    val color = opts?.optString("color")?.let(::parseColor) ?: Color.Black
                    val weight = when (val fw = opts?.opt("fontWeight")) {
                        "bold" -> FontWeight.Bold
                        is Number -> FontWeight(fw.toInt().coerceIn(1, 1000))
                        else -> null
                    }
                    val align = when (opts?.optString("align")) {
                        "center" -> AndroidPaint.Align.CENTER
                        "right" -> AndroidPaint.Align.RIGHT
                        else -> AndroidPaint.Align.LEFT
                    }
                    ops.add(CanvasOp.TextOp(text, x, y, fontSize, weight, color, align))
                }
                "save" -> ops.add(CanvasOp.SaveOp)
                "restore" -> ops.add(CanvasOp.RestoreOp)
                "translate" -> ops.add(CanvasOp.TranslateOp(obj.getDouble("dx").toFloat(), obj.getDouble("dy").toFloat()))
                "scale" -> ops.add(CanvasOp.ScaleOp(obj.getDouble("sx").toFloat(), obj.optDouble("sy", obj.getDouble("sx")).toFloat()))
                "rotate" -> ops.add(CanvasOp.RotateOp(obj.getDouble("degrees").toFloat(), obj.optDouble("px", 0.0).toFloat(), obj.optDouble("py", 0.0).toFloat()))
                "clipRect" -> ops.add(CanvasOp.ClipRectOp(obj.getDouble("x").toFloat(), obj.getDouble("y").toFloat(), obj.getDouble("w").toFloat(), obj.getDouble("h").toFloat()))
                else -> logError("Canvas: unknown command type '$type' at index $i")
            }
        } catch (e: Exception) {
            logError("Canvas: bad command at index $i: ${e.message}")
        }
    }
    return ops
}

private fun parsePaint(obj: JSONObject?): ParsedPaint {
    if (obj == null) return ParsedPaint()
    val col = if (obj.has("color")) parseColor(obj.getString("color")) ?: Color.Black else Color.Black
    val isStroke = obj.optString("style") == "stroke"
    val sw = obj.optDouble("strokeWidth", 1.0).toFloat()
    val cap = when (obj.optString("strokeCap")) {
        "round" -> StrokeCap.Round
        "square" -> StrokeCap.Square
        else -> StrokeCap.Butt
    }
    val join = when (obj.optString("strokeJoin")) {
        "round" -> StrokeJoin.Round
        "bevel" -> StrokeJoin.Bevel
        else -> StrokeJoin.Miter
    }
    val dashArr = obj.optJSONArray("dash")?.let { arr ->
        FloatArray(arr.length()) { idx -> arr.optDouble(idx, 0.0).toFloat() }
    }
    val opacity = obj.optDouble("opacity", 1.0).toFloat().coerceIn(0f, 1f)

    val lin = obj.optJSONObject("linearGradient")?.let { l ->
        val colors = parseColors(l.optJSONArray("colors"))
        val stops = parseStops(l.optJSONArray("stops"))
        LinearGradSpec(l.getDouble("x0").toFloat(), l.getDouble("y0").toFloat(), l.getDouble("x1").toFloat(), l.getDouble("y1").toFloat(), colors, stops)
    }
    val rad = obj.optJSONObject("radialGradient")?.let { r ->
        val colors = parseColors(r.optJSONArray("colors"))
        val stops = parseStops(r.optJSONArray("stops"))
        RadialGradSpec(r.getDouble("cx").toFloat(), r.getDouble("cy").toFloat(), r.getDouble("r").toFloat(), colors, stops)
    }
    return ParsedPaint(
        color = col,
        isStroke = isStroke,
        strokeWidth = sw,
        strokeCap = cap,
        strokeJoin = join,
        dash = dashArr,
        opacity = opacity,
        linearGrad = lin,
        radialGrad = rad,
    )
}

private fun parseColors(arr: JSONArray?): List<Color> {
    if (arr == null || arr.length() == 0) return listOf(Color.Black, Color.White)
    val list = ArrayList<Color>(arr.length())
    for (i in 0 until arr.length()) {
        list.add(parseColor(arr.optString(i)) ?: Color.Black)
    }
    return list
}

private fun parseStops(arr: JSONArray?): List<Float>? {
    if (arr == null || arr.length() == 0) return null
    val list = ArrayList<Float>(arr.length())
    for (i in 0 until arr.length()) {
        list.add(arr.optDouble(i, 0.0).toFloat())
    }
    return list
}

private fun parseColor(s: String?): Color? {
    if (s.isNullOrEmpty()) return null
    return try {
        Color(android.graphics.Color.parseColor(s))
    } catch (_: Exception) {
        toColor(s)
    }
}

@Composable
internal fun ZnCanvas(s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    val rawJson = if (s.commandsSlot >= 0) inst.slot(s.commandsSlot).value as? String else s.commands
    val density = LocalDensity.current.density
    val textPaint = remember {
        AndroidPaint().apply {
            isAntiAlias = true
        }
    }

    Spacer(
        modifier = mod.drawWithCache {
            val ops = parseCanvasCommands(rawJson)
            onDrawBehind {
                val d = density
                var saves = 0
                for (op in ops) {
                    when (op) {
                        is CanvasOp.RectOp -> {
                            val topLeft = Offset(op.x * d, op.y * d)
                            val size = Size(op.w * d, op.h * d)
                            val brush = op.paint.toBrush(d)
                            if (brush != null) {
                                drawRect(brush = brush, topLeft = topLeft, size = size, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            } else {
                                drawRect(color = op.paint.color, topLeft = topLeft, size = size, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            }
                        }
                        is CanvasOp.RoundRectOp -> {
                            val topLeft = Offset(op.x * d, op.y * d)
                            val size = Size(op.w * d, op.h * d)
                            val brush = op.paint.toBrush(d)
                            val cr = CornerRadius(op.r * d, op.r * d)
                            if (brush != null) {
                                drawRoundRect(brush = brush, topLeft = topLeft, size = size, cornerRadius = cr, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            } else {
                                drawRoundRect(color = op.paint.color, topLeft = topLeft, size = size, cornerRadius = cr, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            }
                        }
                        is CanvasOp.CircleOp -> {
                            val center = Offset(op.cx * d, op.cy * d)
                            val radius = op.r * d
                            val brush = op.paint.toBrush(d)
                            if (brush != null) {
                                drawCircle(brush = brush, radius = radius, center = center, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            } else {
                                drawCircle(color = op.paint.color, radius = radius, center = center, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            }
                        }
                        is CanvasOp.OvalOp -> {
                            val topLeft = Offset(op.x * d, op.y * d)
                            val size = Size(op.w * d, op.h * d)
                            val brush = op.paint.toBrush(d)
                            if (brush != null) {
                                drawOval(brush = brush, topLeft = topLeft, size = size, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            } else {
                                drawOval(color = op.paint.color, topLeft = topLeft, size = size, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            }
                        }
                        is CanvasOp.LineOp -> {
                            val start = Offset(op.x1 * d, op.y1 * d)
                            val end = Offset(op.x2 * d, op.y2 * d)
                            val brush = op.paint.toBrush(d)
                            val pe = if (op.paint.dash != null && op.paint.dash.isNotEmpty()) {
                                PathEffect.dashPathEffect(FloatArray(op.paint.dash.size) { op.paint.dash[it] * d }, 0f)
                            } else null
                            if (brush != null) {
                                drawLine(brush = brush, start = start, end = end, strokeWidth = (op.paint.strokeWidth * d).coerceAtLeast(1f), cap = op.paint.strokeCap, pathEffect = pe, alpha = op.paint.opacity)
                            } else {
                                drawLine(color = op.paint.color, start = start, end = end, strokeWidth = (op.paint.strokeWidth * d).coerceAtLeast(1f), cap = op.paint.strokeCap, pathEffect = pe, alpha = op.paint.opacity)
                            }
                        }
                        is CanvasOp.ArcOp -> {
                            val topLeft = Offset(op.x * d, op.y * d)
                            val size = Size(op.w * d, op.h * d)
                            val brush = op.paint.toBrush(d)
                            if (brush != null) {
                                drawArc(brush = brush, startAngle = op.start, sweepAngle = op.sweep, useCenter = op.useCenter, topLeft = topLeft, size = size, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            } else {
                                drawArc(color = op.paint.color, startAngle = op.start, sweepAngle = op.sweep, useCenter = op.useCenter, topLeft = topLeft, size = size, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                            }
                        }
                        is CanvasOp.PathOp -> {
                            val brush = op.paint.toBrush(d)
                            val scaledPath = Path().apply {
                                addPath(op.path)
                            }
                            if (d != 1f) {
                                drawContext.canvas.save()
                                drawContext.canvas.scale(d, d)
                                if (brush != null) {
                                    drawPath(path = op.path, brush = brush, style = op.paint.toDrawStyle(1f), alpha = op.paint.opacity)
                                } else {
                                    drawPath(path = op.path, color = op.paint.color, style = op.paint.toDrawStyle(1f), alpha = op.paint.opacity)
                                }
                                drawContext.canvas.restore()
                            } else {
                                if (brush != null) {
                                    drawPath(path = op.path, brush = brush, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                                } else {
                                    drawPath(path = op.path, color = op.paint.color, style = op.paint.toDrawStyle(d), alpha = op.paint.opacity)
                                }
                            }
                        }
                        is CanvasOp.TextOp -> {
                            textPaint.textSize = op.fontSize * d
                            textPaint.color = op.color.toArgb()
                            textPaint.textAlign = op.align
                            textPaint.typeface = if (op.fontWeight == FontWeight.Bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                            drawContext.canvas.nativeCanvas.drawText(op.text, op.x * d, op.y * d, textPaint)
                        }
                        is CanvasOp.SaveOp -> {
                            drawContext.canvas.save()
                            saves++
                        }
                        is CanvasOp.RestoreOp -> {
                            if (saves > 0) {
                                drawContext.canvas.restore()
                                saves--
                            }
                        }
                        is CanvasOp.TranslateOp -> {
                            drawContext.canvas.translate(op.dx * d, op.dy * d)
                        }
                        is CanvasOp.ScaleOp -> {
                            drawContext.canvas.scale(op.sx, op.sy)
                        }
                        is CanvasOp.RotateOp -> {
                            if (op.px != 0f || op.py != 0f) {
                                drawContext.canvas.translate(op.px * d, op.py * d)
                                drawContext.canvas.rotate(op.degrees)
                                drawContext.canvas.translate(-op.px * d, -op.py * d)
                            } else {
                                drawContext.canvas.rotate(op.degrees)
                            }
                        }
                        is CanvasOp.ClipRectOp -> {
                            drawContext.canvas.clipRect(op.x * d, op.y * d, (op.x + op.w) * d, (op.y + op.h) * d)
                        }
                    }
                }
                while (saves > 0) {
                    drawContext.canvas.restore()
                    saves--
                }
            }
        }
    )
}
