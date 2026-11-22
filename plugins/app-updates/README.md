# @zeronative/app-updates

Store updates for zero-native apps: **Google Play's in-app updates** on Android, **the App Store** on iOS. The
zn-updates server's store rules say who must or should update. The answer comes with native's OTA check, the same
call (`POST /v1/check`, `server/src/phone.ts`), and native keeps it (`Updates.status().store`); this plugin reads that
answer, asks Play, and shows the update. It makes no network call of its own.

Ported from ZeroBill's own plugin (`my-app/plugins/in-app-update`), which ported the RN app's
`ZInAppUpdatesModule`. The native behaviour is the same, tested on the RN and zn ZeroBill apps.

On Android, a forced update at launch opens natively, before the app's first screen (`AppUpdatesLaunch`, through zn's
launch gate): Play is asked at once, in parallel with the OTA check. Optional updates and returns use the JS engine.

Not the same as OTA (`Updates` in core): OTA changes the JS bundle; this one sends the user to the store for a new
APK / IPA.

## What you get

| | Android | iOS |
|---|---|---|
| `storeAnswer(status?)` | the store answer of native's last update check (`{ update, store }`), or `null` before the first one | same |
| `nativeStoreSource`, `checkAfterUpdateChecks(engine)` | the engine's source, and "check after each of native's update checks" | same |
| `AppUpdates.isUpdateAvailable({ appStoreId? })` | Play's answer: `{ available, versionCode, immediateAllowed, flexibleAllowed, stalenessDays? }` | the App Store's lookup: the same keys plus `storeVersion` and `appStoreId`; `available` = the store's version is newer than this build's and this iOS can run it (kept an hour) |
| `AppUpdates.start({ flexible, appStoreId? })` | Play's sheet: `false` = forced (IMMEDIATE), `true` = optional (FLEXIBLE) | the App Store's own sheet for the app, inside the app (`SKStoreProductViewController`; the App Store app when it can't load). A forced one opens again on each return to the app |
| `AppUpdates.complete()` | installs a downloaded optional update (Play restarts the app) | `unavailable`: the App Store installs and ends the app itself |
| `AppUpdates.setBusy(busy)` | a payment / form is open: nothing opens or installs, the card hides | no forced sheet opens again; kept on disk |
| `AppUpdates.openStore({ appStoreId? })` | the Play listing (Play Store app, else the web page) | `itms-apps://apps.apple.com/app/id<appStoreId>` |
| `AppUpdates.onState(handler)` | Play's install state: `accepted`, `declined`, `pending`, `downloading` (bytes), `downloaded`, `failed` (errorCode), `canceled` | the sheet closing: `declined` (optional) or `canceled` (forced). iOS never says whether Update was tapped |
| `appStoreUpdates` | - | the lookup in the shape of the engine's `confirm` |
| `createAppUpdateEngine(deps)` | the rules below, pure and tested | same, with the app's own screens (and `confirm`) |

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
- **The App Store doesn't have it yet** (iOS with `confirm: appStoreUpdates`): the same. Apple's CDN can lag a release
  by hours, and the server's rule may come first.
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
import { appState, nav, onAppState, Platform } from "@zeronative/core"
import { AppUpdates, appStoreUpdates, checkAfterUpdateChecks, createAppUpdateEngine, nativeStoreSource, playUpdates } from "@zeronative/app-updates"

const os = Platform.OS === "ios" ? "ios" : "android"
const engine = createAppUpdateEngine({
  // The answer comes with native's OTA check (the phone sends its versionCode / "1.6.2" version itself)
  source: nativeStoreSource,
  autoCheck: false, // checkAfterUpdateChecks below runs the checks
  play: os === "android" ? playUpdates : undefined,
  confirm: os === "ios" ? appStoreUpdates : undefined, // iOS: show the screens once the App Store has the version
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
`AppUpdates.start({ flexible: false, appStoreId })` for the App Store sheet in the app, or
`AppUpdates.openStore({ appStoreId })` for the App Store app) and an optional sheet. Android with `play` never calls
`prompt`.

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
- **Forced at launch:** with a forced rule for build N, open N from the launcher: Play's forced screen opens before
  the first screen (logcat `zn-app-updates` "launch: ... Play's screen opens N ms after the launch", and `zn-ota`
  "gate: ..."). Open it again: it opens at once from the saved answer.

The sample's "App updates plugin" lab (Dev screen) runs `Updates.check()` and shows the store answer that came with it
(the sample's update server, `bun run updates:server`, `adb reverse tcp:8790 tcp:8790`), and has buttons for each call.

## iOS notes

Apple has no in-app update API like Play's: the server's rule decides and the app shows its own screens (`prompt`).
The App Store id comes from the server's app facts (`store.ios.appStoreId`), answered as `store.appStoreId`.

- `isUpdateAvailable` asks Apple's public lookup (`https://itunes.apple.com/lookup?bundleId=<this app>&country=<cc>`,
  or `id=<appStoreId>` when given). The country is the App Store account's (StoreKit's storefront), then the phone's
  region when that storefront has no answer. It sends Apple only the bundle id (or id) and the country. It is not a
  documented API, though widely used; an app not sold in either storefront gets no result (`available: false`).
  Answers are kept an hour, and Apple's CDN can lag a release by hours.
- `start` loads the App Store's sheet, then shows it in the app. It can't be made full screen, so a forced update still
  needs your own screen behind it. It isn't refused while busy (as Android); busy only stops a forced sheet opening
  again. A forced sheet keeps opening again on each return until a check of that same app says there is no update (a
  failed lookup, offline say, doesn't end it). It doesn't load on the simulator (no App Store there); then it opens the
  App Store app, which the simulator doesn't have either (`ok: false`).
- `complete` can't exist: the App Store installs the update and ends the app.
- The rules are in `ios/AppUpdatesRules.swift`, checked on the Mac by `bun run tools/ios-unit-test.ts plugins/app-updates`.
- The lab: `bun run tools/ios-sample.ts --route appUpdatesLab --params '{"appStoreId":"<a published app's id>"}'`.

## Size

Play Core `app-update` 2.1.0 (+ Play's tasks library). No permission.
