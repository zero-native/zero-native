package dev.zeronative.runtime

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException

/**
 * One route from the bundle manifest (ARCHITECTURE.md §11). [index] is its position in the table: the number the
 * runtime uses for it (the `NAV` op, step 2.2). Written by the compiler from the app's `defineRoutes({...})`.
 */
class ZnRoute(
    val index: Int,
    val name: String,
    val path: String,
    /** Template id of the screen's root. */
    val templateId: Int,
    val transition: Transition,
    /** Which edges native keeps clear of the system bars (step 2.3). */
    val safeTop: Boolean,
    val safeBottom: Boolean,
    /** True = dark status / navigation bar icons (for light screens). */
    val darkBarIcons: Boolean,
    /** Only routes that allow it can be opened from a link. */
    val deepLink: Boolean,
    /** True: the screen shrinks to the space above the keyboard (the `keyboard: "resize"` option, the default). */
    val resizeForKeyboard: Boolean = true,
    /** False: not reopened after Android kills the app in the background (the `restore` option, default true). */
    val restore: Boolean = true,
    /** A plugin's native screen ("scanner.full"), or null. Such a route has no template: [templateId] is -1. */
    val native: String? = null,
    /** True: no screenshots or recordings while this route is on top (the `secure` option). */
    val secure: Boolean = false,
) {
    enum class Transition { PUSH, MODAL, FADE, NONE }

    /** Path segments; a segment starting with ':' is a param. "/" has none. */
    internal val segments: List<String> = path.split('/').filter { it.isNotEmpty() }
}

/** A deep link resolved to a route, with its params decoded. */
data class ZnRouteMatch(val route: ZnRoute, val params: Map<String, String>)

/** The route table of a bundle. */
class ZnRoutes(val all: List<ZnRoute>) {
    private val byName = all.associateBy { it.name }

    fun named(name: String): ZnRoute? = byName[name]

    fun at(index: Int): ZnRoute? = all.getOrNull(index)

    /** Where the app starts when there is nothing to restore or open: the route with path "/". */
    val start: ZnRoute? = all.firstOrNull { it.path == "/" }

    /**
     * Matches the path of a link (`/pay/m%202`, query and fragment ignored) against routes that allow deep links.
     * A literal segment beats a param in the same place, so `/pay/new` wins over `/pay/:id` for "new".
     * Returns null if nothing matches, or if a param doesn't decode to valid text.
     */
    fun matchDeepLink(rawPath: String): ZnRouteMatch? {
        val path = rawPath.substringBefore('?').substringBefore('#')
        val parts = path.split('/').filter { it.isNotEmpty() }
        var best: ZnRouteMatch? = null
        var bestLiterals = -1
        for (route in all) {
            if (!route.deepLink || route.segments.size != parts.size) continue
            val params = HashMap<String, String>()
            var literals = 0
            var ok = true
            for (i in parts.indices) {
                val seg = route.segments[i]
                if (seg.startsWith(':')) {
                    val value = percentDecode(parts[i])
                    if (value.isNullOrEmpty()) { ok = false; break }
                    params[seg.substring(1)] = value
                } else if (seg == parts[i]) {
                    literals++
                } else {
                    ok = false; break
                }
            }
            if (ok && literals > bestLiterals) {
                best = ZnRouteMatch(route, params)
                bestLiterals = literals
            }
        }
        return best
    }

    companion object {
        /** `%XX` → bytes → UTF-8 text. '+' stays '+' (paths are not form data). Null if malformed. */
        internal fun percentDecode(s: String): String? {
            if ('%' !in s) return s
            val out = ByteArrayOutputStream(s.length)
            var i = 0
            while (i < s.length) {
                val c = s[i]
                if (c == '%') {
                    if (i + 2 >= s.length) return null
                    out.write(s.substring(i + 1, i + 3).toIntOrNull(16) ?: return null)
                    i += 3
                } else {
                    out.write(c.toString().toByteArray(Charsets.UTF_8))
                    i++
                }
            }
            return try {
                Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(out.toByteArray())).toString()
            } catch (_: CharacterCodingException) {
                null
            }
        }
    }
}
