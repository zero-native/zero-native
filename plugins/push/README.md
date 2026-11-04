# @zero-native/push

Push messages (Firebase Cloud Messaging) and notifications the app shows itself, on Android. Two parts:

- **`Push`**: the FCM token, topics, and every data message, as a JS task. The task runs when the app is in front,
  behind, or closed (FCM starts the app). One path for all three, so nothing "only works while open".
- **`Notifications`**: a notifee-like API: channels and channel groups, `show` with big text, a big picture, a large
  icon, inbox lines, a progress bar, buttons (with an inline reply), groups with a summary, cancel, lists of what is
  shown and of channels, and a check before showing. A tap opens the notification's `link` through the app's normal
  link path. A button or a swipe away runs a task. It works with no FCM at all.

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

The plugin's manifest adds `POST_NOTIFICATIONS` (Android 13+), the FCM service and three receivers (none exported):
`ZnNotificationDismissed` (swipes), `ZnNotificationTrigger` (the alarm of a scheduled notification) and
`ZnNotificationAction` (a button with no link, for `Notifications.onAction`) *(the last two came with push v2)*. Firebase adds `INTERNET`, `WAKE_LOCK` and FCM's receive permission. No exact alarms, no boot receiver, no
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
| `Push.getInitialNotification()` | `{ messageId, from, sentAt, data }` / null | The FCM notification whose tap started the app, once (native version 2) |
| `Push.onNotificationOpenedApp(fn)` | unsubscribe function | A tap on an FCM notification while the app was behind (native version 2) |
| `Push.setAutoInitEnabled(on)` / `isAutoInitEnabled()` | true / false | FCM's token at the first start, by itself. Kept across starts (native version 2) |
| `Push.requestPermission()` / `hasPermission()` | `granted` / `denied` / `blocked` | Core's `Permissions` for `notifications` (Android 13+ asks; older: granted) |
| `Notifications.createChannel({ id, name, importance?, description?, sound?, vibration?, lights?, badge? })` | true | Android 8+. Safe at every start |
| `Notifications.deleteChannel(id)` | true | |
| `Notifications.canShow(channelId?)` | null or `off` / `no_channel` / `channel_blocked` | No dialog |
| `Notifications.show({ id, channelId, title, body?, bigText?, link?, largeIconUrl?, imageUrl?, group?, data?, autoCancel? })` | `{ shown, reason }` | The same id replaces it |
| `Notifications.cancel(id)` / `cancelAll()` | true | `cancelAll` on logout |
| `Notifications.onDismiss(fn)` | — | `{ id, data }` |
| `show({ ..., actions, lines, progress, ongoing, onlyAlertOnce, silent, number, timestamp, showTimestamp, visibility, category, color })` | | Native version 2. `actions`: `[{ id, title, link?, input?: { placeholder } }]`, 3 at most. `visibility` default `"private"` |
| `Notifications.onAction(fn)` | — | `{ id, actionId, data, input? }`: a button with no link (8 s, no screen). Cancel or show the same id again after (native version 2) |
| `Notifications.createChannelGroup({ id, name, description? })` / `deleteChannelGroup(id)` | true | A heading over channels in the phone's settings; a channel joins with `groupId` (native version 2) |
| `Notifications.getChannels()` / `getChannel(id)` | `[{ id, name, importance, blocked, description, groupId }]` | As the user left them (native version 2) |
| `Notifications.getDisplayed()` | `[{ id, title, body, channelId, group, shownAt, data }]` | On screen now, newest first (native version 2) |
| `Notifications.schedule(options, { at, repeat?, exact? })` | `{ scheduled, reason }` | Shows it later, natively. `repeat`: `hourly`, `daily`, `weekly`. `reason`: `past`, `bad_repeat`, `no_id` (native version 2) |
| `Notifications.getScheduled()` | `[{ id, at, repeat }]` | Soonest first. `cancel(id)` and `cancelAll()` remove scheduled ones too |
| `Notifications.canScheduleExact()` / `isBatteryOptimized()` | true / false | Power checks |
| `Notifications.openSettings(page)` | true / false | `exact_alarms` (Android 12+), `battery`, `notifications` |

RN Firebase's names for ported code: `messaging().getToken()`, `onTokenRefresh`, `subscribeToTopic`,
`unsubscribeFromTopic`, `deleteToken`, `setBackgroundMessageHandler`, `getInitialNotification`,
`onNotificationOpenedApp`, `setAutoInitEnabled`, `requestPermission` and `hasPermission` (these two answer
`AuthorizationStatus`: 1 granted, 0 not). RN's front-only `onMessage` is our `onMessage` with `m.inFront`. Notifee's `displayNotification` maps to `Notifications.show`.

## Rules worth knowing
- **Data messages** reach JS every time. **Messages with a `notification` block** are shown by Android itself while the
  app is behind (JS doesn't run for them then), and a tap opens the app on its start screen. The message's data comes
  with the tap: `getInitialNotification()` (the app was closed) or `onNotificationOpenedApp` (it was behind). Open a
  `data.link` from there yourself. For pictures and groups, send data-only messages and call `Notifications.show`.
- **"Check for an update now":** a data message `zn_ota=check` (to a topic like `ota-android`) runs core's OTA check at
  once, natively, as at a start (`ZnOta.check`). It never reaches JS. A new bundle installs and applies by the app's
  normal OTA rules. Turn it off with `PushPlugin(otaCheck = false)`.
- A channel's importance, sound and vibration are fixed once made (the user owns them after). Only the name and
  description change later. To change the rest, use a new channel id.
- Images: https only (http also in debug builds), at most 3 MB, downloaded natively in at most 4 s. Else the
  notification shows without it.
- A group shows its summary from 2 notifications on (Android's own grouping starts at 4), with the newest 5 lines. It
  goes away at 1. The summary makes no sound of its own.
- `onMessage` has 15 s (FCM gives about 20). Long work goes to the server, or to a later start.
- Never log `m.data` as a whole, and never put private data in it: FCM servers and the phone's notification log keep it.
- Phones with no Google Play services get no FCM. `getToken` says why; local notifications still work.
- **Buttons:** a button with a `link` opens it like a tap; one without runs `onAction` with no screen. A reply button
  (`input`) shows Android's inline reply; after it Android shows a spinner until you show the same id again or
  cancel it. Lock screen: `visibility: "private"` (the default) shows only the app name; use `"secret"` for money.
- **Scheduled notifications** are shown by an alarm, natively, with no JS (the app may be closed). Not exact: within
  10 minutes of their time; a phone in deep Doze (still, screen off for long) shows them when it wakes. For exact times the app declares
  `<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />` itself and passes `exact: true`; on
  Android 12+ the user must allow it (`canScheduleExact`, `openSettings("exact_alarms")`). Without it, `exact` falls
  back to inexact. Android drops alarms on a reboot and on a force-stop: the plugin sets them again at each app start.
  To have them back after a reboot without opening the app, add the boot receiver to the app's manifest:
  ```xml
  <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
  <receiver android:name="dev.zeronative.plugins.push.ZnNotificationBoot" android:exported="false">
      <intent-filter>
          <action android:name="android.intent.action.BOOT_COMPLETED" />
          <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
      </intent-filter>
  </receiver>
  ```
  A missed one-time notification (phone off) shows at the next chance; a missed repeat moves to its next time.
- **Not built yet:** foreground services, messaging style, full-screen intents, iOS.

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-bom` | 35.1.0 | Firebase versions (from `@zero-native/firebase-app`) |
| `com.google.firebase:firebase-messaging` | from the BoM (26.0.x) | FCM |
| `androidx.core` | the app's | `NotificationCompat`, already in every app |

Measured on the sample's R8 release APK (arm64), 2026-11-04: **about 54 KB** on top of `@zero-native/crashlytics`
(classes.dex +50 KB compressed). The two share Firebase's core (firebase-common, installations, transport). An app with
push and no Crashlytics also pays for that core: not measured on its own.
