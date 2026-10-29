package dev.zeronative.runtime

import androidx.compose.ui.focus.FocusManager

/**
 * The built-in `Keyboard` module (JS: `Keyboard.dismiss()` from `@zero-native/core`). Registered by [ZnRuntime.start].
 * [ZnNavHost] gives it the window's focus manager: clearing focus closes the keyboard and blurs the field.
 */
internal object ZnKeyboard : ZnModuleBase("Keyboard", version = 1) {
    /** Main thread only. */
    var focusManager: FocusManager? = null

    init {
        function("dismiss", onMain = true) { call ->
            focusManager?.clearFocus(force = true)
            call.resolve()
        }
    }
}
