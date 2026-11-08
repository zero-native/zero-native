package dev.zeronative.runtime

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Layout values from slots (registry 23, Gemini's H1), fixed in the 2026-11-08 review: RN's edge order with static and
 * slot values mixed, and NaN / Infinity / huge numbers from JS that used to crash the app.
 */
class ZnLayoutGuardsTest {
    /** One Box node with [props] written in the template and [slotProps] bound to slots 0, 1, ... in that order. */
    private fun spec(props: Map<Int, Any?> = emptyMap(), slotProps: List<Int> = emptyList()): ZnNodeSpec =
        ZnTemplate(RawTemplate(
            component = intArrayOf(Registry.Component.BOX),
            parent = intArrayOf(-1),
            props = arrayOf(props),
            slots = slotProps.map { SlotDef(0, it, null) },
            events = emptyList(),
        )).nodes[0]

    @Test
    fun aWrittenEdgeBeatsASlotsAxis() {
        // paddingStart: 4 written, paddingHorizontal from a slot: RN keeps 4 at the start and uses the slot at the end.
        val s = spec(mapOf(Registry.Prop.PADDING_START to 4.0), listOf(Registry.Prop.PADDING_HORIZONTAL))
        val e = s.mixedEdges(s.paddingProps, s.paddingSlots) { 10f }
        assertEquals(Edges(4f, 0f, 10f, 0f), e)
    }

    @Test
    fun aSlotsEdgeBeatsAWrittenAxis() {
        val s = spec(mapOf(Registry.Prop.MARGIN_HORIZONTAL to 8.0, Registry.Prop.MARGIN to 2.0), listOf(Registry.Prop.MARGIN_END))
        val e = s.mixedEdges(s.marginProps, s.marginSlots) { -6f }
        assertEquals(Edges(8f, 2f, -6f, 2f), e)
    }

    @Test
    fun aNanSlotCountsAsNotWritten() {
        val s = spec(mapOf(Registry.Prop.PADDING to 5.0), listOf(Registry.Prop.PADDING_TOP))
        assertEquals(Edges(5f, 5f, 5f, 5f), s.mixedEdges(s.paddingProps, s.paddingSlots) { Float.NaN })
        assertEquals(Edges(5f, 5f, 5f, 5f), s.mixedEdges(s.paddingProps, s.paddingSlots) { Float.POSITIVE_INFINITY })
    }

    @Test
    fun badSizesFromJsAreNotWritten() {
        val s = spec(slotProps = listOf(Registry.Prop.WIDTH))
        assertNull(resolveSizePx(Double.NaN, 1000, true, 2f, s, "width"))
        assertNull(resolveSizePx(Double.POSITIVE_INFINITY, 1000, true, 2f, s, "width"))
        assertNull(resolveSizePx("NaN%", 1000, true, 2f, s, "width"))
        assertNull(resolveDpPx(Double.NaN, 2f))
        assertEquals(0, resolveSizePx(-20.0, 1000, true, 2f, s, "width"))
        assertEquals(40, resolveSizePx(20.0, 1000, true, 2f, s, "width"))
        assertEquals(500, resolveSizePx("50%", 1000, true, 2f, s, "width"))
        // A huge number is capped, so it can still go into Compose's Constraints.
        assertEquals((1 shl 18) - 1, resolveSizePx(1e9, 1000, true, 2f, s, "width"))
    }

    @Test
    fun aBadGapIsNoGap() {
        assertEquals(Arrangement.Center, znHorizontalArrangement(Registry.JustifyContent.CENTER, Float.NaN))
        assertEquals(Arrangement.Bottom, znVerticalArrangement(Registry.JustifyContent.FLEX_END, Float.POSITIVE_INFINITY))
        // B1: with a gap, justifyContent is kept (Row and Column used plain spacedBy before 2026-11-08).
        assertEquals(ZnJustifyWithGap(Registry.JustifyContent.SPACE_BETWEEN, 8.dp),
            znHorizontalArrangement(Registry.JustifyContent.SPACE_BETWEEN, 8f))
    }
}
