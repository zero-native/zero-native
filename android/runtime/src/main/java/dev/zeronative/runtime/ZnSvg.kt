package dev.zeronative.runtime

import android.util.Log
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.geometry.Offset
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
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.graphics.vector.toPath
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// SVG on the phone (docs/svg.md §8). Two steps:
// 1. ZnSvgReader reads the compiler's draw data (format v1, compiler/src/svg-data.ts) into plain data (ZnSvgData).
//    No Android classes, so unit tests run it on the JVM.
// 2. ZnSvgDrawing turns that into Compose Paths, Strokes and brushes once, and draws them in a DrawScope.

// Paint kinds (SvgShape.fillKind / strokeKind). The value is the ARGB colour or the gradient number.
internal const val SVG_PAINT_NONE = 0
internal const val SVG_PAINT_CURRENT = 1
internal const val SVG_PAINT_COLOR = 2
internal const val SVG_PAINT_GRADIENT = 3
/** Registry 13: a pattern (the value is its number). */
internal const val SVG_PAINT_PATTERN = 4

/** aspect = 18: preserveAspectRatio="none" (stretch). */
private const val ASPECT_NONE = 18

/** A path: its SVG path data read into Compose's commands (plain data, no Android Path yet). */
internal class SvgPath(val nodes: List<PathNode>)

/**
 * A gradient. coords: x1 y1 x2 y2 (linear), cx cy r (radial), or cx cy r fx fy fr (radial with a focal circle,
 * registry 13). matrix: a b c d e f, or null (identity).
 */
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

/**
 * Registry 13: a list of ops drawn by a pattern or a mask (ZnSvgData.contents), with its own shapes' paths.
 * Its ops have no parts.
 */
internal class SvgContent(val ops: Array<SvgOp>, val paths: Array<SvgPath>, val maxDepth: Int)

/** Registry 13: a pattern. tile: x y w h in its space; matrix: that space → the shape's (null: identity). */
internal class SvgPattern(val tile: FloatArray, val matrix: FloatArray?, val content: Int)

/** Registry 13: a mask. [region]: a clip number or -1; [content]: its ops (ZnSvgData.contents), in viewBox space. */
internal class SvgMask(val luminance: Boolean, val region: Int, val content: Int)

/**
 * Registry 13: a filter (compiler/src/svg-data.ts "Filters"). region: x0 y0 x1 y1 in viewBox space. [prims] in order;
 * [shadows]: dx dy std per shadow, with [shadowColors], drawn instead where the phone can't run the filter.
 */
internal class SvgFilter(
    val region: FloatArray,
    val prims: Array<SvgFilterPrim>,
    val shadows: FloatArray,
    val shadowColors: IntArray,
)

/**
 * One filter primitive. [kind]: 'b' blur, 'o' offset, 'f' flood, 'm' colour matrix, 'c' composite, 'B' blend,
 * 'M' merge. [inputs]: earlier results, -1 the group's drawing, -2 its alpha. [values]: blur sx sy, offset dx dy,
 * the 20 matrix numbers; [mode]: the composite operator or blend mode; [color]: the flood colour.
 */
internal class SvgFilterPrim(
    val kind: Char,
    val inputs: IntArray,
    val values: FloatArray,
    val mode: Int,
    val color: Int,
)

/** A stroke. dashes: null when solid. [nonScaling]: [width] is in dp, whatever the SVG's size (non-scaling-stroke). */
internal class SvgStroke(
    val width: Float,
    val cap: Int,
    val join: Int,
    val miter: Float,
    val dashes: FloatArray?,
    val dashOffset: Float,
    val nonScaling: Boolean = false,
)

/** One op of the draw list. [part]: its index for <SvgPart part={i}> (G and S ops, counted from 0, in order). */
internal sealed class SvgOp(val part: Int)

/**
 * "G" (or "X", registry 13): a group starts. [end]: the index of its "g" in the op list. clip, mask, filter: numbers,
 * or -1. blend: 0 normal, else the mix-blend-mode code (svg-data.ts).
 */
internal class SvgGroup(
    part: Int,
    val opacity: Float,
    val clip: Int,
    val mask: Int = -1,
    val filter: Int = -1,
    val blend: Int = 0,
) : SvgOp(part) {
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
    /** paint-order (registry 13): the stroke is drawn before the fill. */
    val strokeFirst: Boolean = false,
) : SvgOp(part)

/**
 * "T" (registry 13): one line of text from ([x], [y]) in [matrix]'s space (null: viewBox space). [anchor]: 0 start,
 * 1 middle, 2 end, for all the runs together.
 */
internal class SvgText(part: Int, val x: Float, val y: Float, val anchor: Int, val matrix: FloatArray?, val runs: Array<SvgTextRun>) : SvgOp(part)

/**
 * One run of a text line: its paints (as SvgShape's), font ([family] 0 sans-serif 1 serif 2 monospace, the phone's
 * own fonts), letter [spacing] and [baseline] (0 alphabetic 1 central 2 hanging) in user units, and how far it moves
 * the pen first ([dx], [dy]).
 */
internal class SvgTextRun(
    val fillKind: Int,
    val fill: Int,
    val fillAlpha: Float,
    val strokeKind: Int,
    val stroke: Int,
    val strokeAlpha: Float,
    val opacity: Float,
    val strokeSpec: SvgStroke?,
    val size: Float,
    val weight: Int,
    val italic: Boolean,
    val family: Int,
    val spacing: Float,
    val baseline: Int,
    val dx: Float,
    val dy: Float,
    val text: String,
)

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
    /** Registry 13: filters, patterns, masks, and the op lists the patterns and masks draw. */
    val filters: Array<SvgFilter> = emptyArray(),
    val patterns: Array<SvgPattern> = emptyArray(),
    val masks: Array<SvgMask> = emptyArray(),
    val contents: Array<SvgContent> = emptyArray(),
    /** Registry 13: animated gradient stops, as (gradient, stop, part) triples in gradient order ("SL"). */
    val stopLinks: IntArray = IntArray(0),
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

        while (i < n) {
            when {
                word2('L', 'G') -> gradients += gradient(4)
                word2('R', 'G') -> gradients += gradient(3)
                word2('R', 'F') -> gradients += gradient(6)
                word2('S', 'L') -> {
                    val g = int(maxOf(0, stopLinks.lastLinkGradient()), gradients.size - 1, "stop link gradient")
                    stopLinks += g
                    stopLinks += int(0, gradients[g].colors.size - 1, "stop link stop")
                    stopLinks += int(0, Int.MAX_VALUE, "stop link part")
                }
                word('K') -> clips += clip()
                word2('F', 'L') -> filters += filter()
                word2('P', 'T') -> {
                    val tile = FloatArray(4) { number() }
                    val matrix = matrix()
                    contents += ops('p', 't')
                    patterns += SvgPattern(tile, matrix, contents.size - 1)
                }
                word2('M', 'K') -> {
                    val luminance = int(0, 1, "mask type") == 0
                    val region = int(-1, clips.size - 1, "mask region")
                    contents += ops('m', 'k')
                    masks += SvgMask(luminance, region, contents.size - 1)
                }
                else -> break
            }
        }
        val main = ops(null, null)
        return ZnSvgData(vx, vy, vw, vh, aspect, gradients.toTypedArray(), clips.toTypedArray(), main.ops,
            main.paths, main.maxDepth, filters.toTypedArray(), patterns.toTypedArray(), masks.toTypedArray(),
            contents.toTypedArray(), stopLinks.toIntArray())
    }

    /** The gradient of the last stop link read (links come in gradient order), or -1. */
    private fun ArrayList<Int>.lastLinkGradient(): Int = if (size >= 3) this[size - 3] else -1

    private val stopLinks = ArrayList<Int>()

    // Defs read so far: ops may use only these (each def is written after the ones it uses).
    private val gradients = ArrayList<SvgGradient>()
    private val clips = ArrayList<SvgClip>()
    private val filters = ArrayList<SvgFilter>()
    private val patterns = ArrayList<SvgPattern>()
    private val masks = ArrayList<SvgMask>()
    private val contents = ArrayList<SvgContent>()

    /** Ops up to the two-letter token [end0][end1] (a pattern's or mask's end), or to the end of the data (null). */
    private fun ops(end0: Char?, end1: Char?): SvgContent {
        val ops = ArrayList<SvgOp>()
        val paths = ArrayList<SvgPath>()
        var open = IntArray(8) // op index of each open group
        var depth = 0
        var maxDepth = 0
        var part = 0
        fun group(effects: Boolean) {
            val opacity = number()
            val clip = int(-1, clips.size - 1, "clip")
            val mask = if (effects) int(-1, masks.size - 1, "mask") else -1
            val filter = if (effects) int(-1, filters.size - 1, "filter") else -1
            val blend = if (effects) int(0, 15, "blend") else 0
            if (depth == open.size) open = open.copyOf(depth * 2)
            open[depth++] = ops.size
            if (depth > maxDepth) maxDepth = depth
            ops += SvgGroup(part++, opacity, clip, mask, filter, blend)
        }
        while (i < n) {
            when {
                end0 != null && depth == 0 && word2(end0, end1!!) -> return SvgContent(ops.toTypedArray(), paths.toTypedArray(), maxDepth)
                word('G') -> group(effects = false)
                word('X') -> group(effects = true)
                word('g') -> {
                    if (depth == 0) fail("g without a G")
                    (ops[open[--depth]] as SvgGroup).end = ops.size
                    ops += SvgGroupEnd
                }
                word('S') -> ops += shape(part++, paths)
                word('T') -> ops += text(part++)
                else -> fail("unknown token")
            }
        }
        if (depth != 0) fail("$depth G without a g")
        if (end0 != null) fail("$end0$end1 missing")
        return SvgContent(ops.toTypedArray(), paths.toTypedArray(), maxDepth)
    }

    private fun filter(): SvgFilter {
        val region = FloatArray(4) { number() }
        val count = int(1, n - i, "primitive count")
        val prims = Array(count) { k ->
            // An input is an earlier result (0 until k), -1 the source drawing or -2 its alpha.
            fun input() = int(-2, k - 1, "filter input")
            when {
                word('b') -> SvgFilterPrim('b', intArrayOf(input()), floatArrayOf(number(), number()), 0, 0)
                word('o') -> SvgFilterPrim('o', intArrayOf(input()), floatArrayOf(number(), number()), 0, 0)
                word('f') -> SvgFilterPrim('f', IntArray(0), FloatArray(0), 0, color())
                word('m') -> SvgFilterPrim('m', intArrayOf(input()), FloatArray(20) { number() }, 0, 0)
                word('c') -> SvgFilterPrim('c', intArrayOf(input(), input()), FloatArray(0), int(0, 6, "composite"), 0)
                word('B') -> SvgFilterPrim('B', intArrayOf(input(), input()), FloatArray(0), int(0, 15, "blend"), 0)
                word('M') -> {
                    val m = int(1, n - i, "merge count")
                    SvgFilterPrim('M', IntArray(m) { input() }, FloatArray(0), 0, 0)
                }
                else -> fail("unknown filter primitive")
            }
        }
        val m = int(0, n - i, "shadow count")
        val shadows = FloatArray(m * 3)
        val colors = IntArray(m)
        for (k in 0 until m) {
            shadows[k * 3] = number()
            shadows[k * 3 + 1] = number()
            shadows[k * 3 + 2] = number()
            colors[k] = color()
        }
        return SvgFilter(region, prims, shadows, colors)
    }

    private fun gradient(coords: Int): SvgGradient {
        val radial = coords != 4
        val c = FloatArray(coords)
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

    private fun shape(part: Int, paths: ArrayList<SvgPath>): SvgShape {
        paint()
        val fillKind = paintKind
        val fill = paintValue
        val fillAlpha = number()
        paint()
        val strokeKind = paintKind
        val stroke = paintValue
        val strokeAlpha = number()
        val rule = int(0, 3, "rule") // + 2: paint-order, the stroke first (registry 13)
        val opacity = number()
        val spec = if (strokeKind != SVG_PAINT_NONE) strokeSpec() else null
        val matrix = matrix()
        val index = paths.size
        paths += path()
        return SvgShape(part, index, fillKind, fill, fillAlpha, strokeKind, stroke, strokeAlpha, rule and 1, opacity, spec,
            matrix, strokeFirst = rule >= 2)
    }

    private fun text(part: Int): SvgText {
        val x = number()
        val y = number()
        val anchor = int(0, 2, "text anchor")
        val matrix = matrix()
        val count = int(1, n - i, "run count")
        val runs = Array(count) {
            paint()
            val fillKind = paintKind
            val fill = paintValue
            val fillAlpha = number()
            paint()
            val strokeKind = paintKind
            val stroke = paintValue
            val strokeAlpha = number()
            val opacity = number()
            val spec = if (strokeKind != SVG_PAINT_NONE) strokeSpec() else null
            val size = number()
            val weight = int(1, 1000, "font weight")
            val italic = int(0, 1, "italic") == 1
            val family = int(0, 2, "font family")
            val spacing = number()
            val baseline = int(0, 2, "baseline")
            val dx = number()
            val dy = number()
            SvgTextRun(fillKind, fill, fillAlpha, strokeKind, stroke, strokeAlpha, opacity, spec, size, weight, italic,
                family, spacing, baseline, dx, dy, textToken())
        }
        return SvgText(part, x, y, anchor, matrix, runs)
    }

    /** A URI-encoded text token (no spaces inside). */
    private fun textToken(): String {
        val start = i
        while (i < n && s[i] != ' ') i++
        if (i == start) fail("expected text")
        val raw = s.substring(start, i)
        separator()
        return try {
            java.net.URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8")
        } catch (e: IllegalArgumentException) {
            fail("bad text encoding", start)
        }
    }

    private fun strokeSpec(): SvgStroke {
        // A negative width is a non-scaling stroke (vector-effect="non-scaling-stroke"), that many dp wide.
        val signed = number()
        val width = kotlin.math.abs(signed)
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
        return SvgStroke(width, cap, join, miter, dashes, offset, signed < 0f)
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

    /** "-" none, "c" currentColor, "#AARRGGBB", "@n" gradient n, "%n" pattern n. Sets [paintKind] and [paintValue]. */
    private fun paint() {
        when {
            word('-') -> { paintKind = SVG_PAINT_NONE; paintValue = 0 }
            word('c') -> { paintKind = SVG_PAINT_CURRENT; paintValue = 0 }
            i < n && s[i] == '#' -> { paintKind = SVG_PAINT_COLOR; paintValue = color() }
            i < n && s[i] == '@' -> {
                i++
                paintKind = SVG_PAINT_GRADIENT
                paintValue = int(0, gradients.size - 1, "gradient")
            }
            i < n && s[i] == '%' -> {
                i++
                paintKind = SVG_PAINT_PATTERN
                paintValue = int(0, patterns.size - 1, "pattern")
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

    /**
     * Draw data of [BIG_SVG] chars or more in this file, set once when the file loads (any thread, before any draw).
     * [prefetch] reads these on a background thread after the first frame, so their first draw doesn't parse on the
     * main thread (a 23 KB SVG took 6–7 ms there on a fresh install, §13).
     */
    @Volatile var big: List<String> = emptyList()
    private var prefetching = false

    /** The drawing for [data], parsed on first use; null when the data is bad (reported once, then drawn as nothing). */
    fun get(data: String): ZnSvgDrawing? {
        drawings[data]?.let { return it }
        if (drawings.containsKey(data)) return null
        val drawing = parse(data)
        drawings[data] = drawing
        return drawing
    }

    /**
     * Main thread, from any Svg of this file: waits for the next frame, then reads each [big] string not drawn yet on
     * a background thread, one at a time. Once per cache; if the Svg leaves before it ends, the next one goes on.
     */
    suspend fun prefetch() {
        if (prefetching || big.isEmpty()) return
        prefetching = true
        try {
            withFrameNanos {} // the frame being made now (cold start stays the same)
            for (data in big) {
                if (drawings.containsKey(data)) continue
                val drawing = withContext(Dispatchers.Default) { parse(data) }
                if (!drawings.containsKey(data)) drawings[data] = drawing // a draw may have parsed it meanwhile
            }
            big = emptyList()
        } finally {
            prefetching = false
        }
    }

    /** Any thread: makes no shared state. */
    private fun parse(data: String): ZnSvgDrawing? {
        val parsed = ZnSvgReader.readOrNull(data) { Log.e("zn", "bad SVG draw data, drawing nothing: $it") }
        return parsed?.let {
            try {
                ZnSvgDrawing(it)
            } catch (e: RuntimeException) {
                Log.e("zn", "bad SVG draw data, drawing nothing", e)
                null
            }
        }
    }

    companion object {
        /** Draw data this long (chars) or longer is read in the background after the first frame. */
        const val BIG_SVG = 8 * 1024

        /** The file's [BIG_SVG] strings, each once. */
        fun bigOf(templates: List<ZnTemplate>): List<String> {
            val seen = LinkedHashSet<String>()
            for (t in templates) for (n in t.nodes) n.svg?.let { if (it.length >= BIG_SVG) seen += it }
            return seen.toList()
        }
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
    /** Registry 12: the stroke width and dash offset of the strokes inside (viewBox units; NaN = their own). */
    val strokeWidth: () -> Float = { Float.NaN },
    val dashOffset: () -> Float = { Float.NaN },
    /** One shape's part: its scale changes the outline, so the stroke keeps its width (animated .svg sizes). */
    val scaleOutline: Boolean = false,
    /** One shape's part: the paths it morphs through, and where it is in them ([morphAt] < 0: its own path). */
    val morph: ZnSvgMorph? = null,
    val morphAt: () -> Float = { -1f },
    /** Registry 13: skews around the pivot (degrees; after the turn, before the scale). */
    val skewX: () -> Float = { 0f },
    val skewY: () -> Float = { 0f },
    /** The space the transform above happens in (the element's own, inside a turned or stretched group), or null. */
    val frame: ZnSvgFrame? = null,
    /** A path the part moves along (outside its own transform), and where on it ([motionAt] < 0: not moved). */
    val motion: ZnSvgMotion? = null,
    val motionAt: () -> Float = { -1f },
    /** A trimmed piece of length 0 still draws its caps (an SVG dash of length 0). */
    val trimCaps: Boolean = false,
)

/** SvgPart `frame` ("a b c d e f"): the part draws through [matrix] · its transform · [inverse]. */
internal class ZnSvgFrame(val matrix: android.graphics.Matrix, val inverse: android.graphics.Matrix) {
    companion object {
        /** Null when [s] is not six numbers of a matrix that can be undone ([onError] says why). */
        fun parse(s: String, onError: (String) -> Unit = { Log.e("zn", it) }): ZnSvgFrame? {
            val n = s.trim().split(' ').map { it.toFloatOrNull() ?: Float.NaN }
            val m = android.graphics.Matrix()
            val inv = android.graphics.Matrix()
            if (n.size == 6 && n.none { it.isNaN() }) {
                m.setValues(floatArrayOf(n[0], n[2], n[4], n[1], n[3], n[5], 0f, 0f, 1f))
                if (m.invert(inv)) return ZnSvgFrame(m, inv)
            }
            onError("bad SVG part frame \"$s\", the part's transform is drawn in viewBox units")
            return null
        }
    }
}

/**
 * A path a part moves along (SvgPart `motionPath`, from animateMotion / CSS offset-path): "ox oy angle mode;MCZ;x y
 * ...", in viewBox units. At `at` (0–1 of the path's length) the part moves by (point − origin) and turns around the
 * origin: mode 0 by `angle`, 1 by the path's direction minus `angle`, 2 by that plus 180. Main thread only.
 */
internal class ZnSvgMotion(
    private val ox: Float,
    private val oy: Float,
    private val angle: Float,
    private val mode: Int,
    /** One measure per piece of the path (a new M starts one); pieces of length 0 are left out. */
    private val pieces: Array<android.graphics.PathMeasure>,
    private val lengths: FloatArray,
    private val startX: Float,
    private val startY: Float,
) {
    private val total = lengths.sum()
    private val pos = FloatArray(2)
    private val tan = FloatArray(2)

    /** Moves and turns [m] (after what it has) for position [at]. */
    fun applyTo(m: android.graphics.Matrix, at: Float) {
        var d = at.coerceIn(0f, 1f) * total
        var i = 0
        while (i < pieces.size - 1 && d > lengths[i]) {
            d -= lengths[i]
            i++
        }
        val dir: Float
        if (pieces.isEmpty() || !pieces[i].getPosTan(d.coerceIn(0f, lengths[i]), pos, tan)) {
            pos[0] = startX
            pos[1] = startY
            dir = 0f
        } else {
            dir = Math.toDegrees(kotlin.math.atan2(tan[1], tan[0]).toDouble()).toFloat()
        }
        m.preTranslate(pos[0] - ox, pos[1] - oy)
        val r = when (mode) {
            1 -> dir - angle
            2 -> dir - angle + 180f
            else -> angle
        }
        if (r != 0f) m.preRotate(r, ox, oy)
    }

    companion object {
        /** Null when [s] is not a motion path the compiler writes ([onError] says why; the part then stays put). */
        fun parse(s: String, onError: (String) -> Unit = { Log.e("zn", it) }): ZnSvgMotion? {
            val parts = s.split(';')
            val head = parts[0].trim().split(' ').map { it.toFloatOrNull() ?: Float.NaN }
            val shape = if (parts.size == 3) ZnSvgMorph.parse("${parts[1]}|${parts[2]}") { } else null
            if (head.size != 4 || head.any { it.isNaN() } || shape == null || shape.commands.firstOrNull() != 'M') {
                onError("bad SVG motion path, the part stays where it is")
                return null
            }
            val nums = shape.keyframes[0]
            val pieces = ArrayList<android.graphics.PathMeasure>()
            val lengths = ArrayList<Float>()
            var piece: android.graphics.Path? = null
            fun end() {
                val p = piece ?: return
                val m = android.graphics.PathMeasure(p, false)
                if (m.length > 0f) {
                    pieces.add(m)
                    lengths.add(m.length)
                }
            }
            var k = 0
            for (cmd in shape.commands) {
                when (cmd) {
                    'M' -> {
                        end()
                        piece = android.graphics.Path().apply { moveTo(nums[k], nums[k + 1]) }
                        k += 2
                    }
                    'L' -> piece!!.lineTo(nums[k], nums[k + 1]).also { k += 2 }
                    'C' -> piece!!.cubicTo(nums[k], nums[k + 1], nums[k + 2], nums[k + 3], nums[k + 4], nums[k + 5]).also { k += 6 }
                    'Z' -> piece!!.close()
                }
            }
            end()
            return ZnSvgMotion(head[0], head[1], head[2], head[3].toInt(), pieces.toTypedArray(), lengths.toFloatArray(), nums[0], nums[1])
        }
    }
}

/** "Draw the line": the visible piece, as fractions 0–1 of the part's whole length; [offset] moves it (wraps round). */
internal class ZnSvgTrim(val start: () -> Float, val end: () -> Float, val offset: () -> Float)

/**
 * The keyframe paths of a morph (SvgPart `morph`, written by the compiler): "MCCZ|x y x y ...|x y ...". The commands
 * are the same for every keyframe (M, L, C, Z only), so a frame between two keyframes mixes their numbers.
 */
internal class ZnSvgMorph(val commands: CharArray, val keyframes: Array<FloatArray>) {
    /** The numbers of the frame being drawn (reused: main thread only). */
    private val frame = FloatArray(keyframes[0].size)

    /** The numbers at [at] (0 = the first keyframe, 1.5 = half way from the second to the third), into [out]. */
    fun mix(at: Float, out: FloatArray) {
        val last = keyframes.size - 1
        val c = at.coerceIn(0f, last.toFloat())
        val i = minOf(c.toInt(), maxOf(last - 1, 0))
        val f = if (last == 0) 0f else c - i
        val a = keyframes[i]
        val b = keyframes[minOf(i + 1, last)]
        for (k in a.indices) out[k] = a[k] + (b[k] - a[k]) * f
    }

    /** Writes the path at [at] into [out]. */
    fun build(at: Float, out: android.graphics.Path) {
        mix(at, frame)
        out.rewind()
        var k = 0
        for (cmd in commands) {
            when (cmd) {
                'M' -> out.moveTo(frame[k], frame[k + 1]).also { k += 2 }
                'L' -> out.lineTo(frame[k], frame[k + 1]).also { k += 2 }
                'C' -> out.cubicTo(frame[k], frame[k + 1], frame[k + 2], frame[k + 3], frame[k + 4], frame[k + 5]).also { k += 6 }
                'Z' -> out.close()
            }
        }
    }

    companion object {
        /** Null when [s] is not a morph the compiler writes ([onError] says why; the shape then draws its own path). */
        fun parse(s: String, onError: (String) -> Unit = { Log.e("zn", it) }): ZnSvgMorph? {
            val parts = s.split('|')
            val commands = parts[0].toCharArray()
            val count = commands.sumOf { c -> when (c) { 'M', 'L' -> 2; 'C' -> 6; 'Z' -> 0; else -> -1000 } }
            val keyframes = parts.drop(1).map { k -> k.trim().split(' ').map { it.toFloatOrNull() ?: Float.NaN }.toFloatArray() }
            if (count < 0 || keyframes.isEmpty() || keyframes.any { k -> k.size != count || k.any { it.isNaN() } }) {
                onError("bad SVG morph data, drawing the shape's own path")
                return null
            }
            return ZnSvgMorph(commands, keyframes.toTypedArray())
        }
    }
}

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

    /** The position of the part for [part] in any order (a gradient stop's part, registry 13), or -1. */
    fun indexOf(part: Int): Int = java.util.Arrays.binarySearch(index, part).let { if (it >= 0) it else -1 }

    operator fun get(k: Int): ZnSvgPart = parts[k]
    fun fill(k: Int): Long = parts[k].fill().toOverride()
    fun stroke(k: Int): Long = parts[k].stroke().toOverride()
    fun opacity(k: Int): Float = parts[k].opacity().coerceIn(0f, 1f)
}

/** The parts of Svg node [s] (its SvgPart children), or null when it has none. The part count is fixed per template. */
@Composable
internal fun znSvgParts(t: ZnTemplate, s: ZnNodeSpec, inst: ZnInstance, taps: () -> Int = { 0 }): ZnSvgParts? {
    val specs = remember(t, s) {
        s.children.map { t.nodes[it] }.filter { it.type == Registry.Component.SVG_PART && it.part >= 0 }.sortedBy { it.part }
    }
    if (specs.isEmpty()) return null
    val parts = specs.map { p ->
        val a = p.animate
        val m = znMotionInputs(p, s, inst, taps)
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
            strokeWidth = f(p.strokeWidthSlot, p.strokeWidth, Registry.Prop.STROKE_WIDTH),
            dashOffset = f(p.dashOffsetSlot, p.dashOffset, Registry.Prop.DASH_OFFSET),
            scaleOutline = p.scaleOutline,
            morph = remember(p) { p.morph?.let(ZnSvgMorph::parse) },
            morphAt = f(-1, p.morphAt, Registry.Prop.MORPH_AT),
            skewX = f(-1, p.skewX, Registry.Prop.SKEW_X),
            skewY = f(-1, p.skewY, Registry.Prop.SKEW_Y),
            frame = remember(p) { p.frame?.let(ZnSvgFrame::parse) },
            motion = remember(p) { p.motionPath?.let(ZnSvgMotion::parse) },
            motionAt = f(-1, p.motionAt, Registry.Prop.MOTION_AT),
            trimCaps = p.trimCaps,
        )
    }
    return remember(specs, *parts.toTypedArray()) { ZnSvgParts(IntArray(specs.size) { specs[it].part }, parts.toTypedArray()) }
}

/**
 * One SVG ready to draw: Compose Paths (with their fill rule), Strokes, gradient brushes and clip paths, made once
 * from [ZnSvgData]. Gradients are in viewBox space, so nothing here depends on the node's size. Main thread only:
 * the draw state below is reused by every draw.
 *
 * Registry 13: patterns and masks draw their own op lists ([contents]); a group with a mask, a filter or a blend mode
 * draws its children in an extra layer (ZnSvgEffects.kt).
 */
internal class ZnSvgDrawing(d: ZnSvgData) {
    private val vx = d.vx
    private val vy = d.vy
    private val vw = d.vw
    private val vh = d.vh
    private val aspect = d.aspect
    private val gradients = d.gradients
    private val brushes: Array<Brush?> = Array(d.gradients.size) { brush(d.gradients[it]) }
    /** Registry 13: animated stops ((gradient, stop, part) triples), and the colour each one has now (NO_OVERRIDE: its own). */
    private val stopLinks = d.stopLinks
    private val stopColors = LongArray(stopLinks.size / 3) { NO_OVERRIDE }
    private val clips: Array<Path> = Array(d.clips.size) { clipPath(d.clips[it]) }
    private val patterns = d.patterns
    private val masks = d.masks
    private val filters = d.filters
    private var nextListId = 0
    private val main = OpList(d.ops, d.paths, d.maxDepth)
    private val contents = Array(d.contents.size) { OpList(d.contents[it].ops, d.contents[it].paths, d.contents[it].maxDepth) }
    /** A pattern's tile as a brush, for the resolution it was made at (made again when that changes a lot). */
    private val patternBrushes = arrayOfNulls<ZnSvgPatternBrush>(patterns.size)
    /** mix-blend-mode mixes only with what the SVG itself drew (as an image), so the whole SVG gets a layer. */
    private val blends = (d.ops.asSequence() + d.contents.asSequence().flatMap { it.ops.asSequence() })
        .any { it is SvgGroup && it.blend != 0 }

    /** Pixels per viewBox unit in the current draw (both axes, as one number), and the screen density. */
    private var unitPx = 1f
    private var density = 1f
    /** currentColor in the current draw (patterns and masks use it too). */
    private var current = Color.Black
    /** The filter nodes of the Svg node being drawn now (this drawing is shared by every instance). */
    private var filterNodes: ZnSvgFilterNodes? = null
    private val layerPaint = Paint()
    private val effects = ZnSvgEffects()
    /** The node's box in viewBox space, for layers; made again only when the size changes. */
    private var bounds: Rect? = null
    /**
     * Registry 13: viewBox → the node's pixels as the canvas has it since the draw began, or null where that isn't
     * what the canvas has (inside a filter's own drawing, a pattern tile, a mask's content).
     */
    private var viewMatrix: android.graphics.Matrix? = null
    private val viewM = android.graphics.Matrix()
    /** Text (registry 13): one paint for every run, and the phone's fonts by family, weight and italic. */
    private val textPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG or android.graphics.Paint.SUBPIXEL_TEXT_FLAG)
    private val typefaces = HashMap<Int, android.graphics.Typeface>()

    private fun typeface(family: Int, weight: Int, italic: Boolean): android.graphics.Typeface =
        typefaces.getOrPut(family * 10_000 + weight * 2 + (if (italic) 1 else 0)) {
            val base = when (family) {
                1 -> android.graphics.Typeface.SERIF
                2 -> android.graphics.Typeface.MONOSPACE
                else -> android.graphics.Typeface.SANS_SERIF
            }
            if (android.os.Build.VERSION.SDK_INT >= 28) {
                android.graphics.Typeface.create(base, weight.coerceIn(1, 1000), italic)
            } else {
                val bold = weight >= 600
                android.graphics.Typeface.create(base, when {
                    bold && italic -> android.graphics.Typeface.BOLD_ITALIC
                    bold -> android.graphics.Typeface.BOLD
                    italic -> android.graphics.Typeface.ITALIC
                    else -> android.graphics.Typeface.NORMAL
                })
            }
        }

    /**
     * Draws into [ds]'s box: viewBox → box with the aspect code; [mirror] flips it left to right (autoMirror in RTL).
     * [current] is currentColor. [parts] override paints and opacity per op. [filterNodes]: the drawing Svg node's own
     * filter nodes (null: filters use the fallback).
     */
    fun draw(ds: DrawScope, current: Color, mirror: Boolean, parts: ZnSvgParts?, filterNodes: ZnSvgFilterNodes? = null) {
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

        unitPx = kotlin.math.sqrt(sx * sy)
        // What the canvas has since this draw began (viewBox → the node's pixels), for non-scaling strokes on screen.
        viewM.reset()
        if (mirror) {
            viewM.preTranslate(w, 0f)
            viewM.preScale(-1f, 1f)
        }
        viewM.preTranslate(tx, ty)
        viewM.preScale(sx, sy)
        viewMatrix = viewM
        density = ds.density
        this.current = current
        this.filterNodes = filterNodes
        if (blends) {
            layerPaint.alpha = 1f
            canvas.saveLayer(bounds!!, layerPaint)
        }
        if (stopColors.isNotEmpty()) updateStops(parts)
        parts?.restart()
        main.drawRange(ds, 0, main.size, 0, parts, bounds!!)
        if (blends) canvas.restore()
        canvas.restore()
    }

    /**
     * Gives a gradient with an animated stop a new brush when a stop's part colour changed since the last draw (the
     * links come in gradient order, so each gradient is one run). Patterns are drawn again, as they may use it.
     */
    private fun updateStops(parts: ZnSvgParts?) {
        var changed = false
        var k = 0
        while (k < stopColors.size) {
            val g = stopLinks[k * 3]
            var end = k
            var dirty = false
            while (end < stopColors.size && stopLinks[end * 3] == g) {
                val at = parts?.indexOf(stopLinks[end * 3 + 2]) ?: -1
                val c = if (at >= 0) parts!!.fill(at) else NO_OVERRIDE
                if (c != stopColors[end]) {
                    stopColors[end] = c
                    dirty = true
                }
                end++
            }
            if (dirty) {
                val src = gradients[g]
                val colors = src.colors.copyOf()
                for (j in k until end) if (stopColors[j] != NO_OVERRIDE) colors[stopLinks[j * 3 + 1]] = stopColors[j].toInt()
                brushes[g] = brush(SvgGradient(src.radial, src.coords, src.spread, src.matrix, src.offsets, colors))
                changed = true
            }
            k = end
        }
        if (changed) patternBrushes.fill(null)
    }

    /** Pattern [index] as a brush for [pxPerUnit] pixels per unit of the shape's space, or null when it paints nothing. */
    private fun patternBrush(index: Int, pxPerUnit: Float): Brush? {
        val p = patterns[index]
        val made = patternBrushes[index]
        val m = p.matrix
        val ms = if (m == null) 1f else kotlin.math.sqrt(kotlin.math.abs(m[0] * m[3] - m[1] * m[2]))
        val want = pxPerUnit * ms
        if (made != null && made.fits(want, current)) return made.brush
        val brush = ZnSvgPatternBrush.make(p, want, current, density) { ds, tileBounds, scale ->
            val keep = unitPx
            val view = viewMatrix
            unitPx = scale
            viewMatrix = null
            contents[p.content].drawRange(ds, 0, contents[p.content].size, 0, null, tileBounds)
            unitPx = keep
            viewMatrix = view
        }
        patternBrushes[index] = brush
        return brush?.brush
    }

    /** One list of ops (the SVG's own, a pattern's or a mask's) with its paths, strokes and draw state. */
    private inner class OpList(private val ops: Array<SvgOp>, svgPaths: Array<SvgPath>, maxDepth: Int) {
        val size = ops.size
        private val paths: Array<Path>
        private val strokes: Array<Stroke?>
        private val matrices: Array<Matrix?>

        // Draw state, per group depth: the part fill / stroke in force, and how many times the group saved the canvas.
        private val fillOverride = LongArray(maxDepth + 1)
        private val strokeOverride = LongArray(maxDepth + 1)
        private val saved = IntArray(maxDepth + 1)
        // Per depth (registry 13): the part stroke width / dash offset in force (NaN: none), and how much the parts in
        // force scale (for non-scaling strokes, patterns and filters).
        private val widthOverride = FloatArray(maxDepth + 1)
        private val dashOverride = FloatArray(maxDepth + 1)
        private val partScale = FloatArray(maxDepth + 1)
        /** Registry 13: the parts' transforms in force per depth, together (for non-scaling strokes on screen). */
        private val partMatrix = Array(maxDepth + 1) { android.graphics.Matrix() }
        private val partTemp = android.graphics.Matrix()
        private val screenMatrix = android.graphics.Matrix()
        private val screenBack = android.graphics.Matrix()
        private val screenPath = android.graphics.Path()
        private val screenPathC: Path = screenPath.asComposePath()
        private val specs: Array<SvgStroke?>
        /** Strokes made for a part width, a dash offset or a non-scaling stroke: the last one per shape, and its values. */
        private val madeStroke: Array<Stroke?>
        private val madeWidth: FloatArray
        private val madePhase: FloatArray
        private val outlineMatrix = android.graphics.Matrix()
        private val outline = android.graphics.Path()
        private val outlinePath: Path = outline.asComposePath()
        private val morphed = android.graphics.Path()
        private val morphedPath: Path = morphed.asComposePath()
        // The trim in force per depth (one extra, for a shape's own): how many ranges show (-1: no trim), up to 4 ranges
        // [a, b] in line lengths from the start of the first op, and whether a piece of length 0 draws its caps
        // (registry 13). A trim inside a trimmed group shows only what both show.
        private val trimCount = IntArray(maxDepth + 2)
        private val trimRange = FloatArray((maxDepth + 2) * 8)
        private val trimCaps = BooleanArray(maxDepth + 2)
        private val trimScratch = FloatArray(4)
        private val trimPos = FloatArray(2)
        private val warpedPiece = android.graphics.Path()
        /** Made on the first trimmed draw only: measuring every path would slow down SVGs that never trim. */
        private val lengths: ZnSvgLengths by lazy(LazyThreadSafetyMode.NONE) { ZnSvgLengths(ops, paths, matrices) }
        private val measure = android.graphics.PathMeasure()
        private val trimmed = android.graphics.Path()
        private val trimmedPath: Path = trimmed.asComposePath()
        /** Pixels per unit of the shape being painted (for pattern tiles). */
        private var shapePx = 1f
        /** Names this list in the filter node cache. */
        private val listId = nextListId++
        private val shadowMatrix = android.graphics.Matrix()
        private val shadowPath = android.graphics.Path()

        init {
            val count = svgPaths.size
            val p = arrayOfNulls<Path>(count)
            val st = arrayOfNulls<Stroke>(count)
            val m = arrayOfNulls<Matrix>(count)
            val sp = arrayOfNulls<SvgStroke>(count)
            for (op in ops) {
                if (op !is SvgShape) continue
                p[op.index] = svgPaths[op.index].toPath(op.rule)
                st[op.index] = op.strokeSpec?.let { if (it.nonScaling) null else stroke(it) }
                m[op.index] = op.matrix?.let(::composeMatrix)
                sp[op.index] = op.strokeSpec
            }
            paths = p.requireNoNulls()
            strokes = st
            matrices = m
            specs = sp
            madeStroke = arrayOfNulls(count)
            madeWidth = FloatArray(count) { Float.NaN }
            madePhase = FloatArray(count) { Float.NaN }
        }

        /**
         * Draws ops [from] until [to] at group depth [depth0] (0: from the start, with fresh state; more: a group's
         * children, inside the state its group set). [layerBounds]: what layers cover, in this list's space.
         */
        fun drawRange(ds: DrawScope, from: Int, to: Int, depth0: Int, parts: ZnSvgParts?, layerBounds: Rect) {
            val canvas = ds.drawContext.canvas
            var depth = depth0
            if (depth0 == 0) {
                fillOverride[0] = NO_OVERRIDE
                strokeOverride[0] = NO_OVERRIDE
                widthOverride[0] = Float.NaN
                dashOverride[0] = Float.NaN
                partScale[0] = 1f
                partMatrix[0].reset()
                trimCount[0] = NO_TRIM
            }
            var i = from
            while (i < to) {
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
                        widthOverride[depth] = widthOverride[depth - 1]
                        dashOverride[depth] = dashOverride[depth - 1]
                        partScale[depth] = partScale[depth - 1]
                        partMatrix[depth].set(partMatrix[depth - 1])
                        if (k >= 0) {
                            val p = parts!![k]
                            p.strokeWidth().let { if (!it.isNaN()) widthOverride[depth] = it }
                            p.dashOffset().let { if (!it.isNaN()) dashOverride[depth] = it }
                            partScale[depth] *= kotlin.math.sqrt(kotlin.math.abs(p.scaleX() * p.scaleY()))
                            if (p.matrixInto(partTemp)) partMatrix[depth].preConcat(partTemp)
                        }
                        // A group's trim treats all its pieces as one line, in draw order.
                        val trim = if (k >= 0) parts!![k].trim else null
                        if (trim != null) setTrim(depth, depth - 1, i, lengths.before[op.end] - lengths.before[i], trim, parts!![k].trimCaps)
                        else copyTrim(depth - 1, depth)
                        val layer = opacity < 1f || op.blend != 0
                        val clip = op.clip >= 0
                        var saves = 0
                        if (layer) {
                            // A layer, so overlapping children don't show through each other. Made before the
                            // part's transform, so the layer still covers the whole box when the part turns.
                            canvas.saveLayer(layerBounds, effects.layerPaint(opacity, op.blend))
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
                        if (op.mask >= 0 || op.filter >= 0) {
                            // The children are drawn here, through the mask or filter; then on after the group.
                            drawEffects(ds, i, op, depth, parts, layerBounds)
                            repeat(saves) { canvas.restore() }
                            depth--
                            i = op.end + 1
                            continue
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
                        drawShape(ds, i, op, opacity, f, st, part, depth, layerBounds)
                    }
                    is SvgText -> {
                        var opacity = 1f
                        var f = fillOverride[depth]
                        var st = strokeOverride[depth]
                        val k = parts?.find(op.part) ?: -1
                        var part: ZnSvgPart? = null
                        if (k >= 0) {
                            part = parts!![k]
                            opacity *= parts.opacity(k)
                            parts.fill(k).let { if (it != NO_OVERRIDE) f = it }
                            parts.stroke(k).let { if (it != NO_OVERRIDE) st = it }
                        }
                        drawText(ds, op, opacity, f, st, part, depth)
                    }
                }
                i++
            }
        }

        /** Text op [op] (registry 13), laid out with the phone's own fonts. */
        private fun drawText(ds: DrawScope, op: SvgText, opacity: Float, f: Long, st: Long, part: ZnSvgPart?, depth: Int) {
            if (opacity <= 0f) return
            val canvas = ds.drawContext.canvas
            val native = canvas.nativeCanvas
            val moved = part != null && canvas.partTransform(part)
            val m = op.matrix
            if (m != null) {
                native.save()
                native.concat(android.graphics.Matrix().apply { setValues(floatArrayOf(m[0], m[2], m[4], m[1], m[3], m[5], 0f, 0f, 1f)) })
            }
            // The whole line's width first, for the anchor.
            var total = 0f
            for (r in op.runs) {
                textFont(r)
                total += r.dx + textPaint.measureText(r.text)
            }
            var x = op.x - total * op.anchor / 2f
            var y = op.y
            shapePx = unitPx * partScale[depth] * (if (m == null) 1f else kotlin.math.sqrt(kotlin.math.abs(m[0] * m[3] - m[1] * m[2])))
            for (r in op.runs) {
                x += r.dx
                y += r.dy
                textFont(r)
                val fm = textPaint.fontMetrics
                val by = y + when (r.baseline) {
                    1 -> -(fm.ascent + fm.descent) / 2f // central: the middle of the letters' box on y
                    2 -> -fm.ascent * 0.8f // hanging: about the top of the capitals on y
                    else -> 0f
                }
                val a = opacity * r.opacity
                if (r.fillKind != SVG_PAINT_NONE && textPaintFor(r.fillKind, r.fill, f, a * r.fillAlpha)) {
                    textPaint.style = android.graphics.Paint.Style.FILL
                    native.drawText(r.text, x, by, textPaint)
                }
                val spec = r.strokeSpec
                if (r.strokeKind != SVG_PAINT_NONE && spec != null && textPaintFor(r.strokeKind, r.stroke, st, a * r.strokeAlpha)) {
                    textPaint.style = android.graphics.Paint.Style.STROKE
                    textPaint.strokeWidth = spec.width
                    textPaint.strokeCap = when (spec.cap) { 1 -> android.graphics.Paint.Cap.ROUND; 2 -> android.graphics.Paint.Cap.SQUARE; else -> android.graphics.Paint.Cap.BUTT }
                    textPaint.strokeJoin = when (spec.join) { 1 -> android.graphics.Paint.Join.ROUND; 2 -> android.graphics.Paint.Join.BEVEL; else -> android.graphics.Paint.Join.MITER }
                    textPaint.strokeMiter = spec.miter
                    native.drawText(r.text, x, by, textPaint)
                }
                textPaint.shader = null
                x += textPaint.measureText(r.text)
            }
            if (m != null) native.restore()
            if (moved) canvas.restore()
        }

        /** Sets [textPaint]'s font for run [r]. */
        private fun textFont(r: SvgTextRun) {
            textPaint.typeface = typeface(r.family, r.weight, r.italic)
            textPaint.textSize = r.size
            textPaint.letterSpacing = if (r.size > 0f) r.spacing / r.size else 0f
        }

        /** Sets [textPaint]'s colour or shader for a text paint; false when it paints nothing. */
        private fun textPaintFor(kind: Int, value: Int, override: Long, alpha: Float): Boolean {
            val a = alpha.coerceIn(0f, 1f)
            if (a <= 0f) return false
            textPaint.shader = null
            val color: Int = when {
                override != NO_OVERRIDE -> override.toInt()
                kind == SVG_PAINT_CURRENT -> current.toArgb()
                kind == SVG_PAINT_COLOR -> value
                else -> {
                    val brush = if (kind == SVG_PAINT_GRADIENT) brushes[value] else patternBrush(value, shapePx)
                    when (brush) {
                        is SolidColor -> brush.value.toArgb()
                        is ShaderBrush -> {
                            textPaint.shader = brush.createShader(androidx.compose.ui.geometry.Size.Unspecified)
                            android.graphics.Color.BLACK
                        }
                        else -> return false
                    }
                }
            }
            textPaint.color = color
            textPaint.alpha = (android.graphics.Color.alpha(color) * a).toInt().coerceIn(0, 255)
            return true
        }

        /** Group [op] (at op [at], depth [depth] already set up) with its mask and / or filter. */
        private fun drawEffects(ds: DrawScope, at: Int, op: SvgGroup, depth: Int, parts: ZnSvgParts?, layerBounds: Rect) {
            val canvas = ds.drawContext.canvas
            val mask = if (op.mask >= 0) masks[op.mask] else null
            if (mask != null) canvas.saveLayer(layerBounds, effects.layerPaint(1f, 0))
            if (op.filter >= 0) {
                val scale = unitPx * partScale[depth]
                val key = (listId.toLong() shl 32) or at.toLong()
                val view = viewMatrix
                effects.drawFiltered(ds, filters[op.filter], key, scale, density, filterNodes, { paint, s -> drawShadowShapes(ds, at, op.end, paint, s) }) { inner ->
                    // The filter may draw into its own canvas (in pixels): no screen transform known there.
                    if (inner !== ds) viewMatrix = null
                    drawRange(inner, at + 1, op.end, depth, parts, layerBounds)
                    viewMatrix = view
                }
            } else {
                drawRange(ds, at + 1, op.end, depth, parts, layerBounds)
            }
            if (mask != null) {
                // The mask's layer keeps the content only where the mask shows (DstIn): by its brightness (drawn over
                // black, so its alpha counts too) or by its alpha.
                canvas.saveLayer(layerBounds, effects.maskPaint(mask.luminance))
                if (mask.region >= 0) canvas.clipPath(clips[mask.region])
                if (mask.luminance) ds.drawRect(Color.Black, Offset(layerBounds.left, layerBounds.top), layerBounds.size)
                val c = contents[mask.content]
                val view = viewMatrix
                viewMatrix = null // the mask's content is drawn under the group's part transform
                c.drawRange(ds, 0, c.size, 0, null, layerBounds)
                viewMatrix = view
                canvas.restore()
                canvas.restore()
            }
        }

        /**
         * The shapes of ops [from] until [to] as one plain silhouette (a drop shadow where filters can't run), with
         * [paint]. The canvas is in pixels: each path is scaled by [scale] (pixels per viewBox unit), so a blur
         * radius on the paint is in pixels too.
         */
        private fun drawShadowShapes(ds: DrawScope, from: Int, to: Int, paint: android.graphics.Paint, scale: Float) {
            val canvas = ds.drawContext.canvas.nativeCanvas
            for (i in from until to) {
                val op = ops[i] as? SvgShape ?: continue
                shadowMatrix.setScale(scale, scale)
                matrices[op.index]?.let { m -> shadowMatrix.preConcat(androidMatrix(m)) }
                paths[op.index].asAndroidPath().transform(shadowMatrix, shadowPath)
                if (op.fillKind != SVG_PAINT_NONE) {
                    paint.style = android.graphics.Paint.Style.FILL
                    canvas.drawPath(shadowPath, paint)
                }
                val spec = specs[op.index]
                if (op.strokeKind != SVG_PAINT_NONE && spec != null && !spec.nonScaling) {
                    paint.style = android.graphics.Paint.Style.STROKE
                    paint.strokeWidth = spec.width * scale * lengthScale(op.index)
                    canvas.drawPath(shadowPath, paint)
                }
            }
        }

        private fun drawShape(
            ds: DrawScope, at: Int, op: SvgShape, opacity: Float, f: Long, st: Long, part: ZnSvgPart?, depth: Int,
            layerBounds: Rect,
        ) {
            if (opacity <= 0f) return
            val stroke = if (op.strokeKind != SVG_PAINT_NONE) strokeFor(op, part, depth) else null
            val hasFill = op.fillKind != SVG_PAINT_NONE
            val hasStroke = stroke != null
            if (!hasFill && !hasStroke) return
            // The trim in force: the shape's own together with its group's (what both show). The slot after the deepest
            // group holds it.
            var d = depth
            if (part?.trim != null) {
                d = depth + 1
                setTrim(d, depth, at, lengths.length(op.index), part.trim, part.trimCaps)
            }
            var path = if (trimCount[d] != NO_TRIM) trimPath(d, at, op) ?: return else paths[op.index]
            // A morph (animated `d`) draws the path between two keyframes; the compiler never trims one.
            val morph = part?.morph
            if (morph != null && trimCount[d] == NO_TRIM) {
                val where = part.morphAt()
                if (where >= 0f) {
                    morph.build(where, morphed)
                    morphedPath.fillType = path.fillType
                    path = morphedPath
                }
            }
            val m = matrices[op.index]
            // A part that scales its outline, not its stroke: the scale goes into the path, the rest onto the canvas.
            val outlined = part != null && part.scaleOutline && m == null && (part.scaleX() != 1f || part.scaleY() != 1f)
            if (outlined) {
                outlineMatrix.setScale(part!!.scaleX(), part.scaleY(), part.pivotX, part.pivotY)
                path.asAndroidPath().transform(outlineMatrix, outline)
                outlinePath.fillType = path.fillType
                path = outlinePath
            }
            shapePx = unitPx * partScale[depth] *
                (if (part != null) kotlin.math.sqrt(kotlin.math.abs(part.scaleX() * part.scaleY())) else 1f) * lengthScale(op.index)
            val canvas = ds.drawContext.canvas
            // Translucent with both a fill and a stroke: a layer, so the fill doesn't show through the stroke.
            val layer = opacity < 1f && hasFill && hasStroke
            if (layer) {
                layerPaint.alpha = opacity
                canvas.saveLayer(layerBounds, layerPaint)
            }
            val alpha = if (layer) 1f else opacity
            // The part's own move / turn / scale goes outside the shape matrix: its pivot is the centre of the shape as drawn.
            val moved = part != null && canvas.partTransform(part, scale = !outlined)
            if (m != null) { // a shape matrix transforms the stroke too
                canvas.save()
                canvas.concat(m)
            }
            // paint-order: the stroke first, when the file asks for it.
            // A non-scaling stroke under a transform that stretches unevenly (registry 13): drawn on screen, as SVG does.
            val onScreen = hasStroke && specs[op.index]!!.nonScaling && screenStroke(op, part, depth, outlined, m, st, path)
            if (hasStroke && op.strokeFirst) strokePath(ds, onScreen, path, op, st, op.strokeAlpha * alpha, stroke!!)
            if (hasFill) paintPath(ds, path, op.fillKind, op.fill, f, op.fillAlpha * alpha, Fill)
            if (hasStroke && !op.strokeFirst) strokePath(ds, onScreen, path, op, st, op.strokeAlpha * alpha, stroke!!)
            if (m != null) canvas.restore()
            if (moved) canvas.restore()
            if (layer) canvas.restore()
        }

        /**
         * Shape [op]'s stroke, or null when it draws none: its own, or one made for a part's stroke width or dash offset
         * (the shape's own part wins over a group's) or a non-scaling stroke. Made again only when a value changes.
         */
        private fun strokeFor(op: SvgShape, part: ZnSvgPart?, depth: Int): Stroke? {
            val spec = specs[op.index] ?: return null
            var w = widthOverride[depth]
            var phase = dashOverride[depth]
            var scale = partScale[depth]
            if (part != null) {
                part.strokeWidth().let { if (!it.isNaN()) w = it }
                part.dashOffset().let { if (!it.isNaN()) phase = it }
                if (!part.scaleOutline) scale *= kotlin.math.sqrt(kotlin.math.abs(part.scaleX() * part.scaleY()))
            }
            if (w.isNaN() && phase.isNaN() && !spec.nonScaling) return strokes[op.index]
            if (w.isNaN()) {
                w = spec.width
                // Non-scaling: so many dp on screen, whatever scales the SVG, the shape or its parts.
                if (spec.nonScaling) {
                    val shape = lengthScale(op.index)
                    val px = unitPx * scale * shape
                    w = if (px > 0f) w * density / px else w
                }
            }
            if (phase.isNaN()) phase = spec.dashOffset
            if (w <= 0f) return null
            val i = op.index
            if (madeStroke[i] == null || madeWidth[i] != w || madePhase[i] != phase) {
                madeStroke[i] = stroke(spec, w, phase)
                madeWidth[i] = w
                madePhase[i] = phase
            }
            return madeStroke[i]
        }

        /** How much shape [index]'s own matrix scales lengths (about), 1 without one. */
        private fun lengthScale(index: Int): Float {
            val v = matrices[index]?.values ?: return 1f
            return kotlin.math.sqrt(kotlin.math.abs(v[Matrix.ScaleX] * v[Matrix.ScaleY] - v[Matrix.SkewX] * v[Matrix.SkewY]))
        }

        /**
         * Sets the trim at depth [d], measured from op [from] over a line [total] long. Like Lottie and VectorDrawable:
         * start > end swaps them, and the offset moves the piece round the line, wrapping at the end.
         */
        private fun setTrim(d: Int, parent: Int, from: Int, total: Float, t: ZnSvgTrim, caps: Boolean) {
            // A trim that shows the whole line cuts nothing: what the group shows stays.
            if (!znTrimRanges(t.start(), t.end(), t.offset(), total, trimScratch, 0)) return copyTrim(parent, d)
            trimCaps[d] = caps
            trimCount[d] = znTrimIntersect(trimScratch, lengths.before[from], trimRange, parent * 8,
                if (parent >= 0) trimCount[parent] else NO_TRIM, trimRange, d * 8)
        }

        private fun copyTrim(from: Int, to: Int) {
            trimCount[to] = trimCount[from]
            trimCaps[to] = trimCaps[from]
            System.arraycopy(trimRange, from * 8, trimRange, to * 8, 8)
        }

        /**
         * Shape [op] (at op [at]) cut to the trim at depth [d], or null when none of it shows. Reuses one path. A shape
         * whose matrix doesn't keep shapes (a skew, registry 13) is measured as drawn and cut there, then mapped back.
         */
        private fun trimPath(d: Int, at: Int, op: SvgShape): Path? {
            val r = d * 8
            val src = paths[op.index]
            val contours = lengths.contours[op.index]
            val k = lengths.scale[op.index]
            val warped = lengths.warped[op.index]
            val out = if (warped != null) warpedPiece else trimmed
            // Where this shape starts on the line.
            var c0 = lengths.before[at]
            trimmed.reset()
            out.reset()
            measure.setPath(warped ?: src.asAndroidPath(), false)
            var any = false
            for ((ci, len) in contours.withIndex()) {
                val c1 = c0 + len * k
                for (q in 0 until trimCount[d]) {
                    val a = trimRange[r + q * 2]
                    val b = trimRange[r + q * 2 + 1]
                    if (a == b) {
                        // A piece of length 0: its caps only (an SVG dash of length 0 with a round cap is a dot).
                        if (trimCaps[d] && a >= c0 && (a < c1 || ci == contours.size - 1) && measure.getPosTan((a - c0) / k, trimPos, null)) {
                            out.moveTo(trimPos[0], trimPos[1])
                            out.lineTo(trimPos[0], trimPos[1])
                            any = true
                        }
                        continue
                    }
                    val x0 = maxOf(a, c0)
                    val x1 = minOf(b, c1)
                    if (x1 > x0 && measure.getSegment((x0 - c0) / k, (x1 - c0) / k, out, true)) any = true
                }
                c0 = c1
                if (!measure.nextContour()) break
            }
            if (!any) return null
            if (warped != null) out.transform(lengths.unwarp[op.index]!!, trimmed)
            trimmedPath.fillType = src.fillType
            return trimmedPath
        }

        /**
         * Registry 13: whether non-scaling stroke [op] must be drawn on screen: the way to the screen stretches unevenly
         * or skews (else its dp width, worked out in strokeFor, is exact), its paint is a plain colour, and the screen
         * transform is known here. Then [screenMatrix] is that transform and [screenPath] the path on screen.
         */
        private fun screenStroke(op: SvgShape, part: ZnSvgPart?, depth: Int, outlined: Boolean, m: Matrix?, st: Long, path: Path): Boolean {
            val view = viewMatrix ?: return false
            if (st == NO_OVERRIDE && op.strokeKind != SVG_PAINT_COLOR && op.strokeKind != SVG_PAINT_CURRENT) return false
            screenMatrix.set(view)
            screenMatrix.preConcat(partMatrix[depth])
            if (part != null && part.matrixInto(partTemp, scale = !outlined)) screenMatrix.preConcat(partTemp)
            if (m != null) screenMatrix.preConcat(androidMatrix(m))
            screenMatrix.getValues(screenValues)
            val a = screenValues[android.graphics.Matrix.MSCALE_X]
            val c = screenValues[android.graphics.Matrix.MSKEW_X]
            val b = screenValues[android.graphics.Matrix.MSKEW_Y]
            val d = screenValues[android.graphics.Matrix.MSCALE_Y]
            val big = maxOf(1e-6f, a * a + b * b, c * c + d * d)
            if (kotlin.math.abs(a * c + b * d) <= 1e-4f * big && kotlin.math.abs(a * a + b * b - c * c - d * d) <= 1e-4f * big) return false
            if (!screenMatrix.invert(screenBack)) return false
            path.asAndroidPath().transform(screenMatrix, screenPath)
            screenScale = kotlin.math.sqrt(kotlin.math.abs(a * d - b * c))
            return true
        }

        private val screenValues = FloatArray(9)
        private var screenScale = 1f

        /** Stroke [op] with [stroke], or on screen (see [screenStroke]): [width] dp wide, its dashes scaled as drawn. */
        private fun strokePath(ds: DrawScope, onScreen: Boolean, path: Path, op: SvgShape, st: Long, alpha: Float, stroke: Stroke) {
            if (!onScreen) return paintPath(ds, path, op.strokeKind, op.stroke, st, alpha, stroke)
            val spec = specs[op.index]!!
            val k = screenScale
            val s = stroke(SvgStroke(spec.width * density, spec.cap, spec.join, spec.miter, spec.dashes?.let { d -> FloatArray(d.size) { d[it] * k } },
                spec.dashOffset * k)) ?: return
            val canvas = ds.drawContext.canvas
            canvas.save()
            canvas.nativeCanvas.concat(screenBack)
            paintPath(ds, screenPathC, op.strokeKind, op.stroke, st, alpha, s)
            canvas.restore()
        }

        private fun paintPath(ds: DrawScope, path: Path, kind: Int, value: Int, override: Long, alpha: Float, style: DrawStyle) {
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
                SVG_PAINT_PATTERN -> patternBrush(value, shapePx)?.let { ds.drawPath(path, it, a, style) }
            }
        }
    }
}

/**
 * Registry 13: the pieces of [rel] (a1 b1 a2 b2 as [znTrimRanges] writes them; a2 < 0: one piece) moved by [base], cut
 * to the [count] ranges at [pAt] of [parent] (count < 0: nothing to cut to), written as ranges at [outAt] of [out].
 * Returns how many (at most 4). A piece of length 0 stays where its point shows (for caps).
 */
internal fun znTrimIntersect(rel: FloatArray, base: Float, parent: FloatArray, pAt: Int, count: Int, out: FloatArray, outAt: Int): Int {
    var n = 0
    for (i in 0 until if (rel[2] < 0f) 1 else 2) {
        val a = rel[i * 2] + base
        val b = rel[i * 2 + 1] + base
        if (count < 0) {
            out[outAt + n * 2] = a
            out[outAt + n * 2 + 1] = b
            n++
            continue
        }
        for (j in 0 until count) {
            val p = parent[pAt + j * 2]
            val q = parent[pAt + j * 2 + 1]
            val lo = maxOf(a, p)
            val hi = minOf(b, q)
            val keep = if (a == b) a in p..q else hi > lo
            if (keep && n < 4) {
                out[outAt + n * 2] = lo
                out[outAt + n * 2 + 1] = if (a == b) a else hi
                n++
            }
        }
    }
    return n
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
 * Moves, turns, skews and scales by part [p] around its pivot (viewBox units, degrees). Saves the canvas and returns
 * true, or returns false when the part leaves things where they are. Registry 13: a motion path moves it first
 * (outside the rest), and a frame puts the rest in the element's own space (frame · transform · frame⁻¹).
 */
private fun androidx.compose.ui.graphics.Canvas.partTransform(p: ZnSvgPart, scale: Boolean = true): Boolean {
    if (!p.matrixInto(partMatrixScratch, scale)) return false
    save()
    nativeCanvas.concat(partMatrixScratch)
    return true
}

/** Reused by [partTransform] (main thread only). */
private val partMatrixScratch = android.graphics.Matrix()

/** Part [p]'s transform (as [partTransform] draws it) into [out]; false when it leaves things where they are. */
internal fun ZnSvgPart.matrixInto(out: android.graphics.Matrix, scale: Boolean = true): Boolean {
    val tx = translateX()
    val ty = translateY()
    val r = rotate()
    val sx = if (scale) scaleX() else 1f
    val sy = if (scale) scaleY() else 1f
    val kx = skewX()
    val ky = skewY()
    val mo = motion
    val at = if (mo != null) motionAt() else -1f
    val still = tx == 0f && ty == 0f && r == 0f && sx == 1f && sy == 1f && kx == 0f && ky == 0f
    if (still && at < 0f) return false
    out.reset()
    if (mo != null && at >= 0f) mo.applyTo(out, at)
    if (still) return true
    val fr = frame
    if (fr != null) out.preConcat(fr.matrix)
    out.preTranslate(tx + pivotX, ty + pivotY)
    if (r != 0f) out.preRotate(r)
    if (kx != 0f) out.preSkew(kotlin.math.tan(Math.toRadians(kx.toDouble())).toFloat(), 0f)
    if (ky != 0f) out.preSkew(0f, kotlin.math.tan(Math.toRadians(ky.toDouble())).toFloat())
    if (sx != 1f || sy != 1f) out.preScale(sx, sy)
    out.preTranslate(-pivotX, -pivotY)
    if (fr != null) out.preConcat(fr.inverse)
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
    /**
     * Registry 13: a shape whose matrix doesn't keep shapes (a skew, or a stretch that isn't the same both ways): its
     * path as drawn (measured instead, scale 1), and the way back to its own space. Null for the rest.
     */
    val warped = arrayOfNulls<android.graphics.Path>(paths.size)
    val unwarp = arrayOfNulls<android.graphics.Matrix>(paths.size)

    init {
        val pm = android.graphics.PathMeasure()
        for (i in paths.indices) {
            val v = matrices[i]?.values
            var src = paths[i].asAndroidPath()
            if (v != null) {
                val a = v[0]
                val b = v[1]
                val c = v[4]
                val d = v[5]
                val big = maxOf(1f, a * a + b * b, c * c + d * d)
                if (kotlin.math.abs(a * c + b * d) > 1e-4f * big || kotlin.math.abs(a * a + b * b - c * c - d * d) > 1e-4f * big) {
                    val m = androidMatrix(matrices[i]!!)
                    val back = android.graphics.Matrix()
                    if (m.invert(back)) {
                        val w = android.graphics.Path()
                        src.transform(m, w)
                        warped[i] = w
                        unwarp[i] = back
                        src = w
                    }
                }
            }
            pm.setPath(src, false)
            val list = ArrayList<Float>()
            do list.add(pm.length) while (pm.nextContour())
            contours[i] = list.toFloatArray()
            if (v != null && warped[i] == null) scale[i] = kotlin.math.sqrt(kotlin.math.abs(v[0] * v[5] - v[1] * v[4]))
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
private fun stroke(s: SvgStroke, width: Float = s.width, phase: Float = s.dashOffset): Stroke? {
    if (width <= 0f) return null
    return Stroke(
        width = width,
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
        pathEffect = s.dashes?.let { PathEffect.dashPathEffect(it, phase) },
    )
}

/** A Compose matrix (2D only) as an Android one. */
private fun androidMatrix(m: Matrix) = android.graphics.Matrix().apply {
    val v = m.values
    setValues(floatArrayOf(v[Matrix.ScaleX], v[Matrix.SkewX], v[Matrix.TranslateX], v[Matrix.SkewY], v[Matrix.ScaleY],
        v[Matrix.TranslateY], 0f, 0f, 1f))
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
        if (c.size == 6 && android.os.Build.VERSION.SDK_INT >= 31) {
            // A focal circle (fx fy fr, registry 13): Android 12+ draws the two-circle gradient exactly. Older phones
            // draw it from the centre (below), which is close for a focal point near the centre.
            val colors = LongArray(g.colors.size) { android.graphics.Color.pack(g.colors[it]) }
            android.graphics.RadialGradient(c[3], c[4], c[5], c[0], c[1], c[2], colors, g.offsets, tile)
        } else {
            android.graphics.RadialGradient(c[0], c[1], c[2], g.colors, g.offsets, tile)
        }
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
    // Animations that start on a tap (SMIL begin="click", registry 13): taps on the Svg are counted, never taken, so a
    // Pressable around it still gets them.
    val tapped = remember(t, s) { s.children.any { t.nodes[it].animate?.waitsForTap == true } }
    val taps = remember(inst) { mutableIntStateOf(0) }
    val parts = znSvgParts(t, s, inst, remember(taps) { { taps.intValue } })
    val current: () -> Color = if (s.colorSlot >= 0) ({ toColor(inst.slot(s.colorSlot).value) ?: Color.Black })
    else ({ s.color ?: Color.Black })
    val mirror = s.autoMirror
    // The compiler always writes a size; 24 dp (an icon) only if it didn't.
    // Big SVGs of this file not drawn yet: read them in the background after this frame.
    LaunchedEffect(cache) { cache.prefetch() }
    // This node's own filter nodes (Android 12+; ZnSvgEffects.kt), freed when it leaves the screen.
    val filterNodes = remember { ZnSvgFilterNodes() }
    DisposableEffect(filterNodes) { onDispose { filterNodes.release() } }
    val sized = (if (s.width == null && s.height == null) mod.size(24.dp) else mod).let { m ->
        if (!tapped) m else m.pointerInput(taps) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                val up = waitForUpOrCancellation()
                if (up != null && (up.position - down.position).getDistance() <= viewConfiguration.touchSlop) taps.intValue++
            }
        }
    }
    Spacer(
        sized.drawBehind {
            val drawing = data?.let(cache::get) ?: return@drawBehind
            drawing.draw(this, current(), mirror && layoutDirection == LayoutDirection.Rtl, parts, filterNodes)
        },
    )
}
