// <Text> on iOS, as android/runtime's ZnRenderer.kt TEXT branch: the text (template or slot), textTransform, colour,
// size, weight, italic, letterSpacing, lineHeight, alignment, numberOfLines (with "…"), textDecorationLine with
// textDecorationStyle (solid, dashed, dotted: SwiftUI's own line patterns, where Android draws its own dashes), and
// nested <Text> spans (registry 16): one style per piece, the pieces joined by U+001F (compile.ts `textChildren`),
// static in the template or JSON in a slot when they change at runtime. A span with onPress is a link; a tap sends
// onSpanPress with its index.
// iOS differences: includeFontPadding is Android-only (ignored). lineHeight adds the difference to the font's own
// line height as line spacing (RN on iOS places the extra space differently: above each line).
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
        let font = UIFont.systemFont(ofSize: s.fontSize, weight: znUIWeight(s.fontWeight))
        let extra = s.lineHeight.map { max($0 - font.lineHeight, 0) } ?? 0
        Text(attributed(value, spans: spans, color: color))
            .multilineTextAlignment(s.textAlign == Registry.TextAlign.center ? .center
                                    : s.textAlign == Registry.TextAlign.end ? .trailing : .leading)
            .lineLimit(s.maxLines)
            .truncationMode(.tail)
            .lineSpacing(extra)
            .environment(\.openURL, OpenURLAction { url in
                // zn-span:<index>: a span's onPress.
                guard url.scheme == "zn-span", let i = Int(url.absoluteString.dropFirst("zn-span:".count)) else {
                    return .systemAction
                }
                if s.onSpanPress != 0 { ctx.send(inst.id, s.onSpanPress, .number(Double(i))) }
                return .handled
            })
    }

    private func pattern(_ style: Int) -> Text.LineStyle.Pattern {
        switch style {
        case Registry.TextDecorationStyle.dashed: return .dash
        case Registry.TextDecorationStyle.dotted: return .dot
        default: return .solid
        }
    }

    /// The text with the node's style, then each span's on its piece.
    private func attributed(_ text: String, spans: [ZnSpan]?, color: Color) -> AttributedString {
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
            style(&a, size: s.fontSize, weight: s.fontWeight, italic: s.italic, line: s.decorationLine,
                  kern: s.letterSpacing, color: color, background: nil)
            return a
        }
        var out = AttributedString()
        for (i, piece) in text.split(separator: "\u{1F}", omittingEmptySubsequences: false).enumerated() {
            let sp = i < spans.count ? spans[i] : ZnSpan()
            var a = AttributedString(String(piece))
            style(&a, size: sp.fontSize ?? s.fontSize, weight: sp.fontWeight ?? s.fontWeight, italic: sp.italic ?? s.italic,
                  line: sp.decorationLine ?? s.decorationLine, kern: sp.letterSpacing ?? s.letterSpacing,
                  color: sp.color ?? color, background: sp.background)
            if sp.pressable { a.link = URL(string: "zn-span:\(i)") }
            out += a
        }
        return out
    }
}
