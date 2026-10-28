package dev.zeronative.exp4

import android.util.Log
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

data class NavEntry(
    val route: String,
    val params: Map<String, Any?>,
    val entryId: Int
)

object NavigationManager {
    private const val TAG = "zn-nav"

    val backStack = mutableStateListOf(
        NavEntry("/amount", emptyMap(), 0)
    )

    var isForwardTransition by mutableStateOf(true)
        private set

    val currentEntry: NavEntry
        get() = backStack.lastOrNull() ?: NavEntry("/amount", emptyMap(), 0)

    fun push(route: String, params: Map<String, Any?>, entryId: Int) {
        Log.i(TAG, "[NAV] push: route=$route, entryId=$entryId, params=$params")
        isForwardTransition = true
        backStack.add(NavEntry(route, params, entryId))
    }

    fun pop() {
        if (backStack.size > 1) {
            val popped = backStack.removeAt(backStack.size - 1)
            Log.i(TAG, "[NAV] pop: popped route=${popped.route}, returning to ${currentEntry.route}")
            isForwardTransition = false
        } else {
            Log.i(TAG, "[NAV] pop called but backStack has only 1 entry")
        }
    }

    fun replace(route: String, params: Map<String, Any?>, entryId: Int) {
        Log.i(TAG, "[NAV] replace: route=$route, entryId=$entryId")
        isForwardTransition = true
        if (backStack.isNotEmpty()) {
            backStack.removeAt(backStack.size - 1)
        }
        backStack.add(NavEntry(route, params, entryId))
    }

    fun reset(route: String = "/amount", params: Map<String, Any?> = emptyMap(), entryId: Int = 0) {
        Log.i(TAG, "[NAV] reset: route=$route, entryId=$entryId")
        isForwardTransition = false
        backStack.clear()
        backStack.add(NavEntry(route, params, entryId))
    }

    fun clear() {
        backStack.clear()
        backStack.add(NavEntry("/amount", emptyMap(), 0))
        isForwardTransition = true
    }
}

