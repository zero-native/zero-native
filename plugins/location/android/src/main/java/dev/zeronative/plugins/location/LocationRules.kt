package dev.zeronative.plugins.location

/** The location plugin's rules, apart from Android (LocationRulesTest). Times are `elapsedRealtime` ms, not the clock. */
object LocationRules {
    const val GPS = "gps"
    const val NETWORK = "network"

    /** A fix as the rules see it. [accuracyM]: null when the provider gave none. */
    data class Fix(val latitude: Double, val longitude: Double, val accuracyM: Float?, val provider: String, val realtimeMs: Long)

    /** How good a fix must be before a one-shot stops early. LOW takes the first fix and never starts the GPS. */
    enum class Accuracy(val goodEnoughM: Float) {
        HIGH(25f),
        BALANCED(100f),
        LOW(Float.MAX_VALUE),
    }

    const val TIMEOUT_DEFAULT_MS = 10_000L
    const val TIMEOUT_MIN_MS = 500L
    /** Our own cap: a forgotten call can't keep the GPS on. */
    const val TIMEOUT_MAX_MS = 60_000L
    const val INTERVAL_DEFAULT_MS = 5_000L
    const val INTERVAL_MIN_MS = 1_000L
    const val INTERVAL_MAX_MS = 600_000L
    const val DISTANCE_MAX_M = 10_000.0
    /** A fix this much older than the ask is a cached one a provider sent at once, not a new one. */
    const val FRESH_SLACK_MS = 2_000L
    /**
     * With the rough permission only, Android sends an app a new fix at most every 10 minutes, and the cached rough one
     * at once. So that one counts (seen on the Lava: a 155 s old fix, then nothing until the timeout).
     */
    const val ROUGH_SLACK_MS = 11 * 60_000L
    const val GEOCODE_MAX = 5

    /** The launch key for Google's "turn on location" dialog (plugins/location/src/index.ts TURN_ON_KEY). */
    const val TURN_ON_KEY = "location.turn-on"
    /** Play services can be slow to answer, or busy updating itself: its Task may never finish. */
    const val TURN_ON_ASK_MS = 8_000L
    /** CommonStatusCodes.RESOLUTION_REQUIRED: the user can fix it in Google's dialog. */
    const val RESOLUTION_REQUIRED = 6

    /**
     * What to do with Play services' "the settings are not right" answer: "dialog", or "unavailable". Only
     * RESOLUTION_REQUIRED opens the dialog. Another resolvable code (Play services missing or too old) would open an
     * update screen, which is not what the user tapped for.
     */
    fun turnOnStep(statusCode: Int, resolvable: Boolean) = if (resolvable && statusCode == RESOLUTION_REQUIRED) "dialog" else "unavailable"

    /** null: not a known name. A missing name is BALANCED. */
    fun accuracy(name: String?): Accuracy? = when (name) {
        null, "balanced" -> Accuracy.BALANCED
        "high" -> Accuracy.HIGH
        "low" -> Accuracy.LOW
        else -> null
    }

    fun timeoutMs(value: Long?) = (value ?: TIMEOUT_DEFAULT_MS).coerceIn(TIMEOUT_MIN_MS, TIMEOUT_MAX_MS)
    fun maxAgeMs(value: Long?) = (value ?: 0L).coerceAtLeast(0L)
    fun intervalMs(value: Long?) = (value ?: INTERVAL_DEFAULT_MS).coerceIn(INTERVAL_MIN_MS, INTERVAL_MAX_MS)
    fun distanceM(value: Double?) = (value ?: 0.0).coerceIn(0.0, DISTANCE_MAX_M).toFloat()
    fun geocodeMax(value: Int?) = (value ?: 1).coerceIn(1, GEOCODE_MAX)

    /** A real place: finite, in range, and not 0,0, which some phones send when they have no fix. */
    fun valid(latitude: Double, longitude: Double) =
        latitude.isFinite() && longitude.isFinite() &&
            latitude in -90.0..90.0 && longitude in -180.0..180.0 &&
            !(latitude == 0.0 && longitude == 0.0)

    /**
     * The providers to ask. GPS needs the precise permission (Android throws otherwise). [onlyOn]: skip a provider that
     * is turned off, for a one-shot. A watch keeps them all, so fixes start again when the user turns location back on.
     */
    fun providers(
        accuracy: Accuracy,
        fine: Boolean,
        coarse: Boolean,
        has: Set<String>,
        on: Set<String>,
        onlyOn: Boolean,
    ): List<String> {
        fun usable(p: String) = p in has && (!onlyOn || p in on)
        val gps = fine && usable(GPS)
        val network = (fine || coarse) && usable(NETWORK)
        return when {
            accuracy == Accuracy.LOW && network -> listOf(NETWORK)
            else -> listOfNotNull(GPS.takeIf { gps }, NETWORK.takeIf { network })
        }
    }

    /** Why a one-shot can't start, or null when it can. */
    fun cantStart(fine: Boolean, coarse: Boolean, enabled: Boolean, providers: List<String>, inFront: Boolean): String? = when {
        !fine && !coarse -> "denied"
        !inFront -> "background" // Android gives a hidden app no fix without the background permission, which we never ask
        !enabled -> "off"
        providers.isEmpty() -> "unavailable"
        else -> null
    }

    fun fresh(fix: Fix, startMs: Long, precise: Boolean) = fix.realtimeMs >= startMs - if (precise) FRESH_SLACK_MS else ROUGH_SLACK_MS

    /** The more accurate one. A fix with no accuracy loses. Same accuracy: the newer one. */
    fun better(best: Fix?, fix: Fix): Fix {
        if (best == null) return fix
        val a = best.accuracyM ?: Float.MAX_VALUE
        val b = fix.accuracyM ?: Float.MAX_VALUE
        return when {
            b < a -> fix
            b == a && fix.realtimeMs > best.realtimeMs -> fix
            else -> best
        }
    }

    /** Without the precise permission every fix is blurred to about 2 km: waiting can't make it better, so the first one wins. */
    fun goodEnough(fix: Fix, accuracy: Accuracy, precise: Boolean) =
        !precise || accuracy == Accuracy.LOW || (fix.accuracyM != null && fix.accuracyM <= accuracy.goodEnoughM)

    fun newest(fixes: List<Fix>): Fix? = fixes.maxByOrNull { it.realtimeMs }

    /** A cached fix answers at once only if the caller allowed one this old. */
    fun cachedOk(fix: Fix?, nowMs: Long, maxAgeMs: Long) = fix != null && maxAgeMs > 0 && nowMs - fix.realtimeMs <= maxAgeMs

    /**
     * Should a watch send this fix? With GPS and network both on, a worse network fix right after a GPS one would make
     * the dot jump. So a fix from the other provider passes only if it is as good, or the last one is old.
     */
    fun watchKeeps(last: Fix?, fix: Fix, intervalMs: Long): Boolean =
        last == null ||
            fix.provider == last.provider ||
            (fix.accuracyM ?: Float.MAX_VALUE) <= (last.accuracyM ?: Float.MAX_VALUE) ||
            fix.realtimeMs - last.realtimeMs >= 2 * intervalMs
}
