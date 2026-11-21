// What a slot that may follow a motion value reads (Android: ZnAnimation.kt animatedFloat / znBackground,
// ZnRenderer.kt resolveSizePx and display, ZnMotionUi.kt ZnMotionShape), as plain functions over ZnValue and the
// engine, so the Mac unit suite (ios/tests/motion) checks them without SwiftUI. ZnMotionBindings.swift draws with them.
// Main thread only, as the engine.
import CoreGraphics
import Foundation
import QuartzCore

/// The slot value refers to a motion source ("\u{0}m<id>"), made yet or not.
func znIsMotionRef(_ v: ZnValue) -> Bool {
    if case .string(let s) = v { return s.hasPrefix(ZnMotionEngine.refPrefix) }
    return false
}

/// The source a slot value refers to, or nil (not a reference, or not made yet: a miss reads the engine's generation,
/// so the reader draws again once it arrives).
func znMotionSource(_ v: ZnValue, _ engine: ZnMotionEngine = .shared) -> ZnSource? {
    guard case .string(let s) = v, s.hasPrefix(ZnMotionEngine.refPrefix) else { return nil }
    return engine.ref(s)
}

/// A layer number (opacity, a transform, a 3D turn, the camera, blur): a motion reference reads its source now, a
/// finite number is itself, anything else (null, NaN, a reference not made yet) is [fixed], as Android's animatedFloat.
func znBoundNumber(_ v: ZnValue, _ fixed: CGFloat, site: ZnSite?, _ engine: ZnMotionEngine = .shared) -> CGFloat {
    switch v {
    case .number(let n): return n.isFinite ? CGFloat(n) : fixed
    case .string: return znMotionSource(v, engine).map { CGFloat($0.read(site)) } ?? fixed
    default: return fixed
    }
}

/// A number that may follow a motion value, nil when the value is neither (a corner, a size). A source's value is
/// never NaN; a number that isn't finite counts as not written.
func znBoundNumberOrNil(_ v: ZnValue, _ engine: ZnMotionEngine = .shared) -> CGFloat? {
    switch v {
    case .number(let n): return n.isFinite ? CGFloat(n) : nil
    case .string: return znMotionSource(v, engine).map { CGFloat($0.read(nil)) }
    default: return nil
    }
}

/// ARGB of a motion colour (mapColor, a formula ending in interpolateColor) a slot follows; nil when it follows none,
/// or a source that isn't a colour (Android's znBackground then reads the value as a colour, which a string isn't).
func znBoundColor(_ v: ZnValue, site: ZnSite? = nil, _ engine: ZnMotionEngine = .shared) -> UInt32? {
    guard let src = znMotionSource(v, engine), src.isColor else { return nil }
    return src.readColor(site)
}

/// Any of these slot values follows a formula that reads `self` / `parent` (Android's siteUsed): only then does the
/// node measure itself and ask its parent for its size.
func znSiteUsed(_ values: [ZnValue], _ engine: ZnMotionEngine = .shared) -> Bool {
    values.contains { znMotionSource($0, engine)?.usesSite == true }
}

/// What a Text shows for a string slot: a motion value as text ("\u{0}f<id>|<format>", `v.format(...)`) formatted
/// from its value now, never the raw control characters (an empty string while the value isn't made, or with the
/// engine off). Any other string is itself, as Android's display().
func znShownString(_ s: String, _ engine: ZnMotionEngine = .shared) -> String {
    guard s.hasPrefix(ZnMotionEngine.textPrefix) else { return s }
    return engine.text(s) ?? ""
}

/// SwiftUI's blur radius for a blurRadius in points. Android blurs the layer with RenderEffect.createBlurEffect, whose
/// radius HWUI turns into a Gaussian sigma as Skia does (0.57735 × radius + 0.5 pixels); SwiftUI's radius is the
/// sigma, so this is Skia's sigma in points ([scale]: pixels per point). 0 or less: no blur.
func znBlurSigma(_ radius: CGFloat, scale: CGFloat) -> CGFloat {
    guard radius > 0, radius.isFinite else { return 0 }
    return 0.57735 * radius + 0.5 / max(1, scale)
}

/// A layer's whole transform as one matrix, in the order of Android's RenderNode (HWUI's updateMatrix): scale and
/// rotate about the origin, then the 3D turn about it (ZnDepth.swift), then the translation. Row vectors, as Core
/// Animation: a point is scaled first. [originX] / [originY]: 0…1 of [size]; degrees; [scale]: pixels per point.
func znLayerMatrix(size: CGSize, scaleX: CGFloat, scaleY: CGFloat, rotate: CGFloat, rotateX: CGFloat, rotateY: CGFloat,
                   cameraDistance: CGFloat, translateX: CGFloat, translateY: CGFloat, originX: CGFloat, originY: CGFloat,
                   scale: CGFloat) -> CATransform3D {
    let px = size.width * originX, py = size.height * originY
    var m = CATransform3DMakeTranslation(-px, -py, 0)
    m = CATransform3DConcat(m, CATransform3DMakeScale(scaleX, scaleY, 1))
    if rotate != 0 { m = CATransform3DConcat(m, CATransform3DMakeRotation(rotate * .pi / 180, 0, 0, 1)) }
    m = CATransform3DConcat(m, CATransform3DMakeTranslation(px, py, 0))
    if rotateX != 0 || rotateY != 0 {
        m = CATransform3DConcat(m, znDepthMatrix(size: size, rotateX: rotateX, rotateY: rotateY, cameraDistance: cameraDistance,
                                                 originX: originX, originY: originY, scale: scale))
    }
    return CATransform3DConcat(m, CATransform3DMakeTranslation(translateX, translateY, 0))
}
