package dev.zeronative.runtime

import android.util.Log
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Matrix
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asAndroidPath
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.DrawStyle
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.toPath
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp

// SVG on the phone (docs/svg.md §8). Two steps:
// 1. ZnSvgReader reads the compiler's draw data (format v1, compiler/src/svg-data.ts) into plain data (ZnSvgData).
//    No Android classes, so unit tests run it on the JVM.
// 2. ZnSvgDrawing turns that into Compose Paths, Strokes and brushes once, and draws them in a DrawScope.

// Paint kinds (SvgShape.fillKind / strokeKind). The value is the ARGB colour or the gradient number.
internal const val SVG_PAINT_NONE = 0
internal const val SVG_PAINT_CURRENT = 1
internal const val SVG_PAINT_COLOR = 2
internal const val SVG_PAINT_GRADIENT = 3

/** aspect = 18: preserveAspectRatio="none" (stretch). */
private const val ASPECT_NONE = 18

/** A path: its SVG path data read into Compose's commands (plain data, no Android Path yet). */
internal class SvgPath(val nodes: List<PathNode>)

/** A gradient. coords: x1 y1 x2 y2 (linear) or cx cy r (radial). matrix: a b c d e f, or null (identity). */
internal class SvgGradient(
    val radial: Boolean,
    val coords: FloatArray,
    val spread: Int,
    val matrix: FloatArray?,
    val offsets: FloatArray,
    val colors: IntArray,
)

/** A clip: the union of its paths, each with its own fill rule (0 nonzero, 1 evenodd). */
internal class SvgClip(val rules: IntArray, val paths: Array<SvgPath>)

/** A stroke. dashes: null when solid. */
internal class SvgStroke(
    val width: Float,
    val cap: Int,
    val join: Int,
    val miter: Float,
    val dashes: FloatArray?,
    val dashOffset: Float,
)

/** One op of the draw list. [part]: its index for <SvgPart part={i}> (G and S ops, counted from 0, in order). */
internal sealed class SvgOp(val part: Int)

/** "G": a group starts. [end]: the index of its "g" in the op list. clip: a clip number, or -1. */
internal class SvgGroup(part: Int, val opacity: Float, val clip: Int) : SvgOp(part) {
    var end = -1
        internal set
}

/** "g": the group ends. */
internal object SvgGroupEnd : SvgOp(-1)

/** "S": a shape. [index]: its number among the shapes (its path is ZnSvgData.paths[index]). */
internal class SvgShape(
    part: Int,
    val index: Int,
    val fillKind: Int,
    val fill: Int,
    val fillAlpha: Float,
    val strokeKind: Int,
    val stroke: Int,
    val strokeAlpha: Float,
    val rule: Int,
    val opacity: Float,
    val strokeSpec: SvgStroke?,
    val matrix: FloatArray?,
) : SvgOp(part)

/** One SVG's draw data, read but not yet turned into Compose objects. */
internal class ZnSvgData(
    val vx: Float,
    val vy: Float,
    val vw: Float,
    val vh: Float,
    val aspect: Int,
    val gradients: Array<SvgGradient>,
    val clips: Array<SvgClip>,
    val ops: Array<SvgOp>,
    /** One path per shape, in order (SvgShape.index). */
    val paths: Array<SvgPath>,
    /** How deep groups nest (0: no groups). */
    val maxDepth: Int,
)

/** Draw data that doesn't follow format v1. The compiler made it, so this means a bug or a damaged bundle. */
internal class ZnSvgFormatException(message: String) : IllegalArgumentException(message)

internal object ZnSvgReader {
    /** Reads draw data [text]. Throws [ZnSvgFormatException] when it is not valid format v1. */
    fun read(text: String): ZnSvgData = SvgScanner(text).read()

    /** Like [read], but never throws: a bad string gives null and one call to [onError]. */
    fun readOrNull(text: String, onError: (String) -> Unit): ZnSvgData? = try {
        read(text)
    } catch (e: RuntimeException) { // ZnSvgFormatException, or a bug in this reader: never crash the app for an SVG
        onError(e.message ?: e.toString())
        null
    }
}

/**
 * Reads format v1 in one pass over the characters. Numbers are scanned by hand (no regex, no split, no String per
 * token). Tokens are separated by exactly one space. Path data (one token up to ";") goes to Compose's PathParser.
 */
private class SvgScanner(private val s: String) {
    private var i = 0
    private val n = s.length
    private val pathParser = PathParser() // reused: pathStringToNodes gives a new list each time

    // The last paint read by paint().
    private var paintKind = SVG_PAINT_NONE
    private var paintValue = 0

    fun read(): ZnSvgData {
        if (n == 0) fail("empty draw data")
        if (!word2('Z', '1')) fail("draw data must start with Z1 (format v1)")
        val vx = number()
        val vy = number()
        val vw = number()
        val vh = number()
        if (vw <= 0f || vh <= 0f) fail("viewBox width and height must be above 0")
        val aspect = int(0, ASPECT_NONE, "aspect")

        val gradients = ArrayList<SvgGradient>()
        val clips = ArrayList<SvgClip>()
        while (i < n) {
            when {
                word2('L', 'G') -> gradients += gradient(radial = false)
                word2('R', 'G') -> gradients += gradient(radial = true)
                word('K') -> clips += clip()
                else -> break
            }
        }

        val ops = ArrayList<SvgOp>()
        val paths = ArrayList<SvgPath>()
        var open = IntArray(8) // op index of each open group
        var depth = 0
        var maxDepth = 0
        var part = 0
        while (i < n) {
            when {
                word('G') -> {
                    val opacity = number()
                    val clip = int(-1, clips.size - 1, "clip")
                    if (depth == open.size) open = open.copyOf(depth * 2)
                    open[depth++] = ops.size
                    if (depth > maxDepth) maxDepth = depth
                    ops += SvgGroup(part++, opacity, clip)
                }
                word('g') -> {
                    if (depth == 0) fail("g without a G")
                    (ops[open[--depth]] as SvgGroup).end = ops.size
                    ops += SvgGroupEnd
                }
                word('S') -> ops += shape(part++, paths, gradients.size)
                else -> fail("unknown token")
            }
        }
        if (depth != 0) fail("$depth G without a g")
        return ZnSvgData(vx, vy, vw, vh, aspect, gradients.toTypedArray(), clips.toTypedArray(), ops.toTypedArray(),
            paths.toTypedArray(), maxDepth)
    }

    private fun gradient(radial: Boolean): SvgGradient {
        val c = FloatArray(if (radial) 3 else 4)
        for (k in c.indices) c[k] = number()
        val spread = int(0, 2, "spread")
        val matrix = matrix()
        val count = int(0, n - i, "stop count") // a stop takes more than one char: bounds the arrays below
        val offsets = FloatArray(count)
        val colors = IntArray(count)
        var last = 0f
        for (k in 0 until count) {
            // As SVG: an offset below an earlier one takes the earlier one's value.
            val o = number().coerceIn(0f, 1f).coerceAtLeast(last)
            offsets[k] = o
            last = o
            colors[k] = color()
        }
        return SvgGradient(radial, c, spread, matrix, offsets, colors)
    }

    private fun clip(): SvgClip {
        val rules = ArrayList<Int>(2)
        val paths = ArrayList<SvgPath>(2)
        while (word2('K', 'P')) {
            rules += int(0, 1, "rule")
            paths += path()
        }
        if (paths.isEmpty()) fail("K needs at least one KP")
        return SvgClip(IntArray(rules.size) { rules[it] }, paths.toTypedArray())
    }

    private fun shape(part: Int, paths: ArrayList<SvgPath>, gradientCount: Int): SvgShape {
        paint(gradientCount)
        val fillKind = paintKind
        val fill = paintValue
        val fillAlpha = number()
        paint(gradientCount)
        val strokeKind = paintKind
        val stroke = paintValue
        val strokeAlpha = number()
        val rule = int(0, 1, "rule")
        val opacity = number()
        val spec = if (strokeKind != SVG_PAINT_NONE) strokeSpec() else null
        val matrix = matrix()
        val index = paths.size
        paths += path()
        return SvgShape(part, index, fillKind, fill, fillAlpha, strokeKind, stroke, strokeAlpha, rule, opacity, spec, matrix)
    }

    private fun strokeSpec(): SvgStroke {
        val width = number()
        if (width < 0f) fail("negative stroke width")
        val cap = int(0, 2, "cap")
        val join = int(0, 2, "join")
        val miter = number()
        val count = int(0, n - i, "dash count")
        if (count % 2 != 0) fail("dash count must be even")
        var dashes: FloatArray? = null
        if (count > 0) {
            val d = FloatArray(count)
            var sum = 0f
            for (k in 0 until count) {
                d[k] = number()
                if (d[k] < 0f) fail("negative dash")
                sum += d[k]
            }
            if (sum > 0f) dashes = d // all zero: solid, as SVG says
        }
        val offset = number()
        return SvgStroke(width, cap, join, miter, dashes, offset)
    }

    private fun matrix(): FloatArray? {
        if (int(0, 1, "matrix flag") == 0) return null
        val m = FloatArray(6)
        for (k in 0 until 6) m[k] = number()
        return m
    }

    /** SVG path data up to ";" (it may hold spaces; may be empty). */
    private fun path(): SvgPath {
        if (i >= n) fail("expected path data")
        val start = i
        val end = s.indexOf(';', i)
        if (end < 0) fail("path data without its ;")
        i = end + 1
        endOfToken("expected a space after ;")
        val nodes = try {
            pathParser.pathStringToNodes(s.substring(start, end), ArrayList())
        } catch (e: IllegalArgumentException) { // an unknown command letter
            fail("bad path data: ${e.message}", start)
        }
        return SvgPath(nodes)
    }

    /** "-" none, "c" currentColor, "#AARRGGBB", "@n" gradient n. Sets [paintKind] and [paintValue]. */
    private fun paint(gradientCount: Int) {
        when {
            word('-') -> { paintKind = SVG_PAINT_NONE; paintValue = 0 }
            word('c') -> { paintKind = SVG_PAINT_CURRENT; paintValue = 0 }
            i < n && s[i] == '#' -> { paintKind = SVG_PAINT_COLOR; paintValue = color() }
            i < n && s[i] == '@' -> {
                i++
                paintKind = SVG_PAINT_GRADIENT
                paintValue = int(0, gradientCount - 1, "gradient")
            }
            else -> fail("expected a paint")
        }
    }

    /** "#AARRGGBB". */
    private fun color(): Int {
        if (i + 9 > n || s[i] != '#') fail("expected a colour #AARRGGBB")
        var v = 0
        for (k in 1..8) {
            val h = hex(s[i + k])
            if (h < 0) fail("bad colour")
            v = (v shl 4) or h
        }
        i += 9
        endOfToken("bad colour")
        return v
    }

    private fun hex(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'A'..'F' -> c - 'A' + 10
        in 'a'..'f' -> c - 'a' + 10
        else -> -1
    }

    /** A decimal number: optional "-", digits, optional "." and digits. No exponent. */
    private fun number(): Float {
        val start = i
        val neg = i < n && s[i] == '-'
        if (neg) i++
        var v = 0.0
        var digits = 0
        while (i < n) {
            val d = s[i] - '0'
            if (d !in 0..9) break
            v = v * 10 + d
            digits++
            i++
        }
        if (digits == 0) fail("bad number", start)
        if (i < n && s[i] == '.') {
            i++
            var frac = 0L
            var scale = 1.0
            var fd = 0
            while (i < n) {
                val d = s[i] - '0'
                if (d !in 0..9) break
                if (fd < 15) { // more digits than a Float can hold are skipped
                    frac = frac * 10 + d
                    scale *= 10
                }
                fd++
                i++
            }
            if (fd == 0) fail("bad number", start)
            v += frac / scale
        }
        val f = (if (neg) -v else v).toFloat()
        if (f.isInfinite()) fail("number too big", start)
        endOfToken("bad number", start)
        return f
    }

    /** A whole number in [min]..[max]. */
    private fun int(min: Int, max: Int, what: String): Int {
        val start = i
        val neg = i < n && s[i] == '-'
        if (neg) i++
        var v = 0L
        var digits = 0
        while (i < n) {
            val d = s[i] - '0'
            if (d !in 0..9) break
            v = v * 10 + d
            if (v > Int.MAX_VALUE) fail("$what: number too big", start)
            digits++
            i++
        }
        if (digits == 0) fail("$what: expected a whole number", start)
        endOfToken("$what: expected a whole number", start)
        val r = (if (neg) -v else v).toInt()
        if (r < min || r > max) fail("$what $r is out of range $min..$max", start)
        return r
    }

    /** True (and moves past it) when the next token is the one character [c]. */
    private fun word(c: Char): Boolean {
        if (i >= n || s[i] != c || (i + 1 < n && s[i + 1] != ' ')) return false
        i++
        separator()
        return true
    }

    /** True (and moves past it) when the next token is the two characters [a][b]. */
    private fun word2(a: Char, b: Char): Boolean {
        if (i + 1 >= n || s[i] != a || s[i + 1] != b || (i + 2 < n && s[i + 2] != ' ')) return false
        i += 2
        separator()
        return true
    }

    /** A token ends at the end of the data or at a space. */
    private fun endOfToken(message: String, start: Int = i) {
        if (i < n && s[i] != ' ') fail(message, start)
        separator()
    }

    /** Moves past the one space after a token. More spaces, or a space at the end, are an error. */
    private fun separator() {
        if (i >= n) return
        i++ // the space (checked by the caller)
        if (i >= n || s[i] == ' ') fail("extra space")
    }

    private fun fail(message: String, at: Int = i): Nothing = throw ZnSvgFormatException("$message (at char $at)")
}

/**
 * The parsed SVGs of one template file, keyed by draw data string: one parse per distinct SVG, shared by every node
 * and list row that uses it. Why here: a ZnTemplate list is built per template file and kept by its ZnBundle, so this
 * cache goes away with its bundle (an OTA update applied in place or a `zn dev` reload makes new ones), and no global
 * map has to be cleaned up. The template reader decodes each string once, so equal keys are usually the same String
 * object (a fast lookup). Main thread only (only the main thread draws).
 */
internal class ZnSvgCache {
    private val drawings = HashMap<String, ZnSvgDrawing?>() // null: bad data, already reported

    /** The drawing for [data], parsed on first use; null when the data is bad (reported once, then drawn as nothing). */
    fun get(data: String): ZnSvgDrawing? {
        drawings[data]?.let { return it }
        if (drawings.containsKey(data)) return null
        val parsed = ZnSvgReader.readOrNull(data) { Log.e("zn", "bad SVG draw data, drawing nothing: $it") }
        val drawing = parsed?.let {
            try {
                ZnSvgDrawing(it)
            } catch (e: RuntimeException) {
                Log.e("zn", "bad SVG draw data, drawing nothing", e)
                null
            }
        }
        drawings[data] = drawing
        return drawing
    }
}

/** No part fill / stroke here (the override stacks hold ARGB as a non-negative Long, or this). */
private const val NO_OVERRIDE = -1L
/** No trim in force at a depth. */
private const val NO_TRIM = -1

private fun Color?.toOverride(): Long = if (this == null) NO_OVERRIDE else toArgb().toLong() and 0xFFFFFFFFL

/**
 * One <SvgPart>'s values as draw-phase reads (constants, slots or animations, ZnAnimation.kt): a change or an
 * animation frame redraws the Svg only. Transforms are in viewBox units around ([pivotX], [pivotY]).
 */
internal class ZnSvgPart(
    val fill: () -> Color?,
    val stroke: () -> Color?,
    val opacity: () -> Float,
    val rotate: () -> Float,
    val scaleX: () -> Float,
    val scaleY: () -> Float,
    val translateX: () -> Float,
    val translateY: () -> Float,
    val pivotX: Float,
    val pivotY: Float,
    /** Null when the part never cuts its line. */
    val trim: ZnSvgTrim?,
)

/** "Draw the line": the visible piece, as fractions 0–1 of the part's whole length; [offset] moves it (wraps round). */
internal class ZnSvgTrim(val start: () -> Float, val end: () -> Float, val offset: () -> Float)

/** The <SvgPart> children of one Svg node in one instance, sorted by part index. */
internal class ZnSvgParts(private val index: IntArray, private val parts: Array<ZnSvgPart>) {
    /** Where [find] looks next. Ops are drawn in part order, so one forward walk per draw finds them all. */
    private var cursor = 0

    fun restart() {
        cursor = 0
    }

    /** The position of the part for op [part], or -1. Calls must come in increasing [part] order after [restart]. */
    fun find(part: Int): Int {
        while (cursor < index.size && index[cursor] < part) cursor++
        return if (cursor < index.size && index[cursor] == part) cursor else -1
    }

    operator fun get(k: Int): ZnSvgPart = parts[k]
    fun fill(k: Int): Long = parts[k].fill().toOverride()
    fun stroke(k: Int): Long = parts[k].stroke().toOverride()
    fun opacity(k: Int): Float = parts[k].opacity().coerceIn(0f, 1f)
}

/** The parts of Svg node [s] (its SvgPart children), or null when it has none. The part count is fixed per template. */
@Composable
internal fun znSvgParts(t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance): ZnSvgParts? {
    val specs = remember(t, s) {
        s.children.map { t.nodes[it] }.filter { it.type == Registry.Component.SVG_PART && it.part >= 0 }.sortedBy { it.part }
    }
    if (specs.isEmpty()) return null
    val parts = specs.map { p ->
        val a = p.animate
        val m = znMotionInputs(p, s, inst)
        @Composable fun f(slot: Int, static: Float, prop: Int) = animatedFloat(inst, slot, static, a?.timingFor(prop), m)
        val trim = if (p.hasTrim) {
            ZnSvgTrim(
                f(p.trimStartSlot, p.trimStart, Registry.Prop.TRIM_START),
                f(p.trimEndSlot, p.trimEnd, Registry.Prop.TRIM_END),
                f(p.trimOffsetSlot, p.trimOffset, Registry.Prop.TRIM_OFFSET),
            )
        } else null
        val scale = f(p.scaleSlot, p.scaleBase, Registry.Prop.SCALE)
        val scaleX = f(p.scaleXSlot, p.scaleXOnly, Registry.Prop.SCALE_X)
        val scaleY = f(p.scaleYSlot, p.scaleYOnly, Registry.Prop.SCALE_Y)
        ZnSvgPart(
            fill = animatedColor(inst, p.fillSlot, p.fill, a?.timingFor(Registry.Prop.FILL), m),
            stroke = animatedColor(inst, p.strokeSlot, p.stroke, a?.timingFor(Registry.Prop.STROKE), m),
            opacity = f(p.opacitySlot, p.opacity, Registry.Prop.OPACITY),
            rotate = f(p.rotateSlot, p.rotate, Registry.Prop.ROTATE),
            scaleX = remember(scale, scaleX) { { scale() * scaleX() } },
            scaleY = remember(scale, scaleY) { { scale() * scaleY() } },
            translateX = f(p.translateXSlot, p.translateX, Registry.Prop.TRANSLATE_X),
            translateY = f(p.translateYSlot, p.translateY, Registry.Prop.TRANSLATE_Y),
            pivotX = p.pivotX,
            pivotY = p.pivotY,
            trim = trim,
        )
    }
    return remember(specs, *parts.toTypedArray()) { ZnSvgParts(IntArray(specs.size) { specs[it].part }, parts.toTypedArray()) }
}

/**
 * One SVG ready to draw: Compose Paths (with their fill rule), Strokes, gradient brushes and clip paths, made once
 * from [ZnSvgData]. Gradients are in viewBox space, so nothing here depends on the node's size. Main thread only:
 * the draw state below is reused by every draw.
 */
internal class ZnSvgDrawing(d: ZnSvgData) {
    private val vx = d.vx
    private val vy = d.vy
    private val vw = d.vw
    private val vh = d.vh
    private val aspect = d.aspect
    private val ops = d.ops
    private val brushes: Array<Brush?> = Array(d.gradients.size) { brush(d.gradients[it]) }
    private val clips: Array<Path> = Array(d.clips.size) { clipPath(d.clips[it]) }
    private val paths: Array<Path>
    private val strokes: Array<Stroke?>
    private val matrices: Array<Matrix?>

    // Draw state, per group depth: the part fill / stroke in force, and how many times the group saved the canvas.
    private val fillOverride = LongArray(d.maxDepth + 1)
    private val strokeOverride = LongArray(d.maxDepth + 1)
    private val saved = IntArray(d.maxDepth + 1)
    // The trim in force per depth (one extra, for a shape's own): the op it was measured from (-1: none), and two ranges
    // [a1, b1] and [a2, b2] (a2 < 0: just one), in line lengths from that op's start.
    private val trimFrom = IntArray(d.maxDepth + 2)
    private val trimRange = FloatArray((d.maxDepth + 2) * 4)
    private val layerPaint = Paint()
    /** Made on the first trimmed draw only: measuring every path would slow down SVGs that never trim. */
    private val lengths: ZnSvgLengths by lazy(LazyThreadSafetyMode.NONE) { ZnSvgLengths(ops, paths, matrices) }
    private val measure = android.graphics.PathMeasure()
    private val trimmed = android.graphics.Path()
    private val trimmedPath: Path = trimmed.asComposePath()
    /** The node's box in viewBox space, for layers; made again only when the size changes. */
    private var bounds: Rect? = null

    init {
        val count = d.paths.size
        val p = arrayOfNulls<Path>(count)
        val st = arrayOfNulls<Stroke>(count)
        val m = arrayOfNulls<Matrix>(count)
        for (op in ops) {
            if (op !is SvgShape) continue
            p[op.index] = d.paths[op.index].toPath(op.rule)
            st[op.index] = op.strokeSpec?.let(::stroke)
            m[op.index] = op.matrix?.let(::composeMatrix)
        }
        paths = p.requireNoNulls()
        strokes = st
        matrices = m
    }

    /**
     * Draws into [ds]'s box: viewBox → box with the aspect code; [mirror] flips it left to right (autoMirror in RTL).
     * [current] is currentColor. [parts] override paints and opacity per op.
     */
    fun draw(ds: DrawScope, current: Color, mirror: Boolean, parts: ZnSvgParts?) {
        val w = ds.size.width
        val h = ds.size.height
        if (w <= 0f || h <= 0f) return
        val sx: Float
        val sy: Float
        val align: Int
        if (aspect == ASPECT_NONE) {
            sx = w / vw
            sy = h / vh
            align = 0
        } else {
            val slice = aspect >= 9
            val scale = if (slice) maxOf(w / vw, h / vh) else minOf(w / vw, h / vh)
            sx = scale
            sy = scale
            align = aspect % 9
        }
        // Alignment: x and y each 0 min, 1 mid, 2 max.
        val tx = (w - vw * sx) * (align % 3) / 2f - vx * sx
        val ty = (h - vh * sy) * (align / 3) / 2f - vy * sy

        val canvas = ds.drawContext.canvas
        canvas.save()
        if (aspect in 9..17) canvas.clipRect(0f, 0f, w, h) // slice: the box clips what overflows it
        if (mirror) {
            canvas.translate(w, 0f)
            canvas.scale(-1f, 1f)
        }
        canvas.translate(tx, ty)
        canvas.scale(sx, sy)
        // Layers cover the node's box, in viewBox space (groups never add a transform of their own).
        val bl = -tx / sx
        val bt = -ty / sy
        val br = (w - tx) / sx
        val bb = (h - ty) / sy
        val b = bounds
        if (b == null || b.left != bl || b.top != bt || b.right != br || b.bottom != bb) bounds = Rect(bl, bt, br, bb)

        parts?.restart()
        var depth = 0
        fillOverride[0] = NO_OVERRIDE
        strokeOverride[0] = NO_OVERRIDE
        trimFrom[0] = NO_TRIM
        var i = 0
        while (i < ops.size) {
            when (val op = ops[i]) {
                is SvgGroup -> {
                    var opacity = op.opacity.coerceIn(0f, 1f)
                    var f = fillOverride[depth]
                    var st = strokeOverride[depth]
                    val k = parts?.find(op.part) ?: -1
                    if (k >= 0) {
                        opacity *= parts!!.opacity(k)
                        parts.fill(k).let { if (it != NO_OVERRIDE) f = it }
                        parts.stroke(k).let { if (it != NO_OVERRIDE) st = it }
                    }
                    if (opacity <= 0f) { // invisible: skip to after its "g"
                        i = op.end + 1
                        continue
                    }
                    depth++
                    fillOverride[depth] = f
                    strokeOverride[depth] = st
                    // A group's trim treats all its pieces as one line, in draw order. The nearest trim wins.
                    val trim = if (k >= 0) parts!![k].trim else null
                    if (trim != null) setTrim(depth, i, lengths.before[op.end] - lengths.before[i], trim)
                    else copyTrim(depth - 1, depth)
                    val layer = opacity < 1f
                    val clip = op.clip >= 0
                    var saves = 0
                    if (layer) {
                        // A layer, so overlapping children don't show through each other. Made before the
                        // part's transform, so the layer still covers the whole box when the part turns.
                        layerPaint.alpha = opacity
                        canvas.saveLayer(bounds!!, layerPaint)
                        saves++
                    }
                    if (k >= 0 && canvas.partTransform(parts!![k])) saves++
                    if (clip) {
                        if (saves == 0) {
                            canvas.save()
                            saves++
                        }
                        canvas.clipPath(clips[op.clip])
                    }
                    saved[depth] = saves
                }
                SvgGroupEnd -> {
                    repeat(saved[depth]) { canvas.restore() }
                    depth--
                }
                is SvgShape -> {
                    var opacity = op.opacity.coerceIn(0f, 1f)
                    var f = fillOverride[depth]
                    var st = strokeOverride[depth]
                    val k = parts?.find(op.part) ?: -1
                    var part: ZnSvgPart? = null
                    if (k >= 0) { // the shape's own part wins over a group's
                        part = parts!![k]
                        opacity *= parts.opacity(k)
                        parts.fill(k).let { if (it != NO_OVERRIDE) f = it }
                        parts.stroke(k).let { if (it != NO_OVERRIDE) st = it }
                    }
                    drawShape(ds, i, op, opacity, f, st, current, part, depth)
                }
            }
            i++
        }
        canvas.restore()
    }

    private fun drawShape(
        ds: DrawScope, at: Int, op: SvgShape, opacity: Float, f: Long, st: Long, current: Color, part: ZnSvgPart?, depth: Int,
    ) {
        if (opacity <= 0f) return
        val stroke = strokes[op.index]
        val hasFill = op.fillKind != SVG_PAINT_NONE
        val hasStroke = op.strokeKind != SVG_PAINT_NONE && stroke != null
        if (!hasFill && !hasStroke) return
        // The trim in force: the shape's own, else its group's. The slot after the deepest group holds the shape's own.
        // An own trim that shows the whole line means no cut, even inside a trimmed group (the nearest trim wins).
        var d = depth
        if (part?.trim != null) {
            d = depth + 1
            setTrim(d, at, lengths.length(op.index), part.trim)
        }
        val path = if (trimFrom[d] != NO_TRIM) trimPath(d, at, op) ?: return else paths[op.index]
        val canvas = ds.drawContext.canvas
        // Translucent with both a fill and a stroke: a layer, so the fill doesn't show through the stroke.
        val layer = opacity < 1f && hasFill && hasStroke
        if (layer) {
            layerPaint.alpha = opacity
            canvas.saveLayer(bounds!!, layerPaint)
        }
        val alpha = if (layer) 1f else opacity
        // The part's own move / turn / scale goes outside the shape matrix: its pivot is the centre of the shape as drawn.
        val moved = part != null && canvas.partTransform(part)
        val m = matrices[op.index]
        if (m != null) { // a shape matrix transforms the stroke too
            canvas.save()
            canvas.concat(m)
        }
        if (hasFill) paintPath(ds, path, op.fillKind, op.fill, f, op.fillAlpha * alpha, current, Fill)
        if (hasStroke) paintPath(ds, path, op.strokeKind, op.stroke, st, op.strokeAlpha * alpha, current, stroke!!)
        if (m != null) canvas.restore()
        if (moved) canvas.restore()
        if (layer) canvas.restore()
    }

    /**
     * Sets the trim at depth [d], measured from op [from] over a line [total] long. Like Lottie and VectorDrawable:
     * start > end swaps them, and the offset moves the piece round the line, wrapping at the end.
     */
    private fun setTrim(d: Int, from: Int, total: Float, t: ZnSvgTrim) {
        trimFrom[d] = if (znTrimRanges(t.start(), t.end(), t.offset(), total, trimRange, d * 4)) from else NO_TRIM
    }

    private fun copyTrim(from: Int, to: Int) {
        trimFrom[to] = trimFrom[from]
        System.arraycopy(trimRange, from * 4, trimRange, to * 4, 4)
    }

    /** Shape [op] (at op [at]) cut to the trim at depth [d], or null when none of it shows. Reuses one path. */
    private fun trimPath(d: Int, at: Int, op: SvgShape): Path? {
        val r = d * 4
        val src = paths[op.index]
        val contours = lengths.contours[op.index]
        val k = lengths.scale[op.index]
        // Where this shape starts on the trimmed line.
        var c0 = lengths.before[at] - lengths.before[trimFrom[d]]
        trimmed.reset()
        measure.setPath(src.asAndroidPath(), false)
        var any = false
        for (len in contours) {
            val c1 = c0 + len * k
            for (q in 0..1) {
                val a = trimRange[r + q * 2]
                if (a < 0f) continue
                val x0 = maxOf(a, c0)
                val x1 = minOf(trimRange[r + q * 2 + 1], c1)
                if (x1 > x0 && measure.getSegment((x0 - c0) / k, (x1 - c0) / k, trimmed, true)) any = true
            }
            c0 = c1
            if (!measure.nextContour()) break
        }
        if (!any) return null
        trimmedPath.fillType = src.fillType
        return trimmedPath
    }

    private fun paintPath(ds: DrawScope, path: Path, kind: Int, value: Int, override: Long, alpha: Float, current: Color, style: DrawStyle) {
        val a = alpha.coerceIn(0f, 1f)
        if (a <= 0f) return
        if (override != NO_OVERRIDE) {
            ds.drawPath(path, Color(override.toInt()), a, style)
            return
        }
        when (kind) {
            SVG_PAINT_CURRENT -> ds.drawPath(path, current, a, style)
            SVG_PAINT_COLOR -> ds.drawPath(path, Color(value), a, style)
            SVG_PAINT_GRADIENT -> brushes[value]?.let { ds.drawPath(path, it, a, style) }
        }
    }
}

/**
 * The visible piece of a line [total] long, for trims [start] / [end] / [offset] (fractions). Writes [a1, b1, a2, b2]
 * to [out] at [at]: a2 < 0 means one range; when the piece wraps past the end, the second range starts at 0.
 * Returns false when nothing is cut (the whole line shows). An empty piece gives a1 == b1.
 */
internal fun znTrimRanges(start: Float, end: Float, offset: Float, total: Float, out: FloatArray, at: Int): Boolean {
    var s = start.coerceIn(0f, 1f)
    var e = end.coerceIn(0f, 1f)
    if (s > e) s = e.also { e = s }
    val span = e - s
    if (span >= 1f || total <= 0f) return false
    val a = (((s + offset) % 1f + 1f) % 1f) * total
    val b = a + span * total
    out[at] = a
    out[at + 1] = minOf(b, total)
    out[at + 2] = if (b > total) 0f else -1f
    out[at + 3] = b - total
    return true
}

/**
 * Moves, turns and scales by part [p] around its pivot (viewBox units, degrees). Saves the canvas and returns true,
 * or returns false when the part leaves things where they are.
 */
private fun androidx.compose.ui.graphics.Canvas.partTransform(p: ZnSvgPart): Boolean {
    val tx = p.translateX()
    val ty = p.translateY()
    val r = p.rotate()
    val sx = p.scaleX()
    val sy = p.scaleY()
    if (tx == 0f && ty == 0f && r == 0f && sx == 1f && sy == 1f) return false
    save()
    translate(tx + p.pivotX, ty + p.pivotY)
    if (r != 0f) rotate(r)
    if (sx != 1f || sy != 1f) scale(sx, sy)
    translate(-p.pivotX, -p.pivotY)
    return true
}

/**
 * Line lengths for trims, in viewBox units. [contours]: each shape's contour lengths as its path has them;
 * [scale]: how much the shape's own matrix stretches them (about); [before]: the drawn length of all shapes
 * before each op, so a group's length is before[its end] - before[it].
 */
internal class ZnSvgLengths(ops: Array<SvgOp>, paths: Array<Path>, matrices: Array<Matrix?>) {
    val contours: Array<FloatArray> = Array(paths.size) { FloatArray(0) }
    val scale = FloatArray(paths.size) { 1f }
    val before = FloatArray(ops.size + 1)

    init {
        val pm = android.graphics.PathMeasure()
        for (i in paths.indices) {
            pm.setPath(paths[i].asAndroidPath(), false)
            val list = ArrayList<Float>()
            do list.add(pm.length) while (pm.nextContour())
            contours[i] = list.toFloatArray()
            matrices[i]?.values?.let { v -> scale[i] = kotlin.math.sqrt(kotlin.math.abs(v[0] * v[5] - v[1] * v[4])) }
        }
        var acc = 0f
        for (i in ops.indices) {
            before[i] = acc
            val op = ops[i]
            if (op is SvgShape) acc += length(op.index)
        }
        before[ops.size] = acc
    }

    /** Shape [index]'s whole drawn length. */
    fun length(index: Int): Float = contours[index].sum() * scale[index]
}

private fun SvgPath.toPath(rule: Int): Path {
    val p = nodes.toPath()
    p.fillType = if (rule == 1) PathFillType.EvenOdd else PathFillType.NonZero
    return p
}

/** A clip's paths as one: the union, each path with its own fill rule (Path.op keeps them). */
private fun clipPath(c: SvgClip): Path {
    var acc = c.paths[0].toPath(c.rules[0])
    for (k in 1 until c.paths.size) {
        val next = c.paths[k].toPath(c.rules[k])
        val union = Path()
        if (union.op(acc, next, PathOperation.Union)) acc = union
        else acc.addPath(next) // op failed (rare): keep both paths, the fill rule may be off
    }
    return acc
}

/** null when the stroke draws nothing (width 0: SVG draws no stroke; Compose would draw a hairline). */
private fun stroke(s: SvgStroke): Stroke? {
    if (s.width <= 0f) return null
    return Stroke(
        width = s.width,
        miter = s.miter.coerceAtLeast(1f),
        cap = when (s.cap) {
            1 -> StrokeCap.Round
            2 -> StrokeCap.Square
            else -> StrokeCap.Butt
        },
        join = when (s.join) {
            1 -> StrokeJoin.Round
            2 -> StrokeJoin.Bevel
            else -> StrokeJoin.Miter
        },
        pathEffect = s.dashes?.let { PathEffect.dashPathEffect(it, s.dashOffset) },
    )
}

/** a b c d e f (x' = a*x + c*y + e, y' = b*x + d*y + f) as a Compose matrix. */
private fun composeMatrix(m: FloatArray) = Matrix().apply {
    values[Matrix.ScaleX] = m[0]
    values[Matrix.SkewY] = m[1]
    values[Matrix.SkewX] = m[2]
    values[Matrix.ScaleY] = m[3]
    values[Matrix.TranslateX] = m[4]
    values[Matrix.TranslateY] = m[5]
}

/**
 * A gradient as a brush (android.graphics shader with the gradient's matrix as its local matrix), or null when it
 * paints nothing (no stops). The cases SVG paints with one colour are a solid brush: one stop, a zero-length line,
 * a radius of 0.
 */
private fun brush(g: SvgGradient): Brush? {
    val count = g.colors.size
    if (count == 0) return null
    val last = Color(g.colors[count - 1])
    if (count == 1) return SolidColor(last)
    val c = g.coords
    val tile = when (g.spread) {
        1 -> android.graphics.Shader.TileMode.MIRROR
        2 -> android.graphics.Shader.TileMode.REPEAT
        else -> android.graphics.Shader.TileMode.CLAMP
    }
    val shader = if (g.radial) {
        if (c[2] <= 0f) return SolidColor(last)
        android.graphics.RadialGradient(c[0], c[1], c[2], g.colors, g.offsets, tile)
    } else {
        if (c[0] == c[2] && c[1] == c[3]) return SolidColor(last)
        android.graphics.LinearGradient(c[0], c[1], c[2], c[3], g.colors, g.offsets, tile)
    }
    g.matrix?.let { m ->
        // Android's order: [scaleX skewX transX; skewY scaleY transY; 0 0 1].
        shader.setLocalMatrix(android.graphics.Matrix().apply {
            setValues(floatArrayOf(m[0], m[2], m[4], m[1], m[3], m[5], 0f, 0f, 1f))
        })
    }
    return ShaderBrush(shader)
}

/**
 * An <Svg> node (docs/svg.md §8): one Spacer that draws the draw data, like Icon. The data is parsed on first draw
 * and shared through the template file's [ZnSvgCache]. `color` (currentColor) and the parts' fill / stroke /
 * opacity are read inside the draw lambda: a change redraws this node, nothing recomposes.
 */
@Composable
internal fun ZnSvg(t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance, mod: Modifier) {
    val data = s.svg
    val cache = t.svgs
    val parts = znSvgParts(t, s, inst)
    val current: () -> Color = if (s.colorSlot >= 0) ({ toColor(inst.slot(s.colorSlot).value) ?: Color.Black })
    else ({ s.color ?: Color.Black })
    val mirror = s.autoMirror
    // The compiler always writes a size; 24 dp (an icon) only if it didn't.
    val sized = if (s.width == null && s.height == null) mod.size(24.dp) else mod
    Spacer(
        sized.drawBehind {
            val drawing = data?.let(cache::get) ?: return@drawBehind
            drawing.draw(this, current(), mirror && layoutDirection == LayoutDirection.Rtl, parts)
        },
    )
}
