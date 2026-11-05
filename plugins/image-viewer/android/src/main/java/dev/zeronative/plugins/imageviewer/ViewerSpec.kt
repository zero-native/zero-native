package dev.zeronative.plugins.imageviewer

import org.json.JSONObject

/**
 * One picture: its link, what TalkBack reads (null: "Photo n of count"), and what JS gave natively for it ([Held]: its
 * `data:` bytes or request headers; null after Android killed the app, or when there was none).
 */
internal data class ViewerImage(val uri: String, val alt: String?, val held: Held? = null)

/**
 * The route's params (index.ts `viewerParams`). JS checks them first; this reads them again without trusting them,
 * because a bundle comes over the air: no pictures gives an empty list (the screen closes), a bad index is kept inside
 * the list, a colour that can't be read gives black.
 */
internal class ViewerSpec(from: JSONObject) {
    /** The key of this viewer's held parts (ViewerHeld), if JS gave any. */
    val heldKey: String? = from.text("held")
    val images: List<ViewerImage> = buildList {
        val list = from.optJSONArray("images") ?: return@buildList
        for (i in 0 until minOf(list.length(), MAX_IMAGES)) {
            val item = list.optJSONObject(i) ?: continue
            val uri = item.optString("uri", "")
            if (uri.isEmpty()) continue
            add(ViewerImage(uri, item.text("alt"), ViewerHeld.get(heldKey, i)))
        }
    }
    val index: Int = from.optInt("index", 0).coerceIn(0, maxOf(0, images.size - 1))
    val swipeToClose: Boolean = from.optBoolean("swipeToClose", true)
    val doubleTap: Boolean = from.optBoolean("doubleTap", true)
    /** ARGB. */
    val background: Int = from.color("backgroundColor", BLACK)
    val close: String = from.text("closeLabel") ?: "Close"
    val error: String = from.text("errorText") ?: "Couldn't load this photo"
    val retry: String = from.text("retryLabel") ?: "Try again"
    val photo: String = from.text("photoLabel") ?: "Photo {n} of {count}"
    val next: String = from.text("nextLabel") ?: "Next photo"
    val previous: String = from.text("previousLabel") ?: "Previous photo"

    companion object {
        /** More is a bug in the app; the params are saved with the back stack, so keep them small. */
        const val MAX_IMAGES = 500
        const val BLACK = 0xFF000000.toInt()
    }
}

private fun JSONObject.text(name: String): String? = if (isNull(name)) null else optString(name).takeIf { it.isNotEmpty() }

/** "#RRGGBB" or "#AARRGGBB", else [default]. Parsed here, not with android.graphics.Color, so the JVM tests can run it. */
private fun JSONObject.color(name: String, default: Int): Int {
    val text = text(name) ?: return default
    if (!text.startsWith("#")) return default
    val hex = text.substring(1)
    val value = hex.toLongOrNull(16) ?: return default
    return when (hex.length) {
        6 -> (0xFF000000 or value).toInt()
        8 -> value.toInt()
        else -> default
    }
}
