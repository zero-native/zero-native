# @zero-native/app-updates

Store updates for zero-native apps: **Google Play's in-app updates** on Android, **the App Store** on iOS. The
zn-updates server's store rules say who must or should update. The answer comes with native's OTA check, the same
call (`POST /v1/check`, `server/src/phone.ts`), and native keeps it (`Updates.status().store`); this plugin reads that
answer, asks Play, and shows the update. It makes no network call of its own.

Ported from ZeroBill's own plugin (`my-app/plugins/in-app-update`), which ported the RN app's
`ZInAppUpdatesModule`. The native behaviour is the same, tested on the RN and zn ZeroBill apps.

Not the same as OTA (`Updates` in core): OTA changes the JS bundle; this one sends the user to the store for a new
APK / IPA.

## What you get

| | Android | iOS |
|---|---|---|
| `storeAnswer(status?)` | the store answer of native's last update check (`{ update, store }`), or `null` before the first one | same |
| `nativeStoreSource`, `checkAfterUpdateChecks(engine)` | the engine's source, and "check after each of native's update checks" | same |
| `AppUpdates.isUpdateAvailable()` | Play's answer: `{ available, versionCode, immediateAllowed, flexibleAllowed, stalenessDays? }` | `{ available: false }` (no Play) |
| `AppUpdates.start({ flexible })` | Play's sheet: `false` = forced (IMMEDIATE), `true` = optional (FLEXIBLE) | `{ ok: false, unavailable: true }` |
| `AppUpdates.complete()` | installs a downloaded optional update (Play restarts the app) | `unavailable` |
| `AppUpdates.setBusy(busy)` | a payment / form is open: nothing opens or installs, the card hides | ignored |
| `AppUpdates.openStore({ appStoreId? })` | the Play listing (Play Store app, else the web page) | `itms-apps://apps.apple.com/app/id<appStoreId>` |
| `AppUpdates.onState(handler)` | Play's install state: `accepted`, `declined`, `pending`, `downloading` (bytes), `downloaded`, `failed` (errorCode), `canceled` | never fires |
| `createAppUpdateEngine(deps)` | the rules below, pure and tested | same, with the app's own screens |

Native module `AppUpdates`, version 1. Nothing rejects: a failure answers "no update", `ok: false` or `null`.

## The rules (critical 1 / 2)

The server answers `critical: 2` (forced) or `1` (optional) for this build, or `update: null`.

- **Forced (2).** Android: Play's full-screen IMMEDIATE update. Cancelling it opens it again; coming back to the app
  while Play still has it open opens it again. iOS: the app's own full-screen screen the user can't close; its button
  calls `openStore`. Shown again on every start and every return.
- **Optional (1).** Android: Play's FLEXIBLE sheet, then a download in the background. iOS: the app's own sheet. Once per
  session. Never on login / OTP screens (`holdRoutes`): it waits until the user leaves them.
- **Busy.** Never during a payment or a form being sent (`isBusy`, and `setBusy` for the native side). Nothing is shown
  or installed then; the next return checks again.
- **Play has no update for this phone** (staged rollout, Play is slow to see a new build): ignore, ask again next
  return. The server's rule alone never opens Play.
- **Downloaded.** A downloaded optional update installs when the user comes back to the app, never while busy. A new
  Activity (after Android killed the app) also installs it, unless the disk says "busy".
- The check runs 1 s after start and 1 s after every return to the app.

## How an app uses it

**1. Android host (once).** Add the Gradle project and register the plugin, then forward Play's result: Play Core
answers with a request code (312) through `onActivityResult`.

```kotlin
// Application.onCreate, with the other plugins
ZnPlugins.register(this, AppUpdatesPlugin(showCard = true))

// MainActivity
@Deprecated("Play Core's update sheet still answers through onActivityResult")
override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    if (AppUpdatesModule.onActivityResult(this, requestCode, resultCode)) return
    // ... other SDKs
}
```

iOS host: `ZnPlugins.register(..., AppUpdatesPlugin())`.

**2. JS (once, after `startApp`).**

```ts
import { appState, nav, onAppState, Platform } from "@zero-native/core"
import { AppUpdates, checkAfterUpdateChecks, createAppUpdateEngine, nativeStoreSource, playUpdates } from "@zero-native/app-updates"

const os = Platform.OS === "ios" ? "ios" : "android"
const engine = createAppUpdateEngine({
  // The answer comes with native's OTA check (the phone sends its versionCode / "1.6.2" version itself)
  source: nativeStoreSource,
  autoCheck: false, // checkAfterUpdateChecks below runs the checks
  play: os === "android" ? playUpdates : undefined,
  prompt: {
    forced: (u, store) => nav.replace("forceUpdate", { appStoreId: store.appStoreId, message: u.message }),
    optional: (u, store) => showUpdateSheet(u, store),
  },
  isBusy: () => checkout.isOpen(),
  currentRoute: () => nav.current()?.name,
  holdRoutes: new Set(["login", "verify"]),
  isFront: () => appState() === "active",
})
AppUpdates.onState((s) => engine.onUpdateState(s))
checkAfterUpdateChecks(engine) // one engine check after each of native's update checks
onAppState((s) => s === "active" && engine.onActive()) // installs a downloaded optional update

// How often native checks on a return is the app's choice: ZnOta.Config(checkIntervalMs = 0) checks on every return
// (a forced rule then reaches the user at once); the default is at most every 5 min.

// Tell native when a payment starts and ends (it also hides the card and holds a forced re-open)
checkout.subscribe(() => void AppUpdates.setBusy(checkout.isOpen()))
```

`prompt` is your own screens: a forced screen (no Back, one "Update" button that calls
`AppUpdates.openStore({ appStoreId })`) and an optional sheet. Android with `play` never calls `prompt`.

Call `setBusy` again on every return (as ZeroBill does): native keeps it on disk for a new Activity after a kill, and a
change made while the app had no Activity may not have reached it.

## The download card (Android): why opt-in

`AppUpdatesPlugin(showCard = true)` draws a small native card at the top of the screen while an optional update
downloads (progress, ✕ to hide), then "Update ready" with a Restart button. It is native on purpose: it follows Play
with no JS and survives a JS restart, and RN users already know it. It hides while the app is busy.

It is **off by default** because its look belongs to the app: a framework can't know the app's colour, words or
language. Words and colour: `AppUpdatesPlugin(showCard = true, cardTexts = UpdateCardTexts(readyHint = "Restart
MyApp to finish", color = 0xFF3D26ED.toInt()))`. An app that wants its own banner leaves it off and draws one from
`AppUpdates.onState` (`downloading` with bytes, `downloaded`, then `AppUpdates.complete()`).

## Saved state (Android)

SharedPreferences file `app_updates`: `update_type` and `update_request_priority` (the same keys as the RN app and
ZeroBill's plugin, so a phone that updates from those keeps its forced-update request), and `busy` (new).

## Testing with Play

- **In-app updates only work for an app installed from Play.** A sideloaded APK (`adb install`, Android Studio) always
  gets "no update" (`available: false`), and `start` shows nothing. The JS rules can still be tested with fakes
  (`test/rules.test.ts`).
- **Internal app sharing** is the quick way: upload build N and build N+1 to internal app sharing, install N from its
  link, then open the N+1 link (don't install it), go back to the app: Play now offers N+1. Turn on "Internal app
  sharing" in the Play Store app's settings (tap the Play Store version 7 times to show it). Both builds must be signed
  with the same key.
- Or the internal testing track, with a tester account on the phone.
- Play caches its answer: clear the Play Store app's cache if a new build doesn't show.
- **Forced:** start forced, press Back on Play's screen: it opens again. Leave the app while it is open, come back: it
  opens again.
- **Optional:** start optional, tap Update: `accepted`, then `downloading` events and the card; leave the app until
  it's downloaded, come back: it installs (or the Restart button does). Close the sheet: `declined`, not asked again
  this session.
- **Busy:** set busy, leave and come back with a forced update open in Play: it does not open again until busy ends.

The sample's "App updates plugin" lab (Dev screen) runs `Updates.check()` and shows the store answer that came with it
(the sample's update server, `bun run updates:server`, `adb reverse tcp:8790 tcp:8790`), and has buttons for each call.

## iOS notes

Apple has no in-app update API: the server's rule is the truth and the app shows its own screens (`prompt`). The App
Store id comes from the server's app facts (`store.ios.appStoreId`), answered as `store.appStoreId`. `openStore` opens
the App Store app directly (`itms-apps://`), not an in-app `SKStoreProductViewController` (kept small).
**`ios/AppUpdatesPlugin.swift` is not built on a Mac yet** (written on Windows, 2026-11-09).

## Size

Play Core `app-update` 2.1.0 (+ Play's tasks library). No permission.
