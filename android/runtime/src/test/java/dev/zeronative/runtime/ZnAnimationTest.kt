package dev.zeronative.runtime

import androidx.compose.animation.core.TargetBasedAnimation
import androidx.compose.animation.core.VectorConverter
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
    fun motionOptions() {
        // Old timings: nothing plays by itself.
        assertEquals(false, ZnTiming.parse("t250e0")!!.selfPlaying)
        assertEquals(false, ZnAnimate.parse("*=t250e0").selfPlaying)
        val spin = ZnTiming.parse("t900e3~f0~r-1")!!
        assertEquals(true, spin.selfPlaying)
        assertEquals(-1, spin.plays)
        assertEquals("0", spin.from)
        val shake = ZnTiming.parse("t300e4~b0.4:0:0.2:1~k0:-8:8:-8:0~m0:0.2:0.5:0.8:1~d50")!!
        assertEquals(listOf("0", "-8", "8", "-8", "0"), shake.keyframes)
        assertEquals(0.2f, shake.times!![1])
        assertEquals(50, shake.delayMs)
        assertEquals(1, shake.plays)
        val pulse = ZnTiming.parse("s0.5,300~f#FFEEEEEE~r3~v~g200")!!
        assertEquals(true, pulse.reverse)
        assertEquals(3, pulse.plays)
        assertEquals(200, pulse.repeatDelayMs)
        assertEquals("#FFEEEEEE", pulse.from)
        assertEquals(true, ZnAnimate.parse("${Registry.Prop.ROTATE}=t900e3~f0~r-1").selfPlaying)
        // An option this app doesn't know yet is skipped, not a failure.
        assertNotNull(ZnTiming.parse("t250e0~q9"))
        assertNull(ZnTiming.parse("t250e0~dX"))
        // enter / exit with a delay.
        assertEquals(120, ZnTransition.parse("0,0,12,1|t220e1~d120")!!.timing.delayMs)
    }

    @Test
    fun segmentEasings() {
        // From an imported .svg (compiler/src/svg-anim.ts): linear, then a step (hold 10, jump to 20), then linear.
        val t = ZnTiming.parse("t1000e3~z3:5:3~k0:10:20:30~m0:0.4:0.6:1")!!
        val a = TargetBasedAnimation(t.keyframeSpec(listOf(0f, 10f, 20f, 30f)), Float.VectorConverter, 0f, 30f)
        val at = { ms: Long -> a.getValueFromNanos(ms * 1_000_000L) }
        assertEquals(5f, at(200), 0.01f)
        assertEquals(10f, at(500), 0.01f) // held by the step
        assertEquals(20f, at(600), 0.01f)
        assertEquals(25f, at(800), 0.01f)
        // A bezier per segment: ease-in-out makes the middle of the first segment exactly half way.
        val b = ZnTiming.parse("t1000e3~z4,0.42,0,0.58,1:3~k0:10:20~m0:0.5:1")!!
        val ab = TargetBasedAnimation(b.keyframeSpec(listOf(0f, 10f, 20f)), Float.VectorConverter, 0f, 20f)
        assertEquals(5f, ab.getValueFromNanos(250_000_000L), 0.05f)
        assertEquals(true, ab.getValueFromNanos(100_000_000L) < 1f) // slow start
        assertEquals(15f, ab.getValueFromNanos(750_000_000L), 0.05f) // linear second half
        // Times that land on whole ms stay there (0.0499 x 1000 rounds to 50, not 49).
        val r = ZnTiming.parse("t1000e3~k0:1:1~m0:0.0499:1")!!
        val ar = TargetBasedAnimation(r.keyframeSpec(listOf(0f, 1f, 1f)), Float.VectorConverter, 0f, 1f)
        assertEquals(1f, ar.getValueFromNanos(50_000_000L), 0.001f)
    }

    @Test
    fun playPositions() {
        val len = 1000L
        // Forever, forward: time wraps.
        assertEquals(250L, motionAt(250, len, 0, -1, false).time)
        assertEquals(250L, motionAt(3250, len, 0, -1, false).time)
        // Reverse: every second play backwards.
        assertEquals(750L, motionAt(1250, len, 0, -1, true).time)
        // A gap between plays holds the end of the play.
        assertEquals(len, motionAt(1100, len, 500, -1, false).time)
        assertEquals(100L, motionAt(1600, len, 500, -1, false).time)
        // Two plays, then done where the last play ended (forward, then backwards with reverse).
        val end = motionAt(2500, len, 0, 2, false)
        assertEquals(true, end.done)
        assertEquals(len, end.time)
        assertEquals(0L, motionAt(2500, len, 0, 2, true).time)
        assertEquals(false, motionAt(1999, len, 0, 2, true).done)
        // A zero-length play ends at once.
        assertEquals(true, motionAt(0, 0, 0, -1, false).done)
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
