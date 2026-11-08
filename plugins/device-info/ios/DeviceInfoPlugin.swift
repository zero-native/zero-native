// The device-info plugin's iOS side (plugins/device-info, as android/.../DeviceInfoPlugin.kt): react-native-device-info's
// iOS answers. Values fixed while the app runs are constants (JS reads them synchronously); values that change are calls.
// Android-only values (androidId, apiLevel, bootloader, serial, install referrer, Play services, ...) are left out of the
// constants or answer false / [], so JS gives react-native-device-info's "don't know" ("unknown", -1, false, []).
//
// iOS differences, as in react-native-device-info:
// - getUniqueId is identifierForVendor: the same for this vendor's apps on the phone, new after all of them are removed.
// - getModel is the marketing name ("iPhone 16") for the phones in the table below, else the device id ("iPhone17,3").
// - getDeviceName: since iOS 16 the system gives a generic name ("iPhone") without Apple's entitlement.
// - getCarrier: iOS 16 no longer tells apps the carrier ("unknown"). isAirplaneMode: iOS doesn't say (false).
// - getUserAgent: WKWebView's default user agent, built from the iOS version (no web view is created).
import AVFoundation
import CoreLocation
import LocalAuthentication
import UIKit

struct DeviceInfoPlugin: ZnPlugin {
    func register(_ r: ZnPluginRegistry) {
        r.module(DeviceInfoModule())
    }
}

final class DeviceInfoModule: ZnModuleBase, @unchecked Sendable {
    /// Read once, on the main thread, when the plugin is added (before JS starts).
    private let fixed: [String: Any]

    @MainActor init() {
        fixed = Self.readConstants()
        super.init("DeviceInfo", version: 1)
        dynamic("batteryLevel", onMain: true) { Self.battery().level }
        dynamic("powerState", onMain: true) {
            let b = Self.battery()
            return ["batteryLevel": b.level, "batteryState": b.state, "lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled]
        }
        dynamic("isBatteryCharging", onMain: true) { Self.battery().state == "charging" }
        dynamic("freeDiskStorage") { try Self.fileSystem(.systemFreeSize) }
        dynamic("totalDiskCapacity") { try Self.fileSystem(.systemSize) }
        dynamic("usedMemory") { Self.residentBytes() }
        dynamic("isAirplaneMode") { false }
        dynamic("isLocationEnabled") { CLLocationManager.locationServicesEnabled() }
        dynamic("isHeadphonesConnected") {
            let kinds: Set<AVAudioSession.Port> = [.headphones, .bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .usbAudio]
            return AVAudioSession.sharedInstance().currentRoute.outputs.contains { kinds.contains($0.portType) }
        }
        dynamic("isPinOrFingerprintSet") { LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) }
        dynamic("fontScale", onMain: true) { Double(UIFontMetrics(forTextStyle: .body).scaledValue(for: 100) / 100) }
        dynamic("isLandscape", onMain: true) {
            let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            return scene?.interfaceOrientation.isLandscape ?? false
        }
        dynamic("carrier") { "unknown" }
        dynamic("ipAddress") { Self.ipv4() ?? "0.0.0.0" }
        dynamic("isCameraPresent") { AVCaptureDevice.default(for: .video) != nil }
        dynamic("systemAvailableFeatures") { [String]() }
        dynamic("hasGms") { false }
        dynamic("hasHms") { false }
        dynamic("userAgent") { Self.userAgent() }
        dynamic("brightness", onMain: true) { Double(UIScreen.main.brightness) }
        function("hasSystemFeature") { call in call.resolve(false) }
    }

    override func constants() -> [String: Any]? { fixed }

    /// A call with no arguments that answers [read]'s value; a failure answers null (JS: react-native-device-info's
    /// "don't know").
    private func dynamic(_ name: String, onMain: Bool = false, _ read: @escaping () throws -> Any) {
        function(name, onMain: onMain) { call in
            do { call.resolve(try read()) } catch {
                print("zn-device-info: \(name) failed: \(error)")
                call.resolve(nil)
            }
        }
    }

    // MARK: Fixed values

    @MainActor private static func readConstants() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "unknown"
        let build = info["CFBundleVersion"] as? String ?? "unknown"
        let device = UIDevice.current
        let id = machine()
        let type: String
        switch device.userInterfaceIdiom {
        case .phone: type = "Handset"
        case .pad: type = "Tablet"
        case .tv: type = "Tv"
        case .mac: type = "Desktop"
        default: type = "unknown"
        }
        var c: [String: Any] = [
            "bundleId": Bundle.main.bundleIdentifier ?? "unknown",
            "applicationName": info["CFBundleDisplayName"] as? String ?? info["CFBundleName"] as? String ?? "unknown",
            "version": version,
            "buildNumber": build,
            "readableVersion": "\(version).\(build)",
            "installerPackageName": installer(),
            "uniqueId": device.identifierForVendor?.uuidString ?? "unknown",
            "deviceId": id,
            "model": marketingNames[id] ?? id,
            "brand": "Apple",
            "manufacturer": "Apple",
            "systemName": device.systemName,
            "systemVersion": device.systemVersion,
            "deviceType": type,
            "isTablet": type == "Tablet",
            "hasNotch": notch(id),
            "hasDynamicIsland": dynamicIsland(id),
            "isDisplayZoomed": UIScreen.main.scale != UIScreen.main.nativeScale,
            "isEmulator": isSimulator,
            "supportedAbis": [arch()],
            "totalMemory": Double(ProcessInfo.processInfo.physicalMemory),
            "isLowRamDevice": false,
            "deviceName": device.name,
        ]
        // react-native-device-info on iOS: when the app's Documents folder was made.
        if let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
           let made = (try? FileManager.default.attributesOfItem(atPath: docs.path))?[.creationDate] as? Date {
            c["firstInstallTime"] = (made.timeIntervalSince1970 * 1000).rounded()
        }
        return c
    }

    private static var isSimulator: Bool {
        #if targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    /// "iPhone17,3"; on the simulator, the phone it plays.
    private static func machine() -> String {
        if isSimulator, let id = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] { return id }
        var u = utsname()
        uname(&u)
        return withUnsafeBytes(of: &u.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    private static func arch() -> String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    /// react-native-device-info's values: "TestFlight", "AppStore", or "SimulatorOrDevelopment"-like for the rest.
    private static func installer() -> String {
        if isSimulator { return "Simulator" }
        #if DEBUG
        return "Other"
        #else
        return Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt" ? "TestFlight" : "AppStore"
        #endif
    }

    /// "iPhone<major>,<minor>" → (major, minor), or nil for anything else.
    private static func iphone(_ id: String) -> (Int, Int)? {
        guard id.hasPrefix("iPhone") else { return nil }
        let parts = id.dropFirst(6).split(separator: ",").compactMap { Int($0) }
        return parts.count == 2 ? (parts[0], parts[1]) : nil
    }

    /// Phones with a Dynamic Island: 14 Pro and later, except the 14 / 14 Plus (notch) and the 16e (notch).
    private static func dynamicIsland(_ id: String) -> Bool {
        guard let (major, minor) = iphone(id) else { return false }
        if major == 15 { return [2, 3, 4, 5].contains(minor) }
        if major == 17 { return minor != 5 }
        return major >= 16
    }

    /// Phones with a notch: X to 14 Plus and the 16e. Not the SEs, the 8s or Dynamic Island phones.
    private static func notch(_ id: String) -> Bool {
        guard let (major, minor) = iphone(id) else { return false }
        switch major {
        case 10: return [3, 6].contains(minor)
        case 11, 12, 13: return !(major == 12 && minor == 8)
        case 14: return minor != 6
        case 17: return minor == 5
        default: return false
        }
    }

    private static let marketingNames: [String: String] = [
        "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE",
        "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
        "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
        "iPhone14,6": "iPhone SE", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
        "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
        "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
        "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
        "iPhone17,5": "iPhone 16e",
        "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air",
    ]

    // MARK: Changing values

    @MainActor private static func battery() -> (level: Double, state: String) {
        let d = UIDevice.current
        d.isBatteryMonitoringEnabled = true
        let state: String
        switch d.batteryState {
        case .unplugged: state = "unplugged"
        case .charging: state = "charging"
        case .full: state = "full"
        default: state = "unknown"
        }
        return (Double(d.batteryLevel), state)  // -1 when unknown (the simulator)
    }

    private static func fileSystem(_ key: FileAttributeKey) throws -> Double {
        let a = try FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())
        return (a[key] as? NSNumber)?.doubleValue ?? -1
    }

    /// The app's resident memory in bytes (react-native-device-info's getUsedMemory on iOS).
    private static func residentBytes() -> Double {
        var info = mach_task_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
        let ok = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
            }
        }
        return ok == KERN_SUCCESS ? Double(info.resident_size) : -1
    }

    /// Wi-Fi's IPv4 address (en0), else the first other IPv4 one that is up and not loopback.
    private static func ipv4() -> String? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(head) }
        var found: [String: String] = [:]
        for p in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let a = p.pointee
            guard let addr = a.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET),
                  a.ifa_flags & UInt32(IFF_UP) != 0, a.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
            found[String(cString: a.ifa_name)] = String(cString: host)
        }
        return found["en0"] ?? found.values.sorted().first
    }

    /// WKWebView's default user agent, as navigator.userAgent gives it.
    private static func userAgent() -> String {
        let os = UIDevice.current.systemVersion.replacingOccurrences(of: ".", with: "_")
        let pad = UIDevice.current.userInterfaceIdiom == .pad
        let platform = pad ? "iPad; CPU OS \(os)" : "iPhone; CPU iPhone OS \(os)"
        return "Mozilla/5.0 (\(platform) like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"
    }
}
