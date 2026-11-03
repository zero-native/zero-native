package dev.zeronative.runtime

import android.os.Handler
import android.os.Looper
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.text.BasicSecureTextField
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.KeyboardActionHandler
import androidx.compose.foundation.text.input.TextFieldDecorator
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.maxLength
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import kotlinx.coroutines.flow.drop

/**
 * Keeps a controlled field and JS in step (ARCHITECTURE §9.4), as React Native does. The field owns the text while the
 * user types, so typing never waits for JS. Each change the user makes gets a number and goes to JS as "n\u0001text";
 * JS answers "n\u0001value" (packages/core view.ts `textInput`):
 * - an answer to an older change is ignored: the user has typed on since, and the newer change gets its own answer;
 * - an answer to the newest change, or a plain value (JS changed it on its own, e.g. a Clear button), is shown if it
 *   differs from the field (cursor at the end).
 */
private class ZnTextSync(private val state: TextFieldState) {
    /** Number of the newest change sent to JS. */
    var count = 0
        private set
    /** The last text JS put in the field: its own change event is not sent back to JS. */
    private var fromJs: String? = null
    /** The text of change [count]. */
    private var lastSent: String? = null

    /** The field's text changed. Returns true if it is the user's change and should be sent to JS (as [count]). */
    fun changed(text: String): Boolean {
        if (text == fromJs) {
            fromJs = null
            return false
        }
        fromJs = null
        count++
        lastSent = text
        return true
    }

    /** JS sent a value: "n\u0001value" (an answer to change n) or a plain value. */
    fun fromJs(raw: String) {
        val sep = raw.indexOf('\u0001')
        val n = if (sep > 0) raw.substring(0, sep).toIntOrNull() else null
        // Stale: a newer change was sent, or the user typed again and that change isn't numbered yet.
        if (n != null && (n < count || state.text.toString() != lastSent)) return
        val value = if (n != null) raw.substring(sep + 1) else raw
        if (value == state.text.toString()) return
        fromJs = value
        state.setTextAndPlaceCursorAtEnd(value)
    }
}

private val main = Handler(Looper.getMainLooper())

/** `<TextField>`: a native text field (Compose `BasicTextField`). Its look comes from the node's style props. */
@Composable
internal fun ZnTextField(s: ZnNodeSpec, inst: ZnInstance, n: Int, mod: Modifier) {
    val state = remember(inst.id, n) {
        TextFieldState(if (s.valueSlot >= 0) withoutCount(text(inst.slot(s.valueSlot).value)) else s.value.orEmpty())
    }
    val sync = remember(state) { ZnTextSync(state) }

    // JS → field. Every PATCH, even a repeated value (JS answers every change, also by resending the old value to
    // undo typing it rejected). Applied after the batch, outside its snapshot.
    if (s.valueSlot >= 0) {
        DisposableEffect(inst.id, n) {
            inst.patchWatchers[s.valueSlot] = { v -> main.post { sync.fromJs(text(v)) } }
            onDispose { inst.patchWatchers.remove(s.valueSlot) }
        }
    }
    // Field → JS.
    LaunchedEffect(state) {
        snapshotFlow { state.text.toString() }.drop(1).collect { t ->
            if (!sync.changed(t) || s.onChangeText == 0) return@collect
            // Controlled (a value slot): numbered, so JS's answer can be matched to it.
            ZnRuntime.dispatchEvent(inst.id, s.onChangeText, if (s.valueSlot >= 0) "${sync.count}\u0001$t" else t)
        }
    }

    val focus = remember { FocusRequester() }
    if (s.autoFocus) LaunchedEffect(inst.id, n) { focus.requestFocus() }
    // `ref`: JS's focus() / blur() / clear() find the field through ZnKeyboard while it is composed.
    val refField = if (s.ref != 0) remember(state) { ZnKeyboard.Field(focus, state) } else null
    if (refField != null) {
        DisposableEffect(inst.id, s.ref, refField) {
            ZnKeyboard.attach(inst.id, s.ref, refField)
            onDispose { ZnKeyboard.detach(inst.id, s.ref, refField) }
        }
    }
    // Compose calls onFocusChanged once when the field appears (not focused), and again after the Activity is made
    // again: only a real change is sent, so onBlur doesn't fire for a field nobody touched (as in React Native).
    val wasFocused = remember(inst.id, n) { booleanArrayOf(false) }
    val focusMod = mod.focusRequester(focus).onFocusChanged {
        if (it.isFocused == wasFocused[0]) return@onFocusChanged
        wasFocused[0] = it.isFocused
        if (refField != null) {
            refField.focused = it.isFocused
            ZnRuntime.dispatchEvent(inst.id, s.ref, it.isFocused)
        }
        val id = if (it.isFocused) s.onFocus else s.onBlur
        if (id != 0) ZnRuntime.dispatchEvent(inst.id, id)
    }

    val color = if (s.colorSlot >= 0) (toColorOrNull(inst.slot(s.colorSlot).value) ?: Color.Black) else (s.color ?: Color.Black)
    val fontScale = androidx.compose.ui.platform.LocalDensity.current.fontScale
    val style = s.effectiveTextStyle(fontScale).copy(color = color)
    val editable = if (s.editableSlot >= 0) inst.slot(s.editableSlot).value != false else s.editable
    val placeholder = if (s.placeholderSlot >= 0) text(inst.slot(s.placeholderSlot).value) else s.placeholder.orEmpty()
    val options = KeyboardOptions(
        capitalization = when (s.autoCapitalize) {
            Registry.AutoCapitalize.NONE -> KeyboardCapitalization.None
            Registry.AutoCapitalize.WORDS -> KeyboardCapitalization.Words
            Registry.AutoCapitalize.CHARACTERS -> KeyboardCapitalization.Characters
            else -> if (s.secure || s.keyboardType > 0) KeyboardCapitalization.None else KeyboardCapitalization.Sentences
        },
        autoCorrectEnabled = s.autoCorrect && !s.secure,
        keyboardType = when (s.keyboardType) {
            Registry.KeyboardType.NUMBER_PAD -> KeyboardType.NumberPassword // digits only, as in React Native
            Registry.KeyboardType.DECIMAL_PAD -> KeyboardType.Decimal
            Registry.KeyboardType.PHONE_PAD -> KeyboardType.Phone
            Registry.KeyboardType.EMAIL_ADDRESS -> KeyboardType.Email
            Registry.KeyboardType.URL -> KeyboardType.Uri
            else -> if (s.secure) KeyboardType.Password else KeyboardType.Text
        },
        imeAction = when (s.returnKeyType) {
            Registry.ReturnKeyType.GO -> ImeAction.Go
            Registry.ReturnKeyType.NEXT -> ImeAction.Next
            Registry.ReturnKeyType.SEARCH -> ImeAction.Search
            Registry.ReturnKeyType.SEND -> ImeAction.Send
            Registry.ReturnKeyType.DONE -> ImeAction.Done
            else -> if (s.multiline) ImeAction.Default else ImeAction.Done
        },
    )
    // The action key: tell JS, then do the default (Done hides the keyboard, Next moves to the next field).
    val onAction = KeyboardActionHandler { performDefault ->
        if (s.onSubmitEditing != 0) ZnRuntime.dispatchEvent(inst.id, s.onSubmitEditing, state.text.toString())
        performDefault()
    }
    val decorator = TextFieldDecorator { inner ->
        Box {
            if (state.text.isEmpty() && placeholder.isNotEmpty()) {
                BasicText(placeholder, style = style.copy(color = s.placeholderColor), maxLines = if (s.multiline) Int.MAX_VALUE else 1)
            }
            inner()
        }
    }
    val cursor = SolidColor(s.selectionColor ?: color)
    val limit = s.maxLength?.let { InputTransformation.maxLength(it) }
    val selection = s.selectionColor?.let { TextSelectionColors(handleColor = it, backgroundColor = it.copy(alpha = 0.3f)) }

    CompositionLocalProvider(LocalTextSelectionColors provides (selection ?: LocalTextSelectionColors.current)) {
        if (s.secure) {
            BasicSecureTextField(
                state = state,
                modifier = focusMod,
                readOnly = !editable,
                inputTransformation = limit,
                textStyle = style,
                keyboardOptions = options,
                onKeyboardAction = onAction,
                cursorBrush = cursor,
                decorator = decorator,
            )
        } else {
            BasicTextField(
                state = state,
                modifier = focusMod,
                readOnly = !editable,
                inputTransformation = limit,
                textStyle = style,
                keyboardOptions = options,
                onKeyboardAction = onAction,
                lineLimits = if (s.multiline) TextFieldLineLimits.MultiLine() else TextFieldLineLimits.SingleLine,
                cursorBrush = cursor,
                decorator = decorator,
            )
        }
    }
}

/** A value slot may hold JS's last answer, "n\u0001value". */
private fun withoutCount(v: String): String {
    val sep = v.indexOf('\u0001')
    return if (sep > 0 && v.substring(0, sep).toIntOrNull() != null) v.substring(sep + 1) else v
}

private fun text(v: Any?): String = when (v) {
    null -> ""
    is String -> v
    is Double -> if (v % 1.0 == 0.0) v.toLong().toString() else v.toString()
    else -> v.toString()
}

/** Colours come from templates as ZnColor and from JS as an ARGB number (as in ZnRenderer). */
private fun toColorOrNull(v: Any?): Color? = when (v) {
    is ZnColor -> Color(v.argb)
    is Double -> Color(v.toLong().toInt())
    else -> null
}
