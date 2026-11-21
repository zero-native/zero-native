// The parts of ZnTasks (ZnBuiltInModules.swift) with no iOS in them, so the Mac tests check them (ios/tests/push).
import Foundation

/// Calls [f] the first time it is called, never again, from any thread. For a completion that must be answered
/// exactly once (iOS's fetchCompletionHandler: called twice it crashes, never called iOS ends the app).
public final class ZnOnce<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var f: ((T) -> Void)?

    public init(_ f: @escaping (T) -> Void) { self.f = f }

    /// True if this call ran [f].
    @discardableResult public func callAsFunction(_ value: T) -> Bool {
        guard let g = lock.withLock({ () -> ((T) -> Void)? in defer { f = nil }; return f }) else { return false }
        g(value)
        return true
    }

    /// Already called.
    public var done: Bool { lock.withLock { f == nil } }
}

/// A deadline on the main thread that comes on time. A plain asyncAfter this long can run a second or more late (GCD's
/// leeway), and iOS gives a background push about 30 s in all.
public enum ZnDeadline {
    /// Runs [f] on the main thread at [at], at most about 20 ms late. cancel() on the result stops it. Any thread.
    @discardableResult public static func main(at: DispatchTime, _ f: @escaping () -> Void) -> DispatchSourceTimer {
        let t = DispatchSource.makeTimerSource(queue: .main)
        t.schedule(deadline: at, leeway: .milliseconds(20))
        // The handler keeps the timer alive until it fires or is cancelled (then GCD lets the handler go)
        t.setEventHandler {
            t.cancel()
            f()
        }
        t.resume()
        return t
    }
}

enum ZnTaskRules {
    /// What happens when a task's answer-by time passes (ZnTasks.run's answerByMs).
    enum AnswerBy: Equatable {
        /// JS is running it: its signal is aborted and the outcome is timedOut (as at its own time limit).
        case abort
        /// It waits for JS and isn't kept: answered timedOut and dropped (Android drops a queued task at its limit).
        case drop
        /// It waits for JS and is kept: answered timedOut now, and JS still runs it (in this process or the next).
        case answerAndKeep
    }

    static func answerBy(queued: Bool, kept: Bool) -> AnswerBy {
        if !queued { return .abort }
        return kept ? .answerAndKeep : .drop
    }
}
