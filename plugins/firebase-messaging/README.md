# @zeronative/firebase-messaging

Push messages from Firebase Cloud Messaging, on Android and iOS. **`Push`**: the FCM token, topics, and every data message, as
a JS task. The task runs when the app is in front, behind, or closed (FCM starts the app). One path for all three, so
nothing "only works while open".

> **`Notifications` moved** to [`@zeronative/notifications`](../notifications/README.md) (2026-11-09), which has no
> Firebase in it. This plugin adds it by itself (`PushPlugin()` registers `NotificationsPlugin()`), and this package
> re-exports it, so `import { Notifications } from "@zeronative/firebase-messaging"` keeps working. New code imports it from
> `@zeronative/notifications`. Messages reach JS through that plugin's `PushEvents`, the path any push service can use.

Each call answers with a value and never rejects. Nothing asks for a permission by itself.

## Add it
1. Firebase as for `@zeronative/firebase-crashlytics` (README there): `google-services.json`, `:plugin-firebase-app` in
   `settings.gradle.kts`, and `apply(from = "../../plugins/firebase-app/firebase.gradle.kts")`, which applies the
   google-services Gradle plugin only when the json is there. Without it the app builds, `Push.status()` says `available: false`,
   and `Notifications` still work.
2. In the app's `settings.gradle.kts`: `:plugin-firebase-messaging` and `:plugin-notifications` (push depends on it). In
   `build.gradle.kts`: `implementation(project(":plugin-firebase-messaging"))`.
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
permission; `POST_NOTIFICATIONS` and the notification receivers come from `@zeronative/notifications`.

## Use it
```ts
// main.ts, at the top level: a message can start the app with no screen, so these must exist before any screen.
import { Notifications } from "@zeronative/notifications"
import { Push } from "@zeronative/firebase-messaging"

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
- **"Check for an update":** a data message `zn_ota=check` runs core's OTA check natively, in a background job after
  a random wait (see "OTA pushes" below). It never reaches JS. Turn it off with `PushPlugin(otaCheck = false)`.
- `onMessage` has 15 s (FCM gives about 20). Long work goes to the server, or to a later start.
- Never log `m.data` as a whole, and never put private data in it: FCM servers and the phone's notification log keep it.
- Phones with no Google Play services get no FCM. `getToken` says why; local notifications still work.
- Logs use the tag `zn-push` (the message line itself, `fcm message ...`, is `zn-notifications`).
- Other push services: the notifications README, "Push services".

## iOS
The plugin's Swift (`ios/FirebaseMessagingPlugin.swift`) gets the APNs token, hands it to FCM, and answers the same
calls. Details: `docs/milestones-ios.md` (Phase 3).

**Add it:**
1. Firebase as for `@zeronative/firebase-crashlytics` on iOS (GoogleService-Info.plist, the SDK from
   `bun run tools/fetch-firebase-apple.ts`), plus the `FirebaseMessaging` xcframeworks and their privacy bundles.
2. `FirebaseMessagingPlugin()` in `ZnPlugins.register(...)`. It adds `NotificationsPlugin()` itself.
3. Info.plist: `FirebaseAppDelegateProxyEnabled` = NO and `UIBackgroundModes` = [`remote-notification`]. The
   entitlement `aps-environment` (Xcode turns `development` into `production` for an App Store build). Firebase's
   project needs the app's APNs key (Firebase console, Cloud Messaging, Apple app configuration).
4. The app delegate forwards three calls (the header of `FirebaseMessagingPlugin.swift` has them):
   `FirebaseMessagingPlugin.apnsToken(token)`, `.apnsFailed(error)`, `.remoteNotification(info, done)`.
5. For pushes iOS shows itself: a **notification service extension** with `ios-service/ZnNotificationService.swift`
   (ZeroBill: the `AppNotificationService` target in ios/CMakeLists.txt). It removes HTML tags from the title and
   body and attaches the picture (`fcm_options.image`, else the data keys in its Info.plist `ZnNotificationImageKeys`).
   A push with no category gets `zn.default` (its swipe reaches `onDismiss`), or the extension's Info.plist
   `ZnNotificationDefaultCategory`.
6. Optional, so JS hears of **every** push iOS showed: an **App Group** for the app and the extension (the entitlement
   `com.apple.security.application-groups` in both, and Info.plist `ZnAppGroup` = the group's id in both). The
   extension notes each push there. Without it JS hears only of the ones still in the notification centre, or acted on.

**How messages arrive on iOS (not as on Android):**
- **The server must send an alert for iOS** (an `apns` block with `aps.alert` and `"mutable-content": 1`). iOS shows
  it while the app is behind or closed, with no app code. JS hears of it later, once per message id:
  - `onMessage` with `shown: true` and `shownAt` (when iOS showed it), at the next start or return to the front, or
    with its tap, swipe or button. Save it and count it; don't show it again.
  - a tap: `onNotificationOpenedApp`, or `getInitialNotification` after a cold start. Its `data` comes with it.
  - a swipe: `Notifications.onDismiss` (`id` the message id, `provider: "fcm"`), if its category has the dismiss
    action (`zn.default` from the extension, or one set with `setNotificationCategories`).
  - a button of its category (the server's `aps.category`): `Notifications.onAction` (`provider: "fcm"`).
  - Whether iOS could show it isn't known per push (Android's "can't show"): `Notifications.getNotificationSettings()`
    says what the user allows. iOS groups pushes by the server's `aps.thread-id`; there is no summary to tap.
- While the app is in front the same push runs `onMessage` (`inFront: true`, `notification` set) and iOS shows nothing,
  so the app shows its own with `Notifications.show`, as on Android. `FirebaseMessagingPlugin(foreground: [.banner])`
  makes iOS show it too.
- Data-only messages reach iOS only while the app runs, or as a background wake (`content-available`: send it with
  `apns-push-type: background` and `apns-priority: 5`, `tools/push-send.ts --background`). iOS rations those (a few an
  hour), holds them in Low Power Mode, and never wakes an app the user closed. The plugin answers iOS's
  `fetchCompletionHandler` once, within 25 s, even when JS is slow or not running (a handler never called makes iOS end
  the app and wake it less). JS doesn't start for a background launch yet: such a message is kept and `onMessage` runs
  at the next start (or when the app opens), late; compare `sentAt` with `Date.now()` before acting on old data. For
  anything that must arrive, send an alert push (above).
- `getToken` waits up to 10 s for the APNs token: `not_now` without it (no network; a simulator build without the push
  entitlement). A message reaching both the app delegate and the notification center runs `onMessage` once.
- `zn_ota=check` messages run the OTA check natively: "OTA pushes" below, "On iOS".
- Logs start with `zn-push:`. The APNs token and the FCM token are never logged.

Checked on the iOS Simulator (2026-11-11) with `xcrun simctl push`: a push in front (onMessage, the app's own
notification, no second one from iOS), behind and closed (iOS shows it; a tap reaches `onNotificationOpenedApp` /
`getInitialNotification`). `simctl push` skips service extensions; the extension's code was run on its own on the Mac.
Data-only pushes on the simulator (2026-11-21, the sample's debug hook `notifyutil -p dev.zeronative.sample.push.data`,
since the iOS 26 simulator doesn't hand simctl's background pushes to the app delegate): with JS 45 s late iOS was
answered once at 25 s and `onMessage` ran when JS came up; with a JS handler slower than the task's 15 s it was
aborted and iOS answered at 15 s; with the process ended before JS ran, the message ran at the next start.
Then on an iPhone 11 through FCM (2026-11-11, a signed debug build, the server's planned `apns` shape): in front
(`onMessage`, the app's own notification), closed (iOS showed it with the HTML gone and the picture attached; a tap
started the app and opened its action).

## OTA pushes (a new bundle downloads in the background)
When the OTA server publishes a bundle, it sends one FCM data message to the channel's topic. Each phone then downloads
the bundle in the background, at a random moment, and runs it from its **next cold start**. Nothing is applied in the
background (`Updates.applyNow()` still works as usual).

**The contract (server → phone):**
- Topic: `zn-ota-<app>-<channel>`. `app` is the OTA app id of the APK's own bundle (`zn-updates.json` `app`, e.g.
  `sample`); `channel` is `ZnOta.Config.channel` (e.g. `staging`). Example: `zn-ota-sample-staging`.
- Data (all strings, no `notification` block): `{ "zn_ota": "check", "zn_ota_delay_ms": "<n>" }`. `n`: the longest
  random wait in whole ms. Missing or not a number: 0. Clamped to 0 .. 24 h.
- `android.priority`: `high` (a normal message can wait for hours on a phone in Doze).
- One message per publish is enough. The phone asks the OTA server what to do; the message carries no bundle id.

**What the phone does:**
1. At each start of the main process (after `Application.onCreate`), with `otaCheck` on and `ZnOta` configured, it
   subscribes to its topic. FCM ignores a repeat. It keeps the last topic; when the topic changes (another channel or
   app id), it unsubscribes the old one. Log: `subscribed to the OTA topic zn-ota-sample-staging`. With
   `otaCheck = false` it unsubscribes the kept topic. With OTA off (no `ZnOta.configure`) nothing changes.
2. The message schedules a WorkManager job (`zn-ota-push-check`): a random wait in 0 .. `zn_ota_delay_ms`, and only
   with a network. Log: `OTA check job in 1234 ms (random in 0..3000 ms), once online`.
3. **One job at a time.** A push while a job waits changes nothing (`a job is already enqueued (due in 40 s), kept as it
   is`): a second push can't move it further away. When the job runs, it gets whatever is newest.
4. The job runs `ZnOta.check` (the same check as at a start) and waits up to 8 min (WorkManager stops a job at 10).
   A failed check on the network (no answer, server error, cut download) runs again later, at most 3 runs in all. Other
   failures (bad signature, a bundle that doesn't fit) don't retry. After that, the next start checks as always.
5. The new bundle runs from the next cold start. Logs: `zn-ota: installed sample_7; it runs from the next start`.

**Choosing the wait:** a few seconds on staging (testers want it now). On production, spread the phones over a few
hours (for example 6 h = `21600000`), so a million phones don't call the server in the same minute.

**On iOS** (`ios/OtaPush.swift`; `FirebaseMessagingPlugin(otaCheck: false)` turns it off): the same topic, joined once per start
when FCM has its token (FCM can't join a topic before APNs has answered), and the same message. Not as on Android:
- The message must wake the app: the server sends it with an `apns` block for a background push
  (`apns-push-type: background`, `apns-priority: 5`, `aps: { "content-available": 1 }`). iOS throttles those (a few an
  hour) and never delivers them to an app the user swiped away in the app switcher; such phones check at their next
  start or return, as always.
- A woken app has about 30 s. A random wait up to 10 s runs in it, then the check (under a background task while it
  lasts). A longer wait becomes a background refresh task due after the wait, only if the app declares it:
  `BGTaskSchedulerPermittedIdentifiers` = [`dev.zeronative.ota-check`] and `fetch` in `UIBackgroundModes`. iOS
  decides when it runs. Without it nothing is scheduled; the next start or return checks.
- No retries after a failed check (Android: 3 runs). Logs: `zn-push: message …: OTA check in 1234 ms`,
  `zn-push: OTA check: <action> <reason>` (the check's own logs start with `zn-ota:`).

Logs use the tag `zn-push` (the job) and `zn-ota` (the check). `PushPlugin` adds `androidx.work:work-runtime-ktx`; an app
that turned off WorkManager's start-up initializer must set it up itself, or the push logs `can't schedule`.

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-bom` | 35.1.0 | Firebase versions (from `@zeronative/firebase-app`) |
| `com.google.firebase:firebase-messaging` | from the BoM (26.0.x) | FCM |
| `@zeronative/notifications` | this repo | Notifications and `PushEvents` (no Firebase) |
| `androidx.work:work-runtime-ktx` | 2.12.0 | The OTA check job after an OTA push (added 2026-11-09, size not measured) |

Measured on the sample's R8 release APK (arm64), 2026-11-04, before the split (push and notifications together):
**about 54 KB** on top of `@zeronative/firebase-crashlytics`
(classes.dex +50 KB compressed). The two share Firebase's core (firebase-common, installations, transport). An app with
push and no Crashlytics also pays for that core: not measured on its own.
