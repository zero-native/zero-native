// <OtpInput> on iOS (registry 18), as android/runtime's ZnOtpInput.kt (react-native-otp-entry's way): one hidden
// native field over the boxes holds the code, so typing, paste, the keyboard's code autofill (iOS: the SMS code
// above the keyboard, `autoComplete="sms-otp"` or by default) and ref.setValue all go through it; the boxes only
// draw it. Same theme ("key=value;..." from the compiler), the same character filter (digits from other scripts
// become 0-9, other characters are skipped so a pasted "Code: 1234" works), onChangeText / onFilled, blurOnFilled,
// disabled (read only, setValue ignored), invalid (the error box style), secure dots, placeholder, autoFocus, `ref`
// (Keyboard.focus / blur / clear). The boxes read left to right in every language. VoiceOver reads one element: the
// label and "2 of 4 digits".
import SwiftUI
import UIKit

/// One box's look; nil = not set (the style under it shows).
struct ZnOtpBox {
    var width: CGFloat?, height: CGFloat?, radius: CGFloat?, borderWidth: CGFloat?
    var borderColor: Color?, background: Color?

    /// This style over [under]: what this one sets wins.
    func over(_ u: ZnOtpBox) -> ZnOtpBox {
        ZnOtpBox(width: width ?? u.width, height: height ?? u.height, radius: radius ?? u.radius,
                 borderWidth: borderWidth ?? u.borderWidth, borderColor: borderColor ?? u.borderColor,
                 background: background ?? u.background)
    }
}

/// The boxes' look. Defaults are react-native-otp-entry's: boxes 44 x 60, radius 12, border 1 #DFDFDE; caret 2 x 30 in
/// focusColor (#A4D0A4), 350 ms.
struct ZnOtpTheme {
    var base: ZnOtpBox, focused: ZnOtpBox, filled: ZnOtpBox, disabled: ZnOtpBox, error: ZnOtpBox
    var focusColor: Color
    var stickWidth: CGFloat, stickHeight: CGFloat
    var stickColor: Color
    var blinkMs: Int
    var hideStick: Bool
    var placeholderColor: Color?

    static func parse(_ raw: String?) -> ZnOtpTheme {
        var kv: [String: String] = [:]
        for part in (raw ?? "").split(separator: ";") {
            guard let eq = part.firstIndex(of: "="), eq != part.startIndex else { continue }
            kv[String(part[..<eq])] = String(part[part.index(after: eq)...])
        }
        func num(_ k: String) -> CGFloat? { kv[k].flatMap { Double($0) }.map { CGFloat($0) } }
        func color(_ k: String) -> Color? {
            guard let s = kv[k], s.count == 9, s.first == "#", let v = UInt32(s.dropFirst(), radix: 16) else { return nil }
            return znColor(.color(v))
        }
        func box(_ p: String) -> ZnOtpBox {
            ZnOtpBox(width: num(p + "w"), height: num(p + "h"), radius: num(p + "r"), borderWidth: num(p + "bw"),
                     borderColor: color(p + "bc"), background: color(p + "bg"))
        }
        let rn = ZnOtpBox(width: 44, height: 60, radius: 12, borderWidth: 1,
                          borderColor: Color(.sRGB, red: 0xDF / 255, green: 0xDF / 255, blue: 0xDE / 255), background: nil)
        let focus = color("fc") ?? Color(.sRGB, red: 0xA4 / 255, green: 0xD0 / 255, blue: 0xA4 / 255)
        return ZnOtpTheme(base: box("").over(rn), focused: box("f"), filled: box("l"), disabled: box("d"), error: box("e"),
                          focusColor: focus, stickWidth: num("sw") ?? 2, stickHeight: num("sh") ?? 30,
                          stickColor: color("sc") ?? focus, blinkMs: max(Int(num("sb") ?? 350), 50),
                          hideStick: kv["hs"] == "1", placeholderColor: color("pc"))
    }

    /// A box's look in RN's order: base, focusColor and the focused style, filled, disabled, then zn's error style.
    func box(focused f: Bool, filled l: Bool, disabled d: Bool, error e: Bool) -> ZnOtpBox {
        var b = base
        if f { b = focused.over(ZnOtpBox(borderColor: focusColor).over(b)) }
        if l { b = filled.over(b) }
        if d { b = disabled.over(b) }
        if e { b = error.over(b) }
        return b
    }
}

/// The characters an OTP box takes (RN `type`), cut to [max] (otpFilter in ZnOtpInput.kt).
func znOtpFilter(_ text: String, _ type: Int, _ max: Int) -> String {
    var out = ""
    for c in text {
        if out.count >= max { break }
        let digit = c.wholeNumberValue.flatMap { c.isNumber && $0 < 10 ? $0 : nil }
        let ascii = c.isASCII
        switch type {
        case Registry.OtpType.alpha: if ascii && c.isLetter { out.append(c) }
        case Registry.OtpType.alphanumeric:
            if let d = digit { out += String(d) } else if ascii && c.isLetter { out.append(c) }
        default: if let d = digit { out += String(d) }
        }
    }
    return out
}

@Observable
final class ZnOtpState {
    var code = ""
    var focused = false
}

struct ZnOtpInputView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    @State private var state = ZnOtpState()
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let max = min(Swift.max(s.maxLength ?? 6, 1), 12)
        let theme = ZnOtpTheme.parse(s.otpTheme)
        let disabled = s.disabledNow(inst)
        let invalid = s.invalidSlot >= 0 ? inst.slot(s.invalidSlot).value == .bool(true) : s.invalid
        let placeholder = s.placeholderSlot >= 0 ? (inst.slot(s.placeholderSlot).value.string ?? "") : (s.placeholder ?? "")
        let color = s.color ?? .black
        // The digits follow the phone's text size (capped by maxFontScale), as Android's 28 sp default does.
        let size: CGFloat = (s.props[Registry.Prop.fontSize] != nil ? Swift.max(s.fontSize, 0) : 28) * s.textScale(typeSize)
        let font = znFont(s.fontFamily, size: size, weight: s.fontWeight, italic: s.italic)
        let chars = Array(state.code)
        let setValue = s.valueSlot >= 0 ? inst.slot(s.valueSlot).value : .null
        HStack(spacing: s.gap) {
                ForEach(0..<max, id: \.self) { i in
                    let ch: Character? = i < chars.count ? chars[i] : nil
                    let focusedInput = i == chars.count && !disabled && state.focused
                    let focusedBox = focusedInput || (chars.count == max && i == max - 1 && state.focused)
                    let b = theme.box(focused: focusedBox, filled: ch != nil, disabled: disabled, error: invalid)
                    if i > 0 && s.gap == 0 && s.props[Registry.Prop.justifyContent] == nil { Spacer(minLength: 0) }
                    ZStack {
                        RoundedRectangle(cornerRadius: b.radius ?? 0).fill(b.background ?? .clear)
                        RoundedRectangle(cornerRadius: b.radius ?? 0)
                            .strokeBorder(b.borderColor ?? .clear, lineWidth: b.borderWidth ?? 0)
                        if focusedInput && !theme.hideStick {
                            ZnOtpStick(theme: theme)
                        } else if let ch {
                            Text(s.secure ? "•" : String(ch)).font(font).foregroundStyle(color)
                        } else if !placeholder.isEmpty {
                            let p = placeholder.count == 1 ? placeholder : (i < placeholder.count ? String(Array(placeholder)[i]) : "")
                            Text(p).font(font)
                                .foregroundStyle(theme.placeholderColor ?? color.opacity(0.5))
                        }
                    }
                    .frame(width: b.width ?? 44, height: b.height ?? 60)
                }
            }
            .frame(maxWidth: .infinity, alignment: s.justify == Registry.JustifyContent.center ? .center
                   : s.justify == Registry.JustifyContent.flexEnd ? .trailing : .leading)
            .accessibilityHidden(true)
        // The hidden field covers the boxes (an overlay: as a sibling it would make the input as tall as it can be).
        .overlay { ZnOtpField(ctx: ctx, s: s, inst: inst, state: state, max: max, disabled: disabled,
                              label: s.accessibilityLabelNow(inst)) }
        .environment(\.layoutDirection, .leftToRight)
        .onChange(of: setValue) { _, v in
            // ref.setValue(code): "n\u{1}code" through the value slot (core otp-input.ts). Ignored while disabled.
            guard !disabled, let raw = v.string, let sep = raw.firstIndex(of: "\u{1}"), sep != raw.startIndex else { return }
            let code = znOtpFilter(String(raw[raw.index(after: sep)...]), s.otpType, max)
            ZnOtpField.set(state, code, ctx: ctx, s: s, inst: inst, max: max, force: true)
        }
    }
}

/// The blinking caret in the focused box (RN's VerticalStick: fades out and in, blinkMs each way).
private struct ZnOtpStick: View {
    let theme: ZnOtpTheme
    @State private var on = true

    var body: some View {
        Rectangle().fill(theme.stickColor).frame(width: theme.stickWidth, height: theme.stickHeight)
            .opacity(on ? 1 : 0)
            .onAppear {
                withAnimation(.easeInOut(duration: Double(theme.blinkMs) / 1000).repeatForever(autoreverses: true)) { on = false }
            }
    }
}

/// The hidden field over the boxes: no text colour, no caret, the caret always at the end.
struct ZnOtpField: UIViewRepresentable {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let state: ZnOtpState
    let max: Int
    let disabled: Bool
    /// accessibilityLabel now (also from a slot, ZnOtpInput.kt reads it the same way).
    let label: String?

    /// The code changed (typing, paste, autofill, setValue): JS hears onChangeText, and onFilled when it is full.
    @MainActor static func set(_ state: ZnOtpState, _ code: String, ctx: ZnContext, s: ZnNodeSpec, inst: ZnInstance, max: Int,
                               force: Bool = false, field: UITextField? = nil) {
        // The same code again changes nothing, but RN's setValue still reports it.
        guard code != state.code || force else { return }
        state.code = code
        if let field, field.text != code { field.text = code }
        if s.onChangeText != 0 { ctx.send(inst.id, s.onChangeText, .string(code)) }
        if code.count == max {
            if s.onFilled != 0 { ctx.send(inst.id, s.onFilled, .string(code)) }
            if s.blurOnFilled { DispatchQueue.main.async { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) } }
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var parent: ZnOtpField?

        @objc func changed(_ f: UITextField) {
            guard let p = parent else { return }
            let kept = znOtpFilter(f.text ?? "", p.s.otpType, p.max)
            if kept != f.text { f.text = kept }
            MainActor.assumeIsolated { ZnOtpField.set(p.state, kept, ctx: p.ctx, s: p.s, inst: p.inst, max: p.max) }
        }

        func textFieldShouldBeginEditing(_ f: UITextField) -> Bool { !(parent?.disabled ?? false) }

        func textFieldDidBeginEditing(_ f: UITextField) {
            guard let p = parent else { return }
            MainActor.assumeIsolated {
                p.state.focused = true
                if p.s.onFocus != 0 { p.ctx.send(p.inst.id, p.s.onFocus, .none) }
                ZnFieldFocus.revealSoon()
            }
        }

        func textFieldDidEndEditing(_ f: UITextField) {
            guard let p = parent else { return }
            MainActor.assumeIsolated {
                p.state.focused = false
                if p.s.onBlur != 0 { p.ctx.send(p.inst.id, p.s.onBlur, .none) }
            }
        }

        /// The caret stays at the end: a code is typed in order.
        func textFieldDidChangeSelection(_ f: UITextField) {
            let end = f.endOfDocument
            if f.selectedTextRange?.start != end { f.selectedTextRange = f.textRange(from: end, to: end) }
        }

        func textFieldShouldReturn(_ f: UITextField) -> Bool {
            f.resignFirstResponder()
            return true
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextField {
        let f = UITextField()
        f.textColor = .clear
        f.tintColor = .clear
        f.backgroundColor = .clear
        f.autocorrectionType = .no
        f.autocapitalizationType = .none
        f.spellCheckingType = .no
        f.smartInsertDeleteType = .no
        f.returnKeyType = .done
        f.delegate = context.coordinator
        f.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        if s.ref != 0 { ZnKeyboard.attach(f, inst.id, s.ref) }
        // The keyboard's autofill offers the SMS code (on unless autoComplete says otherwise).
        if s.autoComplete == -1 || s.autoComplete == Registry.AutoComplete.smsOtp { f.textContentType = .oneTimeCode }
        switch s.keyboardType {
        case Registry.KeyboardType.decimalPad: f.keyboardType = .decimalPad
        case Registry.KeyboardType.phonePad: f.keyboardType = .phonePad
        case Registry.KeyboardType.numberPad: f.keyboardType = .numberPad
        default: f.keyboardType = s.otpType == Registry.OtpType.numeric ? .numberPad : .asciiCapable
        }
        f.isSecureTextEntry = false  // the boxes draw dots; a secure field would block the code autofill
        f.isAccessibilityElement = true
        if s.autoFocus { DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { f.becomeFirstResponder() } }  // after the screen's slide
        return f
    }

    func updateUIView(_ f: UITextField, context: Context) {
        context.coordinator.parent = self
        if f.text != state.code { f.text = state.code }
        let unit = s.otpType == Registry.OtpType.numeric ? "digits" : "characters"
        f.accessibilityLabel = label
        if let hint = s.accessibilityHint { f.accessibilityHint = hint }
        if let id = s.testID { f.accessibilityIdentifier = id }
        f.accessibilityValue = "\(state.code.count) of \(max) \(unit)"
        znFieldTouch(f, off: context.environment.znTouchOff)
        if disabled && f.isFirstResponder { f.resignFirstResponder() }
    }
}
