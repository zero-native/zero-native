package dev.zeronative.plugins.push

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.zeronative.runtime.ZnBackground
import org.json.JSONObject

/**
 * Group summaries, taps and swipes for [NotificationsModule]. A group with [PushRules.SUMMARY_FROM] or more notifications
 * gets one summary (inbox style, the newest lines); with fewer it has none. Kept right after every show, cancel and swipe,
 * also in a process started only for the swipe: what a summary says is saved per group, not kept in memory.
 */
internal object Groups {
    class Line(val id: String, val title: String?, val body: String?)

    private const val TAG = "zn-push"
    private const val PREFS = "zn-push-groups"
    private const val EXTRA_ID = "dev.zeronative.push.id"
    private const val EXTRA_GROUP = "dev.zeronative.push.group"
    private const val EXTRA_DATA = "dev.zeronative.push.data"

    /** Saves the group's summary options from the latest `show` ({ key, title, summaryFormat, link } and the channel). */
    fun remember(context: Context, key: String, channelId: String, group: JSONObject) {
        val saved = JSONObject().put("channelId", channelId)
        for (k in listOf("title", "summaryFormat", "link")) group.optString(k).takeIf { it.isNotEmpty() }?.let { saved.put(k, it) }
        prefs(context).edit().putString(key, saved.toString()).apply()
    }

    /** Shows, updates or removes [key]'s summary. [with]: just posted (Android may not list it yet). [without]: just removed. */
    fun refresh(context: Context, key: String, with: Line? = null, without: String? = null) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val lines = nm.activeNotifications
            .filter { it.id == PushRules.NOTIFICATION_INT_ID && !PushRules.isSummaryTag(it.tag) && it.notification.group == key && it.tag != without }
            .sortedByDescending { it.postTime }
            .map { Line(it.tag, it.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(), it.notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()) }
            .toMutableList()
        if (with != null && lines.none { it.id == with.id }) lines.add(0, with)
        val manager = NotificationManagerCompat.from(context)
        val tag = PushRules.summaryTag(key)
        if (lines.size < PushRules.SUMMARY_FROM) {
            manager.cancel(tag, PushRules.NOTIFICATION_INT_ID)
            return
        }
        val saved = prefs(context).getString(key, null)?.let(::JSONObject) ?: return
        val count = lines.size
        val text = PushRules.summaryText(saved.optString("summaryFormat").takeIf { it.isNotEmpty() }, count) ?: "$count new"
        val inbox = NotificationCompat.InboxStyle().setSummaryText(text)
        for (l in lines.take(PushRules.SUMMARY_LINES)) inbox.addLine(PushRules.inboxLine(l.title, l.body))
        val summary = NotificationCompat.Builder(context, saved.getString("channelId"))
            .setSmallIcon(smallIcon(context))
            .setContentTitle(saved.optString("title").takeIf { it.isNotEmpty() } ?: text)
            .setContentText(text)
            .setStyle(inbox)
            .setGroup(key)
            .setGroupSummary(true)
            // The summary never makes its own sound: the new notification in the group already did.
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(tap(context, tag, saved.optString("link").takeIf { it.isNotEmpty() }))
            .build()
        try {
            manager.notify(tag, PushRules.NOTIFICATION_INT_ID, summary)
        } catch (e: SecurityException) {
            Log.w(TAG, "group summary not shown: no permission")
        }
    }

    /**
     * The app's own link (it has a route) opens the app through core's link path; another http(s) link opens the
     * browser; no link opens the app where it was.
     */
    fun tap(context: Context, id: String, link: String?): PendingIntent {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()
        val intent = link?.let { Uri.parse(it) }?.let { uri ->
            val own = Intent(Intent.ACTION_VIEW, uri).setPackage(context.packageName)
            when {
                own.resolveActivity(context.packageManager) != null -> own
                uri.scheme == "https" || uri.scheme == "http" -> Intent(Intent.ACTION_VIEW, uri)
                else -> null.also { Log.w(TAG, "notification $id: nothing opens its link; the tap opens the app") }
            }
        } ?: launch
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /** Swiping [id] away sends this to [ZnNotificationDismissed]. */
    fun dismissIntent(context: Context, id: String, group: String?, data: JSONObject): PendingIntent {
        val intent = Intent(context, ZnNotificationDismissed::class.java)
            .putExtra(EXTRA_ID, id)
            .putExtra(EXTRA_DATA, data.toString())
        if (group != null) intent.putExtra(EXTRA_GROUP, group)
        return PendingIntent.getBroadcast(context, id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    /**
     * The app's monochrome icon from its manifest ([NotificationsModule.META_SMALL_ICON]), else the app icon, else a
     * system one: Android refuses a notification with no icon at all.
     */
    fun smallIcon(context: Context): Int {
        val meta = try {
            context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
        } catch (_: Exception) {
            null
        }
        return meta?.getInt(NotificationsModule.META_SMALL_ICON, 0)?.takeIf { it != 0 }
            ?: context.applicationInfo.icon.takeIf { it != 0 }
            ?: android.R.drawable.ic_dialog_info
    }

    internal fun dismissed(context: Context, intent: Intent, done: () -> Unit) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return done()
        intent.getStringExtra(EXTRA_GROUP)?.let { refresh(context, it, without = id) }
        val data = intent.getStringExtra(EXTRA_DATA)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        ZnBackground.run(PushRules.DISMISS_TASK, JSONObject().put("id", id).put("data", data), PushRules.DISMISS_TIMEOUT_MS) { done() }
    }

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
}

/** A notification swiped away (its delete intent): the group summary is kept right, and JS hears it ("push.dismissed"). */
class ZnNotificationDismissed : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        Groups.dismissed(context.applicationContext, intent) { pending.finish() }
    }
}
