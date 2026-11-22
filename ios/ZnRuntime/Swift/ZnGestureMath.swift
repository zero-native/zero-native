// The numbers behind a gesture's options (Android: ZnGesture.kt ZnSpec, ZnAnchor, ZnMagnet, rubber, flingDistance).
// Foundation only, so the Mac suite (ios/tests/gestures) checks them with the Kotlin tests' numbers.
import Foundation

/// A coordinate in a gesture's options: points, a share of the travel room, of its own size, of its parent's, or a
/// motion value.
struct ZnSpec {
    private let pt: Float, share: Float, of: Int
    private let src: ZnSource?

    private static let pt = 0, travel = 1, own = 2, parent = 3

    /// [own] / [parent]: the node's and its parent's size along this axis (points).
    func resolve(_ own: Float, _ parent: Float, _ site: ZnSite?) -> Float {
        if let src { return src.read(site) }
        switch of {
        case Self.travel: return share * max(0, parent - own)
        case Self.own: return share * own
        case Self.parent: return share * parent
        default: return pt
        }
    }

    /// A number, "N%" (of the travel room: parent minus own size), "N%self", "N%parent", or {"m": source id}.
    static func parse(_ v: Any?, _ engine: ZnMotionEngine = .shared) throws -> ZnSpec? {
        switch v {
        case nil, is NSNull: return nil
        case let o as [String: Any]:
            guard let m = znJsonNumber(o["m"]) else { throw ZnInvalidArgs("bad coordinate \(o)") }
            return ZnSpec(pt: 0, share: 0, of: pt, src: try engine.source(Int(m)))
        case let s as String:
            let t = s.trimmingCharacters(in: .whitespaces)
            guard let r = t.range(of: #"^-?\d+(\.\d+)?%(self|parent)?$"#, options: .regularExpression), r == t.startIndex..<t.endIndex,
                  let pct = t.firstIndex(of: "%"), let n = Float(t[..<pct]) else {
                throw ZnInvalidArgs("\"\(s)\": use a number of points, \"N%\", \"N%self\" or \"N%parent\"")
            }
            let kind = t[t.index(after: pct)...]
            return ZnSpec(pt: 0, share: n / 100, of: kind == "self" ? own : kind == "parent" ? parent : travel, src: nil)
        default:
            guard let n = znJsonNumber(v) else { throw ZnInvalidArgs("bad coordinate \(v!)") }
            let f = Float(n)
            return f.isFinite ? ZnSpec(pt: f, share: 0, of: pt, src: nil) : nil
        }
    }
}

/// A snap point. 1D gestures use only the coordinate of their axis.
struct ZnAnchor {
    let id: String
    let x: ZnSpec?, y: ZnSpec?
}

/// A magnetic zone: pulls the dragged node toward its centre inside [radius]; releasing inside snaps there.
final class ZnMagnet {
    let id: String
    let x: ZnSpec, y: ZnSpec
    let radius: Float, pull: Float
    var inside = false

    init(id: String, x: ZnSpec, y: ZnSpec, radius: Float, pull: Float) {
        self.id = id; self.x = x; self.y = y; self.radius = radius; self.pull = pull
    }
}

enum ZnGestureMath {
    /// The touch slop (points): Android's 8 dp.
    static let slop: Float = 8

    /// A rubber band: pulling [d] past a bound moves it less and less (iOS's curve), [dim] the scale.
    static func rubber(_ d: Float, _ dim: Float) -> Float {
        let size = dim > 1 ? dim : 200
        return (1 - 1 / (d * 0.55 / size + 1)) * size
    }

    /// How far a fling at [v] (points a second) glides: UIScrollView's normal deceleration (0.998 per ms), where
    /// Android uses its own spline decay. A release with `project` picks the anchor nearest to there.
    static func flingDistance(_ v: Float) -> Float {
        let d: Float = 0.998
        return v / 1000 * d / (1 - d)
    }
}
