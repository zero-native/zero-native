// React Native's `<StatusBar>` and zn's `<NavigationBar>` on iOS (registry 15, as android/runtime's ZnSystemBars.kt).
//
// Each element belongs to its screen (the screen whose instance tree it is in, also from inside a Modal or a Sheet).
// While that screen is on top, `barStyle` picks the status bar's text (light / dark) and `hidden` hides the status
// bar. Each element's backgroundColor is drawn behind its bar for that screen only (ZnBarStrips, under the screen's
// content: a full-bleed header still covers it). As in RN, several on one screen merge: each value comes from the newest
// mounted element that sets it. No element: the route's `statusBar` option and the screen's background decide.
//
// iOS differences: the home indicator has no colour or icons of its own, so a NavigationBar's barStyle does nothing;
// its backgroundColor fills the bottom safe area (behind the home indicator), as Android fills the navigation bar.
import SwiftUI

@MainActor @Observable final class ZnSystemBars {
    static let shared = ZnSystemBars()

    /// What one element sets; nil = not set (an older element, or the route, decides).
    struct Values: Equatable {
        var lightContent: Bool?
        var background: Color?
        var hidden: Bool?
    }

    private struct Mounted {
        let token: UUID
        let navigation: Bool
        var values: Values
    }

    /// Per screen entry: its mounted elements, oldest first.
    private var screens: [UInt32: [Mounted]] = [:]

    /// The status bar's (or, with [navigation], the bottom bar's) merged values for screen [entry].
    func merged(_ entry: UInt32, navigation: Bool) -> Values? {
        guard let list = screens[entry]?.filter({ $0.navigation == navigation }), !list.isEmpty else { return nil }
        var out = Values()
        for m in list {  // newest last: its values win
            if let v = m.values.lightContent { out.lightContent = v }
            if let v = m.values.background { out.background = v }
            if let v = m.values.hidden { out.hidden = v }
        }
        return out
    }

    func put(_ entry: UInt32, _ token: UUID, navigation: Bool, _ values: Values) {
        var list = screens[entry] ?? []
        if let i = list.firstIndex(where: { $0.token == token }) {
            if list[i].values == values { return }  // unchanged: nothing redraws
            list[i].values = values  // an update keeps its place (RN: the newest *mounted* wins)
        } else {
            list.append(Mounted(token: token, navigation: navigation, values: values))
        }
        screens[entry] = list
        if !navigation { Self.refreshStatusBar() }
    }

    func remove(_ entry: UInt32, _ token: UUID) {
        guard let list = screens[entry] else { return }
        let left = list.filter { $0.token != token }
        screens[entry] = left.isEmpty ? nil : left
        Self.refreshStatusBar()
    }

    /// The status bar asks the controllers again (ZnRootController → ZnNavController → the top ZnScreenController).
    static func refreshStatusBar() {
        for case let scene as UIWindowScene in UIApplication.shared.connectedScenes {
            for w in scene.windows { w.rootViewController?.setNeedsStatusBarAppearanceUpdate() }
        }
    }
}

/// The screen entry an instance belongs to: the root of its instance tree (ZnStore: a screen's root instance has the
/// entry's id).
@MainActor func znScreenEntry(_ inst: ZnInstance) -> UInt32 {
    var i = inst
    var steps = 0
    while i.parent != 0, steps < 10_000, let p = ZnApp.shared.store.find(i.parent) {
        i = p
        steps += 1
    }
    return i.id
}

/// A `<StatusBar>` / `<NavigationBar>` element: takes no room, registers its values for its screen.
struct ZnBarElement: View {
    let s: ZnNodeSpec
    let inst: ZnInstance
    let navigation: Bool
    @State private var token = UUID()

    private static func style(_ v: ZnValue) -> Int {
        switch v {
        case .enumValue(let e): return e
        case .string("light-content"): return Registry.BarStyle.lightContent
        case .string("dark-content"): return Registry.BarStyle.darkContent
        case .string("default"): return Registry.BarStyle.default
        default: return -1
        }
    }

    var body: some View {
        let style = s.barStyleSlot >= 0 ? Self.style(inst.slot(s.barStyleSlot).value) : s.barStyle
        let background = s.backgroundSlot >= 0 ? znColor(inst.slot(s.backgroundSlot).value) : s.background
        let hidden: Bool? = s.hiddenSlot >= 0 ? inst.slot(s.hiddenSlot).value.bool : s.hasHiddenProp ? s.hidden : nil
        let values = ZnSystemBars.Values(
            lightContent: style == Registry.BarStyle.lightContent ? true : style == Registry.BarStyle.darkContent ? false : nil,
            background: background,
            hidden: navigation ? nil : hidden)
        Color.clear.frame(width: 0, height: 0)
            .accessibilityHidden(true)
            .onAppear { ZnSystemBars.shared.put(znScreenEntry(inst), token, navigation: navigation, values) }
            .onChange(of: values) { _, v in ZnSystemBars.shared.put(znScreenEntry(inst), token, navigation: navigation, v) }
            .onDisappear { ZnSystemBars.shared.remove(znScreenEntry(inst), token) }
    }
}

/// A screen's background with its <StatusBar> / <NavigationBar> colours over the top and bottom safe areas, under the
/// screen's content (ZnNavHost.kt barStrips).
struct ZnBarStrips: View {
    let entry: UInt32
    let base: Color

    var body: some View {
        let bars = ZnSystemBars.shared
        let status = bars.merged(entry, navigation: false)?.background
        let bottom = bars.merged(entry, navigation: true)?.background
        let app = ZnApp.shared
        ZStack {
            base
            if status != nil || bottom != nil {
                VStack(spacing: 0) {
                    (status ?? .clear).frame(height: app.windowInsetTop)
                    Spacer(minLength: 0)
                    (bottom ?? .clear).frame(height: app.windowInsetBottom)
                }
            }
        }
        .ignoresSafeArea()
    }
}
