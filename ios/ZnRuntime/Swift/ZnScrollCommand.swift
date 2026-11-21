// A scroll command from core's bindListController (packages/core/src/view.ts), for <List ref> and <Scroll ref>: one
// parser for both, so they can't drift. Foundation only (tools/ios-spec-test.ts builds it on the Mac).
//
// The text is "action:param:animated:second:seq" (numbers in dp = pt), as Android reads it (ZnRenderer.kt for a List,
// ZnScrollExtras.kt ZnScrollCommands for a Scroll):
//   index:<row>:<anim>:<viewOffset>:<seq>   a List's scrollToIndex
//   end:0:<anim>:0:<seq>                    scrollToEnd
//   offset:<o>:<anim>:0:<seq>               scrollToOffset
//   to:<x>:<anim>:<y>:<seq>                 scrollTo({ x, y })
import Foundation

struct ZnScrollCommand: Equatable {
    enum Action: Equatable {
        case index, end, offset, to
        /// Any other word: its sequence number still counts as run, as on Android, but nothing moves.
        case other
    }

    let action: Action
    /// The row (index), the offset (offset) or x (to); 0 when missing or not a finite number.
    let param: Double
    /// Anything but "0" animates.
    let animated: Bool
    /// viewOffset (index) or y (to); 0 when missing or not a finite number.
    let second: Double
    /// Each command runs once: a seq not above the last one run is old.
    let seq: Int

    /// nil without a whole-number seq (the fifth part), as Android's `toIntOrNull() ?: return`.
    init?(_ text: String?) {
        guard let parts = text?.split(separator: ":", omittingEmptySubsequences: false).map(String.init),
              parts.count > 4, let seq = Int(parts[4]) else { return nil }
        func number(_ i: Int) -> Double { Double(parts[i]).flatMap { $0.isFinite ? $0 : nil } ?? 0 }
        switch parts[0] {
        case "index": action = .index
        case "end": action = .end
        case "offset": action = .offset
        case "to": action = .to
        default: action = .other
        }
        param = number(1)
        animated = parts[2] != "0"
        second = number(3)
        self.seq = seq
    }

    /// The absolute offset along the scroll's axis for offset / to (to: x when horizontal, else y); nil for the others.
    /// Not clamped: the caller keeps it between 0 and its own end.
    func axisOffset(horizontal: Bool) -> Double? {
        switch action {
        case .offset: return param
        case .to: return horizontal ? param : second
        default: return nil
        }
    }

    /// Is this command new? A List starts its last seq at -1 (a command sent with the MOUNT runs on first draw), a
    /// Scroll at 0 (its instance's scrollSeqs), as on Android.
    func isNew(after last: Int) -> Bool { seq > last }
}
