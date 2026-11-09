package dev.zeronative.plugins.appupdates

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.UpdateAvailability
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnOta
import dev.zeronative.runtime.ZnStoreLauncher
import dev.zeronative.runtime.ZnStoreUpdate

/**
 * A forced store update at launch, before the app's first screen ([ZnStoreLauncher]; from JS alone it came seconds
 * after the app opened, ZeroBill 2026-11-10). At each start with UI, zn's launch gate calls [onLaunch]: Play is asked at
 * once, in parallel with zn's update check. When the store answer is forced (the server's; before it comes, this APK's
 * saved one) and Play offers an update that may be forced, Play's forced screen opens now, while the launch screen is
 * still up ([AppUpdatesRules.launch]). Anything else: the app opens, and JS handles optional updates and returns.
 * It sets the same prefs as JS's start(false), so a cancelled forced screen opens again. Main thread only.
 */
internal class AppUpdatesLaunch(private val context: Context) : ZnStoreLauncher {
    private val main = Handler(Looper.getMainLooper())
    private val manager by lazy { AppUpdateManagerFactory.create(context) }

    /** This launch's number: a late answer from an earlier launch is dropped. */
    private var launch = 0
    private var tapAt = 0L
    private var saved: ZnStoreUpdate? = null
    private var answer: ZnStoreUpdate? = null
    private var answered = false
    private var info: AppUpdateInfo? = null
    private var playAnswered = false
    private var over = false
    private var activityTries = 0

    override fun onLaunch(saved: ZnStoreUpdate?) {
        val id = ++launch
        tapAt = SystemClock.uptimeMillis()
        this.saved = saved
        answer = null
        answered = false
        info = null
        playAnswered = false
        over = false
        activityTries = 0
        try {
            manager.appUpdateInfo
                .addOnSuccessListener { i ->
                    if (id != launch) return@addOnSuccessListener
                    Log.i(TAG, "launch: Play answered in ${ms()} ms: availability ${i.updateAvailability()}, version ${i.availableVersionCode()}")
                    info = i
                    playAnswered = true
                    decide()
                }
                .addOnFailureListener { e ->
                    if (id != launch) return@addOnFailureListener
                    Log.w(TAG, "launch: Play failed in ${ms()} ms", e)
                    playAnswered = true
                    decide()
                }
        } catch (t: Throwable) {
            Log.w(TAG, "launch: could not ask Play", t)
            playAnswered = true
            decide()
        }
    }

    override fun onLaunchAnswer(answer: ZnStoreUpdate?) {
        Log.i(TAG, "launch: the check's store answer in ${ms()} ms: ${answer?.let { "critical ${it.critical}, version ${it.version}" } ?: "no update"}")
        this.answer = answer
        answered = true
        decide()
    }

    /**
     * Called from Play's listeners and a timer, outside any catch: an error here must never take the app down. At worst
     * the app opens as usual and JS handles the update.
     */
    private fun decide() {
        if (over) return
        try {
            decideNow()
        } catch (t: Throwable) {
            Log.w(TAG, "launch: failed, the app opens as usual", t)
            if (!over) done(false, "failed: ${t.javaClass.simpleName}")
        }
    }

    private fun decideNow() {
        val i = info
        val (what, why) = AppUpdatesRules.launch(
            answered = answered,
            critical = answer?.critical ?: 0,
            savedCritical = saved?.critical ?: 0,
            playAnswered = playAnswered,
            playAvailable = i?.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE,
            immediateAllowed = i?.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE) == true,
            busy = AppUpdatesHelper.isBusy(context),
        )
        when (what) {
            AppUpdatesRules.Launch.WAIT -> return
            AppUpdatesRules.Launch.SKIP -> return done(false, why)
            AppUpdatesRules.Launch.OPEN -> Unit
        }
        val activity = ZnActivity.current
        if (i == null || activity == null || activity.isFinishing) {
            // The Activity attaches right after the gate starts: try again shortly, for a short while.
            if (i == null || ++activityTries > ACTIVITY_TRIES) return done(false, "no Activity")
            main.postDelayed({ decide() }, ACTIVITY_RETRY_MS)
            return
        }
        try {
            AppUpdatesHelper.setUpdateType(context, AppUpdateType.IMMEDIATE)
            AppUpdatesHelper.setRequestPending(context, true)
            val started = manager.startUpdateFlowForResult(i, activity, AppUpdateOptions.defaultOptions(AppUpdateType.IMMEDIATE), UPDATE_REQUEST_CODE)
            if (!started) return done(false, "Play refused to start the forced screen")
            openedAt = SystemClock.elapsedRealtime()
            Log.i(TAG, "launch: forced update ${(if (answered) answer else saved)?.version}: Play's screen opens ${ms()} ms after the launch")
            done(true, "opened")
        } catch (t: Throwable) {
            Log.w(TAG, "launch: could not start Play's forced screen", t)
            done(false, "Play's forced screen failed to start")
        }
    }

    private fun done(opened: Boolean, why: String) {
        over = true
        if (!opened) Log.i(TAG, "launch: $why (${ms()} ms)")
        ZnOta.storeLaunchDone(opened, why)
    }

    private fun ms() = SystemClock.uptimeMillis() - tapAt

    companion object {
        private const val TAG = "zn-app-updates"
        private const val ACTIVITY_TRIES = 30
        private const val ACTIVITY_RETRY_MS = 100L
        /** A forced start from JS this soon after this one opened Play's screen does nothing (the same update). */
        private const val JS_SKIP_MS = 10_000L

        /** elapsedRealtime when this opened Play's forced screen (0: never in this process). */
        @Volatile private var openedAt = 0L

        fun openedRecently(): Boolean = openedAt != 0L && SystemClock.elapsedRealtime() - openedAt < JS_SKIP_MS
    }
}
