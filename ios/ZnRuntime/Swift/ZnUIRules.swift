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

/// How far a Pressable's touch area reaches past it on each side (top, start, bottom, end).
struct ZnTouchReach: Equatable {
    var top: CGFloat = 0, start: CGFloat = 0, bottom: CGFloat = 0, end: CGFloat = 0
}

enum ZnTouchRules {
    /// The smallest touch area of a Pressable, per axis: Apple's 44 pt guideline (decided 2026-11-24). Android
    /// gives Compose's 48 dp. An app may lower it, or set 0 to turn it off.
    nonisolated(unsafe) static var minSize: CGFloat = 44

    /// The hitSlop, grown on each axis until the whole area is at least [minSize], the growth split evenly so the area
    /// stays centred on the Pressable. hitSlop only ever adds. A Pressable not laid out yet (0 wide or tall) isn't grown,
    /// so it can't take taps where nothing shows.
    static func reach(width: CGFloat, height: CGFloat, slop: ZnTouchReach, minSize: CGFloat = ZnTouchRules.minSize) -> ZnTouchReach {
        var r = slop
        guard width > 0, height > 0, minSize > 0 else { return r }
        let w = width + r.start + r.end
        if w < minSize { let x = (minSize - w) / 2; r.start += x; r.end += x }
        let h = height + r.top + r.bottom
        if h < minSize { let y = (minSize - h) / 2; r.top += y; r.bottom += y }
        return r
    }

    /// How far [p] is from [r] (0 inside it): where two grown areas overlap, the nearer Pressable takes the touch.
    static func distance(_ p: CGPoint, to r: CGRect) -> CGFloat {
        let dx = max(r.minX - p.x, 0, p.x - r.maxX)
        let dy = max(r.minY - p.y, 0, p.y - r.maxY)
        return (dx * dx + dy * dy).squareRoot()
    }
}
