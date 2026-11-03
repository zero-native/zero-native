package dev.zeronative.plugins.pdf

import android.app.ActivityManager
import android.content.Context
import dev.zeronative.runtime.ZnActivityEvents
import org.json.JSONObject

/** What the views on screen can be asked to do. Main thread. */
internal interface PdfLive {
    /** Debug builds: zoom to [scale] around the middle. */
    fun zoom(scale: Float): Boolean

    /** Drop every bitmap: they are drawn again when needed. */
    fun trim()
}

/** The PDF views on screen, by view id. Main thread. */
internal class PdfViews(private val context: Context) : ZnActivityEvents {
    private val live = HashMap<String, PdfLive>()

    /** Bytes of bitmaps one view may hold (PdfRules.budget). */
    val budget: Long by lazy {
        val am = context.getSystemService(ActivityManager::class.java)
        PdfRules.budget(am?.memoryClass ?: 128, am?.isLowRamDevice ?: true)
    }

    fun add(id: String, view: PdfLive) {
        live[id] = view
    }

    fun remove(id: String, view: PdfLive) {
        if (live[id] === view) live.remove(id)
    }

    fun zoom(id: String, scale: Float): Boolean = live[id]?.zoom(scale) ?: false

    override fun onLowMemory() {
        for (v in live.values) v.trim()
    }
}

internal fun errorJson(reason: String, page: Int? = null): JSONObject =
    JSONObject().put("reason", reason).apply { if (page != null) put("page", page + 1) }

internal fun loadJson(view: String, pages: List<PageSize>): JSONObject =
    JSONObject().put("view", view).put("pages", pages.size).put("width", pages[0].width.toDouble()).put("height", pages[0].height.toDouble())

/** A colour from props ("#RRGGBB" and the like), or [default]. */
internal fun JSONObject.color(name: String, default: Int): Int =
    if (isNull(name)) default else try {
        android.graphics.Color.parseColor(optString(name))
    } catch (e: IllegalArgumentException) {
        default
    }
