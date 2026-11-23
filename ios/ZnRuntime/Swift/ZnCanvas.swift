// <Canvas> (registry 24, android/runtime's ZnCanvas.kt and ZnCanvasImage.kt): draws a command list from JS (core
// canvas.ts), static or from a slot (commands, commandsSlot).
// - Parsed once per change (ZnCanvasParse.swift), drawn with Core Graphics in a plain UIView's draw(_:)
//   (ZnCanvasDraw.swift), as <Svg> is: not a SwiftUI Canvas, which once stopped showing frames after an empty first
//   one (ZnSvgView.swift). A slot write redraws only this node.
// - No size of its own (Android's Spacer): an axis is 0 unless a width / height (points or "%"), an aspectRatio, a
//   stretch or a flex sizes it, or a minWidth / minHeight raises it. (Before 2026-11-21 it took all it was offered, so
//   a Canvas with only a width filled the rest of a Column.)
// - Problems in the list: one warning per distinct text in the Xcode console ("zn: <Canvas> commands:"), as Android's
//   Log.w; the good commands still draw.
// - Images (draw.image): loaded per list, the same forms as <Image> (znImageURL: asset:, zn://file, http(s), file),
//   decoded at about the drawn size in pixels with ImageIO. One load per src and size; a picture the last list had at
//   the same size is used at once, so a list that changes every 500 ms doesn't blink, and a load still under way goes
//   on for the next list. Nothing is drawn while loading or after an error (one warning; not tried again while the
//   lists keep that picture). Loads stop when no list uses them any more or the canvas leaves.
// - Motion values in commands (gesture-driven charts, a ring that springs, a path that draws itself: CanvasLab tiles
//   9-11) are found once per list and read in draw(_:), watched with Observation (ZnCanvasWatch, one watch at a time
//   per view): a value of the list that moves (its ZnCell, an @Observable) marks this view for a draw, so it redraws
//   on that frame with no JS, no SwiftUI update and no new parse, as Android's drawBehind. A canvas with no motion
//   values tracks nothing. One out of the window (a screen pushed over it) isn't drawn, and draws once when it's back;
//   one only scrolled out of sight still draws each frame, as on Android (CanvasLab tile 19: about 0.1-0.2 ms a frame
//   on the CPU). A value not made yet when the list was read: read again once sources arrive
//   (ZnMotionEngine.generation). Sources are found once per list, as Android: JS ids only go up, and a reload or an
//   OTA applied in place builds a new tree (ZnApp.restart), so a list never holds a source another took the id of.
// - ZN_CANVAS_TIMING=1 prints how long moving canvases take to draw, every 120 draws.
import SwiftUI
import UIKit

struct ZnCanvasView: View {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance
    /// What the parent stretches or flexes this node to fill.
    let outer: ZnOuter

    @State private var model = ZnCanvasModel()
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let raw = s.commandsSlot >= 0 ? inst.slot(s.commandsSlot).value.string : s.commands
        // Axes that fill what they are offered; the others are 0 or the min, as a Spacer with the same modifiers.
        let fillW = outer.fillWidth || s.hasWidth || s.hasAspectRatio
        let fillH = outer.fillHeight || s.hasHeight || s.hasAspectRatio
        ZnCanvasSurface(commands: model.commands(raw, scale: displayScale), model: model,
                        fillW: fillW, fillH: fillH,
                        minW: fillW ? 0 : max(s.minWidthNow(inst) ?? 0, 0), minH: fillH ? 0 : max(s.minHeightNow(inst) ?? 0, 0))
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

    /// The generation the list was read at, when a motion value in it was missing.
    private var missedAt = -1

    /// The list for [raw], parsed again only when it changed, or when a motion value it missed may be there now. Runs
    /// in the SwiftUI body: the generation read makes SwiftUI call it again when sources arrive (only while missing).
    func commands(_ raw: String?, scale: CGFloat) -> ZnCanvasCommands {
        let missing = parsed.missed && ZnMotionEngine.shared.generation.n != missedAt
        if raw == self.raw && scale == self.scale && !missing { return parsed }
        self.raw = raw
        self.scale = scale
        let px = scale > 0 ? scale : 1
        let s = (view?.window?.windowScene?.screen ?? UIScreen.main).bounds.size
        parsed = znParseCanvasCommands(raw, density: 1, pixels: px, screen: max(s.width, s.height) * px)
        missedAt = parsed.missed ? ZnMotionEngine.shared.generation.n : -1
        report(parsed)
        return parsed
    }

    /// One warning per list (not per draw); the same text again (a chart that updates every 500 ms with the same
    /// mistake) is not printed again by this canvas.
    private func report(_ c: ZnCanvasCommands) {
        guard !c.errors.isEmpty else { return }
        if c.missed {
            // A motion value made by a module call that reaches the main thread just after the list: no warning if
            // the list read again by then finds it.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self, weak c] in
                guard let self, let c, self.parsed === c else { return }
                self.warn(c)
            }
            return
        }
        warn(c)
    }

    private func warn(_ c: ZnCanvasCommands) {
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
        var reused = false
        var waiting: [String: [ZnCanvasOp.Image]] = [:]
        var order: [String] = []
        for case let op as ZnCanvasOp.Image in c.ops {
            let key = op.key
            used.insert(key)
            if let have = kept[key] {
                op.image = have
                reused = true
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
        // Pictures set from kept need a draw too: a list that came while hidden drew without them (the loads only
        // start once it shows again), and nothing else redraws it.
        if reused { view?.setNeedsDisplay() }
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

    /// The canvas left the screen: its loads stop (they start again when it comes back), and failed pictures are tried
    /// again then (the network may be back), as a new composition does on Android.
    func leave() {
        shown = false
        for l in loading.values { l.task?.cancel() }
        loading = [:]
        failed = []
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
    /// Axes that take what they are offered (a set size, a stretch, a flex); the others are [minW] / [minH] or 0.
    let fillW: Bool, fillH: Bool
    let minW: CGFloat, minH: CGFloat

    final class View: UIView {
        var commands = ZnCanvasCommands.empty
        /// The motion values of a moving list: when one moves, this view draws again on that frame.
        private lazy var watch = ZnCanvasWatch { [weak self] in self?.setNeedsDisplay() }

        override func draw(_ rect: CGRect) {
            guard !commands.ops.isEmpty, let cg = UIGraphicsGetCurrentContext() else { return }
            let c = commands
            let t0 = ZnCanvasTiming.on && c.moving ? CFAbsoluteTimeGetCurrent() : 0
            watch.draw(c) { znDrawCanvas(cg, c, size: bounds.size) }
            if t0 > 0 { ZnCanvasTiming.add(CFAbsoluteTimeGetCurrent() - t0, bounds.size, contentScaleFactor) }
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

    /// No size of its own: what it is offered on a filled axis, else the min or nothing.
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: View, context: Context) -> CGSize? {
        func side(_ v: CGFloat?, _ fill: Bool, _ lo: CGFloat) -> CGFloat {
            guard fill else { return lo }
            if let v, v.isFinite { return max(v, 0) } else { return 0 }
        }
        return CGSize(width: side(proposal.width, fillW, minW), height: side(proposal.height, fillH, minH))
    }
}

/// How long moving canvases take to draw (the whole list, blurs included), printed every 120 draws when the app runs
/// with ZN_CANVAS_TIMING=1 (main thread only). The draw is on the CPU into the view's backing store; Core Animation
/// sends it to the GPU after.
enum ZnCanvasTiming {
    static let on = ProcessInfo.processInfo.environment["ZN_CANVAS_TIMING"] == "1"
    nonisolated(unsafe) private static var runs = 0
    nonisolated(unsafe) private static var total: Double = 0
    nonisolated(unsafe) private static var worst: Double = 0
    nonisolated(unsafe) private static var pixels = 0

    static func add(_ seconds: Double, _ size: CGSize, _ scale: CGFloat) {
        runs += 1
        total += seconds
        worst = max(worst, seconds)
        pixels = max(pixels, Int(size.width * scale) * Int(size.height * scale))
        guard runs == 120 else { return }
        print(String(format: "zn: moving canvases: 120 draws, %.2f ms each on average, %.2f ms the slowest, up to %d px",
                     total / 120 * 1000, worst * 1000, pixels))
        runs = 0; total = 0; worst = 0; pixels = 0
    }
}
