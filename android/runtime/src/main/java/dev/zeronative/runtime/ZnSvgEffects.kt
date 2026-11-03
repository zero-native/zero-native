package dev.zeronative.runtime

import android.os.Build
import androidx.annotation.RequiresApi
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ColorMatrix
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.drawscope.CanvasDrawScope
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection

// SVG effects on the phone (registry 13, docs/svg.md §17): layers for opacity and mix-blend-mode, masks, filters and
// pattern tiles. ZnSvgDrawing (ZnSvg.kt) decides where they go; this file makes the Android objects.
//
// Filters run as an Android RenderEffect on a RenderNode (Android 12+, hardware drawing). Elsewhere (older phones,
// a pattern tile drawn into a bitmap) the group is drawn without its filter, under the plain drop shadows the
// compiler found in it (BlurMaskFilter: Android 9+ with hardware drawing).

internal class ZnSvgEffects {
    private val plain = Paint()
    private val blendPaints = arrayOfNulls<Paint>(16)
    private val luminanceMask = Paint().apply {
        blendMode = BlendMode.DstIn
        // alpha = the colour's brightness (sRGB weights, as browsers use for masks); the colours themselves don't matter.
        colorFilter = ColorFilter.colorMatrix(ColorMatrix(floatArrayOf(
            0f, 0f, 0f, 0f, 0f,
            0f, 0f, 0f, 0f, 0f,
            0f, 0f, 0f, 0f, 0f,
            0.2125f, 0.7154f, 0.0721f, 0f, 0f,
        )))
    }
    private val alphaMask = Paint().apply { blendMode = BlendMode.DstIn }
    private val shadowPaint = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)

    /** The paint for a group layer: [opacity] and blend mode [blend] (0 normal). Reused: set before each saveLayer. */
    fun layerPaint(opacity: Float, blend: Int): Paint {
        if (blend == 0) return plain.also { it.alpha = opacity }
        val p = blendPaints[blend] ?: Paint().also {
            it.blendMode = BLEND_MODES[blend]
            blendPaints[blend] = it
        }
        p.alpha = opacity
        return p
    }

    fun maskPaint(luminance: Boolean): Paint = if (luminance) luminanceMask else alphaMask

    /**
     * Draws a filtered group: [content] draws its children (in viewBox units) into the given DrawScope; [scale] is how
     * many pixels one viewBox unit is here. [shadows] draws the group's shapes as one silhouette with the paint it
     * gets, in viewBox units times the scale it gets (for the fallback). [key] names this group in [nodes], the node
     * store of the Svg node being drawn (null: no filter node, the fallback).
     */
    fun drawFiltered(
        ds: DrawScope, f: SvgFilter, key: Long, scale: Float, density: Float, nodes: ZnSvgFilterNodes?,
        shadows: (android.graphics.Paint, Float) -> Unit, content: (DrawScope) -> Unit,
    ) {
        val native = ds.drawContext.canvas.nativeCanvas
        if (Build.VERSION.SDK_INT >= 31 && native.isHardwareAccelerated && scale > 0f && nodes != null &&
            drawWithEffect(native, f, nodes.get(key), scale, density, content)
        ) return
        // Fallback: the plain drop shadows (blurred where the phone can blur a mask), then the group as it is.
        if (f.shadowColors.isNotEmpty() && scale > 0f && (Build.VERSION.SDK_INT >= 28 || !native.isHardwareAccelerated)) {
            for (k in f.shadowColors.indices) {
                val sigma = f.shadows[k * 3 + 2] * scale
                shadowPaint.color = f.shadowColors[k]
                shadowPaint.maskFilter = if (sigma > 0f) android.graphics.BlurMaskFilter(blurRadius(sigma), android.graphics.BlurMaskFilter.Blur.NORMAL) else null
                native.save()
                native.translate(f.shadows[k * 3] * scale, f.shadows[k * 3 + 1] * scale)
                native.scale(1f / scale, 1f / scale)
                shadows(shadowPaint, scale)
                native.restore()
            }
            shadowPaint.maskFilter = null
        }
        content(ds)
    }

    /** False when the region is too big for one node (then the caller falls back). */
    @RequiresApi(31)
    private fun drawWithEffect(
        native: android.graphics.Canvas, f: SvgFilter, n: ZnSvgFilterNode, s: Float, density: Float, content: (DrawScope) -> Unit,
    ): Boolean {
        val r = f.region
        val left = kotlin.math.floor(r[0] * s)
        val top = kotlin.math.floor(r[1] * s)
        val w = (kotlin.math.ceil(r[2] * s) - left).toInt()
        val h = (kotlin.math.ceil(r[3] * s) - top).toInt()
        if (w <= 0 || h <= 0) return true // nothing shows
        if (w > MAX_NODE_PX || h > MAX_NODE_PX) return false
        val node = n.node
        node.setPosition(0, 0, w, h)
        val rc = node.beginRecording(w, h)
        try {
            rc.translate(-left, -top)
            rc.scale(s, s)
            CanvasDrawScope().draw(Density(density), LayoutDirection.Ltr, androidx.compose.ui.graphics.Canvas(rc),
                Size(r[2] - r[0], r[3] - r[1])) { content(this) }
        } finally {
            node.endRecording()
        }
        if (n.filter !== f || n.scale != s) {
            n.filter = f
            n.scale = s
            node.setRenderEffect(ZnSvgFilterGraph.build(f, s))
        }
        native.save()
        native.scale(1f / s, 1f / s)
        native.translate(left, top)
        native.drawRenderNode(node)
        native.restore()
        return true
    }

    private companion object {
        /** A filter node bigger than this (pixels per side) falls back: an offscreen layer that big costs too much memory. */
        const val MAX_NODE_PX = 4096
        val BLEND_MODES = arrayOf(
            BlendMode.SrcOver, BlendMode.Multiply, BlendMode.Screen, BlendMode.Overlay, BlendMode.Darken,
            BlendMode.Lighten, BlendMode.ColorDodge, BlendMode.ColorBurn, BlendMode.Hardlight, BlendMode.Softlight,
            BlendMode.Difference, BlendMode.Exclusion, BlendMode.Hue, BlendMode.Saturation, BlendMode.Color,
            BlendMode.Luminosity,
        )
    }
}

/** Android's blur radius for standard deviation [sigma] (Android turns a radius r into sigma 0.57735 r + 0.5). */
internal fun blurRadius(sigma: Float): Float = ((sigma - 0.5f) / 0.57735f).coerceAtLeast(0.01f)

internal class ZnSvgFilterNode {
    val node = if (Build.VERSION.SDK_INT >= 29) android.graphics.RenderNode("zn-svg-filter") else error("RenderNode needs Android 10")
    var filter: SvgFilter? = null
    var scale = Float.NaN
}

/**
 * The filter RenderNodes of one Svg node on screen (Android 12+), by filtered group. They belong to the Svg node, not
 * to the parsed drawing that every instance shares: a RenderNode is drawn by reference, so two instances (two sizes,
 * colours or animation states) recording into one node in the same frame would all show the last one. Main thread.
 */
internal class ZnSvgFilterNodes {
    private val nodes = HashMap<Long, ZnSvgFilterNode>()

    fun get(key: Long): ZnSvgFilterNode = nodes.getOrPut(key) { ZnSvgFilterNode() }

    /** When the Svg node leaves the screen: frees the nodes' drawing. */
    fun release() {
        if (Build.VERSION.SDK_INT >= 29) for (n in nodes.values) n.node.discardDisplayList()
        nodes.clear()
    }
}

/** A filter's primitives as one Android RenderEffect (Android 12+). */
@RequiresApi(31)
internal object ZnSvgFilterGraph {
    private val alphaOnly = android.graphics.ColorMatrixColorFilter(floatArrayOf(
        0f, 0f, 0f, 0f, 0f,
        0f, 0f, 0f, 0f, 0f,
        0f, 0f, 0f, 0f, 0f,
        0f, 0f, 0f, 1f, 0f,
    ))

    /** [s]: pixels per viewBox unit. Null when the filter changes nothing. */
    fun build(f: SvgFilter, s: Float): android.graphics.RenderEffect? {
        val results = arrayOfNulls<android.graphics.RenderEffect>(f.prims.size)
        // null stands for the group's own drawing (a RenderEffect with no input reads the node's content).
        fun input(i: Int): android.graphics.RenderEffect? = when (i) {
            -1 -> null
            -2 -> android.graphics.RenderEffect.createColorFilterEffect(alphaOnly)
            else -> results[i]
        }
        fun source() = android.graphics.RenderEffect.createOffsetEffect(0f, 0f)
        fun nonNull(e: android.graphics.RenderEffect?) = e ?: source()
        for ((k, p) in f.prims.withIndex()) {
            results[k] = when (p.kind) {
                'b' -> {
                    val sx = p.values[0] * s
                    val sy = p.values[1] * s
                    if (sx <= 0f && sy <= 0f) input(p.inputs[0])
                    else android.graphics.RenderEffect.createBlurEffect(
                        if (sx > 0f) blurRadius(sx) else 0.01f, if (sy > 0f) blurRadius(sy) else 0.01f,
                        nonNull(input(p.inputs[0])), android.graphics.Shader.TileMode.DECAL,
                    )
                }
                'o' -> {
                    val e = input(p.inputs[0])
                    if (e == null) android.graphics.RenderEffect.createOffsetEffect(p.values[0] * s, p.values[1] * s)
                    else android.graphics.RenderEffect.createOffsetEffect(p.values[0] * s, p.values[1] * s, e)
                }
                'f' -> android.graphics.RenderEffect.createShaderEffect(
                    android.graphics.LinearGradient(0f, 0f, 1f, 0f, p.color, p.color, android.graphics.Shader.TileMode.CLAMP),
                )
                'm' -> {
                    // SVG's matrix works on 0–1 values; Android's offsets are 0–255.
                    val v = p.values.copyOf()
                    for (row in 0 until 4) v[row * 5 + 4] *= 255f
                    val cf = android.graphics.ColorMatrixColorFilter(v)
                    val e = input(p.inputs[0])
                    if (e == null) android.graphics.RenderEffect.createColorFilterEffect(cf)
                    else android.graphics.RenderEffect.createColorFilterEffect(cf, e)
                }
                'c' -> android.graphics.RenderEffect.createBlendModeEffect(
                    nonNull(input(p.inputs[1])), nonNull(input(p.inputs[0])), COMPOSITE[p.mode],
                )
                'B' -> android.graphics.RenderEffect.createBlendModeEffect(
                    nonNull(input(p.inputs[1])), nonNull(input(p.inputs[0])), BLENDS[p.mode],
                )
                'M' -> {
                    var acc = nonNull(input(p.inputs[0]))
                    for (j in 1 until p.inputs.size) {
                        acc = android.graphics.RenderEffect.createBlendModeEffect(acc, nonNull(input(p.inputs[j])), android.graphics.BlendMode.SRC_OVER)
                    }
                    acc
                }
                else -> input(-1)
            }
        }
        return results.last()
    }

    /** feComposite operators, src = in, dst = in2 (svg-data.ts "c"). 6: in2 minus in, as DstOut (exact for shadows). */
    private val COMPOSITE = arrayOf(
        android.graphics.BlendMode.SRC_OVER, android.graphics.BlendMode.SRC_IN, android.graphics.BlendMode.SRC_OUT,
        android.graphics.BlendMode.SRC_ATOP, android.graphics.BlendMode.XOR, android.graphics.BlendMode.PLUS,
        android.graphics.BlendMode.DST_OUT,
    )
    private val BLENDS = arrayOf(
        android.graphics.BlendMode.SRC_OVER, android.graphics.BlendMode.MULTIPLY, android.graphics.BlendMode.SCREEN,
        android.graphics.BlendMode.OVERLAY, android.graphics.BlendMode.DARKEN, android.graphics.BlendMode.LIGHTEN,
        android.graphics.BlendMode.COLOR_DODGE, android.graphics.BlendMode.COLOR_BURN, android.graphics.BlendMode.HARD_LIGHT,
        android.graphics.BlendMode.SOFT_LIGHT, android.graphics.BlendMode.DIFFERENCE, android.graphics.BlendMode.EXCLUSION,
        android.graphics.BlendMode.HUE, android.graphics.BlendMode.SATURATION, android.graphics.BlendMode.COLOR,
        android.graphics.BlendMode.LUMINOSITY,
    )
}

/**
 * A pattern's tile drawn once into a bitmap and repeated as a brush. Made for one resolution ([px] pixels per unit
 * of the pattern's space, in half-octave steps so a growing shape doesn't remake it every frame) and one currentColor.
 */
internal class ZnSvgPatternBrush private constructor(val brush: Brush, private val px: Float, private val color: Color) {
    fun fits(want: Float, current: Color): Boolean = current == color && want <= px * 1.42f && want >= px / 1.42f

    companion object {
        /** The biggest tile bitmap, in pixels per side and in all. */
        private const val MAX_SIDE = 2048
        private const val MAX_PIXELS = 4_000_000

        /**
         * [draw] draws the tile's content into the DrawScope it gets (in the pattern's space, cut to the tile),
         * with the layer bounds and pixels per unit it gets. Null when the tile can't be made.
         */
        fun make(
            p: SvgPattern, want: Float, current: Color, density: Float, draw: (DrawScope, Rect, Float) -> Unit,
        ): ZnSvgPatternBrush? {
            if (!(want > 0f) || want.isInfinite()) return null
            val px = Math.pow(2.0, Math.round(Math.log(want.toDouble()) / Math.log(2.0) * 2) / 2.0).toFloat()
            val t = p.tile
            var w = kotlin.math.ceil(t[2] * px).toDouble()
            var h = kotlin.math.ceil(t[3] * px).toDouble()
            val shrink = minOf(1.0, MAX_SIDE / w, MAX_SIDE / h, kotlin.math.sqrt(MAX_PIXELS / (w * h)))
            w = maxOf(1.0, kotlin.math.floor(w * shrink))
            h = maxOf(1.0, kotlin.math.floor(h * shrink))
            val bw = w.toInt()
            val bh = h.toInt()
            val bitmap = ImageBitmap(bw, bh)
            val sx = bw / t[2]
            val sy = bh / t[3]
            val tile = Rect(t[0], t[1], t[0] + t[2], t[1] + t[3])
            CanvasDrawScope().draw(Density(density), LayoutDirection.Ltr, androidx.compose.ui.graphics.Canvas(bitmap),
                Size(bw.toFloat(), bh.toFloat())) {
                val c = drawContext.canvas
                c.scale(sx, sy)
                c.translate(-t[0], -t[1])
                c.clipRect(tile)
                draw(this, tile, kotlin.math.sqrt(sx * sy))
            }
            val shader = android.graphics.BitmapShader(bitmap.asAndroidBitmap(), android.graphics.Shader.TileMode.REPEAT,
                android.graphics.Shader.TileMode.REPEAT)
            val local = android.graphics.Matrix()
            p.matrix?.let { m -> local.setValues(floatArrayOf(m[0], m[2], m[4], m[1], m[3], m[5], 0f, 0f, 1f)) }
            local.preTranslate(t[0], t[1])
            local.preScale(1f / sx, 1f / sy)
            shader.setLocalMatrix(local)
            return ZnSvgPatternBrush(ShaderBrush(shader), px, current)
        }
    }
}
