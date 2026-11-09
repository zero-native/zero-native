package dev.zeronative.plugins.firebase.messaging

import dev.zeronative.plugins.notifications.PushEvents
import org.json.JSONObject

/**
 * Taps on the notifications FCM shows itself (a message with a `notification` block while the app is behind or
 * closed): RN Firebase's `getInitialNotification()` and `onNotificationOpenedApp`. The tap rules are the notifications
 * plugin's ([PushEvents.taps]); this file only reads FCM's extras.
 */
internal val Opens = PushEvents.taps("FCM's notification") { intent ->
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
