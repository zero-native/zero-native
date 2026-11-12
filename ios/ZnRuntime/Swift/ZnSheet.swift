// <Sheet> on iOS, both ways (i.1c). Contract, as android/runtime's ZnSheet.kt: `visible` is a JS slot and native never
// writes it; a drag-down (or a tap outside) sends onDismiss, and JS decides: visible false → the sheet goes, true →
// it stays. Detents "content" (its content's height), "half", "full"; the first is where it opens.
//
// UIKit variant: our own sheet in a layer over the full screen (ZnSheetLayer, as Android's), not
// UISheetPresentationController, whose dismiss blocks every touch for ~0.3 s (2026-11-12).
// SwiftUI variant: .sheet(isPresented:) + presentationDetents. SwiftUI has no "attempted to dismiss" callback: the
// sheet is already gone when the binding's setter tells us, so JS can't keep it (it would come back up).
import SwiftUI
import UIKit

struct ZnSheetHost: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec

    var body: some View {
        let visible = s.visibleSlot >= 0 ? inst.slot(s.visibleSlot).value == .bool(true) : s.visible
        switch ZnImpl.sheet {
        case .swiftUI:
            Color.clear.frame(width: 0, height: 0)
                .sheet(isPresented: Binding(get: { visible }, set: { shown in
                    if !shown, s.onDismiss != 0 { ctx.send(inst.id, s.onDismiss, .none) }
                })) {
                    ZnSheetSwiftUIBody(ctx: ctx, t: t, inst: inst, s: s)
                }
        case .uiKit:
            ZnSheetPresenter(ctx: ctx, t: t, inst: inst, s: s, visible: visible)
                .frame(width: 0, height: 0)
        }
    }
}

/// The sheet's own content: the Sheet node drawn as a Column (its style: padding, gap), full width.
struct ZnSheetContent: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    /// UIKit variant: its height whenever it changes, so the "content" detent follows the content (text set after the
    /// sheet opened, a row added; ZeroBill's scanner sheets get their title and text after they open, 2026-11-09).
    var onHeight: ((CGFloat) -> Void)? = nil

    var body: some View {
        if let onHeight {
            if s.detents.contains("content") {
                // Measured: as tall as it wants (the "content" detent is that), at the top of the sheet's area.
                node(fillHeight: false)
                    .fixedSize(horizontal: false, vertical: true)
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { onHeight($0) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                // Half / full only: the sheet's height (as Android), so a list inside (flex: 1) fills it. Measured at
                // its own height, a List had none and the sheet showed blank (2026-11-12).
                node(fillHeight: true).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        } else {
            node(fillHeight: false)
        }
    }

    private func node(fillHeight: Bool) -> some View {
        ZnNodeView(ctx: ctx, t: t, inst: inst, n: s.index, outer: ZnOuter(fillWidth: true, fillHeight: fillHeight),
                   definiteWidth: true, sheetBody: true)
            .padding(.top, 20)  // room for the grabber
    }
}

// MARK: - SwiftUI

struct ZnSheetSwiftUIBody: View {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    @State private var height: CGFloat = 300

    var body: some View {
        ZnSheetContent(ctx: ctx, t: t, inst: inst, s: s)
            .fixedSize(horizontal: false, vertical: true)
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
            .presentationDetents(Set(s.detents.map { d -> PresentationDetent in
                switch d {
                case "half": return .medium
                case "full": return .large
                default: return .height(height)
                }
            }))
            .presentationDragIndicator(.visible)
            .interactiveDismissDisabled(!s.dismissible)
    }
}

// MARK: - UIKit

struct ZnSheetPresenter: UIViewControllerRepresentable {
    let ctx: ZnContext
    let t: ZnTemplate
    let inst: ZnInstance
    let s: ZnNodeSpec
    let visible: Bool

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }

    func updateUIViewController(_ host: UIViewController, context: Context) {
        let c = context.coordinator
        c.onAttempt = { [ctx, inst, s] in if s.onDismiss != 0 { ctx.send(inst.id, s.onDismiss, .none) } }
        if visible, c.sheet == nil {
            let layer = ZnSheetLayer(detents: s.detents, dismissible: s.dismissible)
            layer.content = UIHostingController(rootView: ZnSheetContent(ctx: ctx, t: t, inst: inst, s: s) { [weak layer] h in
                layer?.contentHeight(h)
            })
            layer.onAttempt = { [weak c] in c?.onAttempt() }
            c.sheet = layer
            // animateIn={false}: already at rest, no slide-up or dimming fade (a sheet that is part of a restored
            // screen). Read now, when it opens; later opens read it again.
            let animated = s.animateInSlot >= 0 ? inst.slot(s.animateInSlot).value != .bool(false) : s.animateIn
            layer.atRestOnOpen = !animated
            c.present(layer, from: host, animated: animated)
        } else if !visible, let sheet = c.sheet {
            c.sheet = nil
            // In the same batch as a stack change (pick an app → receipt), close at once: no slide down over the
            // navigation transition (2026-11-08).
            let animated = !ZnApp.shared.batchChangesStack
            // UIKit drops a dismiss sent while a presentation is still running: the sheet stayed up over the next
            // screen (ZeroBill's "Processing Secure Payment" closed 231 ms after it opened, on an iPhone, 2026-11-09).
            // The present's completion closes it instead.
            if c.opening === sheet {
                print("zn t=\(ZnDebug.ms()) sheet: dismiss (JS set visible false) while it opens: closes when it has opened")
                return
            }
            print("zn t=\(ZnDebug.ms()) sheet: dismiss (JS set visible false\(animated ? "" : ", with a stack change: no animation"))")
            sheet.close(animated: animated)
        }
    }

    @MainActor final class Coordinator {
        var sheet: ZnSheetLayer?
        /// The sheet UIKit is presenting now (its present not finished).
        var opening: ZnSheetLayer?
        var onAttempt: () -> Void = {}

        /// Presents [layer] once [host] is in the window. A sheet visible on its screen's first frame (a restored
        /// payment, animateIn false) gets here before SwiftUI has put the host in the window, and UIKit ignores a
        /// present from a view that isn't there ("not in the window hierarchy"): try again each frame, up to ~2 s.
        func present(_ layer: ZnSheetLayer, from host: UIViewController, animated: Bool, tries: Int = 0) {
            guard sheet === layer else { return }  // closed (visible false) before it could open
            // From the frontmost controller over the host: a sheet opened while another (or a Modal) is up goes over it.
            var top = host
            while let p = top.presentedViewController { top = p }
            // Not from a sheet JS just closed, in this same update (a processing sheet swapped for a cancelled one):
            // it is still leaving, and the new sheet went with it (2026-11-12). Its presenter is free a frame later.
            let leaving = (top as? ZnSheetLayer)?.closed == true || top.isBeingDismissed
            guard host.view.window != nil, !leaving else {
                if tries >= 120 { return print("zn sheet: its screen never reached the window; not shown") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.016) { [weak self, weak host] in
                    guard let self, let host else { return }
                    self.present(layer, from: host, animated: animated, tries: tries + 1)
                }
                return
            }
            let wait = tries > 0 ? " after \(tries) frame(s)" : ""
            print("zn t=\(ZnDebug.ms()) sheet: present\(animated ? "" : " (animateIn false: at rest)")\(wait) over \(type(of: top))")
            opening = layer
            top.present(layer, animated: false) { [weak self, weak layer] in
                guard let self, let layer else { return }
                if self.opening === layer { self.opening = nil }
                if self.sheet !== layer {
                    // visible went false while it was being presented.
                    print("zn t=\(ZnDebug.ms()) sheet: opened after JS closed it: dismiss now")
                    layer.close(animated: !ZnApp.shared.batchChangesStack)
                } else {
                    layer.opened(animated: animated)
                }
            }
        }
    }
}

/// The UIKit variant's sheet: a layer over the full screen, presented with no animation (as ZnModal), in which we draw
/// the dim and the sheet and run its drag, detents and slides ourselves, as android/runtime's ZnSheet.kt does.
///
/// Not UISheetPresentationController: while it dismisses, UIKit sends no touch to any window of the app for ~0.3 s,
/// even with dismiss(animated: false) (2026-11-12, a test window over the app got none either), so the first tap after
/// "Continue" was lost (ZeroBill's keypad after the offers sheet). The rule both OSes keep: once a sheet starts closing,
/// the screen below takes the next tap at once, and onDismiss is sent once per close.
/// - A drag-down, a fling or a tap outside sends onDismiss and slides the sheet down, taking no touches; if JS keeps
///   `visible` true, it comes back up after `keepOpen` (Android's KEEP_OPEN_MS). Not dismissible: it springs back.
/// - JS closes it: it leaves the screen at once and a picture of it slides down, taking no touches.
/// - Looks as UIKit's sheet did on iOS 18: dim black 12%, corners 10 pt, a 36 x 5 grabber 5 pt from the top.
final class ZnSheetLayer: UIViewController, UIGestureRecognizerDelegate {
    static let dimAlpha: CGFloat = 0.12
    static let keepOpen = 0.4
    /// pt/s: a faster release is a fling (to the next detent; 1.5x down: a close).
    static let fling: CGFloat = 500

    let detents: [String]
    let dismissible: Bool
    var content: UIHostingController<ZnSheetContent>!
    /// Sends onDismiss (the user asked to close).
    var onAttempt: () -> Void = {}
    var atRestOnOpen = false
    private(set) var closed = false
    /// The user asked to close and JS hasn't answered yet.
    private var dismissing = false
    private var dragging = false
    private var moved = false
    private var open = false
    private var detent: String
    private var contentH: CGFloat = 0
    /// The sheet's top edge, in the view.
    private var top: CGFloat = 0
    private var keyboard: CGFloat = 0
    private var laidOut: [CGFloat] = []
    private var lastY: CGFloat = 0
    private weak var scroll: UIScrollView?
    /// The sheet moved in this drag: the list under the finger stays still for the rest of it.
    private var holdList = false
    private let dim = UIView(), card = UIView(), grabber = UIView()

    init(detents: [String], dismissible: Bool) {
        self.detents = detents.isEmpty ? ["content"] : detents
        self.dismissible = dismissible
        detent = self.detents[0]
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .overFullScreen
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        view.accessibilityViewIsModal = true
        dim.backgroundColor = .black
        dim.alpha = 0
        dim.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapOutside)))
        view.addSubview(dim)
        card.backgroundColor = .white
        card.layer.cornerRadius = 10
        card.layer.cornerCurve = .continuous
        card.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        card.clipsToBounds = true
        view.addSubview(card)
        // The content sees no safe area and no keyboard: the sheet keeps it clear of the home indicator and lifts it
        // over the keyboard, and a drag doesn't lay it out again.
        content.safeAreaRegions = []
        content.view.backgroundColor = .clear
        addChild(content)
        card.addSubview(content.view)
        content.didMove(toParent: self)
        grabber.backgroundColor = UIColor(red: 197 / 255, green: 197 / 255, blue: 200 / 255, alpha: 1)
        grabber.layer.cornerRadius = 2.5
        card.addSubview(grabber)
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
        pan.delegate = self
        card.addGestureRecognizer(pan)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardMoves(_:)),
                                               name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }

    // MARK: Geometry

    private var screenH: CGFloat { view.bounds.height }
    /// Where the sheet's bottom edge rests: the screen's bottom, or the keyboard's top.
    private var bottom: CGFloat { screenH - keyboard }
    private var safeBottom: CGFloat { keyboard > 0 ? 0 : view.safeAreaInsets.bottom }
    private var maxHeight: CGFloat { max(0, bottom - safeBottom - view.safeAreaInsets.top - 10) }

    /// A detent's height, above the home indicator (as UIKit's detents).
    private func height(_ d: String) -> CGFloat {
        switch d {
        case "half": return min(screenH / 2 - view.safeAreaInsets.bottom, maxHeight)
        case "full": return maxHeight
        default: return min(contentH, maxHeight)
        }
    }

    private func rest(_ d: String) -> CGFloat { bottom - safeBottom - height(d) }
    private var rests: [CGFloat] { detents.map(rest) }

    private func place() {
        let w = view.bounds.width
        dim.frame = view.bounds
        let lowest = rests.max() ?? screenH
        let shown = screenH - lowest > 1 ? (screenH - top) / (screenH - lowest) : 0
        dim.alpha = Self.dimAlpha * min(max(shown, 0), 1)
        // The content is as tall as the tallest detent (as Android): moving between detents shows more or less of
        // it, without laying it out again.
        let h = detents.map(height).max() ?? 0
        // Down to the screen's bottom at least: pulled above its top, no gap shows under it.
        card.frame = CGRect(x: 0, y: top, width: w, height: max(screenH - top, height(detent) + safeBottom))
        content.view.frame = CGRect(x: 0, y: 0, width: w, height: h)
        grabber.frame = CGRect(x: (w - 36) / 2, y: 5, width: 36, height: 5)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let key = [view.bounds.width, view.bounds.height, view.safeAreaInsets.top, view.safeAreaInsets.bottom]
        guard key != laidOut else { return }
        let first = laidOut.isEmpty
        laidOut = key
        if first {
            // Before the content has reported its height (onHeight comes after its first layout).
            if contentH == 0 {
                contentH = content.sizeThatFits(in: CGSize(width: view.bounds.width, height: .greatestFiniteMagnitude)).height
            }
            open = atRestOnOpen
            top = atRestOnOpen ? rest(detent) : screenH
        } else if open, !dragging, !dismissing, !closed {
            top = rest(detent)
        }
        place()
    }

    /// Presented: slide up (unless it opened at rest).
    func opened(animated: Bool) {
        guard !closed, !open else { return }
        open = true
        view.layoutIfNeeded()
        animate(to: rest(detent), duration: 0.45)
    }

    /// The content's height whenever it changes: the "content" detent follows it (text set after the sheet opened,
    /// rows added), as Android.
    func contentHeight(_ h: CGFloat) {
        guard abs(h - contentH) > 0.5 else { return }
        contentH = h
        guard isViewLoaded, !laidOut.isEmpty else { return }
        guard open, !dragging, !dismissing, !closed else { return place() }
        print("zn t=\(ZnDebug.ms()) sheet: content now \(Int(h)) pt tall: resize")
        animate(to: rest(detent))
    }

    private func animate(to y: CGFloat, velocity: CGFloat = 0, duration: TimeInterval = 0.4,
                         done: ((Bool) -> Void)? = nil) {
        let distance = y - top
        top = y
        UIView.animate(withDuration: duration, delay: 0, usingSpringWithDamping: 1,
                       initialSpringVelocity: abs(distance) > 1 ? velocity / distance : 0,
                       options: [.allowUserInteraction, .beginFromCurrentState]) { self.place() } completion: { done?($0) }
    }

    // MARK: Closing

    /// Takes touches or lets them through to the screen below. UIKit's container (UITransitionView) holds the view: it
    /// would take them otherwise (ZnModal, 2026-11-12).
    private func takesTouches(_ on: Bool) {
        view.isUserInteractionEnabled = on
        view.superview?.isUserInteractionEnabled = on
        presentationController?.containerView?.isUserInteractionEnabled = on
    }

    /// The user asks to close (drag, fling, tap outside): onDismiss, slide down; back up if JS keeps it.
    private func askToClose(velocity: CGFloat = 0) {
        guard !closed, !dismissing else { return }
        guard dismissible else { return animate(to: rest(detent), velocity: velocity) }
        dismissing = true
        takesTouches(false)
        print("zn t=\(ZnDebug.ms()) sheet: closed by the user → onDismiss to JS")
        onAttempt()
        animate(to: screenH, velocity: velocity, duration: 0.3) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.keepOpen) {
                guard let self, self.dismissing, !self.closed else { return }
                print("zn t=\(ZnDebug.ms()) sheet: JS kept it open: back up")
                self.dismissing = false
                self.takesTouches(true)
                self.animate(to: self.rest(self.detent))
            }
        }
    }

    /// JS closed it: it leaves at once (with whatever it presents: a StoreKit page or share sheet over it, ZeroBill's
    /// store sheet 2026-11-11), so the screen below takes the next tap; a picture of it slides down.
    func close(animated: Bool) {
        closed = true
        takesTouches(false)
        if animated, let window = view.window, let pic = card.snapshotView(afterScreenUpdates: false) {
            let from = card.layer.presentation()?.frame.minY ?? card.frame.minY
            if from < screenH - 1 {
                let ghost = UIView(frame: window.bounds)
                ghost.isUserInteractionEnabled = false
                let shade = UIView(frame: window.bounds)
                shade.backgroundColor = .black
                shade.alpha = CGFloat(dim.layer.presentation()?.opacity ?? Float(dim.alpha))
                pic.frame = CGRect(origin: view.convert(CGPoint(x: 0, y: from), to: window), size: pic.bounds.size)
                ghost.addSubview(shade)
                ghost.addSubview(pic)
                window.addSubview(ghost)
                UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0) {
                    pic.frame.origin.y = window.bounds.height
                    shade.alpha = 0
                } completion: { _ in ghost.removeFromSuperview() }
            }
        }
        (presentingViewController ?? self).dismiss(animated: false)
    }

    @objc private func tapOutside() { askToClose() }

    override func accessibilityPerformEscape() -> Bool {
        askToClose()
        return true
    }

    // MARK: Drag

    func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
        guard let pan = g as? UIPanGestureRecognizer else { return true }
        scroll = nil
        holdList = false
        let v = pan.velocity(in: view)
        guard abs(v.y) > abs(v.x) else { return false }
        // A list inside scrolls first; at its top, pulling down moves the sheet (as UIKit's sheet and Android).
        var hit = card.hitTest(pan.location(in: card), with: nil)
        while let h = hit, h !== card {
            if let s = h as? UIScrollView, s.isScrollEnabled,
               s.contentSize.height + s.adjustedContentInset.top + s.adjustedContentInset.bottom > s.bounds.height + 1 {
                scroll = s
                break
            }
            hit = h.superview
        }
        return true
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        other.view is UIScrollView
    }

    @objc private func pan(_ g: UIPanGestureRecognizer) {
        let y = g.translation(in: view).y
        switch g.state {
        case .began:
            guard !closed, !dismissing else { return }
            dragging = true
            moved = false
            // Caught while it moves: from where it is on screen.
            if let p = card.layer.presentation() { top = p.frame.minY }
            [card, dim, content.view, grabber].forEach { $0.layer.removeAllAnimations() }
            place()
            lastY = y
        case .changed:
            guard dragging, !closed, !dismissing else { return }
            let dy = y - lastY
            lastY = y
            guard dy != 0 else { return }  // (a still step would take the drag from the list)
            let highest = rests.min() ?? 0, lowest = rests.max() ?? screenH
            if let s = scroll, !holdList {
                let atTop = s.contentOffset.y <= -s.adjustedContentInset.top + 0.5
                if dy < 0, top <= highest + 0.5 { return }  // at its tallest: the list scrolls
                if dy > 0, !atTop { return }  // the list scrolls back to its top first
                // The sheet moves: the list's own drag ends here (off and on cancels it), so it stays still and
                // doesn't fling. Pinning its offset on each change looped forever (2026-11-12).
                holdList = true
                s.panGestureRecognizer.isEnabled = false
                s.panGestureRecognizer.isEnabled = true
                s.contentOffset.y = -s.adjustedContentInset.top
            }
            let next = top + dy
            // Rubber-band above its tallest detent, and below its lowest when it can't be dismissed.
            top = next < highest || (!dismissible && next > lowest) ? top + dy * 0.25 : next
            moved = true
            place()
        case .ended, .cancelled, .failed:
            guard dragging else { return }
            dragging = false
            guard moved, !closed, !dismissing else { return }
            settle(velocity: g.velocity(in: view).y)
        default:
            break
        }
    }

    private func settle(velocity v: CGFloat) {
        let named = detents.map { ($0, rest($0)) }.sorted { $0.1 < $1.1 }  // tallest first
        let lowest = named.last?.1 ?? screenH
        if v > Self.fling * 1.5 || (top - lowest > (screenH - lowest) * 0.35 && v > -Self.fling) {
            return askToClose(velocity: v)
        }
        let target = v < -Self.fling ? (named.last { $0.1 < top - 1 } ?? named[0])
            : v > Self.fling ? (named.first { $0.1 > top + 1 } ?? named[named.count - 1])
            : named.min { abs($0.1 - top) < abs($1.1 - top) }!
        detent = target.0
        animate(to: target.1, velocity: v)
    }

    // MARK: Keyboard

    /// Over the keyboard, as UIKit's sheet: it rests on the keyboard's top edge.
    @objc private func keyboardMoves(_ n: Notification) {
        guard let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue,
              let screen = view.window?.screen else { return }
        let kb = view.convert(end, from: screen.coordinateSpace)
        keyboard = max(0, view.bounds.maxY - kb.minY)
        guard open, !dragging, !dismissing, !closed else { return }
        let duration = n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double ?? 0.25
        let curve = n.userInfo?[UIResponder.keyboardAnimationCurveUserInfoKey] as? UInt ?? 7
        top = rest(detent)
        UIView.animate(withDuration: duration, delay: 0,
                       options: [.beginFromCurrentState, UIView.AnimationOptions(rawValue: curve << 16)]) { self.place() }
    }
}
