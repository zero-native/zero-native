// What the user sees instead of a screen whose JS threw while building it (NAV FAILED), whose JS hung and was stopped
// by the time limit, or when the app's JS didn't start at all. Drawn natively, so it can't break the way the screen
// did. As android/runtime's ZnErrorScreen.kt: the same words, colours and buttons.
//
// Apps change its words and colours before the app starts (their own language, their brand):
//
//     ZnErrorScreen.texts = .init(title: "कुछ गड़बड़ हो गई")
//     ZnErrorScreen.colors = .init(button: Color(red: 0.24, green: 0.15, blue: 0.93))
//
// Release builds never show the error message (it is for developers and may hold internal details); debug builds show
// it under the text.
//
// iOS difference: a failed start has no "Restart app" button. iOS apps may not end or relaunch themselves, so the text
// asks the user to close and open the app.
import SwiftUI

enum ZnErrorScreen {
    struct Texts {
        var title = "Something went wrong"
        /// A screen failed and there is a screen to go back to.
        var body = "This screen couldn't open. You can try again or go back."
        /// A screen failed and it is the first screen.
        var bodyFirstScreen = "This screen couldn't open. Please try again."
        /// JS on this screen ran too long and was stopped (the time limit).
        var bodyHang = "This screen stopped responding. Try again to reload it."
        /// The app's JS didn't start.
        var bodyStart = "The app couldn't start. Close it and open it again."
        var retry = "Try again"
        var back = "Go back"
    }

    struct Colors {
        var background = Color(znArgb: 0xFFF8_FAFC)
        var title = Color(znArgb: 0xFF0F_172A)
        var body = Color(znArgb: 0xFF47_5569)
        var icon = Color(znArgb: 0xFFE2_E8F0)
        var iconMark = Color(znArgb: 0xFF47_5569)
        var button = Color(znArgb: 0xFF0F_172A)
        var buttonText = Color.white
        var link = Color(znArgb: 0xFF0F_172A)
    }

    /// Set these before the app starts, before any screen can fail.
    nonisolated(unsafe) static var texts = Texts()
    nonisolated(unsafe) static var colors = Colors()

    /// Start of the error text of JS stopped by the time limit (kTimeLimitError in core/include/zn/engine.h).
    static let timeLimitError = "zero-native time limit:"
}

struct ZnErrorScreenView: View {
    let message: String
    let startFailed: Bool
    let canGoBack: Bool
    let onRetry: () -> Void
    let onBack: () -> Void

    var body: some View {
        let t = ZnErrorScreen.texts
        let c = ZnErrorScreen.colors
        let hung = message.hasPrefix(ZnErrorScreen.timeLimitError)
        let text = startFailed ? t.bodyStart : hung ? t.bodyHang : canGoBack ? t.body : t.bodyFirstScreen
        VStack(spacing: 0) {
            Text("!")
                .font(.system(size: 26, weight: .bold))
                .foregroundStyle(c.iconMark)
                .frame(width: 56, height: 56)
                .background(Circle().fill(c.icon))
            Text(t.title)
                .font(.system(size: 20, weight: .semibold))
                .foregroundStyle(c.title)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 20)
            Text(text)
                .font(.system(size: 15))
                .lineSpacing(4)
                .foregroundStyle(c.body)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
            #if DEBUG
            if !message.isEmpty {
                Text(message)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(Color(znArgb: 0xFFB9_1C1C))
                    .lineLimit(6)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(znArgb: 0xFFFE_F2F2)))
                    .padding(.top, 16)
            }
            #endif
            if !startFailed {
                button(t.retry, filled: true, action: onRetry).padding(.top, 28)
                if canGoBack { button(t.back, filled: false, action: onBack).padding(.top, 8) }
            }
        }
        .frame(maxWidth: 420)
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(c.background.ignoresSafeArea())
    }

    private func button(_ label: String, filled: Bool, action: @escaping () -> Void) -> some View {
        let c = ZnErrorScreen.colors
        return Button(action: action) {
            Text(label)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(filled ? c.buttonText : c.link)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(RoundedRectangle(cornerRadius: 12).fill(filled ? c.button : .clear))
                .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
    }
}

extension Color {
    /// 0xAARRGGBB, as Android's Color(0xFF...).
    init(znArgb v: UInt32) {
        self.init(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255,
                  blue: Double(v & 0xFF) / 255, opacity: Double(v >> 24) / 255)
    }
}
