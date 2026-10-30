package dev.zeronative.runtime

/**
 * App-level events: native → JS events that belong to the app, not to a screen node (instance [APP]). Every number is
 * listed here once, and packages/core/src/app-events.ts must say the same (a JS test compares them). Two parts of the
 * runtime using one number would silently take each other's events: step 3.9 gave RETRY the number of native call
 * answers (7), and every native call answered after the app started was dropped (found in step 4.5).
 */
internal object ZnAppEvent {
    const val APP = 0

    const val START = 1
    const val BACK = 2
    const val FORCED_BACK = 3
    const val OPEN = 4
    const val INSETS = 5
    const val IMPRESSIONS = 6
    const val CALL_RESULT = 7
    const val MODULE_EVENT = 8
    const val CALL_RESULT_BYTES = 9
    const val RETRY = 10
}
