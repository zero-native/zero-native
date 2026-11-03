package dev.zeronative.runtime

import androidx.compose.runtime.Composable
import org.json.JSONObject

/** A plugin's native screen: a composable, drawn in the normal back stack (docs/plugins.md §5). */
typealias ZnScreenContent = @Composable (ZnScreenScope) -> Unit

/** What a native screen gets. Back works by itself. A plugin adds a screen with `r.screen(name) { scope -> ... }`. */
class ZnScreenScope internal constructor(private val entry: ZnEntry) {
    private var answered = false

    /** The route's params. */
    val params: JSONObject = JSONObject(entry.params)

    /**
     * Closes the screen with [value], which `nav.pushForResult` or `onNavResult` gets. Only the first answer counts: a second
     * one (a double scan) is dropped. Main thread.
     */
    fun finish(value: JSONObject) {
        if (answered) return
        answered = true
        ZnNav.answer(entry, value.toString())
    }

    /** Closes the screen with no answer: the same as Back. */
    fun cancel() {
        if (answered) return
        answered = true
        ZnNav.systemBack()
    }
}

internal object ZnNativeScreens {
    private val screens = HashMap<String, ZnScreenContent>()

    fun has(name: String) = name in screens
    fun get(name: String): ZnScreenContent? = screens[name]
    fun add(name: String, content: ZnScreenContent) {
        screens[name] = content
    }
}
