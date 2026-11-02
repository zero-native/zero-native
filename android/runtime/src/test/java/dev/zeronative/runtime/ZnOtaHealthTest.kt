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
    private fun launchThatDies(s: State, bundle: String, exit: (Long, Int) -> Exit, at: Long = 2_000) {
        Rules.launch(s, bundle, at - 1_000, 4242)
        Rules.atStart(s, 1, 100, at, exit)
    }

    private val hour = 60 * 60 * 1000L

    @Test fun twoUnsureDeathsBlockTheBundle() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        assertEquals(1, s.crashTimes.size)
        assertFalse(s.blocked.containsKey("app_5"))
        launchThatDies(s, "app_5", crash)
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
        assertEquals(0, s.crashTimes.size)
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
        assertEquals(0, s.crashTimes.size)
        assertEquals(listOf("launch_crashed", "watchdog_block"), s.events.map { it.kind })
        assertEquals("crash (1 of 1)", s.events[0].detail)
        assertEquals("a launch ended by a crash; last: crash", s.events[1].detail)
    }

    @Test fun theLastGoodBundleTakesThreeDeathsEvenWhenSure() {
        val s = fresh()
        Rules.healthy(s, "app_5") // ran well on this phone before
        launchThatDies(s, "app_5", sureCrash)
        assertEquals("crash (1 of 3)", s.events.last().detail)
        launchThatDies(s, "app_5", crash)
        assertTrue(s.blocked.isEmpty())
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
        assertEquals("2 launches in 24 h ended by a crash or a freeze; last: crash", s.events.last().detail)
    }

    @Test fun theBackgroundDoesNotClearTheCount() {
        val s = fresh()
        Rules.healthy(s, "app_5")
        // A crash on return from a payment app, three times, with the background in between each.
        repeat(3) { i ->
            assertTrue(s.blocked.isEmpty())
            Rules.launch(s, "app_5", 3_000L + i, 4242)
            Rules.ended(s, "app_5")
            assertNull(s.pending)
            launchThatDies(s, "app_5", sureCrash, at = 5_000L + i)
        }
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
    }

    @Test fun deathsOlderThanADayAreDropped() {
        val s = fresh()
        Rules.healthy(s, "app_5")
        launchThatDies(s, "app_5", sureCrash, at = 2_000)
        launchThatDies(s, "app_5", sureCrash, at = 2_000 + 5 * hour)
        launchThatDies(s, "app_5", sureCrash, at = 2_000 + 25 * hour) // the first one is gone
        assertEquals(2, s.crashTimes.size)
        assertTrue(s.blocked.isEmpty())
        launchThatDies(s, "app_5", sureCrash, at = 2_000 + 26 * hour)
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
    }

    @Test fun deathsInTheFutureAreDropped() {
        val s = fresh()
        launchThatDies(s, "app_5", crash, at = 100 * hour) // then the clock goes back
        launchThatDies(s, "app_5", crash, at = 2_000)
        assertEquals(listOf(2_000L), s.crashTimes)
        assertTrue(s.blocked.isEmpty())
    }

    @Test fun aDeathAfterTheBackgroundIsNotCounted() {
        val s = fresh()
        Rules.launch(s, "app_5", 1_000, 4242)
        Rules.ended(s, "app_5")
        Rules.atStart(s, 1, 100, 2_000) { _, _ -> error("nothing is pending") }
        assertEquals(0, s.crashTimes.size)
    }

    @Test fun aStartFailureCountsAsAnUnsureDeathOfTheLastGoodBundle() {
        val s = fresh()
        Rules.healthy(s, "app_5")
        assertFalse(Rules.countDeath(s, "app_5", "start failed", Rules.WATCHDOG_LIMIT, 1_000))
        assertTrue(Rules.countDeath(s, "app_5", "start failed", Rules.WATCHDOG_LIMIT, 2_000))
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
        assertNull(s.lastGood)
    }

    @Test fun aCrashMarkMustNameTheProcessAndComeAfterTheLaunch() {
        assertTrue(Rules.isCrashOf("777 5000", 777, 1_000))
        assertFalse(Rules.isCrashOf("778 5000", 777, 1_000)) // another process
        assertFalse(Rules.isCrashOf("777 500", 777, 1_000)) // an older crash of a reused pid
        assertFalse(Rules.isCrashOf(null, 777, 1_000))
        assertFalse(Rules.isCrashOf("broken", 777, 1_000))
    }

    @Test fun exitsThatAreNotTheBundlesFaultAreNotCounted() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        launchThatDies(s, "app_5", stopped) // force stop, low memory...: the count stays at 1
        assertEquals(1, s.crashTimes.size)
        assertNull(s.pending)
        launchThatDies(s, "app_5", crash)
        assertEquals(ZnOtaHealth.WATCHDOG, s.blocked["app_5"])
    }

    @Test fun aCrashOfAnotherBundleStartsTheCountAgain() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        launchThatDies(s, "app_6", crash)
        assertEquals("app_6", s.crashBundle)
        assertEquals(1, s.crashTimes.size)
        assertTrue(s.blocked.isEmpty())
    }

    @Test fun healthyMakesTheLastGoodBundleButTheVisitStaysWatched() {
        val s = fresh()
        launchThatDies(s, "app_5", crash)
        Rules.launch(s, "app_5", 3_000, 4242)
        assertTrue(Rules.healthy(s, "app_5"))
        assertFalse(Rules.healthy(s, "app_5"))
        assertEquals("app_5", s.lastGood)
        assertEquals("app_5", s.pending) // a crash after healthy counts (F4)
        assertEquals(1, s.crashTimes.size)
    }

    @Test fun aBlockedBundleNeverBecomesLastGood() {
        val s = fresh()
        Rules.block(s, "app_5", ZnOtaHealth.WATCHDOG)
        assertFalse(Rules.healthy(s, "app_5"))
        assertNull(s.lastGood)
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
        assertEquals(0, s.crashTimes.size)
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

    @Test fun anUnusableBundleIsReportedOnce() {
        val s = fresh()
        Rules.unusable(s, "app_5", "no zn-bundle.json", 1_000)
        Rules.unusable(s, "app_5", "no zn-bundle.json", 2_000)
        assertEquals(listOf("bundle_unusable"), s.events.map { it.kind })
        Rules.atStart(s, 1, 200, 3_000) { _, _ -> error("nothing is pending") } // a new APK: it may be reported again
        Rules.unusable(s, "app_5", "no zn-bundle.json", 4_000)
        assertEquals(2, s.events.count { it.kind == "bundle_unusable" })
    }

    @Test fun maskHidesPrivateData() {
        assertEquals("pay failed for ***", Rules.mask("pay failed for 9876543210"))
        assertEquals("call *** now", Rules.mask("call 98765 43210 now"))
        assertEquals("card ***", Rules.mask("card 4111-1111-1111-1111"))
        assertEquals("***@*** declined", Rules.mask("rahul@okaxis declined"))
        assertEquals("mail ***@*** bounced", Rules.mask("mail a.b+c@mail.example.com bounced"))
        assertEquals("GET https://api.example.com/v1/pay?*** failed", Rules.mask("GET https://api.example.com/v1/pay?pa=a@b&am=100 failed"))
        assertEquals("upi://pay?***", Rules.mask("upi://pay?pa=x@y&am=1.00&tr=123456"))
        assertEquals("/v1/pay?*** 500", Rules.mask("/v1/pay?id=7 500"))
        assertEquals("Authorization: Bearer ***", Rules.mask("Authorization: Bearer abc.def-123"))
    }

    @Test fun maskKeepsOrdinaryErrors() {
        for (text in listOf(
            "screen in Home: Cannot read property 'amount' of undefined",
            "amount 500 at 12:30 is too big",
            "start in main.js:12345:678: boom",
            "Why did this fail? Nobody knows",
        )) assertEquals(text, Rules.mask(text))
    }

    @Test fun maskStopsAtItsLimit() {
        assertEquals(1024, Rules.mask("x".repeat(5_000)).length)
    }

    @Test fun theStateSurvivesTheFile() {
        val s = fresh()
        Rules.block(s, "app_9", ZnOtaHealth.WATCHDOG)
        Rules.block(s, "app_3", ZnOtaHealth.ERROR)
        Rules.healthy(s, "app_4")
        Rules.launch(s, "app_8", 42, 4242)
        s.crashBundle = "app_8"
        s.crashTimes += listOf(10L, 20L)
        s.unusable += "app_2"
        Rules.event(s, "x", "app_8", "why", 7)
        Rules.event(s, "error_rollback", "app_8", "screen in Home", 8, stack = "at Home (main.js:20:5)", sha = "ab".repeat(32))
        val back = State.fromJson(s.toJson())
        assertEquals(listOf("app_9", "app_3"), back.blocked.keys.toList()) // order kept
        assertEquals("app_4", back.lastGood)
        assertEquals("app_8", back.pending)
        assertEquals(42L, back.pendingSince)
        assertEquals(4242, back.pendingPid)
        assertEquals("app_8", back.crashBundle)
        assertEquals(listOf(10L, 20L), back.crashTimes)
        assertEquals(listOf("app_2"), back.unusable)
        assertEquals(listOf("x", "app_8", "why", 7L, null, null), back.events[0].let { listOf(it.kind, it.bundle, it.detail, it.atMs, it.stack, it.sha) })
        assertEquals(listOf("at Home (main.js:20:5)", "ab".repeat(32)), back.events[1].let { listOf(it.stack, it.sha) })
    }
}
