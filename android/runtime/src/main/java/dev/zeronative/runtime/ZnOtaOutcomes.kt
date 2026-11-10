package dev.zeronative.runtime

/**
 * How the OTA client keeps its outcomes (what happened, sent with the next check) while checks fail. Pure rules, so
 * they can be tested without Android (ZnOtaOutcomesTest). Second-opinions #217 (Fable's review, 2026-11-10): an app
 * that checks on every return (ZeroBill) and is offline for a while stored one outcome per failed check, and only the
 * last 20 were kept, so a `launch_crashed` or `error_rollback` was pushed out before it reached the server.
 */
internal object ZnOtaOutcomes {
    /**
     * Keeps at most [max] items, oldest dropped first, but plain ones before serious ones: a serious item goes only
     * when the list holds nothing else to drop. The order of what stays doesn't change.
     */
    fun <T> trim(items: List<T>, max: Int, serious: (T) -> Boolean): List<T> {
        if (items.size <= max) return items
        var plainToDrop = minOf(items.size - max, items.count { !serious(it) })
        var seriousToDrop = items.size - max - plainToDrop
        val kept = ArrayList<T>(max)
        for (item in items) {
            when {
                !serious(item) && plainToDrop > 0 -> plainToDrop--
                serious(item) && seriousToDrop > 0 -> seriousToDrop--
                else -> kept += item
            }
        }
        return kept
    }

    /**
     * True when a failed check's outcome [kind] can replace [last] instead of adding one more: the same failure again
     * (no bundle named, not serious). Many failed checks in a row then cost one place, not one each.
     */
    fun sameFailureAgain(lastKind: String?, lastHasBundle: Boolean, kind: String, serious: Boolean): Boolean =
        !serious && !lastHasBundle && lastKind == kind
}
