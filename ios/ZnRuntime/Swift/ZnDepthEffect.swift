// A 3D turn of an element (Android: the graphicsLayer's rotationX / rotationY / cameraDistance): the flip presets of
// enter / exit now, and rotateX / rotateY / cameraDistance from props and motion values later (motion-depth-props).
// The maths, directions and camera distance are in ZnDepth.swift (znDepthMatrix).
import SwiftUI

struct ZnDepthEffect: GeometryEffect {
    /// Degrees.
    var rotateX: CGFloat
    var rotateY: CGFloat
    var cameraDistance: CGFloat
    var origin: UnitPoint
    /// The screen's pixels per point (the view's displayScale), for the camera distance.
    var scale: CGFloat

    init(rotateX: CGFloat, rotateY: CGFloat, cameraDistance: CGFloat, origin: UnitPoint, scale: CGFloat) {
        self.rotateX = rotateX; self.rotateY = rotateY; self.cameraDistance = cameraDistance; self.origin = origin
        self.scale = scale
    }

    /// SwiftUI interpolates the turn (an enter's progress is animated), rather than jumping to the end.
    var animatableData: AnimatablePair<CGFloat, AnimatablePair<CGFloat, CGFloat>> {
        get { AnimatablePair(rotateX, AnimatablePair(rotateY, cameraDistance)) }
        set { rotateX = newValue.first; rotateY = newValue.second.first; cameraDistance = newValue.second.second }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        guard rotateX != 0 || rotateY != 0 else { return ProjectionTransform() }
        return ProjectionTransform(znDepthMatrix(size: size, rotateX: rotateX, rotateY: rotateY,
                                                 cameraDistance: cameraDistance, originX: origin.x, originY: origin.y,
                                                 scale: scale))
    }
}
