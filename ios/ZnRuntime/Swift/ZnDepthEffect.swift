// A 3D turn of an element (Android: the graphicsLayer's rotationX / rotationY / cameraDistance): the flip presets of
// enter / exit now, and rotateX / rotateY / cameraDistance from props and motion values later (motion-depth-props).
//
// The same directions as Android (and CSS): a positive rotateX takes the top edge away from the viewer, a positive
// rotateY the right edge. Both turn about the transform origin. Android's camera distance is in Skia's units: 8
// (the default) puts the camera 8 × 72 = 576 device pixels away, so here it is 72 × cameraDistance pixels, in points
// at this screen's scale (192 pt at 3x; Android at 2.625x: 219 dp). A 90-degree turn is edge-on: nothing shows.
import QuartzCore
import SwiftUI
import UIKit

struct ZnDepthEffect: GeometryEffect {
    /// Degrees.
    var rotateX: CGFloat
    var rotateY: CGFloat
    var cameraDistance: CGFloat
    var origin: UnitPoint

    init(rotateX: CGFloat, rotateY: CGFloat, cameraDistance: CGFloat, origin: UnitPoint) {
        self.rotateX = rotateX; self.rotateY = rotateY; self.cameraDistance = cameraDistance; self.origin = origin
    }

    /// SwiftUI interpolates the turn (an enter's progress is animated), rather than jumping to the end.
    var animatableData: AnimatablePair<CGFloat, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(rotateX, AnimatablePair(rotateY, cameraDistance)) }
        set { rotateX = newValue.first; rotateY = newValue.second.first; cameraDistance = newValue.second.second }
    }

    nonisolated(unsafe) private static let screenScale: CGFloat = MainActor.assumeIsolated { UIScreen.main.scale }

    func effectValue(size: CGSize) -> ProjectionTransform {
        guard rotateX != 0 || rotateY != 0 else { return ProjectionTransform() }
        return ProjectionTransform(Self.matrix(size: size, rotateX: rotateX, rotateY: rotateY, cameraDistance: cameraDistance,
                                        origin: origin, scale: Self.screenScale))
    }

    /// Turn about the origin: to the origin, rotate about x then y, the camera's perspective, back.
    static func matrix(size: CGSize, rotateX: CGFloat, rotateY: CGFloat, cameraDistance: CGFloat, origin: UnitPoint,
                       scale: CGFloat) -> CATransform3D {
        let px = size.width * origin.x, py = size.height * origin.y
        let d = max(0.1, abs(cameraDistance)) * 72 / max(1, scale)
        var persp = CATransform3DIdentity
        persp.m34 = -1 / d
        var m = CATransform3DMakeTranslation(-px, -py, 0)
        m = CATransform3DConcat(m, CATransform3DMakeRotation(rotateX * .pi / 180, 1, 0, 0))
        m = CATransform3DConcat(m, CATransform3DMakeRotation(rotateY * .pi / 180, 0, 1, 0))
        m = CATransform3DConcat(m, persp)
        return CATransform3DConcat(m, CATransform3DMakeTranslation(px, py, 0))
    }
}
