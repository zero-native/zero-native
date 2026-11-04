package dev.zeronative.plugins.push

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.zeronative.runtime.ZnBackground
import dev.zeronative.runtime.ZnOta
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * Every FCM message and new token, in front, behind, or with the app closed (FCM starts the process; Application.onCreate
 * starts JS as always). Both run a JS task, so there is one path for all three cases:
 * - a message runs "push.message" (`Push.onMessage`). FCM shows a message with a `notification` block by itself while
 *   the app is behind; the task still runs for its data only when the app is in front (Android's rule for such messages).
 * - a new token runs "push.token" (`Push.onTokenRefresh`).
 * The service's thread waits for the task (FCM keeps the process alive until then), at most [PushRules.MESSAGE_TIMEOUT_MS].
 */
class ZnMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (PushState.otaCheck && PushRules.isOtaCheck(message.data)) return otaCheck(message.messageId)
        val data = JSONObject()
        for ((k, v) in message.data) data.put(k, v)
        val payload = JSONObject()
            .put("messageId", message.messageId ?: JSONObject.NULL)
            .put("from", message.from ?: JSONObject.NULL)
            .put("sentAt", message.sentTime)
            .put("priority", priority(message.priority))
            .put("originalPriority", priority(message.originalPriority))
            .put("inFront", PushState.inFront)
            .put("data", data)
            .put("notification", message.notification?.let { n ->
                JSONObject().put("title", n.title ?: JSONObject.NULL).put("body", n.body ?: JSONObject.NULL)
            } ?: JSONObject.NULL)
        // Never the data itself in the log: it may hold whatever the server put in it.
        Log.i(TAG, "message ${message.messageId} (${message.data.size} data keys, ${priority(message.priority)}, inFront=${PushState.inFront})")
        runAndWait(PushRules.MESSAGE_TASK, payload, PushRules.MESSAGE_TIMEOUT_MS)
    }

    override fun onNewToken(token: String) {
        Log.i(TAG, "new FCM token")
        runAndWait(PushRules.TOKEN_TASK, JSONObject().put("token", token), PushRules.TOKEN_TIMEOUT_MS)
    }

    override fun onDeletedMessages() {
        // FCM dropped messages it couldn't deliver (the phone was offline too long): the app should sync instead.
        Log.w(TAG, "FCM deleted pending messages")
        runAndWait(PushRules.MESSAGE_TASK, JSONObject().put("deleted", true).put("inFront", PushState.inFront).put("data", JSONObject()), PushRules.MESSAGE_TIMEOUT_MS)
    }

    /** "Check for an update now" from the server (PushRules.OTA_KEY): core's normal check, as at a start. */
    private fun otaCheck(id: String?) {
        Log.i(TAG, "message $id: OTA check asked")
        val done = CountDownLatch(1)
        ZnOta.check { r ->
            Log.i(TAG, "OTA check from push: ${r.optString("action")} ${r.optString("reason")}")
            done.countDown()
        }
        done.await(PushRules.OTA_WAIT_MS, TimeUnit.MILLISECONDS)
    }

    private fun runAndWait(task: String, payload: JSONObject, timeoutMs: Long) {
        val done = CountDownLatch(1)
        ZnBackground.run(task, payload, timeoutMs) { outcome ->
            if (outcome != ZnBackground.Outcome.DONE) Log.w(TAG, "task $task: $outcome")
            done.countDown()
        }
        done.await(timeoutMs + 1_000, TimeUnit.MILLISECONDS)
    }

    private fun priority(p: Int) = when (p) {
        RemoteMessage.PRIORITY_HIGH -> "high"
        RemoteMessage.PRIORITY_NORMAL -> "normal"
        else -> "unknown"
    }

    private companion object {
        const val TAG = "zn-push"
    }
}

/** Shared by the plugin's parts (main thread writes, any thread reads). */
internal object PushState {
    /** The app is on screen (from the plugin's Activity events). */
    @Volatile var inFront = false
    /** PushPlugin(otaCheck): the `zn_ota=check` message runs the OTA check. */
    @Volatile var otaCheck = true
}
