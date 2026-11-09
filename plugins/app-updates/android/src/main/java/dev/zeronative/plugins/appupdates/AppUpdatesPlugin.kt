package dev.zeronative.plugins.appupdates

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.google.android.play.core.install.model.AppUpdateType
import dev.zeronative.runtime.ZnActivity
import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnOta
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import dev.zeronative.runtime.boolean
import org.json.JSONObject

/**
 * Store updates: Google Play's in-app updates (README: plugins/app-updates). Besides the JS functions, the plugin hears
 * the app's Activity, so a forced (IMMEDIATE) update cannot be skipped:
 * - a new Activity: an update that finished downloading is installed (not while the app is busy)
 * - every time the app comes to the front: a forced update that Play still has open is opened again
 * - a forced update cancelled: it is asked for again (onActivityResult)
 * Optional (FLEXIBLE) updates are never opened again: their state goes to JS as `state` events; JS installs a
 * downloaded update when the user comes back.
 *
 * A forced update at launch opens natively, before the app's first screen ([AppUpdatesLaunch], zn's launch gate):
 * when the zn-updates server's store answer says forced and Play offers the update. Needs OTA on (the answer comes with
 * the OTA check). One store launcher per app: the last plugin that sets one wins.
 *
 * The app's Activity must pass its onActivityResult to [AppUpdatesModule.onActivityResult] (Play answers there).
 *
 * [showCard]: a small native card at the top of the screen follows the optional download (progress, then "Restart").
 * Off by default: an app can draw its own from the `state` events instead. [cardTexts] changes its words and colour.
 */
class AppUpdatesPlugin(
    private val showCard: Boolean = false,
    private val cardTexts: UpdateCardTexts = UpdateCardTexts(),
) : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        UpdateCard.configure(showCard, cardTexts)
        r.module(AppUpdatesModule(r.context))
        ZnOta.setStoreLauncher(AppUpdatesLaunch(r.context))
        r.activityEvents(object : ZnActivityEvents {
            override fun onFront() = AppUpdatesModule.onFront()
        })
    }
}

/**
 * Module "AppUpdates" version 1:
 * - isUpdateAvailable: `{ available, versionCode, immediateAllowed, flexibleAllowed, stalenessDays? }`; any failure
 *   answers `available: false`.
 * - start `{ flexible }`: asks Play to open its sheet (true = optional, false = forced) when Play offers an update.
 *   `{ ok }`: true when Play was asked. Never rejects.
 * - complete: Play installs the downloaded update and restarts the app. `{ ok }`.
 * - setBusy `{ busy }`: a payment or form is open: nothing re-opens or installs, the card hides. Kept on disk.
 * - openStore: the app's Play listing (Play Store app, else the web page). `{ opened }`.
 * - event `state`: `{ status, bytesDownloaded, totalBytes, errorCode }`.
 */
class AppUpdatesModule(private val context: Context) : ZnModuleBase("AppUpdates", version = 1) {
    private var helper: AppUpdatesHelper? = null
    private var helperActivity: Activity? = null

    init {
        instance = this

        function("isUpdateAvailable") { call ->
            val activity = ZnActivity.current ?: return@function call.resolve(JSONObject().put("available", false).put("versionCode", 0))
            val a = try {
                helperFor(activity).availability()
            } catch (e: Throwable) {
                Log.w(TAG, "isUpdateAvailable failed", e)
                PlayAvailability(false, 0, false, false, null)
            }
            val out = JSONObject()
                .put("available", a.available)
                .put("versionCode", a.versionCode)
                .put("immediateAllowed", a.immediateAllowed)
                .put("flexibleAllowed", a.flexibleAllowed)
            a.stalenessDays?.let { out.put("stalenessDays", it) }
            call.resolve(out)
        }

        function("start", onMain = true) { call ->
            val activity = ZnActivity.current ?: return@function call.resolve(ok(false))
            try {
                val flexible = call.boolean("flexible")
                // The launch already opened Play's forced screen for this answer: a second start would open it twice.
                if (!flexible && AppUpdatesLaunch.openedRecently()) {
                    Log.i(TAG, "start: the forced screen was opened at launch, nothing to do")
                    return@function call.resolve(ok(true))
                }
                AppUpdatesHelper.setUpdateType(activity, if (flexible) AppUpdateType.FLEXIBLE else AppUpdateType.IMMEDIATE)
                AppUpdatesHelper.setRequestPending(activity, true)
                helperFor(activity).start()
                call.resolve(ok(true))
            } catch (e: Throwable) {
                Log.w(TAG, "start failed", e)
                call.resolve(ok(false))
            }
        }

        function("complete", onMain = true) { call ->
            val activity = ZnActivity.current ?: return@function call.resolve(ok(false))
            try {
                helperFor(activity).completeUpdate()
                call.resolve(ok(true))
            } catch (e: Throwable) {
                Log.w(TAG, "complete failed", e)
                call.resolve(ok(false))
            }
        }

        function("setBusy", onMain = true) { call ->
            val busy = call.boolean("busy")
            UpdateCard.setBusy(busy)
            AppUpdatesHelper.setBusy(context, busy)
            call.resolve(null)
        }

        function("openStore", onMain = true) { call ->
            call.resolve(JSONObject().put("opened", openPlayListing()))
        }
    }

    /** The Play Store app's page for this app; the web page when there is no Play Store app. */
    private fun openPlayListing(): Boolean {
        val from: Context = ZnActivity.current ?: context
        val pkg = context.packageName
        val newTask = if (from is Activity) 0 else Intent.FLAG_ACTIVITY_NEW_TASK
        for (uri in listOf("market://details?id=$pkg", "https://play.google.com/store/apps/details?id=$pkg")) {
            try {
                from.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri)).addFlags(newTask))
                return true
            } catch (_: ActivityNotFoundException) {
                // Try the next one
            } catch (e: Exception) {
                Log.w(TAG, "openStore: could not open $uri", e)
            }
        }
        return false
    }

    private fun ok(value: Boolean) = JSONObject().put("ok", value)

    /**
     * One helper per Activity: after the Activity is made again, the old one would start flows on a destroyed Activity.
     * A new Activity also installs an update that finished downloading. Synchronized (RN hardening F10): it runs on the
     * main thread (front, results) and on the I/O pool (isUpdateAvailable); two threads at once made two helpers, one
     * never disposed, so every update state reached JS twice.
     */
    @Synchronized
    private fun helperFor(activity: Activity): AppUpdatesHelper {
        val current = helper
        if (current != null && helperActivity === activity) return current

        current?.dispose()
        val created = AppUpdatesHelper(activity) { status, bytesDownloaded, totalBytes, errorCode ->
            emit(
                "state",
                JSONObject()
                    .put("status", status)
                    .put("bytesDownloaded", bytesDownloaded)
                    .put("totalBytes", totalBytes)
                    .put("errorCode", errorCode),
            )
        }
        helper = created
        helperActivity = activity
        created.installIfDownloaded()
        return created
    }

    private fun front() {
        val activity = ZnActivity.current ?: return
        UpdateCard.attach(activity)
        try {
            helperFor(activity).onResume()
        } catch (e: Throwable) {
            Log.w(TAG, "front: update check failed", e)
        }
    }

    private fun result(activity: Activity, resultCode: Int) {
        try {
            helperFor(activity).onActivityResult(resultCode)
        } catch (e: Throwable) {
            Log.w(TAG, "onActivityResult: update handling failed", e)
        }
    }

    companion object {
        private const val TAG = "zn-app-updates"

        @Volatile private var instance: AppUpdatesModule? = null

        /** The app came to the front (main thread). */
        internal fun onFront() {
            instance?.front()
        }

        /**
         * The app's Activity calls this from its onActivityResult. True when it was Play's update sheet
         * ([UPDATE_REQUEST_CODE]): the Activity then has nothing else to do with it.
         */
        @JvmStatic
        fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int): Boolean {
            if (requestCode != UPDATE_REQUEST_CODE) return false
            instance?.result(activity, resultCode)
            return true
        }
    }
}
