// <Canvas> command list (registry 24; core canvas.ts) → ops to draw, as android/runtime's ZnCanvas.kt parseCanvasCommands.
// Foundation and CoreGraphics only, so the Mac tests (ios/tests/draw) build it. Rules, the same as Android's, so a bad
// list never crashes the app (ZeroBill takes payments on this runtime):
// - Everything is checked here: numbers must be finite, a gradient needs 2+ colours, a dash an even length. A bad
//   command is dropped (or drawn in a safe way) and named in one warning per list. The error texts match Android's.
// - Colours come as ARGB numbers (core's parseColor). A string is a warning and draws black.
// - Units: iOS points are dp, so the app parses with density 1. [pixels] is device pixels per unit after density
//   (the screen scale on iOS, 1 on Android, where units are px): the thinnest stroke is one pixel, and an image is
//   decoded at about its drawn size in pixels.
// - A number (or a paint colour) may follow a motion value ("\u{0}m<id>", core motion.ts): its source is found once
//   here (ZnMotionEngine.ref) and read on each draw, so a moving value redraws this canvas only, with no new parse and
//   no JS (ZnCanvas.swift). One that is gone is a warning and draws 0, or black for a colour, as on Android.
// Main thread only (the motion engine is).
import CoreGraphics
import Foundation

let znMaxCanvasCommands = 10000

/// At most this many problems are listed in one warning; the rest are counted.
private let maxListedErrors = 10

/// What a slot holds for a motion value (core motion.ts).
private let motionRef = "\u{0}m"

/// A number of a command: a constant, already times its scale (density for positions, 1 for angles and fractions), or a
/// motion value read on each draw and times [scale] (Android's CNum).
struct ZnCanvasNum: Equatable {
    let const: CGFloat
    let src: ZnSource?
    let scale: CGFloat

    init(const: CGFloat, src: ZnSource? = nil, scale: CGFloat = 1) {
        self.const = const; self.src = src; self.scale = scale
    }

    var value: CGFloat {
        guard let src else { return const }
        return CGFloat(src.read(nil)) * scale
    }

    /// The value now, for sizes worked out once (an image's decode size).
    func initial() -> CGFloat { value }
    static func of(_ v: CGFloat) -> ZnCanvasNum { ZnCanvasNum(const: v) }

    static func == (a: ZnCanvasNum, b: ZnCanvasNum) -> Bool { a.const == b.const && a.src === b.src && a.scale == b.scale }
}

/// A colour: an ARGB number, or a motion colour (v.mapColor, a derive ending in interpolateColor) read on each draw.
struct ZnCanvasColor: Equatable {
    let argb: UInt32
    let src: ZnSource?

    init(argb: UInt32, src: ZnSource? = nil) { self.argb = argb; self.src = src }

    var value: UInt32 { src?.readColor(nil) ?? argb }
    static let black = ZnCanvasColor(argb: 0xFF00_0000)

    static func == (a: ZnCanvasColor, b: ZnCanvasColor) -> Bool { a.argb == b.argb && a.src === b.src }
}

/// A gradient in the paint's units. Stops are 0...1, one per colour, or nil for evenly spread colours.
enum ZnCanvasGradient: Equatable {
    case linear(start: CGPoint, end: CGPoint, colors: [UInt32], stops: [CGFloat]?)
    case radial(center: CGPoint, radius: CGFloat, colors: [UInt32], stops: [CGFloat]?)
    /// Round the centre from 3 o'clock, clockwise, turned by startAngle degrees.
    case sweep(center: CGPoint, colors: [UInt32], stops: [CGFloat]?, startAngle: CGFloat)

    var colors: [UInt32] {
        switch self {
        case .linear(_, _, let c, _), .radial(_, _, let c, _), .sweep(_, let c, _, _): return c
        }
    }

    var stops: [CGFloat]? {
        switch self {
        case .linear(_, _, _, let s), .radial(_, _, _, let s), .sweep(_, _, let s, _): return s
        }
    }
}

struct ZnCanvasShadow: Equatable {
    let dx: CGFloat, dy: CGFloat, blur: CGFloat
    let color: UInt32
}

/// Blend modes by their JS names (Compose's BlendMode, which is Skia's), as Core Graphics modes.
let znCanvasBlendModes: [String: CGBlendMode] = [
    "srcOver": .normal, "multiply": .multiply, "screen": .screen, "overlay": .overlay, "darken": .darken,
    "lighten": .lighten, "plus": .plusLighter, "clear": .clear, "srcIn": .sourceIn, "srcOut": .sourceOut,
    "srcAtop": .sourceAtop, "dstIn": .destinationIn, "dstOut": .destinationOut, "dstOver": .destinationOver,
    "dstAtop": .destinationAtop, "xor": .xor,
]

/// Paint for one command, in its units (a path's are dp: it is drawn under scale(density)).
final class ZnCanvasPaint {
    let color: ZnCanvasColor
    let opacity: ZnCanvasNum
    let gradient: ZnCanvasGradient?
    let isStroke: Bool
    let strokeWidth: ZnCanvasNum
    /// One device pixel in this paint's units: the thinnest stroke.
    let minWidth: CGFloat
    let cap: CGLineCap
    let join: CGLineJoin
    let dash: [CGFloat]?
    let evenOdd: Bool
    let blend: CGBlendMode
    let shadow: ZnCanvasShadow?
    /// Blur radius in this paint's units; 0 for none.
    let blur: CGFloat

    init(color: ZnCanvasColor, opacity: ZnCanvasNum, gradient: ZnCanvasGradient?, isStroke: Bool, strokeWidth: ZnCanvasNum,
         minWidth: CGFloat, cap: CGLineCap, join: CGLineJoin, dash: [CGFloat]?, evenOdd: Bool, blend: CGBlendMode,
         shadow: ZnCanvasShadow?, blur: CGFloat) {
        self.color = color
        self.opacity = opacity
        self.gradient = gradient
        self.isStroke = isStroke
        self.strokeWidth = strokeWidth
        self.minWidth = minWidth
        self.cap = cap
        self.join = join
        self.dash = dash
        self.evenOdd = evenOdd
        self.blend = blend
        self.shadow = shadow
        self.blur = blur
    }

    /// True when it needs a shadow or a blur.
    var hasFx: Bool { shadow != nil || blur > 0 }

    func width() -> CGFloat { max(strokeWidth.value, minWidth) }

    func alpha() -> CGFloat { min(max(opacity.value, 0), 1) }

    /// The gradient as Core Graphics draws it, made on the first draw and kept with the list.
    lazy var cgGradient: CGGradient? = {
        guard let g = gradient else { return nil }
        let colors = g.colors.map { c in
            CGColor(srgbRed: CGFloat(c >> 16 & 0xFF) / 255, green: CGFloat(c >> 8 & 0xFF) / 255,
                    blue: CGFloat(c & 0xFF) / 255, alpha: CGFloat(c >> 24 & 0xFF) / 255)
        }
        // Core Graphics needs rising stops; Skia pins one that goes back to the one before it, so do the same.
        var locations: [CGFloat]? = nil
        if let s = g.stops {
            var prev: CGFloat = 0
            locations = s.map { v in prev = max(prev, v); return prev }
        }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB) else { return nil }
        return CGGradient(colorsSpace: space, colors: colors as CFArray, locations: locations)
    }()
}

let znFitCover = 0
let znFitContain = 1
let znFitFill = 2

/// One parsed command. Positions and sizes are in points (dp × density), except a path's, which stay in dp.
class ZnCanvasOp {
    final class Rect: ZnCanvasOp {
        let x: ZnCanvasNum, y: ZnCanvasNum, w: ZnCanvasNum, h: ZnCanvasNum, paint: ZnCanvasPaint
        init(_ x: ZnCanvasNum, _ y: ZnCanvasNum, _ w: ZnCanvasNum, _ h: ZnCanvasNum, _ paint: ZnCanvasPaint) {
            self.x = x; self.y = y; self.w = w; self.h = h; self.paint = paint
        }
    }

    final class RoundRect: ZnCanvasOp {
        let x: ZnCanvasNum, y: ZnCanvasNum, w: ZnCanvasNum, h: ZnCanvasNum, r: ZnCanvasNum, paint: ZnCanvasPaint
        init(_ x: ZnCanvasNum, _ y: ZnCanvasNum, _ w: ZnCanvasNum, _ h: ZnCanvasNum, _ r: ZnCanvasNum, _ paint: ZnCanvasPaint) {
            self.x = x; self.y = y; self.w = w; self.h = h; self.r = r; self.paint = paint
        }
    }

    final class Circle: ZnCanvasOp {
        let cx: ZnCanvasNum, cy: ZnCanvasNum, r: ZnCanvasNum, paint: ZnCanvasPaint
        init(_ cx: ZnCanvasNum, _ cy: ZnCanvasNum, _ r: ZnCanvasNum, _ paint: ZnCanvasPaint) {
            self.cx = cx; self.cy = cy; self.r = r; self.paint = paint
        }
    }

    final class Oval: ZnCanvasOp {
        let x: ZnCanvasNum, y: ZnCanvasNum, w: ZnCanvasNum, h: ZnCanvasNum, paint: ZnCanvasPaint
        init(_ x: ZnCanvasNum, _ y: ZnCanvasNum, _ w: ZnCanvasNum, _ h: ZnCanvasNum, _ paint: ZnCanvasPaint) {
            self.x = x; self.y = y; self.w = w; self.h = h; self.paint = paint
        }
    }

    final class Line: ZnCanvasOp {
        let x1: ZnCanvasNum, y1: ZnCanvasNum, x2: ZnCanvasNum, y2: ZnCanvasNum, paint: ZnCanvasPaint
        init(_ x1: ZnCanvasNum, _ y1: ZnCanvasNum, _ x2: ZnCanvasNum, _ y2: ZnCanvasNum, _ paint: ZnCanvasPaint) {
            self.x1 = x1; self.y1 = y1; self.x2 = x2; self.y2 = y2; self.paint = paint
        }
    }

    final class Arc: ZnCanvasOp {
        let x: ZnCanvasNum, y: ZnCanvasNum, w: ZnCanvasNum, h: ZnCanvasNum, start: ZnCanvasNum, sweep: ZnCanvasNum
        let useCenter: Bool, paint: ZnCanvasPaint
        init(_ x: ZnCanvasNum, _ y: ZnCanvasNum, _ w: ZnCanvasNum, _ h: ZnCanvasNum, _ start: ZnCanvasNum,
             _ sweep: ZnCanvasNum, _ useCenter: Bool, _ paint: ZnCanvasPaint) {
            self.x = x; self.y = y; self.w = w; self.h = h; self.start = start; self.sweep = sweep
            self.useCenter = useCenter; self.paint = paint
        }
    }

    /// Path data in dp, drawn under scale(density); its paint is in dp too. With a trim only a piece of it is drawn,
    /// cut with ZnPathMeasure (ZnSvgGeometry.swift) into one reused path, as <Svg> trims are.
    final class PathOp: ZnCanvasOp {
        let path: CGPath
        let paint: ZnCanvasPaint
        let trimStart: ZnCanvasNum?, trimEnd: ZnCanvasNum?, trimOffset: ZnCanvasNum?
        var trimmed: Bool { trimStart != nil || trimEnd != nil || trimOffset != nil }
        private lazy var measure = ZnPathMeasure(path)
        private var piece = CGMutablePath()

        init(_ path: CGPath, _ paint: ZnCanvasPaint, _ trimStart: ZnCanvasNum?, _ trimEnd: ZnCanvasNum?, _ trimOffset: ZnCanvasNum?) {
            self.path = path; self.paint = paint
            self.trimStart = trimStart; self.trimEnd = trimEnd; self.trimOffset = trimOffset
        }

        /// The path to draw now: all of it, its trimmed piece, or nil when nothing of it shows.
        func visible() -> CGPath? {
            if !trimmed { return path }
            let total = measure.lengths.reduce(0, +)
            guard let r = znTrimRanges(trimStart?.value ?? 0, trimEnd?.value ?? 1, trimOffset?.value ?? 0, total) else { return path }
            piece = CGMutablePath()
            var any = segment(r[0], r[1])
            if r[2] >= 0 && r[3] > r[2] && segment(r[2], r[3]) { any = true }
            return any ? piece : nil
        }

        /// Adds the piece from [a] to [b] (lengths along all contours).
        private func segment(_ a: CGFloat, _ b: CGFloat) -> Bool {
            guard b > a else { return false }
            var c0: CGFloat = 0
            var any = false
            for (i, len) in measure.lengths.enumerated() {
                let c1 = c0 + len
                let x0 = max(a, c0), x1 = min(b, c1)
                if x1 > x0 && measure.segment(i, x0 - c0, x1 - c0, into: piece) { any = true }
                c0 = c1
                if c0 >= b { break }
            }
            return any
        }
    }

    /// [fontSize] in dp; [x] / [y] in points, [y] is the baseline. [align]: 0 left, 1 center, 2 right.
    final class Text: ZnCanvasOp {
        let text: String
        let x: ZnCanvasNum, y: ZnCanvasNum
        let fontSize: CGFloat
        let fontWeight: Int?
        let color: ZnCanvasColor
        let align: Int
        /// The laid-out line, made on the first draw (ZnCanvasDraw.swift).
        var made: AnyObject?
        init(_ text: String, _ x: ZnCanvasNum, _ y: ZnCanvasNum, _ fontSize: CGFloat, _ fontWeight: Int?, _ color: ZnCanvasColor, _ align: Int) {
            self.text = text; self.x = x; self.y = y; self.fontSize = fontSize; self.fontWeight = fontWeight
            self.color = color; self.align = align
        }
    }

    /// Text that wraps at [width] points; [y] is the top. [lineHeight] in points, 0 for the font's own. [align]: 0 left,
    /// 1 center, 2 right. The lines are laid out once, on the first draw.
    final class Paragraph: ZnCanvasOp {
        let text: String
        let x: ZnCanvasNum, y: ZnCanvasNum
        let width: CGFloat
        let fontSizePx: CGFloat
        let fontWeight: Int?
        let color: ZnCanvasColor
        let align: Int
        let lineHeight: CGFloat
        let maxLines: Int
        var made: AnyObject?
        init(_ text: String, _ x: ZnCanvasNum, _ y: ZnCanvasNum, _ width: CGFloat, _ fontSizePx: CGFloat, _ fontWeight: Int?,
             _ color: ZnCanvasColor, _ align: Int, _ lineHeight: CGFloat, _ maxLines: Int) {
            self.text = text; self.x = x; self.y = y; self.width = width; self.fontSizePx = fontSizePx
            self.fontWeight = fontWeight; self.color = color; self.align = align; self.lineHeight = lineHeight
            self.maxLines = maxLines
        }
    }

    /// An image from [src] (the same forms as <Image>), decoded at about [decodeW] × [decodeH] pixels (ZnCanvas.swift).
    /// Nothing is drawn while it loads or after an error. [fit]: znFitCover, znFitContain, znFitFill.
    final class Image: ZnCanvasOp {
        let src: String
        let x: ZnCanvasNum, y: ZnCanvasNum, w: ZnCanvasNum, h: ZnCanvasNum
        let fit: Int
        let radius: ZnCanvasNum?
        let opacity: ZnCanvasNum
        let decodeW: Int, decodeH: Int
        /// Main thread only.
        var image: CGImage?
        var key: String { "\(src)|\(decodeW)x\(decodeH)" }
        init(_ src: String, _ x: ZnCanvasNum, _ y: ZnCanvasNum, _ w: ZnCanvasNum, _ h: ZnCanvasNum, _ fit: Int,
             _ radius: ZnCanvasNum?, _ opacity: ZnCanvasNum, _ decodeW: Int, _ decodeH: Int) {
            self.src = src; self.x = x; self.y = y; self.w = w; self.h = h; self.fit = fit; self.radius = radius
            self.opacity = opacity; self.decodeW = decodeW; self.decodeH = decodeH
        }
    }

    final class Translate: ZnCanvasOp {
        let dx: ZnCanvasNum, dy: ZnCanvasNum
        init(_ dx: ZnCanvasNum, _ dy: ZnCanvasNum) { self.dx = dx; self.dy = dy }
    }

    final class Scale: ZnCanvasOp {
        let sx: ZnCanvasNum, sy: ZnCanvasNum
        init(_ sx: ZnCanvasNum, _ sy: ZnCanvasNum) { self.sx = sx; self.sy = sy }
    }

    final class Rotate: ZnCanvasOp {
        let degrees: ZnCanvasNum, px: ZnCanvasNum, py: ZnCanvasNum
        init(_ degrees: ZnCanvasNum, _ px: ZnCanvasNum, _ py: ZnCanvasNum) { self.degrees = degrees; self.px = px; self.py = py }
    }

    final class ClipRect: ZnCanvasOp {
        let x: ZnCanvasNum, y: ZnCanvasNum, w: ZnCanvasNum, h: ZnCanvasNum
        let difference: Bool
        init(_ x: ZnCanvasNum, _ y: ZnCanvasNum, _ w: ZnCanvasNum, _ h: ZnCanvasNum, _ difference: Bool) {
            self.x = x; self.y = y; self.w = w; self.h = h; self.difference = difference
        }
    }

    final class ClipRoundRect: ZnCanvasOp {
        let x: ZnCanvasNum, y: ZnCanvasNum, w: ZnCanvasNum, h: ZnCanvasNum, r: ZnCanvasNum
        let difference: Bool
        init(_ x: ZnCanvasNum, _ y: ZnCanvasNum, _ w: ZnCanvasNum, _ h: ZnCanvasNum, _ r: ZnCanvasNum, _ difference: Bool) {
            self.x = x; self.y = y; self.w = w; self.h = h; self.r = r; self.difference = difference
        }
    }

    /// Path data already in points ([scale] applied at parse): a clip stays after this command.
    final class ClipPath: ZnCanvasOp {
        let path: CGPath
        let scale: CGFloat
        let evenOdd: Bool
        let difference: Bool
        init(_ path: CGPath, _ scale: CGFloat, _ evenOdd: Bool, _ difference: Bool) {
            self.path = path; self.scale = scale; self.evenOdd = evenOdd; self.difference = difference
        }
    }

    final class Save: ZnCanvasOp {}
    final class Restore: ZnCanvasOp {}
}

/// A parsed command list: what to draw, and the problems found (empty when all is well).
final class ZnCanvasCommands {
    let ops: [ZnCanvasOp]
    let errors: [String]
    /// A blend mode other than srcOver: the list draws into its own layer.
    let needsLayer: Bool
    /// Points per dp: a path is drawn under scale(density).
    let density: CGFloat
    /// Some number or colour follows a motion value: the canvas draws again when one moves (ZnCanvas.swift).
    let moving: Bool
    /// Some motion value wasn't there when the list was read (not made yet, or disposed with nothing kept): the list
    /// is read again once more sources arrive (ZnMotionEngine.generation).
    let missed: Bool

    init(_ ops: [ZnCanvasOp], _ errors: [String], needsLayer: Bool = false, density: CGFloat = 1, moving: Bool = false,
         missed: Bool = false) {
        self.ops = ops; self.errors = errors; self.needsLayer = needsLayer; self.density = density
        self.moving = moving; self.missed = missed
    }

    static let empty = ZnCanvasCommands([], [])
}

/// Parses the command list once per change. [density] turns dp into units (1 on iOS; paths stay in dp). [screen] is
/// the screen's longer side in pixels: an image whose size follows a motion value is decoded at it. Never traps: bad
/// JSON or a list over znMaxCanvasCommands gives nothing to draw and an error; a bad command is dropped (or made safe)
/// and named.
func znParseCanvasCommands(_ json: String?, density: CGFloat = 1, pixels: CGFloat = 1, screen: CGFloat = 2048) -> ZnCanvasCommands {
    guard let json, !json.isEmpty, json != "[]", json != "null" else { return .empty }
    let any: Any
    do {
        any = try JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])
    } catch {
        return ZnCanvasCommands([], ["commands are not a JSON array: \(error.localizedDescription)"])
    }
    guard let array = any as? [Any] else {
        return ZnCanvasCommands([], ["commands are not a JSON array: it is not a list"])
    }
    // Counted before any command is built.
    if array.count > znMaxCanvasCommands {
        return ZnCanvasCommands([], ["\(array.count) commands, more than the \(znMaxCanvasCommands) allowed; nothing is drawn"])
    }
    let d = density.isFinite && density > 0 ? density : 1
    let px = pixels.isFinite && pixels > 0 ? pixels : 1
    var p = ZnCanvasParser(d: d, pixels: px, screen: screen.isFinite && screen > 0 ? screen : 2048)
    return p.parse(array)
}

/// A command that can't be drawn at all; its message names the field.
private struct BadCommand: Error {
    let message: String
    init(_ m: String) { message = m }
}

private func isBool(_ v: Any?) -> Bool {
    guard let n = v as? NSNumber else { return false }
    return CFGetTypeID(n) == CFBooleanGetTypeID()
}

/// A JSON number (not a boolean), or nil.
private func jsonNumber(_ v: Any?) -> Double? {
    guard let n = v as? NSNumber, !isBool(n) else { return nil }
    return n.doubleValue
}

/// Present and not null (org.json's has && !isNull).
private func given(_ o: [String: Any], _ key: String) -> Bool {
    guard let v = o[key] else { return false }
    return !(v is NSNull)
}

/// org.json's optString: "" when missing or null, the value as text otherwise.
private func optString(_ o: [String: Any]?, _ key: String) -> String {
    guard let o, let v = o[key], !(v is NSNull) else { return "" }
    if let s = v as? String { return s }
    if isBool(v) { return (v as? NSNumber)?.boolValue == true ? "true" : "false" }
    if let n = jsonNumber(v) { return shownNumber(n) }
    return "\(v)"
}

/// A number as Kotlin prints it: 5, not 5.0, for a whole one.
private func shownNumber(_ n: Double) -> String {
    if n == n.rounded(), abs(n) < 1e15 { return String(Int64(n)) }
    return "\(n)"
}

private func shown(_ v: Any?) -> String {
    guard let v else { return "null" }
    if v is NSNull { return "null" }
    if let s = v as? String { return "\"\(s)\"" }
    if isBool(v) { return (v as? NSNumber)?.boolValue == true ? "true" : "false" }
    if let n = jsonNumber(v) { return shownNumber(n) }
    return "\(v)"
}

private struct ZnCanvasParser {
    let d: CGFloat
    let pixels: CGFloat
    private var errors: [String] = []
    private var errorCount = 0
    private var index = 0
    private var blends = false
    let screen: CGFloat
    private var moving = false
    private var missed = false

    init(d: CGFloat, pixels: CGFloat, screen: CGFloat) {
        self.d = d
        self.pixels = pixels
        self.screen = screen
    }

    static let zero = ZnCanvasNum.of(0)
    static let one = ZnCanvasNum.of(1)

    mutating func error(_ message: String) {
        errorCount += 1
        if errors.count < maxListedErrors { errors.append("command \(index): \(message)") }
    }

    mutating func parse(_ array: [Any]) -> ZnCanvasCommands {
        var ops: [ZnCanvasOp] = []
        ops.reserveCapacity(array.count)
        var depth = 0
        for (i, item) in array.enumerated() {
            index = i
            // `[a, cond && draw.circle(...)]`: null and false are skipped without an error.
            if item is NSNull || (isBool(item) && (item as? NSNumber)?.boolValue == false) { continue }
            guard let o = item as? [String: Any] else {
                error("not a command object")
                continue
            }
            do {
                let op = try command(o)
                if op is ZnCanvasOp.Save {
                    depth += 1
                } else if op is ZnCanvasOp.Restore {
                    if depth == 0 {
                        error("restore without a save; skipped")
                        continue
                    }
                    depth -= 1
                }
                ops.append(op)
            } catch let e as BadCommand {
                error("\(e.message); skipped")
            } catch let e {
                self.error("\(e); skipped")
            }
        }
        if errorCount > errors.count { errors.append("and \(errorCount - errors.count) more") }
        return ZnCanvasCommands(ops, errors, needsLayer: blends, density: d, moving: moving, missed: missed)
    }

    private mutating func command(_ o: [String: Any]) throws -> ZnCanvasOp {
        let type = optString(o, "type")
        switch type {
        case "rect":
            return ZnCanvasOp.Rect(try pxV(o, "x"), try pxV(o, "y"), try pxV(o, "w"), try pxV(o, "h"), try paint(o, d))
        case "roundRect":
            return ZnCanvasOp.RoundRect(try pxV(o, "x"), try pxV(o, "y"), try pxV(o, "w"), try pxV(o, "h"), try pxV(o, "r"), try paint(o, d))
        case "circle":
            return ZnCanvasOp.Circle(try pxV(o, "cx"), try pxV(o, "cy"), try pxV(o, "r"), try paint(o, d))
        case "oval":
            return ZnCanvasOp.Oval(try pxV(o, "x"), try pxV(o, "y"), try pxV(o, "w"), try pxV(o, "h"), try paint(o, d))
        case "line":
            return ZnCanvasOp.Line(try pxV(o, "x1"), try pxV(o, "y1"), try pxV(o, "x2"), try pxV(o, "y2"), try paint(o, d))
        case "arc":
            let x = try pxV(o, "x"), y = try pxV(o, "y"), w = try pxV(o, "w"), h = try pxV(o, "h")
            let start = try numV(o, "start"), sweep = try numV(o, "sweep")
            return ZnCanvasOp.Arc(x, y, w, h, start, sweep, optBool(o, "useCenter"), try paint(o, d))
        case "path":
            guard let data = o["d"] as? String else { throw BadCommand("\"d\" must be a string") }
            let parsed = ZnPathData.parse(data)
            guard parsed.ok else { throw BadCommand("\"d\" is not valid path data") }
            // Drawn under scale(density): the paint is in dp, so its gradient and stroke are not scaled twice.
            let p = try paint(o, 1)
            return ZnCanvasOp.PathOp(parsed.path, p, try optNumV(o, "trimStart"), try optNumV(o, "trimEnd"), try optNumV(o, "trimOffset"))
        case "text":
            return try text(o)
        case "paragraph":
            return try paragraph(o)
        case "image":
            return try image(o)
        case "save":
            return ZnCanvasOp.Save()
        case "restore":
            return ZnCanvasOp.Restore()
        case "translate":
            return ZnCanvasOp.Translate(try pxV(o, "dx"), try pxV(o, "dy"))
        case "scale":
            let sx = try numV(o, "sx")
            return ZnCanvasOp.Scale(sx, try optNumV(o, "sy") ?? sx)
        case "rotate":
            return ZnCanvasOp.Rotate(try numV(o, "degrees"), try optNumV(o, "px", d) ?? Self.zero, try optNumV(o, "py", d) ?? Self.zero)
        case "clipRect":
            return ZnCanvasOp.ClipRect(try pxV(o, "x"), try pxV(o, "y"), try pxV(o, "w"), try pxV(o, "h"), clipOp(o))
        case "clipRoundRect":
            return ZnCanvasOp.ClipRoundRect(try pxV(o, "x"), try pxV(o, "y"), try pxV(o, "w"), try pxV(o, "h"), try pxV(o, "r"), clipOp(o))
        case "clipPath":
            guard let data = o["d"] as? String else { throw BadCommand("\"d\" must be a string") }
            let parsed = ZnPathData.parse(data)
            guard parsed.ok else { throw BadCommand("\"d\" is not valid path data") }
            var m = CGAffineTransform(scaleX: d, y: d)
            let path = parsed.path.copy(using: &m) ?? parsed.path
            let evenOdd = fillType(o)
            return ZnCanvasOp.ClipPath(path, d, evenOdd, clipOp(o))
        case "":
            throw BadCommand("no \"type\"")
        default:
            throw BadCommand("unknown type \"\(type)\"")
        }
    }

    /// org.json's optBoolean: true, or the text "true".
    private func optBool(_ o: [String: Any], _ key: String) -> Bool {
        guard let v = o[key] else { return false }
        if isBool(v) { return (v as? NSNumber)?.boolValue == true }
        if let s = v as? String { return s.lowercased() == "true" }
        return false
    }

    /// True for "difference".
    private mutating func clipOp(_ o: [String: Any]) -> Bool {
        let op = o["op"]
        if op == nil || op is NSNull || (op as? String) == "intersect" { return false }
        if (op as? String) == "difference" { return true }
        error("op \(shownRaw(op)) is not known; intersect is used")
        return false
    }

    /// True for "evenOdd".
    private mutating func fillType(_ o: [String: Any]) -> Bool {
        let f = o["fillType"]
        if f == nil || f is NSNull || (f as? String) == "nonZero" { return false }
        if (f as? String) == "evenOdd" { return true }
        error("fillType \(shownRaw(f)) is not known; nonZero is used")
        return false
    }

    /// A value inside quotes as Kotlin's "\"$v\"" prints it.
    private func shownRaw(_ v: Any?) -> String {
        if let s = v as? String { return "\"\(s)\"" }
        return "\"\(shown(v))\""
    }

    private mutating func fontWeight(_ opts: [String: Any]?) throws -> Int? {
        guard let opts, let fw = opts["fontWeight"], !(fw is NSNull) else { return nil }
        if let s = fw as? String {
            if s == "normal" { return nil }
            if s == "bold" { return 700 }
            if let n = Int(s) { return min(max(n, 1), 1000) }
            error("fontWeight \"\(s)\" is not known; normal is used")
            return nil
        }
        if let n = jsonNumber(fw) {
            let f = try finite(n, "fontWeight")
            // Clamped before Int(...): a huge weight (1e30) would trap. Kotlin's toInt() saturates, then clamps.
            return Int(min(max(f.rounded(.towardZero), 1), 1000))
        }
        return nil
    }

    private func fontSize(_ opts: [String: Any]?) throws -> CGFloat {
        var size: CGFloat = 14
        if let opts, given(opts, "fontSize") { size = try num(opts, "fontSize") }
        if size <= 0 { throw BadCommand("\"fontSize\" must be above 0") }
        return size
    }

    private func textOf(_ o: [String: Any]) throws -> String {
        let content = o["text"]
        if let s = content as? String { return s }
        if let n = jsonNumber(content) { return n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : "\(n)" }
        throw BadCommand("\"text\" must be a string")
    }

    private func align(_ opts: [String: Any]?) -> Int {
        switch optString(opts, "align") {
        case "center": return 1
        case "right": return 2
        default: return 0
        }
    }

    private mutating func text(_ o: [String: Any]) throws -> ZnCanvasOp.Text {
        let text = try textOf(o)
        let opts = o["options"] as? [String: Any]
        let size = try fontSize(opts)
        let weight = try fontWeight(opts)
        let a = align(opts)
        let x = try pxV(o, "x"), y = try pxV(o, "y")
        return ZnCanvasOp.Text(text, x, y, size, weight, colorV(opts, "color", .black), a)
    }

    private mutating func paragraph(_ o: [String: Any]) throws -> ZnCanvasOp.Paragraph {
        let text = try textOf(o)
        let width = try px(o, "width")
        if width < 1 { throw BadCommand("\"width\" must be above 0") }
        let opts = o["options"] as? [String: Any]
        let size = try fontSize(opts)
        let a = align(opts)
        var lineHeight: CGFloat = 0
        if let opts, given(opts, "lineHeight") {
            if let v = jsonNumber(opts["lineHeight"]).map({ CGFloat(Float($0)) }), v.isFinite, v > 0 {
                lineHeight = v * d
            } else {
                error("lineHeight must be a finite number above 0; the font's own is used")
            }
        }
        var maxLines = Int.max
        if let opts, given(opts, "maxLines") {
            if let v = jsonNumber(opts["maxLines"]), v.isFinite, v >= 1 {
                maxLines = v >= Double(Int32.max) ? Int(Int32.max) : Int(v)
            } else {
                error("maxLines must be 1 or more; no limit")
            }
        }
        let x = try pxV(o, "x"), y = try pxV(o, "y")
        let weight = try fontWeight(opts)
        return ZnCanvasOp.Paragraph(text, x, y, min(width, 100_000), size * d, weight, colorV(opts, "color", .black), a,
                                    lineHeight, maxLines)
    }

    private mutating func image(_ o: [String: Any]) throws -> ZnCanvasOp.Image {
        guard let src = o["src"] as? String else { throw BadCommand("\"src\" must be a string") }
        if src.isEmpty { throw BadCommand("\"src\" is empty") }
        let x = try pxV(o, "x"), y = try pxV(o, "y"), w = try pxV(o, "w"), h = try pxV(o, "h")
        let opts = o["options"] as? [String: Any]
        var fit = znFitCover
        let f = opts?["fit"]
        if f == nil || f is NSNull || (f as? String) == "cover" {
            fit = znFitCover
        } else if (f as? String) == "contain" {
            fit = znFitContain
        } else if (f as? String) == "fill" {
            fit = znFitFill
        } else {
            error("fit \(shownRaw(f)) is not known; cover is used")
        }
        var radius: ZnCanvasNum? = nil
        var opacity = Self.one
        if let opts {
            radius = try optNumV(opts, "radius", d)
            opacity = try optNumV(opts, "opacity") ?? Self.one
        }
        // Decoded at about the drawn size in pixels, never above 4096 a side. A size that follows a motion value (an
        // image that grows) is decoded at the screen's longer side instead, as on Android: its size when the list was
        // read may be 1 px, and a decode at that would stay blurry as it grows. The decode never blows a small
        // picture up (znCanvasDecode).
        let moves = w.src != nil || h.src != nil
        let dw = Int(min(max(moves ? screen : w.initial() * pixels, 1), 4096))
        let dh = Int(min(max(moves ? screen : h.initial() * pixels, 1), 4096))
        return ZnCanvasOp.Image(src, x, y, w, h, fit, radius, opacity, dw, dh)
    }

    /// [scale] is units per dp of this command: density, or 1 for a path (drawn under scale(density)).
    private mutating func paint(_ command: [String: Any], _ scale: CGFloat) throws -> ZnCanvasPaint {
        // The same thinnest stroke everywhere: one device pixel.
        let minWidth = scale / d / pixels
        guard let o = command["paint"] as? [String: Any] else {
            return ZnCanvasPaint(color: .black, opacity: Self.one, gradient: nil, isStroke: false, strokeWidth: .of(minWidth),
                                 minWidth: minWidth, cap: .butt, join: .miter, dash: nil, evenOdd: false, blend: .normal,
                                 shadow: nil, blur: 0)
        }
        var color = colorV(o, "color", .black)
        let isStroke = optString(o, "style") == "stroke"
        let width = try optNumV(o, "strokeWidth", scale) ?? .of(minWidth)
        let cap: CGLineCap
        switch optString(o, "strokeCap") {
        case "round": cap = .round
        case "square": cap = .square
        default: cap = .butt
        }
        let join: CGLineJoin
        switch optString(o, "strokeJoin") {
        case "round": join = .round
        case "bevel": join = .bevel
        default: join = .miter
        }
        let opacity = try optNumV(o, "opacity") ?? Self.one
        let dash = dash(o["dash"], scale)

        var gradient: ZnCanvasGradient? = nil
        if let lin = o["linearGradient"] as? [String: Any] {
            let g = self.gradient(lin, "linearGradient")
            if g.colors.count < 2 {
                if g.colors.count == 1 { color = ZnCanvasColor(argb: g.colors[0]) }
            } else {
                let start = CGPoint(x: try finite(try num(lin, "x0") * scale, "x0"), y: try finite(try num(lin, "y0") * scale, "y0"))
                let end = CGPoint(x: try finite(try num(lin, "x1") * scale, "x1"), y: try finite(try num(lin, "y1") * scale, "y1"))
                gradient = .linear(start: start, end: end, colors: g.colors, stops: g.stops)
            }
        } else if let rad = o["radialGradient"] as? [String: Any] {
            let g = self.gradient(rad, "radialGradient")
            if g.colors.count < 2 {
                if g.colors.count == 1 { color = ZnCanvasColor(argb: g.colors[0]) }
            } else {
                let center = CGPoint(x: try finite(try num(rad, "cx") * scale, "cx"), y: try finite(try num(rad, "cy") * scale, "cy"))
                let radius = max(try finite(try num(rad, "r") * scale, "r"), 0.1)
                gradient = .radial(center: center, radius: radius, colors: g.colors, stops: g.stops)
            }
        } else if let swp = o["sweepGradient"] as? [String: Any] {
            let g = self.gradient(swp, "sweepGradient")
            if g.colors.count < 2 {
                if g.colors.count == 1 { color = ZnCanvasColor(argb: g.colors[0]) }
            } else {
                let cx = try finite(try num(swp, "cx") * scale, "cx")
                let cy = try finite(try num(swp, "cy") * scale, "cy")
                var angle: CGFloat = 0
                if given(swp, "startAngle") {
                    if let a = jsonNumber(swp["startAngle"]).map({ CGFloat(Float($0)) }), a.isFinite {
                        angle = a
                    } else {
                        error("sweepGradient startAngle must be a finite number; 0 is used")
                    }
                }
                gradient = .sweep(center: CGPoint(x: cx, y: cy), colors: g.colors, stops: g.stops, startAngle: angle)
            }
        }
        var blend = CGBlendMode.normal
        if let b = o["blendMode"], !(b is NSNull) {
            if let s = b as? String, let m = znCanvasBlendModes[s] {
                blend = m
            } else {
                error("blendMode \(shownRaw(b)) is not known; srcOver is used")
            }
        }
        if blend != .normal { blends = true }
        var blur: CGFloat = 0
        if given(o, "blur") {
            if let v = jsonNumber(o["blur"]).map({ CGFloat(Float($0)) }), v.isFinite, v >= 0 {
                blur = v * scale
            } else {
                error("blur must be a finite number ≥ 0; no blur")
            }
        }
        let evenOdd = fillType(o)
        let shadow = self.shadow(o, scale, minWidth)
        return ZnCanvasPaint(color: color, opacity: opacity, gradient: gradient, isStroke: isStroke, strokeWidth: width,
                             minWidth: minWidth, cap: cap, join: join, dash: dash, evenOdd: evenOdd, blend: blend,
                             shadow: shadow, blur: blur)
    }

    /// {dx, dy, blur, color}: anything wrong gives no shadow (the shape still draws).
    private mutating func shadow(_ o: [String: Any], _ scale: CGFloat, _ minWidth: CGFloat) -> ZnCanvasShadow? {
        guard given(o, "shadow") else { return nil }
        guard let s = o["shadow"] as? [String: Any] else {
            error("shadow must be an object; no shadow")
            return nil
        }
        do {
            let c = s["color"]
            guard jsonNumber(c) != nil else { throw BadCommand("shadow color must be an ARGB number") }
            let dx = try num(s, "dx") * scale, dy = try num(s, "dy") * scale
            // Android removes the shadow at radius 0: at least 1 px, here too.
            let blur = max(try num(s, "blur") * scale, minWidth)
            return ZnCanvasShadow(dx: dx, dy: dy, blur: blur, color: colorValue(c, "shadow color"))
        } catch let e as BadCommand {
            error("\(e.message); no shadow")
            return nil
        } catch {
            return nil
        }
    }

    private struct Gradient {
        let colors: [UInt32]
        let stops: [CGFloat]?
    }

    /// Under 2 colours: no gradient (the caller draws a solid colour). Stops that don't match the colours: dropped.
    private mutating func gradient(_ g: [String: Any], _ name: String) -> Gradient {
        let arr = g["colors"] as? [Any] ?? []
        var colors: [UInt32] = []
        for (i, c) in arr.enumerated() { colors.append(colorValue(c, "\(name) colour \(i)")) }
        if colors.count < 2 {
            error("\(name) needs at least 2 colours, has \(colors.count); drawn in one colour")
            return Gradient(colors: colors, stops: nil)
        }
        guard let stopsArr = g["stops"] as? [Any] else { return Gradient(colors: colors, stops: nil) }
        if stopsArr.count != colors.count {
            error("\(name) has \(stopsArr.count) stops for \(colors.count) colours; stops are left out")
            return Gradient(colors: colors, stops: nil)
        }
        var stops: [CGFloat] = []
        for i in 0..<colors.count {
            guard let f = jsonNumber(stopsArr[i]).map({ CGFloat(Float($0)) }), f.isFinite else {
                error("\(name) stop \(i) is not a finite number; stops are left out")
                return Gradient(colors: colors, stops: nil)
            }
            stops.append(min(max(f, 0), 1))
        }
        return Gradient(colors: colors, stops: stops)
    }

    /// Only an even length ≥ 2, values ≥ 0, a sum > 0 (Android's DashPathEffect throws on an odd length).
    private mutating func dash(_ v: Any?, _ scale: CGFloat) -> [CGFloat]? {
        guard let v, !(v is NSNull) else { return nil }
        guard let a = v as? [Any] else {
            error("dash must be an array; no dash")
            return nil
        }
        let n = a.count
        if n < 2 || n % 2 != 0 {
            error("dash needs an even number of values (2, 4, ...), has \(n); no dash")
            return nil
        }
        var sum: CGFloat = 0
        var out: [CGFloat] = []
        for i in 0..<n {
            guard let f = jsonNumber(a[i]).map({ CGFloat(Float($0)) }), f.isFinite, f >= 0 else {
                error("dash value \(i) must be a finite number ≥ 0; no dash")
                return nil
            }
            out.append(f * scale)
            sum += f
        }
        if !(sum > 0) || !sum.isFinite {
            error("dash values add up to 0; no dash")
            return nil
        }
        return out
    }

    /// A colour that may follow a motion colour. A number motion value, or one that is gone, draws black.
    private mutating func colorV(_ o: [String: Any]?, _ key: String, _ fallback: ZnCanvasColor) -> ZnCanvasColor {
        guard let o, given(o, key) else { return fallback }
        let v = o[key]
        if let s = v as? String, s.hasPrefix(motionRef) {
            guard let src = ZnMotionEngine.shared.ref(s) else {
                missed = true
                error("\(key) follows motion value \(s.dropFirst(motionRef.count)), which is gone; black is used")
                return .black
            }
            guard src.isColor else {
                error("\(key) follows a number, not a colour (use v.mapColor(...)); black is used")
                return .black
            }
            moving = true
            return ZnCanvasColor(argb: 0xFF00_0000, src: src)
        }
        return ZnCanvasColor(argb: colorValue(v, key))
    }

    /// An ARGB number (core parseColor). A string is a warning and black: native never parses colour strings.
    private mutating func colorValue(_ v: Any?, _ what: String) -> UInt32 {
        if let n = jsonNumber(v) {
            if n.isFinite && n == n.rounded(.down) && n >= Double(Int32.min) && n <= Double(UInt32.max) {
                return UInt32(truncatingIfNeeded: Int64(n))
            }
            error("\(what) \(shownNumber(n)) is not an ARGB number; black is used")
            return 0xFF00_0000
        }
        error("\(what) \(shown(v)) is not an ARGB number (use core's draw helpers or parseColor); black is used")
        return 0xFF00_0000
    }

    /// Finite after the Float conversion Android makes (a huge Double becomes infinite there).
    private func finite(_ v: CGFloat, _ key: String) throws -> CGFloat {
        let f = Float(v)
        if !f.isFinite || !v.isFinite { throw BadCommand("\"\(key)\" is not a finite number") }
        return v
    }

    /// A required plain number. JSON.stringify turns NaN and Infinity into null, so they land here too.
    private func num(_ o: [String: Any], _ key: String) throws -> CGFloat {
        let v = o[key]
        guard let n = jsonNumber(v) else {
            throw BadCommand(v == nil ? "\"\(key)\" is missing" : "\"\(key)\" is not a finite number")
        }
        return try finite(CGFloat(n), key)
    }

    private func px(_ o: [String: Any], _ key: String) throws -> CGFloat { try finite(try num(o, key) * d, key) }

    /// A required number that may follow a motion value, times [scale] (density for positions, 1 for angles).
    private mutating func numV(_ o: [String: Any], _ key: String, _ scale: CGFloat = 1) throws -> ZnCanvasNum {
        let v = o[key]
        if let s = v as? String, s.hasPrefix(motionRef) {
            guard let src = ZnMotionEngine.shared.ref(s) else {
                missed = true
                error("\"\(key)\" follows motion value \(s.dropFirst(motionRef.count)), which is gone; 0 is used")
                return ZnCanvasNum(const: 0, scale: scale)
            }
            moving = true
            return ZnCanvasNum(const: 0, src: src, scale: scale)
        }
        guard let n = jsonNumber(v) else {
            throw BadCommand(v == nil ? "\"\(key)\" is missing" : "\"\(key)\" is not a finite number")
        }
        return .of(try finite(CGFloat(n) * scale, key))
    }

    private mutating func pxV(_ o: [String: Any], _ key: String) throws -> ZnCanvasNum { try numV(o, key, d) }

    /// Nil when left out.
    private mutating func optNumV(_ o: [String: Any], _ key: String, _ scale: CGFloat = 1) throws -> ZnCanvasNum? {
        try given(o, key) ? numV(o, key, scale) : nil
    }
}
