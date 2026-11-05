package dev.zeronative.plugins.imageviewer

import dev.zeronative.runtime.ZnActivityEvents
import dev.zeronative.runtime.ZnModuleBase
import dev.zeronative.runtime.ZnPlugin
import dev.zeronative.runtime.ZnPluginRegistry
import java.util.concurrent.CopyOnWriteArraySet

class ImageViewerPlugin : ZnPlugin {
    override fun register(r: ZnPluginRegistry) {
        r.module(ImageViewerModule())
        r.screen("imageviewer.full") { scope -> ImageViewerScreen(scope) }
        r.activityEvents(ViewerMemory)
        DebugGestures.install(r.context) // debug builds only: two-finger gestures from adb (src/debug)
    }
}

/**
 * The module "ImageViewer". It puts the plugin in a bundle's needs, so an app without the plugin never runs a bundle that
 * opens the viewer (docs/plugins.md D3). The screen "imageviewer.full" belongs to it.
 * Version 2 (2026-11-05): `hold`, for `data:` pictures and request headers (ViewerHeld).
 */
internal class ImageViewerModule : ZnModuleBase("ImageViewer", version = 2) {
    init {
        // Not on the main thread: it decodes base64 (up to 5 MB).
        function("hold") { call ->
            val key = call.args.optString("key", "")
            val items = call.args.optJSONArray("items")
            if (key.isEmpty() || items == null) return@function call.reject("invalid_args", "hold needs key and items")
            ViewerHeld.hold(key, items)
            call.resolve(true)
        }
    }
}

/** The pages on screen drop their sharp parts when Android is short of memory. Coil clears its own cache. */
internal object ViewerMemory : ZnActivityEvents {
    private val trims = CopyOnWriteArraySet<() -> Unit>()

    fun add(trim: () -> Unit) {
        trims += trim
    }

    fun remove(trim: () -> Unit) {
        trims -= trim
    }

    override fun onLowMemory() {
        for (t in trims) t()
    }
}
