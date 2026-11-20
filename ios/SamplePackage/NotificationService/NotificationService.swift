// The sample's notification service extension, from the Swift package: zero-native's ZnNotificationService does the
// work (HTML out of the text, the picture attached, the default category; plugins/firebase-messaging/ios-service).
// An app's own extension is this one file, its Info.plist and the `ZnNotificationService` product.
import ZnNotificationService

final class NotificationService: ZnNotificationService {}
