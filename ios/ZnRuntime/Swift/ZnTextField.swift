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
        // Read here, so a slot's change updates the native field (Observation runs updateUIView again).
        let look = znFieldLook(s, inst)
        switch ZnImpl.field {
        case .uiKit where s.multiline: ZnUIKitTextView(ctx: ctx, s: s, inst: inst, state: state, raw: raw, look: look)
        case .uiKit: ZnUIKitField(ctx: ctx, s: s, inst: inst, state: state, raw: raw, look: look)
        case .swiftUI: ZnSwiftUIField(ctx: ctx, s: s, inst: inst, state: state, raw: raw, look: look)
        }
    }
}

/// What a field shows that may come from a slot: editable, the text colour and the placeholder (ZnTextField.kt reads
/// the same three from their slots).
struct ZnFieldLook: Equatable {
    var editable: Bool
    var color: Color
    var placeholder: String
}

/// editable: a slot's null counts as editable, as on Android (`!= false`).
@MainActor func znFieldLook(_ s: ZnNodeSpec, _ inst: ZnInstance) -> ZnFieldLook {
    let editable = s.editableSlot >= 0 ? inst.slot(s.editableSlot).value != .bool(false) : s.editable
    let color = s.colorSlot >= 0 ? (znColor(inst.slot(s.colorSlot).value) ?? .black) : (s.color ?? .black)
    let placeholder = s.placeholderSlot >= 0 ? znDisplay(inst.slot(s.placeholderSlot).value) : (s.placeholder ?? "")
    return ZnFieldLook(editable: editable, color: color, placeholder: placeholder)
}

/// A tap anywhere in a field's box (its padding, the rest of a minHeight) focuses the field, as on Android, where
/// the whole box is the field. The native view is one line tall at the top of the box; without this a tap below it
/// did nothing (found 2026-11-08 on the sample's 64 pt note box). Taps on the native view itself go to it as before.
//
// The focused field is scrolled into view, as Compose keeps a focused text field in view: when it gets focus, and
// while the keyboard opens and the screen above it shrinks (keyboard: "resize"). The whole box shows, not just the
// one-line native view, so its padding and the rest of a tall box show too. A plain UIView behind the box
// (ZnFieldBoxMarker) gives the box's frame in UIKit terms; every scroll view around it (a <Scroll>'s, a list's)
// scrolls the least it can to show it, innermost first.
//
// SwiftUI moves the screen to its new size over the keyboard's animation, frame by frame (seen 2026-11-08: the
// scroll view was 419 pt tall 150 ms in, 336 pt at the end), so one look at any moment is wrong. While the keyboard
// moves, every frame puts the box back in view without animation, so the content rides up with the keyboard.
@MainActor
enum ZnFieldFocus {
    private static var views: [String: WeakView] = [:]
    private static var boxes: [String: WeakView] = [:]
    final class WeakView { weak var view: UIView?; init(_ v: UIView) { view = v } }

    static func key(_ inst: ZnInstance, _ node: Int) -> String { "\(ObjectIdentifier(inst).hashValue):\(node)" }
    static func register(_ v: UIView, _ inst: ZnInstance, _ node: Int) {
        views = views.filter { $0.value.view != nil }
        views[key(inst, node)] = WeakView(v)
    }
    static func registerBox(_ v: UIView, _ key: String) {
        boxes = boxes.filter { $0.value.view != nil }
        boxes[key] = WeakView(v)
    }
    /// The boxes of the fields in [window] under [point] (window coordinates), with the view controller each is in: a
    /// Pressable around a field leaves the touch to it (ZnTouchControl.hitTest).
    static func boxes(at point: CGPoint, in window: UIWindow) -> [(frame: CGRect, controller: UIViewController?)] {
        boxes.values.compactMap { w in
            guard let v = w.view, v.window === window, !v.isHidden else { return nil }
            let f = v.convert(v.bounds, to: window)
            return f.contains(point) ? (f, znNearestController(v)) : nil
        }
    }

    static func focus(_ inst: ZnInstance, _ node: Int) {
        guard let v = views[key(inst, node)]?.view, !v.isFirstResponder else { return }
        v.becomeFirstResponder()
    }

    /// After this run of the main loop: scrolls the focused field's box into view, animated. On focus (another field
    /// while the keyboard is up, or a hardware keyboard).
    static func revealSoon() {
        DispatchQueue.main.async { reveal(animated: true) }
    }

    private static var link: CADisplayLink?
    private static var followUntil: CFTimeInterval = 0
    private final class Ticker: NSObject {
        @objc func tick(_ l: CADisplayLink) {
            MainActor.assumeIsolated {
                ZnFieldFocus.reveal(animated: false)
                if l.timestamp >= ZnFieldFocus.followUntil { ZnFieldFocus.stopFollowing() }
            }
        }
    }
    private static let ticker = Ticker()

    /// The keyboard starts to move for [duration] seconds: keep the focused field in view on every frame meanwhile.
    /// Called again when it has arrived, for SwiftUI's last frames.
    static func followKeyboard(duration: Double) {
        // SwiftUI's own motion ends a little after the keyboard's.
        followUntil = CACurrentMediaTime() + max(duration, 0.25) + 0.2
        guard link == nil else { return }
        let l = CADisplayLink(target: ticker, selector: #selector(Ticker.tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
    }

    private static var followedFrames = 0

    private static func stopFollowing() {
        link?.invalidate()
        link = nil
        if followedFrames > 0 { print("zn t=\(ZnDebug.ms()) keyboard: kept the focused field in view over \(followedFrames) frames") }
        followedFrames = 0
    }

    private static func reveal(animated: Bool) {
        guard let (key, field) = views.first(where: { $0.value.view?.isFirstResponder == true }),
              let field = field.view else { return }
        let target = boxes[key]?.view ?? field
        var v = target.superview
        while let sv = v {
            if let scroll = sv as? UIScrollView, scroll.isScrollEnabled {
                let rect = target.convert(target.bounds, to: scroll)
                let seen = scroll.bounds.inset(by: scroll.adjustedContentInset)
                if !seen.insetBy(dx: -1, dy: -1).contains(rect) {  // a point of slack: frames are fractional
                    if animated {
                        print("zn t=\(ZnDebug.ms()) keyboard: scroll the focused field into view (y \(Int(rect.minY))–\(Int(rect.maxY)), seen \(Int(seen.minY))–\(Int(seen.maxY)))")
                        scroll.scrollRectToVisible(rect, animated: true)
                    } else {
                        scroll.setContentOffset(offsetShowing(rect, in: scroll, seen: seen), animated: false)
                        followedFrames += 1
                    }
                }
            }
            v = sv.superview
        }
    }

    /// The content offset that shows [rect] with the least movement (its top when it is taller than what shows),
    /// kept inside the content.
    private static func offsetShowing(_ rect: CGRect, in scroll: UIScrollView, seen: CGRect) -> CGPoint {
        func axis(_ lo: CGFloat, _ hi: CGFloat, _ seenLo: CGFloat, _ seenHi: CGFloat, _ now: CGFloat,
                  _ minOff: CGFloat, _ maxOff: CGFloat) -> CGFloat {
            var d: CGFloat = 0
            if hi > seenHi { d = hi - seenHi }
            if lo - d < seenLo { d = lo - seenLo }
            return min(max(now + d, minOff), max(minOff, maxOff))
        }
        let inset = scroll.adjustedContentInset
        let o = scroll.contentOffset
        let x = axis(rect.minX, rect.maxX, seen.minX, seen.maxX, o.x, -inset.left,
                     scroll.contentSize.width - scroll.bounds.width + inset.right)
        let y = axis(rect.minY, rect.maxY, seen.minY, seen.maxY, o.y, -inset.top,
                     scroll.contentSize.height - scroll.bounds.height + inset.bottom)
        return CGPoint(x: x, y: y)
    }
}

struct ZnFieldBoxTap: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        if s.type == Registry.Component.textField {
            // Inside pointerEvents "none" the box takes no taps, and a Pressable around it doesn't yield to it.
            content.contentShape(Rectangle()).onTapGesture { if !touchOff { ZnFieldFocus.focus(inst, s.index) } }
                .background(ZnFieldBoxMarker(key: ZnFieldFocus.key(inst, s.index), off: touchOff))
        } else {
            content
        }
    }
}

/// An empty UIView the size of a field's box: where the box is, for scrolling it into view (ZnFieldFocus.reveal).
struct ZnFieldBoxMarker: UIViewRepresentable {
    let key: String
    var off = false

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        ZnFieldFocus.registerBox(v, key)
        return v
    }

    func updateUIView(_ v: UIView, context: Context) {
        v.isHidden = off  // hidden boxes are left out of ZnFieldFocus.boxes(at:)
        ZnFieldFocus.registerBox(v, key)
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
    let look: ZnFieldLook

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UITextField {
        let f = UITextField()
        f.delegate = context.coordinator
        f.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        f.setContentHuggingPriority(.defaultLow, for: .horizontal)
        f.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        ZnFieldFocus.register(f, inst, s.index)
        if s.ref != 0 { ZnKeyboard.attach(f, inst.id, s.ref) }
        if s.autoFocus && look.editable { DispatchQueue.main.async { f.becomeFirstResponder() } }
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
        c.focusChanged = { [ctx, inst, s] focused in if s.ref != 0 { ctx.send(inst.id, s.ref, .bool(focused)) } }
        c.s = s
        c.state = state
        // editable={false}: no focus, no keyboard, no typing (React Native on iOS sets enabled = NO). One that turns
        // read-only while focused closes its keyboard; onBlur then goes as when focus is lost on Android.
        c.editable = look.editable
        if !look.editable && f.isFirstResponder { f.resignFirstResponder() }
        // Only on a change: setting them again relays the field out.
        if f.placeholder != look.placeholder { f.placeholder = look.placeholder.isEmpty ? nil : look.placeholder }
        f.font = .systemFont(ofSize: s.fontSize, weight: znUIWeight(s.fontWeight))
        let color = UIColor(look.color)
        if f.textColor != color { f.textColor = color }
        f.isSecureTextEntry = s.secure
        f.keyboardType = znKeyboard(s.keyboardType)
        // The keyboard's autofill (the user's own phone number, email, an SMS code). Only when it changes: setting it
        // while focused reloads the keyboard's suggestions.
        let hint = znContentType(s.autoComplete)
        if f.textContentType != hint { f.textContentType = hint }
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
        /// A `<TextField ref>`'s focus, for its handle's isFocused().
        var focusChanged: (Bool) -> Void = { _ in }
        var lastRaw: ZnValue?
        var s: ZnNodeSpec?
        var state: ZnFieldState?
        var editable = true

        @objc func changed(_ f: UITextField) {
            guard let s, let state, s.onChangeText != 0 else { return }
            if f.markedTextRange != nil { return }  // an IME is composing: send when it commits
            state.seq += 1
            print("zn t=\(ZnDebug.ms()) field: typed → JS \"\(f.text ?? "")\" (change \(state.seq))")
            send(s.onChangeText, "\(state.seq)\u{1}\(f.text ?? "")")
        }

        func textFieldShouldBeginEditing(_ f: UITextField) -> Bool { editable }

        func textField(_ f: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
            guard editable else { return false }  // a paste or autofill that still arrives
            guard let max = s?.maxLength else { return true }
            let current = f.text ?? ""
            if let phone = znNationalPhone(s, current: current, range: range, insert: string) {
                print("zn t=\(ZnDebug.ms()) field: a phone number suggestion of \(string.count) characters, kept its last \(phone.count) digits")
                f.text = phone
                let end = f.endOfDocument
                f.selectedTextRange = f.textRange(from: end, to: end)
                changed(f)  // setting text by code sends no editingChanged
                return false
            }
            return (current as NSString).replacingCharacters(in: range, with: string).count <= max
        }

        func textFieldDidBeginEditing(_ f: UITextField) {
            focusChanged(true)
            ZnFieldFocus.revealSoon()
            if let s, s.onFocus != 0 { send(s.onFocus, nil) }
        }
        func textFieldDidEndEditing(_ f: UITextField) {
            focusChanged(false)
            if let s, s.onBlur != 0 { send(s.onBlur, nil) }
        }
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
    let look: ZnFieldLook
    @State private var text = ""

    var body: some View {
        let field = Group {
            if s.secure {
                SecureField(look.placeholder, text: binding)
            } else {
                TextField(look.placeholder, text: binding)
            }
        }
        field
            .font(.system(size: s.fontSize, weight: znWeight(s.fontWeight)))
            .foregroundStyle(look.color)
            .disabled(!look.editable)
            .keyboardType(znKeyboard(s.keyboardType))
            .textContentType(znContentType(s.autoComplete))
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
    let look: ZnFieldLook

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
        if s.ref != 0 { ZnKeyboard.attach(v, inst.id, s.ref) }
        if s.autoFocus && look.editable { DispatchQueue.main.async { v.becomeFirstResponder() } }
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
        c.focusChanged = { [ctx, inst, s] focused in if s.ref != 0 { ctx.send(inst.id, s.ref, .bool(focused)) } }
        c.s = s
        c.state = state
        let font = UIFont.systemFont(ofSize: s.fontSize, weight: znUIWeight(s.fontWeight))
        v.font = font
        // editable={false}: the text can still be selected and copied (the nearest to Compose's readOnly), not edited.
        // Turning it off while focused resigns, so the keyboard closes and onBlur goes.
        c.editable = look.editable
        if v.isEditable != look.editable { v.isEditable = look.editable }
        let color = UIColor(look.color)
        if v.textColor != color { v.textColor = color }
        v.keyboardType = znKeyboard(s.keyboardType)
        let hint = znContentType(s.autoComplete)
        if v.textContentType != hint { v.textContentType = hint }
        v.returnKeyType = znReturnKey(s.returnKeyType) ?? .default
        if c.placeholder?.text != look.placeholder { c.placeholder?.text = look.placeholder }
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
        /// A `<TextField ref>`'s focus, for its handle's isFocused().
        var focusChanged: (Bool) -> Void = { _ in }
        var lastRaw: ZnValue?
        var s: ZnNodeSpec?
        var state: ZnFieldState?
        var editable = true
        weak var placeholder: UILabel?

        func textViewDidChange(_ v: UITextView) {
            placeholder?.isHidden = !v.text.isEmpty
            guard let s, let state, s.onChangeText != 0, v.markedTextRange == nil else { return }
            state.seq += 1
            send(s.onChangeText, "\(state.seq)\u{1}\(v.text ?? "")")
        }

        func textView(_ v: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard let s else { return true }
            guard editable else { return false }
            if text == "\n", s.returnKeyType >= 0 {  // Return is the keyboard's action, not a new line
                if s.onSubmitEditing != 0 { send(s.onSubmitEditing, v.text) }
                v.resignFirstResponder()
                return false
            }
            guard let max = s.maxLength else { return true }
            return ((v.text ?? "") as NSString).replacingCharacters(in: range, with: text).count <= max
        }

        func textViewDidBeginEditing(_ v: UITextView) {
            focusChanged(true)
            ZnFieldFocus.revealSoon()
            if let s, s.onFocus != 0 { send(s.onFocus, nil) }
        }
        func textViewDidEndEditing(_ v: UITextView) {
            focusChanged(false)
            if let s, s.onBlur != 0 { send(s.onBlur, nil) }
        }
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

/// `autoComplete` as iOS's autofill hint (RN's textContentType; the compiler keeps autoComplete only, as on Android).
/// nil: no hint (not written, "off", or no iOS match: tel-country-code, gender).
func znContentType(_ a: Int) -> UITextContentType? {
    typealias A = Registry.AutoComplete
    switch a {
    case A.tel, A.telNational, A.telDevice: return .telephoneNumber
    case A.smsOtp: return .oneTimeCode
    case A.email: return .emailAddress
    case A.name: return .name
    case A.givenName: return .givenName
    case A.familyName: return .familyName
    case A.nameMiddle: return .middleName
    case A.username, A.usernameNew: return .username
    case A.password: return .password
    case A.newPassword: return .newPassword
    case A.postalCode: return .postalCode
    case A.streetAddress, A.postalAddress: return .fullStreetAddress
    case A.country: return .countryName
    case A.birthdateFull: return .birthdate
    default: return nil
    }
}

/// A national phone field (autoComplete "tel-national") with a maxLength: what iOS's suggestion of the user's own number
/// ("+91 98765 43210") becomes. Its digits, the last `max` of them when there are more (the country code and a leading
/// 0 go). nil for any other change, which the plain maxLength rule then decides. Only for an insert of more than one
/// character that doesn't fit as it is (a suggestion or a paste): typing one key never changes.
func znNationalPhone(_ s: ZnNodeSpec?, current: String, range: NSRange, insert: String) -> String? {
    guard let s, s.autoComplete == Registry.AutoComplete.telNational, let max = s.maxLength, insert.count > 1 else { return nil }
    let next = (current as NSString).replacingCharacters(in: range, with: insert)
    guard next.count > max else { return nil }
    let digits = next.filter(\.isASCII).filter(\.isNumber)
    return String(digits.suffix(max))
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
