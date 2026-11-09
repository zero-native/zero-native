package dev.zeronative.runtime

import android.util.Log
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import java.io.File
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

/**
 * The app's fonts for one bundle (registry 24, guide notes §84): RN's `fontFamily`. The build reads the files in
 * `<app>/assets/fonts/` and writes a table into the manifest (compiler/src/fonts.ts): family name → faces (file,
 * weight, italic). A family here becomes one Compose [FontFamily] with all its faces, so Compose picks the face for
 * each text's fontWeight / fontStyle (the closest weight, as CSS), also inside spans.
 *
 * Font files are bundle files like `asset:` images: a downloaded bundle's own copy when it has one, else the APK's.
 * One table per loaded bundle (not global), so an update applied while the app runs, or a rollback, never mixes two
 * bundles' fonts.
 *
 * Never crashes on a bad font (OTA-safe): an unknown name, a missing file or a file that isn't a font draws the
 * system font, with one warning in the log per name. A file is checked (it opens, and starts like a font) the first
 * time its family is used; Compose loads it then, on the main thread (a few ms per face, once per process).
 */
class ZnFontTable internal constructor(json: JSONObject?, private val bundle: ZnBundles.Running?) {
    private class Face(val file: String, val weight: Int, val italic: Boolean)

    private val faces: Map<String, List<Face>> = json?.let(::parse) ?: emptyMap()
    /** Resolved families. A name that resolves to the system font maps to [SYSTEM] (null can't be stored here). */
    private val cache = ConcurrentHashMap<String, FontFamily>()

    /** The Compose family for [name], or null for the system font (also for a name the app has no font for). */
    fun family(name: String?): FontFamily? {
        if (name.isNullOrEmpty()) return null
        val f = cache.getOrPut(name) { resolve(name) ?: SYSTEM }
        return if (f === SYSTEM) null else f
    }

    private fun resolve(name: String): FontFamily? {
        val list = faces[name]
        if (list != null) {
            val fonts = list.mapNotNull { face -> font(face) }
            if (fonts.isNotEmpty()) return FontFamily(fonts)
            Log.w(TAG, "font: none of the files of \"$name\" can be read; drawing the system font")
            return null
        }
        return when (name) {
            "System", "sans-serif", "Roboto" -> null
            "serif" -> FontFamily.Serif
            "monospace" -> FontFamily.Monospace
            else -> if (name.startsWith("sans-serif-")) {
                // Android's system faces under their names (sans-serif-medium, -light, -condensed, ...), as RN Android.
                FontFamily(androidx.compose.ui.text.font.Typeface(android.graphics.Typeface.create(name, android.graphics.Typeface.NORMAL)))
            } else {
                Log.w(TAG, "font: this bundle has no font \"$name\"; drawing the system font")
                null
            }
        }
    }

    /** A face as a Compose [Font], or null (logged) when its file is missing or isn't a font. */
    private fun font(face: Face): Font? {
        val weight = FontWeight(face.weight.coerceIn(1, 1000))
        val style = if (face.italic) FontStyle.Italic else FontStyle.Normal
        val r = bundle
        val file = if (r?.dir != null && r.info?.files?.containsKey(face.file) == true) File(r.dir, face.file) else null
        return try {
            if (file != null) {
                if (!looksLikeFont(file.inputStream())) return bad(face, "isn't a font")
                Font(file, weight, style)
            } else {
                val assets = ZnBundles.apkAssets()
                if (!looksLikeFont(assets.open(face.file))) return bad(face, "isn't a font")
                Font(face.file, assets, weight, style)
            }
        } catch (e: Exception) { // a missing or unreadable file, never a crash (OTA-safe)
            bad(face, "can't be read (${e.message})")
        }
    }

    private fun bad(face: Face, why: String): Font? {
        Log.w(TAG, "font: ${face.file} $why; left out")
        return null
    }

    companion object {
        private const val TAG = "zn"
        /** Marks a name that resolves to the system font in the cache. */
        private val SYSTEM: FontFamily = FontFamily.Default
        /** No app fonts (tests, a bundle built before registry 24). */
        val EMPTY = ZnFontTable(null, null)

        /** The manifest's "fonts": { family: [{ file, weight, italic }] }. A malformed entry is skipped. */
        private fun parse(manifest: JSONObject): Map<String, List<Face>>? {
            val fonts = manifest.optJSONObject("fonts") ?: return null
            val out = HashMap<String, List<Face>>()
            for (name in fonts.keys()) {
                val list = fonts.optJSONArray(name) ?: continue
                out[name] = (0 until list.length()).mapNotNull { i ->
                    val o = list.optJSONObject(i) ?: return@mapNotNull null
                    val file = o.optString("file").ifEmpty { null } ?: return@mapNotNull null
                    Face(file, o.optInt("weight", 400), o.optBoolean("italic", false))
                }
            }
            return out
        }

        /** The first 4 bytes are a TrueType / OpenType tag (00 01 00 00, "OTTO" or "true"). Closes [input]. */
        internal fun looksLikeFont(input: InputStream): Boolean = input.use {
            val b = ByteArray(4)
            var n = 0
            while (n < 4) {
                val got = it.read(b, n, 4 - n)
                if (got < 0) return@use false
                n += got
            }
            val tag = String(b, Charsets.ISO_8859_1)
            tag == "\u0000\u0001\u0000\u0000" || tag == "OTTO" || tag == "true"
        }
    }
}
