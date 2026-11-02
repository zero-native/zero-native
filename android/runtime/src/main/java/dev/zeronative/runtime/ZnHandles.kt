package dev.zeronative.runtime

import android.content.Context
import android.graphics.drawable.Drawable
import coil3.asImage
import coil3.decode.DataSource
import coil3.fetch.Fetcher
import coil3.fetch.ImageFetchResult
import coil3.request.ImageRequest
import java.util.concurrent.ConcurrentHashMap

/**
 * `zn://` handles (ARCHITECTURE §15.4): native images reach JS as a short string, never as pixels. `<Image src>` takes
 * one, like `zn://app-icon/com.phonepe.app`. Each kind has a [Loader]. It runs on Coil's background threads, never the
 * main thread: an app icon is a slow Binder call. The handle table was first built in the exp4 prototype.
 */
object ZnHandles {
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

    /** What the renderer gives Coil for a handle. Kept in Coil's memory cache under the handle's own text. */
    internal fun request(context: Context, uri: String): ImageRequest =
        ImageRequest.Builder(context).data(Handle(uri)).fetcherFactory(factory).memoryCacheKey(uri).build()
}
