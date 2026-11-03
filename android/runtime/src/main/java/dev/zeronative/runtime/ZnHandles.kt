package dev.zeronative.runtime

import android.content.Context
import android.graphics.drawable.Drawable
import coil3.asImage
import coil3.decode.DataSource
import coil3.fetch.Fetcher
import coil3.fetch.ImageFetchResult
import coil3.request.ImageRequest
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * `zn://` handles (ARCHITECTURE §15.4): native images reach JS as a short string, never as pixels. `<Image src>` takes
 * one, like `zn://app-icon/com.phonepe.app`. Each kind has a [Loader]. It runs on Coil's background threads, never the
 * main thread: an app icon is a slow Binder call. The handle table was first built in the exp4 prototype.
 */
object ZnHandles {
    private const val FILE = "file"
    private const val FILE_DIR = "zn-files"
    private val NAME = Regex("[A-Za-z0-9_-][A-Za-z0-9._-]*")

    /** Off the main thread. Null or an exception: a normal image error, and `<Image fallback>` shows. */
    fun interface Loader {
        fun load(context: Context, path: String): Drawable?
    }

    private val kinds = ConcurrentHashMap<String, Loader>().apply {
        put("app-icon") { context, pkg -> context.packageManager.getApplicationIcon(pkg) }
    }

    /** Adds a kind of handle: `zn://<name>/<path>`. */
    fun kind(name: String, loader: Loader) {
        kinds[name] = loader
    }

    /** Where a plugin writes files that JS will name, like a picked photo. It stays after a kill; Android may clear it when short of space. */
    fun fileDir(context: Context): File = File(context.cacheDir, FILE_DIR).apply { mkdirs() }

    /**
     * `zn://file/<name>` for a file in [fileDir]. Only those files get a handle, so a bundle can't read a path of its choice.
     * Throws for any other file: a mistake in the plugin.
     */
    fun file(context: Context, file: File): String {
        require(file.canonicalFile.parentFile == fileDir(context).canonicalFile && fileName(file.name) != null) {
            "${file.name} must be a plain file name inside ZnHandles.fileDir"
        }
        return "zn://file/${file.name}"
    }

    /** The file of a `zn://file/<name>` handle, or null if that isn't one. For a plugin that gets a handle back from JS. */
    fun fileOf(context: Context, uri: String): File? {
        val (kind, path) = parse(uri) ?: return null
        if (kind != FILE) return null
        return fileName(path)?.let { File(fileDir(context), it) }?.takeIf { it.isFile }
    }

    /** [name] if it can only mean a file directly in [fileDir]: no folders, no "..". JS writes this text, so it's outside input. */
    internal fun fileName(name: String): String? = name.takeIf { NAME.matches(it) }

    /** A data class: Compose compares requests, and an equal one must not load again. */
    private data class Handle(val uri: String)

    private val factory = Fetcher.Factory<Handle> { data, options, _ ->
        Fetcher {
            val (kind, path) = parse(data.uri) ?: error("not a zn:// handle: ${data.uri}")
            val loader = kinds[kind] ?: error("no handle kind \"$kind\"")
            val drawable = loader.load(options.context, path) ?: error("nothing for ${data.uri}")
            ImageFetchResult(drawable.asImage(), isSampled = false, DataSource.DISK)
        }
    }

    /** `zn://kind/path` → (kind, path), or null. */
    internal fun parse(uri: String): Pair<String, String>? {
        if (!uri.startsWith("zn://")) return null
        val rest = uri.removePrefix("zn://")
        val kind = rest.substringBefore('/', "")
        val path = rest.substringAfter('/', "")
        return if (kind.isEmpty() || path.isEmpty()) null else kind to path
    }

    /**
     * What the renderer gives Coil for a handle. Kept in Coil's memory cache under the handle's own text. A file goes through
     * Coil's normal path: it decodes a big photo at the size on screen, which a [Loader] can't do.
     */
    internal fun request(context: Context, uri: String): ImageRequest {
        val file = fileOf(context, uri)
        if (file != null) return ImageRequest.Builder(context).data(file).build()
        return ImageRequest.Builder(context).data(Handle(uri)).fetcherFactory(factory).memoryCacheKey(uri).build()
    }
}
