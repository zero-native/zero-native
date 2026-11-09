package dev.zeronative.plugins.firebase.messaging

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
     * The "check for an app update" push: a data message with `zn_ota=check`. The plugin doesn't send it to JS: it
     * schedules a background job ([OtaCheckJob]) that runs core's OTA check natively, after a random wait of 0 ..
     * `zn_ota_delay_ms`, once the phone is online. The check asks only the app's own OTA server, as at a start.
     */
    const val OTA_KEY = "zn_ota"
    const val OTA_CHECK = "check"
    /** The longest random wait the server asks for, in whole ms (a string, as all FCM data). Missing or bad: 0. */
    const val OTA_DELAY_KEY = "zn_ota_delay_ms"
    /** A message can't ask for a longer wait than this (one day). */
    const val OTA_MAX_DELAY_MS = 24 * 60 * 60 * 1000L
    /** WorkManager stops a job after 10 min: the job waits for the check at most this long. */
    const val OTA_WAIT_MS = 8 * 60 * 1000L
    /** Runs of the job in all: the first and up to 2 retries after a failed check. */
    const val OTA_MAX_RUNS = 3
    fun isOtaCheck(data: Map<String, String>): Boolean = data[OTA_KEY] == OTA_CHECK

    /** The message's longest wait: whole ms, clamped to 0 .. [OTA_MAX_DELAY_MS]; missing or not a number is 0. */
    fun otaMaxDelayMs(data: Map<String, String>): Long =
        data[OTA_DELAY_KEY]?.trim()?.toLongOrNull()?.coerceIn(0L, OTA_MAX_DELAY_MS) ?: 0L

    /** The wait for this phone: random in 0 .. [maxMs], both ends included, so phones don't all ask at once. */
    fun otaDelayMs(maxMs: Long, random: kotlin.random.Random = kotlin.random.Random): Long =
        if (maxMs <= 0) 0L else random.nextLong(maxMs.coerceAtMost(OTA_MAX_DELAY_MS) + 1)

    /**
     * The FCM topic the OTA server sends `zn_ota=check` to: `zn-ota-<app>-<channel>` (app: the APK's bundle's app id;
     * channel: ZnOta's channel). Null if the name breaks FCM's topic rule.
     */
    fun otaTopic(app: String, channel: String): String? = "zn-ota-$app-$channel".takeIf { app.isNotEmpty() && channel.isNotEmpty() && validTopic(it) }

    /** The kept topic to unsubscribe once [now] is subscribed: the old one if it changed (another channel or app). */
    fun otaTopicToDrop(old: String?, now: String): String? = old?.takeIf { it != now }

    /**
     * Whether a failed check is worth another run of the job: no answer from the server or a cut download (the network,
     * or a server that was down). A refused signature or a bundle that doesn't fit stays the same on a retry.
     * [reason] and [error] are from ZnOta.check's answer (`ERROR`, `"<code>: <message>"`).
     */
    fun otaRetry(reason: String, error: String?): Boolean =
        reason == "ERROR" && error?.substringBefore(':')?.trim() in RETRY_CODES
    private val RETRY_CODES = setOf("failed", "server", "download")

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
