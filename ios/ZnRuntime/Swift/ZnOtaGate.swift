// The launch gate on iOS (android/runtime ZnOtaGate.kt, docs/ota-patches.md §8). At a cold start the update check
// runs at once. Then:
// - While it runs, the launch screen stays (ZnSplash, when the app holds it), at most Config.launchDecisionMs from the
//   tap. Most starts have no update: a slow answer never holds a start longer than that.
// - Nothing for now (no update, or priority normal): the app opens; a normal update runs from the next start.
// - Priority high or critical: the update screen shows (it carries on from the launch screen), the bundle downloads,
//   and the app swaps to it (ZnOta.applyNow: the same screens open again) before the user is in.
// - Time limit from the tap: launchCapMs for high, launchCapCriticalMs for critical. After a short grace time the
//   gate also leaves early when the download's pace says it can't end in time. Then the app opens on the bundle it
//   has; the download goes on and the update runs from the next start (or when the app calls Updates.applyNow).
// - A hold (Updates.hold, a payment) or an open launch (UPI) refuses the swap: the app opens on the old bundle.
// Not on iOS yet: Android's store phase (Play's in-app update); the app's own store screens read Updates.status().store.
// Main thread only.
import UIKit

/// How the update screen looks: the launch screen (ZnSplash's copy of it) with a title, a line and a progress bar.
public struct ZnUpdateScreen {
    public var title = "Updating for a better experience"
    public var message = "This takes only a few seconds"
    /// The progress bar (the app's brand colour). nil: the tint colour.
    public var accent: UIColor? = nil
    /// The text colour. nil: the label colour.
    public var textColor: UIColor? = nil

    public init(title: String = "Updating for a better experience", message: String = "This takes only a few seconds",
                accent: UIColor? = nil, textColor: UIColor? = nil) {
        self.title = title; self.message = message; self.accent = accent; self.textColor = textColor
    }
}

@MainActor
enum ZnOtaGate {
    private static let graceMs = 400.0
    private static let applyAllowanceMs = 600.0
    private static let lateStartMs = 2_000.0
    private static let tickMs = 50.0
    private static let swapTimeoutMs = 3_000.0

    enum Phase { case off, checking, staging, ready, swapping }

    private(set) static var phase = Phase.off
    private static var tapAt = 0.0
    private static var priority = 0
    private static var screenAt = 0.0
    private static var downloadAt = 0.0
    private static var timer: Timer?
    private static var screen: UIView?
    private static var bar: UIProgressView?

    /// The update screen is up.
    static var showing: Bool { screen != nil }

    /// ZnSplash asks at every frame: keep the launch screen while the check runs (and give way to the update screen).
    static func holdsSplash() -> Bool { phase == .checking }

    private static func nowMs() -> Double { CACurrentMediaTime() * 1000 }

    /// The process's start (the tap), on the CACurrentMediaTime clock; now if it started long ago (a push woke it).
    private static func tapTime() -> Double {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.size
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let now = nowMs()
        guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return now }
        let start = info.kp_proc.p_un.__p_starttime
        let startMs = Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
        let ago = Date().timeIntervalSince1970 * 1000 - startMs
        return ago >= 0 && ago < lateStartMs ? now - ago : now
    }

    /// A cold start with UI (ZnBundles.choose): [check] runs the update check now.
    static func beginCold(_ check: () -> Void) {
        guard let c = ZnOta.config, c.launchDecisionMs > 0, phase == .off else { return }
        tapAt = tapTime()
        priority = 0
        phase = .checking
        print("zn-ota: gate: cold start, checking (waits at most \(Int(c.launchDecisionMs)) ms from the tap, \(Int(nowMs() - tapAt)) ms gone)")
        check()
        tick()
    }

    /// Any thread: the check found an update and starts its download. [p]: 0 normal, 1 high, 2 critical.
    nonisolated static func found(_ p: Int) {
        DispatchQueue.main.async {
            guard phase == .checking else { return }
            priority = p
            if p < 1 { return end("normal priority: it runs from the next start") }
            phase = .staging
            downloadAt = nowMs()
            show()
        }
    }

    /// Any thread: the check ended. [ready]: a bundle is installed and waiting; [p]: its priority.
    nonisolated static func checkDone(ready: Bool, priority p: Int, result: String) {
        DispatchQueue.main.async {
            switch phase {
            case .checking:
                if ready && p >= 1 {
                    priority = p
                    phase = .ready
                    show()
                } else {
                    end(ready ? "normal priority: it runs from the next start" : "nothing to apply (\(result))")
                }
            case .staging:
                if ready { phase = .ready } else { end("the download didn't finish (\(result))") }
            default:
                break
            }
            tick()
        }
    }

    /// From ZnOta.screensUp: the new bundle's screens are built after a swap.
    static func screensUp() {
        if phase == .swapping { end(nil) }
    }

    private static func show() {
        screenAt = nowMs()
        print("zn-ota: gate: priority \(priority >= 2 ? "critical" : "high") update, the update screen shows \(Int(screenAt - tapAt)) ms after the tap")
        guard screen == nil, let window = ZnOta.window() else { return }
        let look = ZnOta.config?.updateScreen ?? ZnUpdateScreen()
        let v = ZnSplash.launchCover(window.bounds)
        v.isUserInteractionEnabled = true  // every touch stops here
        let title = UILabel()
        title.text = look.title
        title.font = .systemFont(ofSize: 20, weight: .semibold)
        let message = UILabel()
        message.text = look.message
        message.font = .systemFont(ofSize: 15)
        for l in [title, message] {
            l.textColor = look.textColor ?? .label
            l.textAlignment = .center
            l.numberOfLines = 0
        }
        message.alpha = 0.7
        let progress = UIProgressView(progressViewStyle: .default)
        progress.progressTintColor = look.accent
        progress.trackTintColor = (look.accent ?? .tintColor).withAlphaComponent(0.15)
        progress.layer.cornerRadius = 2
        progress.clipsToBounds = true
        let stack = UIStackView(arrangedSubviews: [title, message, progress])
        stack.axis = .vertical
        stack.spacing = 10
        stack.setCustomSpacing(24, after: message)
        stack.translatesAutoresizingMaskIntoConstraints = false
        v.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: v.leadingAnchor, constant: 40),
            stack.trailingAnchor.constraint(equalTo: v.trailingAnchor, constant: -40),
            stack.topAnchor.constraint(equalTo: v.centerYAnchor, constant: 110),
            progress.heightAnchor.constraint(equalToConstant: 4),
        ])
        window.addSubview(v)
        screen = v
        bar = progress
    }

    private static func tick() {
        timer?.invalidate()
        timer = nil
        guard phase != .off else { return }
        guard let c = ZnOta.config else { return end("updates are off") }
        let now = nowMs()
        let cap = tapAt + (priority >= 2 ? c.launchCapCriticalMs : c.launchCapMs)
        switch phase {
        case .checking:
            if now >= tapAt + c.launchDecisionMs { return end("no answer within \(Int(c.launchDecisionMs)) ms") }
        case .staging:
            let (ph, prog) = ZnOta.shared.phaseAndProgress()
            bar?.setProgress(Float(ph == "installing" ? 1 : min(max(prog, 0), 1)), animated: true)
            let graceEnds = screenAt + graceMs
            if now >= max(cap, graceEnds) { return end("time limit while \(ph) (\(Int(prog * 100)) %)") }
            if now >= graceEnds && ph == "downloading" && prog > 0 {
                let eta = (now - downloadAt) * (1 - prog) / prog + applyAllowanceMs
                if now + eta > cap { return end("the download can't end in time (about \(Int(eta)) ms left)") }
            }
        case .ready:
            bar?.setProgress(1, animated: true)
            if now >= cap { return end("time limit before the swap") }
            // applyNow needs the running bundle's first screens (it opens the same ones again).
            if ZnApp.shared.firstScreensUp { swap() }
        case .swapping:
            if now >= tapAt + c.launchCapCriticalMs + swapTimeoutMs { return end("the new screens didn't say they are up") }
        case .off:
            return
        }
        guard phase != .off else { return }
        timer = Timer.scheduledTimer(withTimeInterval: tickMs / 1000, repeats: false) { _ in MainActor.assumeIsolated { tick() } }
    }

    private static func swap() {
        phase = .swapping
        let t = nowMs()
        ZnOta.shared.applyNow { r in
            if r["applied"] as? Bool != true {
                end("the swap was refused: \(r["reason"] ?? "") \(r["error"] ?? "")".trimmingCharacters(in: .whitespaces))
            } else {
                print("zn-ota: gate: swapped to \(r["bundle"] ?? "built-in") at the update screen, \(Int(nowMs() - tapAt)) ms after the tap (swap \(Int(nowMs() - t)) ms)")
            }
        }
    }

    /// Ends the gate. [gaveUp]: why the app opens on the bundle it has (nil: it swapped).
    private static func end(_ gaveUp: String?) {
        guard phase != .off else { return }
        let wasShowing = showing
        phase = .off
        timer?.invalidate()
        timer = nil
        if let v = screen {
            screen = nil
            bar = nil
            UIView.animate(withDuration: 0.2, animations: { v.alpha = 0 }, completion: { _ in v.removeFromSuperview() })
        }
        let ms = Int(nowMs() - tapAt)
        if let gaveUp {
            print("zn-ota: gate: the app opens on the bundle it has: \(gaveUp) (\(ms) ms after the tap)")
            // Only a gate that showed the update screen is worth a report (most starts have no update).
            if wasShowing { ZnOta.shared.gateOutcome("gate_timeout", "cold start, priority \(priority): \(gaveUp), \(ms) ms after the tap") }
        } else {
            ZnOta.shared.gateOutcome("gate_swap", "cold start, priority \(priority), \(ms) ms after the tap")
        }
    }
}
