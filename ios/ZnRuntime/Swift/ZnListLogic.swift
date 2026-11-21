// <List>'s pure rules (Foundation only), so the Mac harness (tools/ios-spec-test.ts) builds them without UIKit or
// SwiftUI: pinned rows and the grid row style. Ports of android/runtime's parseSticky (ZnRenderer.kt) and
// ZnColumnWrapper (ZnTemplate.kt); later List items add their pure parts here too.
import Foundation

/// "1,30" → the sorted, distinct row indices (bad entries dropped), as Android's parseSticky.
func znParseSticky(_ text: String?) -> [Int] {
    guard let text else { return [] }
    return Array(Set(text.split(separator: ",").compactMap { Int($0.trimmingCharacters(in: .whitespaces)) }.filter { $0 >= 0 })).sorted()
}

/// RN columnWrapperStyle (registry 24), written by the compiler as "g<gap>;j<justify>;a<align>;p<start>,<top>,<end>,<bottom>"
/// (-1: unset). A grid row is laid out like a <Row> with these. Unreadable parts keep their defaults (ZnTemplate.kt).
struct ZnColumnWrapper: Equatable {
    var gap: Double = 0
    var justify = -1
    var align = -1
    var start: Double = 0, top: Double = 0, end: Double = 0, bottom: Double = 0

    static let none = ZnColumnWrapper()

    static func parse(_ s: String?) -> ZnColumnWrapper {
        guard let s, !s.isEmpty else { return .none }
        var w = ZnColumnWrapper()
        for part in s.split(separator: ";", omittingEmptySubsequences: true) {
            let v = String(part.dropFirst())
            switch part.first {
            case "g": w.gap = Double(v).flatMap { $0.isFinite && $0 >= 0 ? $0 : nil } ?? 0
            case "j": w.justify = Int(v) ?? -1
            case "a": w.align = Int(v) ?? -1
            case "p":
                let pad = v.split(separator: ",", omittingEmptySubsequences: false).compactMap { Double($0) }
                if pad.count == 4 { (w.start, w.top, w.end, w.bottom) = (pad[0], pad[1], pad[2], pad[3]) }
            default: break
            }
        }
        return w
    }
}
