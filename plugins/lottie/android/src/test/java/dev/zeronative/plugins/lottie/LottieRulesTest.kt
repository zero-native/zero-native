package dev.zeronative.plugins.lottie

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LottieRulesTest {
    private fun t(
        mode: String = "auto",
        autoPlay: Boolean = false,
        restart: Int = 0,
        plays: Int = 0,
        progress: Float? = null,
        speed: Float = 1f,
        from: Int? = null,
        to: Int? = null,
        loop: Boolean = true,
    ) = Target(
        mode = mode,
        playing = LottieRules.playing(mode, autoPlay),
        restart = restart,
        plays = plays,
        progress = progress,
        backwards = LottieRules.backwards(speed, from, to),
        loop = loop,
        speed = speed,
        from = from,
        to = to,
    )

    @Test
    fun assetPaths() {
        assertEquals("lottie/a.json", LottieRules.assetPath("asset:lottie/a.json"))
        assertEquals("lottie/a.lottie", LottieRules.assetPath("asset://lottie/a.lottie"))
        assertEquals("a.json", LottieRules.assetPath("asset:a.json"))
        for (bad in listOf(null, "", "lottie/a.json", "https://x.example/a.json", "file:///sdcard/a.json", "asset:",
            "asset:/lottie/a.json", "asset:../a.json", "asset:lottie/../../a.json", "asset:lottie//a.json",
            "asset:lottie\\a.json", "asset:lottie/", "asset:./a.json")) {
            assertNull(bad, LottieRules.assetPath(bad))
        }
    }

    @Test
    fun playingFollowsTheControllerThenAutoPlay() {
        assertTrue(LottieRules.playing("auto", autoPlay = true))
        assertFalse(LottieRules.playing("auto", autoPlay = false))
        assertTrue(LottieRules.playing("play", autoPlay = false))
        assertFalse(LottieRules.playing("pause", autoPlay = true))
        assertFalse(LottieRules.playing("stop", autoPlay = true))
    }

    @Test
    fun firstStart() {
        // autoPlay starts at the start, whatever `progress` says (RN's playAnimation()).
        assertEquals(0f, LottieRules.start(null, t(autoPlay = true, progress = 0.5f), 0f, 0f, 1f))
        assertEquals(1f, LottieRules.start(null, t(autoPlay = true, speed = -1f), 0f, 0f, 1f))
        // Not playing: the `progress` frame, RN's default 0, kept inside the part.
        assertEquals(0.5f, LottieRules.start(null, t(progress = 0.5f), 0f, 0f, 1f))
        assertEquals(0f, LottieRules.start(null, t(), 0.7f, 0f, 1f))
        assertEquals(0.2f, LottieRules.start(null, t(progress = 0.1f), 0f, 0.2f, 0.8f))
    }

    @Test
    fun resetThenPlayInOneTickStartsAgain() {
        // ZeroBill's Welcome slide: view.reset(); view.play() in the same tick.
        val playing = t(mode = "play", restart = 1)
        val again = t(mode = "play", restart = 2)
        assertEquals(0f, LottieRules.start(playing, again, 0.6f, 0f, 1f))
    }

    @Test
    fun pauseKeepsTheFrameAndResumeGoesOn() {
        val playing = t(mode = "play")
        val paused = t(mode = "pause")
        assertNull(LottieRules.start(playing, paused, 0.4f, 0f, 1f))
        assertNull(LottieRules.start(paused, playing, 0.4f, 0f, 1f))
        // At the end, a play starts again (Lottie's resumeAnimation()).
        assertEquals(0f, LottieRules.start(paused, playing, 1f, 0f, 1f))
        val back = t(mode = "play", speed = -1f)
        assertEquals(1f, LottieRules.start(t(mode = "pause", speed = -1f), back, 0f, 0f, 1f))
    }

    @Test
    fun aPlayThatEndedIsOverUntilTheNextPlay() {
        // Found on the emulator: a second play() after a play without loop ended did nothing, and a new `progress`
        // started the play again instead of showing that frame.
        val played = t(mode = "play", plays = 1, loop = false)
        val ended = 0 to 1
        assertFalse(LottieRules.afterEnd(played, ended).playing)
        assertFalse(LottieRules.afterEnd(played.copy(progress = 0.5f), ended).playing)
        // The `progress` frame shows, as the view is not playing any more.
        val over = LottieRules.afterEnd(played, ended)
        assertEquals(0.5f, LottieRules.start(over, LottieRules.afterEnd(played.copy(progress = 0.5f), ended), 1f, 0f, 1f))
        // play() again: plays is raised, so it is a new play; at the end, it starts from the start.
        val again = t(mode = "play", plays = 2, loop = false)
        assertTrue(LottieRules.afterEnd(again, ended).playing)
        assertEquals(0f, LottieRules.start(over, again, 1f, 0f, 1f))
        assertTrue(LottieRules.newPlay(over, again))
        // reset() is a new restart: not the play that ended.
        assertFalse(LottieRules.afterEnd(t(mode = "stop", restart = 1, plays = 1), ended).playing)
        assertTrue(LottieRules.afterEnd(t(mode = "play", restart = 1, plays = 1), ended).playing)
        assertEquals(played, LottieRules.afterEnd(played, null))
    }

    @Test
    fun aNewProgressJumpsThere() {
        assertEquals(0.3f, LottieRules.start(t(progress = 0.1f), t(progress = 0.3f), 0.1f, 0f, 1f))
        assertEquals(0.3f, LottieRules.start(t(mode = "play", progress = 0.1f), t(mode = "play", progress = 0.3f), 0.9f, 0f, 1f))
        // The same progress again changes nothing: a play goes on.
        assertNull(LottieRules.start(t(mode = "play", progress = 0.1f), t(mode = "play", progress = 0.1f, loop = false), 0.9f, 0f, 1f))
    }

    @Test
    fun aPartPlaysByItsFrames() {
        assertEquals(10..20, LottieRules.part(10, 20))
        assertEquals(10..20, LottieRules.part(20, 10))
        assertNull(LottieRules.part(10, null))
        assertFalse(LottieRules.backwards(1f, 10, 20))
        assertTrue(LottieRules.backwards(1f, 20, 10))
        // RN turns the speed to match the frames.
        assertFalse(LottieRules.backwards(-1f, 10, 20))
        assertTrue(LottieRules.backwards(-1f, null, null))
        // play(20, 10): from the higher frame, backwards.
        assertEquals(0.8f, LottieRules.start(t(mode = "play"), t(mode = "play", restart = 1, from = 20, to = 10), 0.5f, 0.2f, 0.8f))
    }

    @Test
    fun onlyResetCancelsARunningPlay() {
        val playing = t(mode = "play")
        assertTrue(LottieRules.cancelled(playing, t(mode = "stop", restart = 1), wasRunning = true))
        assertFalse(LottieRules.cancelled(playing, t(mode = "stop", restart = 1), wasRunning = false))
        assertFalse(LottieRules.cancelled(playing, t(mode = "pause"), wasRunning = true))
        assertFalse(LottieRules.cancelled(playing, t(mode = "play", restart = 1, from = 1, to = 5), wasRunning = true))
        assertFalse(LottieRules.cancelled(null, t(mode = "stop", restart = 1), wasRunning = true))
    }

    @Test
    fun withAnimationsOffOnlyANewPlayFinishes() {
        assertTrue(LottieRules.newPlay(null, t(autoPlay = true, loop = false)))
        assertTrue(LottieRules.newPlay(t(mode = "pause"), t(mode = "play")))
        assertTrue(LottieRules.newPlay(t(mode = "play"), t(mode = "play", restart = 1)))
        assertFalse(LottieRules.newPlay(t(mode = "play"), t(mode = "play", speed = 2f)))
        assertFalse(LottieRules.newPlay(null, t()))
    }

    @Test
    fun animatorScale() {
        assertTrue(LottieRules.motionOff(0f))
        assertFalse(LottieRules.motionOff(1f))
        assertEquals(2f, LottieRules.speed(1f, 0.5f))
        assertEquals(1f, LottieRules.speed(1f, 1f))
        assertEquals(1f, LottieRules.speed(1f, 0f))
    }

    @Test
    fun keyPathsLikeLottieReactNative() {
        assertEquals(listOf("Layer", "**"), LottieRules.keyPath("Layer"))
        assertEquals(listOf("Layer", "Group", "**"), LottieRules.keyPath("Layer.Group"))
        assertEquals(listOf("**"), LottieRules.keyPath(""))
    }
}
