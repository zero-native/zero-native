package dev.zeronative.runtime

import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.clearText
import androidx.compose.ui.focus.FocusManager
import androidx.compose.ui.focus.FocusRequester

/**
 * The built-in `Keyboard` module (JS: `Keyboard.dismiss()` and a `<TextField ref>`'s focus / blur / clear, from
 * `@zero-native/core`). Registered by [ZnRuntime.start]. [ZnNavHost] gives it the window's focus manager: clearing
 * focus closes the keyboard and blurs the field. v2: fields with a `ref` (RN basics pack).
 */
internal object ZnKeyboard : ZnModuleBase("Keyboard", version = 2) {
    /** Main thread only. */
    var focusManager: FocusManager? = null

    /** A `<TextField ref>` on screen. [focused] follows its focus. */
    class Field(val focus: FocusRequester, val state: TextFieldState) {
        var focused = false
    }

    /** By (instance, ref event id), while the field is composed. Main thread only. */
    private val fields = HashMap<Long, Field>()

    private fun key(inst: Int, id: Int) = (inst.toLong() shl 32) or (id.toLong() and 0xFFFFFFFFL)

    fun attach(inst: Int, id: Int, field: Field) {
        fields[key(inst, id)] = field
    }

    fun detach(inst: Int, id: Int, field: Field) {
        if (fields[key(inst, id)] === field) fields.remove(key(inst, id))
    }

    /** The field a call names, or null after the call was rejected (it is not on screen: closed, or scrolled away). */
    private fun field(call: ZnCall): Field? {
        // JS sends ids as unsigned numbers; Kotlin keeps the same 32 bits in an Int.
        val f = fields[key(call.long("inst").toInt(), call.long("id").toInt())]
        if (f == null) call.reject("not_shown", "this TextField is not on screen")
        return f
    }

    init {
        function("dismiss", onMain = true) { call ->
            focusManager?.clearFocus(force = true)
            call.resolve()
        }

        function("focus", onMain = true) { call ->
            val f = field(call) ?: return@function
            // Throws if the field's node is not attached yet (built but not laid out): then it is not on screen.
            runCatching { f.focus.requestFocus() }
                .onSuccess { call.resolve(true) }
                .onFailure { call.reject("not_shown", "this TextField is not on screen yet") }
        }

        function("blur", onMain = true) { call ->
            val f = field(call) ?: return@function
            // Only this field's focus: blur() on a field that doesn't have it changes nothing, as in React Native.
            if (f.focused) focusManager?.clearFocus(force = true)
            call.resolve(f.focused)
        }

        function("clear", onMain = true) { call ->
            val f = field(call) ?: return@function
            // As if the user deleted the text: the field sends onChangeText(""), so a controlled value follows.
            f.state.clearText()
            call.resolve(true)
        }
    }
}
