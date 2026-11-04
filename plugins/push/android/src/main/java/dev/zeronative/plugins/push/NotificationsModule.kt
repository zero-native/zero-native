package dev.zeronative.plugins.push

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.zeronative.runtime.ZnCall
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.booleanOrNull
import dev.zeronative.runtime.string
import dev.zeronative.runtime.stringOrNull
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/**
 * Notifications shown by the app itself (plugins/push/src/index.ts `Notifications`), notifee-like: channels, show with
 * pictures and groups, cancel, and a check before showing. Works with no Firebase at all. A tap opens the notification's
 * `link` through core's normal link path (the app's `onLink`); a swipe away runs the JS task "push.dismissed".
 */
internal class NotificationsModule(private val context: Context, private val debug: Boolean) : ZnModuleBase("Notifications", version = 1) {
    private val manager = NotificationManagerCompat.from(context)

    init {
        function("createChannel") { call ->
            val id = call.string("id")
            val name = call.string("name")
            val importance = PushRules.importance(call.stringOrNull("importance"))
                ?: return@function call.reject("invalid_args", "importance must be none, min, low, default or high")
            if (Build.VERSION.SDK_INT >= 26) {
                val ch = NotificationChannel(id, name, importance)
                call.stringOrNull("description")?.let { ch.description = it }
                if (call.booleanOrNull("sound") == false) ch.setSound(null, null)
                ch.enableVibration(call.booleanOrNull("vibration") ?: true)
                ch.enableLights(call.booleanOrNull("lights") ?: false)
                ch.setShowBadge(call.booleanOrNull("badge") ?: true)
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

        function("canShow") { call -> call.resolve(JSONObject().put("reason", blocked(call.stringOrNull("channelId")) ?: JSONObject.NULL)) }

        // On the I/O pool: it may download a picture first.
        function("show") { call -> show(call) }

        function("cancel") { call ->
            val id = call.string("id")
            val group = active().firstOrNull { it.tag == id }?.notification?.group
            manager.cancel(id, PushRules.NOTIFICATION_INT_ID)
            if (group != null) Groups.refresh(context, group, without = id)
            call.resolve(true)
        }

        function("cancelAll") { call ->
            manager.cancelAll()
            call.resolve(true)
        }
    }

    /** Why a notification can't show now (null: it can). With no channel id: only the app-wide switch. */
    private fun blocked(channelId: String?): String? {
        val appOn = manager.areNotificationsEnabled()
        if (channelId == null || Build.VERSION.SDK_INT < 26) return PushRules.blocked(appOn, true, null)
        val ch = manager.getNotificationChannel(channelId)
        return PushRules.blocked(appOn, ch != null, ch?.importance)
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
        blocked(channelId)?.let { reason ->
            Log.w(TAG, "notification $id not shown: $reason")
            return call.resolve(JSONObject().put("shown", false).put("reason", reason))
        }

        val picture = call.stringOrNull("imageUrl")?.let { download(it, PushRules.PICTURE_MAX_PX) }
        val largeIcon = call.stringOrNull("largeIconUrl")?.let { download(it, PushRules.ICON_MAX_PX) }
        val b = NotificationCompat.Builder(context, channelId)
            .setSmallIcon(smallIcon())
            .setContentTitle(title)
            .setAutoCancel(autoCancel)
            .setContentIntent(Groups.tap(context, id, link))
            .setDeleteIntent(Groups.dismissIntent(context, id, groupKey, data))
        body?.let(b::setContentText)
        color()?.let(b::setColor)
        largeIcon?.let(b::setLargeIcon)
        when (PushRules.style(body, bigText, picture != null)) {
            PushRules.Style.PICTURE -> b.setStyle(NotificationCompat.BigPictureStyle().bigPicture(picture).setSummaryText(body))
            PushRules.Style.BIG_TEXT -> b.setStyle(NotificationCompat.BigTextStyle().bigText(bigText ?: body))
            PushRules.Style.PLAIN -> {}
        }
        if (groupKey != null) {
            b.setGroup(groupKey)
            Groups.remember(context, groupKey, channelId, group)
        }
        try {
            manager.notify(id, PushRules.NOTIFICATION_INT_ID, b.build())
        } catch (e: SecurityException) { // the permission was taken away between the check and here
            return call.resolve(JSONObject().put("shown", false).put("reason", "off"))
        }
        if (groupKey != null) Groups.refresh(context, groupKey, with = Groups.Line(id, title, body))
        call.resolve(JSONObject().put("shown", true).put("reason", JSONObject.NULL))
    }

    private fun active() = (context.getSystemService(NotificationManager::class.java)?.activeNotifications ?: emptyArray())
        .filter { it.id == PushRules.NOTIFICATION_INT_ID }

    private fun smallIcon(): Int = Groups.smallIcon(context)

    private fun color(): Int? = meta()?.getInt(META_COLOR, 0)?.takeIf { it != 0 }?.let { context.getColor(it) }

    private fun meta() = try {
        context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData
    } catch (_: Exception) {
        null
    }

    /** A picture for the notification, or null (it then shows without one). Never more than a few seconds. */
    private fun download(url: String, maxPx: Int): Bitmap? {
        if (!PushRules.imageUrlAllowed(url, debug)) {
            Log.w(TAG, "image left out: only https links")
            return null
        }
        return try {
            val c = URL(url).openConnection() as HttpURLConnection
            c.connectTimeout = PushRules.IMAGE_TIMEOUT_MS
            c.readTimeout = PushRules.IMAGE_TIMEOUT_MS
            c.instanceFollowRedirects = true
            try {
                if (c.responseCode !in 200..299) return null
                if (c.contentLengthLong > PushRules.MAX_IMAGE_BYTES) return null
                val out = ByteArrayOutputStream()
                c.inputStream.use { input ->
                    val buf = ByteArray(16 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        if (out.size() > PushRules.MAX_IMAGE_BYTES) return null
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
        private const val TAG = "zn-push"
        /** In the app's manifest: `<meta-data android:name="dev.zeronative.push.small_icon" android:resource="@drawable/..." />`. */
        const val META_SMALL_ICON = "dev.zeronative.push.small_icon"
        const val META_COLOR = "dev.zeronative.push.color"
    }
}
