// The notifications plugin's iOS side (plugins/notifications; Android: NotificationsModule.kt and the files next to it).
// Notifications the app shows itself, with UNUserNotificationCenter: `show`, `schedule`, buttons (with a typed reply),
// groups (thread ids), pictures (attachments), taps, swipes, the badge and categories. docs/ios-notifications-plan.md.
//
// One delegate for every notification (ZnNotificationCenter): a tap on the app's own goes to its `link` or `onPress`; a
// swipe runs `onDismiss`; a button runs `onAction` (or opens its `link`). A push's own notification (one iOS showed from
// an APNs message) goes to `ZnNotificationCenter.remote`, which the messaging plugin sets (plugins/firebase-messaging).
//
// Android-only calls (channels, exact alarms, battery) answer as notifee does on iOS and never fail. iOS shows text
// only: HTML tags in titles and bodies are taken out (`<br>` becomes a new line).
import Foundation
import UIKit
import UserNotifications
#if SWIFT_PACKAGE
import ZnRuntime
#endif

public struct NotificationsPlugin: ZnPlugin {
    public init() {}

    @MainActor private static var registered = false

    public func register(_ r: ZnPluginRegistry) {
        // Once: the messaging plugin adds it too (as on Android), for apps that list only that one
        guard !Self.registered else { return }
        Self.registered = true
        r.module(NotificationsModule.shared)
        ZnNotificationCenter.shared.install()
    }
}

/// Choices with no UIKit in them (as NotificationRules.kt), kept apart so they read and test simply.
enum NotificationRules {
    /// Core task names (packages notifications src/index.ts).
    static let dismissTask = "push.dismissed", actionTask = "push.action"
    /// The keys the app's own notifications carry in userInfo.
    static let keyId = "zn.id", keyData = "zn.data", keyLink = "zn.link", keyActions = "zn.actions", keyFront = "zn.front",
        keyRepeat = "zn.repeat", keyAt = "zn.at"
    static let defaultCategory = "zn.default"
    static let maxActions = 4
    static let attachmentTimeout: TimeInterval = 4

    /// Text with HTML tags taken out: `<br>` and `</p>` become new lines, entities are decoded. Text with no tag stays
    /// exactly as given.
    static func plain(_ html: String) -> String {
        guard html.contains("<") || html.contains("&") else { return html }
        var s = html.replacingOccurrences(of: "(?i)<br\\s*/?>|</p>", with: "\n", options: .regularExpression)
        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (entity, char) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
            s = s.replacingOccurrences(of: entity, with: char)
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Android's group summary format ("%d new offers") as iOS's ("%u new offers").
    static func summaryFormat(_ f: String) -> String {
        f.replacingOccurrences(of: "%d", with: "%u").replacingOccurrences(of: "%s", with: "%@")
    }

    /// A category id for a set of buttons and a summary: the same spec gives the same id, at every start.
    static func categoryId(_ actions: [[String: Any]], _ summary: String?) -> String {
        var key = summary ?? ""
        for a in actions {
            key += "|\(a["id"] as? String ?? "")~\(a["title"] as? String ?? "")~\(a["input"] != nil)"
            if let ios = a["ios"] as? [String: Any] { key += "~\(ios["foreground"] as? Bool ?? false)\(ios["destructive"] as? Bool ?? false)\(ios["authenticationRequired"] as? Bool ?? false)" }
        }
        var h: UInt64 = 0xcbf29ce484222325  // FNV-1a
        for b in key.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return "zn.c." + String(h, radix: 16)
    }

    /// When a scheduled notification repeats: the calendar parts of [at] that must match.
    static func repeatParts(_ every: String?) -> Set<Calendar.Component>? {
        switch every {
        case nil: return [.year, .month, .day, .hour, .minute, .second]
        case "hourly": return [.minute, .second]
        case "daily": return [.hour, .minute, .second]
        case "weekly": return [.weekday, .hour, .minute, .second]
        default: return nil
        }
    }

    /// Strings only (a notification's `data`).
    static func strings(_ v: Any?) -> [String: String] {
        guard let d = v as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (k, v) in d { if let s = v as? String { out[k] = s } }
        return out
    }
}

/// The one UNUserNotificationCenter delegate (docs/ios-notifications-plan.md §1.3).
public final class ZnNotificationCenter: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    public static let shared = ZnNotificationCenter()

    /// A push's own notifications (not shown by this plugin): the messaging plugin's.
    public protocol Remote: AnyObject {
        /// What iOS shows while the app is in front. Called on the main thread.
        func willPresent(_ notification: UNNotification) -> UNNotificationPresentationOptions
        /// A tap (or a button) on one.
        func didReceive(_ response: UNNotificationResponse)
    }
    public weak var remote: Remote?

    private let lock = NSLock()
    /// A tap on the app's own notification (no link) that came before JS had loaded: `getInitialNotification`, once.
    private var initial: [String: Any]?
    private var installed = false

    func install() {
        guard !installed else { return }
        installed = true
        UNUserNotificationCenter.current().delegate = self
        NotificationsModule.shared.registerCategories()
    }

    func takeInitial() -> [String: Any]? { lock.withLock { defer { initial = nil }; return initial } }

    public static func isOwn(_ n: UNNotification) -> Bool { n.request.content.userInfo[NotificationRules.keyId] is String }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        guard Self.isOwn(notification) else {
            DispatchQueue.main.async { done(self.remote?.willPresent(notification) ?? []) }
            return
        }
        let front = notification.request.content.userInfo[NotificationRules.keyFront] as? [String: Bool] ?? [:]
        var o: UNNotificationPresentationOptions = []
        if front["banner"] ?? true { o.insert(.banner) }
        if front["list"] ?? true { o.insert(.list) }
        if front["sound"] ?? true { o.insert(.sound) }
        if front["badge"] ?? true { o.insert(.badge) }
        done(o)
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let n = response.notification
        guard Self.isOwn(n) else {
            DispatchQueue.main.async {
                self.remote?.didReceive(response)
                done()
            }
            return
        }
        let info = n.request.content.userInfo
        let id = info[NotificationRules.keyId] as? String ?? n.request.identifier
        let data = NotificationRules.strings(info[NotificationRules.keyData])
        DispatchQueue.main.async {
            switch response.actionIdentifier {
            case UNNotificationDefaultActionIdentifier:
                if let link = (info[NotificationRules.keyLink] as? String).flatMap(URL.init(string:)) {
                    ZnApp.shared.openLink(link)
                } else if ZnTasks.shared.isLoaded {
                    NotificationsModule.shared.emit("pressed", ["id": id, "data": data])
                } else {
                    self.lock.withLock { self.initial = ["id": id, "data": data] }
                }
            case UNNotificationDismissActionIdentifier:
                ZnTasks.shared.run(NotificationRules.dismissTask, ["id": id, "data": data], timeoutMs: 8_000, keep: true)
            default:
                let actions = info[NotificationRules.keyActions] as? [[String: String]] ?? []
                let action = actions.first { $0["id"] == response.actionIdentifier }
                if let link = action?["link"].flatMap(URL.init(string:)) {
                    ZnApp.shared.openLink(link)
                } else {
                    var event: [String: Any] = ["id": id, "actionId": response.actionIdentifier, "data": data]
                    if let text = (response as? UNTextInputNotificationResponse)?.userText { event["input"] = text }
                    ZnTasks.shared.run(NotificationRules.actionTask, event, timeoutMs: 8_000, keep: true)
                }
            }
            done()
        }
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, openSettingsFor notification: UNNotification?) {
        // providesAppNotificationSettings: the app opens; the app shows its own settings when it wants (no event yet)
    }
}

final class NotificationsModule: ZnModuleBase, @unchecked Sendable {
    static let shared = NotificationsModule()
    private let center = UNUserNotificationCenter.current()
    private let lock = NSLock()
    private static let appCategoriesKey = "zn.notifications.categories"
    private static let autoCategoriesKey = "zn.notifications.autoCategories"

    private init() {
        super.init("Notifications", version: 3)
        // Android only: answered as notifee does on iOS
        for m in ["createChannel", "deleteChannel", "createChannelGroup", "deleteChannelGroup", "canScheduleExact"] {
            function(m) { $0.resolve(true) }
        }
        function("getChannels") { $0.resolve([Any]()) }
        function("getChannel") { $0.resolve(nil) }
        function("isBatteryOptimized") { $0.resolve(false) }

        function("canShow") { call in
            self.center.getNotificationSettings { s in call.resolve(["reason": Self.allowed(s) ? NSNull() : "off" as Any]) }
        }
        function("show") { call in
            let args = call.args
            self.center.getNotificationSettings { s in
                guard Self.allowed(s) else { return call.resolve(["shown": false, "reason": "off"]) }
                self.request(args, trigger: nil) { ok in call.resolve(["shown": ok, "reason": ok ? NSNull() : "off" as Any]) }
            }
        }
        function("schedule") { call in
            guard let n = call.args["notification"] as? [String: Any], (n["id"] as? String)?.isEmpty == false else {
                return call.resolve(["scheduled": false, "reason": "no_id"])
            }
            let every = call.args["repeat"] as? String
            guard let parts = NotificationRules.repeatParts(every) else { return call.resolve(["scheduled": false, "reason": "bad_repeat"]) }
            let atMs = try call.double("at")
            let at = Date(timeIntervalSince1970: atMs / 1000)
            if every == nil && at <= Date() { return call.resolve(["scheduled": false, "reason": "past"]) }
            let comps = Calendar.current.dateComponents(parts, from: at)
            let trigger = UNCalendarNotificationTrigger(dateMatching: comps, repeats: every != nil)
            var extra: [String: Any] = [NotificationRules.keyAt: atMs]
            if let every { extra[NotificationRules.keyRepeat] = every }
            self.request(n, trigger: trigger, extra: extra) { ok in call.resolve(["scheduled": ok, "reason": NSNull()]) }
        }
        function("getScheduled") { call in
            self.center.getPendingNotificationRequests { reqs in
                let list: [[String: Any]] = reqs.compactMap { r in
                    guard r.content.userInfo[NotificationRules.keyId] is String else { return nil }
                    let next = (r.trigger as? UNCalendarNotificationTrigger)?.nextTriggerDate()
                    let at = next.map { $0.timeIntervalSince1970 * 1000 } ?? (r.content.userInfo[NotificationRules.keyAt] as? Double ?? 0)
                    return ["id": r.identifier, "at": at.rounded(), "repeat": r.content.userInfo[NotificationRules.keyRepeat] ?? NSNull()]
                }
                call.resolve(list.sorted { ($0["at"] as? Double ?? 0) < ($1["at"] as? Double ?? 0) })
            }
        }
        function("cancel") { call in
            let id = try call.string("id")
            self.center.removePendingNotificationRequests(withIdentifiers: [id])
            self.center.removeDeliveredNotifications(withIdentifiers: [id])
            call.resolve(true)
        }
        function("cancelAll") { call in
            self.center.removeAllPendingNotificationRequests()
            self.center.removeAllDeliveredNotifications()
            call.resolve(true)
        }
        function("getDisplayed") { call in
            self.center.getDeliveredNotifications { list in
                let out: [[String: Any]] = list.sorted { $0.date > $1.date }.map { n in
                    let c = n.request.content
                    let data = c.userInfo[NotificationRules.keyData] != nil ? NotificationRules.strings(c.userInfo[NotificationRules.keyData])
                        : NotificationRules.strings(c.userInfo as? [String: Any])
                    return ["id": c.userInfo[NotificationRules.keyId] as? String ?? n.request.identifier,
                            "title": c.title.isEmpty ? NSNull() : c.title as Any, "body": c.body.isEmpty ? NSNull() : c.body as Any,
                            "channelId": NSNull(), "group": c.threadIdentifier.isEmpty ? NSNull() : c.threadIdentifier as Any,
                            "shownAt": (n.date.timeIntervalSince1970 * 1000).rounded(), "data": data]
                }
                call.resolve(out)
            }
        }
        function("openSettings", onMain: true) { call in
            guard try call.string("page") == "notifications", let url = URL(string: UIApplication.openNotificationSettingsURLString) else {
                return call.resolve(false)
            }
            UIApplication.shared.open(url) { call.resolve($0) }
        }
        function("getInitialNotification") { call in call.resolve(ZnNotificationCenter.shared.takeInitial()) }

        // iOS only
        function("requestPermission") { call in
            let o = call.args["ios"] as? [String: Any] ?? [:]
            var opts: UNAuthorizationOptions = []
            if o["alert"] as? Bool ?? true { opts.insert(.alert) }
            if o["badge"] as? Bool ?? true { opts.insert(.badge) }
            if o["sound"] as? Bool ?? true { opts.insert(.sound) }
            if o["provisional"] as? Bool == true { opts.insert(.provisional) }
            if o["criticalAlert"] as? Bool == true { opts.insert(.criticalAlert) }
            if o["carPlay"] as? Bool == true { opts.insert(.carPlay) }
            if o["providesAppNotificationSettings"] as? Bool == true { opts.insert(.providesAppNotificationSettings) }
            self.center.requestAuthorization(options: opts) { _, _ in
                self.center.getNotificationSettings { s in
                    call.resolve(Self.allowed(s) ? "granted" : s.authorizationStatus == .notDetermined ? "denied" : "blocked")
                }
            }
        }
        function("getNotificationSettings") { call in
            self.center.getNotificationSettings { s in
                let status: String = switch s.authorizationStatus {
                case .authorized: "authorized"
                case .denied: "denied"
                case .provisional: "provisional"
                case .ephemeral: "ephemeral"
                default: "notDetermined"
                }
                let on = { (x: UNNotificationSetting) in x == .enabled }
                call.resolve(["authorizationStatus": status, "ios": [
                    "alert": on(s.alertSetting), "badge": on(s.badgeSetting), "sound": on(s.soundSetting),
                    "lockScreen": on(s.lockScreenSetting), "notificationCenter": on(s.notificationCenterSetting),
                    "criticalAlert": on(s.criticalAlertSetting), "carPlay": on(s.carPlaySetting),
                ]])
            }
        }
        function("setBadgeCount") { call in
            self.center.setBadgeCount(max(0, try call.int("count"))) { call.resolve($0 == nil) }
        }
        function("getBadgeCount", onMain: true) { call in call.resolve(UIApplication.shared.applicationIconBadgeNumber) }
        function("setNotificationCategories") { call in
            let list = (call.args["categories"] as? [[String: Any]] ?? []).filter { ($0["id"] as? String)?.isEmpty == false }
            UserDefaults.standard.set(list, forKey: Self.appCategoriesKey)
            self.registerCategories()
            call.resolve(true)
        }
        function("getNotificationCategories") { call in
            call.resolve(UserDefaults.standard.array(forKey: Self.appCategoriesKey) ?? [])
        }
    }

    private static func allowed(_ s: UNNotificationSettings) -> Bool {
        [.authorized, .provisional, .ephemeral].contains(s.authorizationStatus)
    }

    // MARK: Categories (the app's, the ones made for `actions` and group summaries, and the default one)

    /// Registers every category: iOS keeps only the last set given, so it is always the whole set. Any thread.
    func registerCategories() {
        lock.withLock {
            var cats: [UNNotificationCategory] = [UNNotificationCategory(identifier: NotificationRules.defaultCategory, actions: [],
                                                                           intentIdentifiers: [], options: [.customDismissAction])]
            let app = UserDefaults.standard.array(forKey: Self.appCategoriesKey) as? [[String: Any]] ?? []
            let auto = UserDefaults.standard.dictionary(forKey: Self.autoCategoriesKey) as? [String: [String: Any]] ?? [:]
            for spec in app + Array(auto.values) { if let c = Self.category(spec) { cats.append(c) } }
            center.setNotificationCategories(Set(cats))
        }
    }

    private static func category(_ spec: [String: Any]) -> UNNotificationCategory? {
        guard let id = spec["id"] as? String, !id.isEmpty else { return nil }
        let actions = (spec["actions"] as? [[String: Any]] ?? []).prefix(NotificationRules.maxActions).compactMap(action)
        var options: UNNotificationCategoryOptions = []
        if spec["customDismissAction"] as? Bool ?? true { options.insert(.customDismissAction) }
        let summary = (spec["summaryFormat"] as? String).map(NotificationRules.summaryFormat)
        return UNNotificationCategory(identifier: id, actions: Array(actions), intentIdentifiers: [],
                                      hiddenPreviewsBodyPlaceholder: spec["hiddenPreviewsBodyPlaceholder"] as? String,
                                      categorySummaryFormat: summary, options: options)
    }

    private static func action(_ a: [String: Any]) -> UNNotificationAction? {
        guard let id = a["id"] as? String, let title = a["title"] as? String else { return nil }
        let ios = a["ios"] as? [String: Any] ?? [:]
        var o: UNNotificationActionOptions = []
        // A button with a link opens the app; so does one marked foreground
        if a["link"] != nil || ios["foreground"] as? Bool == true { o.insert(.foreground) }
        if ios["destructive"] as? Bool == true { o.insert(.destructive) }
        if ios["authenticationRequired"] as? Bool == true { o.insert(.authenticationRequired) }
        if let input = a["input"] as? [String: Any] {
            return UNTextInputNotificationAction(identifier: id, title: title, options: o,
                                                 textInputButtonTitle: input["buttonTitle"] as? String ?? "Send",
                                                 textInputPlaceholder: input["placeholder"] as? String ?? "")
        }
        return UNNotificationAction(identifier: id, title: title, options: o)
    }

    /// The category a notification uses: `ios.categoryId`, else one made (and kept) for its buttons and group summary.
    private func categoryFor(_ args: [String: Any]) -> String {
        if let id = (args["ios"] as? [String: Any])?["categoryId"] as? String, !id.isEmpty { return id }
        let actions = args["actions"] as? [[String: Any]] ?? []
        let summary = (args["group"] as? [String: Any])?["summaryFormat"] as? String
        guard !actions.isEmpty || summary != nil else { return NotificationRules.defaultCategory }
        let id = NotificationRules.categoryId(actions, summary)
        var auto = UserDefaults.standard.dictionary(forKey: Self.autoCategoriesKey) as? [String: [String: Any]] ?? [:]
        if auto[id] == nil {
            var spec: [String: Any] = ["id": id, "actions": actions]
            if let summary { spec["summaryFormat"] = summary }
            auto[id] = spec
            if auto.count > 40 { auto.removeValue(forKey: auto.keys.sorted().first!) }  // a bound; real apps use a few
            UserDefaults.standard.set(auto, forKey: Self.autoCategoriesKey)
            registerCategories()
        }
        return id
    }

    // MARK: Showing

    /// Builds the content (pictures downloaded first, 4 s at most each) and adds the request. [done] on any thread.
    private func request(_ args: [String: Any], trigger: UNNotificationTrigger?, extra: [String: Any] = [:], done: @escaping (Bool) -> Void) {
        guard let id = args["id"] as? String, !id.isEmpty else { return done(false) }
        let ios = args["ios"] as? [String: Any] ?? [:]
        let c = UNMutableNotificationContent()
        c.title = NotificationRules.plain(args["title"] as? String ?? "")
        if let body = args["body"] as? String { c.body = NotificationRules.plain(body) }
        if let sub = ios["subtitle"] as? String { c.subtitle = NotificationRules.plain(sub) }
        let silent = args["silent"] as? Bool == true || (ios["sound"] as? Bool) == false
        if !silent {
            let name = ios["sound"] as? String ?? "default"
            c.sound = name == "default" ? .default : UNNotificationSound(named: UNNotificationSoundName(name))
        }
        if let thread = ios["threadId"] as? String ?? (args["group"] as? [String: Any])?["key"] as? String { c.threadIdentifier = thread }
        if let badge = ios["badgeCount"] as? Int { c.badge = NSNumber(value: badge) }
        if let level = ios["interruptionLevel"] as? String {
            c.interruptionLevel = switch level {
            case "passive": .passive
            case "timeSensitive": .timeSensitive
            case "critical": .critical
            default: .active
            }
        }
        if let score = ios["relevanceScore"] as? Double { c.relevanceScore = min(1, max(0, score)) }
        if let arg = ios["summaryArgument"] as? String { c.summaryArgument = arg }
        if let n = ios["summaryArgumentCount"] as? Int { c.summaryArgumentCount = n }
        c.categoryIdentifier = categoryFor(args)

        var info: [String: Any] = [NotificationRules.keyId: id, NotificationRules.keyData: NotificationRules.strings(args["data"])]
        if let link = args["link"] as? String, !link.isEmpty { info[NotificationRules.keyLink] = link }
        let actions = (args["actions"] as? [[String: Any]] ?? []).compactMap { a -> [String: String]? in
            guard let aid = a["id"] as? String else { return nil }
            var out = ["id": aid]
            if let link = a["link"] as? String { out["link"] = link }
            return out
        }
        if !actions.isEmpty { info[NotificationRules.keyActions] = actions }
        if let front = ios["foregroundPresentationOptions"] as? [String: Any] {
            info[NotificationRules.keyFront] = front.compactMapValues { $0 as? Bool }
        }
        for (k, v) in extra { info[k] = v }
        c.userInfo = info

        var sources: [(String, String?, Bool)] = []  // url, id, thumbnail hidden
        if let url = args["imageUrl"] as? String { sources.append((url, "image", false)) }
        for a in ios["attachments"] as? [[String: Any]] ?? [] {
            if let url = a["url"] as? String { sources.append((url, a["id"] as? String, a["thumbnailHidden"] as? Bool ?? false)) }
        }
        Task.detached {
            for (url, aid, hidden) in sources {
                if let a = await Self.attachment(url, id: aid ?? UUID().uuidString, thumbnailHidden: hidden) { c.attachments.append(a) }
            }
            do {
                try await self.center.add(UNNotificationRequest(identifier: id, content: c, trigger: trigger))
                done(true)
            } catch {
                print("zn: notification \(id) not shown: \(error.localizedDescription)")
                done(false)
            }
        }
    }

    #if DEBUG
    private static let debugBuild = true
    #else
    private static let debugBuild = false
    #endif

    /// A picture as an attachment: https (http in debug builds), `asset:<path>` in the bundle, `zn://file/<name>`. Copied
    /// to a temporary file (iOS moves it), with the extension iOS needs to know its type. Nil if it isn't there in time.
    private static func attachment(_ source: String, id: String, thumbnailHidden: Bool) async -> UNNotificationAttachment? {
        let options: [String: Any] = thumbnailHidden ? [UNNotificationAttachmentOptionsThumbnailHiddenKey: true] : [:]
        var local: URL?
        var ext = (URL(string: source)?.pathExtension).flatMap { $0.isEmpty ? nil : $0 } ?? "jpg"
        if source.hasPrefix("asset:") {
            local = await MainActor.run { ZnApp.shared.bundleURL }?.appendingPathComponent(String(source.dropFirst(6)))
        } else if source.hasPrefix("zn://file/") {
            local = ZnHandles.fileOf(source)
        } else if let url = URL(string: source), url.scheme == "https" || (debugBuild && url.scheme == "http") {
            var req = URLRequest(url: url, timeoutInterval: NotificationRules.attachmentTimeout)
            req.cachePolicy = .returnCacheDataElseLoad
            guard let (file, response) = try? await URLSession.shared.download(for: req),
                  (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? false else { return nil }
            if let mime = response.mimeType {
                ext = mime.contains("png") ? "png" : mime.contains("gif") ? "gif" : mime.contains("webp") ? "webp" : mime.contains("jpeg") ? "jpg" : ext
            }
            local = file
        }
        guard let local, FileManager.default.fileExists(atPath: local.path) else { return nil }
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("zn-att-\(UUID().uuidString).\(ext)")
        do {
            try FileManager.default.copyItem(at: local, to: copy)
            return try UNNotificationAttachment(identifier: id, url: copy, options: options)
        } catch {
            return nil
        }
    }
}
