// <TextField> on iOS, both ways (i.1c). Controlled, as android/runtime's ZnTextField.kt (ARCHITECTURE §9.4): the
// native field owns the text while the user types; each change goes to JS as "n\u0001text"; JS answers
// "n\u0001value" (packages/core view.ts textInput). An answer to an older change is ignored (the user typed on); an
// answer to the newest change, or a plain value (JS set it by itself), is shown if it differs from the field.
//
// UIKit variant: UITextField. When JS changes the text (a reformat, a rejected character), the cursor keeps its
// distance from the end, so "₹1,234" → typing in the middle doesn't throw the cursor to the end; marked text (an IME
// composing) is never replaced. SwiftUI variant: TextField(text:). It has no cursor or marked-text API before iOS 18,
// so a value from JS puts the cursor at the end.
import SwiftUI
import UIKit

/// What a field keeps between changes: the number of the newest change sent to JS.
@MainActor
final class ZnFieldState {
    var seq = 0
}

struct ZnTextFieldView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    @State private var state = ZnFieldState()

    var body: some View {
        let raw = s.valueSlot >= 0 ? inst.slot(s.valueSlot).value : (s.props[Registry.Prop.value] ?? .null)
        switch ZnImpl.field {
        case .uiKit where s.multiline: ZnUIKitTextView(ctx: ctx, s: s, inst: inst, state: state, raw: raw)
        case .uiKit: ZnUIKitField(ctx: ctx, s: s, inst: inst, state: state, raw: raw)
        case .swiftUI: ZnSwiftUIField(ctx: ctx, s: s, inst: inst, state: state, raw: raw)
        }
    }
}

/// A tap anywhere in a field's box (its padding, the rest of a minHeight) focuses the field, as on Android, where
/// the whole box is the field. The native view is one line tall at the top of the box; without this a tap below it
/// did nothing (found 2026-11-08 on the sample's 64 pt note box). Taps on the native view itself go to it as before.
@MainActor
enum ZnFieldFocus {
    private static var views: [String: WeakView] = [:]
    final class WeakView { weak var view: UIView?; init(_ v: UIView) { view = v } }

    static func key(_ inst: ZnInstance, _ node: Int) -> String { "\(ObjectIdentifier(inst).hashValue):\(node)" }
    static func register(_ v: UIView, _ inst: ZnInstance, _ node: Int) {
        views = views.filter { $0.value.view != nil }
        views[key(inst, node)] = WeakView(v)
    }
    static func focus(_ inst: ZnInstance, _ node: Int) {
        guard let v = views[key(inst, node)]?.view, !v.isFirstResponder else { return }
        v.becomeFirstResponder()
    }
}

struct ZnFieldBoxTap: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if s.type == Registry.Component.textField {
            content.contentShape(Rectangle()).onTapGesture { ZnFieldFocus.focus(inst, s.index) }
        } else {
            content
        }
    }
}

/// The value JS sent: (change number it answers, or nil for a plain value; the text).
func znFieldValue(_ v: ZnValue) -> (Int?, String) {
    let text = znDisplay(v)
    guard let sep = text.firstIndex(of: "\u{1}") else { return (nil, text) }
    return (Int(text[..<sep]), String(text[text.index(after: sep)...]))
}

// MARK: - UIKit

struct ZnUIKitField: UIViewRepresentable {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let state: ZnFieldState
    let raw: ZnValue

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextField {
        let f = UITextField()
        f.delegate = context.coordinator
        f.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        f.setContentHuggingPriority(.defaultLow, for: .horizontal)
        f.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        ZnFieldFocus.register(f, inst, s.index)
        if s.autoFocus { DispatchQueue.main.async { f.becomeFirstResponder() } }
        return f
    }

    /// The field's own height at the offered width. Without this a UIKit view takes all the height it is offered
    /// (inside a Scroll that is unlimited: found 2026-11-08, the first field filled the screen).
    func sizeThatFits(_ proposal: ProposedViewSize, uiView f: UITextField, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? f.intrinsicContentSize.width, height: f.intrinsicContentSize.height)
    }

    func updateUIView(_ f: UITextField, context: Context) {
        let c = context.coordinator
        c.send = { [ctx, inst, s] event, text in ctx.send(inst.id, event, text.map(ZnPayload.string) ?? .none) }
        c.s = s
        c.state = state
        f.placeholder = s.placeholder
        f.font = .systemFont(ofSize: s.fontSize, weight: znUIWeight(s.fontWeight))
        f.textColor = s.color.map(UIColor.init) ?? .black
        f.isSecureTextEntry = s.secure
        f.keyboardType = znKeyboard(s.keyboardType)
        f.returnKeyType = znReturnKey(s.returnKeyType) ?? .done
        f.textAlignment = s.textAlign == Registry.TextAlign.center ? .center : s.textAlign == Registry.TextAlign.end ? .right : .left

        // Only a new value from JS counts: SwiftUI calls this for many reasons, and re-applying JS's last value would
        // undo what the user typed before JS answered (found 2026-11-08: typing showed nothing).
        guard raw != c.lastRaw else { return }
        c.lastRaw = raw
        let (answers, value) = znFieldValue(raw)
        if let n = answers, n != state.seq { return }  // an answer to an older change: the user typed on since
        guard value != (f.text ?? ""), f.markedTextRange == nil else { return }
        print("zn t=\(ZnDebug.ms()) field: JS changed the text to \"\(value)\"")
        // Keep the cursor's distance from the end: a reformat ("1234" → "1,234") leaves it after the same digit.
        let fromEnd = f.selectedTextRange.map { f.offset(from: $0.end, to: f.endOfDocument) } ?? 0
        f.text = value
        if let p = f.position(from: f.endOfDocument, offset: -min(fromEnd, value.count)) {
            f.selectedTextRange = f.textRange(from: p, to: p)
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        var send: (Int, String?) -> Void = { _, _ in }
        var lastRaw: ZnValue?
        var s: ZnNodeSpec?
        var state: ZnFieldState?

        @objc func changed(_ f: UITextField) {
            guard let s, let state, s.onChangeText != 0 else { return }
            if f.markedTextRange != nil { return }  // an IME is composing: send when it commits
            state.seq += 1
            print("zn t=\(ZnDebug.ms()) field: typed → JS \"\(f.text ?? "")\" (change \(state.seq))")
            send(s.onChangeText, "\(state.seq)\u{1}\(f.text ?? "")")
        }

        func textField(_ f: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            guard let max = s?.maxLength else { return true }
            let current = (f.text ?? "") as NSString
            return current.replacingCharacters(in: range, with: string).count <= max
        }

        func textFieldDidBeginEditing(_ f: UITextField) { if let s, s.onFocus != 0 { send(s.onFocus, nil) } }
        func textFieldDidEndEditing(_ f: UITextField) { if let s, s.onBlur != 0 { send(s.onBlur, nil) } }
        func textFieldShouldReturn(_ f: UITextField) -> Bool {
            if let s, s.onSubmitEditing != 0 { send(s.onSubmitEditing, f.text ?? "") }
            f.resignFirstResponder()
            return true
        }
    }
}

// MARK: - SwiftUI

struct ZnSwiftUIField: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let state: ZnFieldState
    let raw: ZnValue
    @State private var text = ""

    var body: some View {
        let field = Group {
            if s.secure {
                SecureField(s.placeholder ?? "", text: binding)
            } else {
                TextField(s.placeholder ?? "", text: binding)
            }
        }
        field
            .font(.system(size: s.fontSize, weight: znWeight(s.fontWeight)))
            .foregroundStyle(s.color ?? .black)
            .keyboardType(znKeyboard(s.keyboardType))
            .onAppear { text = znFieldValue(raw).1 }
            .onChange(of: raw) { _, v in
                let (answers, value) = znFieldValue(v)
                if let n = answers, n != state.seq { return }
                if value != text { text = value }  // the cursor goes to the end: no API to keep it (iOS 17)
            }
    }

    private var binding: Binding<String> {
        Binding(get: { text }, set: { new in
            var t = new
            if let max = s.maxLength, t.count > max { t = String(t.prefix(max)) }
            text = t
            guard s.onChangeText != 0 else { return }
            state.seq += 1
            ctx.send(inst.id, s.onChangeText, .string("\(state.seq)\u{1}\(t)"))
        })
    }
}

// MARK: - UIKit, multiline: UITextView

/// A multiline <TextField>: same protocol as the single-line one. Return makes a new line, unless the field sets
/// returnKeyType: then Return is the keyboard's action and sends onSubmitEditing (as on Android). It grows with its
/// text; minHeight / height from the style still apply.
struct ZnUIKitTextView: UIViewRepresentable {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let state: ZnFieldState
    let raw: ZnValue

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextView {
        let v = UITextView()
        v.delegate = context.coordinator
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.isScrollEnabled = false  // grows with its text
        let placeholder = UILabel()
        placeholder.textColor = UIColor(red: 0.61, green: 0.64, blue: 0.69, alpha: 1)  // as Android's default
        placeholder.numberOfLines = 0
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(placeholder)
        NSLayoutConstraint.activate([
            placeholder.topAnchor.constraint(equalTo: v.topAnchor),
            placeholder.leadingAnchor.constraint(equalTo: v.leadingAnchor),
            placeholder.widthAnchor.constraint(equalTo: v.widthAnchor),
        ])
        context.coordinator.placeholder = placeholder
        ZnFieldFocus.register(v, inst, s.index)
        if s.autoFocus { DispatchQueue.main.async { v.becomeFirstResponder() } }
        return v
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView v: UITextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 200
        let fit = v.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = v.font?.lineHeight ?? 17
        return CGSize(width: width, height: max(fit.height, line))
    }

    func updateUIView(_ v: UITextView, context: Context) {
        let c = context.coordinator
        c.send = { [ctx, inst] event, text in ctx.send(inst.id, event, text.map(ZnPayload.string) ?? .none) }
        c.s = s
        c.state = state
        let font = UIFont.systemFont(ofSize: s.fontSize, weight: znUIWeight(s.fontWeight))
        v.font = font
        v.textColor = s.color.map(UIColor.init) ?? .black
        v.keyboardType = znKeyboard(s.keyboardType)
        v.returnKeyType = znReturnKey(s.returnKeyType) ?? .default
        c.placeholder?.text = s.placeholder
        c.placeholder?.font = font
        defer { c.placeholder?.isHidden = !v.text.isEmpty }

        guard raw != c.lastRaw else { return }
        c.lastRaw = raw
        let (answers, value) = znFieldValue(raw)
        if let n = answers, n != state.seq { return }
        guard value != v.text, v.markedTextRange == nil else { return }
        let fromEnd = v.selectedTextRange.map { v.offset(from: $0.end, to: v.endOfDocument) } ?? 0
        v.text = value
        if let p = v.position(from: v.endOfDocument, offset: -min(fromEnd, value.count)) {
            v.selectedTextRange = v.textRange(from: p, to: p)
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var send: (Int, String?) -> Void = { _, _ in }
        var lastRaw: ZnValue?
        var s: ZnNodeSpec?
        var state: ZnFieldState?
        weak var placeholder: UILabel?

        func textViewDidChange(_ v: UITextView) {
            placeholder?.isHidden = !v.text.isEmpty
            guard let s, let state, s.onChangeText != 0, v.markedTextRange == nil else { return }
            state.seq += 1
            send(s.onChangeText, "\(state.seq)\u{1}\(v.text ?? "")")
        }

        func textView(_ v: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard let s else { return true }
            if text == "\n", s.returnKeyType >= 0 {  // Return is the keyboard's action, not a new line
                if s.onSubmitEditing != 0 { send(s.onSubmitEditing, v.text) }
                v.resignFirstResponder()
                return false
            }
            guard let max = s.maxLength else { return true }
            return ((v.text ?? "") as NSString).replacingCharacters(in: range, with: text).count <= max
        }

        func textViewDidBeginEditing(_ v: UITextView) { if let s, s.onFocus != 0 { send(s.onFocus, nil) } }
        func textViewDidEndEditing(_ v: UITextView) { if let s, s.onBlur != 0 { send(s.onBlur, nil) } }
    }
}

func znReturnKey(_ k: Int) -> UIReturnKeyType? {
    switch k {
    case Registry.ReturnKeyType.done: return .done
    case Registry.ReturnKeyType.go: return .go
    case Registry.ReturnKeyType.next: return .next
    case Registry.ReturnKeyType.search: return .search
    case Registry.ReturnKeyType.send: return .send
    default: return nil
    }
}

func znKeyboard(_ k: Int) -> UIKeyboardType {
    switch k {
    case Registry.KeyboardType.numberPad: return .numberPad
    case Registry.KeyboardType.decimalPad: return .decimalPad
    case Registry.KeyboardType.phonePad: return .phonePad
    case Registry.KeyboardType.emailAddress: return .emailAddress
    case Registry.KeyboardType.url: return .URL
    default: return .default
    }
}

func znUIWeight(_ w: Int?) -> UIFont.Weight {
    switch w ?? 400 {
    case ..<350: return .light
    case ..<450: return .regular
    case ..<550: return .medium
    case ..<650: return .semibold
    case ..<750: return .bold
    default: return .heavy
    }
}
