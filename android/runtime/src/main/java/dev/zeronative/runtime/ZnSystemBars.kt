package dev.zeronative.runtime

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color

/**
 * React Native's `<StatusBar>` and zn's `<NavigationBar>` (registry 15, docs/guide-notes.md §43).
 *
 * Each element belongs to its screen (the screen entry it is drawn in, also from inside a Modal or a Sheet): while
 * that screen is on top, it sets the bar's icons (barStyle) and, for the status bar, `hidden`. Its backgroundColor is
 * drawn behind the bar by ZnNavHost, for that screen only: Android 15+ draws every app edge to edge and has no bar
 * colour of its own any more, so this works the same on every version. As in RN, several on one screen merge: each
 * value comes from the newest mounted element that sets it. No element: the route's `statusBar` option and the
 * screen's own background decide, as before.
 */
internal object ZnSystemBars {
    /** What one element sets; null = not set (the next older element, or the route, decides). */
    data class Values(val darkIcons: Boolean?, val background: Color?, val hidden: Boolean?)

    /** The merged values for one bar of one screen. */
    class Merged(val darkIcons: Boolean?, val background: Color?, val hidden: Boolean?)

    private class Mounted(val token: Any, val navigation: Boolean, val values: Values)

    /** Per screen entry id: its mounted elements, oldest first. Observable, so the bars follow a change at once. */
    private val screens = mutableStateMapOf<Int, List<Mounted>>()

    /** The status bar's (or, with [navigation], the navigation bar's) merged values for screen [entry]. */
    fun merged(entry: Int, navigation: Boolean): Merged? {
        val list = screens[entry]?.filter { it.navigation == navigation } ?: return null
        if (list.isEmpty()) return null
        var dark: Boolean? = null
        var bg: Color? = null
        var hidden: Boolean? = null
        for (m in list) { // newest last: its values win
            m.values.darkIcons?.let { dark = it }
            m.values.background?.let { bg = it }
            m.values.hidden?.let { hidden = it }
        }
        return Merged(dark, bg, hidden)
    }

    fun put(entry: Int, token: Any, navigation: Boolean, values: Values) {
        val list = screens[entry].orEmpty()
        val i = list.indexOfFirst { it.token === token }
        if (i >= 0 && list[i].values == values) return // unchanged: no state write, nothing redraws
        // An update keeps its place (RN: the newest *mounted* wins, not the last changed).
        screens[entry] = if (i < 0) list + Mounted(token, navigation, values)
        else list.toMutableList().also { it[i] = Mounted(token, navigation, values) }
    }

    fun remove(entry: Int, token: Any) {
        val list = screens[entry] ?: return
        val left = list.filter { it.token !== token }
        if (left.isEmpty()) screens.remove(entry) else screens[entry] = left
    }

    /** Reload (dev) or a new bundle: no screen keeps its elements. */
    fun reset() = screens.clear()
}

/** A `<StatusBar>` / `<NavigationBar>` element: takes no space, registers its values for its screen. */
@Composable
internal fun ZnBarElement(s: ZnNodeSpec, inst: ZnInstance, navigation: Boolean) {
    val entry = LocalZnEntry.current
    if (entry == 0) return // not in a screen (a preview): nothing to set
    val style = if (s.barStyleSlot >= 0) barStyleOf(inst.slot(s.barStyleSlot).value as? String) else s.barStyle
    val background = if (s.backgroundSlot >= 0) toColor(inst.slot(s.backgroundSlot).value) else s.background
    val hidden = if (s.hiddenSlot >= 0) inst.slot(s.hiddenSlot).value as? Boolean else if (s.hasHiddenProp) s.hidden else null
    val values = ZnSystemBars.Values(
        darkIcons = when (style) {
            Registry.BarStyle.DARK_CONTENT -> true
            Registry.BarStyle.LIGHT_CONTENT -> false
            else -> null // "default" or not set: the route's option
        },
        background = background,
        hidden = if (navigation) null else hidden,
    )
    val token = remember { Any() }
    SideEffect { ZnSystemBars.put(entry, token, navigation, values) }
    DisposableEffect(entry, token) { onDispose { ZnSystemBars.remove(entry, token) } }
}

private fun barStyleOf(v: String?): Int = when (v) {
    "dark-content" -> Registry.BarStyle.DARK_CONTENT
    "light-content" -> Registry.BarStyle.LIGHT_CONTENT
    "default" -> Registry.BarStyle.DEFAULT
    else -> -1
}
