# @zeronative/location

The phone's location on Android, from Android's own `LocationManager` and `Geocoder`. Play services is used for one thing
only: Google's "Turn on location" dialog.

- **One fix** (`getCurrentPosition`), with a timeout, and the last known fix when there is no new one.
- **Updates** (`watchPosition`), paused while the app is hidden.
- **Permission**, with "denied" and "blocked" (Android won't ask again), precise or approximate.
- **Location off**: says so, shows Google's "Turn on location" dialog (`turnOn`), or opens the phone's Location screen.
- **Geocoder**: place names and postal codes for a point, and points for a name.

Each call answers with a value and never rejects. Nothing shows a dialog except `requestPermission` and `turnOn`.
Nothing logs a coordinate or an address.

## Add it
In the app's `build.gradle.kts`:
```kotlin
implementation(project(":plugin-location"))
```
In `Application.onCreate`, first thing:
```kotlin
ZnPlugins.register(this, LocationPlugin())
```
The app's Activity needs `ZnActivity.attach(this)` (`docs/guide-notes.md` §31): the plugin learns from it when the app
is in front. The plugin's manifest adds `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`. For the rough one only, remove
the first in your app's manifest:
```xml
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" tools:node="remove" />
```
It never asks for background location, and no foreground service.

## Use it
```ts
import { Location } from "@zeronative/location"
import { onAppState, Os } from "@zeronative/core"

// On a tap ("Use my location"):
const { permission } = await Location.requestPermission()   // shows Android's dialog only if it can
if (permission === "blocked") return Os.openSettings()        // the app's page: the only way out

const r = await Location.getCurrentPosition({ timeoutMs: 8000 })
if (r.position) loadStores(r.position.coords.latitude, r.position.coords.longitude)
else if (r.reason === "off") {
  const t = await Location.turnOn()                          // Google's dialog: "Turn on" switches it on at once
  if (t.on) retry()
  else if (t.reason === "unavailable") await Location.openSettings() // no Play services: then check again when active:
}
onAppState((s) => s === "active" && retry())
```

## API
| Call | Answers | What it does |
|---|---|---|
| `getCurrentPosition({ accuracy?, timeoutMs?, maxAgeMs?, signal? })` | `{ position, reason, lastKnown }` | One fix. `position` null: `reason` says why, `lastKnown` is the newest cached fix (any age) or null |
| `watchPosition(onPosition, { accuracy?, intervalMs?, distanceFilterM? }, onError?)` | a stop function | Fixes until stop, or until the screen that started it closes |
| `lastKnown()` | `Position` or null | The newest cached fix. Starts nothing |
| `status()` | `{ permission, precise, enabled, gps, network }` | No dialog |
| `requestPermission({ precise? })` | `{ permission, precise }` | Android's dialog. `precise: false` asks only for the rough one |
| `turnOn()` | `{ on, reason }` | Google's "Turn on location" dialog when location is off. Already on: `{ on: true }`, no dialog |
| `openSettings()` | true / false | The phone's Location screen: the fallback when `turnOn` says `unavailable`. For a blocked permission, `Os.openSettings()` |
| `reverseGeocode(lat, lng, { max? })` | `{ addresses, reason }` | Places at a point, best first. `max` 1–5, default 1 |
| `geocode(query, { max? })` | `{ addresses, reason }` | Points for a name or an address |

A `Position` is RN's shape: `{ coords: { latitude, longitude, accuracy, altitude, altitudeAccuracy, heading, speed },
timestamp }`, plus `ageMs`, `provider` (`"gps"`, `"network"`, ...) and `mocked`.

**Accuracy:**
| | Waits for | Providers | Use it for |
|---|---|---|---|
| `"high"` | a fix within 25 m | GPS and network | a map pin, a delivery address |
| `"balanced"` (default) | a fix within 100 m | GPS and network | nearby stores and offers |
| `"low"` | any fix | network only (GPS if there is no network one) | the city |

Both providers start together. The network one usually answers first, in 1–3 s, within 20–100 m indoors. The GPS takes
10–60 s outdoors and often never answers indoors. At the timeout you get the best fix seen so far; only with no fix at all
is the reason `timeout`.

**Reasons:** `denied`, `blocked`, `off` (location is off in settings), `unavailable` (no provider this app may use),
`timeout`, `background` (the app was hidden), `cancelled` (your signal), `failed` (the plugin is missing or broke).

**Limits:** timeout default 10 s, at most 60 s. `maxAgeMs` default 0 (always a fresh fix). Watch interval default 5 s,
at least 1 s.

**Geocoder reasons:** `none` (nothing found), `unavailable` (the phone has no geocoder), `failed` (often no internet),
`timeout` (10 s), `invalid` (a bad point or an empty name). `postalCode` is a string.

## What to know
- **The app hidden:** a one-shot answers at once (`background`, or the best fix so far) and a watch pauses. It goes on by
  itself when the app comes back. Android gives a hidden app no fix without the background permission, which this plugin
  never asks for.
- **Approximate only** (the user picked it in the dialog): `precise` is false, the GPS is not used, and Android blurs
  every fix to about 2 km. Fine for a city, not for "stores within 1 km". Android sends such an app a new fix at most every
  10 minutes, so the first fix answers at once and may be up to 10 minutes old (`ageMs`).
- **Location off:** `turnOn()` shows Google's dialog ("The following settings should be on: Device location", **No,
  thanks** / **Turn on**), from Play services' `SettingsClient`. **Turn on** switches location on at once: `{ on: true }`.
  Reasons when it stays off: `declined` (No thanks, or closed), `unavailable` (no Play services, too old, or the setting
  can't change now: then `openSettings()` and check again on `onAppState("active")`), `busy` (another dialog of the app
  is open), `no_activity`, `lost` (the app was closed while the dialog was open: read `status()`), `failed`. It opens
  through core's launches, so its answer survives the app being killed. Call it from a tap.
- **The dialog may also turn on "Google Location Accuracy"** on some phones. That is Google's dialog; the RN app has the same.
- **The network provider** comes from Google's location service on most phones. If the user turned off "Google Location
  Accuracy", only the GPS is left: slow, and indoors nothing (`timeout`).
- **Don't** reuse `lastKnown` without looking at `ageMs`: it can be days old, from another city.
- **Don't** trust `mocked: true` fixes for anything that matters.
- **The Geocoder** needs the internet on most phones (Google does the lookup), and can be slow. Cache its answers.
- New JS (an update applied in place) stops every request of the old JS.

## React Native code
`Geolocation` has the RN names (`@react-native-community/geolocation`): `getCurrentPosition(success, error, options)`,
`watchPosition` (returns an id), `clearWatch`, `stopObserving`, `requestAuthorization`, `setRNConfiguration`. Errors have
RN's codes: 1 permission, 2 unavailable, 3 timeout. Like RN, `getCurrentPosition` asks for the permission first, unless
`setRNConfiguration({ skipPermissionRequests: true })`, and `maximumAge` defaults to any age.
Differences: the timeout is at most 60 s (RN: no limit), `watchPosition` doesn't ask for the permission (it reports
code 1), and a watch pauses while the app is hidden.

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.android.gms:play-services-location` | 21.4.0 | Only `SettingsClient`, for the turn-on dialog |
| `androidx.core` | the app's | `LocationManagerCompat`, already in every app |

The whole plugin adds about 50 KB to the sample's R8 release APK, of which the dialog is about 8 KB (compressed code).
Details in `docs/milestones.md`.
