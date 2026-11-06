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

    /** Repeats for a scheduled notification. Fixed lengths: India has no daylight saving, and notifee does the same. */
    fun repeatMs(repeat: String): Long? = when (repeat) {
        "hourly" -> 3_600_000L
        "daily" -> 86_400_000L
        "weekly" -> 604_800_000L
        else -> null
    }

    /** The first time after [now] that a repeat from [at] falls on ([at] itself if it is still ahead). */
    fun nextAt(at: Long, repeat: String, now: Long): Long {
        val step = repeatMs(repeat) ?: return at
        if (at > now) return at
        val missed = (now - at) / step + 1
        return at + missed * step
    }

    /** How long an alarm waits for its notification to show (a broadcast has about 10 s; a picture takes up to 4). */
    const val TRIGGER_SHOW_WAIT_MS = 8_000L
    /** A scheduled notification shows within this long after its time (not exact). Android 12+ allows no less. */
    const val TRIGGER_WINDOW_MS = 600_000L

    /** The name JS uses for one of NotificationManager's importance values (the user may have changed it). */
    fun importanceName(value: Int): String = when {
        value <= 0 -> "none"
        value == 1 -> "min"
        value == 2 -> "low"
        value == 3 -> "default"
        else -> "high"
    }

    enum class Style { PICTURE, INBOX, BIG_TEXT, PLAIN }

    /** A picture wins, then inbox lines, then big text (asked for, or a long body), else plain. */
    fun style(body: String?, bigText: String?, hasPicture: Boolean, hasLines: Boolean = false): Style = when {
        hasPicture -> Style.PICTURE
        hasLines -> Style.INBOX
        bigText != null || (body?.length ?: 0) > BIG_TEXT_FROM -> Style.BIG_TEXT
        else -> Style.PLAIN
    }

    /** The JS task a notification's button runs, and its time (a broadcast receiver has about 10 s with goAsync()). */
    const val ACTION_TASK = "push.action"
    const val ACTION_TIMEOUT_MS = 8_000L
    /** Android shows 3 buttons; more are dropped. */
    const val MAX_ACTIONS = 3
    /** Inbox lines Android shows. */
    const val MAX_LINES = 6
    fun actionRequestCode(id: String, actionId: String): Int = "$id/$actionId".hashCode()

    /** What the lock screen shows (NotificationCompat.VISIBILITY_*): "private" hides the text, "secret" all of it. */
    fun visibility(name: String?): Int? = when (name ?: "private") {
        "public" -> 1
        "private" -> 0
        "secret" -> -1
        else -> null
    }

    /** NotificationCompat.CATEGORY_* by the names JS uses: Android ranks and filters by it (Do Not Disturb). */
    fun category(name: String?): String? = when (name) {
        null -> null
        "message" -> "msg"
        "reminder" -> "reminder"
        "status" -> "status"
        "progress" -> "progress"
        "promo" -> "promo"
        "transport" -> "transport"
        "event" -> "event"
        "social" -> "social"
        "error" -> "err"
        "recommendation" -> "recommendation"
        "service" -> "service"
        else -> ""
    }

    /** A progress bar: [current] within 0..[max]. Null when the values make no bar. */
    class Progress(val max: Int, val current: Int, val indeterminate: Boolean)
    fun progress(max: Int?, current: Int?, indeterminate: Boolean?): Progress? {
        if (indeterminate == true) return Progress(0, 0, true)
        val m = max ?: return null
        if (m <= 0) return null
        return Progress(m, (current ?: 0).coerceIn(0, m), false)
    }

    /** "#RRGGBB" or "#AARRGGBB" to an ARGB int; null when it isn't one. */
    fun color(hex: String?): Int? {
        val h = hex?.removePrefix("#") ?: return null
        if (h.length != 6 && h.length != 8) return null
        val v = h.toLongOrNull(16) ?: return null
        return if (h.length == 6) (0xFF000000 or v).toInt() else v.toInt()
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

    /**
     * The "check for an app update now" push: a data message with `zn_ota=check`. The plugin runs core's OTA check
     * natively and doesn't send the message to JS. The check asks only the app's own OTA server, as at a start.
     */
    const val OTA_KEY = "zn_ota"
    const val OTA_CHECK = "check"
    /** Inside FCM's ~20 s for a message. A download that takes longer goes on in the OTA worker. */
    const val OTA_WAIT_MS = 15_000L
    fun isOtaCheck(data: Map<String, String>): Boolean = data[OTA_KEY] == OTA_CHECK

    /** How long `getInitialNotification` waits for the app's Activity when JS asks before it is there. */
    const val INITIAL_WAIT_MS = 10_000L

    private val HTML = Regex("<[a-zA-Z/!]|&[a-zA-Z]+;|&#[0-9]+;|&#x[0-9a-fA-F]+;")

    /** True when notification text has a tag or an entity, so it is read as HTML (Groups.html). "a < b" isn't. */
    fun looksLikeHtml(text: String): Boolean = HTML.containsMatchIn(text)

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
