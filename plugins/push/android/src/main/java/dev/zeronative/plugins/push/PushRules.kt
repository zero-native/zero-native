package dev.zeronative.plugins.push

/** The plugin's choices with no Android in them, so plain JVM tests can check them. */
internal object PushRules {
    /** JS tasks (core's `defineTask`) the plugin runs. The JS side names them the same (src/index.ts). */
    const val MESSAGE_TASK = "push.message"
    const val TOKEN_TASK = "push.token"
    const val DISMISS_TASK = "push.dismissed"

    /** FCM gives a message about 20 s; JS gets 15, so the service still answers in time after a cold start. */
    const val MESSAGE_TIMEOUT_MS = 15_000L
    const val TOKEN_TIMEOUT_MS = 10_000L
    /** A broadcast receiver has about 10 s with goAsync(). */
    const val DISMISS_TIMEOUT_MS = 8_000L

    /** Images in a notification: small, quick, or left out. */
    const val IMAGE_TIMEOUT_MS = 4_000
    const val MAX_IMAGE_BYTES = 3 * 1024 * 1024
    const val PICTURE_MAX_PX = 1_024
    const val ICON_MAX_PX = 256

    /** A group shows its summary from this many notifications on (Android's own grouping starts at 4). */
    const val SUMMARY_FROM = 2
    /** Lines in the summary's inbox style (Android shows at most 5 or 6). */
    const val SUMMARY_LINES = 5
    /** A body longer than this gets the expandable "big text" style. */
    const val BIG_TEXT_FROM = 40

    /** NotificationManager's importance values, by the names JS uses. */
    fun importance(name: String?): Int? = when (name ?: "default") {
        "none" -> 0
        "min" -> 1
        "low" -> 2
        "default" -> 3
        "high" -> 4
        else -> null
    }

    enum class Style { PICTURE, BIG_TEXT, PLAIN }

    fun style(body: String?, bigText: String?, hasPicture: Boolean): Style = when {
        hasPicture -> Style.PICTURE
        bigText != null || (body?.length ?: 0) > BIG_TEXT_FROM -> Style.BIG_TEXT
        else -> Style.PLAIN
    }

    /** https only; http also in debug builds (a test server on the computer). */
    fun imageUrlAllowed(url: String, debug: Boolean): Boolean {
        val u = url.trim().lowercase()
        return u.startsWith("https://") || (debug && u.startsWith("http://"))
    }

    /** FCM's own rule for topic names. */
    fun validTopic(topic: String): Boolean = TOPIC.matches(topic)
    private val TOPIC = Regex("[a-zA-Z0-9\\-_.~%]{1,900}")

    /** A notification's id is the app's own string; Android also wants an int: one fixed int, the string as the tag. */
    const val NOTIFICATION_INT_ID = 0x7A6E
    fun summaryTag(group: String) = "zn-summary:$group"
    fun isSummaryTag(tag: String?) = tag?.startsWith("zn-summary:") == true

    /** The summary's line for one notification: "**title**: body" in Android's inbox style (bold is done by the caller). */
    fun inboxLine(title: String?, body: String?): String = listOfNotNull(title?.takeIf { it.isNotBlank() }, body?.takeIf { it.isNotBlank() })
        .joinToString(": ")

    /** "%d new offers" → "3 new offers". No %d: the text as it is. */
    fun summaryText(format: String?, count: Int): String? = format?.replace("%d", count.toString())

    /** Why a notification can't be shown now, or null if it can. */
    fun blocked(appEnabled: Boolean, channelExists: Boolean, channelImportance: Int?): String? = when {
        !appEnabled -> "off" // the permission (Android 13+), or the user turned the app's notifications off
        !channelExists -> "no_channel"
        channelImportance == 0 -> "channel_blocked"
        else -> null
    }

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
}
