// useTilt() on iOS (Android: ZnTilt in ZnMotionApi.kt; Reanimated's useAnimatedSensor for tilt cards and gyro
// parallax): how the phone leans, from CoreMotion's gravity (the accelerometer when there is no device motion), as x
// (left -1 … right 1) and y (away -1 … towards you 1), turned with the screen and smoothed (ZnTiltFilter,
// ZnMotionMath.swift). It listens only while some JS holds it and the app is active: it stops when the app resigns
// active (Android: onPause) and starts again when it is active with users left. No permission or Info.plist key is
// needed. The simulator has no motion (as the emulator has no sensor): x / y stay 0 there.
import CoreMotion
import UIKit

@MainActor
final class ZnTilt {
    static let shared = ZnTilt()

    private var users: [Int: (x: ZnMotionValue, y: ZnMotionValue)] = [:]
    private lazy var manager = CMMotionManager()
    private var listening = false
    private var observing = false
    private var filter = ZnTiltFilter()
    /// The scene whose orientation turns the axes (read on each reading: a plain property).
    private weak var scene: UIWindowScene?

    /// About Android's SENSOR_DELAY_GAME (20 ms), so the same low-pass smooths over the same time.
    private static let interval: TimeInterval = 0.02

    /// JS's useTilt [id] writes [x] and [y] from now on.
    func add(_ id: Int, _ x: ZnMotionValue, _ y: ZnMotionValue) {
        users[id] = (x, y)
        observe()
        if UIApplication.shared.applicationState == .active { start() }
    }

    func remove(_ id: Int) {
        guard users.removeValue(forKey: id) != nil else { return }
        if users.isEmpty {
            stop()
            filter.reset()  // the next useTilt starts from flat, not from this one's lean
        }
    }

    /// The JS that made them is gone (a reload).
    func reset() {
        users = [:]
        stop()
        filter.reset()
    }

    private func observe() {
        guard !observing else { return }
        observing = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ZnTilt.shared.stop() }
        }
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { ZnTilt.shared.start() }
        }
    }

    private func start() {
        guard !users.isEmpty, !listening else { return }
        scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive } ?? scene
        let m = manager
        if m.isDeviceMotionAvailable {
            m.deviceMotionUpdateInterval = Self.interval
            m.startDeviceMotionUpdates(to: .main) { [weak self] motion, _ in
                guard let g = motion?.gravity else { return }
                MainActor.assumeIsolated { self?.reading(Float(g.x), Float(g.y)) }
            }
        } else if m.isAccelerometerAvailable {
            // The accelerometer reads gravity with the same signs (flat: z -1), plus the hand's moves.
            m.accelerometerUpdateInterval = Self.interval
            m.startAccelerometerUpdates(to: .main) { [weak self] data, _ in
                guard let a = data?.acceleration else { return }
                MainActor.assumeIsolated { self?.reading(Float(a.x), Float(a.y)) }
            }
        } else {
            return  // the simulator: nothing to listen to
        }
        listening = true
    }

    private func stop() {
        guard listening else { return }
        listening = false
        manager.stopDeviceMotionUpdates()
        manager.stopAccelerometerUpdates()
    }

    private func reading(_ gx: Float, _ gy: Float) {
        guard listening else { return }
        let l = filter.feed(gx: gx, gy: gy, Self.turn(scene?.interfaceOrientation ?? .portrait))
        for (x, y) in users.values {
            x.value = l.x
            y.value = l.y
        }
    }

    private static func turn(_ o: UIInterfaceOrientation) -> ZnTiltFilter.Turn {
        switch o {
        case .landscapeRight: return .landscapeRight
        case .landscapeLeft: return .landscapeLeft
        case .portraitUpsideDown: return .upsideDown
        default: return .portrait
        }
    }
}
