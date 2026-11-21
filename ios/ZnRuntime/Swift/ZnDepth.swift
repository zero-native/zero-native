// The maths of a 3D turn (ZnDepthEffect draws it) and enter / exit's values (ZnTransition), with no UIKit or SwiftUI,
// so the Mac unit suite (ios/tests/motion) builds it on its own.
//
// Android turns an element on its graphicsLayer (HWUI: Sk3DView's rotateX then rotateY, preConcatenated, so a point
// is turned about y first, then about x). The same directions as Android (and CSS): a positive rotateX takes the top
// edge away from the viewer, a positive rotateY the right edge. Both turn about the transform origin. Android's
// camera distance is in Skia's units: 8 (the default) puts the camera 8 × 72 = 576 device pixels away, so here it is
// 72 × cameraDistance pixels, in points at the screen's scale (192 pt at 3x; Android at 2.625x: 219 dp). A 90-degree
// turn is edge-on: nothing shows.
import CoreGraphics
import QuartzCore

/// The turn of a [size] element about its origin ([originX], [originY]: 0…1 of its size), in degrees, as a
/// projection (Core Animation's row vectors: to the origin, about y, about x, the camera's perspective, back).
/// [scale]: the screen's pixels per point.
func znDepthMatrix(size: CGSize, rotateX: CGFloat, rotateY: CGFloat, cameraDistance: CGFloat, originX: CGFloat,
                   originY: CGFloat, scale: CGFloat) -> CATransform3D {
    let px = size.width * originX, py = size.height * originY
    let d = max(0.1, abs(cameraDistance)) * 72 / max(1, scale)
    var persp = CATransform3DIdentity
    persp.m34 = -1 / d
    var m = CATransform3DMakeTranslation(-px, -py, 0)
    m = CATransform3DConcat(m, CATransform3DMakeRotation(rotateY * .pi / 180, 0, 1, 0))
    m = CATransform3DConcat(m, CATransform3DMakeRotation(rotateX * .pi / 180, 1, 0, 0))
    m = CATransform3DConcat(m, persp)
    return CATransform3DConcat(m, CATransform3DMakeTranslation(px, py, 0))
}

/// The numbers of an `enter` / `exit` before its "|": "opacity,translateX,translateY,scale", or with
/// ",rotateX,rotateY,scaleX,scaleY" (registry 24: the flip and stretch presets). Nil for any other count, or a part
/// that isn't a number.
func znTransitionValues(_ s: Substring) -> [Double]? {
    let parts = s.split(separator: ",", omittingEmptySubsequences: false)
    let v = parts.compactMap { Double($0) }
    guard v.count == parts.count, v.count == 4 || v.count == 8 else { return nil }
    return v
}
