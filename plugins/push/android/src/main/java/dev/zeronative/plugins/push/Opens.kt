package dev.zeronative.plugins.push

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.zeronative.runtime.ZnActivity
import org.json.JSONObject

/**
 * Taps on the notifications FCM shows itself (a message with a `notification` block while the app is behind or closed).
 * FCM's tap opens the app's launch Activity with the message in its extras; RN Firebase's two calls read it:
 * - `getInitialNotification()`: the message that started this Activity, once.
 * - `onNotificationOpenedApp`: a tap while the Activity is alive (a new Intent, singleTop).
 * Main thread only. Notifications the app shows itself (`Notifications.show`) open their `link` instead.
 */
internal object Opens {
    private val main = Handler(Looper.getMainLooper())
    private val seen = HashSet<String>()
    private val waiting = ArrayList<(JSONObject?) -> Unit>()
    /** Set by PushModule: sends "opened" to JS. */
    var emit: ((JSONObject) -> Unit)? = null

    /** The tap that started the app's Activity, once per message. Waits for the Activity if JS asks before it is there. */
    fun initial(done: (JSONObject?) -> Unit) {
        val activity = ZnActivity.current
        if (activity != null) return done(take(activity.intent))
        waiting += done
        main.postDelayed({ if (waiting.remove(done)) done(null) }, PushRules.INITIAL_WAIT_MS)
    }

    /**
     * The Activity is on screen: answer the calls that waited for it. One main-thread turn later: Android starts a
     * restored Activity and then gives it the tap's new Intent in the same turn ([onNewIntent] must come first).
     */
    fun onFront() {
        if (waiting.isNotEmpty()) main.post(::answerWaiting)
    }

    private fun answerWaiting() {
        if (waiting.isEmpty()) return
        val calls = waiting.toList()
        waiting.clear()
        val first = startTap ?: take(ZnActivity.current?.intent)
        startTap = null
        calls.forEachIndexed { i, done -> done(if (i == 0) first else null) }
    }

    /**
     * A tap while JS still waits for its first Activity: after a low-memory kill Android brings back the old Activity
     * with its old Intent and hands the tap over as a new Intent. For the fresh JS it is the start, so it answers
     * `getInitialNotification` (seen on the emulator, 2026-11-04).
     */
    private var startTap: JSONObject? = null

    fun onNewIntent(intent: Intent) {
        val message = take(intent) ?: return
        Log.i(TAG, "opened from FCM's notification ${message.optString("messageId")}")
        if (waiting.isNotEmpty()) startTap = message else emit?.invoke(message)
    }

    private fun take(intent: Intent?): JSONObject? {
        val extras = intent?.extras ?: return null
        val map = HashMap<String, Any?>()
        for (key in extras.keySet()) @Suppress("DEPRECATION") map[key] = extras.get(key)
        if (!PushRules.isFcmTap(map)) return null
        val id = map[PushRules.EXTRA_MESSAGE_ID] as String
        if (!seen.add(id)) return null
        val data = JSONObject()
        for ((k, v) in PushRules.tapData(map)) data.put(k, v)
        return JSONObject()
            .put("messageId", id)
            .put("from", map["from"] as? String ?: JSONObject.NULL)
            .put("sentAt", PushRules.sentAt(map["google.sent_time"]))
            .put("data", data)
    }

    private const val TAG = "zn-push"
}
