// <Canvas> (registry 24, android/runtime's ZnCanvas.kt and ZnCanvasImage.kt): draws a command list from JS (core
// canvas.ts), static or from a slot (commands, commandsSlot).
// - Parsed once per change (ZnCanvasParse.swift), drawn with Core Graphics in a plain UIView's draw(_:)
//   (ZnCanvasDraw.swift), as <Svg> is: not a SwiftUI Canvas, which once stopped showing frames after an empty first
//   one (ZnSvgView.swift). A slot write redraws only this node.
// - No size of its own (Android's Spacer): the style's width and height, or the stretch, size it.
// - Problems in the list: one warning per distinct text in the Xcode console ("zn: <Canvas> commands:"), as Android's
//   Log.w; the good commands still draw.
// - Images (draw.image): loaded per list, the same forms as <Image> (znImageURL: asset:, zn://file, http(s), file),
//   decoded at about the drawn size in pixels with ImageIO. One load per src and size; a picture the last list had at
//   the same size is used at once, so a list that changes every 500 ms doesn't blink, and a load still under way goes
//   on for the next list. Nothing is drawn while loading or after an error (one warning; not tried again while the
//   lists keep that picture). Loads stop when no list uses them any more or the canvas leaves.
// - Motion values in commands (gesture-driven charts, CanvasLab tiles 9-11) are not read on iOS yet: a warning, and
//   0 or black (canvas-motion-values).
import SwiftUI
import UIKit

struct ZnCanvasView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    @State private var model = ZnCanvasModel()
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let raw = s.commandsSlot >= 0 ? inst.slot(s.commandsSlot).value.string : s.commands
        ZnCanvasSurface(commands: model.commands(raw, scale: displayScale), model: model)
            .onAppear { model.shown = true }
            .onDisappear { model.leave() }
    }
}

/// The parsed list of one canvas, its image loads and the pictures it keeps.
@MainActor
final class ZnCanvasModel {
    private var raw: String?
    private var scale: CGFloat = 0
    private var parsed = ZnCanvasCommands.empty
    private var lastReported: String?
    /// Pictures by "src|WxH": this list's, kept for the next one.
    private var kept: [String: CGImage] = [:]
    /// Loads under way by key, with the image ops of the newest list waiting for each.
    private var loading: [String: Loading] = [:]
    /// Keys that failed: not tried again while the lists keep them (a 404 in a chart that changes every 500 ms).
    private var failed = Set<String>()
    /// The list the loads were started for.
    private weak var loadsFor: ZnCanvasCommands?
    weak var view: ZnCanvasSurface.View?
    var shown = false {
        didSet { if shown, oldValue == false { startLoads(parsed) } }
    }

    /// The list for [raw], parsed again only when it changed.
    func commands(_ raw: String?, scale: CGFloat) -> ZnCanvasCommands {
        if raw == self.raw && scale == self.scale { return parsed }
        self.raw = raw
        self.scale = scale
        parsed = znParseCanvasCommands(raw, density: 1, pixels: scale > 0 ? scale : 1)
        report(parsed)
        return parsed
    }

    /// One warning per list (not per draw); the same text again (a chart that updates every 500 ms with the same
    /// mistake) is not printed again by this canvas.
    private func report(_ c: ZnCanvasCommands) {
        guard !c.errors.isEmpty else { return }
        let text = c.errors.joined(separator: "\n")
        guard text != lastReported else { return }
        lastReported = text
        print("zn: <Canvas> commands:\n\(text)")
    }

    /// Starts the loads for [c]'s images, once per list. A load the last list started for the same key goes on and
    /// fills this list's ops (Android starts it again), so a picture slower than the list's changes still shows.
    func startLoads(_ c: ZnCanvasCommands) {
        guard shown, loadsFor !== c else { return }
        loadsFor = c
        var used = Set<String>()
        var waiting: [String: [ZnCanvasOp.Image]] = [:]
        var order: [String] = []
        for case let op as ZnCanvasOp.Image in c.ops {
            let key = op.key
            used.insert(key)
            if let have = kept[key] {
                op.image = have
            } else if waiting[key] == nil {
                waiting[key] = [op]
                order.append(key)
            } else {
                waiting[key]?.append(op)  // the same picture twice in one list: one load
            }
        }
        // Loads this list doesn't use stop; only this list's pictures (and failures) stay.
        for (key, l) in loading where !used.contains(key) {
            l.task?.cancel()
            loading[key] = nil
        }
        kept = kept.filter { used.contains($0.key) }
        failed = failed.filter { used.contains($0) }
        for key in order {
            guard let ops = waiting[key], let first = ops.first, !failed.contains(key) else { continue }
            if let l = loading[key] {
                l.ops = ops
                continue
            }
            guard let url = znImageURL(first.src) else {
                failed.insert(key)
                print("zn: <Canvas> image \(first.src) can't load on iOS (asset:, zn://file, http(s) and file URLs can)")
                continue
            }
            let l = Loading(ops)
            loading[key] = l
            let src = first.src, w = first.decodeW, h = first.decodeH
            l.task = Task { [weak self] in
                do {
                    let image = try await ZnCanvasModel.load(url, w, h)
                    guard !Task.isCancelled, let self, self.loading[key] === l else { return }
                    self.loading[key] = nil
                    self.kept[key] = image
                    for o in l.ops { o.image = image }
                    self.view?.setNeedsDisplay()
                } catch {
                    guard !Task.isCancelled, let self, self.loading[key] === l else { return }
                    self.loading[key] = nil
                    self.failed.insert(key)
                    print("zn: <Canvas> image failed: \(src) — \(error.localizedDescription)")
                }
            }
        }
    }

    /// A load under way and the image ops waiting for it.
    private final class Loading {
        var ops: [ZnCanvasOp.Image]
        var task: Task<Void, Never>?
        init(_ ops: [ZnCanvasOp.Image]) { self.ops = ops }
    }

    /// The canvas left the screen: its loads stop (they start again when it comes back).
    func leave() {
        shown = false
        for l in loading.values { l.task?.cancel() }
        loading = [:]
        loadsFor = nil
    }

    /// The bytes off the main thread, then decoded at about [w] × [h] pixels.
    private nonisolated static func load(_ url: URL, _ w: Int, _ h: Int) async throws -> CGImage {
        let data: Data
        if url.isFileURL {
            data = try await Task.detached { try Data(contentsOf: url) }.value
        } else {
            let (d, response) = try await URLSession.shared.data(from: url)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw ZnImageError("HTTP \(http.statusCode)")
            }
            data = d
        }
        try Task.checkCancellation()
        let image = await Task.detached(priority: .userInitiated) { znCanvasDecode(data, w, h) }.value
        guard let image else { throw ZnImageError("not a picture") }
        return image
    }
}

/// The UIView the list is drawn in. Sized by its frame only (Android's Spacer).
struct ZnCanvasSurface: UIViewRepresentable {
    let commands: ZnCanvasCommands
    let model: ZnCanvasModel

    final class View: UIView {
        var commands = ZnCanvasCommands.empty

        override func draw(_ rect: CGRect) {
            guard !commands.ops.isEmpty, let cg = UIGraphicsGetCurrentContext() else { return }
            znDrawCanvas(cg, commands, size: bounds.size)
        }
    }

    func makeUIView(context: Context) -> View {
        let v = View()
        v.isOpaque = false
        v.backgroundColor = .clear
        v.contentMode = .redraw
        v.isUserInteractionEnabled = false
        model.view = v
        return v
    }

    func updateUIView(_ v: View, context: Context) {
        model.view = v
        if v.commands !== commands {
            v.commands = commands
            v.setNeedsDisplay()
        }
        model.startLoads(commands)
    }

    /// No size of its own: what it is offered, or nothing.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: View, context: Context) -> CGSize? {
        func side(_ v: CGFloat?) -> CGFloat { if let v, v.isFinite { return max(v, 0) } else { return 0 } }
        return CGSize(width: side(proposal.width), height: side(proposal.height))
    }
}
