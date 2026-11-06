package dev.zeronative.runtime

import android.os.Handler
import android.os.Looper
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.InputTransformation
import androidx.compose.foundation.text.input.TextFieldBuffer
import androidx.compose.foundation.text.input.TextFieldLineLimits
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.placeCursorAtEnd
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.contentType
import androidx.compose.ui.semantics.password
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.first

/** One box's look; null = not set (the style under it shows). */
internal data class ZnOtpBox(
    val width: Float? = null,
    val height: Float? = null,
    val radius: Float? = null,
    val borderWidth: Float? = null,
    val borderColor: Color? = null,
    val background: Color? = null,
) {
    /** This style over [under]: what this one sets wins (RN's style array order). */
    fun over(under: ZnOtpBox) = ZnOtpBox(
        width ?: under.width, height ?: under.height, radius ?: under.radius,
        borderWidth ?: under.borderWidth, borderColor ?: under.borderColor, background ?: under.background,
    )
}

/**
 * The boxes' look (registry 18), from the compiler's "key=value;..." (registry.ts otpTheme). Defaults are
 * react-native-otp-entry's: boxes 44 x 60, radius 12, border 1 #DFDFDE; caret 2 x 30 in focusColor (#A4D0A4), 350 ms.
 */
internal class ZnOtpTheme(
    val base: ZnOtpBox,
    val focused: ZnOtpBox,
    val filled: ZnOtpBox,
    val disabled: ZnOtpBox,
    val error: ZnOtpBox,
    val focusColor: Color,
    val stickWidth: Float,
    val stickHeight: Float,
    val stickColor: Color,
    val blinkMs: Int,
    val hideStick: Boolean,
    val placeholderColor: Color?,
) {
    companion object {
        private val RN_BOX = ZnOtpBox(44f, 60f, 12f, 1f, Color(0xFFDFDFDE), null)

        fun parse(raw: String?): ZnOtpTheme {
            val kv = HashMap<String, String>()
            raw?.split(';')?.forEach { part ->
                val eq = part.indexOf('=')
                if (eq > 0) kv[part.substring(0, eq)] = part.substring(eq + 1)
            }
            fun num(k: String) = kv[k]?.toFloatOrNull()
            fun color(k: String) = kv[k]?.let { parseArgb(it) }
            fun box(p: String) = ZnOtpBox(num(p + "w"), num(p + "h"), num(p + "r"), num(p + "bw"), color(p + "bc"), color(p + "bg"))
            val focusColor = color("fc") ?: Color(0xFFA4D0A4)
            return ZnOtpTheme(
                base = box("").over(RN_BOX),
                focused = box("f"),
                filled = box("l"),
                disabled = box("d"),
                error = box("e"),
                focusColor = focusColor,
                stickWidth = num("sw") ?: 2f,
                stickHeight = num("sh") ?: 30f,
                stickColor = color("sc") ?: focusColor,
                blinkMs = num("sb")?.toInt()?.coerceAtLeast(50) ?: 350,
                hideStick = kv["hs"] == "1",
                placeholderColor = color("pc"),
            )
        }

        private fun parseArgb(s: String): Color? =
            if (s.length == 9 && s[0] == '#') s.substring(1).toLongOrNull(16)?.let { Color(it.toInt()) } else null
    }

    /**
     * Box [i]'s look, in RN's order: the base, focusColor and the focused style on the focused box, the filled style on
     * a box with a character, the disabled style, then zn's error style.
     */
    fun boxFor(focusedBox: Boolean, filledBox: Boolean, isDisabled: Boolean, isError: Boolean): ZnOtpBox {
        var b = base
        if (focusedBox) b = focused.over(ZnOtpBox(borderColor = focusColor).over(b))
        if (filledBox) b = filled.over(b)
        if (isDisabled) b = disabled.over(b)
        if (isError) b = error.over(b)
        return b
    }
}

/**
 * The characters an OTP box takes (RN `type`), cut to [max]. Unlike react-native-otp-entry, which drops the whole
 * change when one character doesn't fit, other characters are skipped, so a pasted "1234 " or "Code: 1234" works.
 * Digits from other scripts (१२३४, ١٢٣٤) become 0-9: some Indian keyboards type them.
 */
internal fun otpFilter(text: CharSequence, type: Int, max: Int): String {
    val out = StringBuilder()
    for (c in text) {
        if (out.length >= max) break
        val digit = if (Character.isDigit(c)) Character.digit(c, 10) else -1
        val ascii = c.code < 128
        when (type) {
            Registry.OtpType.ALPHA -> if (ascii && c.isLetter()) out.append(c)
            Registry.OtpType.ALPHANUMERIC -> if (digit >= 0) out.append('0' + digit) else if (ascii && c.isLetter()) out.append(c)
            else -> if (digit >= 0) out.append('0' + digit)
        }
    }
    return out.toString()
}

// Lazy: made on first use, so the plain-logic parts of this file run in JVM unit tests.
private val main by lazy { Handler(Looper.getMainLooper()) }

/**
 * `<OtpInput>` (registry 18): one hidden native field over the boxes holds the code (react-native-otp-entry's way), so
 * typing, paste (long press), the keyboard's autofill and ref.setValue all go through it. The boxes only draw it.
 * TalkBack reads one item: the label (on the node, merged by ZnRenderer), the code typed so far and "2 of 4 digits".
 */
@Composable
internal fun ZnOtpInput(s: ZnNodeSpec, inst: ZnInstance, n: Int, mod: Modifier) {
    val max = (s.maxLength ?: 6).coerceIn(1, 12)
    val theme = s.otpTheme
    // From the code typed so far: a new Activity (the process lives on) shows the digits JS still has, as RN does (R51)
    val state = remember(inst.id, n) { TextFieldState(inst.keptText[n].orEmpty()) }
    val disabled = if (s.disabledSlot >= 0) inst.slot(s.disabledSlot).value == true else s.disabled
    val invalid = if (s.invalidSlot >= 0) inst.slot(s.invalidSlot).value == true else s.invalid
    val focusManager = LocalFocusManager.current
    val focus = remember { FocusRequester() }
    var focused by remember(inst.id, n) { mutableStateOf(false) }
    val disabledNow = rememberUpdated(disabled)

    // The code changed (typing, paste, autofill, setValue): tell JS, as RN's onTextChange / onFilled.
    fun emit(t: String) {
        if (s.onChangeText != 0) ZnRuntime.dispatchEvent(inst.id, s.onChangeText, t)
        if (t.length == max) {
            if (s.onFilled != 0) ZnRuntime.dispatchEvent(inst.id, s.onFilled, t)
            if (s.blurOnFilled) focusManager.clearFocus()
        }
    }
    // drop(1): the start text (empty, or the kept code on a new Activity) is no change, so JS isn't told it again (no
    // second onFilled, so no second verify)
    LaunchedEffect(state) {
        snapshotFlow { state.text.toString() }.drop(1).collect {
            inst.keptText[n] = it
            emit(it)
        }
    }

    // ref.setValue(code): "n\u0001code" through the value slot (core otp-input.ts). Ignored while disabled, as RN.
    if (s.valueSlot >= 0) {
        DisposableEffect(inst.id, n) {
            inst.patchWatchers[s.valueSlot] = { v ->
                main.post {
                    val raw = (v as? String).orEmpty()
                    val sep = raw.indexOf('\u0001')
                    if (sep <= 0 || disabledNow.value) return@post
                    val code = otpFilter(raw.substring(sep + 1), s.otpType, max)
                    // The same code again changes nothing in the field, but RN's setValue still reports it.
                    if (code == state.text.toString()) emit(code) else state.setTextAndPlaceCursorAtEnd(code)
                }
            }
            onDispose { inst.patchWatchers.remove(s.valueSlot) }
        }
    }

    // autoFocus (RN's default) waits for the screen's slide, so autofill sees the field in its place (R36).
    val settled = LocalZnScreenSettled.current
    if (s.autoFocus) LaunchedEffect(inst.id, n) {
        snapshotFlow { settled.value }.first { it }
        focus.requestFocus()
    }
    // `ref`: focus() / blur() / clear() find the field through ZnKeyboard, as a TextField's do.
    val refField = if (s.ref != 0) remember(state) { ZnKeyboard.Field(focus, state) } else null
    if (refField != null) {
        DisposableEffect(inst.id, s.ref, refField) {
            ZnKeyboard.attach(inst.id, s.ref, refField)
            onDispose { ZnKeyboard.detach(inst.id, s.ref, refField) }
        }
    }

    val filter = remember(s.otpType, max) {
        object : InputTransformation {
            override fun TextFieldBuffer.transformInput() {
                val now = asCharSequence()
                val kept = otpFilter(now, s.otpType, max)
                if (kept != now.toString()) {
                    replace(0, length, kept)
                    placeCursorAtEnd()
                }
            }
        }
    }
    val autofill = autofillHint(s.autoComplete)
    val text = state.text.toString()
    val fontScale = LocalDensity.current.fontScale
    val base = s.effectiveTextStyle(fontScale)
    val digitStyle = if (s.has(Registry.Prop.FONT_SIZE)) base else base.copy(fontSize = (28f * s.fontScaleCap(fontScale)).sp)
    val color = s.color ?: Color.Black
    val placeholder = if (s.placeholderSlot >= 0) (inst.slot(s.placeholderSlot).value as? String).orEmpty() else s.placeholder.orEmpty()
    // The label goes on the hidden field (ZnRenderer leaves it off the container), so TalkBack reads one item.
    val label = if (s.accessibilityLabelSlot >= 0) inst.slot(s.accessibilityLabelSlot).value as? String else s.accessibilityLabel
    val unit = if (s.otpType == Registry.OtpType.NUMERIC) "digits" else "characters"
    val clear = TextSelectionColors(handleColor = Color.Transparent, backgroundColor = Color.Transparent)

    // Codes read left to right in every language: the boxes don't flip in a right-to-left layout.
    CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Ltr, LocalTextSelectionColors provides clear) {
        Box(mod) {
            Row(
                // RN's container: as wide as its parent and space-between, unless containerStyle says otherwise.
                Modifier.fillMaxWidth().clearAndSetSemantics {},
                horizontalArrangement = if (s.has(Registry.Prop.JUSTIFY_CONTENT) || s.gap > 0f) {
                    znHorizontalArrangement(s.justify, s.gap)
                } else Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                for (i in 0 until max) {
                    val ch = text.getOrNull(i)
                    val focusedInput = i == text.length && !disabled && focused
                    val focusedBox = focusedInput || (text.length == max && i == max - 1 && focused)
                    val b = theme.boxFor(focusedBox, ch != null, disabled, invalid)
                    val shape = RoundedCornerShape((b.radius ?: 0f).dp)
                    Box(
                        Modifier.size((b.width ?: 44f).dp, (b.height ?: 60f).dp).clip(shape)
                            .then(if (b.background != null) Modifier.background(b.background, shape) else Modifier)
                            .border((b.borderWidth ?: 0f).dp, b.borderColor ?: Color.Transparent, shape),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (focusedInput && !theme.hideStick) {
                            OtpStick(theme)
                        } else if (ch != null) {
                            BasicText(if (s.secure) "•" else ch.toString(), style = digitStyle.copy(color = color), maxLines = 1)
                        } else if (placeholder.isNotEmpty()) {
                            val p = if (placeholder.length == 1) placeholder else placeholder.getOrNull(i)?.toString().orEmpty()
                            BasicText(
                                p,
                                style = digitStyle.copy(color = theme.placeholderColor ?: color.copy(alpha = color.alpha * 0.5f)),
                                maxLines = 1,
                            )
                        }
                    }
                }
            }
            BasicTextField(
                state = state,
                // Not alpha(0): Compose leaves a see-through node out of TalkBack. The text is drawn in no colour instead.
                modifier = Modifier.matchParentSize()
                    .semantics {
                        if (autofill != null) contentType = autofill
                        if (label != null) contentDescription = label
                        if (s.secure) password()
                        stateDescription = "${text.length} of $max $unit"
                    }
                    .focusRequester(focus)
                    .onFocusChanged {
                        if (it.isFocused == focused) return@onFocusChanged
                        focused = it.isFocused
                        refField?.focused = it.isFocused
                        val id = if (it.isFocused) s.onFocus else s.onBlur
                        if (id != 0) ZnRuntime.dispatchEvent(inst.id, id)
                    },
                readOnly = disabled,
                inputTransformation = filter,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = when (s.keyboardType) {
                        Registry.KeyboardType.NUMBER_PAD -> KeyboardType.NumberPassword // digits only, as in React Native
                        Registry.KeyboardType.DECIMAL_PAD -> KeyboardType.Decimal
                        Registry.KeyboardType.PHONE_PAD -> KeyboardType.Phone
                        else -> if (s.otpType == Registry.OtpType.NUMERIC) KeyboardType.NumberPassword else KeyboardType.Ascii
                    },
                    imeAction = ImeAction.Done,
                ),
                lineLimits = TextFieldLineLimits.SingleLine,
                textStyle = TextStyle(color = Color.Transparent),
                cursorBrush = SolidColor(Color.Transparent),
            )
        }
    }
}

/** The blinking caret in the focused box (RN's VerticalStick: fades out and in, [ZnOtpTheme.blinkMs] each way). */
@Composable
private fun OtpStick(theme: ZnOtpTheme) {
    val blink = rememberInfiniteTransition(label = "otp-stick")
    val a by blink.animateFloat(1f, 0f, infiniteRepeatable(tween(theme.blinkMs), RepeatMode.Reverse), label = "otp-stick-alpha")
    Box(Modifier.width(theme.stickWidth.dp).height(theme.stickHeight.dp).alpha(a).background(theme.stickColor))
}

/** A state that always holds the latest [value], for callbacks that outlive a recomposition. */
@Composable
private fun <T> rememberUpdated(value: T): androidx.compose.runtime.State<T> {
    val s = remember { mutableStateOf(value) }
    s.value = value
    return s
}
