package dev.zeronative.runtime

import androidx.compose.ui.graphics.TransformOrigin
import org.junit.Assert.assertEquals
import org.junit.Test

/** Registry 20 transformOrigin: the compiler's "x y" fractions become Compose's pivot; anything else is the centre. */
class TransformOriginTest {
    @Test fun fractionsBecomeThePivot() {
        assertEquals(TransformOrigin(0f, 0.5f), parseTransformOrigin("0 0.5"))
        assertEquals(TransformOrigin(0.25f, 1f), parseTransformOrigin("0.25 1"))
    }

    @Test fun absentOrUnreadableIsTheCentre() {
        assertEquals(TransformOrigin.Center, parseTransformOrigin(null))
        assertEquals(TransformOrigin.Center, parseTransformOrigin("left"))
        assertEquals(TransformOrigin.Center, parseTransformOrigin("0"))
    }
}
