package dev.zeronative.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The animation strings the compiler writes (compiler/src/compile.ts: animateSpec, transitionSpec). */
class ZnAnimationTest {
    @Test
    fun animatePerPropAndShorthand() {
        val a = ZnAnimate.parse("${Registry.Prop.OPACITY}=t200e0;${Registry.Prop.TRANSLATE_Y}=s0.75,400")
        assertNotNull(a.timingFor(Registry.Prop.OPACITY))
        assertNotNull(a.timingFor(Registry.Prop.TRANSLATE_Y))
        assertNull(a.timingFor(Registry.Prop.SCALE))
        val all = ZnAnimate.parse("*=t250e1")
        assertNotNull(all.timingFor(Registry.Prop.SCALE))
        assertNotNull(all.timingFor(Registry.Prop.BACKGROUND_COLOR))
    }

    @Test
    fun badTimingsAreIgnored() {
        assertNull(ZnTiming.parse("x12"))
        assertNull(ZnTiming.parse("tabc"))
        assertNull(ZnAnimate.parse("44=nope").timingFor(44))
    }

    @Test
    fun transitions() {
        val t = ZnTransition.parse("0,0,16,0.9|t220e1")!!
        assertEquals(0f, t.opacity)
        assertEquals(16f, t.translateY)
        assertEquals(0.9f, t.scale)
        assertNull(ZnTransition.parse("0,0,16|t220e1")) // a value missing
        assertNull(ZnTransition.parse("0,0,16,1")) // no timing
    }
}
