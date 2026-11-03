package dev.zeronative.plugins.media

import org.json.JSONArray
import org.json.JSONObject

/** Why one file can't be used. [code] reaches JS. */
internal class MediaFailure(val code: String, message: String = code) : Exception(message)

/** Pixels of a crop, on the picture after its rotation. */
internal data class Crop(val x: Int, val y: Int, val width: Int, val height: Int)

/**
 * How to turn one picture into the file we keep. [sample]: BitmapFactory's inSampleSize. [width], [height]: the final size.
 * [turn]: degrees to turn, after [flip]. [cropX], [cropY]: pixels on the turned picture, before it is made smaller.
 */
internal data class Plan(val sample: Int, val width: Int, val height: Int, val turn: Int, val flip: Boolean, val cropX: Int, val cropY: Int, val scale: Double)

/** A file in the folder, for [MediaRules.toDelete]. */
internal data class Stored(val name: String, val bytes: Long, val modified: Long)

/** The media rules, apart from Android, so they run on the JVM (MediaRulesTest). */
internal object MediaRules {
    const val DEFAULT_MAX_SIZE = 2048
    const val DEFAULT_QUALITY = 85
    const val MAX_PHOTOS = 30
    /** A picked file is outside input: a broken app can hand us a stream with no end. */
    const val MAX_BYTES = 100L * 1024 * 1024
    /** 24 MP is about 96 MB of memory. A bigger picture is read smaller, or a low-end phone runs out. */
    const val MAX_PIXELS = 24_000_000L

    /** What the folder may hold by itself, checked after each pick (see [toDelete]). */
    const val KEEP_MS = 7L * 24 * 3600 * 1000
    const val KEEP_BYTES = 256L * 1024 * 1024
    /** A half-done file this old has no job left that wants it. */
    const val PART_KEEP_MS = 3600L * 1000

    private const val PREFIX = "media-"
    private const val PART_PREFIX = ".media-"
    private val MIME = Regex("[A-Za-z0-9*][A-Za-z0-9.+-]*/[A-Za-z0-9*][A-Za-z0-9.+*-]*")
    private val EXTENSION = Regex("[a-z0-9]{1,8}")
    private val NAME_BAD = Regex("[\\u0000-\\u001f\\u007f/\\\\:]")
    private val KNOWN_TYPES = mapOf(
        "application/pdf" to "pdf", "image/jpeg" to "jpg", "image/png" to "png", "image/webp" to "webp", "image/heic" to "heic",
        "image/gif" to "gif", "text/plain" to "txt", "text/csv" to "csv", "application/zip" to "zip",
    )

    /** Starts with a dot: a handle can't name it, so JS never sees a half-done file. */
    fun partName(id: String, index: Int, step: String) = "$PART_PREFIX$id-$index.$step"
    fun captureName(id: String) = "$PART_PREFIX$id-camera.jpg"
    fun fileName(id: String, index: Int, extension: String) = "$PREFIX$id-$index.$extension"

    fun maxSize(value: Int?): Int = (value ?: DEFAULT_MAX_SIZE).also { if (it < 1) throw IllegalArgumentException("\"maxSize\" must be at least 1, got $it") }
    fun quality(value: Int?): Int = (value ?: DEFAULT_QUALITY).also { if (it !in 1..100) throw IllegalArgumentException("\"quality\" must be 1 to 100, got $it") }

    fun rotate(value: Int?): Int {
        val r = value ?: 0
        require(r % 90 == 0) { "\"rotate\" must be a multiple of 90, got $r" }
        return ((r % 360) + 360) % 360
    }

    /** Only other apps' content links. A file:// link from a bad app would make us read our own private files. */
    fun usableUri(scheme: String?, authority: String?, ownAuthority: String) = scheme == "content" && authority != null && authority != ownAuthority

    /** The links an app answered with: no repeats, and no more than asked for. */
    fun usableUris(uris: List<String>, max: Int) = uris.distinct().take(max)

    fun mimeOr(type: String?, default: String): String = type?.takeIf { it.length <= 127 && MIME.matches(it) }?.lowercase() ?: default

    fun extension(mime: String, name: String): String =
        KNOWN_TYPES[mime] ?: name.substringAfterLast('.', "").lowercase().takeIf { EXTENSION.matches(it) } ?: "bin"

    /** The type of a file we kept, when the other app can no longer say. */
    fun mimeOf(fileName: String): String {
        val extension = fileName.substringAfterLast('.', "")
        return KNOWN_TYPES.entries.firstOrNull { it.value == extension }?.key ?: "application/octet-stream"
    }

    /** The name the other app gave: only ever shown or sent, never a path on disk here. */
    fun displayName(name: String?, default: String): String = name?.replace(NAME_BAD, "_")?.trim()?.take(120)?.ifEmpty { null } ?: default

    fun withExtension(name: String, extension: String) = "${name.substringBeforeLast('.', name)}.$extension"

    /**
     * Picks the smallest read that still gives [plan.width] x [plan.height]. Null if [crop] isn't inside the picture.
     * [flip] and [exifDegrees]: the file's EXIF orientation. [rotate]: what the app asks for on top.
     */
    fun plan(width: Int, height: Int, exifDegrees: Int, flip: Boolean, rotate: Int, crop: Crop?, maxSize: Int): Plan? {
        val turn = (exifDegrees + rotate) % 360
        val sideways = turn % 180 != 0
        val shownWidth = if (sideways) height else width
        val shownHeight = if (sideways) width else height
        if (crop != null && (crop.x < 0 || crop.y < 0 || crop.width < 1 || crop.height < 1 ||
                crop.x.toLong() + crop.width > shownWidth || crop.y.toLong() + crop.height > shownHeight)) return null
        val cutWidth = crop?.width ?: shownWidth
        val cutHeight = crop?.height ?: shownHeight
        val pixels = cutWidth.toDouble() * cutHeight
        val scale = minOf(1.0, maxSize.toDouble() / maxOf(cutWidth, cutHeight), Math.sqrt(MAX_PIXELS / pixels))
        var sample = 1
        while (sample * 2 * scale <= 1.0) sample *= 2
        while (width.toLong() / sample * (height.toLong() / sample) > MAX_PIXELS) sample *= 2
        return Plan(
            sample = sample,
            width = Math.round(cutWidth * scale).toInt().coerceAtLeast(1),
            height = Math.round(cutHeight * scale).toInt().coerceAtLeast(1),
            turn = turn,
            flip = flip,
            cropX = crop?.x ?: 0,
            cropY = crop?.y ?: 0,
            scale = scale,
        )
    }

    /**
     * Which of our files to delete. Other plugins share the folder, so only names we made count. [keep]: never these, like
     * the job in progress. First what is older than [maxAgeMs], then the oldest until the rest fit in [maxBytes].
     */
    fun toDelete(files: List<Stored>, now: Long, maxAgeMs: Long, maxBytes: Long, keep: (String) -> Boolean): List<String> {
        val ours = files.filter { !keep(it.name) && (it.name.startsWith(PREFIX) || it.name.startsWith(PART_PREFIX)) }
        val (parts, finals) = ours.partition { it.name.startsWith(PART_PREFIX) }
        val out = parts.filter { now - it.modified >= minOf(PART_KEEP_MS, maxAgeMs) }.map { it.name }.toMutableList()
        val (old, young) = finals.partition { now - it.modified >= maxAgeMs }
        out += old.map { it.name }
        var total = young.sumOf { it.bytes }
        for (file in young.sortedBy { it.modified }) {
            if (total <= maxBytes) break
            out += file.name
            total -= file.bytes
        }
        return out
    }

    /** Android asks a camera-using app to hold the permission even for the camera app, if the manifest lists it (see takePhoto). */
    fun cameraPermissionMissing(declared: Boolean, granted: Boolean) = declared && !granted
}

/**
 * One launch, on disk from before the other app opens until JS forgets it. The picture sizes and file names must outlive a
 * kill, and JS is never trusted to bring back a link or a path. Only the newest job exists.
 */
internal data class MediaJob(
    val id: String,
    val kind: String,
    val maxSize: Int = MediaRules.DEFAULT_MAX_SIZE,
    val quality: Int = MediaRules.DEFAULT_QUALITY,
    val max: Int = 1,
    val maxBytes: Long = MediaRules.MAX_BYTES,
    /** The file the camera app writes. */
    val capture: String? = null,
    /** Android's answer, once it came. */
    val resultCode: Int? = null,
    val uris: List<String> = emptyList(),
) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("kind", kind).put("maxSize", maxSize).put("quality", quality)
        .put("max", max).put("maxBytes", maxBytes).put("capture", capture ?: JSONObject.NULL)
        .put("resultCode", resultCode ?: JSONObject.NULL).put("uris", JSONArray(uris))

    companion object {
        const val PHOTOS = "photos"
        const val FILE = "file"
        const val CAMERA = "camera"

        fun fromJson(text: String): MediaJob? = try {
            val o = JSONObject(text)
            val list = o.getJSONArray("uris")
            MediaJob(
                id = o.getString("id"),
                kind = o.getString("kind"),
                maxSize = o.getInt("maxSize"),
                quality = o.getInt("quality"),
                max = o.getInt("max"),
                maxBytes = o.getLong("maxBytes"),
                capture = if (o.isNull("capture")) null else o.getString("capture"),
                resultCode = if (o.isNull("resultCode")) null else o.getInt("resultCode"),
                uris = (0 until list.length()).map { list.getString(it) },
            )
        } catch (_: org.json.JSONException) {
            null // written by an app version we can't read: the same as no job, and JS hears "lost"
        }
    }
}
