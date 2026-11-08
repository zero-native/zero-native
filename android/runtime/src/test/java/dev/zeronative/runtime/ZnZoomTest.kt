package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** useZoom's maths (ZnZoom.kt). The iOS port must give the same numbers. */
class ZnZoomTest {
    private val m = ZnZoomMath

    @Test
    fun fittedIsContain() {
        // A 4:3 picture in a 300 x 300 box: 300 x 225. A 1:2 picture: 150 x 300. No aspect: the box.
        assertEquals(300f to 225f, m.fitted(300f, 300f, 4f / 3f))
        assertEquals(150f to 300f, m.fitted(300f, 300f, 0.5f))
        assertEquals(300f to 300f, m.fitted(300f, 300f, 0f))
        assertEquals(300f to 300f, m.fitted(300f, 300f, Float.NaN))
    }

    @Test
    fun rangeIsHalfTheOverflow() {
        assertEquals(0f, m.range(300f, 1f, 300f), 0f)
        assertEquals(150f, m.range(300f, 2f, 300f), 0f)
        // Content smaller than the box even zoomed: it stays centred.
        assertEquals(0f, m.range(100f, 2f, 300f), 0f)
    }

    @Test
    fun theSpotUnderTheFingersStays() {
        // Box 300 wide (centre 150), at 1x. Pinch to 2x around x = 250: the content point at 250 must stay at 250.
        val t = m.around(1f, 0f, 250f, 150f, 2f)
        assertEquals(-100f, t, 0.001f)
        // Check with the drawing rule: content point p = 250 is drawn at c + (p - c) * s + t.
        assertEquals(250f, 150f + (250f - 150f) * 2f + t, 0.001f)
        // From 2x (t = -100) to 3x around x = 100.
        val p = 150f + (100f - 150f - (-100f)) / 2f // content point under 100
        val t3 = m.around(2f, -100f, 100f, 150f, 3f)
        assertEquals(100f, 150f + (p - 150f) * 3f + t3, 0.001f)
    }

    @Test
    fun doubleTapZoomsInThereThenOut() {
        // 300 x 300 box, content fills it. Double tap at (250, 150) at 1x → 2.5x, t kept inside ±225.
        val (s, tx, ty) = m.doubleTap(1f, 0f, 0f, 250f, 150f, 300f, 300f, 300f, 300f, 1f, 2.5f)
        assertEquals(2.5f, s, 0f)
        assertEquals(-150f, tx, 0.001f) // around(1, 0, 250, 150, 2.5) = 250 - 150 - 100 * 2.5
        assertEquals(0f, ty, 0.001f)
        // A tap at the very edge would push past the edge: clamped to the range.
        val (_, ex, _) = m.doubleTap(1f, 0f, 0f, 300f, 150f, 300f, 300f, 300f, 300f, 1f, 2.5f)
        assertEquals(-225f, ex, 0.001f)
        // Zoomed in: back to 1x, centred.
        assertEquals(Triple(1f, 0f, 0f), m.doubleTap(2.5f, -150f, 0f, 10f, 10f, 300f, 300f, 300f, 300f, 1f, 2.5f))
    }

    @Test
    fun rubberBandsGiveLessThanTheFinger() {
        val past = m.rubberT(260f, 150f, 300f)
        assertTrue(past > 150f && past < 260f)
        assertEquals(100f, m.rubberT(100f, 150f, 300f), 0f)
        val under = m.rubberS(0.5f, 1f, 4f)
        assertTrue(under < 1f && under > 0.5f)
        val over = m.rubberS(6f, 1f, 4f)
        assertTrue(over > 4f && over < 6f)
    }

    @Test
    fun toBoxUndoesTheLayer() {
        // A point drawn at local 200 in an element scaled 2x and moved -100 (centre 150) is at 150 + 50 * 2 - 100 = 150.
        assertEquals(150f, m.toBox(200f, 150f, 2f, -100f), 0f)
    }
}
