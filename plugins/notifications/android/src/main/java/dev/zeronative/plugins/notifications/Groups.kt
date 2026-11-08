package dev.zeronative.plugins.notifications

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
import androidx.core.text.HtmlCompat
import dev.zeronative.runtime.ZnBackground
import java.security.MessageDigest
import java.security.SecureRandom
import org.json.JSONObject

/**
 * Group summaries, taps and swipes for [NotificationsModule]. A group with [NotificationRules.SUMMARY_FROM] or more notifications
 * gets one summary (inbox style, the newest lines); with fewer it has none. Kept right after every show, cancel and swipe,
 * also in a process started only for the swipe: what a summary says is saved per group, not kept in memory.
 */
internal object Groups {
    class Line(val id: String, val title: String?, val body: String?)

    private const val TAG = "zn-notifications"
    private const val PREFS = "zn-notifications-groups"
    private const val EXTRA_ID = "dev.zeronative.notifications.id"
    private const val EXTRA_GROUP = "dev.zeronative.notifications.group"
    private const val EXTRA_DATA = "dev.zeronative.notifications.data"
    const val EXTRA_PRESS_ID = "dev.zeronative.notifications.press.id"
    const val EXTRA_PRESS_DATA = "dev.zeronative.notifications.press.data"
    const val EXTRA_PRESS_KEY = "dev.zeronative.notifications.press.key"
    private const val EXTRA_PRESS_SECRET = "dev.zeronative.notifications.press.secret"
    private const val ACTION_PRESS = "dev.zeronative.notifications.PRESS"
    private const val SECRET_PREFS = "zn-notifications-press"

    /** The app's context, for [isOurPress] (set by NotificationsPlugin at registration). */
    @Volatile private var app: Context? = null

    fun init(context: Context) {
        app = context.applicationContext
    }

    /**
     * A random value per install, in the app's private storage, put in every press PendingIntent. The launcher
     * Activity is exported, so any other app can send it an Intent with the press extras; it can't know this value.
     */
    private fun pressSecret(context: Context): String = synchronized(this) {
        val prefs = context.getSharedPreferences(SECRET_PREFS, Context.MODE_PRIVATE)
        prefs.getString("secret", null) ?: ByteArray(16).also { SecureRandom().nextBytes(it) }
            .joinToString("") { "%02x".format(it) }
            .also { prefs.edit().putString("secret", it).commit() }
    }

    /** True only for an Intent from one of our own notifications' PendingIntents ([tap]). */
    fun isOurPress(intent: Intent): Boolean {
        val context = app ?: return false
        val given = intent.getStringExtra(EXTRA_PRESS_SECRET) ?: return false
        return MessageDigest.isEqual(given.toByteArray(), pressSecret(context).toByteArray())
    }

    /**
     * Saves the group's summary options from the latest `show` ({ key, title, summaryFormat, link, data } and the
     * channel).
     */
    fun remember(context: Context, key: String, channelId: String, group: JSONObject) {
        val saved = JSONObject().put("channelId", channelId)
        for (k in listOf("title", "summaryFormat", "link")) group.optString(k).takeIf { it.isNotEmpty() }?.let { saved.put(k, it) }
        group.optJSONObject("data")?.let { saved.put("data", it) }
        prefs(context).edit().putString(key, saved.toString()).apply()
    }

    /** Shows, updates or removes [key]'s summary. [with]: just posted (Android may not list it yet). [without]: just removed. */
    fun refresh(context: Context, key: String, with: Line? = null, without: String? = null) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        val lines = nm.activeNotifications
            .filter { it.id == NotificationRules.NOTIFICATION_INT_ID && !NotificationRules.isSummaryTag(it.tag) && it.notification.group == key && it.tag != without }
            .sortedByDescending { it.postTime }
            .map { Line(it.tag, it.notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString(), it.notification.extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()) }
            .toMutableList()
        if (with != null && lines.none { it.id == with.id }) lines.add(0, with)
        val manager = NotificationManagerCompat.from(context)
        val tag = NotificationRules.summaryTag(key)
        if (lines.size < NotificationRules.SUMMARY_FROM) {
            manager.cancel(tag, NotificationRules.NOTIFICATION_INT_ID)
            return
        }
        val saved = prefs(context).getString(key, null)?.let(::JSONObject) ?: return
        val count = lines.size
        val text = NotificationRules.summaryText(saved.optString("summaryFormat").takeIf { it.isNotEmpty() }, count) ?: "$count new"
        val inbox = NotificationCompat.InboxStyle().setSummaryText(text)
        for (l in lines.take(NotificationRules.SUMMARY_LINES)) inbox.addLine(NotificationRules.inboxLine(l.title, l.body))
        val summary = NotificationCompat.Builder(context, saved.getString("channelId"))
            .setSmallIcon(smallIcon(context))
            .setContentTitle(saved.optString("title").takeIf { it.isNotEmpty() }?.let(::html) ?: text)
            .setContentText(text)
            .setStyle(inbox)
            .setGroup(key)
            .setGroupSummary(true)
            // The summary never makes its own sound: the new notification in the group already did.
            .setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            // With no link, a tap on the summary is a press with the group's key as its id and the group's data.
            .setContentIntent(
                tap(context, tag, saved.optString("link").takeIf { it.isNotEmpty() }, press = saved.optJSONObject("data") ?: JSONObject(), pressId = key),
            )
            .build()
        try {
            manager.notify(tag, NotificationRules.NOTIFICATION_INT_ID, summary)
        } catch (e: SecurityException) {
            Log.w(TAG, "group summary not shown: no permission")
        }
    }

    /**
     * Notification text as notifee shows it on Android: HTML (`<b>`, `<i>`, `<span style="color:...">`). Text with no
     * tag and no entity stays exactly as given; in HTML text a line break stays a line break.
     */
    fun html(text: String): CharSequence =
        if (!NotificationRules.looksLikeHtml(text)) text
        else HtmlCompat.fromHtml(text.replace("\n", "<br>"), HtmlCompat.FROM_HTML_MODE_COMPACT).trimEnd()

    /**
     * The app's own link (it has a route) opens the app through core's link path; another http(s) link opens the
     * browser; no link opens the app where it was.
     * With [press] (the notification's data), a tap that opens the app carries it, for `Notifications.onPress` and
     * `getInitialNotification` ([Presses]).
     */
    fun tap(context: Context, id: String, link: String?, press: JSONObject? = null, pressId: String = id): PendingIntent {
        val launch = (context.packageManager.getLaunchIntentForPackage(context.packageName) ?: Intent()).also { i ->
            if (press != null) {
                // Not the launcher's own action: Android drops an Intent equal to the task's first one when the app
                // already runs (it only brings the app to the front), so the press would never reach onNewIntent.
                i.setAction(ACTION_PRESS).removeCategory(Intent.CATEGORY_LAUNCHER)
                i.putExtra(EXTRA_PRESS_ID, pressId)
                    .putExtra(EXTRA_PRESS_DATA, press.toString())
                    .putExtra(EXTRA_PRESS_SECRET, pressSecret(context))
                    // One per show: the same notification's Intent read twice (a recreated Activity) is one press.
                    .putExtra(EXTRA_PRESS_KEY, "$id@${System.nanoTime()}")
            }
        }
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
        return NotificationsModule.metaRes(meta, NotificationsModule.META_SMALL_ICON, NotificationsModule.OLD_META_SMALL_ICON)
            ?: context.applicationInfo.icon.takeIf { it != 0 }
            ?: android.R.drawable.ic_dialog_info
    }

    internal fun dismissed(context: Context, intent: Intent, done: () -> Unit) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return done()
        intent.getStringExtra(EXTRA_GROUP)?.let { refresh(context, it, without = id) }
        val data = intent.getStringExtra(EXTRA_DATA)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()
        ZnBackground.run(NotificationRules.DISMISS_TASK, JSONObject().put("id", id).put("data", data), NotificationRules.DISMISS_TIMEOUT_MS) { done() }
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
