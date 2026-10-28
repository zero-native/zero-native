package dev.zeronative.exp4

import android.graphics.drawable.Drawable
import java.util.concurrent.ConcurrentHashMap

/**
 * Native Resource Registry (ARCHITECTURE / Argon Solution §2)
 * Holds references to heavy Android native visual objects (Drawables, Bitmaps, Camera captures)
 * allowing Hermes JavaScript to manipulate them via lightweight opaque URIs (e.g. "zn://app-icon/com.phonepe.app")
 * with ZERO pixel bytes copying into the JS heap.
 */
object ZnResourceRegistry {
    private val drawables = ConcurrentHashMap<String, Drawable>()

    fun register(uri: String, drawable: Drawable) {
        drawables[uri] = drawable
    }

    fun get(uri: String): Drawable? {
        return drawables[uri]
    }

    fun remove(uri: String): Drawable? {
        return drawables.remove(uri)
    }

    fun clear() {
        drawables.clear()
    }
}

