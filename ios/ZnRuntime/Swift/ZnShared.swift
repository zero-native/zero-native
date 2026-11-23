// Shared elements between two screens (sharedTag, registry 24), as android/runtime's ZnShared.kt: an element with the
// same tag on the screen that leaves and the one that comes flies from one place to the other while the screens
// change, and Back plays it backwards (the edge swipe scrubs it with the finger, as Android's predictive back seeks it).
//
// - ZnSharedProbe (applied in ZnNodeView on the node's box, inside the margin): a node with a sharedTag (written or
//   from a slot) gets a small UIKit view behind it (ZnSharedAnchorView), which says where the node is, and an opacity
//   that hides it while its flight is in the air. Empty tag, or no screen around it: nothing flies (as ZnShared.kt).
// - ZnNavController (ZnNavHost.swift) finds the anchors of the two screens a transition changes and gives the
//   transition's animator a ZnSharedFlight. Only anchors inside the screen's own view count: a Sheet or Modal is
//   another view tree (Android: another window), and a see-through screen (`transparent: true`) shares none (Android
//   gives it no visibility scope); the opaque screen under a see-through one does, when a push covers both.
// - The flight: an <Image> flies as the picture itself (Compose's sharedElement): a UIImageView with the picture from
//   ZnImageCache, its contentScale and corners, growing from the source's box to the destination's. Anything else
//   (and a picture not in the cache yet) moves its bounds and cross-fades a snapshot of the source into one of the
//   destination (sharedBounds). The flight views are over both screens in UIKit's transition container, which is
//   inside the secure container (ZnSecure.swift), so a secure screen's elements stay out of captures while they fly.
// - Timing: the flights move in the transition's own animation block, so they share its curve, and the edge swipe's
//   UIPercentDrivenInteractiveTransition scrubs them with the screens; a cancelled swipe puts them back.
// - A push waits one main-queue turn before it starts, with the new screen drawn under the old one, so SwiftUI has
//   laid the new screen out and its anchors are where they will be (about one frame).
// - No flight with transition "none", a push at start (no slide), Reduce Motion (animations off), or the SwiftUI
//   navigation variant (ZN_IOS_NAV=swiftui: NavigationStack's own transitions).
import SwiftUI
import UIKit

/// One drawn node with a sharedTag: what a flight needs to know about it, and whether it is hidden while it flies.
@MainActor
@Observable
final class ZnSharedSite {
    /// The node hides while its flight is in the air (the flight draws it instead).
    var hidden = false
    @ObservationIgnored var tag: String?
    @ObservationIgnored var entry: UInt32 = 0
    @ObservationIgnored var spec: ZnNodeSpec?
    @ObservationIgnored weak var inst: ZnInstance?
}

/// A node's sharedTag: its anchor and its opacity while it flies.
struct ZnSharedProbe: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if s.sharedTag == nil && s.sharedTagSlot < 0 {
            content
        } else {
            content.modifier(ZnSharedTagged(s: s, inst: inst))
        }
    }
}

private struct ZnSharedTagged: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znEntry) private var entry
    @State private var site = ZnSharedSite()

    func body(content: Content) -> some View {
        let tag = s.sharedTagSlot >= 0 ? inst.slot(s.sharedTagSlot).value.string : s.sharedTag
        content
            .opacity(site.hidden ? 0 : 1)
            .background(ZnSharedAnchor(site: site, tag: tag, entry: entry, s: s, inst: inst))
    }
}

private struct ZnSharedAnchor: UIViewRepresentable {
    let site: ZnSharedSite
    let tag: String?
    let entry: UInt32
    let s: ZnNodeSpec
    let inst: ZnInstance

    func makeUIView(context: Context) -> ZnSharedAnchorView {
        let v = ZnSharedAnchorView(site: site)
        ZnShared.register(v)
        return v
    }

    func updateUIView(_ v: ZnSharedAnchorView, context: Context) {
        site.tag = tag
        site.entry = entry
        site.spec = s
        site.inst = inst
    }
}

/// The node's box, for the flights: an empty view that takes no touches and isn't in the accessibility tree.
final class ZnSharedAnchorView: UIView {
    let site: ZnSharedSite

    init(site: ZnSharedSite) {
        self.site = site
        super.init(frame: .zero)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        accessibilityElementsHidden = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not from a storyboard") }
}

@MainActor
enum ZnShared {
    private static let anchors = NSHashTable<ZnSharedAnchorView>.weakObjects()

    static func register(_ v: ZnSharedAnchorView) { anchors.add(v) }

    /// The tagged nodes of [entry] drawn inside [root] (the screen's own view), by tag. Two with one tag: the first one
    /// in the window, as Compose matches one element per key.
    static func anchors(entry: UInt32, under root: UIView) -> [String: ZnSharedAnchorView] {
        var out: [String: ZnSharedAnchorView] = [:]
        for v in anchors.allObjects {
            guard v.site.entry == entry, let tag = v.site.tag, !tag.isEmpty, v.isDescendant(of: root) else { continue }
            if let had = out[tag], had.window != nil || v.window == nil { continue }
            out[tag] = v
        }
        return out
    }
}

/// The flights of one transition: the tags on both screens (ZnNavController makes it, its animators run it).
@MainActor
final class ZnSharedFlight {
    private let from: [String: ZnSharedAnchorView]
    private let to: () -> [String: ZnSharedAnchorView]
    /// The destination is a new screen (a push): wait one main-queue turn for SwiftUI to lay it out (the animators).
    let waitsForLayout: Bool

    private struct Flying {
        let view: UIView
        let end: CGRect
        let endRadius: CGFloat
        /// A cross-fade: the source's snapshot goes out, the destination's comes in.
        let out: UIView?
        let into: UIView?
        let sites: [ZnSharedSite]
    }
    private var flying: [Flying] = []

    /// [to] is asked when the flight lifts off: a pushed screen's anchors are made by its first layout.
    init(from: [String: ZnSharedAnchorView], to: @escaping () -> [String: ZnSharedAnchorView], waitsForLayout: Bool) {
        self.from = from
        self.to = to
        self.waitsForLayout = waitsForLayout
    }

    /// Puts a flight view over the source of each tag on both screens, on top of [container]. The source screen sits in
    /// place; the destination [toView] may already be moved for its transition: its anchors are measured in its own
    /// space and placed at its final frame [toFrame]. Before the transition moves anything.
    func lift(in container: UIView, toView: UIView, toFrame: CGRect) {
        let dest = to()
        for (tag, a) in from.sorted(by: { $0.key < $1.key }) {
            guard let b = dest[tag], a.window != nil, b.window != nil, let sa = a.site.spec, let ia = a.site.inst,
                  let sb = b.site.spec, let ib = b.site.inst else { continue }
            let start = a.convert(a.bounds, to: container)
            let end = b.convert(b.bounds, to: toView).offsetBy(dx: toFrame.minX, dy: toFrame.minY)
            guard start.width > 0, start.height > 0, end.width > 0, end.height > 0 else { continue }
            let startRadius = Self.radius(sa, ia, start.size), endRadius = Self.radius(sb, ib, end.size)
            let box: UIView
            var out: UIView?, into: UIView?
            if sa.type == Registry.Component.image, sb.type == Registry.Component.image, let picture = Self.picture(sb, ib) ?? Self.picture(sa, ia) {
                // An image: the picture itself (sharedElement), scaled as the destination draws it.
                let iv = UIImageView(image: picture)
                iv.contentMode = Self.mode(sb.contentScale)
                box = iv
            } else {
                // Anything else, or a picture not loaded: the two looks cross-fade in the moving box (sharedBounds).
                box = UIView()
                out = Self.snapshot(a, fresh: false)
                // A screen coming back (a pop) went into the window this turn: drawn now, else its snapshot is blank.
                into = Self.snapshot(b, fresh: !waitsForLayout)
                // Each keeps its own size and is scaled to the moving box (a snapshot view doesn't stretch its picture),
                // as Compose's sharedBounds scales the two contents to the bounds.
                if let out {
                    out.bounds = CGRect(origin: .zero, size: start.size)
                    out.center = CGPoint(x: start.width / 2, y: start.height / 2)
                    box.addSubview(out)
                }
                if let into {
                    into.bounds = CGRect(origin: .zero, size: end.size)
                    into.center = CGPoint(x: start.width / 2, y: start.height / 2)
                    into.transform = CGAffineTransform(scaleX: start.width / end.width, y: start.height / end.height)
                    if out != nil { into.alpha = 0 }
                    box.addSubview(into)
                }
            }
            box.frame = start
            box.clipsToBounds = true
            box.layer.cornerRadius = startRadius
            box.layer.maskedCorners = Self.corners(endRadius > 0 ? sb.cornersNow(ib) : sa.cornersNow(ia))
            box.isUserInteractionEnabled = false
            container.addSubview(box)
            flying.append(Flying(view: box, end: end, endRadius: endRadius, out: out, into: into, sites: [a.site, b.site]))
        }
        // The originals hide (SwiftUI draws it on its next frame; the flight view covers the source now, and a pushed
        // screen's element is off screen at the start). Under a cross-fade, one main-queue turn later: UIKit takes a
        // snapshot view's picture when this turn's changes are drawn, so hidden now they would be blank (seen
        // 2026-11-23 on a pop).
        let now = flying.filter { $0.out == nil && $0.into == nil }, later = flying.filter { $0.out != nil || $0.into != nil }
        for f in now { for s in f.sites { s.hidden = true } }
        if !later.isEmpty {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                for f in later where self.flying.contains(where: { $0.view === f.view }) { for s in f.sites { s.hidden = true } }
            }
        }
        if !flying.isEmpty {
            print("zn t=\(ZnDebug.ms()) shared: \(flying.count) flight(s): \(from.keys.filter { dest[$0] != nil }.sorted().joined(separator: ", "))")
        }
    }

    /// Inside the transition's animation block: each flight to its destination.
    func fly() {
        for f in flying {
            let middle = CGPoint(x: f.end.width / 2, y: f.end.height / 2)
            if let out = f.out {
                out.center = middle
                out.transform = CGAffineTransform(scaleX: f.end.width / max(out.bounds.width, 1), y: f.end.height / max(out.bounds.height, 1))
                out.alpha = 0
            }
            if let into = f.into {
                into.center = middle
                into.transform = .identity
                into.alpha = 1
            }
            f.view.frame = f.end
            f.view.layer.cornerRadius = f.endRadius
        }
    }

    /// The transition ended (or the swipe was cancelled): the flight views go, the originals show again.
    func land() {
        for f in flying {
            f.view.removeFromSuperview()
            for s in f.sites { s.hidden = false }
        }
        flying = []
    }

    /// The node's corners, one radius (the largest; UIKit animates one), at most half the short side.
    private static func radius(_ s: ZnNodeSpec, _ inst: ZnInstance, _ size: CGSize) -> CGFloat {
        min(s.cornersNow(inst).max() ?? 0, min(size.width, size.height) / 2)
    }

    /// The rounded corners (topStart, topEnd, bottomEnd, bottomStart; the layer's are left / right): the destination's,
    /// else the source's. All four when none is.
    private static func corners(_ c: [CGFloat]) -> CACornerMask {
        guard c.count == 4, c.contains(where: { $0 > 0 }) else {
            return [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMaxXMaxYCorner, .layerMinXMaxYCorner]
        }
        let rtl = UIApplication.shared.userInterfaceLayoutDirection == .rightToLeft
        let parts: [(CGFloat, CACornerMask, CACornerMask)] = [
            (c[0], .layerMinXMinYCorner, .layerMaxXMinYCorner), (c[1], .layerMaxXMinYCorner, .layerMinXMinYCorner),
            (c[2], .layerMaxXMaxYCorner, .layerMinXMaxYCorner), (c[3], .layerMinXMaxYCorner, .layerMaxXMaxYCorner),
        ]
        var mask: CACornerMask = []
        for (r, ltr, rtlMask) in parts where r > 0 { mask.insert(rtl ? rtlMask : ltr) }
        return mask
    }

    /// The node's picture, when it is in ZnImageCache (its src, else its fallbackSrc). A tinted one flies as a snapshot.
    private static func picture(_ s: ZnNodeSpec, _ inst: ZnInstance) -> UIImage? {
        let tint = s.tintColorSlot >= 0 ? znColor(inst.slot(s.tintColorSlot).value) : s.tintColor
        guard tint == nil else { return nil }
        let src = s.srcSlot >= 0 ? inst.slot(s.srcSlot).value.string : s.src
        for which in [src, s.fallbackSrc].compactMap({ $0 }) {
            if let url = znImageURL(which), let image = ZnImageCache.shared.cached(url) { return image }
        }
        return nil
    }

    private static func mode(_ scale: Int) -> UIView.ContentMode {
        switch scale {
        case Registry.ContentScale.contain: return .scaleAspectFit
        case Registry.ContentScale.fill: return .scaleToFill
        default: return .scaleAspectFill  // cover
        }
    }

    /// What the node's box shows now, from its screen's view (what is under and over it in the box too). [fresh]: the
    /// screen isn't on the render server yet (it came into the window this turn): draw it first.
    private static func snapshot(_ a: ZnSharedAnchorView, fresh: Bool) -> UIView? {
        guard let screen = znNearestController(a)?.view else { return nil }
        let rect = a.convert(a.bounds, to: screen)
        return screen.resizableSnapshotView(from: rect, afterScreenUpdates: fresh, withCapInsets: .zero)
    }
}
