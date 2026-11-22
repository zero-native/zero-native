// The lottie plugin's iOS side (plugins/lottie, as android/.../LottieView.kt, LottieRules.kt, LottieFiles.kt and
// LottieModule.kt): Airbnb's lottie-ios (bun run tools/fetch-lottie-apple.ts), the same as lottie-react-native on iOS, so
// the same files draw the same. The `lottie.view` view and the "Lottie" module (preload), with the same props, events
// and play rules as Android (LottieRules below is LottieRules.kt line for line).
//
// iOS differences:
// - "Reduce Motion" (Settings → Accessibility) does what Android's "Remove animations" does: the view shows where the play
//   would end, at once, and a play without loop ends with onAnimationFinish(false). iOS has no animator scale, so speed is
//   the prop's.
// - progress as a motion value is followed with ZnViewScope.onMotion: the frame is set on each frame the value moves.
// - renderMode: HARDWARE is Lottie's Core Animation engine, SOFTWARE its main-thread engine, AUTOMATIC lets Lottie pick.
//   mergePaths, opacityToLayers and safeMode are Android-only (accepted, not used).
// - Without lottie-ios in the build, the view stays empty and sends failure "failed"; preload answers failed.
import UIKit
#if SWIFT_PACKAGE
import ZnRuntime
#endif
// In the Swift package the SDK is a declared dependency (ios/packages/lottie/Package.swift): without it, stop the build
// instead of building a plugin that quietly does nothing. The CMake builds may leave the SDK out on purpose.
#if SWIFT_PACKAGE && !(canImport(Lottie))
#error("ZnPluginLottie needs Lottie: check ios/packages/lottie/Package.swift")
#endif
#if canImport(Lottie)
import Lottie
#endif

public struct LottiePlugin: ZnPlugin {
    public init() {}

    public func register(_ r: ZnPluginRegistry) {
        r.module(LottieModule())
        r.view("lottie.view") { scope in ZnLottieView(scope) }
    }
}

/// The play rules (LottieRules.kt), apart from UIKit.
enum LottieRules {
    struct Target: Equatable {
        var mode: String
        var playing: Bool
        var restart: Int
        var plays: Int
        var progress: Double?
        var backwards: Bool
        var loop: Bool
        var speed: Double
        var from: Int?
        var to: Int?
    }

    /// The path inside the bundle for `asset:lottie/x.json` (or `asset://...`): plain paths only (no `..`, no leading `/`).
    static func assetPath(_ source: String?) -> String? {
        guard let source else { return nil }
        let path: String
        if source.hasPrefix("asset://") { path = String(source.dropFirst(8)) } else if source.hasPrefix("asset:") { path = String(source.dropFirst(6)) } else { return nil }
        if path.isEmpty || path.hasPrefix("/") || path.contains("\\") || path.hasSuffix("/") { return nil }
        if path.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) { return nil }
        return path
    }

    static func playing(_ mode: String, _ autoPlay: Bool) -> Bool {
        switch mode {
        case "play": return true
        case "auto": return autoPlay
        default: return false
        }
    }

    /// Where a play goes from (progress), or nil to stay. `prev` nil: the first answer after a file loads.
    static func start(_ prev: Target?, _ next: Target, current: Double, min: Double, max: Double) -> Double? {
        let fromStart = next.playing && next.backwards ? max : min
        guard let prev else { return next.playing ? fromStart : Swift.min(Swift.max(next.progress ?? 0, min), max) }
        if next.restart != prev.restart { return fromStart }
        if let p = next.progress, p != prev.progress { return Swift.min(Swift.max(p, min), max) }
        if next.playing && (!prev.playing || next.plays != prev.plays) {
            let atEnd = next.backwards ? current <= min : current >= max
            return atEnd ? fromStart : nil
        }
        return current < min || current > max ? Swift.min(Swift.max(current, min), max) : nil
    }

    static func cancelled(_ prev: Target?, _ next: Target, wasRunning: Bool) -> Bool {
        guard wasRunning, let prev else { return false }
        return next.mode == "stop" && (prev.mode != "stop" || prev.restart != next.restart)
    }

    static func newPlay(_ prev: Target?, _ next: Target) -> Bool {
        next.playing && (prev == nil || !prev!.playing || prev!.restart != next.restart || prev!.plays != next.plays)
    }

    /// A play without loop that reached its end stays over until the next play(), resume() or reset().
    static func afterEnd(_ t: Target, ended: (Int, Int)?) -> Target {
        guard t.playing, let e = ended, e == (t.restart, t.plays) else { return t }
        var out = t
        out.playing = false
        return out
    }

    static func part(_ from: Int?, _ to: Int?) -> ClosedRange<Int>? {
        guard let from, let to else { return nil }
        return Swift.min(from, to)...Swift.max(from, to)
    }

    static func backwards(_ speed: Double, _ from: Int?, _ to: Int?) -> Bool {
        if let from, let to { return from > to }
        return speed < 0
    }

    /// lottie-react-native on iOS: "Layer.Group" paints everything under it ("Layer.Group.**.Color").
    static func colorKeypath(_ keypath: String) -> String { "\(keypath).**.Color" }
}

#if canImport(Lottie)
/// Reads and parses files from the app's bundle folder, on one queue; 20 parsed animations kept (as Lottie on Android).
enum LottieFiles {
    static let queue = DispatchQueue(label: "zn-lottie")
    private static let cache: NSCache<NSString, LottieAnimation> = { let c = NSCache<NSString, LottieAnimation>(); c.countLimit = 20; return c }()

    enum Load { case ok(LottieAnimation), failed(String) }

    /// On `queue`. `base`: the bundle folder (ZnApp.bundleURL), read on the main thread by the caller.
    static func load(_ source: String?, cache useCache: Bool, base: URL?) -> Load {
        guard let path = LottieRules.assetPath(source), base != nil else { return .failed("bad_source") }
        let key = "zn-lottie:app:\(path)" as NSString
        if useCache, let hit = cache.object(forKey: key) { return .ok(hit) }
        let url = ZnBundles.assetURL(path)  // the running bundle's copy, else the app's own
        guard FileManager.default.fileExists(atPath: url.path) else { return .failed("not_found") }
        guard let data = try? Data(contentsOf: url) else { return .failed("failed") }
        let animation: LottieAnimation?
        if data.starts(with: [0x50, 0x4B]) {  // "PK": a .lottie (zip); Lottie looks at the bytes, not the name
            animation = (try? DotLottieFile.SynchronouslyBlockingCurrentThread.loadedFrom(data: data, filename: url.lastPathComponent).get())?.animations.first?.animation
        } else {
            animation = try? LottieAnimation.from(data: data)
        }
        guard let a = animation, a.endFrame > a.startFrame else {
            print("zn lottie: \(path) is not a Lottie animation")
            return .failed("broken")
        }
        if useCache { cache.setObject(a, forKey: key) }
        return .ok(a)
    }

    /// The file's own numbers: 200 × 200, 36 frames, 1200 ms.
    static func info(_ a: LottieAnimation) -> [String: Any] {
        let frames = Int((a.endFrame - a.startFrame).rounded())
        return ["width": Int(a.size.width.rounded()), "height": Int(a.size.height.rounded()),
                "durationMs": a.framerate > 0 ? Int((Double(frames) * 1000 / a.framerate).rounded()) : 0,
                "frames": frames, "frameRate": a.framerate]
    }
}
#endif

final class LottieModule: ZnModuleBase, @unchecked Sendable {
    init() {
        super.init("Lottie", version: 1)
        // Parses a file into the cache now, so a view shows it at once later. Never rejects for a bad file.
        function("preload", onMain: true) { call in
            guard let source = call.args["source"] as? String else { throw ZnInvalidArgs("\"source\" must be a string") }
            #if canImport(Lottie)
            let base = MainActor.assumeIsolated { ZnApp.shared.bundleURL }
            LottieFiles.queue.async {
                switch LottieFiles.load(source, cache: true, base: base) {
                case .ok(let a): call.resolve(LottieFiles.info(a).merging(["ok": true]) { $1 })
                case .failed(let reason): call.resolve(["ok": false, "reason": reason])
                }
            }
            #else
            _ = source
            call.resolve(["ok": false, "reason": "failed"])
            #endif
        }
    }
}

/// The `lottie.view` view.
final class ZnLottieView: UIView {
    private let scope: ZnViewScope
    #if canImport(Lottie)
    private var view: LottieAnimationView?
    private var renderMode = ""
    private var animation: LottieAnimation?
    private var loaded: (source: String?, cache: Bool)?
    private var loadToken = 0
    private var props: [String: Any] = [:]
    // What the last play saw (Android's `Last`).
    private var lastAnimation: LottieAnimation?
    private var lastTarget: LottieRules.Target?
    private var running = false
    private var ended: (Int, Int)?
    private var playToken = 0
    private var filtersSet: [String] = []
    #endif

    init(_ scope: ZnViewScope) {
        self.scope = scope
        super.init(frame: .zero)
        clipsToBounds = true
        scope.onProps = { [weak self] p in self?.apply(p) }
        apply(scope.props)
        #if canImport(Lottie)
        // Registry 24: `progress` as a motion value moves the frame on each frame it changes (no JS); plays wait.
        scope.onMotion("progress") { [weak self] v in self?.drive(v) }
        NotificationCenter.default.addObserver(self, selector: #selector(motionChanged), name: UIAccessibility.reduceMotionStatusDidChangeNotification, object: nil)
        #endif
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        #if canImport(Lottie)
        view?.frame = bounds
        #endif
    }

    private func apply(_ p: [String: Any]) {
        #if canImport(Lottie)
        props = p
        let mode = p["renderMode"] as? String ?? "AUTOMATIC"
        if view == nil || mode != renderMode { makeView(mode) }
        switch p["resizeMode"] as? String {
        case "cover": view?.contentMode = .scaleAspectFill
        case "center": view?.contentMode = .center
        default: view?.contentMode = .scaleAspectFit
        }
        let source = p["source"] as? String, cache = p["cache"] as? Bool ?? true
        if loaded == nil || loaded!.source != source || loaded!.cache != cache {
            loaded = (source, cache)
            load(source, cache)
        } else {
            setFilters()
            run()
        }
        #else
        scope.emit("failure", ["error": "failed"])
        #endif
    }

    #if canImport(Lottie)
    private func makeView(_ mode: String) {
        renderMode = mode
        let engine: RenderingEngineOption = mode == "HARDWARE" ? .coreAnimation : mode == "SOFTWARE" ? .mainThread : .automatic
        // Reduce Motion is handled below with RN's events, so Lottie's own switch is off.
        let v = LottieAnimationView(configuration: LottieConfiguration(renderingEngine: engine, reducedMotionOption: .standardMotion))
        v.backgroundBehavior = .pauseAndRestore
        v.frame = bounds
        view?.removeFromSuperview()
        addSubview(v)
        view = v
        filtersSet = []
        if let a = animation {
            v.animation = a
            lastTarget = nil  // a new view: the first answer again
            lastAnimation = nil
            setFilters()
            run()
        }
    }

    private func load(_ source: String?, _ cache: Bool) {
        animation = nil
        view?.animation = nil
        loadToken += 1
        let token = loadToken
        guard source != nil else { return }
        let base = ZnApp.shared.bundleURL
        LottieFiles.queue.async {
            let r = LottieFiles.load(source, cache: cache, base: base)
            DispatchQueue.main.async { [weak self] in
                guard let self, token == self.loadToken else { return }
                switch r {
                case .ok(let a):
                    self.animation = a
                    self.view?.animation = a
                    self.filtersSet = []
                    self.scope.emit("loaded", LottieFiles.info(a))
                    self.setFilters()
                    self.run()
                case .failed(let reason):
                    self.scope.emit("failure", ["error": reason])
                }
            }
        }
    }

    private func setFilters() {
        guard let v = view else { return }
        let list = (props["colorFilters"] as? [[String: Any]] ?? []).compactMap { f -> (String, Int)? in
            guard let k = f["keypath"] as? String, !k.isEmpty, let c = (f["color"] as? NSNumber)?.int64Value else { return nil }
            return (k, Int(c))
        }
        let ids = list.map { "\($0.0)=\($0.1)" }
        guard ids != filtersSet else { return }
        filtersSet = ids
        for (keypath, argb) in list {
            let u = UInt32(truncatingIfNeeded: argb)
            let color = LottieColor(r: Double((u >> 16) & 0xFF) / 255, g: Double((u >> 8) & 0xFF) / 255, b: Double(u & 0xFF) / 255, a: Double(u >> 24) / 255)
            v.setValueProvider(ColorValueProvider(color), keypath: AnimationKeypath(keypath: LottieRules.colorKeypath(keypath)))
        }
    }

    @objc private func motionChanged() {
        motionToggled = true  // Android's effect is keyed on the animator scale too: run even with the same props
        run()
    }

    private func target() -> LottieRules.Target {
        let p = props
        let speed = (p["speed"] as? Double).flatMap { $0.isFinite ? $0 : nil } ?? 1
        let from = (p["from"] as? NSNumber)?.intValue, to = (p["to"] as? NSNumber)?.intValue
        let mode = p["mode"] as? String ?? "auto"
        return LottieRules.Target(
            mode: mode, playing: LottieRules.playing(mode, p["autoPlay"] as? Bool ?? false),
            restart: (p["restart"] as? NSNumber)?.intValue ?? 0, plays: (p["plays"] as? NSNumber)?.intValue ?? 0,
            progress: (p["progress"] as? Double).map { min(max($0, 0), 1) },
            backwards: LottieRules.backwards(speed, from, to), loop: p["loop"] as? Bool ?? true, speed: speed, from: from, to: to)
    }

    /// A motion value's progress: the frame it shows (Android draws `driven()` in place of the player's progress).
    private func drive(_ p: Float) {
        guard let v = view, animation != nil, p.isFinite else { return }
        v.currentProgress = AnimationProgressTime(min(max(p, 0), 1))
    }

    /// Android's play effect: runs on each props change and when the file loads.
    private func run() {
        guard let a = animation, let v = view else { return }
        // While a motion value drives it, autoPlay and play() do nothing (Android's effect returns at once).
        if let read = scope.motion("progress") {
            if running || !driven { playToken += 1 }
            running = false
            driven = true
            v.pause()
            drive(read())
            return
        }
        if driven {
            driven = false
            motionToggled = true  // as Android's effect keyed on `driven`: run the play rules again
        }
        let same = lastAnimation === a
        let prev = same ? lastTarget : nil
        let wasRunning = running && prev != nil
        let t = LottieRules.afterEnd(target(), ended: same ? ended : nil)
        if same, prev == t, !motionToggled { return }  // nothing changed for the player
        motionToggled = false
        lastAnimation = a
        lastTarget = t
        running = false
        if !same { ended = nil }
        playToken += 1
        let token = playToken
        if LottieRules.cancelled(prev, t, wasRunning: wasRunning) { scope.emit("finish", ["isCancelled": true]) }

        let part = LottieRules.part(t.from, t.to)
        let minP = part.map { a.progressTime(forFrame: Double($0.lowerBound)) } ?? 0
        let maxP = part.map { a.progressTime(forFrame: Double($0.upperBound)) } ?? 1
        let current = Double(v.currentProgress)
        let start = LottieRules.start(prev, t, current: current, min: minP, max: maxP)

        guard t.playing else {
            v.pause()
            if let s = start { v.currentProgress = s }
            return
        }
        if UIAccessibility.isReduceMotionEnabled {
            v.pause()
            v.currentProgress = t.backwards ? minP : maxP
            if !t.loop && LottieRules.newPlay(prev, t) {
                ended = (t.restart, t.plays)
                scope.emit("finish", ["isCancelled": false])
            }
            return
        }
        v.animationSpeed = abs(t.speed)
        running = true
        let from = start ?? current, to = t.backwards ? minP : maxP
        let fromStart = t.backwards ? maxP : minP
        let finished: (Bool) -> Void = { [weak self] done in
            guard let self, done, token == self.playToken else { return }
            if t.loop {
                // On from where it was to the end, then the whole part again and again.
                v.play(fromProgress: fromStart, toProgress: to, loopMode: .loop)
                return
            }
            self.running = false
            self.ended = (t.restart, t.plays)
            self.scope.emit("finish", ["isCancelled": false])
        }
        v.play(fromProgress: from, toProgress: to, loopMode: .playOnce, completion: finished)
    }

    private var motionToggled = false
    private var driven = false
    #endif
}
