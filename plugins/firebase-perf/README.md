# @zero-native/firebase-perf

Firebase Performance Monitoring in zero-native apps, on Android, with RN Firebase's `perf()` API. Most apps need no
JS. By itself it sends:

- **The app start** (Firebase's own trace).
- **Every `fetch`**: a network trace (time, response code, sizes) from an interceptor on core's fetch client. Firebase
  sees the URL with no query and no fragment, since those may hold tokens or personal data.
- **Every screen**: a trace per top route, `screen_<route>`, with `frames`, `frames_slow` (over 16 ms) and
  `frames_frozen` (over 700 ms). The app is one Activity, so Firebase's own screen traces would all be one screen.
- **`zn_bundle`** on every trace: the running bundle, to compare OTA bundles.

No Gradle plugin is needed (Firebase's `firebase-perf` Gradle plugin only rewrites bytecode for apps that use plain
OkHttp; zero-native's fetch already goes through the interceptor).

## Add it
1. Firebase as for [`@zero-native/firebase-app`](../firebase-app/README.md).
2. In `settings.gradle.kts`: `:plugin-firebase-perf` → `../plugins/firebase-perf/android`.
3. In the app's `build.gradle.kts`: `implementation(project(":plugin-firebase-perf"))`.
4. In `Application.onCreate`, with the other plugins, **before the first fetch**:
   ```kotlin
   ZnPlugins.register(this, PerfPlugin())
   // Your own URL rule (null: no trace for it), or no screen traces:
   ZnPlugins.register(this, PerfPlugin(url = { u -> if (u.host == "api.example.com") "${u.scheme}://${u.host}${u.encodedPath}" else null }))
   ```
   A fetch made before it (very rare) means no network traces in that process; the plugin logs one line.

**It starts at the first launch, before any consent.** From the first start it collects the app start, the screen
traces and every fetch (the URL without the query and fragment), plus device data that Firebase adds. To keep it off
until the user agrees, put this in the app's `<application>` and call `setPerformanceCollectionEnabled(true)` after the
yes (the flag is Firebase's own; this plugin does not read or change it):
`<meta-data android:name="firebase_performance_collection_enabled" android:value="false" />`.
Do this for a DPDP / consent check before real users. (Analytics also collects before consent by default, Pavan's call;
see its README.)

Permissions: none of its own (Firebase adds `INTERNET` and `ACCESS_NETWORK_STATE`). To see traces in logcat while
testing: `<meta-data android:name="firebase_performance_logcat_enabled" android:value="true" />` (the sample does).

## Use it
```ts
import { Perf } from "@zero-native/firebase-perf"

await Perf.trace("receipt_render", async (t) => {
  await t.putAttribute("kind", "pdf")
  await renderReceipt()
})

const t = await Perf.startTrace("checkout_load")
t.incrementMetric("retries")
await t.stop()
```

## API
Each call answers and never rejects. A bad name answers false with a console warning.

| Call | Answers | What it does |
|---|---|---|
| `status()` | `{ available, enabled }` | |
| `setPerformanceCollectionEnabled(on)` | true / false | Kept across starts |
| `isPerformanceCollectionEnabled` | boolean | The last value seen |
| `startTrace(name)` | `Trace` | 1–100 characters, no space at either end, not starting with `_` |
| `trace(name, fn)` | `fn`'s result | Starts, runs, stops (also when `fn` throws) |
| `Trace.putMetric(name, n)` / `incrementMetric(name, by = 1)` | true / false | Whole numbers |
| `Trace.putAttribute(name, value)` / `removeAttribute(name)` | true / false | 5 at most; names 40 characters; values cut to 100 |
| `Trace.stop()` | true / false | Sends it. A trace never stopped is never sent |

RN Firebase's names work for ported code: `perf().startTrace(...)`, `getPerformance()`. Not built: `newHttpMetric`
(every `fetch` is traced already), `newScreenTrace`.

## Do and don't
- **Do** register it before anything fetches. **Why:** core's fetch client is built once, at the first fetch.
- **Don't** put personal data in trace names, attributes or URL paths you let through. **Why:** everyone with console
  access sees them. The default URL rule drops the query; a path with a phone number in it still shows: use `url`.
- **Do** read `frames_slow` and `frames_frozen` per screen, and compare `zn_bundle` values after an OTA.
- **Know:** traces reach the console some minutes later.
- **Know:** URL **paths are kept**. An id in a path (`/orders/12345`) goes to Firebase. Only the query and fragment are
  cut. Use the `url` option to shorten such paths.
- **Know:** other plugins' fetches and the OTA check also go through the interceptor, because it sits on core's shared
  client (`ZnFetch.addInterceptor`, `docs/fetch.md` §5).

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-perf` | from the BoM (35.1.0) | Performance Monitoring |

The sample's release APK: 15.21 MB before, 15.35 MB with it (+0.14 MB, 2026-11-04).
