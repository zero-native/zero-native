package dev.zeronative.plugins.analytics

/**
 * Google Analytics' limits, checked before Firebase sees a call. Firebase itself drops a bad event with only a logcat
 * line; here a bad name answers its reason to JS (a console warning), so the author sees it while building.
 * Limits: https://support.google.com/analytics/answer/9267744 and FirebaseAnalytics' reference.
 * No Android in it, so it runs in plain unit tests: values are Kotlin maps and lists, not JSON or Bundles.
 */
internal object AnalyticsRules {
    const val MAX_NAME = 40
    const val MAX_PARAMS = 25
    const val MAX_STRING = 100
    const val MAX_PROPERTY_NAME = 24
    const val MAX_PROPERTY_VALUE = 36
    const val MAX_USER_ID = 256
    const val MAX_ITEMS = 200
    /** The only parameter that can hold a list: e-commerce items, each a map of its own. */
    const val ITEMS = "items"
    /** Default parameter on every event: the running bundle (`sample_12@1a2b3c4d5e6f`), for OTA comparisons. */
    const val PARAM_BUNDLE = "zn_bundle"

    private val NAME = Regex("^[A-Za-z][A-Za-z0-9_]*$")
    private val RESERVED_PREFIXES = listOf("firebase_", "google_", "ga_")
    // Events Firebase sends itself: an app can't send them.
    private val RESERVED_EVENTS = setOf(
        "ad_activeview", "ad_click", "ad_exposure", "ad_query", "ad_reward", "adunit_exposure", "app_background",
        "app_clear_data", "app_exception", "app_remove", "app_store_refund", "app_store_subscription_cancel",
        "app_store_subscription_convert", "app_store_subscription_renew", "app_upgrade", "app_update", "error",
        "first_open", "first_visit", "in_app_purchase", "notification_dismiss", "notification_foreground",
        "notification_open", "notification_receive", "os_update", "session_start", "session_start_with_rollout",
        "user_engagement",
    )
    private val RESERVED_PROPERTIES = setOf("first_open_after_install", "first_open_time", "first_visit_time", "last_deep_link_referrer", "user_id")

    fun eventNameProblem(name: String): String? =
        nameProblem("event name", name, MAX_NAME) ?: if (name in RESERVED_EVENTS) "event name \"$name\" is Firebase's own" else null

    fun propertyNameProblem(name: String): String? =
        nameProblem("user property name", name, MAX_PROPERTY_NAME)
            ?: if (name in RESERVED_PROPERTIES) "user property name \"$name\" is Firebase's own" else null

    fun userIdProblem(id: String): String? = if (id.length > MAX_USER_ID) "user id is longer than $MAX_USER_ID characters" else null

    /** A user property's value: cut to Analytics' 36 characters (it would cut it the same way). */
    fun propertyValue(value: String): String = value.take(MAX_PROPERTY_VALUE)

    /** An event's parameters, ready for a Bundle: strings, longs, doubles, and [ITEMS] as a list of the same. */
    class Params(val values: Map<String, Any>, val problem: String?)

    /**
     * Checks and converts. Strings are cut to 100 characters (as Analytics does), booleans become 1 or 0 (Analytics has
     * no booleans), null values are left out. A bad name, a list anywhere but [ITEMS], or too many parameters is a
     * problem: the event is not sent.
     */
    fun params(raw: Map<String, Any?>, allowItems: Boolean = true): Params {
        val out = LinkedHashMap<String, Any>()
        for ((key, value) in raw) {
            nameProblem("parameter name", key, MAX_NAME)?.let { return Params(emptyMap(), it) }
            if (value == null) continue
            if (value is List<*>) {
                if (!allowItems || key != ITEMS) return Params(emptyMap(), "parameter \"$key\" is a list: only \"$ITEMS\" can be one")
                if (value.size > MAX_ITEMS) return Params(emptyMap(), "\"$ITEMS\" has more than $MAX_ITEMS entries")
                val items = ArrayList<Map<String, Any>>(value.size)
                for (item in value) {
                    @Suppress("UNCHECKED_CAST")
                    val map = item as? Map<String, Any?> ?: return Params(emptyMap(), "each entry of \"$ITEMS\" must be an object")
                    val p = params(map, allowItems = false)
                    if (p.problem != null) return Params(emptyMap(), "in \"$ITEMS\": ${p.problem}")
                    items += p.values
                }
                out[key] = items
                continue
            }
            out[key] = scalar(value) ?: return Params(emptyMap(), "parameter \"$key\" must be a string, a finite number or a boolean")
        }
        if (out.size > MAX_PARAMS) return Params(emptyMap(), "more than $MAX_PARAMS parameters")
        return Params(out, null)
    }

    private fun scalar(value: Any): Any? = when (value) {
        is String -> value.take(MAX_STRING)
        is Boolean -> if (value) 1L else 0L
        is Int -> value.toLong()
        is Long -> value
        is Double, is Float -> (value as Number).toDouble().takeIf { it.isFinite() }
        is Number -> value.toLong()
        else -> null
    }

    /** The running bundle as a parameter value (100 characters at most). */
    fun bundleValue(label: String): String = label.take(MAX_STRING)

    private fun nameProblem(what: String, name: String, max: Int): String? = when {
        name.isEmpty() -> "$what is empty"
        name.length > max -> "$what \"$name\" is longer than $max characters"
        !NAME.matches(name) -> "$what \"$name\" must start with a letter and have only letters, digits and _"
        RESERVED_PREFIXES.any { name.startsWith(it) } -> "$what \"$name\" starts with a prefix Firebase keeps for itself"
        else -> null
    }
}
