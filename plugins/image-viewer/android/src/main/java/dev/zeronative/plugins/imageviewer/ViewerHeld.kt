package dev.zeronative.plugins.imageviewer

import android.util.Base64
import android.util.Log
import org.json.JSONObject

/** What JS gave natively for one picture: its decoded `data:` bytes, or its request headers. */
internal class Held(val bytes: ByteArray?, val headers: Map<String, String>?)

/**
 * The parts of a viewer's pictures that must not go in the route's params: `data:` pictures (big) and request headers
 * (a login token). Params are saved in Android's saved state: it has a size limit, and it is kept outside the app. These
 * stay in memory only, so after Android kills the app they are gone and those pictures show their error.
 *
 * By key, the newest [MAX_KEYS] viewers, with at most [ViewerRules.MAX_HELD_BYTES] of pictures in all. A viewer the user
 * closes lets go of its key at once; one closed from JS (`nav.back()`) stays until newer ones push it out. Any thread.
 */
internal object ViewerHeld {
    private const val MAX_KEYS = 8
    private val byKey = object : LinkedHashMap<String, Map<Int, Held>>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Map<Int, Held>>?) = size > MAX_KEYS
    }

    @Synchronized
    fun get(key: String?, index: Int): Held? = if (key == null) null else byKey[key]?.get(index)

    @Synchronized
    fun release(key: String) {
        byKey.remove(key)
    }

    /**
     * Keeps [items] (`[{ i, data?, headers? }]`) under [key]. A `data:` link that isn't a base64 picture, or is bigger
     * than [ViewerRules.MAX_DATA_BYTES], or would take this viewer over [ViewerRules.MAX_HELD_BYTES], keeps no bytes,
     * so its picture shows the error. Header values are never logged.
     */
    fun hold(key: String, items: org.json.JSONArray) {
        val out = HashMap<Int, Held>()
        var total = 0L
        for (n in 0 until items.length()) {
            val item = items.optJSONObject(n) ?: continue
            val i = item.optInt("i", -1).takeIf { it >= 0 } ?: continue
            var bytes = item.optString("data", "").takeIf { it.isNotEmpty() }?.let { decode(it, i) }
            if (bytes != null && total + bytes.size > ViewerRules.MAX_HELD_BYTES) {
                Log.w("zn", "image-viewer: images[$i] data: link dropped, the viewer's data: pictures are over ${ViewerRules.MAX_HELD_BYTES / 1048576} MB")
                bytes = null
            }
            total += bytes?.size ?: 0
            out[i] = Held(bytes, headers(item.optJSONObject("headers"), i))
        }
        synchronized(this) {
            byKey[key] = out
            // Oldest viewers first, never the new one.
            val it = byKey.entries.iterator()
            while (sizeOf(byKey.values) > ViewerRules.MAX_HELD_BYTES && it.hasNext()) {
                val e = it.next()
                if (e.key != key) it.remove()
            }
        }
    }

    private fun sizeOf(all: Collection<Map<Int, Held>>): Long = all.sumOf { m -> m.values.sumOf { (it.bytes?.size ?: 0).toLong() } }

    private fun decode(uri: String, i: Int): ByteArray? {
        val start = ViewerRules.dataStart(uri)
        if (start == null) {
            Log.w("zn", "image-viewer: images[$i] data: link refused (not a base64 picture, or over ${ViewerRules.MAX_DATA_BYTES / 1048576} MB)")
            return null
        }
        return try {
            Base64.decode(uri.substring(start), Base64.DEFAULT).takeIf { it.isNotEmpty() && it.size <= ViewerRules.MAX_DATA_BYTES }
                ?: run { Log.w("zn", "image-viewer: images[$i] data: link is empty or too big"); null }
        } catch (e: IllegalArgumentException) {
            Log.w("zn", "image-viewer: images[$i] data: link is not valid base64")
            null
        }
    }

    private fun headers(from: JSONObject?, i: Int): Map<String, String>? {
        if (from == null) return null
        val out = LinkedHashMap<String, String>()
        for (name in from.keys()) {
            val value = from.opt(name) as? String ?: continue
            if (ViewerRules.safeHeader(name, value)) out[name] = value
            else Log.w("zn", "image-viewer: images[$i] header \"${name.take(40)}\" dropped (bad name or line break in value)")
        }
        return out.takeIf { it.isNotEmpty() }
    }
}
