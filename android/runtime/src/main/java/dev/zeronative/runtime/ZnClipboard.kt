package dev.zeronative.runtime

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context

/** The built-in Clipboard module: `@react-native-clipboard/clipboard`'s text calls (packages/core/src/clipboard.ts). */
internal object ZnClipboard : ZnModuleBase("Clipboard", version = 1) {
    private lateinit var app: Context

    /** Main process, once. */
    fun init(context: Context) {
        app = context.applicationContext
    }

    private fun clipboard(): ClipboardManager =
        app.getSystemService(ClipboardManager::class.java) ?: throw IllegalStateException("no clipboard on this phone")

    init {
        function("setString", onMain = true) { call ->
            val text = call.string("text")
            clipboard().setPrimaryClip(ClipData.newPlainText("", text))
            call.resolve()
        }

        // Android 10+ lets an app read the clipboard only while it has focus; else Android gives null, and JS gets "".
        function("getString", onMain = true) { call ->
            val clip = clipboard().primaryClip
            val text = if (clip == null || clip.itemCount == 0) "" else clip.getItemAt(0).coerceToText(app)?.toString() ?: ""
            call.resolve(text)
        }

        function("hasString", onMain = true) { call ->
            val cm = clipboard()
            call.resolve(cm.hasPrimaryClip() && cm.primaryClipDescription?.hasMimeType("text/*") == true)
        }
    }
}
