// i.1c spike switches: each hard part is built twice, with SwiftUI and with UIKit, to choose per component
// (ARCHITECTURE.md §20). Picked at launch: ZN_IOS_PRESS / ZN_IOS_NAV / ZN_IOS_SHEET / ZN_IOS_FIELD / ZN_IOS_LIST
// = "swiftui" or "uikit". The defaults are the choices made in i.1c (2026-11-08, docs/milestones.md): UIKit for all
// five. The SwiftUI variants stay until the device checks listed there are done, then go; these switches don't ship.
import Foundation

enum ZnImpl {
    case swiftUI, uiKit

    private static func pick(_ name: String, _ fallback: ZnImpl) -> ZnImpl {
        switch ProcessInfo.processInfo.environment[name]?.lowercased() {
        case "swiftui": return .swiftUI
        case "uikit": return .uiKit
        default: return fallback
        }
    }

    static let press = pick("ZN_IOS_PRESS", .uiKit)
    static let nav = pick("ZN_IOS_NAV", .uiKit)
    static let sheet = pick("ZN_IOS_SHEET", .uiKit)
    static let field = pick("ZN_IOS_FIELD", .uiKit)
    static let list = pick("ZN_IOS_LIST", .uiKit)
}

/// An event payload for JS.
enum ZnPayload {
    case none
    case bool(Bool)
    case number(Double)
    case string(String)
}
