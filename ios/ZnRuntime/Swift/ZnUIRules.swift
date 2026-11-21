// Small rules of the UI props that need only Foundation, so ios/tests/uirules checks them on the Mac against
// Android's: a Carousel's page width, a Text's auto-fit scale, a TextField's capitalization and autocorrect.
import Foundation

/// A Carousel page's width (ZnRenderer.kt ZnCarousel pageSize): a percent of the width inside the padding (the gap
/// not taken off, rounded, at least 1), else `itemWidth`, else that whole width.
func znCarouselPageWidth(width: CGFloat, padding: CGFloat, itemWidth: CGFloat?, percent: CGFloat?) -> CGFloat {
    let avail = max(width - padding, 0)
    if let percent { return max(1, (avail * percent / 100).rounded()) }
    return itemWidth ?? avail
}

/// The smallest scale an auto-fit Text may shrink to (ZnRenderer.kt: minimumFontScale ?: 0.5, within 0.01...1), or 1
/// (no shrinking) when adjustsFontSizeToFit is off or there is no numberOfLines.
func znTextMinScale(autoFit: Bool, maxLines: Int?, minimumFontScale: CGFloat?) -> CGFloat {
    guard autoFit, maxLines != nil else { return 1 }
    return min(max(minimumFontScale ?? 0.5, 0.01), 1)
}

/// A TextField's capitalization (ZnTextField.kt KeyboardOptions), as a plain value for UIKit and SwiftUI to map.
enum ZnAutocap: Equatable { case none, sentences, words, characters }

enum ZnFieldRules {
    /// autoCapitalize (Registry.AutoCapitalize, -1 when not written). Not written or "sentences": none for a secure
    /// field or one with a keyboardType (numbers, email, phone, URL), else sentences, as Android.
    static func autocap(_ written: Int, secure: Bool, keyboardType: Int) -> ZnAutocap {
        switch written {
        case Registry.AutoCapitalize.none: return .none
        case Registry.AutoCapitalize.words: return .words
        case Registry.AutoCapitalize.characters: return .characters
        // "sentences" or not written (Android maps only the other three).
        default: return secure || keyboardType > 0 ? .none : .sentences
        }
    }

    /// Autocorrect (and spell checking) on: autoCorrect isn't false and the field isn't secure, as Android.
    static func autocorrect(_ autoCorrect: Bool, secure: Bool) -> Bool { autoCorrect && !secure }
}
