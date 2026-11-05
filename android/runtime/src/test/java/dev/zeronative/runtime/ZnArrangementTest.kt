package dev.zeronative.runtime

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

/**
 * justifyContent + gap must place items where React Native (Yoga) places them (second-opinions 112). The expected
 * numbers are worked out by hand from Yoga's rule: free = size - items - gap × (n - 1), shared out on top of the gap.
 */
class ZnArrangementTest {
    private val J = Registry.JustifyContent
    private val three = intArrayOf(50, 50, 50)

    private fun h(justify: Int, gap: Float, total: Int, sizes: IntArray = three, rtl: Boolean = false, density: Float = 1f): IntArray {
        val out = IntArray(sizes.size)
        val dir = if (rtl) LayoutDirection.Rtl else LayoutDirection.Ltr
        with(znHorizontalArrangement(justify, gap)) { Density(density).arrange(total, sizes, dir, out) }
        return out
    }

    private fun v(justify: Int, gap: Float, total: Int, sizes: IntArray = three): IntArray {
        val out = IntArray(sizes.size)
        with(znVerticalArrangement(justify, gap)) { Density(1f).arrange(total, sizes, out) }
        return out
    }

    @Test
    fun noGapKeepsThePlainComposeArrangements() {
        // Rows with no gap must not change at all.
        assertSame(Arrangement.Start, znHorizontalArrangement(-1, 0f))
        assertSame(Arrangement.Start, znHorizontalArrangement(J.FLEX_START, 0f))
        assertSame(Arrangement.Center, znHorizontalArrangement(J.CENTER, 0f))
        assertSame(Arrangement.End, znHorizontalArrangement(J.FLEX_END, 0f))
        assertSame(Arrangement.SpaceBetween, znHorizontalArrangement(J.SPACE_BETWEEN, 0f))
        assertSame(Arrangement.SpaceAround, znHorizontalArrangement(J.SPACE_AROUND, 0f))
        assertSame(Arrangement.SpaceEvenly, znHorizontalArrangement(J.SPACE_EVENLY, 0f))
        assertSame(Arrangement.Top, znVerticalArrangement(-1, 0f))
        assertSame(Arrangement.Center, znVerticalArrangement(J.CENTER, 0f))
        assertSame(Arrangement.Bottom, znVerticalArrangement(J.FLEX_END, 0f))
        assertSame(Arrangement.SpaceBetween, znVerticalArrangement(J.SPACE_BETWEEN, 0f))
    }

    @Test
    fun flexStartIsUnchanged() {
        assertEquals(Arrangement.spacedBy(10.dp), znHorizontalArrangement(-1, 10f))
        assertArrayEquals(intArrayOf(0, 60, 120), h(J.FLEX_START, 10f, 300))
        assertArrayEquals(intArrayOf(0, 60, 120), v(-1, 10f, 300))
    }

    @Test
    fun centerAndEndKeepTheGapAndMoveTheGroup() {
        // Group = 3 × 50 + 2 × 10 = 170; 130 left over.
        assertArrayEquals(intArrayOf(65, 125, 185), h(J.CENTER, 10f, 300))
        assertArrayEquals(intArrayOf(130, 190, 250), h(J.FLEX_END, 10f, 300))
        assertArrayEquals(intArrayOf(65, 125, 185), v(J.CENTER, 10f, 300))
        assertArrayEquals(intArrayOf(130, 190, 250), v(J.FLEX_END, 10f, 300))
    }

    @Test
    fun spaceBetweenUsesTheGapAsTheSmallestSpace() {
        // Room to spare: free = 300 - 150 - 20 = 130, between = 10 + 65 = 75 (the same as with no gap).
        assertArrayEquals(intArrayOf(0, 125, 250), h(J.SPACE_BETWEEN, 10f, 300))
        // Tight: 150 + 20 = 170 fits exactly, so the gap is all there is.
        assertArrayEquals(intArrayOf(0, 60, 120), h(J.SPACE_BETWEEN, 10f, 170))
        // The old code gave [0, 55, 110] here (gap dropped). Yoga: free < 0 → flex-start with the gap.
        assertArrayEquals(intArrayOf(0, 60, 120), h(J.SPACE_BETWEEN, 10f, 160))
        // One item sits at the start, as in RN.
        assertArrayEquals(intArrayOf(0), h(J.SPACE_BETWEEN, 10f, 300, intArrayOf(50)))
        assertArrayEquals(intArrayOf(0, 125, 250), v(J.SPACE_BETWEEN, 10f, 300))
    }

    @Test
    fun spaceAroundAndEvenlyAddTheGapOnTop() {
        // Around: lead = 130 / 3 / 2 = 21.67, between = 10 + 43.33.
        assertArrayEquals(intArrayOf(22, 125, 228), h(J.SPACE_AROUND, 10f, 300))
        // Evenly: lead = 130 / 4 = 32.5, between = 10 + 32.5.
        assertArrayEquals(intArrayOf(33, 125, 218), h(J.SPACE_EVENLY, 10f, 300))
        // One item: centred by both.
        assertArrayEquals(intArrayOf(125), h(J.SPACE_AROUND, 10f, 300, intArrayOf(50)))
        assertArrayEquals(intArrayOf(125), h(J.SPACE_EVENLY, 10f, 300, intArrayOf(50)))
        // No room: the gap stays, nothing goes before the first item.
        assertArrayEquals(intArrayOf(0, 60, 120), h(J.SPACE_AROUND, 10f, 170))
        assertArrayEquals(intArrayOf(0, 60, 120), h(J.SPACE_EVENLY, 10f, 170))
    }

    @Test
    fun aRowThatWrapsItsContentCountsTheGaps() {
        // Row / Column add spacing × (n - 1) to their own size; without it a wrapping row would have no room for gaps.
        assertEquals(10.dp, znHorizontalArrangement(J.SPACE_BETWEEN, 10f).spacing)
        assertEquals(10.dp, znVerticalArrangement(J.SPACE_EVENLY, 10f).spacing)
        assertEquals(10.dp, znHorizontalArrangement(J.CENTER, 10f).spacing)
        assertEquals(10.dp, znVerticalArrangement(J.FLEX_END, 10f).spacing)
    }

    @Test
    fun rightToLeftMirrors() {
        assertArrayEquals(intArrayOf(250, 125, 0), h(J.SPACE_BETWEEN, 10f, 300, rtl = true))
        assertArrayEquals(intArrayOf(185, 125, 65), h(J.CENTER, 10f, 300, rtl = true))
        assertArrayEquals(intArrayOf(120, 60, 0), h(J.FLEX_END, 10f, 300, rtl = true))
    }

    @Test
    fun centerAndEndWithTooLittleRoomHangOver() {
        // Like Compose's own Center / End with no gap, and like RN: the group hangs over both ends (center) or the
        // start (flex-end).
        assertArrayEquals(intArrayOf(-5, 55, 115), h(J.CENTER, 10f, 160))
        assertArrayEquals(intArrayOf(-10, 50, 110), h(J.FLEX_END, 10f, 160))
    }

    @Test
    fun gapIsInDpNotPixels() {
        // Density 2: gap 10 dp = 20 px; items 100 px each; total 600 → free = 600 - 300 - 40 = 260 → between 150.
        assertArrayEquals(intArrayOf(0, 250, 500), h(J.SPACE_BETWEEN, 10f, 600, intArrayOf(100, 100, 100), density = 2f))
        assertArrayEquals(intArrayOf(0, 120, 240), h(J.SPACE_BETWEEN, 10f, 340, intArrayOf(100, 100, 100), density = 2f))
        // Density 2.625 (a common phone): 10 dp = 26.25 px, rounded to 26 as Row reserves it. A row that wraps its
        // content (100 × 3 + 26 × 2 = 352) then has no rounding drift.
        assertArrayEquals(intArrayOf(0, 126, 252), h(J.SPACE_BETWEEN, 10f, 352, intArrayOf(100, 100, 100), density = 2.625f))
        assertArrayEquals(intArrayOf(0, 126, 252), h(J.CENTER, 10f, 352, intArrayOf(100, 100, 100), density = 2.625f))
    }

    @Test
    fun theSameStyleGivesAnEqualArrangement() {
        // Equal across recompositions, so Row / Column keep their remembered measure policy.
        assertEquals(znHorizontalArrangement(J.SPACE_BETWEEN, 8f), znHorizontalArrangement(J.SPACE_BETWEEN, 8f))
        for (j in listOf(-1, J.FLEX_START, J.CENTER, J.FLEX_END, J.SPACE_BETWEEN, J.SPACE_AROUND, J.SPACE_EVENLY)) {
            assertEquals(znVerticalArrangement(j, 8f), znVerticalArrangement(j, 8f))
            assertEquals(znHorizontalArrangement(j, 8f), znHorizontalArrangement(j, 8f))
        }
        assertArrayEquals(IntArray(0), h(J.SPACE_EVENLY, 10f, 300, IntArray(0)))
    }
}
