// Impressions' rules (useImpressions, impressionKey), a port of Android's ZnImpressions.kt with the clock, the top
// screen, the timer and the event handed in, so the Mac suite (ios/tests/impressions) runs them on a fake clock.
// Foundation only. The app's wiring (UIKit, the probe on each keyed node): ZnImpressions.swift.
//
// - A screen turns it on with `useImpressions(handler, { threshold, minMs })` (NAV IMPRESSIONS → configure).
// - A key counts once it is ≥ threshold visible (for minMs, if set), only while its screen is on top and the app is in
//   front, once per screen visit (until the screen leaves the stack).
// - Counted keys go to JS in batches: at most every 500 ms, and at once when the app goes to the back or the screen
//   leaves.
import Foundation

final class ZnImpressionsCore {
    static let flushMs = 500.0

    private final class Track {
        let threshold: Double
        let minMs: Double
        var counted = Set<String>()
        var fraction: [String: Double] = [:]
        var visibleSince: [String: Double] = [:]
        var pending: [String] = []

        init(threshold: Double, minMs: Double) {
            self.threshold = threshold
            self.minMs = minMs
        }
    }

    /// Milliseconds on a clock that only goes forward.
    private let now: () -> Double
    /// Is this entry the top screen?
    private let isTop: (UInt32) -> Bool
    /// Runs the function after that many milliseconds.
    private let schedule: (Double, @escaping () -> Void) -> Void
    /// Sends {entry, keys} to JS.
    private let emit: (UInt32, [String]) -> Void

    private var tracks: [UInt32: Track] = [:]
    /// Entries in the order they were configured, so a flush sends them in a fixed order.
    private var order: [UInt32] = []
    private var flushScheduled = false

    init(now: @escaping () -> Double, isTop: @escaping (UInt32) -> Bool,
         schedule: @escaping (Double, @escaping () -> Void) -> Void, emit: @escaping (UInt32, [String]) -> Void) {
        self.now = now
        self.isTop = isTop
        self.schedule = schedule
        self.emit = emit
    }

    /// False while the app is not in front. Back in front: what is visible counts; going: what was counted is sent.
    var resumed = true {
        didSet { if resumed { refresh() } else { flush() } }
    }

    /// The runtime is replaced (an OTA update in place, a `zn dev` reload): every tracked screen is dropped unsent.
    func resetForReload() {
        tracks = [:]
        order = []
    }

    /// NAV IMPRESSIONS: the screen [entry] tracks impressions with these settings (JSON {threshold, minMs}). A second
    /// call (the screen built again) starts its counts again, as on Android.
    func configure(_ entry: UInt32, _ params: String?) {
        let o = params.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
        let threshold = min(max((o["threshold"] as? NSNumber)?.doubleValue ?? 0.35, 0.01), 1)
        let minMs = max(((o["minMs"] as? NSNumber)?.doubleValue ?? 0).rounded(.towardZero), 0)
        tracks[entry] = Track(threshold: threshold, minMs: minMs)
        if !order.contains(entry) { order.append(entry) }
    }

    func tracking(_ entry: UInt32) -> Bool { tracks[entry] != nil }

    /// True once [key] was counted on [entry]'s screen (or the screen doesn't track): the node can stop measuring.
    func done(_ entry: UInt32, _ key: String) -> Bool { tracks[entry]?.counted.contains(key) ?? true }

    /// A node with [key] on [entry]'s screen is now [fraction] visible (0 when it left the screen).
    func report(_ entry: UInt32, _ key: String, _ fraction: Double) {
        guard let t = tracks[entry], !t.counted.contains(key) else { return }
        t.fraction[key] = fraction
        evaluate(entry, t, key)
    }

    private func active(_ entry: UInt32) -> Bool { resumed && isTop(entry) }

    private func evaluate(_ entry: UInt32, _ t: Track, _ key: String) {
        let f = t.fraction[key] ?? 0
        guard active(entry), f >= t.threshold else {
            t.visibleSince[key] = nil
            return
        }
        if t.minMs <= 0 { return count(t, key) }
        let now = now()
        let since: Double
        if let s = t.visibleSince[key] {
            since = s
        } else {
            since = now
            t.visibleSince[key] = now
            // Looks again when the time is up (the node may not move again).
            schedule(t.minMs) { [weak self, weak t] in
                guard let self, let t, self.tracks[entry] === t else { return }
                self.evaluate(entry, t, key)
            }
        }
        if now - since >= t.minMs { count(t, key) }
    }

    private func count(_ t: Track, _ key: String) {
        guard t.counted.insert(key).inserted else { return }
        t.visibleSince[key] = nil
        t.fraction[key] = nil
        t.pending.append(key)
        if !flushScheduled {
            flushScheduled = true
            schedule(Self.flushMs) { [weak self] in self?.flush() }
        }
    }

    /// The top screen or the app state changed: count what is already visible on the screen now on top.
    func refresh() {
        for entry in order {
            guard let t = tracks[entry], active(entry) else { continue }
            for key in Array(t.fraction.keys).sorted() { evaluate(entry, t, key) }
        }
    }

    /// Sends every counted key to JS now.
    func flush() {
        flushScheduled = false
        for entry in order {
            guard let t = tracks[entry], !t.pending.isEmpty else { continue }
            let keys = t.pending
            t.pending = []
            emit(entry, keys)
        }
    }

    /// The screen left the back stack: send what it counted and forget it.
    func release(_ entry: UInt32) {
        flush()
        tracks[entry] = nil
        order.removeAll { $0 == entry }
    }
}
