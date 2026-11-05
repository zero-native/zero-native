package dev.zeronative.runtime

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** A negative margin or padding must never reach Compose (second-opinions 113). */
class ZnEdgesTest {
    @Test
    fun composeRefusesNegativePadding() {
        // Why the clamp exists: this is the crash a `marginTop: -8` caused before 2026-11-05.
        assertThrows(IllegalArgumentException::class.java) { PaddingValues(0.dp, (-8).dp, 0.dp, 0.dp) }
    }

    @Test
    fun negativeEdgesBecomeZero() {
        val p = Edges(-4f, -8f, 6f, 0f).toPadding()
        assertEquals(0.dp, p.calculateLeftPadding(LayoutDirection.Ltr))
        assertEquals(0.dp, p.calculateTopPadding())
        assertEquals(6.dp, p.calculateRightPadding(LayoutDirection.Ltr))
        assertEquals(0.dp, p.calculateBottomPadding())
    }

    @Test
    fun aNegativeBorderWidthPlusPaddingDoesNotCrash() {
        // Border widths are added to the padding (zn flex rule 2); a negative width used to make it negative.
        val p = Edges(4f, 4f, 4f, 4f).plus(-10f, -10f, -10f, -10f).toPadding()
        assertEquals(0.dp, p.calculateTopPadding())
    }
}
