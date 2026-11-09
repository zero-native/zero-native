package dev.zeronative.plugins.notifications

import android.content.Intent
import android.os.Looper
import android.util.Log
import dev.zeronative.runtime.ZnBackground
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * The door for a push service: FCM (plugins/firebase-messaging) today; later an APNs-only iOS path, OneSignal, or an app's own
 * service. The service gets messages and tokens its own way, then hands them here, so JS hears every service the same
 * way: `PushEvents.onMessage` (the JS task "push.message") and `PushEvents.onTokenRefresh` ("push.token").
 *
 * Getting a token, topics and the like stay with each service (FCM: the "Push" module). This file has no FCM in it.
 */
object PushEvents {
    /** JS tasks (core's `defineTask`). The JS side names them the same (src/index.ts). */
    const val MESSAGE_TASK = "push.message"
    const val TOKEN_TASK = "push.token"

    /** FCM gives a message about 20 s; JS gets 15, so the service still answers in time after a cold start. */
    const val MESSAGE_TIMEOUT_MS = 15_000L
    const val TOKEN_TIMEOUT_MS = 10_000L

    /** The app is on screen (NotificationsPlugin keeps it from the Activity's events). */
    @Volatile var inFront = false
        internal set

    /**
     * A message from a push service: runs "push.message" and waits until JS answers, at most [timeoutMs]. It blocks, so
     * call it from the service's own background thread (FCM's service thread is one), never the main thread. Never puts
     * the message's data in the log.
     */
    fun message(m: PushMessage, timeoutMs: Long = MESSAGE_TIMEOUT_MS): ZnBackground.Outcome {
        Log.i(TAG, "${m.provider} message ${m.messageId} (${m.data.size} data keys, ${NotificationRules.priorityName(m.priority)}, inFront=$inFront)")
        return runAndWait(MESSAGE_TASK, obj(NotificationRules.messageFields(m, inFront)), timeoutMs)
    }

    /** The service dropped messages it couldn't deliver (the phone was offline too long): the app should sync instead. */
    fun deleted(provider: String, timeoutMs: Long = MESSAGE_TIMEOUT_MS): ZnBackground.Outcome {
        Log.w(TAG, "$provider deleted pending messages")
        val payload = JSONObject().put("provider", provider).put("deleted", true).put("inFront", inFront).put("data", JSONObject())
        return runAndWait(MESSAGE_TASK, payload, timeoutMs)
    }

    /** A new token from the service: runs "push.token". Blocks like [message]. */
    fun token(token: String, provider: String, timeoutMs: Long = TOKEN_TIMEOUT_MS): ZnBackground.Outcome {
        Log.i(TAG, "new $provider token")
        return runAndWait(TOKEN_TASK, JSONObject().put("token", token).put("provider", provider), timeoutMs)
    }

    /**
     * Taps on notifications the service showed itself (FCM shows a message's `notification` block while the app is
     * behind). [read] gives a key for the tap (the same tap twice is one) and what JS gets, or null when the Intent isn't
     * such a tap. The service's module answers its `getInitialNotification` with [NotificationTaps.initial] and sets
     * [NotificationTaps.emit]. Call it once, in the service's plugin `register`.
     */
    fun taps(kind: String, read: (Intent) -> Pair<String, JSONObject>?): NotificationTaps = NotificationTaps(kind, read)

    private fun runAndWait(task: String, payload: JSONObject, timeoutMs: Long): ZnBackground.Outcome {
        check(Looper.myLooper() != Looper.getMainLooper()) { "PushEvents waits for JS: call it off the main thread" }
        val done = CountDownLatch(1)
        var result = ZnBackground.Outcome.TIMED_OUT
        ZnBackground.run(task, payload, timeoutMs) { outcome ->
            if (outcome != ZnBackground.Outcome.DONE) Log.w(TAG, "task $task: $outcome")
            result = outcome
            done.countDown()
        }
        done.await(timeoutMs + 1_000, TimeUnit.MILLISECONDS)
        return result
    }

    private fun obj(map: Map<*, *>): JSONObject = JSONObject().also { o -> for ((k, v) in map) o.put(k.toString(), json(v)) }

    private fun json(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> obj(value)
        else -> value
    }

    private const val TAG = "zn-notifications"
}

/**
 * One message from a push service, as JS gets it ([PushEvents.message]). [priority]: "high", "normal" or anything else
 * ("unknown"). [data] is all strings (FCM's rule; other services: turn values into strings first).
 */
class PushMessage(
    /** "fcm", "apns", "onesignal", or the app's own name. */
    val provider: String,
    val messageId: String?,
    /** The sender (FCM: the sender id, or `/topics/<name>`). */
    val from: String?,
    /** ms since 1970, 0 when unknown. */
    val sentAt: Long,
    val priority: String?,
    val originalPriority: String? = priority,
    val data: Map<String, String>,
    /** The message's own title and body, when the service sent one (FCM's `notification` block). */
    val notification: Notice? = null,
) {
    class Notice(val title: String?, val body: String?)
}
