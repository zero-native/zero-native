# @zeronative/android-ad-id

The Google advertising id, for ad attribution. An opt-in plugin: only apps that add it get Google's library and the
`AD_ID` permission.

```ts
import { AdId } from "@zeronative/android-ad-id"

const { id, limitAdTracking } = await AdId.get()
if (id !== null) attribution.setAdId(id, { limitAdTracking })
```

## What it answers
`AdId.get()` answers `{ id: string | null, limitAdTracking: boolean }`. It **never rejects**.

| Phone | `id` | `limitAdTracking` |
|---|---|---|
| Play services, ads personalisation on | the id | `false` |
| Ads personalisation off, Android 11 and older (the id is still given) | the id | `true` |
| The user deleted the id (Android 12+: all zeros) | `null` | `true` |
| The app has no `AD_ID` permission (Android 13+: all zeros) | `null` | `true` |
| No Play services (Huawei, some cheap phones), Play services fails or updates | `null` | `false` |
| An APK without this plugin | `null` | `false` |

- **`limitAdTracking` true with an id: the app decides, and must follow Play's rules.** The user said no to
  personalised ads. You may still use the id for attribution and analytics, not to build an ad profile of the user
  or to show them personalised ads. Send the flag with the id to your attribution partner.
- **Read it each time you need it.** The user can delete or reset the id at any time. Don't keep it in storage.
- It takes a few ms to ~0.5 s (a call into Play services; slower on the first call after boot). It runs on its own
  thread, never on the main thread and never holding up other modules' calls.

## Play's rules (Google Play's advertising id policy)
- Use it **only for ads and user analytics** (ad attribution is one). Not to identify a user, not for fraud checks.
- **Never link it** to personal data (phone number, email, name) or to a device id (ANDROID_ID, IMEI) without the
  user's clear consent.
- A reset gives a new id: never connect the old and the new one.
- Declare it in Play Console: the advertising id question and the Data safety form.

## Add it
1. In `settings.gradle.kts`: `:plugin-android-ad-id` → `../plugins/android-ad-id/android`.
2. In the app's `build.gradle.kts`: `implementation(project(":plugin-android-ad-id"))`.
3. In `Application.onCreate`, with the other plugins: `ZnPlugins.register(this, AdIdPlugin())`.
4. In the app's `package.json`: `"@zeronative/android-ad-id": "workspace:*"`.

**Permission:** Google's library (`play-services-ads-identifier` 18.0.0, the same one Firebase Analytics brings) adds
`com.google.android.gms.permission.AD_ID` to the app's manifest. Make sure the app's own manifest doesn't remove it
(`tools:node="remove"`): then Android 13+ gives zeros and `id` is always null. The zero-native sample removes it on
purpose (analytics with no ads), so its lab shows `ad id none`.
