package dev.zeronative.plugins.crashlytics

/** The plugin's choices with no Android in them, so plain JVM tests can check them. */
internal object CrashlyticsRules {
    /** The running bundle as reports name it: `sample_12@1a2b3c4d5e6f` (`bun run ota symbolicate` finds the map by it). */
    const val KEY_BUNDLE = "zn_bundle"
    /** The bundle id alone (`sample_12`): the console filter for "all crashes of this OTA bundle". */
    const val KEY_BUNDLE_ID = "zn_bundle_id"
    /** True: the APK's own bundle. False: a downloaded (OTA) one. */
    const val KEY_BUILT_IN = "zn_built_in"
    /** The APK's host API (`ZnPlugins.HOST_API`). */
    const val KEY_HOST_API = "zn_host_api"
    /** The top route's name, updated on every screen change. */
    const val KEY_ROUTE = "zn_route"
    /** The last JS error's kind ("screen", "handler", "async", "hang", "start", "renderer", "recorded"). */
    const val KEY_JS_KIND = "zn_js_kind"

    /**
     * JS errors sent per process. An error in a loop (a timer, a list item) would otherwise send hundreds; Crashlytics
     * keeps only the newest 8 non-fatals of a session anyway. The rest are counted in one log line.
     */
    const val MAX_JS_ERRORS = 30
    /** The JS stack goes in a log line too (with columns, for `ota symbolicate`). Crashlytics keeps 64 KB of logs. */
    const val MAX_LOG_CHARS = 4_000
    /** Crashlytics' own limit for a key and a value. */
    const val MAX_KEY_CHARS = 1_024

    /** A recorded error's text, like core's errors.ts: Hermes' stack starts with "Error: message" already. */
    fun details(name: String?, message: String, stack: String?): String {
        val s = stack.orEmpty()
        if (s.isNotEmpty() && s.contains(message)) return s
        val head = if (name.isNullOrEmpty()) message else "$name: $message"
        return if (s.isEmpty()) head else "$head\n$s"
    }

    /** `sample_12@1a2b3c4d5e6f` → `sample_12`. */
    fun bundleId(label: String): String = label.substringBefore('@')

    fun routeLog(from: String?, to: String?): String = "nav: ${from ?: "-"} -> ${to ?: "-"}"

    fun otaLog(kind: String, bundle: String?, detail: String?): String =
        "ota: $kind${bundle?.let { " $it" } ?: ""}${detail?.let { ": $it" } ?: ""}"

    /** What Crashlytics can keep as a key's value: a string, a boolean or a number. Else null. */
    fun keyValue(value: Any?): Any? = when (value) {
        is String -> value.take(MAX_KEY_CHARS)
        is Boolean -> value
        is Int, is Long -> (value as Number).toLong()
        is Number -> value.toDouble().let { if (it == Math.rint(it) && Math.abs(it) < 9.0E15) it.toLong() else it }
        else -> null
    }

    fun validKey(key: String): Boolean = key.isNotEmpty() && key.length <= MAX_KEY_CHARS

    /** Counts JS errors so one process sends at most [max]. */
    class Budget(private val max: Int = MAX_JS_ERRORS) {
        var dropped = 0
            private set
        private var used = 0

        /** True: send this one. False: over the budget (counted in [dropped]). */
        fun take(): Boolean {
            if (used < max) {
                used++
                return true
            }
            dropped++
            return false
        }
    }
}

/**
 * A serious OTA outcome (a rollback, a blocked bundle) as a Crashlytics non-fatal. One stack frame named after the
 * outcome's kind, so Crashlytics makes one issue per kind; the bundle is in the message and in [CrashlyticsRules.KEY_BUNDLE].
 */
class ZnOtaEventException(val kind: String, bundle: String?, detail: String?) :
    RuntimeException(CrashlyticsRules.otaLog(kind, bundle, detail).removePrefix("ota: ").let { "OTA $it" }) {
    init {
        stackTrace = arrayOf(StackTraceElement("zn.ota", kind, "ota", 0))
    }

    override fun fillInStackTrace(): Throwable = this // where it was made means nothing
}
