# Notifications and push on iOS: plan (Phase 3, 2026-11-11)

Pavan's asks (2026-11-11): `@zero-native/notifications` matches notifee on iOS too, with notifee's shape: the shared
options, plus an `android: {...}` and an `ios: {...}` block; `@zero-native/firebase-messaging` on iOS (APNs token →
FCM token, topics, messages). ZeroBill must show its pushes on iOS while the app is behind or closed, as the Flutter app
does today: plan a server change for it (an iOS alert block), reviewed and deployed by Pavan.

## 1. What iOS gets

### 1.1 `@zero-native/notifications` (module `Notifications`, UNUserNotificationCenter)

| Call | iOS |
|---|---|
| `requestPermission` / `hasPermission` | core Permissions ("notifications"), as today. New: `requestPermission({ ios: { provisional, criticalAlert... } })` asks with those options |
| `show(options)` | a local notification now. Title, `ios.subtitle`, body (HTML tags stripped: iOS has no rich text), `data`, `link` / tap, `imageUrl` (or `ios.attachments`) as an attachment (downloaded natively, 4 s), `group.key` → thread id (`ios.threadId` wins), `actions` → a category with those buttons (reply input → text input action), `silent` / `ios.sound`, `ios.badgeCount`, `ios.interruptionLevel`, `ios.relevanceScore`, `ios.foregroundPresentationOptions` (default banner + list + sound + badge), `ios.summaryArgument` |
| `schedule(options, trigger)` | UNCalendar trigger for `at` (one time), and for `repeat` hourly / daily / weekly (matching minute / time / weekday from `at`). `exact` is ignored (iOS is always on time) |
| `cancel` / `cancelAll` | pending and delivered |
| `getDisplayed` / `getScheduled` | delivered / pending requests |
| `getInitialNotification`, `onPress` | a tap on the app's own notification with no `link` |
| `onDismiss` | a swipe away (categories with `customDismissAction`) |
| `onAction` | a button with no `link` (with the typed reply) |
| channels, channel groups, `canScheduleExact`, `isBatteryOptimized` | Android only: answer as notifee does on iOS (true / [] / null / false), never fail |
| `canShow` | null, or "off" when notifications are off |
| `openSettings("notifications")` | the app's settings page; other pages: false |
| New, iOS only (notifee's) | `setBadgeCount`, `getBadgeCount`, `incrementBadgeCount`, `decrementBadgeCount`; `setNotificationCategories` / `getNotificationCategories`. On Android: the launcher badge isn't settable, so they answer false / 0 |

**The TS shape (notifee's):** `show({ id, title, body, data, link, imageUrl, group, actions, android: {...}, ios: {...} })`.
Android's options move into `android` (`channelId`, `bigText`, `largeIconUrl`, `lines`, `progress`, `ongoing`,
`onlyAlertOnce`, `number`, `timestamp`, `showTimestamp`, `visibility`, `category`, `color`, `autoCancel`). The flat
fields keep working (ZeroBill uses them), marked deprecated; the TS turns `android` back into the flat payload Android
reads today, so **Android's Kotlin doesn't change**. `channelId` stops being required at the top (Android still needs
one: from `android.channelId` or the flat field).

### 1.2 `@zero-native/firebase-messaging` (module `FirebaseMessaging`, FirebaseMessaging SDK)

`status`, `getToken` (APNs registration first, then FCM's token), `deleteToken`, `subscribe` / `unsubscribe`,
`setAutoInitEnabled` / `isAutoInitEnabled`, `getInitialNotification` and `onNotificationOpenedApp` (a tap on a
notification iOS showed from a push), `onMessage` (data), `onTokenRefresh`. Needs the app's push entitlement
(`aps-environment`) and `remote-notification` background mode; the APNs key is already in ZeroBill's Firebase project.
`requestPermission` with RN Firebase's `AuthorizationStatus` including PROVISIONAL on iOS.

### 1.3 One tap path

One UNUserNotificationCenter delegate (the notifications plugin's). A tap on a notification the app showed goes to its
`link`, else `onPress`; a tap on one iOS showed from a push goes to the messaging plugin (`opened`, initial). Foreground
presentation: the app's own use `ios.foregroundPresentationOptions`; a push with an alert shows as a banner.

## 2. Pushes while ZeroBill is behind or closed

Today the server sends a data-only message (`notification: {}` and the fields in `data`). Data reaches an iOS app only
while it runs, or through a background wake that iOS throttles and never gives after the user closed the app.

**Plan (Pavan: yes):** the server adds an `apns` block next to what it sends today, so iOS shows the push itself:

```ts
apns: {
  headers: { 'apns-push-type': 'alert', ...(collapseKey ? { 'apns-collapse-id': collapseKey } : {}) },
  payload: { aps: { alert: { title, body }, sound: 'default', 'mutable-content': 1, 'thread-id': groupKey || type } },
  fcmOptions: { imageUrl: large_image_url || undefined },
}
```

Android ignores `apns`, so Android doesn't change. In the iOS app, a **notification service extension** (a small
second target in ZeroBill's Xcode project) runs before iOS shows it: strips the HTML tags from title and body and
attaches `large_image_url`'s picture, as Android shows them. A tap carries the message's `data`, so ZeroBill's tap rules
(`tapFromData`) work the same; ZeroBill listens to `Push.onNotificationOpenedApp` / `Push.getInitialNotification` on iOS.
While the app is in front, the message also reaches `onMessage` with `notification` set: ZeroBill then only records it
(inbox), it doesn't show it again.

The exact server diff (cron-jobs `workers/fcm-notifications-sender.worker.ts`) is written for Pavan to review;
nothing is deployed from here.

## 3. JS with no screen on iOS

Android runs JS tasks (`onMessage`, `onDismiss`, `onAction`) with no screen. iOS starts JS when the window opens, and
`Tasks` is a stub. Phase 3:
- `ZnTasks.run(name, data, timeout)` in Swift, as `ZnBackground.run`: a queue until JS has loaded, a time limit, one
  answer. While JS runs (front, or behind and not yet suspended) tasks run at once.
- Dismiss and button events that come while JS isn't running are kept natively (UserDefaults) and run as tasks at the
  next start, in order. ZeroBill's dismiss tracking doesn't need them sooner.
- Later (not Phase 3): JS at app launch with no window (a background launch), for silent pushes. With §2, ZeroBill
  doesn't need it.

## 4. Order

1. TS: the notifee shape, iOS-only calls, tests (no Kotlin change).
2. iOS: `ZnTasks` for real; the notifications plugin (Swift).
3. iOS: the messaging plugin; FirebaseMessaging in `fetch-firebase-apple.ts`.
4. ZeroBill: register both, entitlement and background mode, the notification service extension, the iOS tap path.
   Check on the simulator (local notifications; `xcrun simctl push` for push payloads).
5. The server diff for Pavan; a real push on Pavan's iPhone (needs a signed build: ask first).
