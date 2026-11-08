# @zero-native/notifications

Notifications the app shows itself, on Android, with no Firebase and no push service in it. A notifee-like API:
channels and channel groups, `show` with big text, a big picture, a large icon, inbox lines, a progress bar, buttons
(with an inline reply), groups with a summary, scheduled notifications, cancel, lists of what is shown and of channels,
and a check before showing. A tap opens the notification's `link` through the app's normal link path. A button or a
swipe away runs a task.

It also holds **`PushEvents`**: the path every push service's messages and tokens take to JS (below). FCM is
`@zero-native/push`, which adds this plugin by itself.

Each call answers with a value and never rejects. Nothing asks for a permission by itself.

## Add it
1. In the app's `settings.gradle.kts`: `include(":plugin-notifications")` with its `projectDir`
   (`plugins/notifications/android`), and in `build.gradle.kts`: `implementation(project(":plugin-notifications"))`.
   With `@zero-native/push` this comes with it: skip steps 1 and 2.
2. In `Application.onCreate`, with the other plugins: `ZnPlugins.register(this, NotificationsPlugin())`. Listing it
   next to `PushPlugin()` is fine: the second one does nothing.
3. The app's Activity needs `ZnActivity.attach(this)` (`docs/guide-notes.md` §31): taps come from its events.
4. A white-on-clear notification icon, in the app's manifest (Android draws the app icon as a white square otherwise):
   ```xml
   <meta-data android:name="dev.zeronative.notifications.small_icon" android:resource="@drawable/ic_notification" />
   <!-- Optional: the icon's colour -->
   <meta-data android:name="dev.zeronative.notifications.color" android:resource="@color/brand" />
   ```
   **Deprecated:** the old keys `dev.zeronative.push.small_icon` and `dev.zeronative.push.color` (from before the
   split, 2026-11-09) still work; the new key wins when both are there. Move to the new ones.
5. JS: import from `@zero-native/notifications`. Importing `Notifications` from `@zero-native/push` still works, but
   then the app's bundle also needs the "Push" module (the OTA check refuses it on an app without push).

The plugin's manifest adds `POST_NOTIFICATIONS` (Android 13+) and three receivers (none exported):
`ZnNotificationDismissed` (swipes), `ZnNotificationTrigger` (the alarm of a scheduled notification) and
`ZnNotificationAction` (a button with no link, for `Notifications.onAction`), all in
`dev.zeronative.plugins.notifications`. No exact alarms, no boot receiver, no foreground service. Pictures load over
the runtime's `INTERNET` permission.

## Use it
```ts
// main.ts, at the top level: these run with no screen, so they must exist before any screen.
import { Notifications } from "@zero-native/notifications"

Notifications.onDismiss(({ id, data }) => track("dismissed", id))
Notifications.onPress(({ id, data }) => openFromNotification(id, data))   // a tap with no link, app running

// At start (safe every time):
await Notifications.createChannel({ id: "bills", name: "Bills", importance: "high" })
await Notifications.schedule(
  { id: "bill-due", channelId: "bills", title: "Your bill is due", link: "myapp://bills" },
  { at: Date.now() + 86_400_000 },
)

// On a tap ("Turn on notifications"). Android 13+ shows its dialog; older: already on.
const state = await Notifications.requestPermission()
```

A tap on a notification opens its `link`: the app's own link goes through `onLink` in `startApp` (also on a cold
start), a web link opens the browser, no link opens the app. To count opens, put it in the link (`?from=notification`).

## API
| Call | Answers | What it does |
|---|---|---|
| `Notifications.requestPermission()` / `hasPermission()` | `granted` / `denied` / `blocked` | Core's `Permissions` for `notifications` (Android 13+ asks; older: granted) |
| `Notifications.createChannel({ id, name, importance?, description?, sound?, vibration?, lights?, badge?, groupId? })` | true | Android 8+. Safe at every start |
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
| `Notifications.getInitialNotification()` / `onPress(fn)` | `{ id, data }` / null | A tap with no `link`: the one that started the app, once; or while it runs (native version 3) |
| `PushEvents.onMessage(fn)` | — | A message from any push service: `{ provider, data, inFront, priority, notification, sentAt, from, messageId, deleted? }` |
| `PushEvents.onTokenRefresh(fn)` | — | `{ token, provider }` |

Notifee's `displayNotification` maps to `Notifications.show`, `createTriggerNotification` to `schedule`.

## Push services (`PushEvents`)
A push service gets its messages and tokens its own way, then hands them to `PushEvents` (Kotlin,
`dev.zeronative.plugins.notifications.PushEvents`). JS hears every service the same way: `PushEvents.onMessage` (the JS
task `push.message`) and `PushEvents.onTokenRefresh` (`push.token`). `Push.onMessage` in `@zero-native/push` is the same
task. What a service plugin does:
- **A message:** `PushEvents.message(PushMessage(provider = "onesignal", messageId, from, sentAt, priority, data = ...,
  notification = PushMessage.Notice(title, body)))`. It waits until JS answers (15 s at most), so call it from the
  service's background thread, never the main thread. Data is all strings.
- **Dropped messages:** `PushEvents.deleted(provider)`. **A new token:** `PushEvents.token(token, provider)`.
- **Taps on notifications the service showed itself:** `val opens = PushEvents.taps("OneSignal's notification") { intent
  -> key to payload }`, then the service's own module answers its `getInitialNotification` with `opens.initial { ... }`
  and sets `opens.emit` for taps while the app runs. The notifications plugin gives every one of them the Activity's
  events.
- `PushEvents.inFront` says whether the app is on screen.
- Getting a token, topics and the like stay in the service's own module (FCM: the "Push" module).

**iOS (not built yet):** the notifications plugin would own `UNUserNotificationCenter` (show, schedule, actions,
taps). An APNs-only push path would get the device token from `application(_:didRegisterForRemoteNotifications...)`
and remote messages from the app delegate, and hand them to the same `PushEvents` (provider `"apns"`). FCM on iOS would
sit on top of APNs. See `docs/ios-parity-checklist.md` and `docs/second-opinions.md` entry 196.

## Rules worth knowing
- A channel's importance, sound and vibration are fixed once made (the user owns them after). Only the name and
  description change later. To change the rest, use a new channel id.
- Images: https only (http also in debug builds), at most 3 MB, downloaded natively in at most 4 s. Else the
  notification shows without it.
- A group shows its summary from 2 notifications on (Android's own grouping starts at 4), with the newest 5 lines. It
  goes away at 1. The summary makes no sound of its own.
- **Buttons:** a button with a `link` opens it like a tap; one without runs `onAction` with no screen. A reply button
  (`input`) shows Android's inline reply; after it Android shows a spinner until you show the same id again or
  cancel it. Lock screen: `visibility: "private"` (the default) shows only the app name; use `"secret"` for money.
- **Scheduled notifications** are shown by an alarm, natively, with no JS (the app may be closed). Not exact: within
  10 minutes of their time; a phone in deep Doze (still, screen off for long) shows them when it wakes. For exact times
  the app declares `<uses-permission android:name="android.permission.SCHEDULE_EXACT_ALARM" />` itself and passes
  `exact: true`; on Android 12+ the user must allow it (`canScheduleExact`, `openSettings("exact_alarms")`). Without
  it, `exact` falls back to inexact. Android drops alarms on a reboot and on a force-stop: the plugin sets them again
  at each app start. To have them back after a reboot without opening the app, add the boot receiver to the app's
  manifest:
  ```xml
  <uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
  <receiver android:name="dev.zeronative.plugins.notifications.ZnNotificationBoot" android:exported="false">
      <intent-filter>
          <action android:name="android.intent.action.BOOT_COMPLETED" />
          <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
      </intent-filter>
  </receiver>
  ```
  A missed one-time notification (phone off) shows at the next chance; a missed repeat moves to its next time.
- **HTML text, as notifee:** `title`, `body`, `bigText` and `lines` may use `<b>`, `<i>`, `<u>`, `<br>` and
  `<span style="color:#E23744">`. Text with no tag and no entity (`&amp;`) is shown exactly as given, so plain text
  keeps its line breaks. In HTML text a `\n` is a line break too. Older apps (native version 2) show the tags as text.
- **A tap with no `link`** opens the app and calls `Notifications.onPress({ id, data })` while it runs, or answers
  `Notifications.getInitialNotification()` if the tap started it (notifee's PRESS event). One answer per tap; after a
  low-memory kill the tap counts as the start. A notification with a `link` opens the link instead. A group summary
  with no `link` is a press too: `{ id: <group key>, data: group.data }`. Each press carries a random value kept in the
  app's private storage, so another app can't fake one by sending your launcher Activity the same extras. A push
  service's own notifications keep their own calls (FCM: `Push.getInitialNotification`, `onNotificationOpenedApp`).
- Logs use the tag `zn-notifications`. Saved state: prefs `zn-notifications-scheduled`, `-groups`, `-press`.
- **Not built yet:** foreground services, messaging style, full-screen intents, iOS.

## Size
| Dependency | Version | Why |
|---|---|---|
| `androidx.core` | the app's | `NotificationCompat`, already in every app |

No other dependency. Not measured on its own yet; it is the bigger part of what `@zero-native/push` added before the
split (about 54 KB with FCM, 2026-11-04).
