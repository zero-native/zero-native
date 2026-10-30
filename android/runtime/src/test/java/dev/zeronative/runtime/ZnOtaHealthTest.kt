package dev.zeronative.runtime

import dev.zeronative.runtime.ZnOtaHealth.Exit
import dev.zeronative.runtime.ZnOtaHealth.Rules
import dev.zeronative.runtime.ZnOtaHealth.State
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The OTA safety nets' rules (ZnOtaHealth.Rules, step 4.7, docs/ota.md §3.6): the launch watchdog, blocks, the APK, the fuse. */
class ZnOtaHealthTest {
    /** A death Android can't explain (Android < 11, no exit record, a freeze): two in a row block. */
    private val crash: (Long, Int) -> Exit = { _, _ -> Exit.Counts("ended while on screen", sure = false) }
    /** Android's exit record says it crashed (Android 11+): one blocks. */
    private val sureCrash: (Long, Int) -> Exit = { _, _ -> Exit.Counts("crash", sure = true) }
    private val stopped: (Long, Int) -> Exit = { _, _ -> Exit.Ignored("exit reason 10") }

    /** A state as after a first start on APK (1, 100). */
    private fun fresh() = State().also { Rules.atStart(it, 1, 100, 0) { _, _ -> error("nothing is pending") } }

    /** One process: a UI launch of [bundle] that dies, then the next start judges it with [exit]. */
    private fun launchThatDies(s: State, bundle: String, exit: (Long, Int) -> Exit) {
        Rules.launch(s, bundle, 1_000, 4242)
        Rules.atStart(s, 1, 100, 2_000, exit)
    }

    @Test fun twoCrashedLaunchesInARowBlockTheBundle() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        assertEquals(1, s.crashes)
        assertFalse(s.blocked.containsKey("app_5"))
        launchThatDies(s, "app_5", crash)
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
        assertEquals(0, s.crashes)
        assertEquals(listOf("launch_crashed", "launch_crashed", "watchdog_block"), s.events.map { it.kind })
    }

    @Test fun thePendingLaunchIsJudgedByItsOwnProcess() {
        val s = fresh()
        Rules.launch(s, "app_5", 1_000, 777)
        var asked: Pair<Long, Int>? = null
        Rules.atStart(s, 1, 100, 2_000) { since, pid -> asked = since to pid; Exit.Counts("crash", sure = false) }
        assertEquals(1_000L to 777, asked)
    }

    @Test fun oneSureCrashBlocksAtOnce() {
        val s = fresh()
        launchThatDies(s, "app_5", sureCrash)
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
        assertEquals(0, s.crashes)
        assertEquals(listOf("launch_crashed", "watchdog_block"), s.events.map { it.kind })
        assertEquals("crash (1 of 1)", s.events[0].detail)
        assertEquals("a launch ended by a crash; last: crash", s.events[1].detail)
    }

    @Test fun theLastGoodBundleKeepsTwoCrashesEvenWhenSure() {
        val s = fresh()
        Rules.healthy(s, "app_5") // ran well on this phone before
        launchThatDies(s, "app_5", sureCrash)
        assertTrue(s.blocked.isEmpty())
        assertEquals("crash (1 of 2)", s.events.last().detail)
        launchThatDies(s, "app_5", sureCrash)
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
        assertNull(s.lastGood)
    }

    @Test fun errorsOfTheLastGoodBundleAreOnlyReported() {
        val s = fresh()
        assertTrue(Rules.errorsRollBack(s, "app_5")) // new on this phone: on trial
        Rules.healthy(s, "app_5")
        assertFalse(Rules.errorsRollBack(s, "app_5")) // ran well here before
        assertTrue(Rules.errorsRollBack(s, "app_6")) // a newer bundle is on trial again
        Rules.healthy(s, "app_6")
        assertTrue(Rules.errorsRollBack(s, "app_5")) // no longer the last good one
        Rules.block(s, "app_6", ZnOtaHealth.WATCHDOG)
        assertTrue(Rules.errorsRollBack(s, "app_6")) // a block forgets it as last good
    }

    @Test fun aSureCrashAfterAnUnsureOneBlocks() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        assertTrue(s.blocked.isEmpty())
        launchThatDies(s, "app_5", sureCrash)
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
        assertEquals("2 launches in a row ended by a crash or a freeze; last: crash", s.events.last().detail)
    }

    @Test fun aNormalExitInBetweenResetsTheCount() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        Rules.launch(s, "app_5", 3_000, 4242)
        Rules.ended(s, "app_5") // went to the background: a good launch
        assertNull(s.pending)
        launchThatDies(s, "app_5", crash)
        assertEquals(1, s.crashes)
        assertTrue(s.blocked.isEmpty())
    }

    @Test fun exitsThatAreNotTheBundlesFaultAreNotCounted() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        launchThatDies(s, "app_5", stopped) // force stop, low memory...: the count stays at 1
        assertEquals(1, s.crashes)
        assertNull(s.pending)
        launchThatDies(s, "app_5", crash)
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
    }

    @Test fun aCrashOfAnotherBundleStartsTheCountAgain() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        launchThatDies(s, "app_6", crash)
        assertEquals("app_6", s.crashBundle)
        assertEquals(1, s.crashes)
        assertTrue(s.blocked.isEmpty())
    }

    @Test fun healthyMakesTheLastGoodBundleAndClearsTheCount() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        Rules.launch(s, "app_5", 3_000, 4242)
        assertTrue(Rules.healthy(s, "app_5"))
        assertFalse(Rules.healthy(s, "app_5"))
        assertEquals("app_5", s.lastGood)
        assertNull(s.pending)
        assertEquals(0, s.crashes)
    }

    @Test fun blockingForgetsTheBundleAsLastGoodAndErrorBlocksStay() {
        val s = fresh()
        Rules.healthy(s, "app_5")
        Rules.block(s, "app_5", ZnOtaHealth.ERROR)
        assertNull(s.lastGood)
        Rules.block(s, "app_5", ZnOtaHealth.WATCHDOG) // never downgraded
        assertEquals(ZnOtaHealth.ERROR, s.blocked["app_5"])
    }

    @Test fun aNewApkClearsWatchdogBlocksNotErrorBlocks() {
        val s = fresh()
        Rules.block(s, "app_5", ZnOtaHealth.WATCHDOG)
        Rules.block(s, "app_6", ZnOtaHealth.ERROR)
        s.guardFails = 2
        launchThatDies(s, "app_7", crash)
        Rules.launch(s, "app_7", 3_000, 4242)
        assertFalse(Rules.atStart(s, 1, 100, 4_000, stopped)) // the same APK
        assertTrue(Rules.atStart(s, 1, 200, 5_000) { _, _ -> error("a new APK forgets what was pending") }) // reinstalled: new install time
        assertEquals(mapOf("app_6" to ZnOtaHealth.ERROR), s.blocked.toMap())
        assertEquals(0, s.crashes)
        assertEquals(0, s.guardFails)
        assertEquals("apk_changed", s.events.last().kind)
    }

    @Test fun theFirstStartEverIsNotANewApk() {
        val s = State()
        assertFalse(Rules.atStart(s, 7, 100, 0) { _, _ -> error("nothing is pending") })
        assertEquals(7L, s.apkVersion)
        assertTrue(s.events.isEmpty())
    }

    @Test fun twoFailedStartUpsBlowTheFuse() {
        val s = fresh()
        assertFalse(Rules.guardFailed(s))
        assertTrue(Rules.guardFailed(s))
        assertTrue(Rules.fuseBlown(s))
    }

    @Test fun blockedAndEventsAreBounded() {
        val s = fresh()
        repeat(Rules.MAX_BLOCKED + 3) { Rules.block(s, "app_$it", ZnOtaHealth.ERROR) }
        assertEquals(Rules.MAX_BLOCKED, s.blocked.size)
        assertFalse(s.blocked.containsKey("app_0")) // the oldest go first
        repeat(Rules.MAX_EVENTS + 5) { Rules.event(s, "e$it", null, null, it.toLong()) }
        assertEquals(Rules.MAX_EVENTS, s.events.size)
        assertEquals("e5", s.events.first().kind)
    }

    @Test fun theStateSurvivesTheFile() {
        val s = fresh()
        Rules.block(s, "app_9", ZnOtaHealth.WATCHDOG)
        Rules.block(s, "app_3", ZnOtaHealth.ERROR)
        Rules.healthy(s, "app_4")
        Rules.launch(s, "app_8", 42, 4242)
        Rules.event(s, "x", "app_8", "why", 7)
        Rules.event(s, "error_rollback", "app_8", "screen in Home", 8, stack = "at Home (main.js:20:5)", sha = "ab".repeat(32))
        val back = State.fromJson(s.toJson())
        assertEquals(listOf("app_9", "app_3"), back.blocked.keys.toList()) // order kept
        assertEquals("app_4", back.lastGood)
        assertEquals("app_8", back.pending)
        assertEquals(42L, back.pendingSince)
        assertEquals(4242, back.pendingPid)
        assertEquals(listOf("x", "app_8", "why", 7L, null, null), back.events[0].let { listOf(it.kind, it.bundle, it.detail, it.atMs, it.stack, it.sha) })
        assertEquals(listOf("at Home (main.js:20:5)", "ab".repeat(32)), back.events[1].let { listOf(it.stack, it.sha) })
    }
}
