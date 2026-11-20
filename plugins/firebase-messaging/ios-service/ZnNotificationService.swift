// A notification service extension for the pushes iOS shows itself (an `apns` alert with "mutable-content": 1):
// docs/milestones-ios.md Phase 3. iOS runs it before it shows the push, for about 30 s:
// - title, subtitle and body lose their HTML tags (servers often send Android's HTML; iOS shows text only), the same rule
//   as the notifications plugin's NotificationRules.plain;
// - the push's picture is downloaded and attached: FCM's `fcm_options.image` (the server's `apns.fcmOptions.imageUrl`),
//   else the first data key named in the extension's Info.plist `ZnNotificationImageKeys` (default: `image`).
// - a push with no category gets `zn.default` (the notifications plugin registers it with the dismiss action, so a swipe
//   reaches the app's `onDismiss`), or the Info.plist's `ZnNotificationDefaultCategory` (an empty string: none);
// - with an App Group (Info.plist `ZnAppGroup`, in both the app and the extension), each push is noted in the group's
//   shared storage: the messaging plugin runs `push.message` for it at the app's next start or return to the front, with
//   `shown: true` (iOS showed it), so the app can save it and count it as received and shown.
// If the time runs out, iOS shows what is there by then (the text cleaned, no picture).
//
// The app adds a second target, an app extension (it uses no zero-native runtime and no Firebase), with
// NSExtensionPointIdentifier `com.apple.usernotifications.service`, embedded in the app. Two ways:
// - CMake (ZeroBill: ios/CMakeLists.txt): the extension compiles this file; NSExtensionPrincipalClass
//   `$(PRODUCT_MODULE_NAME).ZnNotificationService`.
// - The Swift package: the extension links the product `ZnNotificationService` and has one file,
//   `import ZnNotificationService` + `final class NotificationService: ZnNotificationService {}`; NSExtensionPrincipalClass
//   `$(PRODUCT_MODULE_NAME).NotificationService` (ios/SamplePackage/NotificationService). Hence `open`.
import Foundation
import UserNotifications

/// The extension's choices with no UserNotifications in them.
enum ZnServiceRules {
    /// Text from HTML: <br> and </p> become new lines, other tags go, the common entities are read. (NotificationRules.plain)
    static func plain(_ html: String) -> String {
        guard html.contains("<") || html.contains("&") else { return html }
        var s = html.replacingOccurrences(of: "(?i)<br\\s*/?>|</p>", with: "\n", options: .regularExpression)
        s = s.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        for (entity, char) in [("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&")] {
            s = s.replacingOccurrences(of: entity, with: char)
        }
        return s.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The picture's URL: FCM's `fcm_options.image`, else the first of [keys] in the push's data. https or http only.
    static func imageURL(_ info: [AnyHashable: Any], keys: [String]) -> URL? {
        let fcm = (info["fcm_options"] as? [String: Any])?["image"] as? String
        let candidates = [fcm] + keys.map { info[$0] as? String }
        for case let s? in candidates {
            let t = s.trimmingCharacters(in: .whitespaces)
            if let url = URL(string: t), url.scheme == "https" || url.scheme == "http" { return url }
        }
        return nil
    }

    /// The notifications plugin's category with the dismiss action (NotificationRules.defaultCategory).
    static let defaultCategory = "zn.default"

    /// Where the extension notes delivered pushes for the app (FirebaseMessagingPlugin reads it). At most [maxDelivered].
    static let deliveredKey = "zn.push.delivered", maxDelivered = 100

    /// The push's own data (all strings), without APNs' and FCM's keys (PushRules.data in the messaging plugin).
    static func data(_ info: [AnyHashable: Any]) -> [String: String] {
        var out: [String: String] = [:]
        for (k, v) in info {
            guard let key = k as? String, let value = v as? String else { continue }
            if key == "aps" || key == "fcm_options" || key == "from" || key == "collapse_key" { continue }
            if key.hasPrefix("gcm.") || key.hasPrefix("google.") { continue }
            out[key] = value
        }
        return out
    }

    /// A delivered push as the messaging plugin reads it back.
    static func delivered(_ info: [AnyHashable: Any], title: String, body: String, at: Int64) -> [String: Any] {
        var e: [String: Any] = ["data": data(info), "title": title, "body": body, "at": at]
        if let id = info["gcm.message_id"] as? String { e["id"] = id }
        if let from = info["from"] as? String { e["from"] = from }
        return e
    }

    /// A file extension iOS can read the attachment by: from the MIME type, else the URL's.
    static func fileExtension(mime: String?, url: URL) -> String? {
        switch mime?.lowercased() {
        case "image/jpeg", "image/jpg": return "jpg"
        case "image/png": return "png"
        case "image/gif": return "gif"
        case "image/heic": return "heic"
        case "image/webp": return "webp"
        default:
            let e = url.pathExtension.lowercased()
            return ["jpg", "jpeg", "png", "gif", "heic", "webp"].contains(e) ? e : nil
        }
    }
}

open class ZnNotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?
    private var download: URLSessionDownloadTask?

    open override func didReceive(_ request: UNNotificationRequest, withContentHandler handler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { return handler(request.content) }
        lock.withLock { self.handler = handler; self.content = content }
        content.title = ZnServiceRules.plain(content.title)
        content.subtitle = ZnServiceRules.plain(content.subtitle)
        content.body = ZnServiceRules.plain(content.body)
        if content.categoryIdentifier.isEmpty {
            content.categoryIdentifier = Bundle.main.object(forInfoDictionaryKey: "ZnNotificationDefaultCategory") as? String
                ?? ZnServiceRules.defaultCategory
        }
        noteDelivered(content)

        let keys = Bundle.main.object(forInfoDictionaryKey: "ZnNotificationImageKeys") as? [String] ?? ["image"]
        guard content.attachments.isEmpty, let url = ZnServiceRules.imageURL(content.userInfo, keys: keys) else { return finish() }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 25
        let task = URLSession(configuration: config).downloadTask(with: url) { [weak self] file, response, error in
            guard let self else { return }
            if let file, error == nil, (response as? HTTPURLResponse).map({ (200..<300).contains($0.statusCode) }) ?? true,
               let ext = ZnServiceRules.fileExtension(mime: response?.mimeType, url: url) {
                let dest = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "." + ext)
                if (try? FileManager.default.moveItem(at: file, to: dest)) != nil,
                   let attachment = try? UNNotificationAttachment(identifier: "image", url: dest) {
                    content.attachments = [attachment]
                }
            }
            self.finish()
        }
        lock.withLock { download = task }
        task.resume()
    }

    open override func serviceExtensionTimeWillExpire() {
        lock.withLock { download }?.cancel()
        finish()
    }

    /// Notes the push in the App Group's storage for the app (nothing without `ZnAppGroup`).
    private func noteDelivered(_ content: UNNotificationContent) {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "ZnAppGroup") as? String,
              let store = UserDefaults(suiteName: group) else { return }
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        var list = store.array(forKey: ZnServiceRules.deliveredKey) as? [[String: Any]] ?? []
        list.append(ZnServiceRules.delivered(content.userInfo, title: content.title, body: content.body, at: at))
        if list.count > ZnServiceRules.maxDelivered { list.removeFirst(list.count - ZnServiceRules.maxDelivered) }
        store.set(list, forKey: ZnServiceRules.deliveredKey)
    }

    /// Hands iOS the content, once.
    private func finish() {
        let (handler, content) = lock.withLock { () -> (((UNNotificationContent) -> Void)?, UNMutableNotificationContent?) in
            defer { self.handler = nil }
            return (self.handler, self.content)
        }
        if let handler, let content { handler(content) }
    }
}
