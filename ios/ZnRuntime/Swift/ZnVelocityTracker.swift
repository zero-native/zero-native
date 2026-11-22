// A finger's speed at the lift (Android: Compose's VelocityTracker, which the gestures use). The impulse strategy of
// Compose's VelocityTracker1D: the last 20 samples, only those within 100 ms of the newest, and none after a 40 ms
// pause (the finger stopped before it lifted: speed 0). Positions in points, times in ms, speeds in points a second.
// Foundation only (the Mac suite ios/tests/gestures runs it).
import Foundation

struct ZnVelocityTracker1D {
    private static let history = 20
    private static let horizonMs: Float = 100
    private static let stoppedMs: Float = 40
    private var times = [Int64](repeating: 0, count: history)
    private var points = [Float](repeating: 0, count: history)
    private var filled = [Bool](repeating: false, count: history)
    private var index = 0

    mutating func add(_ timeMs: Int64, _ x: Float) {
        index = (index + 1) % Self.history
        times[index] = timeMs
        points[index] = x
        filled[index] = true
    }

    mutating func reset() {
        filled = [Bool](repeating: false, count: Self.history)
        index = 0
    }

    /// Points a second (0 with fewer than 2 samples).
    func velocity() -> Float {
        guard filled[index] else { return 0 }
        let newest = times[index]
        var data: [Float] = []
        var time: [Float] = []
        var i = index
        while data.count < Self.history, filled[i] {
            let age = Float(newest - times[i])
            // Impulse: each sample's gap is measured from the newest one (Compose's previousSample = newestSample).
            let gap = Float(abs(times[i] - newest))
            if age > Self.horizonMs || gap > Self.stoppedMs { break }
            data.append(points[i])
            time.append(-age)
            i = (i == 0 ? Self.history : i) - 1
        }
        guard data.count >= 2 else { return 0 }
        return Self.impulse(data, time) * 1000
    }

    /// Compose's calculateImpulseVelocity (data not differential): newest first, times ≤ 0 in ms. Units per ms.
    private static func impulse(_ data: [Float], _ time: [Float]) -> Float {
        var work: Float = 0
        let start = data.count - 1
        var nextTime = time[start]
        var i = start
        while i > 0 {
            let current = nextTime
            nextTime = time[i - 1]
            if current != nextTime {
                let vCurr = (data[i] - data[i - 1]) / (current - nextTime)
                let vPrev = energyToVelocity(work)
                work += (vCurr - vPrev) * abs(vCurr)
                if i == start { work *= 0.5 }
            }
            i -= 1
        }
        return energyToVelocity(work)
    }

    private static func energyToVelocity(_ e: Float) -> Float { (e < 0 ? -1 : e > 0 ? 1 : 0) * (2 * abs(e)).squareRoot() }
}

/// Two axes (Compose's VelocityTracker.addPosition / calculateVelocity / resetTracking).
struct ZnVelocityTracker {
    private var x = ZnVelocityTracker1D()
    private var y = ZnVelocityTracker1D()

    mutating func add(_ timeMs: Int64, _ px: Float, _ py: Float) {
        x.add(timeMs, px)
        y.add(timeMs, py)
    }

    mutating func reset() {
        x.reset()
        y.reset()
    }

    func velocity() -> (x: Float, y: Float) { (x.velocity(), y.velocity()) }
}
