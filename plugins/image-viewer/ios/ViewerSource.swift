// One picture's encoded bytes for the TSX viewer's page (imageviewer.page, ViewerPage.swift): the fitted copy drawn at
// zoom 1 (Coil's decode at the size on screen, on Android) and sharp parts of the original when zoomed in (Android's
// SharpSource.kt with BitmapRegionDecoder). ImageIO and Core Graphics only, so the Mac tests run it
// (ios/tests/plugins/image-viewer).
//
// iOS has no region decoder, but a lazily decoded CGImage (kCGImageSourceShouldCache off) cropped and drawn into a
// small bitmap reads only what it needs for JPEG (by rows) and HEIC (by tiles): an 8000 × 6000 JPEG's part of a screen
// peaks at about 28 MB, where the whole picture is 192 MB (measured on the Mac). A thumbnail to 4096 px of the same
// picture peaks at 420 MB, which is why the page decodes its fitted copy at the size on screen, never bigger.
import CoreGraphics
import Foundation
import ImageIO

final class ViewerSource: @unchecked Sendable {
    private let source: CGImageSource
    private let lock = NSLock()
    /// The encoded size (a mapped file counts too: it is what the cache weighs).
    let bytes: Int
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
        raw = ViewerDims(w: CGFloat(w), h: CGFloat(h))
        let orientation = (props[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        degrees = ViewerRules.degrees(orientation)
        // A mirror image's upright size: the turns that swap the sides are 5 to 8.
        upright = ViewerRules.upright(raw, degrees ?? (orientation >= 5 && orientation <= 8 ? 90 : 0))
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

    /// The part [area] of the original, upright, with at most [maxPixels] pixels; nil if it can't be read.
    func decode(_ area: ViewerArea, maxPixels: CGFloat) -> CGImage? {
        guard let degrees else { return nil }
        let s = ViewerRules.storedRect(area.source, upright, degrees)
        let rect = CGRect(x: s.left.rounded(.down), y: s.top.rounded(.down), width: s.right.rounded(.up) - s.left.rounded(.down),
                          height: s.bottom.rounded(.up) - s.top.rounded(.down))
            .intersection(CGRect(x: 0, y: 0, width: raw.w, height: raw.h))
        guard !rect.isNull, rect.width >= 1, rect.height >= 1 else { return nil }
        let n = ViewerRules.sampleSize(area.source, area.screen, maxPixels)
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
            guard let ctx = CGContext(data: nil, width: uw, height: uh, bitsPerComponent: 8, bytesPerRow: 0,
                                      space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
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
