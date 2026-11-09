package dev.zeronative.runtime

import org.json.JSONObject

/** A store update answer from the zn-updates server ([ZnOtaStore]): [critical] 1 = optional, 2 = forced. */
class ZnStoreUpdate(val version: String, val critical: Int, val title: String?, val message: String?) {
    val forced: Boolean get() = critical == 2
}

/**
 * For a plugin that opens the store's own update screen (Play's in-app update, plugins/app-updates): with it, a forced
 * store update opens at launch, before the app's first screen, and not seconds later from JS. Set it with
 * [ZnOta.setStoreLauncher] in the plugin's `register`. Main thread. At each start with UI (the launch gate, [ZnOtaGate]):
 * - [onLaunch] at once, with this APK's last store answer (null: none). Ask the store now, in parallel with our check.
 *   When [saved] is forced, the launch screen stays up for the store too (at most `launchCapCriticalMs` from the tap).
 * - [onLaunchAnswer] once, with the launch check's answer: the server's, or the saved one when the check failed.
 *   It can come after the app opened (a slow check): the plugin may still open the store's screen then.
 * - The plugin calls [ZnOta.storeLaunchDone] when it opened the store's screen, or knows it won't (the store has no
 *   update, the user is paying, no forced answer): then the app opens.
 * Optional updates and returns to the app stay with the app's JS (`Updates.status().store`).
 */
interface ZnStoreLauncher {
    fun onLaunch(saved: ZnStoreUpdate?)
    fun onLaunchAnswer(answer: ZnStoreUpdate?)
}

/**
 * The store update part of the check's answer (docs/zn-updates-server.md): "should this APK update from the store, and
 * how urgent". The server decides it from the app's store rules for the phone's channel and versionCode; the phone only
 * keeps it ([ZnOta] state) and shows it to JS (`Updates.status().store`). What the app does with it (Play's in-app
 * update, its own screen) is up to the app: `plugins/app-updates`, or the app's own code.
 *
 *   { "update": null }                                                  nothing to do
 *   { "update": { "version": 175, "critical": 1, "title"?, "message"? } } 1 = optional, 2 = forced
 *   "appStoreId": "123"                                                 iOS only, when the app's store facts have it
 *
 * Not signed, like the rollout and the priority: a wrong value can't run code, only ask the user to visit the store.
 */
internal object ZnOtaStore {
    /** Longest text kept for a title or a message. */
    private const val MAX_TEXT = 300

    /** The answer as clean JSON text, or null when it can't be read (then the phone keeps the last good one). */
    fun read(raw: Any?): String? {
        val j = raw as? JSONObject ?: return null
        val out = JSONObject()
        val u = j.opt("update")
        when {
            u == null || u == JSONObject.NULL -> out.put("update", JSONObject.NULL)
            u is JSONObject -> {
                val version = u.opt("version")
                val okVersion = (version is Number && version.toDouble().let { it.isFinite() && it > 0 }) ||
                    (version is String && version.isNotBlank())
                val critical = u.opt("critical")
                if (!okVersion || (critical != 1 && critical != 2)) return null
                val update = JSONObject().put("version", version).put("critical", critical)
                u.optString("title").takeIf { it.isNotBlank() }?.let { update.put("title", it.take(MAX_TEXT)) }
                u.optString("message").takeIf { it.isNotBlank() }?.let { update.put("message", it.take(MAX_TEXT)) }
                out.put("update", update)
            }
            else -> return null
        }
        j.optString("appStoreId").takeIf { it.isNotBlank() }?.let { out.put("appStoreId", it) }
        return out.toString()
    }

    /** A kept answer (the JSON text [read] made) as a [ZnStoreUpdate]; null when it has no update or can't be read. */
    fun update(text: String?): ZnStoreUpdate? {
        val u = runCatching { JSONObject(text ?: return null).optJSONObject("update") }.getOrNull() ?: return null
        val critical = u.optInt("critical", 0)
        if (critical != 1 && critical != 2) return null
        val version = u.opt("version")?.let { if (it is Number && it.toDouble() == Math.floor(it.toDouble())) it.toLong().toString() else it.toString() }
            ?: return null
        return ZnStoreUpdate(version, critical, u.optString("title").ifEmpty { null }, u.optString("message").ifEmpty { null })
    }
}
