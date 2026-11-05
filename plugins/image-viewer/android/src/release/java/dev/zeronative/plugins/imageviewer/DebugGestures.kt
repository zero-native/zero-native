package dev.zeronative.plugins.imageviewer

import android.content.Context

/** Release builds: nothing. The debug one takes two-finger gestures from adb (src/debug). */
internal object DebugGestures {
    @Suppress("UNUSED_PARAMETER")
    fun install(context: Context) = Unit
}
