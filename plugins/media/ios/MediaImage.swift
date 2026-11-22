// Turning one picture file into a clean JPEG (Android: MediaImage.kt), with ImageIO and Core Graphics only, so the Mac
// tests run it too (ios/tests/plugins/media). On the media queue, never the main thread.
import CoreGraphics
import Foundation
import ImageIO

enum MediaImage {
    /// The stored size (EXIF's turn not applied), as Android's bounds; (0, 0) for a file that isn't a picture.
    static func size(_ url: URL) -> (Int, Int) {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return (0, 0) }
        return ((p[kCGImagePropertyPixelWidth] as? Int) ?? 0, (p[kCGImagePropertyPixelHeight] as? Int) ?? 0)
    }

    /// The file's EXIF orientation as (degrees, mirrored), and whether it holds a location: debugExif.
    static func exif(_ url: URL) -> (degrees: Int, location: Bool)? {
        guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
              let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] else { return nil }
        let gps = p[kCGImagePropertyGPSDictionary] as? [CFString: Any]
        return (MediaRules.orientation((p[kCGImagePropertyOrientation] as? Int) ?? 1).degrees, gps?[kCGImagePropertyGPSLatitude] != nil)
    }

    /// [source] to a JPEG at [target], through [work], a scratch file. A JPEG written from pixels has no EXIF at all, so
    /// the location goes with the rest, and the file's turn and mirror are built into the pixels. See-through parts
    /// become white.
    static func write(_ source: URL, work: URL, target: URL, maxSize: Int, quality: Int, rotate: Int = 0, crop: MediaCrop? = nil) throws {
        guard let src = CGImageSourceCreateWithURL(source as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let width = props[kCGImagePropertyPixelWidth] as? Int, let height = props[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else {
            throw MediaFailure("not_image", "\(source.lastPathComponent) isn't a picture this phone can read")
        }
        let o = MediaRules.orientation((props[kCGImagePropertyOrientation] as? Int) ?? 1)
        guard let plan = MediaRules.plan(width: width, height: height, exifDegrees: o.degrees, flip: o.flip, rotate: rotate, crop: crop, maxSize: maxSize) else {
            throw MediaFailure("invalid_crop", "the crop is outside the picture")
        }
        // ImageIO reads a big picture smaller itself (a JPEG's own downscale), as Android's inSampleSize. No transform:
        // the plan turns it, in one draw.
        let decoded: CGImage? = plan.readSide.map { side in
            CGImageSourceCreateThumbnailAtIndex(src, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: side,
                kCGImageSourceCreateThumbnailWithTransform: false, kCGImageSourceShouldCacheImmediately: true,
            ] as CFDictionary)
        } ?? CGImageSourceCreateImageAtIndex(src, 0, [kCGImageSourceShouldCacheImmediately: true] as CFDictionary)
        guard let decoded else { throw MediaFailure("not_image", "\(source.lastPathComponent) can't be read") }
        guard let out = draw(decoded, width, height, plan) else { throw MediaFailure("too_big", "not enough memory for this picture") }
        try writeWhole(work, target) { url in
            guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.jpeg" as CFString, 1, nil) else { return false }
            // No properties but the quality: nothing of the source's EXIF, GPS or maker notes is copied.
            CGImageDestinationAddImage(dest, out, [kCGImageDestinationLossyCompressionQuality: Double(quality) / 100] as CFDictionary)
            return CGImageDestinationFinalize(dest)
        }
    }

    /// One transform does it all (Android's one Matrix), so the picture is filtered once. The plan's steps are in
    /// y-down pixels as on Android; Core Graphics is y-up, so the image and the canvas are flipped around them.
    static func draw(_ decoded: CGImage, _ width: Int, _ height: Int, _ plan: MediaPlan) -> CGImage? {
        let dw = CGFloat(decoded.width), dh = CGFloat(decoded.height)
        var m = CGAffineTransform(scaleX: CGFloat(width) / dw, y: CGFloat(height) / dh)  // back to the file's own pixels
        if plan.flip { m = m.concatenating(CGAffineTransform(scaleX: -1, y: 1)) }
        m = m.concatenating(CGAffineTransform(rotationAngle: CGFloat(plan.turn) * .pi / 180))
        let area = CGRect(x: 0, y: 0, width: dw, height: dh).applying(m)
        m = m.concatenating(CGAffineTransform(translationX: -area.minX - CGFloat(plan.cropX), y: -area.minY - CGFloat(plan.cropY)))
        m = m.concatenating(CGAffineTransform(scaleX: CGFloat(plan.scale), y: CGFloat(plan.scale)))
        let outH = CGFloat(plan.height)
        let imageDown = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: dh)       // the image's y-up → y-down
        let canvasUp = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: outH)    // y-down → the canvas's y-up
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: plan.width, height: plan.height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: plan.width, height: plan.height))
        ctx.interpolationQuality = .high
        ctx.concatenate(imageDown.concatenating(m).concatenating(canvasUp))
        ctx.draw(decoded, in: CGRect(x: 0, y: 0, width: dw, height: dh))
        return ctx.makeImage()
    }

    /// Writes [work], flushes it to disk, then moves it onto [target]: a kill leaves either no file or a whole one.
    static func writeWhole(_ work: URL, _ target: URL, _ write: (URL) -> Bool) throws {
        defer { try? FileManager.default.removeItem(at: work) }
        try? FileManager.default.removeItem(at: work)
        guard write(work) else { throw MediaFailure("write_failed", "can't write the picture") }
        try sync(work)
        guard rename(work.path, target.path) == 0 else {
            throw MediaFailure(errno == ENOSPC ? "no_space" : "write_failed", "can't move \(work.lastPathComponent)")
        }
    }

    /// fsync: or a sudden power cut could leave the new name on empty data.
    static func sync(_ url: URL) throws {
        let fd = open(url.path, O_RDONLY)
        guard fd >= 0 else { throw MediaFailure("write_failed", "can't open \(url.lastPathComponent)") }
        defer { close(fd) }
        if fsync(fd) != 0 { throw MediaFailure(errno == ENOSPC ? "no_space" : "write_failed", "can't flush \(url.lastPathComponent)") }
    }

    /// Debug builds: a photo stored sideways (EXIF orientation 6, a quarter turn) with a location in it, 1600 x 1200
    /// blue as Android's, so the phone test needs no hands.
    static func debugPhoto(_ url: URL) throws {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: 1600, height: 1200, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { throw MediaFailure("write_failed") }
        ctx.setFillColor(CGColor(red: 0x22 / 255.0, green: 0x66 / 255.0, blue: 0xCC / 255.0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 1600, height: 1200))
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 1200 - 200, width: 200, height: 200))  // a white mark at the stored top left, to see the turn
        guard let image = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.jpeg" as CFString, 1, nil) else { throw MediaFailure("write_failed") }
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 12.9, kCGImagePropertyGPSLatitudeRef: "N",
                                    kCGImagePropertyGPSLongitude: 77.6, kCGImagePropertyGPSLongitudeRef: "E"]
        CGImageDestinationAddImage(dest, image, [kCGImagePropertyOrientation: 6, kCGImagePropertyGPSDictionary: gps,
                                                 kCGImageDestinationLossyCompressionQuality: 0.95] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw MediaFailure("write_failed") }
    }
}
