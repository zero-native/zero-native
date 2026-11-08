package dev.zeronative.runtime

import kotlin.math.max
import kotlin.math.min

// useZoom() (core motion.ts): the maths, pure so the Kotlin tests can check it. Everything is in dp, in the element's
// own box (not moved by the zoom): the element is drawn at `c + (p - c) * scale + t`, where c is its centre and t is
// (x, y). That is what a graphicsLayer with translation and scale around the centre draws, so the transform
// `[{ translateX: zoom.x }, { translateY: zoom.y }, { scale: zoom.scale }]` matches it.
// The rules come from the image viewer plugin's ViewerRules (tested there since 2026-10), moved here for all apps.

internal object ZnZoomMath {
    /** The content's size in a box of [w] × [h]: fitted inside it ("contain") for an [aspect] (w / h) > 0, else the box. */
    fun fitted(w: Float, h: Float, aspect: Float): Pair<Float, Float> {
        if (!(aspect > 0f) || !aspect.isFinite() || w <= 0f || h <= 0f) return w to h
        return if (w / h > aspect) (h * aspect) to h else w to (w / aspect)
    }

    /** How far t may go each way on one axis: half of what the zoomed content is larger than the box (0 if smaller). */
    fun range(content: Float, scale: Float, box: Float): Float = max(0f, (content * scale - box) / 2f)

    /**
     * t on one axis after the scale goes from [s] to [sNew] while the point [q] of the box stays under the fingers.
     * [c]: the box centre. The content point under q is `c + (q - c - t) / s`; it must stay at q.
     */
    fun around(s: Float, t: Float, q: Float, c: Float, sNew: Float): Float {
        if (s == 0f) return t
        val p = c + (q - c - t) / s
        return q - c - (p - c) * sNew
    }

    /** [t] held inside ±[r]. */
    fun clamp(t: Float, r: Float): Float = min(r, max(-r, t))

    /** [t] past ±[r] moves less and less (the rubber band); [dim] the box size along this axis. */
    fun rubberT(t: Float, r: Float, dim: Float): Float = when {
        t > r -> r + ZnGesture.rubber(t - r, dim)
        t < -r -> -r - ZnGesture.rubber(-r - t, dim)
        else -> t
    }

    /** A scale past [lo] / [hi] moves less and less (half the pan's band, as the old pinch did). */
    fun rubberS(s: Float, lo: Float, hi: Float): Float = when {
        s < lo -> lo - ZnGesture.rubber(lo - s, 1f) * 0.5f
        s > hi -> hi + ZnGesture.rubber(s - hi, hi) * 0.5f
        else -> s
    }

    /**
     * Where a double tap at ([qx], [qy]) goes: zoomed in (above [lo] by 1%) → back to [lo] at the centre; else to
     * [target] around the tapped point, kept inside the edges. Returns (scale, tx, ty).
     */
    fun doubleTap(
        s: Float, tx: Float, ty: Float, qx: Float, qy: Float,
        w: Float, h: Float, cw: Float, ch: Float, lo: Float, target: Float,
    ): Triple<Float, Float, Float> {
        if (s > lo * 1.01f) return Triple(lo, 0f, 0f)
        return zoomTo(s, tx, ty, qx, qy, w, h, cw, ch, target)
    }

    /** To [sNew] around ([qx], [qy]), then kept inside the edges. Returns (scale, tx, ty). */
    fun zoomTo(s: Float, tx: Float, ty: Float, qx: Float, qy: Float, w: Float, h: Float, cw: Float, ch: Float, sNew: Float): Triple<Float, Float, Float> {
        val nx = around(s, tx, qx, w / 2f, sNew)
        val ny = around(s, ty, qy, h / 2f, sNew)
        return Triple(sNew, clamp(nx, range(cw, sNew, w)), clamp(ny, range(ch, sNew, h)))
    }

    /** A point of the element (local dp, inside its own transform) in the box: `c + (p - c) * scale + t`. */
    fun toBox(p: Float, c: Float, scale: Float, t: Float): Float = c + (p - c) * scale + t
}
