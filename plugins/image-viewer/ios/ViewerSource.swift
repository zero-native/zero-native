// One picture's encoded bytes for the TSX viewer's page (imageviewer.page, ViewerPage.swift): the fitted copy drawn at
// zoom 1 (Coil's decode at the size on screen, on Android) and sharp parts of the original when zoomed in (Android's
// SharpSource.kt with BitmapRegionDecoder). ImageIO and Core Graphics only, so the Mac tests run it
// (ios/tests/plugins/image-viewer).
//
// iOS has no region decoder, but a lazily decoded CGImage (kCGImageSourceShouldCache off) cropped and drawn into a
// small bitmap reads only what it needs for JPEG, baseline or progressive (by rows), and HEIC (by tiles). Measured on
// the Mac for a 1200 x 2600 part of an 8000 x 6000 picture, whose whole bitmap is 192 MB: JPEG about 27 MB, HEIC about
// 76 MB, but PNG and TIFF about 197 MB (the whole picture) and GIF 380 MB. So PNG and TIFF parts read every nth pixel
// until the whole picture would be at most `wholePixels` (ImageIO subsamples them), other formats get a part only when
// the whole picture is that small, and GIF gets none (as Android's region decoder). The fitted copy (a thumbnail at the
// size on screen) stays small for all of these but GIF.
import CoreGraphics
import Foundation
import ImageIO

final class ViewerSource: @unchecked Sendable {
    /// A part of a picture that isn't read lazily is cut from the whole picture read every nth pixel, and that whole is
    /// at most this many pixels (48 MB, a 12 MP photo).
    static let wholePixels: CGFloat = 12_000_000

    private let source: CGImageSource
    private let lock = NSLock()
    /// The encoded size (what the cache weighs).
    let bytes: Int
    /// How parts are read: by rows or tiles (JPEG, HEIC), from the whole picture read every nth pixel (PNG, TIFF), from
    /// the whole picture only (the rest), or not at all (GIF).
    let reading: Reading
    enum Reading { case lazy, subsampled, whole, none }
    /// The stored pixels, before the EXIF turn.
    let raw: ViewerDims
    /// The EXIF turn, nil for a mirror image (it gets no sharp parts, as on Android).
    let degrees: Int?
    /// The picture as the user sees it, in its own pixels.
    let upright: ViewerDims

    /// Nil when ImageIO can't read it (not a picture, a broken file).
    init?(data: Data) {
        guard let s = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              CGImageSourceGetCount(s) > 0,
              let props = CGImageSourceCopyPropertiesAtIndex(s, 0, nil) as? [CFString: Any],
              let w = (props[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue,
              let h = (props[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue, w > 0, h > 0 else { return nil }
        source = s
        bytes = data.count
        reading = Self.reading(CGImageSourceGetType(s) as String?)
        raw = ViewerDims(w: CGFloat(w), h: CGFloat(h))
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        degrees = ViewerRules.degrees(orientation)
        // A mirror image's upright size: the turns that swap the sides are 5 to 8.
        upright = ViewerRules.upright(raw, degrees ?? (orientation >= 5 && orientation <= 8 ? 90 : 0))
    }

    static func reading(_ type: String?) -> Reading {
        switch type?.lowercased() {
        case "public.jpeg", "public.heic", "public.heif": return .lazy
        case "public.png", "public.tiff": return .subsampled
        case "com.compuserve.gif": return .none
        default: return .whole
        }
    }

    /// The every-nth-pixel to read a part with, at least [n]; nil when the part can't be read without decoding too much.
    func sampling(_ n: Int) -> Int? { Self.sampling(reading, raw, n) }

    static func sampling(_ reading: Reading, _ raw: ViewerDims, _ n: Int) -> Int? {
        let whole = raw.w * raw.h
        switch reading {
        case .lazy: return n
        case .none: return nil
        case .whole: return whole <= wholePixels ? n : nil
        case .subsampled:
            var k = n
            while whole / CGFloat(k * k) > wholePixels { k *= 2 }
            // ImageIO reads at most every 8th pixel: past that, the whole picture it reads is still too big.
            return whole / CGFloat(min(k, 8) * min(k, 8)) <= wholePixels ? k : nil
        }
    }

    /// The picture upright (EXIF turn and mirror applied), at most [maxPixels] on its long side, never bigger than it is.
    func fitted(maxPixels: CGFloat) -> CGImage? {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, min(maxPixels, max(upright.w, upright.h))).rounded(.up),
        ]
        return lock.withLock { CGImageSourceCreateThumbnailAtIndex(source, 0, opts as CFDictionary) }
    }

    /// An 8-bit bitmap for a part, in the picture's own colours (Display P3 for iPhone photos), as the fitted copy keeps
    /// them: drawn in sRGB, its saturated colours would change when the part shows over the copy. A colour space an
    /// 8-bit bitmap can't use (extended range, HDR) falls back to sRGB, so the part is still made.
    static func bitmap(_ w: Int, _ h: Int, colours: CGColorSpace?, opaque: Bool) -> CGContext? {
        let info = (opaque ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast).rawValue
        if let own = colours, own.model == .rgb, own.supportsOutput,
           let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: own, bitmapInfo: info) {
            return ctx
        }
        return CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                         space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(), bitmapInfo: info)
    }

    /// The part [area] of the original, upright, with at most [maxPixels] pixels; nil if it can't be read.
    func decode(_ area: ViewerArea, maxPixels: CGFloat) -> CGImage? {
        guard let degrees else { return nil }
        let s = ViewerRules.storedRect(area.source, upright, degrees)
        let rect = CGRect(x: s.left.rounded(.down), y: s.top.rounded(.down), width: s.right.rounded(.up) - s.left.rounded(.down),
                          height: s.bottom.rounded(.up) - s.top.rounded(.down))
            .intersection(CGRect(x: 0, y: 0, width: raw.w, height: raw.h))
        guard !rect.isNull, rect.width >= 1, rect.height >= 1 else { return nil }
        guard let n = sampling(ViewerRules.sampleSize(area.source, area.screen, maxPixels)) else { return nil }
        var opts: [CFString: Any] = [kCGImageSourceShouldCache: false]
        if n > 1 { opts[kCGImageSourceSubsampleFactor] = min(n, 8) }
        return lock.withLock { () -> CGImage? in
            guard let whole = CGImageSourceCreateImageAtIndex(source, 0, opts as CFDictionary) else { return nil }
            // What the subsample really gave (a format without it reads every pixel).
            let k = CGFloat(whole.width) / raw.w
            let cut = CGRect(x: rect.minX * k, y: rect.minY * k, width: rect.width * k, height: rect.height * k).integral
                .intersection(CGRect(x: 0, y: 0, width: whole.width, height: whole.height))
            guard !cut.isNull, let part = whole.cropping(to: cut) else { return nil }
            let ow = max(1, Int((rect.width / CGFloat(n)).rounded())), oh = max(1, Int((rect.height / CGFloat(n)).rounded()))
            let turned = degrees == 90 || degrees == 270
            let (uw, uh) = turned ? (oh, ow) : (ow, oh)
            let opaque: Bool
            switch part.alphaInfo {
            case .none, .noneSkipFirst, .noneSkipLast: opaque = true
            default: opaque = false
            }
            guard let ctx = Self.bitmap(uw, uh, colours: part.colorSpace, opaque: opaque) else { return nil }
            ctx.interpolationQuality = .high
            // Core Graphics' y goes up: a turn clockwise on screen is a negative angle here.
            switch degrees {
            case 90: ctx.translateBy(x: 0, y: CGFloat(uh)); ctx.rotate(by: -.pi / 2)
            case 180: ctx.translateBy(x: CGFloat(uw), y: CGFloat(uh)); ctx.rotate(by: .pi)
            case 270: ctx.translateBy(x: CGFloat(uw), y: 0); ctx.rotate(by: .pi / 2)
            default: break
            }
            ctx.draw(part, in: CGRect(x: 0, y: 0, width: ow, height: oh))
            return ctx.makeImage()
        }
    }
}
