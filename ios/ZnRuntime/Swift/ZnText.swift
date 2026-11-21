// <Text> on iOS, as android/runtime's ZnRenderer.kt TEXT branch: the text (template or slot), textTransform, colour,
// size, weight, italic, letterSpacing, lineHeight, alignment, numberOfLines (with "…"), textDecorationLine with
// textDecorationStyle (solid, dashed, dotted: SwiftUI's own line patterns, where Android draws its own dashes), and
// nested <Text> spans (registry 16): one style per piece, the pieces joined by U+001F (compile.ts `textChildren`),
// static in the template or JSON in a slot when they change at runtime. A span with onPress is a link; a tap sends
// onSpanPress with its index.
// fontSize, lineHeight and letterSpacing may come from slots (registry 23): read here, so a change redraws this Text alone.
// A top-level onPress / onLongPress (registry 23) makes the text a button, as Android's clickable Text: no press
// feedback, the touch area the text inside its padding, nothing under pointerEvents "none".
// selectable (registry 23, or its slot): a long press shows iOS's Copy / Share menu for the whole text (SwiftUI's
// textSelection, as React Native on iOS). A Text with onPress / onLongPress keeps its own taps (no menu).
// adjustsFontSizeToFit with numberOfLines (registry 23): the text shrinks to fit its box in those lines, down to
// minimumFontScale (0.5 when not written, kept within 0.01...1), then ends in "…", as Android's TextAutoSize.
// iOS differences: includeFontPadding is Android-only (ignored). lineHeight adds the difference to the font's own
// line height as line spacing (RN on iOS places the extra space differently: above each line). selectable copies the
// whole text: SwiftUI's Text can't select a range on iOS (Android shows handles for a range). Auto-fit shrinks
// smoothly, not in Android's 0.5 sp steps.
import SwiftUI
import UIKit

/// One span's style (parseSpans in ZnTemplate.kt). Absent values: the parent's.
struct ZnSpan: Equatable {
    var color: Color?
    var fontSize: CGFloat?
    var fontWeight: Int?
    var italic: Bool?
    var decorationLine: Int?
    var letterSpacing: CGFloat?
    var background: Color?
    var pressable = false

    static func parse(_ json: String) -> [ZnSpan]? {
        guard let data = json.data(using: .utf8),
              let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return nil }
        return list.map { o in
            func num(_ k: String) -> Double? { (o[k] as? NSNumber)?.doubleValue }
            func argb(_ k: String) -> Color? { num(k).flatMap { znColor(.number($0)) } }
            return ZnSpan(color: argb("color"), fontSize: num("fontSize").map { CGFloat($0) },
                          fontWeight: num("fontWeight").map { Int($0) },
                          italic: num("fontStyle").map { Int($0) == Registry.FontStyle.italic },
                          decorationLine: num("textDecorationLine").map { Int($0) },
                          letterSpacing: num("letterSpacing").map { CGFloat($0) }, background: argb("backgroundColor"),
                          pressable: num("p") == 1)
        }
    }
}

struct ZnTextView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    var body: some View {
        let _ = ZnDebug.hit(name: "TextLeaf", inst: inst, node: s.index)
        let raw = s.textSlot >= 0 ? znDisplay(inst.slot(s.textSlot).value) : (s.text ?? "")
        let value = s.textTransform > 0 ? znTransformText(raw, s.textTransform) : raw
        let color = s.colorSlot >= 0 ? (znColor(inst.slot(s.colorSlot).value) ?? .black) : (s.color ?? .black)
        let spans = s.spansSlot >= 0 ? inst.slot(s.spansSlot).value.string.flatMap(ZnSpan.parse) : s.spans
        let size = max(s.fontSizeNow(inst), 0)
        let font = UIFont.systemFont(ofSize: size, weight: znUIWeight(s.fontWeight))
        let extra = s.lineHeightNow(inst).map { max($0 - font.lineHeight, 0) } ?? 0
        let selectable = s.selectableSlot >= 0 ? inst.slot(s.selectableSlot).value == .bool(true) : s.selectable
        // Auto-fit only with numberOfLines, as Android (without a line limit there is nothing to fit to).
        let minScale = znTextMinScale(autoFit: s.adjustsFontSizeToFit, maxLines: s.maxLines, minimumFontScale: s.minimumFontScale)
        Text(attributed(value, spans: spans, color: color, size: size, kern: s.letterSpacingNow(inst)))
            .multilineTextAlignment(s.textAlign == Registry.TextAlign.center ? .center
                                    : s.textAlign == Registry.TextAlign.end ? .trailing : .leading)
            .lineLimit(s.maxLines)
            .minimumScaleFactor(minScale)
            .truncationMode(.tail)
            .lineSpacing(extra)
            .modifier(ZnTextSelect(on: selectable && s.onPress == 0 && s.onLongPress == 0))
            .modifier(ZnTextPress(ctx: ctx, s: s, inst: inst, selectable: selectable))
    }

    private func pattern(_ style: Int) -> Text.LineStyle.Pattern {
        switch style {
        case Registry.TextDecorationStyle.dashed: return .dash
        case Registry.TextDecorationStyle.dotted: return .dot
        default: return .solid
        }
    }

    /// The text with the node's style, then each span's on its piece.
    private func attributed(_ text: String, spans: [ZnSpan]?, color: Color, size: CGFloat, kern: CGFloat?) -> AttributedString {
        func style(_ a: inout AttributedString, size: CGFloat, weight: Int?, italic: Bool, line: Int, kern: CGFloat?,
                   color: Color, background: Color?) {
            var f = Font.system(size: size, weight: znWeight(weight))
            if italic { f = f.italic() }
            a.font = f
            a.foregroundColor = color
            if let kern { a.kern = kern }
            if let background { a.backgroundColor = background }
            let p = pattern(s.decorationStyle)
            if line == Registry.TextDecorationLine.underline { a.underlineStyle = Text.LineStyle(pattern: p, color: color) }
            if line == Registry.TextDecorationLine.lineThrough { a.strikethroughStyle = Text.LineStyle(pattern: p, color: color) }
        }
        guard let spans else {
            var a = AttributedString(text)
            style(&a, size: size, weight: s.fontWeight, italic: s.italic, line: s.decorationLine,
                  kern: kern, color: color, background: nil)
            return a
        }
        var out = AttributedString()
        for (i, piece) in text.split(separator: "\u{1F}", omittingEmptySubsequences: false).enumerated() {
            let sp = i < spans.count ? spans[i] : ZnSpan()
            var a = AttributedString(String(piece))
            style(&a, size: sp.fontSize ?? size, weight: sp.fontWeight ?? s.fontWeight, italic: sp.italic ?? s.italic,
                  line: sp.decorationLine ?? s.decorationLine, kern: sp.letterSpacing ?? kern,
                  color: sp.color ?? color, background: sp.background)
            if sp.pressable { a.link = URL(string: "zn-span:\(i)") }
            out += a
        }
        return out
    }
}

/// selectable: iOS's long-press Copy / Share menu. A branch, not a value: the two TextSelectability types differ.
struct ZnTextSelect: ViewModifier {
    let on: Bool

    func body(content: Content) -> some View {
        if on { content.textSelection(.enabled) } else { content }
    }
}

/// A span link's tap: zn-span:<index> sends onSpanPress with the index; [fired] runs after it.
@MainActor
func znSpanLinks(_ ctx: ZnContext, _ s: ZnNodeSpec, _ inst: ZnInstance, fired: @escaping () -> Void = {}) -> OpenURLAction {
    OpenURLAction { url in
        guard url.scheme == "zn-span", let i = Int(url.absoluteString.dropFirst("zn-span:".count)) else {
            return .systemAction
        }
        fired()
        if s.onSpanPress != 0 { ctx.send(inst.id, s.onSpanPress, .number(Double(i))) }
        return .handled
    }
}

/// A top-level onPress / onLongPress on a Text (ZnRenderer.kt TEXT: clickable / combinedClickable, no indication,
/// Role.Button). The UIKit touch view a Pressable uses, over the text: a tap sends onPress, a hold of 0.5 s onLongPress
/// (then no onPress), a scroll cancels; inside a Pressable the text's own taps win, as Android's innermost clickable.
/// A Text whose spans are links keeps SwiftUI's taps instead (a touch view over it would take the links' taps): a tap
/// sends onPress unless a link just fired. A Text with neither takes no taps, so a tap goes through to what is under it,
/// as on Android.
/// The press state is made only for a Text with a handler (in ZnTextTouch / ZnTextLinkPress): most Texts have none,
/// and a @State's first value is built again every time the parent's body runs.
struct ZnTextPress: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    /// A selectable Text takes touches (its long press shows the Copy menu).
    var selectable = false

    func body(content: Content) -> some View {
        // Which branch never changes for a node: its events are in the template.
        if s.onPress == 0 && s.onLongPress == 0 {
            content.environment(\.openURL, znSpanLinks(ctx, s, inst)).allowsHitTesting(s.onSpanPress != 0 || selectable)
        } else if s.onSpanPress != 0 {
            content.modifier(ZnTextLinkPress(ctx: ctx, s: s, inst: inst))
        } else {
            content.modifier(ZnTextTouch(ctx: ctx, s: s, inst: inst))
        }
    }
}

/// onLongPress is there and JS still has a handler (the hasLongPress slot), as ZnTouchTarget's.
@MainActor
private func znTextLongPressOn(_ s: ZnNodeSpec, _ inst: ZnInstance) -> Bool {
    s.onLongPress != 0 && (s.hasLongPressSlot < 0 || inst.slot(s.hasLongPressSlot).value != .bool(false))
}

/// A tappable Text without links: ZnTouchControl over it, as a Pressable's (no press feedback).
struct ZnTextTouch: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    @State private var press = ZnPressState()

    func body(content: Content) -> some View {
        content
            .overlay(ZnTouchTarget(ctx: ctx, s: s, inst: inst, state: press, disabled: false))
            .modifier(ZnTextButtonA11y(ctx: ctx, s: s, inst: inst, longPress: znTextLongPressOn(s, inst)))
    }
}

/// When the Text's last span link fired, so a tap that came with it doesn't also send onPress, and whether the touch
/// now down was a long press.
@MainActor
final class ZnTextLinkTaps {
    var lastLinkAt: CFTimeInterval = 0
    var longFired = false
}

/// A tappable Text with span links: SwiftUI's tap and long press, so the links keep their taps. Inside a Pressable it
/// takes its own taps, as Android's innermost clickable: its frame is a box the Pressable's touch view leaves to it
/// (ZnFieldFocus.boxes, as a TextField's).
struct ZnTextLinkPress: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    @State private var taps = ZnTextLinkTaps()
    @Environment(\.znTouchOff) private var touchOff

    func body(content: Content) -> some View {
        let longPressOn = znTextLongPressOn(s, inst)
        content
            .environment(\.openURL, znSpanLinks(ctx, s, inst) { taps.lastLinkAt = CACurrentMediaTime() })
            .simultaneousGesture(LongPressGesture(minimumDuration: 0.5)
                // A new touch: a hold that ended with no tap (the finger moved away) no longer counts.
                .onChanged { _ in taps.longFired = false }
                .onEnded { _ in
                    guard !touchOff, longPressOn else { return }
                    taps.longFired = true
                    ctx.send(inst.id, s.onLongPress, .none)
                })
            .simultaneousGesture(TapGesture().onEnded {
                // After this run of the main loop, so a link's openURL (it fires on the same touch) is seen first.
                DispatchQueue.main.async {
                    defer { taps.longFired = false }
                    guard !touchOff, !taps.longFired, s.onPress != 0,
                          CACurrentMediaTime() - taps.lastLinkAt > 0.15 else { return }
                    ctx.send(inst.id, s.onPress, .none)
                }
            })
            .background(ZnFieldBoxMarker(key: "text:" + ZnFieldFocus.key(inst, s.index), off: touchOff))
            .modifier(ZnTextButtonA11y(ctx: ctx, s: s, inst: inst, longPress: longPressOn))
    }
}

/// A tappable Text reads as a button; VoiceOver's double tap sends onPress, and a "Long press" action (only on a Text
/// with onLongPress) sends onLongPress.
struct ZnTextButtonA11y: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    let longPress: Bool

    func body(content: Content) -> some View {
        let button = content
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { if s.onPress != 0 { ctx.send(inst.id, s.onPress, .none) } }
        // On the template's onLongPress, so the branch never changes; [longPress] says JS still has a handler.
        if s.onLongPress != 0 {
            button.accessibilityAction(named: Text("Long press")) { if longPress { ctx.send(inst.id, s.onLongPress, .none) } }
        } else {
            button
        }
    }
}
