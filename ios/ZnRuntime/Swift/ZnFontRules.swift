// The rules of text sizes and app fonts that need only Foundation and CoreGraphics, so ios/tests/text checks them on
// the Mac against Android's (ZnTemplate.kt fontScaleCap, ZnFonts.kt, Compose's font matching): the text scale with
// maxFontScale, the manifest's font table, the font file check, which face a weight and style pick, the phone's own
// font names, and reading a font file.
import CoreGraphics
import Foundation

/// The scale a text's sizes are drawn at: the phone's text size [phone] (znContentSizeScale), at most [max] when the
/// text sets maxFontScale (allowFontScaling={false} is 1). Android: fontScale × fontScaleCap. Small phone sizes still
/// shrink a capped text, as on Android. A cap of 0 or less is no cap (Android would draw such text at size 0).
func znTextScale(phone: CGFloat, max: CGFloat?) -> CGFloat {
    guard let max, max > 0, phone > max, phone > 0 else { return phone }
    return max
}

/// One face of an app font family (compiler/src/fonts.ts FontFace): its bundle file ("fonts/X.ttf"), weight, italic.
struct ZnFontFace: Equatable {
    let file: String
    let weight: Int
    let italic: Bool
}

enum ZnFontRules {
    /// The manifest's "fonts": { family: [{ file, weight, italic }] }. A malformed entry is skipped (ZnFonts.kt parse).
    static func parse(_ fonts: [String: Any]) -> [String: [ZnFontFace]] {
        var out: [String: [ZnFontFace]] = [:]
        for (name, value) in fonts {
            guard let list = value as? [Any] else { continue }
            out[name] = list.compactMap { item in
                guard let o = item as? [String: Any], let file = o["file"] as? String, !file.isEmpty else { return nil }
                let weight = (o["weight"] as? NSNumber)?.intValue ?? 400
                let italic = (o["italic"] as? Bool) ?? false
                return ZnFontFace(file: file, weight: weight, italic: italic)
            }
        }
        return out
    }

    /// The first 4 bytes are a TrueType / OpenType tag (00 01 00 00, "OTTO" or "true"), as ZnFonts.kt looksLikeFont:
    /// an HTML error page saved as a font, a collection (ttcf) or a cut file is not.
    static func looksLikeFont(_ data: Data) -> Bool {
        guard data.count >= 4 else { return false }
        let tag = [UInt8](data.prefix(4))
        return tag == [0, 1, 0, 0] || tag == Array("OTTO".utf8) || tag == Array("true".utf8)
    }

    /// The face for [weight] and [italic], as Compose and CSS pick one: the wanted style first (else the other, and
    /// [synthItalic] says italic must be drawn slanted), then the weight: 400 tries 500 next, 500 tries 400; below 400
    /// lighter ones first, above 500 heavier ones first. Nil only for no faces.
    static func pick(_ faces: [ZnFontFace], weight: Int, italic: Bool) -> (face: ZnFontFace, synthItalic: Bool)? {
        guard !faces.isEmpty else { return nil }
        let styled = faces.filter { $0.italic == italic }
        let pool = styled.isEmpty ? faces : styled
        let synth = italic && styled.isEmpty
        let w = weight
        let order: [ZnFontFace]
        let up = pool.filter { $0.weight >= w }.sorted { $0.weight < $1.weight }
        let down = pool.filter { $0.weight < w }.sorted { $0.weight > $1.weight }
        if w >= 400 && w <= 500 {
            // Up to 500 first, then lighter, then heavier than 500.
            let near = up.filter { $0.weight <= 500 }
            order = near + down + up.filter { $0.weight > 500 }
        } else if w < 400 {
            let atOrBelow = pool.filter { $0.weight <= w }.sorted { $0.weight > $1.weight }
            order = atOrBelow + pool.filter { $0.weight > w }.sorted { $0.weight < $1.weight }
        } else {
            order = up + down
        }
        return order.first.map { ($0, synth) }
    }

    /// The phone's own fonts under Android's names (fonts.ts SYSTEM_FONTS), as iOS draws them. Nil: not such a name.
    static func systemFont(_ name: String) -> ZnSystemFont? {
        switch name {
        case "System", "sans-serif", "Roboto": return ZnSystemFont()
        case "serif": return ZnSystemFont(design: .serif)
        case "monospace": return ZnSystemFont(design: .monospaced)
        case "sans-serif-thin": return ZnSystemFont(weight: 100)
        case "sans-serif-light": return ZnSystemFont(weight: 300)
        case "sans-serif-medium": return ZnSystemFont(weight: 500)
        case "sans-serif-black": return ZnSystemFont(weight: 900)
        case "sans-serif-condensed": return ZnSystemFont(condensed: true)
        case "sans-serif-condensed-light": return ZnSystemFont(weight: 300, condensed: true)
        case "sans-serif-condensed-medium": return ZnSystemFont(weight: 500, condensed: true)
        default: return nil
        }
    }

    /// A font file's data as a CGFont, after the tag check; nil when it isn't one.
    static func cgFont(_ data: Data) -> CGFont? {
        guard looksLikeFont(data), let provider = CGDataProvider(data: data as CFData) else { return nil }
        return CGFont(provider)
    }
}

/// One of the phone's fonts by an Android name: the system font, or its serif (New York) or monospaced (SF Mono)
/// design, at a weight the name gives (nil: the text's own), condensed or not.
struct ZnSystemFont: Equatable {
    enum Design: Equatable { case standard, serif, monospaced }
    var design: Design = .standard
    var weight: Int? = nil
    var condensed = false
}
