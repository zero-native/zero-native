// Text sizes and fonts for Text, TextField and OtpInput, as android/runtime's ZnTemplate.kt effectiveTextStyle.
//
// Dynamic Type: sizes follow the phone's text size setting, as sp follows Android's font scale. The scale is
// znContentSizeScale (ZnEnv.swift), the number JS's PixelRatio.getFontScale() also gets: large (the default) is 1,
// the accessibility sizes up to about 3.1, the small ones below 1. A text's maxFontScale caps it
// (allowFontScaling={false} is 1). fontSize, lineHeight and letterSpacing are scaled, spans too. The scale is read
// from SwiftUI's dynamicTypeSize, so a change in Settings redraws the text at once. SVG text and Icon sizes are not
// scaled (dp on Android).
//
// Fonts: one builder for every text, from fontFamily (ZnFontTable: the app's files, the phone's fonts by Android's
// names, or an iOS font), the size (already scaled), fontWeight and italic. The system font keeps SwiftUI's own
// Font.system (with its optical sizes), as before fonts came in.
//
// iOS differences: iOS's largest sizes go past Android's 2.0, and its curve differs from Android 14's nonlinear one.
import SwiftUI
import UIKit

@MainActor private var znFontScales: [DynamicTypeSize: CGFloat] = [:]

/// The phone's text size [size] (SwiftUI's environment) as a scale, worked out once per size.
@MainActor func znFontScale(_ size: DynamicTypeSize) -> CGFloat {
    if let k = znFontScales[size] { return k }
    let k = znContentSizeScale(UIContentSizeCategory(size))
    znFontScales[size] = k
    return k
}

extension ZnNodeSpec {
    /// The scale this text's sizes are drawn at under [typeSize]: the phone's, capped by maxFontScale.
    @MainActor func textScale(_ typeSize: DynamicTypeSize) -> CGFloat {
        znTextScale(phone: znFontScale(typeSize), max: maxFontScale)
    }
}

/// The weight a system font draws at: the one written on the text, else the name's (sans-serif-medium: 500), else 400.
private func znSystemWeight(_ sys: ZnSystemFont, _ weight: Int?) -> Int? { weight ?? sys.weight }

/// The UIKit font for [family] at [size] (already scaled), [weight] (nil: not written) and [italic].
@MainActor func znUIFont(_ family: String?, size: CGFloat, weight: Int?, italic: Bool) -> UIFont {
    let table = ZnFontTable.current
    switch table.choose(family, weight: weight ?? 400, italic: italic) {
    case .file(let cg, let synth):
        return table.uiFont(cg, size: size, synthItalic: synth)
    case .installed(let name):
        return table.installedFont(name, size: size, weight: weight ?? 400, italic: italic)
    case .system(let sys):
        let w = znUIWeight(znSystemWeight(sys, weight))
        var f = sys.condensed ? UIFont.systemFont(ofSize: size, weight: w, width: .condensed) : UIFont.systemFont(ofSize: size, weight: w)
        let design: UIFontDescriptor.SystemDesign? = switch sys.design {
        case .serif: .serif
        case .monospaced: .monospaced
        case .standard: nil
        }
        if let design, let d = f.fontDescriptor.withDesign(design) { f = UIFont(descriptor: d, size: size) }
        return znItalic(f, italic)
    }
}

private func znItalic(_ f: UIFont, _ italic: Bool) -> UIFont {
    guard italic, let d = f.fontDescriptor.withSymbolicTraits(f.fontDescriptor.symbolicTraits.union(.traitItalic)) else { return f }
    return UIFont(descriptor: d, size: f.pointSize)
}

/// The SwiftUI font for the same: Font.system for the phone's fonts, the UIKit font for an app file.
@MainActor func znFont(_ family: String?, size: CGFloat, weight: Int?, italic: Bool) -> Font {
    let table = ZnFontTable.current
    switch table.choose(family, weight: weight ?? 400, italic: italic) {
    case .file(let cg, let synth):
        return Font(table.uiFont(cg, size: size, synthItalic: synth) as CTFont)
    case .installed(let name):
        return Font(table.installedFont(name, size: size, weight: weight ?? 400, italic: italic) as CTFont)
    case .system(let sys):
        let design: Font.Design = switch sys.design {
        case .serif: .serif
        case .monospaced: .monospaced
        case .standard: .default
        }
        var f = Font.system(size: size, weight: znWeight(znSystemWeight(sys, weight)), design: design)
        if sys.condensed { f = f.width(.condensed) }
        return italic ? f.italic() : f
    }
}
