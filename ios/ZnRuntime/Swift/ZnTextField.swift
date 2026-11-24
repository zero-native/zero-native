// <TextField> on iOS, both ways (i.1c). Controlled, as android/runtime's ZnTextField.kt (ARCHITECTURE §9.4): the
// native field owns the text while the user types; each change goes to JS as "n\u0001text"; JS answers
// "n\u0001value" (packages/core view.ts textInput). An answer to an older change is ignored (the user typed on); an
// answer to the newest change, or a plain value (JS set it by itself), is shown if it differs from the field.
//
// UIKit variant: UITextField. When JS changes the text (a reformat, a rejected character), the cursor keeps its
// distance from the end, so "₹1,234" → typing in the middle doesn't throw the cursor to the end; marked text (an IME
// composing) is never replaced. SwiftUI variant: TextField(text:). It has no cursor or marked-text API before iOS 18,
// so a value from JS puts the cursor at the end.
//
// As ZnTextField.kt: the placeholder in placeholderColor (#9CA3AF when not written) with the field's font;
// selectionColor tints the cursor, the selection handles and the highlight; not written, the cursor is the text
// colour, as Android's cursorBrush (selectionColor ?: color); autoCapitalize and autoCorrect as Android's
// KeyboardOptions (ZnFieldRules). iOS differences: the highlight is UIKit's lighter shade of the tint (Android: the
// colour at 30%); without selectionColor the handles and the highlight follow the text colour too (one tint on iOS;
// Android keeps its theme's there); spell checking follows autoCorrect (Android has no separate switch).
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
    /// accessibilityLabel (also from a slot); nil: VoiceOver reads the placeholder, as before.
    var label: String? = nil
    /// letterSpacing and lineHeight (also from slots), not yet scaled by the phone's text size.
    var letterSpacing: CGFloat? = nil
    var lineHeight: CGFloat? = nil
}

/// letterSpacing, textDecorationLine (with its style) and, on a multiline field, lineHeight and textAlign as UIKit text
/// attributes, as Android's field draws its text and its placeholder with the text style (ZnTextField.kt:
/// effectiveTextStyle). Sizes scaled by the phone's text size. A single line leaves lineHeight out: Compose trims it
/// off a lone line. Equatable, so a field sets them again only when they change (that lays the text out again).
struct ZnFieldExtras: Equatable {
    var kern: CGFloat?
    var line = Registry.TextDecorationLine.none
    var lineStyle = Registry.TextDecorationStyle.solid
    /// Line spacing added to the font's own line height (what lineHeight is more, as a Text's), multiline only.
    var spacing: CGFloat = 0
    /// textAlign, multiline only (a UITextField has its own textAlignment).
    var align = NSTextAlignment.natural

    @MainActor init(_ s: ZnNodeSpec, _ look: ZnFieldLook, font: UIFont, k: CGFloat, multiline: Bool, rtl: Bool) {
        kern = look.letterSpacing.map { $0 * k }
        line = s.decorationLine
        lineStyle = s.decorationStyle
        if multiline {
            spacing = look.lineHeight.map { max($0 * k - font.lineHeight, 0) } ?? 0
            align = znFieldAlign(s.textAlign, rtl: rtl)
        }
    }

    /// The attributes, each key always there (0 when not written), so one that went away is taken off again.
    var attributes: [NSAttributedString.Key: Any] {
        let pattern: NSUnderlineStyle = switch lineStyle {
        case Registry.TextDecorationStyle.dashed: .patternDash
        case Registry.TextDecorationStyle.dotted: .patternDot
        default: []
        }
        let style = NSUnderlineStyle.single.union(pattern).rawValue
        return [
            .kern: kern ?? 0,
            .underlineStyle: line == Registry.TextDecorationLine.underline ? style : 0,
            .strikethroughStyle: line == Registry.TextDecorationLine.lineThrough ? style : 0,
        ]
    }

    /// The multiline field's paragraph style: its alignment and line spacing.
    var paragraph: NSParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.alignment = align
        p.lineSpacing = spacing
        return p
    }
}

/// textAlign as UIKit's: start and end follow the layout direction, as Compose's TextAlign.Start / End (ZnTemplate.kt)
/// and a Text's .leading / .trailing; start (or not written) is left in a left-to-right layout, right in a right-to-left
/// one.
func znFieldAlign(_ textAlign: Int, rtl: Bool) -> NSTextAlignment {
    switch textAlign {
    case Registry.TextAlign.center: return .center
    case Registry.TextAlign.end: return rtl ? .left : .right
    default: return rtl ? .right : .left
    }
}

/// The field's font: fontFamily, fontWeight and italic, its size scaled by the phone's text size and capped by
/// maxFontScale (ZnTextField.kt: effectiveTextStyle). UIKit doesn't scale it again (adjustsFontForContentSizeCategory
/// stays off).
@MainActor func znFieldFont(_ s: ZnNodeSpec, _ typeSize: DynamicTypeSize) -> UIFont {
    znUIFont(s.fontFamily, size: max(s.fontSize, 0) * s.textScale(typeSize), weight: s.fontWeight, italic: s.italic)
}

/// pointerEvents "none" around the field (or a "box-only" parent): the native view takes no taps either (SwiftUI's
/// allowsHitTesting is set too; this keeps UIKit's own hit testing out as well).
@MainActor func znFieldTouch(_ v: UIView, off: Bool) {
    if v.isUserInteractionEnabled == off { v.isUserInteractionEnabled = !off }
}

/// Android's placeholder colour when the app sets none (ZnTemplate.kt placeholderColor's default).
let znPlaceholderDefault = UIColor(red: 0x9C / 255, green: 0xA3 / 255, blue: 0xAF / 255, alpha: 1)

/// The field's placeholder colour.
func znPlaceholderColor(_ s: ZnNodeSpec) -> UIColor { s.placeholderColor.map(UIColor.init) ?? znPlaceholderDefault }

extension UITextAutocapitalizationType {
    init(_ a: ZnAutocap) {
        switch a {
        case .none: self = .none
        case .sentences: self = .sentences
        case .words: self = .words
        case .characters: self = .allCharacters
        }
    }
}

/// autoCapitalize, autoCorrect and selectionColor on a UITextField or UITextView, each only when it changes (setting
/// one while focused reloads the keyboard, and only then). [textColor]: the cursor's colour when selectionColor isn't
/// written (Android's cursorBrush).
@MainActor
private func znApplyInputTraits(_ v: UIView, _ s: ZnNodeSpec, textColor: UIColor) {
    let cap = UITextAutocapitalizationType(ZnFieldRules.autocap(s.autoCapitalize, secure: s.secure, keyboardType: s.keyboardType))
    let correct: UITextAutocorrectionType = ZnFieldRules.autocorrect(s.autoCorrect, secure: s.secure) ? .default : .no
    let spell: UITextSpellCheckingType = correct == .no ? .no : .default
    var changed = false
    if let f = v as? UITextField {
        if f.autocapitalizationType != cap { f.autocapitalizationType = cap; changed = true }
        if f.autocorrectionType != correct { f.autocorrectionType = correct; changed = true }
        if f.spellCheckingType != spell { f.spellCheckingType = spell; changed = true }
    } else if let t = v as? UITextView {
        if t.autocapitalizationType != cap { t.autocapitalizationType = cap; changed = true }
        if t.autocorrectionType != correct { t.autocorrectionType = correct; changed = true }
        if t.spellCheckingType != spell { t.spellCheckingType = spell; changed = true }
    }
    if changed && v.isFirstResponder { v.reloadInputViews() }
    // Not written: the text colour (it may come from a slot), as Android's cursor; iOS blue looked out of place in a
    // branded field (ZeroBill's search bar).
    let tint = s.selectionColor.map(UIColor.init) ?? textColor
    if v.tintColor != tint { v.tintColor = tint }
}

/// editable: a slot's null counts as editable, as on Android (`!= false`).
@MainActor func znFieldLook(_ s: ZnNodeSpec, _ inst: ZnInstance) -> ZnFieldLook {
    let editable = s.editableSlot >= 0 ? inst.slot(s.editableSlot).value != .bool(false) : s.editable
    let color = s.colorSlot >= 0 ? (znColor(inst.slot(s.colorSlot).value) ?? .black) : (s.color ?? .black)
    let placeholder = s.placeholderSlot >= 0 ? znDisplay(inst.slot(s.placeholderSlot).value) : (s.placeholder ?? "")
    return ZnFieldLook(editable: editable, color: color, placeholder: placeholder, label: s.accessibilityLabelNow(inst),
                       letterSpacing: s.letterSpacingNow(inst), lineHeight: s.lineHeightNow(inst))
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
    final class WeakView {
        weak var view: UIView?
        /// A field of a List row JS hasn't mounted yet (a placeholder of its template): its events go nowhere.
        let placeholder: Bool
        /// A box's: the Pressables it is drawn inside (znPressAncestors, ZnTouchControl.hitTest).
        var ancestors: Set<ObjectIdentifier> = []
        init(_ v: UIView, placeholder: Bool = false) { view = v; self.placeholder = placeholder }
    }

    static func key(_ inst: ZnInstance, _ node: Int) -> String { "\(ObjectIdentifier(inst).hashValue):\(node)" }
    /// [v] under its instance; an older key of the same view (its row's placeholder) goes.
    static func register(_ v: UIView, _ inst: ZnInstance, _ node: Int) {
        views = views.filter { $0.value.view != nil && $0.value.view !== v }
        views[key(inst, node)] = WeakView(v, placeholder: inst.id == 0)
    }
    static func registerBox(_ v: UIView, _ key: String, ancestors: [ObjectIdentifier] = []) {
        boxes = boxes.filter { $0.value.view != nil }
        let w = WeakView(v)
        w.ancestors = Set(ancestors)
        boxes[key] = w
    }
    /// The boxes of the fields in [window] under [point] (window coordinates), with the view controller each is in: a
    /// Pressable around a field leaves the touch to it (ZnTouchControl.hitTest). A tappable Text with span links puts
    /// its frame here too ("text:" keys, ZnTextLinkPress), and so does a Switch or Checkbox ("toggle:", ZnToggleTap).
    /// A box counts only where it shows: one scrolled out of its Scroll or List (clipped there), or on a hidden tab (its
    /// marker hides), took the taps of the Pressables drawn there instead (a fixed Pay button over a form's next fields;
    /// a card on one tab where another tab's search field was; 2026-11-24). With its view and the Pressables it is
    /// inside, so a Pressable leaves the touch only to a box inside it or drawn over it (ZnTouchControl.hitTest).
    static func boxes(at point: CGPoint, in window: UIWindow)
        -> [(frame: CGRect, controller: UIViewController?, view: UIView, ancestors: Set<ObjectIdentifier>)] {
        boxes.values.compactMap { w in
            guard let v = w.view, v.window === window, !v.isHidden, znShows(v, v.bounds, at: point, upTo: nil) else { return nil }
            return (v.convert(v.bounds, to: window), znNearestController(v), v, w.ancestors)
        }
    }

    static func focus(_ inst: ZnInstance, _ node: Int) {
        guard let v = views[key(inst, node)]?.view, !v.isFirstResponder else { return }
        v.becomeFirstResponder()
    }

    /// returnKeyType "next": focuses the field after [field] on its screen, as Compose's default for ImeAction.Next
    /// (focus moves on and the keyboard stays up). After means in reading order: the next line down, or further on
    /// (right, left in a right-to-left layout) on the same line. Inside a List it is row order, as Compose's focus
    /// search goes by the order of the items: n1 → n2 → n3 also in an inverted List (n1 at the bottom, the next one
    /// above it) and in a sideways List in a right-to-left layout (the next one to the left); a List counts as one
    /// block where it lies among the fields around it (ZnFieldOrder). Fields iOS can't focus are passed over: not
    /// editable, under pointerEvents "none", on a hidden tab (Compose can still focus a readOnly or untouchable field:
    /// iOS only, as a read-only one-line field takes no focus here, decision 1). A List row's field goes on to its
    /// List's next rows first, also those past its edge (nextRow). False when there is none: the keyboard then closes,
    /// as before.
    static func focusNext(after field: UIView) -> Bool { focusNext(after: field, rowsOn: 0, waits: 0) }

    private static func focusNext(after field: UIView, rowsOn: Int, waits: Int) -> Bool {
        guard let window = field.window else { return false }
        let screen = znNearestController(field)
        let order = ZnFieldOrder(window: window, rtl: field.effectiveUserInterfaceLayoutDirection == .rightToLeft)
        guard let me = order.key(field) else { return false }
        let after = views.compactMap { (key, w) -> (UIView, [ZnFieldOrder.Step], Bool)? in
            guard let v = w.view, v !== field, v.window === window, !hiddenUp(v), v.isUserInteractionEnabled,
                  boxes[key]?.view?.isHidden != true, znNearestController(v) === screen else { return nil }
            if let t = v as? UITextView, !t.isEditable { return nil }
            guard let k = order.key(v), order.before(me, k) else { return nil }
            return (v, k, w.placeholder)
        }.sorted { order.before($0.1, $1.1) }
        // A field that says no (editable={false} refuses in textFieldShouldBeginEditing): the one after it.
        func take(_ list: [(UIView, [ZnFieldOrder.Step], Bool)]) -> Bool {
            for (v, _, placeholder) in list where !placeholder && v.becomeFirstResponder() {
                print("zn t=\(ZnDebug.ms()) field: next → the field at y \(Int(v.convert(v.bounds, to: window).minY))")
                return true
            }
            return false
        }
        // In a List, its own rows come first, also those not made yet (nextRow), before a field after the List.
        if let row = listRow(of: field) {
            let mine = after.filter { $0.0.isDescendant(of: row.list) }
            // The next row is a placeholder (JS mounts it a moment after it shows): wait for it, up to a second.
            if let first = mine.first, first.2, waits < 20 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    guard field.isFirstResponder else { return }  // the user moved on meanwhile
                    if !focusNext(after: field, rowsOn: rowsOn, waits: waits + 1) { field.resignFirstResponder() }
                }
                return true
            }
            if take(mine) { return true }
            if nextRow(after: field, in: row, rowsOn: rowsOn) { return true }
            return take(after.filter { !$0.0.isDescendant(of: row.list) })
        }
        return take(after)
    }

    /// [v] or a view it is in is hidden. A List keeps a row it made ahead, past its edge, in a hidden cell (seen
    /// 2026-11-24: s4 in checksLab g): a field there refuses focus, but asking it took the focus from the field
    /// before, and the keyboard closed. Such a row is shown first (nextRow), then focused.
    private static func hiddenUp(_ v: UIView) -> Bool {
        var a: UIView? = v
        while let x = a {
            if x.isHidden { return true }
            a = x.superview
        }
        return false
    }

    /// The List (UIKit variant) [field] is in, and the index path of its row there.
    private static func listRow(of field: UIView) -> (list: ZnListCollectionView, at: IndexPath)? {
        var cell: UICollectionViewCell?
        var v = field.superview
        while let sv = v, !(sv is ZnListCollectionView) {
            if let c = sv as? UICollectionViewCell { cell = c }
            v = sv.superview
        }
        guard let list = v as? ZnListCollectionView, let cell, let at = list.indexPath(for: cell) else { return nil }
        return (list, at)
    }

    /// A field in a List row with no field after it among the rows that show: the rows after it aren't made yet (a
    /// UICollectionView makes only the rows that show). Compose's LazyColumn lays out the next item for a focus search
    /// and moves focus into it, so this shows the next row (the least scroll) and looks again, a row at a time, up to 5
    /// rows on; then a field after the List; none: the keyboard closes. The keyboard stays up meanwhile. False: no row
    /// left to show.
    private static func nextRow(after field: UIView, in row: (list: ZnListCollectionView, at: IndexPath),
                                rowsOn: Int) -> Bool {
        guard rowsOn < 5 else { return false }
        let cv = row.list
        // Every item in order (header, rows, footer: one section each). The next is the next item also in an inverted
        // or right-to-left list (row order): only where it shows differs, and scrolling to its frame covers that.
        let all = (0..<cv.numberOfSections).flatMap { sec in
            (0..<cv.numberOfItems(inSection: sec)).map { IndexPath(item: $0, section: sec) }
        }
        guard let i = all.firstIndex(of: row.at), all.indices.contains(i + rowsOn + 1) else { return false }
        let next = all[i + rowsOn + 1]
        if let frame = cv.layoutAttributesForItem(at: next)?.frame {
            cv.scrollRectToVisible(frame, animated: false)  // the least scroll, whichever side it is on
        } else {
            cv.scrollToItem(at: next, at: [], animated: false)
        }
        cv.layoutIfNeeded()
        print("zn t=\(ZnDebug.ms()) field: next → showing list row \(next.item) (section \(next.section)) to look there")
        // A row just made draws its SwiftUI (and so its field) a frame or two later: look once its cell has a field,
        // or after about a quarter second (a row with no field; seen 2026-11-24: looking at once missed s4 and the
        // keyboard closed).
        func look(_ tries: Int) {
            guard field.isFirstResponder else { return }  // the user moved on meanwhile
            if tries < 8, let cell = cv.cellForItem(at: next),
               !views.values.contains(where: { $0.view?.isDescendant(of: cell) == true }) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { look(tries + 1) }
                return
            }
            if !focusNext(after: field, rowsOn: rowsOn + 1, waits: 0) { field.resignFirstResponder() }
        }
        DispatchQueue.main.async { look(0) }
        return true
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
/// Hidden under pointerEvents "none" ([off]) and on a kept, hidden tab (znInHiddenTab, as a Pressable's touch view):
/// hidden boxes take no Pressable's taps (ZnFieldFocus.boxes) and their fields get no "next" focus.
struct ZnFieldBoxMarker: UIViewRepresentable {
    let key: String
    var off = false

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        // Only a place: not in the accessibility tree, where it lay over the field (a UI test's isHittable was false
        // for a multiline field under its box).
        v.accessibilityElementsHidden = true
        ZnFieldFocus.registerBox(v, key)
        return v
    }

    func updateUIView(_ v: UIView, context: Context) {
        let hidden = off || context.environment.znInHiddenTab
        if v.isHidden != hidden { v.isHidden = hidden }  // hidden boxes are left out of ZnFieldFocus.boxes(at:)
        ZnFieldFocus.registerBox(v, key, ancestors: context.environment.znPressAncestors)
    }
}

/// Registers a field's native view for focus (ZnFieldFocus) and for its ref's calls (ZnKeyboard) under [inst], and again
/// when the view moves to another instance: a List row first drawn as a placeholder of its template, then mounted by
/// JS, keeps its native view, which stayed registered under the placeholder (2026-11-24: "next" focused such a row
/// and its onFocus went nowhere; its ref's focus() found nothing).
@MainActor func znFieldRegister(_ v: UIView, _ inst: ZnInstance, _ s: ZnNodeSpec, last: inout ObjectIdentifier?) {
    let id = ObjectIdentifier(inst)
    guard last != id else { return }
    last = id
    ZnFieldFocus.register(v, inst, s.index)
    if s.ref != 0 { ZnKeyboard.attach(v, inst.id, s.ref) }
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
        znFieldRegister(f, inst, s, last: &context.coordinator.registered)
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
        znFieldRegister(f, inst, s, last: &c.registered)
        c.send = { [ctx, inst, s] event, text in ctx.send(inst.id, event, text.map(ZnPayload.string) ?? .none) }
        c.focusChanged = { [ctx, inst, s] focused in if s.ref != 0 { ctx.send(inst.id, s.ref, .bool(focused)) } }
        c.s = s
        c.state = state
        // editable={false}: no focus, no keyboard, no typing (React Native on iOS sets enabled = NO). One that turns
        // read-only while focused closes its keyboard; onBlur then goes as when focus is lost on Android.
        c.editable = look.editable
        // After this update: resigning sends onBlur, and JS's answer must not change state while SwiftUI updates.
        if !look.editable && f.isFirstResponder {
            DispatchQueue.main.async { if !c.editable && f.isFirstResponder { f.resignFirstResponder() } }
        }
        let font = znFieldFont(s, context.environment.dynamicTypeSize)
        // A new font (the phone's text size changed): SwiftUI measures the field again (sizeThatFits).
        if f.font != font { f.font = font; f.invalidateIntrinsicContentSize() }
        znFieldTouch(f, off: context.environment.znTouchOff)
        znApplyA11y(f, s, label: look.label)
        let extras = ZnFieldExtras(s, look, font: font, k: s.textScale(context.environment.dynamicTypeSize), multiline: false,
                                   rtl: context.environment.layoutDirection == .rightToLeft)
        // Only on a change: setting it again relays the field out (an empty placeholder is nil). In placeholderColor
        // and the field's font, letterSpacing and decoration, as Android draws it with the field's text style.
        let placeholder = look.placeholder.isEmpty ? nil : look.placeholder
        let pColor = znPlaceholderColor(s)
        if c.placeholder?.0 != placeholder || c.placeholder?.1 != pColor || c.placeholder?.2 != font || c.placeholder?.3 != extras {
            c.placeholder = (placeholder, pColor, font, extras)
            f.attributedPlaceholder = placeholder.map {
                NSAttributedString(string: $0, attributes: extras.attributes.merging([.foregroundColor: pColor, .font: font]) { $1 })
            }
        }
        let color = UIColor(look.color)
        if f.textColor != color { f.textColor = color }
        // letterSpacing and textDecorationLine on the typed text (the field's default attributes: every character).
        if c.extras != extras {
            c.extras = extras
            f.defaultTextAttributes.merge(extras.attributes) { $1 }
        }
        f.isSecureTextEntry = s.secure
        f.keyboardType = znKeyboard(s.keyboardType)
        znApplyInputTraits(f, s, textColor: color)
        // The keyboard's autofill (the user's own phone number, email, an SMS code). Only when it changes: setting it
        // while focused reloads the keyboard's suggestions.
        let hint = znContentType(s.autoComplete)
        if f.textContentType != hint { f.textContentType = hint }
        f.returnKeyType = znReturnKey(s.returnKeyType) ?? .done
        let align = znFieldAlign(s.textAlign, rtl: context.environment.layoutDirection == .rightToLeft)
        if f.textAlignment != align { f.textAlignment = align }

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
        c.apply(value, to: f)
        if let p = f.position(from: f.endOfDocument, offset: -min(fromEnd, value.count)) {
            f.selectedTextRange = f.textRange(from: p, to: p)
        }
    }

    final class Coordinator: NSObject, UITextFieldDelegate {
        /// The instance the view is registered under (znFieldRegister).
        var registered: ObjectIdentifier?
        var send: (Int, String?) -> Void = { _, _ in }
        /// A `<TextField ref>`'s focus, for its handle's isFocused().
        var focusChanged: (Bool) -> Void = { _ in }
        var lastRaw: ZnValue?
        var s: ZnNodeSpec?
        var state: ZnFieldState?
        var editable = true
        /// The placeholder last set: text, colour, font, letterSpacing and decoration.
        var placeholder: (String?, UIColor, UIFont, ZnFieldExtras)?
        /// letterSpacing and decoration last set on the text.
        var extras: ZnFieldExtras?
        /// JS's value is going in (apply): the editingChanged it sends isn't the user's.
        private var applying = false

        /// JS's [value] into [f] through the text input system (UITextInput's replace), not `f.text =`: a key the
        /// keyboard had queued while the text was set from outside was lost (A93: typing 1234567 fast into a field JS
        /// regroups gave "1,23,456"). replace doesn't ask shouldChangeCharactersIn, so editable, maxLength and the
        /// phone rule don't apply to JS's value (as with `f.text =`). Only while the user can type (focused and
        /// editable): keys queue only then; otherwise `f.text =` as before. Undo: as `f.text =` did, nothing is left to
        /// undo after JS's value (the field's undo history is cleared). Kept, one undo would take back only JS's
        /// regroup, JS would regroup again at once, and undo would seem to do nothing. The undo manager is the field's
        /// own while it edits (UIKit's text undo manager, not the window's: seen 2026-11-24), so only its typing goes.
        func apply(_ value: String, to f: UITextField) {
            guard editable, f.isFirstResponder, let all = f.textRange(from: f.beginningOfDocument, to: f.endOfDocument)
            else { f.text = value; return }
            applying = true
            f.replace(all, withText: value)
            applying = false
            f.undoManager?.removeAllActions()
        }

        @objc func changed(_ f: UITextField) {
            if applying { return }
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
            // "next": the next field takes focus and the keyboard stays up (it went down and, when JS focused the next
            // field in onSubmitEditing, up again: a bounce). Any other key, or no next field: the keyboard closes.
            if s?.returnKeyType == Registry.ReturnKeyType.next, ZnFieldFocus.focusNext(after: f) { return true }
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let prompt = Text(look.placeholder).foregroundStyle(Color(znPlaceholderColor(s)))
        let field = Group {
            // The placeholder is the label too (VoiceOver reads it), the prompt its coloured look.
            if s.secure {
                SecureField(look.placeholder, text: binding, prompt: prompt)
            } else {
                TextField(look.placeholder, text: binding, prompt: prompt)
            }
        }
        let cap: TextInputAutocapitalization = switch ZnFieldRules.autocap(s.autoCapitalize, secure: s.secure, keyboardType: s.keyboardType) {
        case .none: .never
        case .sentences: .sentences
        case .words: .words
        case .characters: .characters
        }
        let pattern: Text.LineStyle.Pattern = s.decorationStyle == Registry.TextDecorationStyle.dashed ? .dash
            : s.decorationStyle == Registry.TextDecorationStyle.dotted ? .dot : .solid
        field
            .font(znFont(s.fontFamily, size: max(s.fontSize, 0) * s.textScale(typeSize), weight: s.fontWeight, italic: s.italic))
            .kerning((look.letterSpacing ?? 0) * s.textScale(typeSize))
            .underline(s.decorationLine == Registry.TextDecorationLine.underline, pattern: pattern)
            .strikethrough(s.decorationLine == Registry.TextDecorationLine.lineThrough, pattern: pattern)
            .foregroundStyle(look.color)
            .znFieldA11y(s, label: look.label)
            .tint(s.selectionColor ?? look.color)  // the cursor: the text colour when not written, as Android
            .textInputAutocapitalization(cap)
            .autocorrectionDisabled(!ZnFieldRules.autocorrect(s.autoCorrect, secure: s.secure))
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

/// A multiline field's UITextView. It scrolls only while its text is taller than its box (maxHeight, a height, all its
/// parent has), as Compose's BasicTextField under a max height: before, it never scrolled and its lower lines drew over
/// the views below the box (ZeroBill's review box and chat input, 2026-11-24). While it fits, scrolling stays off, so
/// a drag on it scrolls the screen and the field grows with its text.
final class ZnFieldTextView: UITextView {
    /// The size the scroll was last decided for; nil: decide again (the text changed).
    private var checked: CGSize?

    override func layoutSubviews() {
        super.layoutSubviews()
        // layoutSubviews runs on every frame of a scroll too: decide only for a new size or new text.
        if checked != bounds.size { znCheckScroll() }
    }

    /// The text changed: decide again at the next layout.
    func znTextChanged() {
        checked = nil
        setNeedsLayout()
    }

    private func znCheckScroll() {
        guard bounds.width > 0, bounds.height > 0 else { return }
        checked = bounds.size
        let fit = sizeThatFits(CGSize(width: bounds.width, height: .greatestFiniteMagnitude)).height
        let scrolls = fit > bounds.height + 0.5
        guard scrolls != isScrollEnabled else { return }
        isScrollEnabled = scrolls
        if scrolls {
            // The cursor stays in sight, as Compose keeps it (typing at the end scrolls on by itself).
            DispatchQueue.main.async { [weak self] in
                guard let self, self.isFirstResponder else { return }
                self.scrollRangeToVisible(self.selectedRange)
            }
        } else if contentOffset != .zero {
            contentOffset = .zero
        }
    }
}

/// A multiline <TextField>: same protocol as the single-line one. Return makes a new line, unless the field sets
/// returnKeyType: then Return is the keyboard's action and sends onSubmitEditing (as on Android), and "next" moves to
/// the next field. It grows with its text; minHeight / height from the style still apply, and at maxHeight (or the
/// height it is offered) it stops growing and scrolls inside (ZnFieldTextView).
struct ZnUIKitTextView: UIViewRepresentable {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let state: ZnFieldState
    let raw: ZnValue
    let look: ZnFieldLook

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ZnFieldTextView {
        let v = ZnFieldTextView()
        v.delegate = context.coordinator
        v.backgroundColor = .clear
        v.textContainerInset = .zero
        v.textContainer.lineFragmentPadding = 0
        v.isScrollEnabled = false  // grows with its text (scrolls when it is taller than its box: ZnFieldTextView)
        let placeholder = UILabel()
        placeholder.numberOfLines = 0
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(placeholder)
        // To the text view's frame, not its content: an empty one's content is 0 wide, and in a right-to-left layout
        // its leading edge is the content's right edge, so the placeholder drew left of the field (2026-11-24).
        NSLayoutConstraint.activate([
            placeholder.topAnchor.constraint(equalTo: v.frameLayoutGuide.topAnchor),
            placeholder.leadingAnchor.constraint(equalTo: v.frameLayoutGuide.leadingAnchor),
            placeholder.widthAnchor.constraint(equalTo: v.frameLayoutGuide.widthAnchor),
        ])
        context.coordinator.placeholder = placeholder
        znFieldRegister(v, inst, s, last: &context.coordinator.registered)
        if s.autoFocus && look.editable { DispatchQueue.main.async { v.becomeFirstResponder() } }
        return v
    }

    /// Its text's height, but no more than the height offered (maxHeight caps the offer: ZnMinMaxLayout), never less
    /// than one line. Taller text then scrolls inside (ZnFieldTextView).
    func sizeThatFits(_ proposal: ProposedViewSize, uiView v: ZnFieldTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 200
        let fit = v.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = v.font?.lineHeight ?? 17
        var height = max(fit.height, line)
        if let offered = proposal.height, offered.isFinite, offered < height { height = max(offered, line) }
        return CGSize(width: width, height: height)
    }

    func updateUIView(_ v: ZnFieldTextView, context: Context) {
        let c = context.coordinator
        znFieldRegister(v, inst, s, last: &c.registered)
        c.send = { [ctx, inst] event, text in ctx.send(inst.id, event, text.map(ZnPayload.string) ?? .none) }
        c.focusChanged = { [ctx, inst, s] focused in if s.ref != 0 { ctx.send(inst.id, s.ref, .bool(focused)) } }
        c.s = s
        c.state = state
        let font = znFieldFont(s, context.environment.dynamicTypeSize)
        // A new font (the phone's text size changed): SwiftUI measures the field again (sizeThatFits).
        if v.font != font { v.font = font; v.invalidateIntrinsicContentSize() }
        znFieldTouch(v, off: context.environment.znTouchOff)
        znApplyA11y(v, s, label: look.label)
        // editable={false}: the text can still be selected and copied (the nearest to Compose's readOnly), not edited.
        // Turning it off while focused resigns (after this update, as the one-line field), so the keyboard closes and
        // onBlur goes: a UITextView that isn't editable can stay first responder. Only on that change: one that is
        // read-only already keeps the selection the user is making.
        c.editable = look.editable
        let turnedOff = v.isEditable && !look.editable
        if v.isEditable != look.editable { v.isEditable = look.editable }
        if turnedOff && v.isFirstResponder {
            DispatchQueue.main.async { if !c.editable && v.isFirstResponder { v.resignFirstResponder() } }
        }
        let color = UIColor(look.color)
        if v.textColor != color { v.textColor = color }
        v.keyboardType = znKeyboard(s.keyboardType)
        znApplyInputTraits(v, s, textColor: color)
        let hint = znContentType(s.autoComplete)
        if v.textContentType != hint { v.textContentType = hint }
        v.returnKeyType = znReturnKey(s.returnKeyType) ?? .default
        // letterSpacing, decoration, lineHeight and textAlign, on the text and the placeholder (as Android's style).
        let extras = ZnFieldExtras(s, look, font: font, k: s.textScale(context.environment.dynamicTypeSize), multiline: true,
                                   rtl: context.environment.layoutDirection == .rightToLeft)
        let pColor = znPlaceholderColor(s)
        if c.placeholderLook?.0 != look.placeholder || c.placeholderLook?.1 != font || c.placeholderLook?.2 != pColor
            || c.placeholderLook?.3 != extras {
            c.placeholderLook = (look.placeholder, font, pColor, extras)
            c.placeholder?.attributedText = NSAttributedString(string: look.placeholder, attributes: extras.attributes.merging(
                [.font: font, .foregroundColor: pColor, .paragraphStyle: extras.paragraph]) { $1 })
        }
        if c.extras != extras {
            c.extras = extras
            c.applyExtras(v)
            v.invalidateIntrinsicContentSize()  // line spacing changes the height
            v.znTextChanged()
        }
        defer { c.placeholder?.isHidden = !v.text.isEmpty }

        guard raw != c.lastRaw else { return }
        c.lastRaw = raw
        let (answers, value) = znFieldValue(raw)
        if let n = answers, n != state.seq { return }
        guard value != v.text, v.markedTextRange == nil else { return }
        let fromEnd = v.selectedTextRange.map { v.offset(from: $0.end, to: v.endOfDocument) } ?? 0
        c.apply(value, to: v)
        c.applyExtras(v)  // a new text has only the font and colour
        v.invalidateIntrinsicContentSize()
        v.znTextChanged()
        if let p = v.position(from: v.endOfDocument, offset: -min(fromEnd, value.count)) {
            v.selectedTextRange = v.textRange(from: p, to: p)
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        /// The instance the view is registered under (znFieldRegister).
        var registered: ObjectIdentifier?
        var send: (Int, String?) -> Void = { _, _ in }
        /// A `<TextField ref>`'s focus, for its handle's isFocused().
        var focusChanged: (Bool) -> Void = { _ in }
        var lastRaw: ZnValue?
        var s: ZnNodeSpec?
        var state: ZnFieldState?
        var editable = true
        weak var placeholder: UILabel?
        /// The placeholder's look last set: text, font, colour, letterSpacing and the rest.
        var placeholderLook: (String, UIFont, UIColor, ZnFieldExtras)?
        /// letterSpacing, decoration, lineHeight and textAlign last set.
        var extras: ZnFieldExtras?

        /// [extras] on every character and on what is typed next. Not while an IME composes (its marked text).
        func applyExtras(_ v: UITextView) {
            guard let extras, v.markedTextRange == nil else { return }
            let a = extras.attributes.merging([.paragraphStyle: extras.paragraph]) { $1 }
            if v.textStorage.length > 0 { v.textStorage.addAttributes(a, range: NSRange(location: 0, length: v.textStorage.length)) }
            v.typingAttributes.merge(a) { $1 }
        }

        /// JS's value is going in (apply): the textViewDidChange it sends isn't the user's.
        private var applying = false

        /// JS's [value] into [v] through UITextInput's replace, as the one-line field (A93): with `v.text =` keys typed
        /// meanwhile landed before the last character (1234567 fast gave 12,35,674). shouldChangeTextIn isn't asked
        /// (editable and maxLength don't apply to JS's value, as before). Only while focused and editable, and the
        /// undo history is then cleared, as the one-line field's apply says why.
        func apply(_ value: String, to v: UITextView) {
            guard v.isEditable, v.isFirstResponder, let all = v.textRange(from: v.beginningOfDocument, to: v.endOfDocument)
            else { v.text = value; return }
            applying = true
            v.replace(all, withText: value)
            applying = false
            v.undoManager?.removeAllActions()
        }

        func textViewDidChange(_ v: UITextView) {
            if applying { return }
            placeholder?.isHidden = !v.text.isEmpty
            (v as? ZnFieldTextView)?.znTextChanged()
            // UIKit's typing attributes go back to the font and colour when the text is emptied.
            if v.text.isEmpty { applyExtras(v) }
            // Scrolling on, a UITextView no longer tells SwiftUI that its height changed: measure it again.
            v.invalidateIntrinsicContentSize()
            guard let s, let state, s.onChangeText != 0, v.markedTextRange == nil else { return }
            state.seq += 1
            send(s.onChangeText, "\(state.seq)\u{1}\(v.text ?? "")")
        }

        func textView(_ v: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard let s else { return true }
            guard editable else { return false }
            if text == "\n", s.returnKeyType >= 0 {  // Return is the keyboard's action, not a new line
                if s.onSubmitEditing != 0 { send(s.onSubmitEditing, v.text) }
                // "next": the next field takes focus and the keyboard stays up, as the one-line field.
                if s.returnKeyType == Registry.ReturnKeyType.next, ZnFieldFocus.focusNext(after: v) { return false }
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

/// The order "next" goes in (ZnFieldFocus.focusNext). A field's key is the path down to it: the outermost List
/// (UIKit variant) it is in, its row's index path there, then the next List inside that row, and so on, and last the
/// field. Two keys compare at the first step where they part: Lists and fields by where they lie on the screen
/// (reading order: a higher line first, then left to right, right to left in a right-to-left layout), rows of one
/// List by their index path (row order, as Compose's focus search: the same in an inverted or right-to-left List).
@MainActor
struct ZnFieldOrder {
    enum Step {
        /// A List or the field, at [frame] in the window.
        case block(ObjectIdentifier, CGRect)
        /// A row of the List before.
        case row(IndexPath)
    }
    let window: UIWindow
    let rtl: Bool

    /// nil: in a List row UIKit has no index path for (a cell going away).
    func key(_ field: UIView) -> [Step]? {
        var steps: [Step] = []
        // The cell passed last on the way up since the last List: that List's own cell for the row (as listRow; not
        // only the List's direct subview, in case UIKit puts a view between them).
        var cell: UICollectionViewCell?
        var v = field.superview
        var inner: UIView = field  // the block found last (a List, or the field to begin with)
        while let sv = v {
            if let list = sv as? ZnListCollectionView {
                guard let c = cell, let ip = list.indexPath(for: c) else { return nil }
                steps = [.row(ip), block(inner)] + steps
                inner = list
                cell = nil
            } else if let c = sv as? UICollectionViewCell {
                cell = c
            }
            v = sv.superview
        }
        return [block(inner)] + steps
    }

    private func block(_ v: UIView) -> Step { .block(ObjectIdentifier(v), v.convert(v.bounds, to: window)) }

    /// a before b: a higher line, or the same line (their middles within half the smaller height) and further on.
    func before(_ a: CGRect, _ b: CGRect) -> Bool {
        guard abs(a.midY - b.midY) < min(a.height, b.height) / 2 else { return a.midY < b.midY }
        return rtl ? a.maxX > b.maxX : a.minX < b.minX
    }

    func before(_ a: [Step], _ b: [Step]) -> Bool {
        for (x, y) in zip(a, b) {
            switch (x, y) {
            case let (.block(i, f), .block(j, g)):
                if i != j { return before(f, g) }
            case let (.row(p), .row(q)):
                if p != q { return p < q }
            default:
                return false  // can't happen: both paths go block, row, block, ...
            }
        }
        return false
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

/// fontWeight as UIKit's, the same steps as znWeight (SwiftUI's), so a field and a Text draw one weight alike.
func znUIWeight(_ w: Int?) -> UIFont.Weight {
    switch w ?? 400 {
    case ..<150: return .ultraLight
    case ..<250: return .thin
    case ..<350: return .light
    case ..<450: return .regular
    case ..<550: return .medium
    case ..<650: return .semibold
    case ..<750: return .bold
    case ..<850: return .heavy
    default: return .black
    }
}
