// Impressions (useImpressions, impressionKey): which keyed elements were seen, measured natively, as Android's
// ZnImpressions.kt and its node modifier (ZnRenderer.kt `impression`). The rules: ZnImpressionsCore.swift.
//
// - ZnImpressions: the one tracker. It knows the top screen (ZnApp.stack), whether the app is in front, the 500 ms
//   batches, and sends {entry, keys} to JS (APP event 6). ZnApp calls configure / release / refresh / resetForReload.
// - ZnImpressionProbe (applied in ZnNodeView inside the margin): on a node with an impressionKey, on a screen that
//   tracks, a small UIKit view behind the node measures how much of it is visible: its box in the window, cut by the
//   window and by every scroll view and clipping view around it (Android's boundsInWindow), over its own area.
//   It measures again when it is laid out or moves, when a scroll view around it scrolls, and reports 0 when it leaves
//   the window, sits on a hidden tab or goes away. Once its key has counted it stops (no work while scrolling).
//   Rows and cards a list hasn't made (off screen) cost nothing. JS does nothing while the user scrolls.
//   Difference: Android's boundsInWindow is cut by every layout around the node; here only by the clipping ones
//   (window, scroll views, clipping views, overflow-hidden nodes), so a keyed node that sticks out of a parent that
//   doesn't clip (a negative margin, an absolute child outside it, a translate) counts the part outside too.
import SwiftUI
import UIKit
#if SWIFT_PACKAGE
import ZnHost
#endif

/// One screen's switch, observed by the keyed and overflow-hidden nodes of that screen only: a probe drawn before
/// its screen's useImpressions (the skeleton, before JS) starts measuring when the screen turns it on, and one that
/// stopped (its key counted) measures again when the screen starts its counts again.
@MainActor
@Observable
final class ZnImpressionScreen {
    /// How many times the screen was configured (0: it doesn't track).
    fileprivate(set) var generation = 0
}

@MainActor
final class ZnImpressions {
    static let shared = ZnImpressions()

    /// Every screen a probe asked about (tracking or not), until it leaves the back stack or the runtime is replaced.
    private var screens: [UInt32: ZnImpressionScreen] = [:]
    /// The entries that track impressions.
    private var tracked: Set<UInt32> = []

    private let core = ZnImpressionsCore(
        now: { CACurrentMediaTime() * 1000 },
        isTop: { entry in MainActor.assumeIsolated { ZnApp.shared.stack.last == entry } },
        schedule: { ms, f in
            DispatchQueue.main.asyncAfter(deadline: .now() + ms / 1000) { MainActor.assumeIsolated { f() } }
        },
        emit: { entry, keys in
            MainActor.assumeIsolated {
                guard let json = ZnModules.json(["entry": entry, "keys": keys] as [String: Any]) else { return }
                print("zn t=\(ZnDebug.ms()) impressions: \(keys.count) key(s) on \(entry) → JS: \(keys.prefix(12).joined(separator: ", "))")
                ZNHost.shared.dispatchEvent(0, event: UInt16(ZnAppEvent.impressions), string: json)
            }
        })
    private var watchingApp = false

    /// In front or not, from the app's state (Android: the Activity's resume and pause). Set up with the first screen
    /// that tracks.
    private func watchApp() {
        guard !watchingApp else { return }
        watchingApp = true
        core.resumed = UIApplication.shared.applicationState == .active
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ZnImpressions.shared.core.resumed = true }
        }
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ZnImpressions.shared.core.resumed = false }
        }
    }

    /// NAV IMPRESSIONS: [entry]'s screen counts its keys with these settings ({threshold, minMs}).
    func configure(_ entry: UInt32, _ params: String?) {
        watchApp()
        core.configure(entry, params)
        tracked.insert(entry)
        screen(entry).generation += 1
    }

    func tracking(_ entry: UInt32) -> Bool { tracked.contains(entry) }

    /// [entry]'s switch. Read its generation in a view body: it observes that screen alone.
    func screen(_ entry: UInt32) -> ZnImpressionScreen {
        if let s = screens[entry] { return s }
        let s = ZnImpressionScreen()
        screens[entry] = s
        return s
    }

    func done(_ entry: UInt32, _ key: String) -> Bool { core.done(entry, key) }

    func report(_ entry: UInt32, _ key: String, _ fraction: Double) {
        guard tracked.contains(entry) else { return }
        core.report(entry, key, fraction)
    }

    /// The top screen may have changed: what is visible on the new top screen counts (after the batch is applied).
    func refresh() {
        guard !tracked.isEmpty else { return }
        DispatchQueue.main.async { MainActor.assumeIsolated { ZnImpressions.shared.core.refresh() } }
    }

    /// [entry] left the back stack: what it counted goes to JS now, and it is forgotten. Its nodes, still drawn while
    /// the screen slides away, keep their views (their generation stays) and report nothing more.
    func release(_ entry: UInt32) {
        screens[entry] = nil
        guard tracked.remove(entry) != nil else { return }
        core.release(entry)
    }

    /// The runtime is replaced (an OTA update in place, a `zn dev` reload): every screen is dropped unsent.
    func resetForReload() {
        core.resetForReload()
        tracked = []
        screens = [:]
    }
}

/// The key of a node, written or from its slot; nil when it has none (or an empty one).
@MainActor
func znImpressionKey(_ s: ZnNodeSpec, _ inst: ZnInstance) -> String? {
    let key: String?
    if s.impressionKeySlot >= 0 {
        switch inst.slot(s.impressionKeySlot).value {
        case .string(let k): key = k
        case .number(let n): key = n == n.rounded() && abs(n) < 1e15 ? String(Int64(n)) : String(n)
        default: key = nil
        }
    } else {
        key = s.impressionKey
    }
    return key?.isEmpty == false ? key : nil
}

extension EnvironmentValues {
    /// The boxes of the `overflow: "hidden"` nodes around this view, on a screen that tracks impressions: SwiftUI
    /// clips them without a UIKit view, so a keyed node inside cuts its visible box by each (Android's
    /// boundsInWindow is clipped by them too).
    @Entry var znImpressionClips: [ZnImpressionClipBox] = []
}

/// On a node with an impressionKey or `overflow: "hidden"` (both fixed by the template); nothing on the others. Its
/// structure never changes with the screen's switch or the key: only what sits in the background does, so turning
/// tracking on or off (the skeleton before JS, the screen leaving) keeps the node's state and UIKit views.
struct ZnImpressionProbe: ViewModifier {
    let ctx: ZnContext
    let s: ZnNodeSpec
    let inst: ZnInstance

    func body(content: Content) -> some View {
        if s.hasImpression || s.clip {
            content.modifier(ZnImpressionProbeOn(s: s, inst: inst))
        } else {
            content
        }
    }
}

private struct ZnImpressionProbeOn: ViewModifier {
    let s: ZnNodeSpec
    let inst: ZnInstance
    @Environment(\.znEntry) private var entry
    @Environment(\.znInHiddenTab) private var hidden
    @Environment(\.znImpressionClips) private var clips
    @State private var box = ZnImpressionBox()
    @State private var clipBox = ZnImpressionClipBox()

    func body(content: Content) -> some View {
        // Observes this screen's switch only.
        let generation = entry != 0 ? ZnImpressions.shared.screen(entry).generation : 0
        let tracking = generation > 0
        let key = tracking && s.hasImpression ? znImpressionKey(s, inst) : nil
        let clipOn = tracking && s.clip
        content
            .environment(\.znImpressionClips, clipOn ? clips + [clipBox] : clips)
            .background {
                if let key {
                    ZnImpressionAnchor(entry: entry, key: key, generation: generation, hidden: hidden, clips: clips, box: box)
                }
                if clipOn { ZnImpressionClipMarker(box: clipBox) }
            }
            .onGeometryChange(for: CGRect.self) { key != nil ? $0.frame(in: .global) : .zero } action: { _ in
                box.view?.measureSoon()  // SwiftUI moved the node without resizing it
            }
    }
}

/// An `overflow: "hidden"` node's box, by its marker view. Equal by identity, so a parent drawn again passes an
/// equal list down and the probes inside aren't drawn again.
@MainActor
final class ZnImpressionClipBox: Equatable {
    weak var view: UIView?

    nonisolated static func == (a: ZnImpressionClipBox, b: ZnImpressionClipBox) -> Bool { a === b }
}

private struct ZnImpressionClipMarker: UIViewRepresentable {
    let box: ZnImpressionClipBox

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.isUserInteractionEnabled = false
        v.isAccessibilityElement = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ v: UIView, context: Context) { box.view = v }
}

@MainActor
private final class ZnImpressionBox {
    weak var view: ZnImpressionView?
}

private struct ZnImpressionAnchor: UIViewRepresentable {
    let entry: UInt32
    let key: String
    let generation: Int
    let hidden: Bool
    let clips: [ZnImpressionClipBox]
    let box: ZnImpressionBox

    func makeUIView(context: Context) -> ZnImpressionView {
        let v = ZnImpressionView()
        v.isUserInteractionEnabled = false
        v.isAccessibilityElement = false
        v.backgroundColor = .clear
        return v
    }

    func updateUIView(_ v: ZnImpressionView, context: Context) {
        box.view = v
        v.clips = clips
        v.set(entry: entry, key: key, generation: generation, hidden: hidden)
    }

    static func dismantleUIView(_ v: ZnImpressionView, coordinator: ()) { v.leave() }
}

/// Measures the node it sits behind (the same box: it is the node's background).
final class ZnImpressionView: UIView {
    private var entry: UInt32 = 0
    private var key = ""
    private var generation = 0
    private var onHiddenTab = false
    /// The overflow-hidden boxes around (ZnImpressionClipBox).
    var clips: [ZnImpressionClipBox] = []
    /// The scroll views around this view, watched while the key hasn't counted.
    private var watching: [NSKeyValueObservation] = []

    func set(entry: UInt32, key: String, generation: Int, hidden: Bool) {
        if entry != self.entry || key != self.key {
            // A reused row with another key: the old key left the screen.
            if !self.key.isEmpty { send(0) }
            self.entry = entry
            self.key = key
            self.generation = generation
            watchScrolls()
        } else if generation != self.generation {
            // The screen started its counts again (useImpressions ran again): watch the scrolls again if this key
            // had counted and stopped.
            self.generation = generation
            watchScrolls()
        }
        onHiddenTab = hidden
        measureSoon()
    }

    /// The node went away: its key left the screen.
    func leave() {
        send(0)
        stopWatching()
        key = ""
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        watchScrolls()
        measureSoon()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        measureSoon()
    }

    private var measuring = false

    /// Measures once the layout going on now has settled (one main-queue turn later), and once however many moves
    /// came in between: a list sizing its rows places them first where their estimated sizes put them, and a row
    /// that only passes through the screen there must not count (Android measures rows before it places them).
    func measureSoon() {
        guard !measuring else { return }
        measuring = true
        DispatchQueue.main.async { [weak self] in
            MainActor.assumeIsolated {
                self?.measuring = false
                self?.measure()
            }
        }
    }

    /// How much of this view is visible now, to the tracker.
    func measure() {
        guard !key.isEmpty, entry != 0 else { return }
        let impressions = ZnImpressions.shared
        guard impressions.tracking(entry) else { return }
        if impressions.done(entry, key) { return stopWatching() }  // counted: no more work while scrolling
        send(visibleFraction())
    }

    /// Visible area over own area, 0...1: the box in the window, cut by the window and by each scroll view or
    /// clipping view around it. 0 off the window, on a hidden tab, or under a hidden view.
    private func visibleFraction() -> Double {
        guard !onHiddenTab, let window, !isHidden else { return 0 }
        let area = bounds.width * bounds.height
        guard area > 0 else { return 0 }
        var visible = convert(bounds, to: window).intersection(window.bounds)
        var v = superview
        while let s = v, s !== window, !visible.isNull {
            if s.isHidden { return 0 }
            if s.clipsToBounds || s is UIScrollView { visible = visible.intersection(s.convert(s.bounds, to: window)) }
            v = s.superview
        }
        for c in clips {
            guard let cv = c.view, cv.window === window else { continue }
            visible = visible.intersection(cv.convert(cv.bounds, to: window))
        }
        if visible.isNull || visible.isEmpty { return 0 }
        return min(max(Double(visible.width * visible.height / area), 0), 1)
    }

    private func send(_ fraction: Double) {
        guard !key.isEmpty, entry != 0 else { return }
        ZnImpressions.shared.report(entry, key, fraction)
    }

    /// Watches every scroll view around this one (a List's collection view, a Scroll, a Carousel's rail): scrolling
    /// moves this view without laying it out.
    private func watchScrolls() {
        stopWatching()
        guard window != nil, !key.isEmpty, entry != 0, !ZnImpressions.shared.done(entry, key) else { return }
        var v = superview
        while let s = v {
            if let sv = s as? UIScrollView {
                watching.append(sv.observe(\.contentOffset) { [weak self] _, _ in MainActor.assumeIsolated { self?.measureSoon() } })
                watching.append(sv.observe(\.contentSize) { [weak self] _, _ in MainActor.assumeIsolated { self?.measureSoon() } })
            }
            v = s.superview
        }
    }

    private func stopWatching() {
        watching.forEach { $0.invalidate() }
        watching = []
    }
}
