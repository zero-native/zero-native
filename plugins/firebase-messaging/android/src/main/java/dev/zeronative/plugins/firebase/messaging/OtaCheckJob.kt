package dev.zeronative.plugins.firebase.messaging

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.zeronative.runtime.ZnOta
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * The OTA check a `zn_ota=check` push asks for (PushRules.OTA_KEY), as a WorkManager job: it runs core's normal check
 * ([ZnOta.check]) once the phone is online, after a random wait of 0 .. `zn_ota_delay_ms`, so a million phones don't ask
 * the server in the same minute. Like a check at a start, it only downloads and installs: the new bundle runs from the
 * next cold start (or `Updates.applyNow()`). Nothing is applied here.
 *
 * One job at a time ([NAME], KEEP): a second push while a job waits changes nothing, so pushes can't keep moving it
 * further away. When it runs, it gets whatever is newest. A check that failed on the network runs again (WorkManager's
 * back-off), at most [PushRules.OTA_MAX_RUNS] runs in all; after that the next start checks as always.
 */
class OtaCheckJob(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        if (ZnOta.appAndChannel() == null) {
            Log.i(TAG, "OTA check job: OTA is off in this app (ZnOta not configured); nothing to do")
            return Result.success()
        }
        val run = runAttemptCount + 1
        Log.i(TAG, "OTA check job: run $run of ${PushRules.OTA_MAX_RUNS}")
        val done = CountDownLatch(1)
        var answer: JSONObject? = null
        ZnOta.check { r ->
            answer = r
            done.countDown()
        }
        if (!done.await(PushRules.OTA_WAIT_MS, TimeUnit.MILLISECONDS)) {
            // The check goes on in ZnOta's own thread while the process lives; a cut download resumes at the next check.
            return again(run, "no answer within ${PushRules.OTA_WAIT_MS / 60_000} min")
        }
        val r = answer ?: JSONObject()
        val reason = r.optString("reason")
        val error = r.optString("error").ifEmpty { null }
        Log.i(TAG, "OTA check job: ${r.optString("action")} $reason${r.optString("bundle").let { if (it.isEmpty()) "" else " $it" }}${error?.let { " ($it)" } ?: ""}")
        return if (PushRules.otaRetry(reason, error)) again(run, error ?: reason) else Result.success()
    }

    private fun again(run: Int, why: String): Result {
        if (run < PushRules.OTA_MAX_RUNS) {
            Log.w(TAG, "OTA check job: run $run failed ($why); WorkManager runs it again later")
            return Result.retry()
        }
        // Success, not failure: nothing waits on this job, and the app checks again at its next start.
        Log.w(TAG, "OTA check job: run $run failed ($why); giving up, the next start checks again")
        return Result.success()
    }

    companion object {
        private const val TAG = "zn-push"
        /** WorkManager's unique name: one OTA check job at a time. */
        const val NAME = "zn-ota-push-check"
        private const val BACKOFF_MS = 30_000L

        /** Schedules the job for a `zn_ota=check` message, unless one already waits (then it changes nothing). */
        fun schedule(context: Context, data: Map<String, String>, messageId: String?) {
            val wm = WorkManager.getInstance(context.applicationContext)
            // Only for the log: KEEP below already keeps a waiting job. This thread is FCM's, so waiting here is fine.
            val waiting = runCatching { wm.getWorkInfosForUniqueWork(NAME).get(5, TimeUnit.SECONDS) }.getOrNull()
                ?.firstOrNull { !it.state.isFinished }
            if (waiting != null) {
                val inMs = if (waiting.state == WorkInfo.State.ENQUEUED) waiting.nextScheduleTimeMillis - System.currentTimeMillis() else 0L
                Log.i(TAG, "message $messageId: OTA check asked; a job is already ${waiting.state.name.lowercase()}" +
                    (if (inMs > 0) " (due in ${inMs / 1000} s)" else "") + ", kept as it is")
                return
            }
            val max = PushRules.otaMaxDelayMs(data)
            val delay = PushRules.otaDelayMs(max)
            val request = OneTimeWorkRequestBuilder<OtaCheckJob>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_MS, TimeUnit.MILLISECONDS)
                .build()
            wm.enqueueUniqueWork(NAME, ExistingWorkPolicy.KEEP, request)
            Log.i(TAG, "message $messageId: OTA check job in $delay ms (random in 0..$max ms), once online")
        }
    }
}

/**
 * The phone's FCM topic for OTA pushes, `zn-ota-<app>-<channel>` (PushRules.otaTopic). Subscribed at every start of the
 * main process (FCM ignores a repeat); the last topic is kept, and a changed one (another channel or app) unsubscribes
 * the old one. With `PushPlugin(otaCheck = false)` the kept topic is unsubscribed. With OTA off (ZnOta not configured)
 * nothing changes.
 */
internal object OtaTopic {
    private const val TAG = "zn-push"
    private const val PREFS = "zn-push-ota"
    private const val KEY = "topic"

    /** Main thread, after Application.onCreate (ZnOta.configure comes after the plugins are registered). */
    fun sync(context: Context, otaCheck: Boolean) {
        val firebase = try {
            FirebaseApp.getApps(context).isNotEmpty()
        } catch (_: Exception) {
            false
        }
        if (!firebase) return
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val old = prefs.getString(KEY, null)
        val m = FirebaseMessaging.getInstance()
        if (!otaCheck) {
            if (old != null) m.unsubscribeFromTopic(old).addOnCompleteListener { t ->
                if (t.isSuccessful) prefs.edit().remove(KEY).apply()
                Log.i(TAG, "OTA pushes off: unsubscribe from $old ${if (t.isSuccessful) "done" else "failed (${t.exception?.message})"}")
            }
            return
        }
        val (app, channel) = ZnOta.appAndChannel() ?: return
        val topic = PushRules.otaTopic(app, channel)
        if (topic == null) {
            Log.w(TAG, "no OTA topic: \"zn-ota-$app-$channel\" is not a valid FCM topic name")
            return
        }
        m.subscribeToTopic(topic).addOnCompleteListener { t ->
            if (!t.isSuccessful) {
                Log.w(TAG, "subscribe to the OTA topic $topic failed (tried again at the next start): ${t.exception?.message}")
                return@addOnCompleteListener
            }
            if (old == topic) {
                Log.d(TAG, "OTA topic $topic (subscribed again)")
                return@addOnCompleteListener
            }
            prefs.edit().putString(KEY, topic).apply()
            Log.i(TAG, "subscribed to the OTA topic $topic${old?.let { " (was $it)" } ?: ""}")
            val drop = PushRules.otaTopicToDrop(old, topic)
            if (drop != null) m.unsubscribeFromTopic(drop).addOnCompleteListener { u ->
                Log.i(TAG, "unsubscribe from the old OTA topic $drop ${if (u.isSuccessful) "done" else "failed (${u.exception?.message})"}")
            }
        }
    }
}
