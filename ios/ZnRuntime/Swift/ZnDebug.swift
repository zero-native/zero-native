// Debug counters: how many times each node's SwiftUI body ran (the iOS counterpart of ZnDebug.countRecompositions
// on Android). After each batch the counts since the last report are logged, so a log shows exactly what one tap
// or one cursor blink redrew. Debug builds only; on with ZN_COUNT_BODIES=1.
import Foundation
import QuartzCore
import os

@MainActor
enum ZnDebug {
    static let enabled: Bool = {
        #if DEBUG
        return ProcessInfo.processInfo.environment["ZN_COUNT_BODIES"] == "1"
        #else
        return false
        #endif
    }()
    static let log = Logger(subsystem: "dev.zeronative", category: "zn")
    private static var counts: [String: Int] = [:]
    private static var reportPending = false
    private static var label = ""

    static func hit(_ s: ZnNodeSpec, _ inst: ZnInstance) {
        guard enabled else { return }
        hit(name: componentName(s.type), inst: inst, node: s.index)
    }

    static func hit(name: String, inst: ZnInstance, node: Int) {
        guard enabled else { return }
        counts["\(name)#\(inst.id).\(node)", default: 0] += 1
    }

    /// Logs the counts a little after a batch is applied (SwiftUI runs bodies when it next draws, not in apply).
    static func afterBatch(_ what: String) {
        guard enabled else { return }
        label = what
        guard !reportPending else { return }
        reportPending = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            reportPending = false
            let total = counts.values.reduce(0, +)
            let top = counts.sorted { $0.value > $1.value || ($0.value == $1.value && $0.key < $1.key) }
            let shown = top.prefix(12).map { "\($0.key)×\($0.value)" }.joined(separator: " ")
            print("zn bodies after \(label): \(total) body run(s) in \(counts.count) view(s): \(shown)")
            counts.removeAll()
        }
    }

    /// Milliseconds since the app started, for timing lines in the log.
    static func ms() -> String {
        String(format: "%.0f", (CACurrentMediaTime() - start) * 1000)
    }
    private static let start = CACurrentMediaTime()

    static func componentName(_ type: Int) -> String {
        names[type] ?? "C\(type)"
    }

    private static let names: [Int: String] = {
        typealias C = Registry.Component
        return [C.column: "Column", C.row: "Row", C.stack: "Stack", C.box: "Box", C.text: "Text", C.image: "Image",
                C.pressable: "Pressable", C.spacer: "Spacer", C.icon: "Icon", C.anchor: "Anchor", C.list: "List",
                C.scroll: "Scroll", C.carousel: "Carousel", C.sheet: "Sheet", C.fragment: "Fragment",
                C.textField: "TextField", C.svg: "Svg", C.switch: "Switch", C.checkbox: "Checkbox",
                C.spinner: "Spinner", C.progress: "Progress", C.shimmer: "Shimmer", C.tabs: "Tabs", C.modal: "Modal", C.canvas: "Canvas"]
    }()
}
