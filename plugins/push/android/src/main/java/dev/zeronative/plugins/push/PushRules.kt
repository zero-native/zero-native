package dev.zeronative.plugins.push

/** FCM's choices with no Android in them, so plain JVM tests can check them. Notification rules: plugins/notifications. */
internal object PushRules {
    /** FCM's own rule for topic names. */
    fun validTopic(topic: String): Boolean = TOPIC.matches(topic)
    private val TOPIC = Regex("[a-zA-Z0-9\\-_.~%]{1,900}")

    /**
     * What FCM's token errors mean for the app. FCM says SERVICE_NOT_AVAILABLE both with no network and with no Play
     * services, so "not_now" covers both: try again later (at the next start, or when the network is back).
     */
    fun tokenReason(message: String?): String = when {
        message == null -> "failed"
        message.contains("MISSING_INSTANCEID_SERVICE") -> "no_play_services"
        message.contains("SERVICE_NOT_AVAILABLE") || message.contains("TIMEOUT") || message.contains("INTERNAL_SERVER_ERROR") -> "not_now"
        else -> "failed"
    }

    /**
     * The "check for an app update now" push: a data message with `zn_ota=check`. The plugin runs core's OTA check
     * natively and doesn't send the message to JS. The check asks only the app's own OTA server, as at a start.
     */
    const val OTA_KEY = "zn_ota"
    const val OTA_CHECK = "check"
    /** Inside FCM's ~20 s for a message. A download that takes longer goes on in the OTA worker. */
    const val OTA_WAIT_MS = 15_000L
    fun isOtaCheck(data: Map<String, String>): Boolean = data[OTA_KEY] == OTA_CHECK

    /** The Intent a tap on FCM's own notification opens has this extra (and the message's data as extras). */
    const val EXTRA_MESSAGE_ID = "google.message_id"
    fun isFcmTap(extras: Map<String, Any?>): Boolean = extras[EXTRA_MESSAGE_ID] is String

    /** The message's own data from such an Intent's extras: FCM's keys (google.*, gcm.*, from, collapse_key) left out. */
    fun tapData(extras: Map<String, Any?>): Map<String, String> = extras
        .filterKeys { !it.startsWith("google.") && !it.startsWith("gcm.") && it != "from" && it != "collapse_key" }
        .mapNotNull { (k, v) -> (v as? String)?.let { k to it } }
        .toMap()

    /** google.sent_time is a Long in the extras (a String on some versions): ms since 1970, 0 when missing. */
    fun sentAt(value: Any?): Long = when (value) {
        is Long -> value
        is String -> value.toLongOrNull() ?: 0L
        else -> 0L
    }
}
