package dev.zeronative.plugins.notifications

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationChannelGroup
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.annotation.RequiresApi
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.booleanOrNull
import dev.zeronative.runtime.doubleOrNull
import dev.zeronative.runtime.intOrNull
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONArray
import org.json.JSONObject

/**
 * Notifications shown by the app itself (plugins/notifications/src/index.ts `Notifications`), notifee-like: channels, show with
 * pictures and groups, cancel, and a check before showing. Works with no Firebase at all. A tap opens the notification's
 * `link` through core's normal link path (the app's `onLink`); with no link it opens the app and JS hears it as a press
 * (version 3: event "pressed", `getInitialNotification`). A swipe away runs the JS task "push.dismissed".
 * Title, body, big text and lines are HTML (version 3), as notifee shows them: `<b>`, `<i>`, `<span style="color">`.
 */
internal class NotificationsModule(private val context: Context, private val debug: Boolean) : ZnModuleBase("Notifications", version = 3) {
    private val manager = NotificationManagerCompat.from(context)

    init {
        // A tap on one of the app's own notifications with no link (Taps.kt, Presses).
        function("getInitialNotification", onMain = true) { call -> Presses.initial { call.resolve(it) } }
        Presses.emit = { press -> emit("pressed", press) }

        function("createChannel") { call ->
            val id = call.string("id")
            val name = call.string("name")
            val importance = NotificationRules.importance(call.stringOrNull("importance"))
                ?: return@function call.reject("invalid_args", "importance must be none, min, low, default or high")
            if (Build.VERSION.SDK_INT >= 26) {
                val ch = NotificationChannel(id, name, importance)
                call.stringOrNull("description")?.let { ch.description = it }
                if (call.booleanOrNull("sound") == false) ch.setSound(null, null)
                ch.enableVibration(call.booleanOrNull("vibration") ?: true)
                ch.enableLights(call.booleanOrNull("lights") ?: false)
                ch.setShowBadge(call.booleanOrNull("badge") ?: true)
                call.stringOrNull("groupId")?.let { ch.group = it }
                // Android keeps a channel's sound, vibration and importance as first made (the user owns them then);
                // only the name and description change on a second call.
                manager.createNotificationChannel(ch)
            }
            call.resolve(true)
        }

        function("deleteChannel") { call ->
            if (Build.VERSION.SDK_INT >= 26) manager.deleteNotificationChannel(call.string("id"))
            call.resolve(true)
        }

        // Version 2. Shown later by an alarm, with no JS (Schedule.kt). Same options as show, plus at / repeat / exact.
        function("schedule") { call ->
            val options = call.args.optJSONObject("notification")
                ?: return@function call.reject("invalid_args", "notification is missing")
            val at = call.doubleOrNull("at")?.toLong() ?: return@function call.reject("invalid_args", "at is missing")
            val repeat = call.stringOrNull("repeat")
            if (repeat == null && at <= System.currentTimeMillis()) return@function call.resolve(JSONObject().put("scheduled", false).put("reason", "past"))
            val reason = Schedule.add(context, options, at, repeat, call.booleanOrNull("exact") ?: false)
            call.resolve(JSONObject().put("scheduled", reason == null).put("reason", reason ?: JSONObject.NULL))
        }

        function("getScheduled") { call -> call.resolve(Schedule.list(context)) }

        // Power and alarm settings (notifee's power manager helpers).
        function("canScheduleExact") { call -> call.resolve(Schedule.canExact(context)) }

        function("isBatteryOptimized") { call ->
            val pm = context.getSystemService(android.os.PowerManager::class.java)
            call.resolve(pm?.isIgnoringBatteryOptimizations(context.packageName) == false)
        }

        function("openSettings", onMain = true) { call ->
            val action = when (call.string("page")) {
                "exact_alarms" -> if (Build.VERSION.SDK_INT >= 31) android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM else null
                "battery" -> android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS
                "notifications" -> if (Build.VERSION.SDK_INT >= 26) android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS else null
                else -> return@function call.reject("invalid_args", "page must be exact_alarms, battery or notifications")
            } ?: return@function call.resolve(false)
            val intent = android.content.Intent(action).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            val pkg = android.net.Uri.parse("package:${context.packageName}")
            // The app's notification page takes the package as an extra only: Settings' filter for it has no data, so
            // an intent with `package:` data matched nothing and the call did nothing (old-phone audit 2026-11-06,
            // checked on Android 13). The exact-alarm page takes it as data.
            when (action) {
                android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS ->
                    intent.putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
                android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM -> intent.data = pkg
            }
            val opened = runCatching { context.startActivity(intent) }.isSuccess ||
                // A phone whose Settings lacks that page: the app's info page, which links to both
                (action != android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS && runCatching {
                    context.startActivity(
                        android.content.Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
                            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
                    )
                }.isSuccess)
            call.resolve(opened)
        }

        // Version 2. A heading over channels in the phone's settings ("Orders", "Offers").
        function("createChannelGroup") { call ->
            if (Build.VERSION.SDK_INT >= 26) {
                val g = NotificationChannelGroup(call.string("id"), call.string("name"))
                if (Build.VERSION.SDK_INT >= 28) call.stringOrNull("description")?.let { g.description = it }
                manager.createNotificationChannelGroup(g)
            }
            call.resolve(true)
        }

        function("deleteChannelGroup") { call ->
            if (Build.VERSION.SDK_INT >= 26) manager.deleteNotificationChannelGroup(call.string("id"))
            call.resolve(true)
        }

        // The app's channels as the user left them: a channel the user turned off says `blocked`.
        function("getChannels") { call ->
            val out = JSONArray()
            if (Build.VERSION.SDK_INT >= 26) for (ch in manager.notificationChannels) out.put(channelJson(ch))
            call.resolve(out)
        }

        function("getChannel") { call ->
            val ch = if (Build.VERSION.SDK_INT >= 26) manager.getNotificationChannel(call.string("id")) else null
            call.resolve(if (ch != null && Build.VERSION.SDK_INT >= 26) channelJson(ch) else null)
        }

        // The app's notifications on screen now (not group summaries), newest first.
        function("getDisplayed") { call ->
            val out = JSONArray()
            for (n in active().filter { !NotificationRules.isSummaryTag(it.tag) }.sortedByDescending { it.postTime }) {
                val e = n.notification.extras
                out.put(
                    JSONObject()
                        .put("id", n.tag)
                        .put("title", e.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: JSONObject.NULL)
                        .put("body", e.getCharSequence(Notification.EXTRA_TEXT)?.toString() ?: JSONObject.NULL)
                        .put("channelId", if (Build.VERSION.SDK_INT >= 26) n.notification.channelId else JSONObject.NULL)
                        .put("group", n.notification.group ?: JSONObject.NULL)
                        .put("shownAt", n.postTime)
                        .put("data", e.getString(EXTRA_DATA)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()),
                )
            }
            call.resolve(out)
        }

        function("canShow") { call -> call.resolve(JSONObject().put("reason", blocked(call.stringOrNull("channelId")) ?: JSONObject.NULL)) }

        // On the I/O pool: it may download a picture first.
        function("show") { call -> show(call) }

        function("cancel") { call ->
            val id = call.string("id")
            Schedule.remove(context, id) // like notifee: a scheduled one with this id goes too
            val group = active().firstOrNull { it.tag == id }?.notification?.group
            manager.cancel(id, NotificationRules.NOTIFICATION_INT_ID)
            if (group != null) Groups.refresh(context, group, without = id)
            call.resolve(true)
        }

        function("cancelAll") { call ->
            Schedule.removeAll(context)
            manager.cancelAll()
            call.resolve(true)
        }
    }

    /** Why a notification can't show now (null: it can). With no channel id: only the app-wide switch. */
    private fun blocked(channelId: String?): String? {
        val appOn = manager.areNotificationsEnabled()
        if (channelId == null || Build.VERSION.SDK_INT < 26) return NotificationRules.blocked(appOn, true, null)
        val ch = manager.getNotificationChannel(channelId)
        return NotificationRules.blocked(appOn, ch != null, ch?.importance)
    }

    private fun show(call: ZnCall) {
        val id = call.string("id")
        val channelId = call.string("channelId")
        val title = call.string("title")
        val body = call.stringOrNull("body")
        val bigText = call.stringOrNull("bigText")
        val link = call.stringOrNull("link")
        val autoCancel = call.booleanOrNull("autoCancel") ?: true
        val group = call.args.optJSONObject("group")
        val groupKey = group?.optString("key")?.takeIf { it.isNotEmpty() }
        val data = call.args.optJSONObject("data") ?: JSONObject()
        val visibility = NotificationRules.visibility(call.stringOrNull("visibility"))
            ?: return call.reject("invalid_args", "visibility must be public, private or secret")
        val categoryName = call.stringOrNull("category")
        val category = NotificationRules.category(categoryName)
        if (category == "") return call.reject("invalid_args", "unknown category \"$categoryName\"")
        val progress = call.args.optJSONObject("progress")?.let {
            NotificationRules.progress(if (it.has("max")) it.optInt("max") else null, it.optInt("current"), it.optBoolean("indeterminate"))
        }
        val lines = call.args.optJSONArray("lines")
            ?.let { a -> List(minOf(a.length(), NotificationRules.MAX_LINES)) { a.optString(it) } }
            ?.filter { it.isNotEmpty() }
        blocked(channelId)?.let { reason ->
            Log.w(TAG, "notification $id not shown: $reason")
            return call.resolve(JSONObject().put("shown", false).put("reason", reason))
        }

        val picture = call.stringOrNull("imageUrl")?.let { download(it, NotificationRules.PICTURE_MAX_PX) }
        val largeIcon = call.stringOrNull("largeIconUrl")?.let { download(it, NotificationRules.ICON_MAX_PX) }
        val b = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(smallIcon())
            .setContentTitle(Groups.html(title))
            .setAutoCancel(autoCancel)
            .setContentIntent(Groups.tap(context, id, link, press = data))
            .setDeleteIntent(Groups.dismissIntent(context, id, groupKey, data))
        body?.let { b.setContentText(Groups.html(it)) }
        (NotificationRules.color(call.stringOrNull("color")) ?: color())?.let(b::setColor)
        largeIcon?.let(b::setLargeIcon)
        when (NotificationRules.style(body, bigText, picture != null, !lines.isNullOrEmpty())) {
            NotificationRules.Style.PICTURE -> b.setStyle(NotificationCompat.BigPictureStyle().bigPicture(picture).setSummaryText(body?.let(Groups::html)))
            NotificationRules.Style.INBOX -> b.setStyle(NotificationCompat.InboxStyle().also { s -> lines!!.forEach { s.addLine(Groups.html(it)) } })
            NotificationRules.Style.BIG_TEXT -> b.setStyle(NotificationCompat.BigTextStyle().bigText((bigText ?: body)?.let(Groups::html)))
            NotificationRules.Style.PLAIN -> {}
        }
        // Version 2 (notifee-like). The lock screen hides the text by default ("private"): bills and payments are private.
        b.setVisibility(visibility)
        category?.let(b::setCategory)
        progress?.let { b.setProgress(it.max, it.current, it.indeterminate) }
        call.booleanOrNull("ongoing")?.let(b::setOngoing)
        call.booleanOrNull("onlyAlertOnce")?.let(b::setOnlyAlertOnce)
        if (call.booleanOrNull("silent") == true) b.setSilent(true)
        call.intOrNull("number")?.let(b::setNumber)
        call.doubleOrNull("timestamp")?.let { b.setWhen(it.toLong()).setShowWhen(true) }
        call.booleanOrNull("showTimestamp")?.let(b::setShowWhen)
        b.addExtras(Bundle().apply { putString(EXTRA_DATA, data.toString()) })
        Actions.add(context, b, id, call.args.optJSONArray("actions"), data)
        if (groupKey != null) {
            b.setGroup(groupKey)
            Groups.remember(context, groupKey, channelId, group)
        }
        try {
            manager.notify(id, NotificationRules.NOTIFICATION_INT_ID, b.build())
        } catch (e: SecurityException) { // the permission was taken away between the check and here
            return call.resolve(JSONObject().put("shown", false).put("reason", "off"))
        }
        if (groupKey != null) Groups.refresh(context, groupKey, with = Groups.Line(id, title, body))
        call.resolve(JSONObject().put("shown", true).put("reason", JSONObject.NULL))
    }

    private fun active() = (context.getSystemService(NotificationManager::class.java)?.activeNotifications ?: emptyArray())
        .filter { it.id == NotificationRules.NOTIFICATION_INT_ID }

    private fun smallIcon(): Int = Groups.smallIcon(context)

    private fun color(): Int? = metaRes(meta(), META_COLOR, OLD_META_COLOR)?.let { context.getColor(it) }

    private fun meta() = try {
        context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
    } catch (_: Exception) {
        null
    }

    /** A picture for the notification, or null (it then shows without one). Never more than a few seconds. */
    private fun download(url: String, maxPx: Int): Bitmap? {
        if (!NotificationRules.imageUrlAllowed(url, debug)) {
            Log.w(TAG, "image left out: only https links")
            return null
        }
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = NotificationRules.IMAGE_TIMEOUT_MS
            c.readTimeout = NotificationRules.IMAGE_TIMEOUT_MS
            c.instanceFollowRedirects = true
            try {
                if (c.responseCode !in 200..299) return null
                if (c.contentLengthLong > NotificationRules.MAX_IMAGE_BYTES) return null
                val out = ByteArrayOutputStream()
                c.inputStream.use { input ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > NotificationRules.MAX_IMAGE_BYTES) return null
                    }
                }
                decode(out.toByteArray(), maxPx)
            } finally {
                c.disconnect()
            }
        } catch (e: Exception) {
            Log.w(TAG, "image left out: ${e::class.simpleName}")
            null
        }
    }

    private fun decode(bytes: ByteArray, maxPx: Int): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (bounds.outWidth / (sample * 2) >= maxPx || bounds.outHeight / (sample * 2) >= maxPx) sample *= 2
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }

    companion object {
        private const val TAG = "zn-notifications"
        /** In the app's manifest: `<meta-data android:name="dev.zeronative.notifications.small_icon" android:resource="@drawable/..." />`. */
        const val META_SMALL_ICON = "dev.zeronative.notifications.small_icon"
        const val META_COLOR = "dev.zeronative.notifications.color"
        /** The keys before the split from plugins/firebase-messaging (2026-11-09). Still read, after the new ones. Deprecated. */
        const val OLD_META_SMALL_ICON = "dev.zeronative.push.small_icon"
        const val OLD_META_COLOR = "dev.zeronative.push.color"

        /** A resource id from the app's meta-data: the new key first, then the old one. */
        internal fun metaRes(meta: Bundle?, key: String, old: String): Int? =
            meta?.getInt(key, 0)?.takeIf { it != 0 } ?: meta?.getInt(old, 0)?.takeIf { it != 0 }
        /** The notification's `data`, kept in its extras for getDisplayed. */
        private const val EXTRA_DATA = "dev.zeronative.notifications.data"
    }

    @RequiresApi(26)
    private fun channelJson(ch: NotificationChannel): JSONObject = JSONObject()
        .put("id", ch.id)
        .put("name", ch.name.toString())
        .put("importance", NotificationRules.importanceName(ch.importance))
        .put("blocked", ch.importance == NotificationManager.IMPORTANCE_NONE)
        .put("description", ch.description ?: JSONObject.NULL)
        .put("groupId", ch.group ?: JSONObject.NULL)
}
