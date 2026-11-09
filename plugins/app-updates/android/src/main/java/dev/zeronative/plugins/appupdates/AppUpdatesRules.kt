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

    enum class Launch { WAIT, OPEN, SKIP }

    /**
     * A start with UI ([AppUpdatesLaunch]): open Play's forced screen now? [answered]: the launch check's store answer
     * is in, with [critical] (0 none, 1 optional, 2 forced). Before it, this APK's saved answer [savedCritical] counts
     * only when forced (it opens at once). [playAnswered]: Play said something (a failure counts, [playAvailable] false).
     * Returns the decision and, for SKIP, why (logged).
     */
    fun launch(
        answered: Boolean,
        critical: Int,
        savedCritical: Int,
        playAnswered: Boolean,
        playAvailable: Boolean,
        immediateAllowed: Boolean,
        busy: Boolean,
    ): Pair<Launch, String> {
        val c = if (answered) critical else if (savedCritical == 2) 2 else -1
        return when {
            c == -1 -> Launch.WAIT to "waiting for the launch check's answer"
            c == 0 -> Launch.SKIP to "no store update"
            c != 2 -> Launch.SKIP to "optional update: the app's JS asks"
            !playAnswered -> Launch.WAIT to "waiting for Play"
            !playAvailable -> Launch.SKIP to "Play has no update for this phone yet"
            !immediateAllowed -> Launch.SKIP to "Play doesn't allow a forced update now"
            busy -> Launch.SKIP to "the app is busy (a payment)"
            else -> Launch.OPEN to "forced update"
        }
    }
}
