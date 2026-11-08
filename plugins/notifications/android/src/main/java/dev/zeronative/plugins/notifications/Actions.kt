package dev.zeronative.plugins.notifications

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import dev.zeronative.runtime.ZnBackground
import org.json.JSONArray
import org.json.JSONObject

/**
 * Buttons on a notification (notifee's actions). A button with a `link` opens it like a tap on the notification. A
 * button without one runs the JS task "push.action" with no screen ([ZnNotificationAction]); with `input`, the user types
 * a reply in the notification first (Android's inline reply) and the task gets the text.
 */
internal object Actions {
    private const val ACTION = "dev.zeronative.notifications.ACTION"
    private const val EXTRA_ID = "dev.zeronative.notifications.id"
    private const val EXTRA_ACTION = "dev.zeronative.notifications.action"
    private const val EXTRA_DATA = "dev.zeronative.notifications.data"
    const val INPUT_KEY = "dev.zeronative.notifications.input"

    /** Adds [actions] (at most [NotificationRules.MAX_ACTIONS], as Android shows) to [b]. */
    fun add(context: Context, b: NotificationCompat.Builder, id: String, actions: JSONArray?, data: JSONObject) {
        if (actions == null) return
        for (i in 0 until minOf(actions.length(), NotificationRules.MAX_ACTIONS)) {
            val a = actions.optJSONObject(i) ?: continue
            val actionId = a.optString("id").takeIf { it.isNotEmpty() } ?: continue
            val title = a.optString("title").takeIf { it.isNotEmpty() } ?: continue
            val link = a.optString("link").takeIf { it.isNotEmpty() }
            val input = a.optJSONObject("input")
            val code = NotificationRules.actionRequestCode(id, actionId)
            val pending = if (link != null) {
                Groups.tap(context, "$id:$actionId", link)
            } else {
                val intent = Intent(context, ZnNotificationAction::class.java)
                    .setAction(ACTION)
                    // Its own data URI: two buttons never share one PendingIntent, even if their request codes clash.
                    .setData(Uri.Builder().scheme("zn-action").appendPath(id).appendPath(actionId).build())
                    .putExtra(EXTRA_ID, id)
                    .putExtra(EXTRA_ACTION, actionId)
                    .putExtra(EXTRA_DATA, data.toString())
                // Android writes the reply into the Intent, so an input button's PendingIntent must be mutable (Android
                // 12+ rule). The Intent names our own receiver, so no other app can send it elsewhere.
                val mutable = if (input != null && Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
                PendingIntent.getBroadcast(context, code, intent, mutable or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            val builder = NotificationCompat.Action.Builder(0, title, pending)
            if (input != null && link == null) {
                builder.addRemoteInput(RemoteInput.Builder(INPUT_KEY).setLabel(input.optString("placeholder").ifEmpty { title }).build())
                builder.setAllowGeneratedReplies(false)
            }
            b.addAction(builder.build())
        }
    }

    internal fun pressed(context: Context, intent: Intent, done: () -> Unit) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return done()
        val actionId = intent.getStringExtra(EXTRA_ACTION) ?: return done()
        val data = intent.getStringExtra(EXTRA_DATA)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        val payload = JSONObject().put("id", id).put("actionId", actionId).put("data", data)
        RemoteInput.getResultsFromIntent(intent)?.getCharSequence(INPUT_KEY)?.let { payload.put("input", it.toString()) }
        ZnBackground.run(NotificationRules.ACTION_TASK, payload, NotificationRules.ACTION_TIMEOUT_MS) { done() }
    }
}

/** A button pressed on a notification: runs the JS task "push.action" (Notifications.onAction). */
class ZnNotificationAction : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        Actions.pressed(context.applicationContext, intent) { pending.finish() }
    }
}
