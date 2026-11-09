package dev.zeronative.plugins.appupdates

/**
 * The helper's decisions as plain functions (no Play types), so a JVM unit test checks them
 * (AppUpdatesRulesTest). The behaviour is ZeroBill's tested one, unchanged.
 */
internal object AppUpdatesRules {
    enum class ColdStart { INSTALL, WAIT, NOTHING }
    enum class Resume { SEND_DOWNLOADED, REOPEN, NOTHING }
    enum class Result { REOPEN, NOTHING, ACCEPTED, DECLINED }

    /** A new Activity: a downloaded update installs now, unless the app is busy (JS installs it on a later return). */
    fun coldStart(downloaded: Boolean, busy: Boolean): ColdStart = when {
        !downloaded -> ColdStart.NOTHING
        busy -> ColdStart.WAIT
        else -> ColdStart.INSTALL
    }

    /**
     * The app came to the front. A downloaded optional update: JS hears "downloaded" and installs it (not while busy).
     * Only a forced update that Play still has open is opened again; an optional one is downloading in the background,
     * and opening Play's sheet again made the user tap Update twice (RN phone pass 2026-10-20). Never on the way back
     * from a payment app (busy): the forced sheet opens again at the first return after the payment.
     */
    fun resume(downloaded: Boolean, forced: Boolean, busy: Boolean, playFlowInProgress: Boolean): Resume = when {
        downloaded -> Resume.SEND_DOWNLOADED
        !forced || busy -> Resume.NOTHING
        playFlowInProgress -> Resume.REOPEN
        else -> Resume.NOTHING
    }

    /**
     * Play's sheet closed. Forced: cancelling opens it again. Optional: Update = the download starts in the background;
     * closing = the user's choice, not asked again until the next check.
     */
    fun result(forced: Boolean, ok: Boolean): Result = when {
        forced -> if (ok) Result.NOTHING else Result.REOPEN
        ok -> Result.ACCEPTED
        else -> Result.DECLINED
    }
}
