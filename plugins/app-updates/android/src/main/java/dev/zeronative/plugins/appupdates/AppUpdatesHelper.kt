package dev.zeronative.plugins.appupdates

import android.app.Activity
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import com.google.android.play.core.appupdate.AppUpdateInfo
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.appupdate.AppUpdateOptions
import com.google.android.play.core.install.InstallState
import com.google.android.play.core.install.InstallStateUpdatedListener
import com.google.android.play.core.install.model.AppUpdateType
import com.google.android.play.core.install.model.InstallStatus
import com.google.android.play.core.install.model.UpdateAvailability

/** The request code of Play's update sheet (the RN app's, kept so the app's Activity forwards the same number). */
const val UPDATE_REQUEST_CODE = 312

/**
 * Update state sent to JS: `status` is one of accepted (the user tapped Update on Play's optional sheet), declined
 * (they closed it), pending, downloading (with bytes), downloaded, failed (with errorCode), canceled.
 */
internal typealias UpdateStateCallback = (status: String, bytesDownloaded: Long, totalBytes: Long, errorCode: Int) -> Unit

/** Runs [block]; any error is logged and ignored: the update code must never stop the app. */
private inline fun <T> ignoreError(tag: String, block: () -> T): T? =
    try {
        block()
    } catch (t: Throwable) {
        Log.w(tag, "ignored error", t)
        null
    }

/** What Play says about this phone, for JS's isUpdateAvailable. */
internal data class PlayAvailability(
    val available: Boolean,
    val versionCode: Int,
    val immediateAllowed: Boolean,
    val flexibleAllowed: Boolean,
    val stalenessDays: Int?,
)

/**
 * Play Core in-app update helper, one per Activity. Ported from ZeroBill's InAppUpdateHelper (itself a port of RN's
 * InAppUpdatesHelper.kt). The same SharedPreferences file and keys as RN and ZeroBill ("app_updates": update_type,
 * update_request_priority), so a phone that updates from those apps keeps its saved forced-update request.
 */
internal class AppUpdatesHelper(
    private val activity: Activity,
    private val onState: UpdateStateCallback,
) : InstallStateUpdatedListener {

    private val appUpdateManager = AppUpdateManagerFactory.create(activity)
    private val main = Handler(Looper.getMainLooper())

    init {
        appUpdateManager.registerListener(this)
        // The download card's Restart button installs through this Activity's helper
        UpdateCard.onRestart = { completeUpdate() }
    }

    companion object {
        private const val TAG = "zn-app-updates"
        /** [availability] answers "no update" when Play hasn't answered by then. JS waits a little longer (rules.ts). */
        const val PLAY_WAIT_MS = 10_000L
        private const val PREFS = "app_updates"

        private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        /** A start was asked for and Play has not said "no update" since. */
        fun requestPending(context: Context): Boolean = prefs(context).getBoolean("update_request_priority", false)

        fun setRequestPending(context: Context, value: Boolean) {
            prefs(context).edit().putBoolean("update_request_priority", value).commit()
        }

        /**
         * The app is busy (JS setBusy: a payment, a checkout, a form), kept on disk: after Android killed the app while a
         * payment app was open, the new Activity starts before JS has restored its state. Then no install restarts the
         * app and no forced-update sheet covers it until the app says it is no longer busy (ZeroBill process-death
         * audit #2, 2026-11-06).
         */
        fun isBusy(context: Context): Boolean = prefs(context).getBoolean("busy", false)

        fun setBusy(context: Context, value: Boolean) {
            prefs(context).edit().putBoolean("busy", value).apply()
        }

        fun updateType(context: Context): Int = prefs(context).getInt("update_type", AppUpdateType.IMMEDIATE)

        fun setUpdateType(context: Context, value: Int) {
            prefs(context).edit().putInt("update_type", value).commit()
        }
    }

    private fun forced() = updateType(activity) == AppUpdateType.IMMEDIATE

    private fun startFlow(info: AppUpdateInfo) {
        appUpdateManager.startUpdateFlowForResult(info, activity, AppUpdateOptions.defaultOptions(updateType(activity)), UPDATE_REQUEST_CODE)
    }

    /** A new Activity: an update that finished downloading is installed now (RN checkAndCompleteUpdateOnColdStart). */
    fun installIfDownloaded() = ignoreError(TAG) {
        appUpdateManager.appUpdateInfo.addOnSuccessListener { info ->
            val downloaded = info.installStatus() == InstallStatus.DOWNLOADED
            when (AppUpdatesRules.coldStart(downloaded, isBusy(activity))) {
                AppUpdatesRules.ColdStart.INSTALL -> {
                    Log.d(TAG, "new Activity: an update is downloaded, installing it now")
                    appUpdateManager.completeUpdate()
                }
                // JS installs it on a later return, once the app is no longer busy
                AppUpdatesRules.ColdStart.WAIT -> Log.d(TAG, "new Activity: an update is downloaded, but the app is busy: waiting")
                AppUpdatesRules.ColdStart.NOTHING -> Unit
            }
        }.addOnFailureListener {
            Log.w(TAG, "new Activity: could not read Play's update state", it)
        }
    }

    /** Opens Play's sheet for the saved update type, when Play offers an update and a start is pending. */
    fun start() = ignoreError(TAG) {
        appUpdateManager.appUpdateInfo.addOnSuccessListener { info ->
            when (info.updateAvailability()) {
                UpdateAvailability.UPDATE_AVAILABLE -> {
                    Log.d(TAG, "Play offers version ${info.availableVersionCode()}")
                    if (requestPending(activity)) ignoreError(TAG) { startFlow(info) }
                }
                UpdateAvailability.UPDATE_NOT_AVAILABLE -> {
                    Log.d(TAG, "Play has no update")
                    setRequestPending(activity, false)
                }
                UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS -> Log.d(TAG, "Play's update is already in progress")
                else -> Log.d(TAG, "Play's update state is unknown")
            }
        }.addOnFailureListener {
            Log.w(TAG, "start: could not ask Play", it)
        }
    }

    /** Every time the app comes to the front. */
    fun onResume() = ignoreError(TAG) {
        appUpdateManager.appUpdateInfo.addOnSuccessListener { info ->
            val action = AppUpdatesRules.resume(
                downloaded = info.installStatus() == InstallStatus.DOWNLOADED,
                forced = forced(),
                busy = isBusy(activity),
                playFlowInProgress = info.updateAvailability() == UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS,
            )
            when (action) {
                // An optional update that finished downloading while the app was away: JS installs it (not while busy)
                AppUpdatesRules.Resume.SEND_DOWNLOADED -> emitState("downloaded")
                AppUpdatesRules.Resume.REOPEN -> ignoreError(TAG) {
                    Log.d(TAG, "back in front: the forced update is still open in Play, opening it again")
                    startFlow(info)
                }
                AppUpdatesRules.Resume.NOTHING -> Unit
            }
        }.addOnFailureListener {
            Log.w(TAG, "back in front: could not read Play's update state", it)
        }
    }

    /** The Activity's result for [UPDATE_REQUEST_CODE] (the app's Activity forwards it). */
    fun onActivityResult(resultCode: Int) = ignoreError(TAG) {
        Log.d(TAG, "Play's sheet closed, resultCode $resultCode")
        when (AppUpdatesRules.result(forced(), resultCode == Activity.RESULT_OK)) {
            AppUpdatesRules.Result.REOPEN -> start()
            AppUpdatesRules.Result.ACCEPTED -> emitState("accepted")
            AppUpdatesRules.Result.DECLINED -> {
                setRequestPending(activity, false)
                emitState("declined")
            }
            AppUpdatesRules.Result.NOTHING -> Unit
        }
    }

    /**
     * Asks Play without waiting on any thread. [answer] runs once: with Play's answer, with "no update" on an error, or
     * with "no update" after [PLAY_WAIT_MS] if Play hasn't answered (a late answer is then ignored).
     * Never `Tasks.await` here: on zero-native's shared call pool (2 threads) a Play answer that doesn't come holds a
     * thread for good, and two of them stop every fetch in the app (docs/second-opinions.md #221).
     */
    fun availability(answer: (PlayAvailability) -> Unit) {
        val none = PlayAvailability(false, 0, false, false, null)
        val done = AtomicBoolean(false)
        val timeout = Runnable {
            if (done.compareAndSet(false, true)) {
                Log.w(TAG, "no answer from Play in $PLAY_WAIT_MS ms; answering no update")
                answer(none)
            }
        }
        fun finish(a: PlayAvailability) {
            if (!done.compareAndSet(false, true)) {
                Log.w(TAG, "Play answered after the time limit; ignored")
                return
            }
            main.removeCallbacks(timeout)
            answer(a)
        }
        main.postDelayed(timeout, PLAY_WAIT_MS)
        try {
            appUpdateManager.appUpdateInfo.addOnSuccessListener { info ->
                val read = ignoreError(TAG) {
                    // Clear a pending forced-update request only when Play answers "no update" (RN hardening F10): a
                    // failed check (offline) must not clear it, or the forced update is not opened again
                    if (info.updateAvailability() == UpdateAvailability.UPDATE_NOT_AVAILABLE) setRequestPending(activity, false)
                    PlayAvailability(
                        available = info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE,
                        versionCode = info.availableVersionCode(),
                        immediateAllowed = info.isUpdateTypeAllowed(AppUpdateType.IMMEDIATE),
                        flexibleAllowed = info.isUpdateTypeAllowed(AppUpdateType.FLEXIBLE),
                        stalenessDays = info.clientVersionStalenessDays(),
                    )
                }
                finish(read ?: none)
            }.addOnFailureListener {
                Log.w(TAG, "could not ask Play for an update", it)
                finish(none)
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not ask Play for an update", e)
            finish(none)
        }
    }

    fun completeUpdate() = ignoreError(TAG) {
        appUpdateManager.completeUpdate()
    }

    /** Stops install-state callbacks (the module makes a new helper when the Activity is made again). */
    fun dispose() {
        ignoreError(TAG) { appUpdateManager.unregisterListener(this) }
        UpdateCard.onRestart = null
    }

    override fun onStateUpdate(state: InstallState) {
        when (state.installStatus()) {
            InstallStatus.PENDING -> emitState("pending")
            InstallStatus.DOWNLOADING -> emitState("downloading", state.bytesDownloaded(), state.totalBytesToDownload())
            InstallStatus.DOWNLOADED -> emitState("downloaded")
            InstallStatus.FAILED -> emitState("failed", errorCode = state.installErrorCode())
            InstallStatus.CANCELED -> emitState("canceled")
            else -> Unit
        }
    }

    private fun emitState(status: String, bytesDownloaded: Long = 0L, totalBytes: Long = 0L, errorCode: Int = 0) {
        // The card follows Play's download by itself (no JS needed, survives a JS restart)
        UpdateCard.onState(status, bytesDownloaded, totalBytes)
        try {
            onState(status, bytesDownloaded, totalBytes, errorCode)
        } catch (e: Exception) {
            Log.w(TAG, "could not send update state '$status' to JS", e)
        }
    }
}
