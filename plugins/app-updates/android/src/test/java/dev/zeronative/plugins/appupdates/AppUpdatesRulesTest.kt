package dev.zeronative.plugins.appupdates

import dev.zeronative.plugins.appupdates.AppUpdatesRules.ColdStart
import dev.zeronative.plugins.appupdates.AppUpdatesRules.Launch
import dev.zeronative.plugins.appupdates.AppUpdatesRules.Resume
import dev.zeronative.plugins.appupdates.AppUpdatesRules.Result
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AppUpdatesRulesTest {
    @Test
    fun aNewActivityInstallsADownloadedUpdateUnlessBusy() {
        assertEquals(ColdStart.INSTALL, AppUpdatesRules.coldStart(downloaded = true, busy = false))
        assertEquals(ColdStart.WAIT, AppUpdatesRules.coldStart(downloaded = true, busy = true))
        assertEquals(ColdStart.NOTHING, AppUpdatesRules.coldStart(downloaded = false, busy = false))
    }

    @Test
    fun backInFrontReopensOnlyAForcedUpdateThatPlayStillHasOpen() {
        // A downloaded optional update goes to JS, busy or not (JS waits for "not busy")
        assertEquals(Resume.SEND_DOWNLOADED, AppUpdatesRules.resume(downloaded = true, forced = false, busy = true, playFlowInProgress = false))
        assertEquals(Resume.REOPEN, AppUpdatesRules.resume(downloaded = false, forced = true, busy = false, playFlowInProgress = true))
        // Not on the way back from a payment app
        assertEquals(Resume.NOTHING, AppUpdatesRules.resume(downloaded = false, forced = true, busy = true, playFlowInProgress = true))
        // An optional update is never opened again (the user tapped Update twice in RN)
        assertEquals(Resume.NOTHING, AppUpdatesRules.resume(downloaded = false, forced = false, busy = false, playFlowInProgress = true))
        assertEquals(Resume.NOTHING, AppUpdatesRules.resume(downloaded = false, forced = true, busy = false, playFlowInProgress = false))
    }

    @Test
    fun cancellingAForcedUpdateOpensItAgain() {
        assertEquals(Result.REOPEN, AppUpdatesRules.result(forced = true, ok = false))
        assertEquals(Result.NOTHING, AppUpdatesRules.result(forced = true, ok = true))
        assertEquals(Result.ACCEPTED, AppUpdatesRules.result(forced = false, ok = true))
        assertEquals(Result.DECLINED, AppUpdatesRules.result(forced = false, ok = false))
    }

    @Test
    fun theCardFollowsTheDownload() {
        var s = UpdateCardState()
        assertFalse(s.visible(busy = false))
        s = s.onStatus("accepted", 0, 0)
        assertTrue(s.visible(busy = false))
        assertNull(s.progress)
        s = s.onStatus("downloading", 50, 200)
        assertEquals(0.25f, s.progress!!, 0.0001f)
        // ✕ hides it while downloading; more progress keeps it hidden
        s = s.hide().onStatus("downloading", 100, 200)
        assertFalse(s.visible(busy = false))
        // Ready: shown again after ✕, but never while busy
        s = s.onStatus("downloaded", 0, 0)
        assertTrue(s.visible(busy = false))
        assertFalse(s.visible(busy = true))
        // A late progress event keeps "ready"
        assertEquals(UpdateCardState.Phase.DOWNLOADED, s.onStatus("downloading", 1, 2).phase)
        assertEquals(UpdateCardState(), s.onStatus("failed", 0, 0))
    }

    private fun launch(
        answered: Boolean = true, critical: Int = 2, saved: Int = 0, playAnswered: Boolean = true,
        available: Boolean = true, immediate: Boolean = true, busy: Boolean = false,
    ) = AppUpdatesRules.launch(answered, critical, saved, playAnswered, available, immediate, busy).first

    @Test
    fun atLaunchPlaysForcedScreenOpensOnlyForAForcedAnswerThatPlayCanServe() {
        assertEquals(Launch.OPEN, launch())
        // Both answers are needed: ours, then Play's
        assertEquals(Launch.WAIT, launch(answered = false))
        assertEquals(Launch.WAIT, launch(playAnswered = false))
        // A saved forced answer opens as soon as Play answers, without waiting for our check
        assertEquals(Launch.OPEN, launch(answered = false, critical = 0, saved = 2))
        // ...but a saved optional one waits for our check
        assertEquals(Launch.WAIT, launch(answered = false, saved = 1))
        // The fresh answer wins over the saved one (a rule taken back)
        assertEquals(Launch.SKIP, launch(critical = 0, saved = 2))
        // Optional stays with JS; nothing when Play has none, can't force it now, or the app is busy (a payment)
        assertEquals(Launch.SKIP, launch(critical = 1))
        assertEquals(Launch.SKIP, launch(available = false))
        assertEquals(Launch.SKIP, launch(immediate = false))
        assertEquals(Launch.SKIP, launch(busy = true))
    }
}
