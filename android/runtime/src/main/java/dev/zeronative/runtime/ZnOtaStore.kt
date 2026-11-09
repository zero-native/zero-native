package dev.zeronative.runtime

import org.json.JSONObject

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
}
