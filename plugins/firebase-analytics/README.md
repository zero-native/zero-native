# @zeronative/firebase-analytics

Google Analytics for Firebase in zero-native apps, on Android, with RN Firebase's `analytics()` API.

- **On from the first start**, as in RN Firebase: adding the plugin is the app's choice, and the app declares it in
  Play's data safety form. The usual off switches are there: `setAnalyticsCollectionEnabled(false)` (when the user
  opts out; Firebase keeps it across starts) and consent mode (`setConsent`).
- **Screen views by themselves**, one `screen_view` per top route, named after the route (`home`, `amount`). The app is
  one Activity, so Firebase's own screen views (which would all say "MainActivity") are turned off.
- **`zn_bundle` on every event**: the running bundle (`sample_12@1a2b3c4d5e6f`), to compare OTA bundles.
- **No advertising id** (`google_analytics_adid_collection_enabled=false`).
- **Names checked before Firebase sees them.** A bad event or parameter name answers `false` with a console warning
  that says why. Firebase itself would drop it with only a logcat line.

## Add it
1. Firebase as for [`@zeronative/firebase-app`](../firebase-app/README.md): `google-services.json`,
   `:plugin-firebase-app` in `settings.gradle.kts`, and its `firebase.gradle.kts` at the end of the app's
   `build.gradle.kts`.
2. In `settings.gradle.kts`: `:plugin-firebase-analytics` → `../plugins/firebase-analytics/android`.
3. In the app's `build.gradle.kts`: `implementation(project(":plugin-firebase-analytics"))`.
4. In `Application.onCreate`, with the other plugins:
   ```kotlin
   ZnPlugins.register(this, AnalyticsPlugin())
   // Rename routes or leave some out (null), or no screen views at all:
   ZnPlugins.register(this, AnalyticsPlugin(screenName = { route -> if (route.startsWith("dev")) null else route }))
   ```
5. If the app shows no ads, take Play services' advertising id permissions out, in the app's manifest
   (`xmlns:tools="http://schemas.android.com/tools"` on `<manifest>`):
   ```xml
   <uses-permission android:name="com.google.android.gms.permission.AD_ID" tools:node="remove" />
   <uses-permission android:name="android.permission.ACCESS_ADSERVICES_AD_ID" tools:node="remove" />
   <uses-permission android:name="android.permission.ACCESS_ADSERVICES_ATTRIBUTION" tools:node="remove" />
   ```
   The plugin can't do this for you: only the app's manifest can remove what a library adds. The sample does it.

With no `google-services.json`, Firebase doesn't start: `status()` says `available: false`, and every call does
nothing. Permissions: `INTERNET`, `ACCESS_NETWORK_STATE`, `WAKE_LOCK` (Firebase's own needs).

To have it off until the user agrees (a consent step first), put this in the app's `<application>`, then call
`setAnalyticsCollectionEnabled(true)` after the yes:
`<meta-data android:name="firebase_analytics_collection_enabled" android:value="false" />`.
Only the manifest can stop the first start's events (`first_open`, `session_start`): Firebase starts before JS.

## Use it
```ts
import { Analytics } from "@zeronative/firebase-analytics"

// The user said yes:
await Analytics.setAnalyticsCollectionEnabled(true)
await Analytics.setConsent({ analytics_storage: true, ad_storage: false, ad_user_data: false, ad_personalization: false })

// After login: your own id (a customer code). On logout: null.
Analytics.setUserId(customer.code)
Analytics.setUserProperty("plan", "free")

Analytics.logEvent("pay_tapped", { amount: 499, method: "upi" })
Analytics.logPurchase({ value: 499, currency: "INR", transaction_id: txn.id, items: [{ item_id: "sku1", price: 499, quantity: 1 }] })
```

## API
Each call answers and never rejects.

| Call | Answers | What it does |
|---|---|---|
| `status()` | `{ available }` | Firebase is set up |
| `setAnalyticsCollectionEnabled(on)` | true / false | On or off, kept across starts. Starts on |
| `setConsent({ analytics_storage, ad_storage, ad_user_data, ad_personalization })` | true / false | Consent mode. Keys left out stay as they are |
| `logEvent(name, params?)` | true / false | Name: letters, digits, `_`, 40 characters, starts with a letter. 25 parameters at most |
| `logScreenView({ screen_name, screen_class? })` | true / false | A screen view of your own (parts of a screen, or with `screenViews = false`) |
| `setUserId(id)` | true / false | `null` or `""` clears it |
| `setUserProperty(name, value)` / `setUserProperties({ ... })` | true / false | Name 24 characters, value cut to 36. `null` clears |
| `setDefaultEventParameters(params)` | true / false | On every later event; `null` clears (the plugin's `zn_bundle` stays) |
| `getAppInstanceId()` | string / null | Analytics' id for this install |
| `resetAnalyticsData()` | true / false | Clears this install's data on the phone, new instance id |
| `setSessionTimeoutDuration(ms)` | true / false | Default 30 minutes |
| `logLogin`, `logSignUp`, `logSearch`, `logShare`, `logSelectContent`, `logViewItem`, `logViewItemList`, `logSelectItem`, `logAddToCart`, `logRemoveFromCart`, `logViewCart`, `logBeginCheckout`, `logAddPaymentInfo`, `logPurchase`, `logRefund`, `logViewPromotion`, `logSelectPromotion`, `logEarnVirtualCurrency`, `logSpendVirtualCurrency`, `logTutorialBegin`, `logTutorialComplete`, `logAppOpen` | true / false | Google's recommended events, `logEvent("<name>", params)` |

Parameter values: strings (cut to 100 characters), numbers, booleans (sent as 1 or 0: Analytics has no booleans).
Only `items` can be a list, of objects with the same rules.

RN Firebase's names work for ported code: `analytics().logEvent(...)`, `getAnalytics()`. Differences: calls answer
`true` / `false` instead of `void`; `isAnalyticsCollectionEnabled` doesn't exist (Firebase has no way to read it).

## Do and don't
- **Do** give users a way to opt out, and call `setAnalyticsCollectionEnabled(false)` when they do. **Why:** India's
  DPDP Act and Play's data safety form expect it; Firebase keeps the setting, so call it once, not on every start.
- **Do** list Analytics in Play's data safety form. **Know:** an app that needs consent before any data (some
  markets) turns it off in the manifest (above).
- **Do** use your own id in `setUserId` (a customer code). **Don't** put a phone number, an email, a VPA or an amount
  tied to a person in the id, a property or a parameter. **Why:** Google's terms forbid personal data in Analytics,
  and everyone with console access sees it.
- **Do** name routes well: they are the screen names in the console. Use `screenName` to rename or leave out dev
  screens.
- **Don't** call `logScreenView` for whole screens. **Why:** the plugin sends one per route already; both together
  count every screen twice.
- **Know:** events reach the console in batches, about an hour later. To see them at once, turn on debug mode for
  the app and open DebugView:
  ```bash
  adb shell setprop debug.firebase.analytics.app dev.zeronative.sample
  ```

## Size
| Dependency | Version | Why |
|---|---|---|
| `com.google.firebase:firebase-analytics` | from the BoM (35.1.0 → 24.0.0) | Google Analytics for Firebase |

The sample's release APK (R8, arm64, with Crashlytics and FCM already in) grew by **0.44 MB** (14.71 → 15.16 MB),
the lab screen included. Measured 2026-11-04.
