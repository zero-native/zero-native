// iOS's small UI rules (ZnUIRules.swift), on the Mac: tools/ios-unit-test.ts builds this with Registry.swift
// (sources.txt). The cases follow android/runtime: ZnRenderer.kt ZnCarousel's pageSize and the TEXT branch's
// TextAutoSize, ZnTextField.kt's KeyboardOptions (capitalization, autoCorrectEnabled).
import CoreGraphics
import Foundation

var failures = 0
var count = 0

func check<T: Equatable>(_ name: String, _ got: T, _ want: T, line: Int = #line) {
    count += 1
    if got != want {
        failures += 1
        print("FAIL \(name) (line \(line)): got \(got), want \(want)")
    }
}

// Carousel pages: a percent of the width inside the padding (gap not taken off), rounded, at least 1.
check("80% of 393 - 24", znCarouselPageWidth(width: 393, padding: 24, itemWidth: nil, percent: 80), 295)
check("percent wins over itemWidth", znCarouselPageWidth(width: 300, padding: 0, itemWidth: 120, percent: 50), 150)
check("itemWidth", znCarouselPageWidth(width: 300, padding: 20, itemWidth: 120, percent: nil), 120)
check("full width", znCarouselPageWidth(width: 300, padding: 20, itemWidth: nil, percent: nil), 280)
check("tiny percent is 1", znCarouselPageWidth(width: 100, padding: 0, itemWidth: nil, percent: 0.1), 1)
check("no room", znCarouselPageWidth(width: 10, padding: 30, itemWidth: nil, percent: nil), 0)

// Auto-fit: only with numberOfLines; minimumFontScale 0.5 when not written, within 0.01...1.
check("off", znTextMinScale(autoFit: false, maxLines: 1, minimumFontScale: 0.3), 1)
check("no numberOfLines", znTextMinScale(autoFit: true, maxLines: nil, minimumFontScale: 0.3), 1)
check("default 0.5", znTextMinScale(autoFit: true, maxLines: 1, minimumFontScale: nil), 0.5)
check("written", znTextMinScale(autoFit: true, maxLines: 2, minimumFontScale: 0.8), 0.8)
check("clamped low", znTextMinScale(autoFit: true, maxLines: 1, minimumFontScale: 0), 0.01)
check("clamped high", znTextMinScale(autoFit: true, maxLines: 1, minimumFontScale: 3), 1)

// Capitalization: none / words / characters as written; "sentences" or not written: none for secure or a keyboardType.
typealias A = Registry.AutoCapitalize
typealias K = Registry.KeyboardType
check("none", ZnFieldRules.autocap(A.none, secure: false, keyboardType: 0), .none)
check("words", ZnFieldRules.autocap(A.words, secure: false, keyboardType: 0), .words)
check("characters", ZnFieldRules.autocap(A.characters, secure: false, keyboardType: 0), .characters)
check("characters on a number pad", ZnFieldRules.autocap(A.characters, secure: false, keyboardType: K.numberPad), .characters)
check("not written", ZnFieldRules.autocap(-1, secure: false, keyboardType: 0), .sentences)
check("not written, secure", ZnFieldRules.autocap(-1, secure: true, keyboardType: 0), .none)
check("not written, email", ZnFieldRules.autocap(-1, secure: false, keyboardType: K.emailAddress), .none)
check("sentences", ZnFieldRules.autocap(A.sentences, secure: false, keyboardType: 0), .sentences)
check("sentences on a phone pad (Android: none)", ZnFieldRules.autocap(A.sentences, secure: false, keyboardType: K.phonePad), .none)

// Autocorrect: on unless written false, never on a secure field.
check("autocorrect default", ZnFieldRules.autocorrect(true, secure: false), true)
check("autocorrect off", ZnFieldRules.autocorrect(false, secure: false), false)
check("autocorrect secure", ZnFieldRules.autocorrect(true, secure: true), false)

print(failures == 0 ? "ios ui rules: \(count) checks passed" : "ios ui rules: \(failures) of \(count) checks failed")
exit(failures == 0 ? 0 : 1)
