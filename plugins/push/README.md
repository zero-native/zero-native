# @zero-native/push

Push messages from Firebase Cloud Messaging, on Android. **`Push`**: the FCM token, topics, and every data message, as
a JS task. The task runs when the app is in front, behind, or closed (FCM starts the app). One path for all three, so
nothing "only works while open".

> **`Notifications` moved** to [`@zero-native/notifications`](../notifications/README.md) (2026-11-09), which has no
> Firebase in it. This plugin adds it by itself (`PushPlugin()` registers `NotificationsPlugin()`), and this package
> re-exports it, so `import { Notifications } from "@zero-native/push"` keeps working. New code imports it from
> `@zero-native/notifications`. Messages reach JS through that plugin's `PushEvents`, the path any push service can use.

Each call answers with a value and never rejects. Nothing asks for a permission by itself.

## Add it
1. Firebase as for `@zero-native/crashlytics` (README there): `google-services.json`, `:plugin-firebase-app` in
   `settings.gradle.kts`, and `apply(from = "../../plugins/firebase-app/firebase.gradle.kts")`, which applies the
   google-services Gradle plugin only when the json is there. Without it the app builds, `Push.status()` says `available: false`,
   and `Notifications` still work.
2. In the app's `settings.gradle.kts`: `:plugin-push` and `:plugin-notifications` (push depends on it). In
   `build.gradle.kts`: `implementation(project(":plugin-push"))`.
3. In `Application.onCreate`, with the other plugins: `ZnPlugins.register(this, PushPlugin())`. It adds
   `NotificationsPlugin()` too.
4. The app's Activity needs `ZnActivity.attach(this)` (`docs/guide-notes.md` §31): a message says if the app was in front.
5. A white-on-clear notification icon, in the app's manifest (Android draws the app icon as a white square otherwise):
   ```xml
   <meta-data android:name="dev.zeronative.notifications.small_icon" android:resource="@drawable/ic_notification" />
   <!-- For messages with a `notification` block, which FCM shows itself: -->
   <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_notification" />
   <!-- Optional: the icon's colour -->
   <meta-data android:name="dev.zeronative.notifications.color" android:resource="@color/brand" />
   ```
   The old keys `dev.zeronative.push.small_icon` / `.color` still work (deprecated: see the notifications README).

The plugin's manifest adds only the FCM service (not exported). Firebase adds `INTERNET`, `WAKE_LOCK` and FCM's receive
permission; `POST_NOTIFICATIONS` and the notification receivers come from `@zero-native/notifications`.

## Use it
```ts
// main.ts, at the top level: a message can start the app with no screen, so these must exist before any screen.
import { Notifications } from "@zero-native/notifications"
import { Push } from "@zero-native/push"

Push.onMessage(async (m, signal) => {          // 15 s; signal aborts at the limit
  if (m.data.type !== "offer") return
  await Notifications.createChannel({ id: "offers", name: "Offers", importance: "high" })
  await Notifications.show({
    id: m.data.offerId, channelId: "offers", title: m.data.title, body: m.data.body,
    imageUrl: m.data.image, link: `myapp://offers/${m.data.offerId}`,
    group: { key: "offers", title: "Offers", summaryFormat: "%d stores have offers" },
  })
})
Push.onTokenRefresh(({ token }) => api.saveToken(token))   // also while the app was closed
Notifications.onDismiss(({ id, data }) => track("dismissed", id))

// At start and after login:
const { token, reason } = await Push.getToken()            // null with a reason when there is none now
if (token && token !== saved.get()) await api.saveToken(token)

// On a tap ("Turn on notifications"). Android 13+ shows its dialog; older: already on.
const r = await Push.requestPermission()                   // the same as Notifications.requestPermission()
```

A tap on a notification opens its `link`: the app's own link goes through `onLink` in `startApp` (also on a cold
start), a web link opens the browser, no link opens the app. To count opens, put it in the link (`?from=push`).

## API
| Call | Answers | What it does |
|---|---|---|
| `Push.status()` | `{ available }` | False: no Firebase in this app |
| `Push.getToken()` | `{ token, reason }` | `reason`: `unavailable`, `not_now` (offline or no Play services now), `no_play_services`, `failed` |
| `Push.deleteToken()` | true / false | On logout; the next `getToken` makes a new one |
| `Push.subscribe(topic)` / `unsubscribe(topic)` | true / false | FCM topics: letters, digits, `- _ . ~ %` |
| `Push.onMessage(fn)` | — | Every data message: `{ provider: "fcm", data, inFront, priority, notification, sentAt, from, messageId, deleted? }`. The same task as `PushEvents.onMessage` |
| `Push.onTokenRefresh(fn)` | — | `{ token, provider }` |
| `Push.getInitialNotification()` | `{ messageId, from, sentAt, data }` / null | The FCM notification whose tap started the app, once (native version 2) |
| `Push.onNotificationOpenedApp(fn)` | unsubscribe function | A tap on an FCM notification while the app was behind (native version 2) |
| `Push.setAutoInitEnabled(on)` / `isAutoInitEnabled()` | true / false | FCM's token at the first start, by itself. Kept across starts (native version 2) |
| `Push.requestPermission()` / `hasPermission()` | `granted` / `denied` / `blocked` | Core's `Permissions` for `notifications` (Android 13+ asks; older: granted) |

`Notifications.*` and `PushEvents.*`: the [notifications README](../notifications/README.md#api).

RN Firebase's names for ported code: `messaging().getToken()`, `onTokenRefresh`, `subscribeToTopic`,
`unsubscribeFromTopic`, `deleteToken`, `setBackgroundMessageHandler`, `getInitialNotification`,
`onNotificationOpenedApp`, `setAutoInitEnabled`, `requestPermission` and `hasPermission` (these two answer
`AuthorizationStatus`: 1 granted, 0 not). RN's front-only `onMessage` is our `onMessage` with `m.inFront`.

## Rules worth knowing
- **Data messages** reach JS every time. **Messages with a `notification` block** are shown by Android itself while the
  app is behind (JS doesn't run for them then), and a tap opens the app on its start screen. The message's data comes
  with the tap: `getInitialNotification()` (the app was closed) or `onNotificationOpenedApp` (it was behind). Open a
  `data.link` from there yourself. For pictures and groups, send data-only messages and call `Notifications.show`.
- **"Check for an update now":** a data message `zn_ota=check` (to a topic like `ota-android`) runs core's OTA check at
  once, natively, as at a start (`ZnOta.check`). It never reaches JS. A new bundle installs and applies by the app's
  normal OTA rules. Turn it off with `PushPlugin(otaCheck = false)`.
- `onMessage` has 15 s (FCM gives about 20). Long work goes to the server, or to a later start.
- Never log `m.data` as a whole, and never put private data in it: FCM servers and the phone's notification log keep it.
- Phones with no Google Play services get no FCM. `getToken` says why; local notifications still work.
- Logs use the tag `zn-push` (the message line itself, `fcm message ...`, is `zn-notifications`).
- **Not built yet:** iOS (APNs). The design for other push services and iOS: the notifications README, "Push services".

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-bom` | 35.1.0 | Firebase versions (from `@zero-native/firebase-app`) |
| `com.google.firebase:firebase-messaging` | from the BoM (26.0.x) | FCM |
| `@zero-native/notifications` | this repo | Notifications and `PushEvents` (no Firebase) |

Measured on the sample's R8 release APK (arm64), 2026-11-04, before the split (push and notifications together):
**about 54 KB** on top of `@zero-native/crashlytics`
(classes.dex +50 KB compressed). The two share Firebase's core (firebase-common, installations, transport). An app with
push and no Crashlytics also pays for that core: not measured on its own.
