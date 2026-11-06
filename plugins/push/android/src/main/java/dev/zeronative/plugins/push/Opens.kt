package dev.zeronative.plugins.push

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.zeronative.runtime.ZnActivity
import org.json.JSONObject

/**
 * Taps that open the app's launch Activity with what was tapped in the Intent's extras. Two kinds, the same rules:
 * - [Opens]: the notifications FCM shows itself (a message with a `notification` block while the app is behind or
 *   closed). RN Firebase's `getInitialNotification()` and `onNotificationOpenedApp`.
 * - [Presses]: the app's own notifications (`Notifications.show`) with no `link`. notifee's `getInitialNotification()`
 *   and its PRESS event (`Notifications.onPress`).
 * For each: `initial` is the tap that started this Activity, once; a tap while the Activity is alive comes as a new
 * Intent (singleTop) and is sent to JS. Main thread only.
 */
internal class Taps(private val kind: String, private val read: (Intent) -> Pair<String, JSONObject>?) {
    private val main = Handler(Looper.getMainLooper())
    private val seen = HashSet<String>()
    private val waiting = ArrayList<(JSONObject?) -> Unit>()
    /** Set by the module: sends the tap to JS. */
    var emit: ((JSONObject) -> Unit)? = null

    /** The tap that started the app's Activity, once per tap. Waits for the Activity if JS asks before it is there. */
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
        val tap = take(intent) ?: return
        Log.i(TAG, "opened from $kind")
        if (waiting.isNotEmpty()) startTap = tap else emit?.invoke(tap)
    }

    /** What was tapped, once: the same Intent read again (a recreated Activity, a second JS call) gives null. */
    private fun take(intent: Intent?): JSONObject? {
        val (key, tap) = intent?.let(read) ?: return null
        return if (seen.add(key)) tap else null
    }

    private companion object {
        const val TAG = "zn-push"
    }
}

/** Taps on FCM's own notifications. */
internal val Opens = Taps("FCM's notification") { intent ->
    val extras = intent.extras
    if (extras == null) {
        null
    } else {
        val map = HashMap<String, Any?>()
        for (key in extras.keySet()) @Suppress("DEPRECATION") map[key] = extras.get(key)
        if (!PushRules.isFcmTap(map)) {
            null
        } else {
            val id = map[PushRules.EXTRA_MESSAGE_ID] as String
            val data = JSONObject()
            for ((k, v) in PushRules.tapData(map)) data.put(k, v)
            id to JSONObject()
                .put("messageId", id)
                .put("from", map["from"] as? String ?: JSONObject.NULL)
                .put("sentAt", PushRules.sentAt(map["google.sent_time"]))
                .put("data", data)
        }
    }
}

/** Taps on the app's own notifications with no `link` (Groups.tap puts these extras in). */
internal val Presses = Taps("the app's notification") { intent ->
    val id = intent.getStringExtra(Groups.EXTRA_PRESS_ID)
    val key = intent.getStringExtra(Groups.EXTRA_PRESS_KEY)
    if (id == null || key == null) {
        null
    } else if (!Groups.isOurPress(intent)) {
        // Another app sent our (exported) launcher Activity press extras: not a tap on our notification.
        Log.w("zn-push", "a press without this install's secret: ignored")
        null
    } else {
        val data = intent.getStringExtra(Groups.EXTRA_PRESS_DATA)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        key to JSONObject().put("id", id).put("data", data)
    }
}
