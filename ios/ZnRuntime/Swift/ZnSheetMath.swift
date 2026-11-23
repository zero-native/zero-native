// A Sheet's motion progress (ZnSheet.swift; Android: ZnSheet.kt's progress), pure, so the Mac suite (ios/tests/gestures)
// runs it.
import Foundation

enum ZnSheetMath {
    /// 0 closed to 1 at the tallest detent, for the sheet's top edge at [top]: how much of [tallest] shows above where
    /// the sheet rests ([restBottom]: the screen's bottom above the home indicator, or the keyboard's top).
    static func progress(top: CGFloat, restBottom: CGFloat, tallest: CGFloat) -> Float {
        tallest > 0 ? Float(min(max((restBottom - top) / tallest, 0), 1)) : 0
    }
}
