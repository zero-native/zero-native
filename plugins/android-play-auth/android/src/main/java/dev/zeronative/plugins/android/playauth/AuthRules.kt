package dev.zeronative.plugins.android.playauth

import java.security.MessageDigest

/** The plugin's rules, apart from Android, so they run on the JVM (AuthRulesTest). */
internal object AuthRules {
    /** The launch key of the phone number hint. plugins/android-play-auth/src/index.ts uses the same one. */
    const val HINT_KEY = "auth.phone-hint"

    /** The first number of exactly 4 or 6 digits, as RN does. A message with two numbers needs the app's own pattern. */
    const val DEFAULT_PATTERN = "\\b(\\d{4}|\\d{6})\\b"

    /** Play services stops the SMS Retriever after 5 minutes, so a longer wait could never get a code. */
    const val MAX_WAIT_MS = 5 * 60 * 1000L
    const val MIN_WAIT_MS = 1000L

    /** How long Play services gets to give us the hint. After that the user is typing, and a late sheet would be in the way. */
    const val HINT_ASK_MS = 10_000L

    private const val RESULT_OK = -1

    // CommonStatusCodes in Play services. AuthRulesTest compares them.
    const val STATUS_SUCCESS = 0
    const val STATUS_TIMEOUT = 15

    private const val HASH_BYTES = 9
    private const val HASH_CHARS = 11

    /** [phone] or [reason] is set, never both. */
    class HintAnswer(val phone: String?, val reason: String?)

    /** [code] or [reason] is set, never both. */
    class OtpAnswer(val code: String?, val reason: String?)

    /** Anything but a real number means "type it by hand". [read] may throw: Play services does that for no number. */
    fun hintAnswer(resultCode: Int, hasData: Boolean, read: () -> String?): HintAnswer {
        if (resultCode != RESULT_OK) return HintAnswer(null, "cancelled")
        if (!hasData) return HintAnswer(null, "no_number")
        val phone = try {
            read()
        } catch (_: Throwable) {
            null
        }
        return if (phone.isNullOrBlank()) HintAnswer(null, "no_number") else HintAnswer(phone, null)
    }

    /** Null: the app's pattern is not a valid pattern. */
    fun pattern(custom: String?): Regex? = try {
        Regex(custom ?: DEFAULT_PATTERN)
    } catch (_: IllegalArgumentException) {
        null
    }

    /** The first match. If the pattern has a group, the code is group 1. */
    fun extractCode(message: String, pattern: Regex): String? {
        val match = pattern.find(message) ?: return null
        val group = match.groupValues.getOrNull(1)
        val code = if (group.isNullOrEmpty()) match.value else group
        return code.takeUnless { it.isBlank() }
    }

    /** What one broadcast from the SMS Retriever means. Every status ends the wait, so a screen never waits on it. */
    fun otpAnswer(status: Int, message: String?, pattern: Regex): OtpAnswer = when (status) {
        STATUS_SUCCESS -> {
            val code = extractCode(message.orEmpty(), pattern)
            if (code != null) OtpAnswer(code, null) else OtpAnswer(null, "no_code")
        }
        STATUS_TIMEOUT -> OtpAnswer(null, "timeout")
        else -> OtpAnswer(null, "failed")
    }

    fun waitMs(asked: Long?): Long = (asked ?: MAX_WAIT_MS).coerceIn(MIN_WAIT_MS, MAX_WAIT_MS)

    /** Google's 11-char hash. [base64] is Android's: java.util.Base64 needs API 26, and we support 24. */
    fun appHash(packageName: String, signature: String, base64: (ByteArray) -> String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest("$packageName $signature".toByteArray(Charsets.UTF_8))
        return base64(digest.copyOfRange(0, HASH_BYTES)).substring(0, HASH_CHARS)
    }
}

/** The one request that waits. A new one hands back the old one, so its caller can answer it: nothing hangs. */
internal class Latest<T : Any> {
    var current: T? = null
        private set

    /** [next] is now the waiting one. Returns the one it replaced. */
    fun begin(next: T): T? = current.also { current = next }

    /** True for the first end of the waiting one. False means it was answered or replaced already. */
    fun end(item: T): Boolean {
        if (current !== item) return false
        current = null
        return true
    }
}
