// The image viewer's rules (android/.../ViewerRules.kt), apart from UIKit, so the Mac tests build them with swiftc
// (ios/tests/plugins/image-viewer, the cases of ViewerRulesTest.kt). Foundation and Core Graphics only.
import CoreGraphics
import Foundation

/// A width and a height, in pixels.
struct ViewerDims: Equatable {
    var w: CGFloat
    var h: CGFloat
    var empty: Bool { w <= 0 || h <= 0 }
}

/// A rectangle, in pixels.
struct ViewerRect: Equatable {
    var left, top, right, bottom: CGFloat
    var width: CGFloat { right - left }
    var height: CGFloat { bottom - top }
    var empty: Bool { width <= 0 || height <= 0 }
}

/// Where the viewer looks: zoom [z] (1 = the picture fits the screen), and a move of [x], [y] pixels of the zoomed
/// picture's middle away from the screen's middle.
struct ViewerCamera: Equatable {
    var z: CGFloat
    var x: CGFloat
    var y: CGFloat
    static let fit = ViewerCamera(z: 1, x: 0, y: 0)
}

/// The part of the original picture that is on screen: [screen] in screen pixels, [source] in the original's pixels
/// (turned upright, as the user sees it).
struct ViewerArea: Equatable {
    var screen: ViewerRect
    var source: ViewerRect
}

/// The viewer's rules (ViewerRules.kt).
enum ViewerRules {
    static let maxZoom: CGFloat = 5
    static let doubleTapZoom: CGFloat = 2.5
    static let zoomed: CGFloat = 1.01
    static let closeDrag: CGFloat = 0.15
    static let closeSpeed: CGFloat = 1000
    static let heldData = "held:data"
    static let maxDataBytes = 5 * 1024 * 1024
    static let maxHeldBytes = 20 * 1024 * 1024
    /// The native screen's single decode (imageviewer.full): at most this many pixels on the long side.
    static let maxPixels: CGFloat = 4096
    /// The page's sharp part (imageviewer.page) has at most this many screens' worth of pixels (AREA_SCREENS).
    static let areaScreens: CGFloat = 2.5
    /// The zoom must rest this long before a sharp part is cut (SETTLE_MS), in seconds.
    static let settle: TimeInterval = 0.12

    enum Source { case web, asset, file, fileUri, content, held, refused }

    static func kind(_ uri: String) -> Source {
        let l = uri.lowercased()
        if l.hasPrefix("https://") || l.hasPrefix("http://") { return .web }
        if uri.hasPrefix("asset:") { return .asset }
        if uri.hasPrefix("zn://file/") { return .file }
        if l.hasPrefix("file://") { return .fileUri }
        if l.hasPrefix("content://") { return .content }
        if uri == heldData { return .held }
        return .refused
    }

    /// Where the base64 text of a `data:image/...;base64,` link starts, or nil (not a picture, or over 5 MB decoded).
    static func dataStart(_ uri: String) -> String.Index? {
        guard uri.lowercased().hasPrefix("data:image/"), let comma = uri.firstIndex(of: ","),
              uri.distance(from: uri.startIndex, to: comma) <= 200, uri[..<comma].lowercased().hasSuffix(";base64") else { return nil }
        let text = uri.distance(from: comma, to: uri.endIndex) - 1
        guard text > 0, text / 4 * 3 <= maxDataBytes else { return nil }
        return uri.index(after: comma)
    }

    /// By scalars: in Swift "\r\n" is one Character, so `value.contains("\n")` misses it.
    static func safeHeader(_ name: String, _ value: String) -> Bool {
        !name.isEmpty && name.count <= 256 && name.unicodeScalars.allSatisfy { $0.value >= 33 && $0.value <= 126 && $0 != ":" }
            && value.count <= 8192 && !value.unicodeScalars.contains { $0 == "\r" || $0 == "\n" || $0 == "\0" }
    }

    /// A plain path inside the bundle: no "..", no leading "/".
    static func assetPath(_ uri: String) -> String? {
        let p = uri.hasPrefix("asset://") ? String(uri.dropFirst(8)) : String(uri.dropFirst(6))
        if p.isEmpty || p.hasPrefix("/") || p.contains("\\") { return nil }
        if p.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) { return nil }
        return p
    }

    static func label(_ template: String, _ index: Int, _ count: Int) -> String {
        template.replacingOccurrences(of: "{n}", with: "\(index + 1)").replacingOccurrences(of: "{count}", with: "\(count)")
    }

    /// Whether a swipe of `drag` points at `speed` points per second closes the viewer.
    static func closes(_ drag: CGFloat, _ speed: CGFloat, _ height: CGFloat) -> Bool {
        guard height > 0 else { return false }
        if abs(drag) > height * closeDrag { return true }
        return abs(speed) > closeSpeed && (speed > 0) == (drag > 0) && drag != 0
    }

    static func backgroundAlpha(_ drag: CGFloat, _ height: CGFloat) -> CGFloat {
        height <= 0 ? 1 : 1 - 0.7 * min(1, abs(drag) / (height * 0.5))
    }

    // MARK: The page's sharp part (imageviewer.page)

    /// The size of [content] fitted inside [box], keeping its shape (scaleAspectFit). Not loaded yet: the box.
    static func fitted(_ content: ViewerDims, _ box: ViewerDims) -> ViewerDims {
        if content.empty || box.empty { return box }
        let s = min(box.w / content.w, box.h / content.h)
        return ViewerDims(w: content.w * s, h: content.h * s)
    }

    /// The part of the [original] (upright pixels) that is on [screen] under [c], or nil if none. [fitted] is the
    /// picture's size at zoom 1.
    static func visibleArea(_ c: ViewerCamera, _ fitted: ViewerDims, _ screen: ViewerDims, _ original: ViewerDims) -> ViewerArea? {
        if fitted.empty || screen.empty || original.empty { return nil }
        let w = fitted.w * c.z, h = fitted.h * c.z
        let left = screen.w / 2 + c.x - w / 2
        let top = screen.h / 2 + c.y - h / 2
        let visible = ViewerRect(left: max(0, left), top: max(0, top), right: min(screen.w, left + w), bottom: min(screen.h, top + h))
        if visible.empty { return nil }
        let sx = original.w / w, sy = original.h / h
        func clampTo(_ v: CGFloat, _ hi: CGFloat) -> CGFloat { min(max(v, 0), hi) }
        let source = ViewerRect(
            left: clampTo((visible.left - left) * sx, original.w),
            top: clampTo((visible.top - top) * sy, original.h),
            right: clampTo((visible.right - left) * sx, original.w),
            bottom: clampTo((visible.bottom - top) * sy, original.h)
        )
        if source.empty { return nil }
        return ViewerArea(screen: visible, source: source)
    }

    /// [a] with its source grown to whole pixels (the decoder takes whole pixels), and its screen part grown by the same
    /// amount. Without this the sharp copy would land up to one source pixel off: 5 screen pixels at zoom 5.
    static func snapped(_ a: ViewerArea) -> ViewerArea {
        let s = a.source
        let kx = a.screen.width / s.width, ky = a.screen.height / s.height
        let l = s.left.rounded(.down), t = s.top.rounded(.down), r = s.right.rounded(.up), b = s.bottom.rounded(.up)
        return ViewerArea(
            screen: ViewerRect(left: a.screen.left - (s.left - l) * kx, top: a.screen.top - (s.top - t) * ky,
                               right: a.screen.right + (r - s.right) * kx, bottom: a.screen.bottom + (b - s.bottom) * ky),
            source: ViewerRect(left: l, top: t, right: r, bottom: b)
        )
    }

    /// Whether the picture on screen needs a sharper copy: the fitted copy ([baseWidth] pixels wide) is stretched on
    /// screen, and the original has more pixels to give.
    static func needsSharp(_ c: ViewerCamera, _ fitted: ViewerDims, _ baseWidth: CGFloat, _ originalWidth: CGFloat) -> Bool {
        if fitted.empty || baseWidth <= 0 { return false }
        return fitted.w * c.z > baseWidth * 1.1 && originalWidth > baseWidth * 1.1
    }

    /// Every [n]th pixel is read, n a power of 2: the biggest n that still gives at least one pixel per screen pixel,
    /// then bigger while the result is over [maxPixels]. ImageIO's subsample goes to 8; past that the part is drawn
    /// smaller.
    static func sampleSize(_ source: ViewerRect, _ screen: ViewerRect, _ maxPixels: CGFloat) -> Int {
        if source.empty || screen.empty { return 1 }
        let ratio = min(source.width / screen.width, source.height / screen.height)
        var n = 1
        while CGFloat(n * 2) <= ratio { n *= 2 }
        while (source.width / CGFloat(n)) * (source.height / CGFloat(n)) > maxPixels && n < 64 { n *= 2 }
        return n
    }

    /// EXIF orientations the page can turn upright (the rest are mirror images: those get no sharp part).
    static func degrees(_ orientation: Int) -> Int? {
        switch orientation {
        case 0, 1: return 0  // 0: unknown, taken as upright
        case 3: return 180
        case 6: return 90
        case 8: return 270
        default: return nil
        }
    }

    /// The upright size of a picture stored as [raw] pixels and turned [degrees].
    static func upright(_ raw: ViewerDims, _ degrees: Int) -> ViewerDims {
        degrees == 90 || degrees == 270 ? ViewerDims(w: raw.h, h: raw.w) : raw
    }

    /// [r] in the upright picture ([upright] size) → the same part in the stored pixels, before the turn of [degrees].
    static func storedRect(_ r: ViewerRect, _ upright: ViewerDims, _ degrees: Int) -> ViewerRect {
        switch degrees {
        case 90: return ViewerRect(left: r.top, top: upright.w - r.right, right: r.bottom, bottom: upright.w - r.left)
        case 180: return ViewerRect(left: upright.w - r.right, top: upright.h - r.bottom, right: upright.w - r.left, bottom: upright.h - r.top)
        case 270: return ViewerRect(left: upright.h - r.bottom, top: r.left, right: upright.h - r.top, bottom: r.right)
        default: return r
        }
    }

    /// The camera a page's motion values give: zoom (NaN, 0 or less → 1) and the move in points, times [scale] for pixels.
    static func camera(scale z: Float?, x: Float?, y: Float?, pixels: CGFloat) -> ViewerCamera {
        let zz = z.flatMap { $0.isFinite && $0 > 0 ? CGFloat($0) : nil } ?? 1
        func px(_ v: Float?) -> CGFloat { v.flatMap { $0.isFinite ? CGFloat($0) * pixels : nil } ?? 0 }
        return ViewerCamera(z: zz, x: px(x), y: px(y))
    }
}
