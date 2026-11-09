package dev.zeronative.plugins.android.adid

/** What `AdId.get` answers, from what Play services gave (pure, so a JVM test can check it). */
internal object AdIdRules {
    class Answer(val id: String?, val limitAdTracking: Boolean)

    /**
     * [id] as given, but null when there is none: blank, or all zeros. Android 12+ gives all zeros when the user
     * deleted the id; Android 13+ also when the app has no AD_ID permission. A deleted id also means "don't track",
     * so [limitAdTracking] is true then. A real id with [limitAdTracking] true (Android 11 and older, or an id the
     * user didn't delete) stays: the app must respect it (README).
     */
    fun answer(id: String?, limitAdTracking: Boolean): Answer {
        val clean = id?.trim()?.takeIf { it.isNotEmpty() }
        val zeros = clean != null && clean.all { it == '0' || it == '-' }
        return Answer(if (zeros) null else clean, limitAdTracking || zeros)
    }
}
