# @zero-native/push

Push messages (Firebase Cloud Messaging) and notifications the app shows itself, on Android. Two parts:

- **`Push`**: the FCM token, topics, and every data message, as a JS task. The task runs when the app is in front,
  behind, or closed (FCM starts the app). One path for all three, so nothing "only works while open".
- **`Notifications`**: a small notifee-like API: channels, `show` with big text, a big picture and a large icon,
  groups with a summary, cancel, and a check before showing. A tap opens the notification's `link` through the app's
  normal link path. A swipe away runs a task. It works with no FCM at all.

Each call answers with a value and never rejects. Nothing asks for a permission by itself.

## Add it
1. Firebase as for `@zero-native/crashlytics` (README there): `google-services.json`, `:plugin-firebase-app` in
   `settings.gradle.kts`, and `apply(from = "../../plugins/firebase-app/firebase.gradle.kts")`, which applies the
   google-services Gradle plugin only when the json is there. Without it the app builds, `Push.status()` says `available: false`,
   and `Notifications` still work.
2. In the app's `build.gradle.kts`: `implementation(project(":plugin-push"))`.
3. In `Application.onCreate`, with the other plugins: `ZnPlugins.register(this, PushPlugin())`.
4. The app's Activity needs `ZnActivity.attach(this)` (`docs/guide-notes.md` §31): a message says if the app was in front.
5. A white-on-clear notification icon, in the app's manifest (Android draws the app icon as a white square otherwise):
   ```xml
   <meta-data android:name="dev.zeronative.push.small_icon" android:resource="@drawable/ic_notification" />
   <!-- For messages with a `notification` block, which FCM shows itself: -->
   <meta-data android:name="com.google.firebase.messaging.default_notification_icon" android:resource="@drawable/ic_notification" />
   <!-- Optional: the icon's colour -->
   <meta-data android:name="dev.zeronative.push.color" android:resource="@color/brand" />
   ```

The plugin's manifest adds `POST_NOTIFICATIONS` (Android 13+), the FCM service and a receiver for swipes (both not
exported). Firebase adds `INTERNET`, `WAKE_LOCK` and FCM's receive permission. No exact alarms, no boot receiver, no
foreground service.

## Use it
```ts
// main.ts, at the top level: a message can start the app with no screen, so these must exist before any screen.
import { Notifications, Push } from "@zero-native/push"

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

// On a tap ("Turn on notifications"): core's permission call. Android 13+ shows its dialog; older: already on.
const r = await Permissions.request(["notifications"])
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
| `Push.onMessage(fn)` | — | Every data message: `{ data, inFront, priority, notification, sentAt, from, messageId, deleted? }` |
| `Push.onTokenRefresh(fn)` | — | `{ token }` |
| `Notifications.createChannel({ id, name, importance?, description?, sound?, vibration?, lights?, badge? })` | true | Android 8+. Safe at every start |
| `Notifications.deleteChannel(id)` | true | |
| `Notifications.canShow(channelId?)` | null or `off` / `no_channel` / `channel_blocked` | No dialog |
| `Notifications.show({ id, channelId, title, body?, bigText?, link?, largeIconUrl?, imageUrl?, group?, data?, autoCancel? })` | `{ shown, reason }` | The same id replaces it |
| `Notifications.cancel(id)` / `cancelAll()` | true | `cancelAll` on logout |
| `Notifications.onDismiss(fn)` | — | `{ id, data }` |

RN Firebase's names for ported code: `messaging().getToken()`, `onTokenRefresh`, `subscribeToTopic`,
`unsubscribeFromTopic`, `deleteToken`, `setBackgroundMessageHandler`. RN's front-only `onMessage` is our `onMessage`
with `m.inFront`. Notifee's `displayNotification` maps to `Notifications.show`.

## Rules worth knowing
- **Data messages** reach JS every time. **Messages with a `notification` block** are shown by Android itself while the
  app is behind (JS doesn't run for them then), and a tap opens the app on its start screen. For a tap that opens a
  route, or for pictures and groups, send data-only messages and call `Notifications.show`.
- A channel's importance, sound and vibration are fixed once made (the user owns them after). Only the name and
  description change later. To change the rest, use a new channel id.
- Images: https only (http also in debug builds), at most 3 MB, downloaded natively in at most 4 s. Else the
  notification shows without it.
- A group shows its summary from 2 notifications on (Android's own grouping starts at 4), with the newest 5 lines. It
  goes away at 1. The summary makes no sound of its own.
- `onMessage` has 15 s (FCM gives about 20). Long work goes to the server, or to a later start.
- Never log `m.data` as a whole, and never put private data in it: FCM servers and the phone's notification log keep it.
- Phones with no Google Play services get no FCM. `getToken` says why; local notifications still work.
- **Not in v1:** an "update now" push for OTA (ZeroBill's `ota_check` topic), scheduled notifications, action buttons,
  badges counts, iOS.

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-bom` | 35.1.0 | Firebase versions (from `@zero-native/firebase-app`) |
| `com.google.firebase:firebase-messaging` | from the BoM (26.0.x) | FCM |
| `androidx.core` | the app's | `NotificationCompat`, already in every app |

Measured on the sample's R8 release APK (arm64), 2026-11-04: **about 54 KB** on top of `@zero-native/crashlytics`
(classes.dex +50 KB compressed). The two share Firebase's core (firebase-common, installations, transport). An app with
push and no Crashlytics also pays for that core: not measured on its own.
