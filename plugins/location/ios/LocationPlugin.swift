// The location plugin's iOS side (plugins/location, as android/.../LocationModule.kt and LocationRules.kt): Core
// Location for fixes, CLGeocoder for addresses. The same calls, answers and rules as Android:
// - current: a one-shot that stops at the first fix good enough for its accuracy (high 25 m, balanced 100 m, low any) or
//   at its timeout (10 s default, 60 s at most) with the best fix seen; a cached fix answers at once only within maxAgeMs.
// - watch: fixes as the event "watch" until JS cancels; paused while the app is hidden; "off" when location goes off.
// - Nothing runs while the app is hidden: a one-shot answers "background".
// - Coordinates and addresses never go in a log line.
//
// iOS differences:
// - One permission ("while using"); "precise" is the user's switch in the same dialog. Asked through core's Permissions
//   (JS picks iOS's names). Never "always": no background location.
// - No providers: a fix's provider is "fused"; `providers` says gps = precise, network = allowed, both when location is on.
// - turnOn: iOS has no "turn on location" dialog, so it answers { on: false, reason: "unavailable" } when location is off,
//   and JS's fallback opens Settings. openSettings opens this app's page in Settings (iOS lets an app open no other).
// - mocked: iOS 15's "simulated by software" flag (the simulator's and Xcode's fake locations).
import Contacts
import CoreLocation
import UIKit

struct LocationPlugin: ZnPlugin {
    func register(_ r: ZnPluginRegistry) {
        r.module(LocationModule())
    }
}

/// The rules, as LocationRules.kt (times in seconds since boot are not needed here: CLLocation has its own timestamp).
enum LocationRules {
    enum Accuracy {
        case high, balanced, low
        var goodEnoughM: Double { switch self { case .high: 25; case .balanced: 100; case .low: .greatestFiniteMagnitude } }
        var desired: CLLocationAccuracy {
            switch self {
            case .high: kCLLocationAccuracyBest
            case .balanced: kCLLocationAccuracyHundredMeters
            case .low: kCLLocationAccuracyKilometer
            }
        }
    }

    static func accuracy(_ name: String?) -> Accuracy? {
        switch name {
        case nil, "balanced": .balanced
        case "high": .high
        case "low": .low
        default: nil
        }
    }

    static func timeoutMs(_ v: Double?) -> Double { min(max(v ?? 10_000, 500), 60_000) }
    static func maxAgeMs(_ v: Double?) -> Double { max(v ?? 0, 0) }
    static func intervalMs(_ v: Double?) -> Double { min(max(v ?? 5_000, 1_000), 600_000) }
    static func distanceM(_ v: Double?) -> Double { min(max(v ?? 0, 0), 10_000) }
    static func geocodeMax(_ v: Int?) -> Int { min(max(v ?? 1, 1), 5) }

    /// A real place: finite, in range, and not 0,0.
    static func valid(_ lat: Double, _ lon: Double) -> Bool {
        lat.isFinite && lon.isFinite && (-90...90).contains(lat) && (-180...180).contains(lon) && !(lat == 0 && lon == 0)
    }

    static func accuracyM(_ l: CLLocation) -> Double? { l.horizontalAccuracy >= 0 ? l.horizontalAccuracy : nil }

    /// A fix made before the ask (minus a little slack) is a cached one Core Location sent at once.
    static func fresh(_ l: CLLocation, since start: Date, precise: Bool) -> Bool {
        l.timestamp >= start.addingTimeInterval(precise ? -2 : -11 * 60)
    }

    /// The more accurate one; same accuracy: the newer one.
    static func better(_ best: CLLocation?, _ l: CLLocation) -> CLLocation {
        guard let best else { return l }
        let a = accuracyM(best) ?? .greatestFiniteMagnitude, b = accuracyM(l) ?? .greatestFiniteMagnitude
        return b < a || (b == a && l.timestamp > best.timestamp) ? l : best
    }

    /// Approximate fixes are blurred to kilometres: waiting can't make them better, so the first one wins.
    static func goodEnough(_ l: CLLocation, _ accuracy: Accuracy, precise: Bool) -> Bool {
        !precise || accuracy == .low || (accuracyM(l).map { $0 <= accuracy.goodEnoughM } ?? false)
    }
}

final class LocationModule: ZnModuleBase, @unchecked Sendable {
    // Main thread only, all of it.
    private var asks: [ObjectIdentifier: Ask] = [:]
    private var watches: [String: Watch] = [:]
    private var inFront = UIApplication.shared.applicationState == .active
    private lazy var probe = CLLocationManager()

    @MainActor init() {
        super.init("Location", version: 2)  // 2: turnOn
        let nc = NotificationCenter.default
        nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onFront() }
        }
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onBack() }
        }

        function("providers", onMain: true) { call in call.resolve(MainActor.assumeIsolated { self.providers() }) }
        function("lastKnown", onMain: true) { call in
            call.resolve(MainActor.assumeIsolated { self.lastKnown().map(Self.json) ?? NSNull() })
        }
        // Answers { position, reason, lastKnown }; never rejects for a location reason.
        function("current", onMain: true) { call in
            let accuracy = try Self.accuracyArg(call)
            let timeout = LocationRules.timeoutMs(call.args["timeoutMs"] as? Double)
            let maxAge = LocationRules.maxAgeMs(call.args["maxAgeMs"] as? Double)
            MainActor.assumeIsolated { self.current(call, accuracy, timeoutMs: timeout, maxAgeMs: maxAge) }
        }
        // Runs until JS cancels; answers only if the watch can't run: { reason }.
        function("watch", onMain: true) { call in
            guard let id = call.args["id"] as? String else { throw ZnInvalidArgs("\"id\" must be a string") }
            let accuracy = try Self.accuracyArg(call)
            let interval = LocationRules.intervalMs(call.args["intervalMs"] as? Double)
            let distance = LocationRules.distanceM(call.args["distanceFilterM"] as? Double)
            MainActor.assumeIsolated { self.startWatch(id, call, accuracy, intervalMs: interval, distanceM: distance) }
        }
        function("turnOn", onMain: true) { call in
            call.resolve(CLLocationManager.locationServicesEnabled() ? ["on": true] : ["on": false, "reason": "unavailable"])
        }
        function("openSettings", onMain: true) { call in
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return call.resolve(false) }
            UIApplication.shared.open(url) { call.resolve($0) }
        }
        function("reverseGeocode", onMain: true) { call in
            guard let lat = call.args["latitude"] as? Double, let lon = call.args["longitude"] as? Double else {
                throw ZnInvalidArgs("\"latitude\" and \"longitude\" must be numbers")
            }
            let max = LocationRules.geocodeMax(call.args["max"] as? Int)
            guard LocationRules.valid(lat, lon) else { return call.resolve(Self.geocoded(nil, "invalid")) }
            Self.geocode(call, max) { $0.reverseGeocodeLocation(CLLocation(latitude: lat, longitude: lon), completionHandler: $1) }
        }
        function("geocode", onMain: true) { call in
            guard let raw = call.args["query"] as? String else { throw ZnInvalidArgs("\"query\" must be a string") }
            let query = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            let max = LocationRules.geocodeMax(call.args["max"] as? Int)
            guard !query.isEmpty else { return call.resolve(Self.geocoded(nil, "invalid")) }
            Self.geocode(call, max) { $0.geocodeAddressString(query, completionHandler: $1) }
        }
    }

    private static func accuracyArg(_ call: ZnCall) throws -> LocationRules.Accuracy {
        let name = call.args["accuracy"] as? String
        guard let a = LocationRules.accuracy(name) else {
            throw ZnInvalidArgs("\"accuracy\" must be \"high\", \"balanced\" or \"low\", not \"\(name ?? "")\"")
        }
        return a
    }

    // MARK: What the phone allows

    @MainActor private var allowed: Bool { [.authorizedWhenInUse, .authorizedAlways].contains(probe.authorizationStatus) }
    @MainActor private var precise: Bool { allowed && probe.accuracyAuthorization == .fullAccuracy }

    @MainActor private func providers() -> [String: Any] {
        let on = CLLocationManager.locationServicesEnabled()
        return ["enabled": on, "gps": on && precise, "network": on && allowed, "hasGps": true, "hasNetwork": true,
                "fine": precise, "coarse": allowed]
    }

    @MainActor private func lastKnown() -> CLLocation? {
        guard allowed, let l = probe.location, LocationRules.valid(l.coordinate.latitude, l.coordinate.longitude) else { return nil }
        return l
    }

    /// Why a one-shot or a watch can't start, or nil.
    @MainActor private func cantStart(oneShot: Bool) -> String? {
        if !allowed { return "denied" }
        if oneShot && !inFront { return "background" }
        if !CLLocationManager.locationServicesEnabled() { return "off" }
        return nil
    }

    // MARK: One fix

    /// CLLocationManager's delegate must be an NSObject: this one forwards to a closure.
    private final class Listener: NSObject, CLLocationManagerDelegate {
        let manager = CLLocationManager()
        var onFix: (CLLocation) -> Void = { _ in }
        var onChange: () -> Void = {}
        override init() {
            super.init()
            manager.delegate = self
        }
        func locationManager(_ m: CLLocationManager, didUpdateLocations locations: [CLLocation]) { locations.forEach(onFix) }
        func locationManager(_ m: CLLocationManager, didFailWithError error: Error) {}  // kCLErrorLocationUnknown: keep trying
        func locationManagerDidChangeAuthorization(_ m: CLLocationManager) { onChange() }
    }

    @MainActor private final class Ask {
        let call: ZnCall
        let accuracy: LocationRules.Accuracy
        let start = Date()
        let precise: Bool
        let listener = Listener()
        var best: CLLocation?
        var timer: Timer?
        init(_ call: ZnCall, _ accuracy: LocationRules.Accuracy, precise: Bool) {
            self.call = call; self.accuracy = accuracy; self.precise = precise
        }
    }

    @MainActor private func current(_ call: ZnCall, _ accuracy: LocationRules.Accuracy, timeoutMs: Double, maxAgeMs: Double) {
        let cached = lastKnown()
        if let c = cached, maxAgeMs > 0, -c.timestamp.timeIntervalSinceNow * 1000 <= maxAgeMs {
            print("zn location: ask answered from cache")
            return call.resolve(Self.answer(c, nil, nil))
        }
        if let reason = cantStart(oneShot: true) {
            print("zn location: ask refused (\(reason))")
            return call.resolve(Self.answer(nil, reason, cached))
        }
        let ask = Ask(call, accuracy, precise: precise)
        let key = ObjectIdentifier(ask)
        asks[key] = ask
        ask.listener.manager.desiredAccuracy = accuracy.desired
        ask.listener.onFix = { [weak self, weak ask] l in
            guard let self, let ask else { return }
            MainActor.assumeIsolated { self.onAskFix(ask, l) }
        }
        ask.timer = Timer.scheduledTimer(withTimeInterval: timeoutMs / 1000, repeats: false) { [weak self, weak ask] _ in
            guard let self, let ask else { return }
            MainActor.assumeIsolated { self.endAsk(ask, "timeout") }
        }
        call.onCancel { [weak self, weak ask] in
            DispatchQueue.main.async {
                guard let self, let ask else { return }
                MainActor.assumeIsolated { self.endAsk(ask, "cancelled") }
            }
        }
        print("zn location: ask (\(accuracy))")
        ask.listener.manager.startUpdatingLocation()
    }

    @MainActor private func onAskFix(_ ask: Ask, _ l: CLLocation) {
        guard asks[ObjectIdentifier(ask)] != nil, LocationRules.valid(l.coordinate.latitude, l.coordinate.longitude),
              LocationRules.fresh(l, since: ask.start, precise: ask.precise) else { return }
        ask.best = LocationRules.better(ask.best, l)
        if LocationRules.goodEnough(l, ask.accuracy, precise: ask.precise) { endAsk(ask, "fix") }
    }

    /// Ends a one-shot once: with any fix seen it answers the best one; else `why` is the reason.
    @MainActor private func endAsk(_ ask: Ask, _ why: String) {
        guard asks.removeValue(forKey: ObjectIdentifier(ask)) != nil else { return }
        ask.timer?.invalidate()
        ask.listener.manager.stopUpdatingLocation()
        print("zn location: ask off (\(why)\(ask.best != nil && why != "fix" ? ", best so far" : ""))")
        ask.call.resolve(ask.best.map { Self.answer($0, nil, nil) } ?? Self.answer(nil, why, lastKnown()))
    }

    // MARK: Updates

    @MainActor private final class Watch {
        let id: String
        let call: ZnCall
        let intervalMs: Double
        let listener = Listener()
        var lastSent: Date?
        var offSent = false
        var running = false
        init(_ id: String, _ call: ZnCall, intervalMs: Double) { self.id = id; self.call = call; self.intervalMs = intervalMs }
    }

    @MainActor private func startWatch(_ id: String, _ call: ZnCall, _ accuracy: LocationRules.Accuracy, intervalMs: Double, distanceM: Double) {
        if let old = watches[id] { stopWatch(old, "replaced") }
        if !allowed { return call.resolve(["reason": "denied"]) }
        let w = Watch(id, call, intervalMs: intervalMs)
        watches[id] = w
        let m = w.listener.manager
        m.desiredAccuracy = accuracy.desired
        m.distanceFilter = distanceM > 0 ? distanceM : kCLDistanceFilterNone
        w.listener.onFix = { [weak self, weak w] l in
            guard let self, let w else { return }
            MainActor.assumeIsolated { self.onWatchFix(w, l) }
        }
        w.listener.onChange = { [weak self, weak w] in
            guard let self, let w else { return }
            MainActor.assumeIsolated { self.watchSettingsChanged(w) }
        }
        call.onCancel { [weak self, weak w] in
            DispatchQueue.main.async {
                guard let self, let w else { return }
                MainActor.assumeIsolated { if self.watches[w.id] === w { self.stopWatch(w, "stopped") } }
            }
        }
        print("zn location: watch \(id) (\(accuracy), \(Int(intervalMs)) ms)")
        if inFront { listen(w) } else { print("zn location: watch \(id) paused") }
        if !CLLocationManager.locationServicesEnabled() { sendOff(w) }
    }

    @MainActor private func listen(_ w: Watch) {
        guard !w.running else { return }
        w.running = true
        w.listener.manager.startUpdatingLocation()
    }

    @MainActor private func pause(_ w: Watch) {
        guard w.running else { return }
        w.running = false
        w.listener.manager.stopUpdatingLocation()
    }

    /// iOS has no interval: fixes closer together than the interval are dropped (the first one always goes).
    @MainActor private func onWatchFix(_ w: Watch, _ l: CLLocation) {
        guard watches[w.id] === w, LocationRules.valid(l.coordinate.latitude, l.coordinate.longitude) else { return }
        if let last = w.lastSent, Date().timeIntervalSince(last) * 1000 < w.intervalMs * 0.9 { return }
        w.lastSent = Date()
        w.offSent = false
        emit("watch", ["id": w.id, "position": Self.json(l), "reason": NSNull()])
    }

    /// The permission or the location switch changed while watching.
    @MainActor private func watchSettingsChanged(_ w: Watch) {
        guard watches[w.id] === w else { return }
        if !CLLocationManager.locationServicesEnabled() { return sendOff(w) }
        if !allowed {
            stopWatch(w, "denied")
            w.call.resolve(["reason": "denied"])
            return
        }
        w.offSent = false
    }

    @MainActor private func sendOff(_ w: Watch) {
        guard !w.offSent else { return }
        w.offSent = true
        print("zn location: watch \(w.id) sees location off")
        emit("watch", ["id": w.id, "position": NSNull(), "reason": "off"])
    }

    @MainActor private func stopWatch(_ w: Watch, _ why: String) {
        if watches[w.id] === w { watches.removeValue(forKey: w.id) }
        pause(w)
        print("zn location: watch \(w.id) off (\(why))")
    }

    // MARK: The app's state

    @MainActor private func onFront() {
        inFront = true
        for w in watches.values where !w.running {
            print("zn location: watch \(w.id) resumed")
            listen(w)
        }
    }

    /// A hidden app gets no fix: a one-shot answers now, with the best fix so far, and watches pause until onFront.
    @MainActor private func onBack() {
        inFront = false
        for ask in Array(asks.values) { endAsk(ask, "background") }
        for w in watches.values where w.running {
            print("zn location: watch \(w.id) paused")
            pause(w)
        }
    }

    // MARK: Geocoder

    /// One CLGeocoder per call (it takes one request at a time), cancelled after 10 s.
    private static func geocode(_ call: ZnCall, _ max: Int, _ start: (CLGeocoder, @escaping CLGeocodeCompletionHandler) -> Void) {
        let geocoder = CLGeocoder()
        var done = false
        let timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: false) { _ in
            guard !done else { return }
            done = true
            geocoder.cancelGeocode()
            call.resolve(geocoded(nil, "timeout"))
        }
        call.onCancel { DispatchQueue.main.async { geocoder.cancelGeocode() } }
        start(geocoder) { places, error in
            guard !done else { return }
            done = true
            timer.invalidate()
            if let error = error as? CLError {
                // Not the message: it can hold the query.
                print("zn location: geocoder failed (code \(error.code.rawValue))")
                return call.resolve(geocoded(nil, error.code == .geocodeFoundNoResult ? "none" : "failed"))
            }
            if error != nil { return call.resolve(geocoded(nil, "failed")) }
            call.resolve(geocoded(Array((places ?? []).prefix(max)), nil))
        }
    }

    private static func geocoded(_ places: [CLPlacemark]?, _ reason: String?) -> [String: Any] {
        let list = (places ?? []).map(json)
        let why = reason ?? (list.isEmpty ? "none" : nil)
        return ["addresses": list, "reason": why ?? NSNull()]
    }

    // MARK: Shapes

    private static func answer(_ position: CLLocation?, _ reason: String?, _ lastKnown: CLLocation?) -> [String: Any] {
        ["position": position.map(json) ?? NSNull(), "reason": reason ?? NSNull(), "lastKnown": lastKnown.map(json) ?? NSNull()]
    }

    private static func json(_ l: CLLocation) -> [String: Any] {
        func orNull(_ v: Double, _ ok: Bool) -> Any { ok ? v : NSNull() }
        return [
            "latitude": l.coordinate.latitude,
            "longitude": l.coordinate.longitude,
            "accuracy": orNull(l.horizontalAccuracy, l.horizontalAccuracy >= 0),
            "altitude": orNull(l.altitude, l.verticalAccuracy >= 0),
            "altitudeAccuracy": orNull(l.verticalAccuracy, l.verticalAccuracy >= 0),
            "heading": orNull(l.course, l.course >= 0),
            "speed": orNull(l.speed, l.speed >= 0),
            "timestamp": (l.timestamp.timeIntervalSince1970 * 1000).rounded(),
            "ageMs": max(0, (-l.timestamp.timeIntervalSinceNow * 1000).rounded()),
            "provider": "fused",
            "mocked": l.sourceInformation?.isSimulatedBySoftware ?? false,
        ]
    }

    private static func json(_ p: CLPlacemark) -> [String: Any] {
        func s(_ v: String?) -> Any { v ?? NSNull() }
        let line = p.postalAddress.map {
            CNPostalAddressFormatter.string(from: $0, style: .mailingAddress).replacingOccurrences(of: "\n", with: ", ")
        }
        return [
            "name": s(p.subLocality ?? p.locality ?? p.subAdministrativeArea ?? p.administrativeArea ?? p.name),
            "line": s(line?.isEmpty == false ? line : p.name),
            "area": s(p.subLocality),
            "city": s(p.locality),
            "district": s(p.subAdministrativeArea),
            "state": s(p.administrativeArea),
            "postalCode": s(p.postalCode),
            "country": s(p.country),
            "countryCode": s(p.isoCountryCode),
            "latitude": p.location.map { $0.coordinate.latitude as Any } ?? NSNull(),
            "longitude": p.location.map { $0.coordinate.longitude as Any } ?? NSNull(),
        ]
    }
}
