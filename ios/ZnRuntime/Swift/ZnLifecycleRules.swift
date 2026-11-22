// The parts of the app's life on iOS with no UIKit in them, so the Mac tests check them (ios/tests/lifecycle):
// - WINDOW's text (android/runtime ZnWindow.kt windowJson): fixed key order and Android's rounding, so the same window
//   always gives the same text and a relayout that changes nothing sends nothing;
// - the keyboard's height from where its layout guide's top is (motion env);
// - when START may go: JS can start without a window (ZnApp.prepare: a push, a task) and the window can come first,
//   or the other way round (Android: the Application starts JS, the Activity opens screens).
import CoreGraphics
import Foundation

enum ZnWindowRules {
    /// One decimal: enough for points, and small changes from rounding don't send events (ZnWindow.kt r).
    static func r1(_ v: Double) -> Double { (v * 10).rounded() / 10 }
    /// Three decimals: scale and font scale stay exact for PixelRatio's pixel math (ZnWindow.kt r3).
    static func r3(_ v: Double) -> Double { (v * 1000).rounded() / 1000 }

    /// A number as Android's JSONObject writes it: 393 for 393.0, 1.235 for 1.235.
    static func number(_ v: Double) -> String {
        guard v.isFinite else { return "0" }
        if v == v.rounded(), abs(v) < 1e15 { return String(Int64(v)) }
        return "\(v)"
    }

    /// WINDOW (dimensions.ts): the window and the whole screen in points, the scale and the text size as a scale.
    /// Written by hand: a dictionary's key order changes from run to run.
    static func windowJson(width: Double, height: Double, scale: Double, fontScale: Double, screenWidth: Double,
                           screenHeight: Double) -> String {
        "{\"width\":\(number(r1(width))),\"height\":\(number(r1(height))),\"scale\":\(number(r3(scale))),"
            + "\"fontScale\":\(number(r3(fontScale))),\"screenWidth\":\(number(r1(screenWidth))),"
            + "\"screenHeight\":\(number(r1(screenHeight)))}"
    }

    /// How much of the window the keyboard covers (points): from the top of its layout guide to the window's bottom,
    /// 0 when the guide sits at the bottom (hidden, a hardware keyboard).
    static func keyboardHeight(windowHeight: CGFloat, guideTop: CGFloat) -> CGFloat {
        guard windowHeight.isFinite, guideTop.isFinite else { return 0 }
        return max(0, windowHeight - guideTop)
    }
}

/// When START goes to JS: once the main script has run and the window has asked for its first screens, whichever
/// comes first. A new runtime (an update applied in place) starts over.
struct ZnStartGate: Equatable {
    /// main.hbc ran: tasks and events reach JS from now on.
    private(set) var scriptLoaded = false
    /// The window's START payload, waiting for the script.
    private(set) var waiting: String?
    /// START went: screens exist (ZnApp.isUIStarted).
    private(set) var uiStarted = false

    /// The script ran; the payload to send now, if the window already asked.
    mutating func scriptRan() -> String? {
        scriptLoaded = true
        return take()
    }

    /// The window asked for its first screens; the payload to send now, if the script already ran.
    mutating func windowAsks(_ payload: String) -> String? {
        guard !uiStarted else { return nil }  // a second window: the screens are up already
        waiting = payload
        return take()
    }

    /// A new runtime: nothing ran, nothing waits.
    mutating func reset() { self = ZnStartGate() }

    private mutating func take() -> String? {
        guard scriptLoaded, !uiStarted, let p = waiting else { return nil }
        waiting = nil
        uiStarted = true
        return p
    }
}
