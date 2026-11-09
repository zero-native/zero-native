package dev.zeronative.plugins.firebase.messaging

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.zeronative.plugins.notifications.PushEvents
import dev.zeronative.plugins.notifications.PushMessage

/**
 * Every FCM message and new token, in front, behind, or with the app closed (FCM starts the process; Application.onCreate
 * starts JS as always). Both go through the notifications plugin's [PushEvents] and run a JS task, so there is one path
 * for all three cases:
 * - a message runs "push.message" (`Push.onMessage`). FCM shows a message with a `notification` block by itself while
 *   the app is behind; the task still runs for its data only when the app is in front (Android's rule for such messages).
 * - a new token runs "push.token" (`Push.onTokenRefresh`).
 * The service's thread waits for the task (FCM keeps the process alive until then), at most [PushEvents.MESSAGE_TIMEOUT_MS].
 */
class ZnMessagingService : FirebaseMessagingService() {
    override fun onMessageReceived(message: RemoteMessage) {
        if (PushState.otaCheck && PushRules.isOtaCheck(message.data)) return otaCheck(message.data, message.messageId)
        PushEvents.message(
            PushMessage(
                provider = PROVIDER,
                messageId = message.messageId,
                from = message.from,
                sentAt = message.sentTime,
                priority = priority(message.priority),
                originalPriority = priority(message.originalPriority),
                data = message.data,
                notification = message.notification?.let { PushMessage.Notice(it.title, it.body) },
            ),
        )
    }

    override fun onNewToken(token: String) {
        PushEvents.token(token, PROVIDER)
    }

    override fun onDeletedMessages() {
        // FCM dropped messages it couldn't deliver (the phone was offline too long): the app should sync instead.
        PushEvents.deleted(PROVIDER)
    }

    /**
     * "Check for an update" from the server (PushRules.OTA_KEY): core's normal check, as at a start, in a background job
     * ([OtaCheckJob]) after the message's random wait, once online. FCM's ~20 s are too short for a download.
     */
    private fun otaCheck(data: Map<String, String>, id: String?) {
        try {
            OtaCheckJob.schedule(applicationContext, data, id)
        } catch (e: Exception) { // WorkManager not set up (an app that turned off its start-up initializer)
            Log.e(TAG, "message $id: can't schedule the OTA check job", e)
        }
    }

    private fun priority(p: Int) = when (p) {
        RemoteMessage.PRIORITY_HIGH -> "high"
        RemoteMessage.PRIORITY_NORMAL -> "normal"
        else -> "unknown"
    }

    private companion object {
        const val TAG = "zn-push"
        const val PROVIDER = "fcm"
    }
}

/** Shared by the plugin's parts (main thread writes, any thread reads). */
internal object PushState {
    /** PushPlugin(otaCheck): the `zn_ota=check` message runs the OTA check. */
    @Volatile var otaCheck = true
}
