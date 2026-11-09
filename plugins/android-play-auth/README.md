# @zero-native/android-play-auth

Two helps for a phone number login, on Android:
- **Phone number hint:** Google's sheet that lists the phone's numbers, so the user taps one instead of typing.
- **OTP auto-read:** the SMS Retriever reads the OTP SMS for your app. It needs no SMS permission and shows no dialog.

Both are only helps. If anything fails, the user types by hand. Your screen must always work without them. Each call
answers with a value and never rejects, so a Play services failure can't crash a screen or leave a spinner running.

The plugin talks to no server. Sending the SMS, and putting the app hash in it, is your backend's job.

## Add it
In the app's `build.gradle.kts`:
```kotlin
implementation(project(":plugin-android-play-auth"))
```
In `Application.onCreate`, first thing:
```kotlin
ZnPlugins.register(this, AuthPlugin())
```
The app's Activity needs `ZnActivity.attach(this)` (`docs/guide-notes.md` §31). No permission and no manifest change.

## Use it
```ts
import { Auth } from "@zero-native/android-play-auth"

// One id for one login attempt. It must come back after a kill.
const draft = restorableSignal("draft", `login-${Date.now()}`)

const hint = await Auth.phoneHint({ draft: draft() })
if (hint.phone) sendOtp(hint.phone)
else focusPhoneField()

const otpPromise = Auth.listenForOtp({ key: phone })  // first, so an early SMS isn't missed
const hash = await Auth.appHash()
await api.sendOtp(phone, hash)
const otp = await otpPromise
if (otp.code) verify(otp.code)
```

## API
| Call | Answers | What it does |
|---|---|---|
| `Auth.phoneHint({ draft })` | `{ phone, reason }` | Opens the sheet, at most once per `draft`. `phone` is null if there is no number; `reason` says why |
| `Auth.clearPhoneHint()` | nothing | Forgets the hint: when the login ends, or the user backs out |
| `Auth.listenForOtp({ pattern?, timeoutMs?, key? })` | `{ code, reason }` | Waits for the SMS. `code` is null if none came; `reason` says why |
| `Auth.stopListening()` | nothing | Stops the listen. It answers `cancelled` |
| `Auth.appHash()` | a string | The 11-char hash for the SMS, or `""` if it can't be read |

**Hint reasons:** `cancelled`, `no_number`, `unavailable`, `already_asked`, `lost`, `busy`, `replaced`, and `no_app`,
`no_activity`, `no_storage`, `unacked`, `failed` when the sheet couldn't open. Treat them all the same: focus the field.

**OTP reasons:** `timeout`, `no_code`, `bad_pattern`, `unavailable`, `failed`, `replaced`, `cancelled`.

`pattern` is a Java regex. If it has a group, the code is group 1. The default takes the first number of exactly 4 or 6
digits. If your SMS has another number before the code, pass your own pattern. Keep it simple: it runs on the main thread.

`timeoutMs` is at most 5 minutes, the default. Play services stops there. A short value is for tests.

## What to know
- **The hint comes at most once per draft.** The mark is on disk before the sheet opens, so a screen rebuilt after a kill
  never gets the sheet back. It gets the answer of the hint that was open, or `already_asked`. Keep the draft where it
  survives a kill: `restorableSignal` for one screen, `storage` if an OTA update may land in between (a `restorableSignal`
  doesn't come back into a new bundle). A new draft is a new login, and it can ask again.
- **Ask only when it helps.** Wait about 1.5 s after the screen opens, and only ask if the field is empty. Opening a sheet
  over a user who is typing is worse than no sheet.
- **A rebuilt screen joins.** The same draft, or the same `key`, gets the same answer and starts nothing new. Without a
  `key`, a new listen answers the one before it with `replaced`.
- **For a new send of the OTP, call `stopListening()` first** (or use a new `key`). If not, the old answer comes back.
- **One listen at a time.** The receiver stops at a code, at any failure, at the timeout, on `stopListening`, on a newer
  listen, and when new JS takes over (an update applied in place, a dev reload).
- **A kill ends the listen.** The receiver only lives in a running process. Call `listenForOtp` again on the rebuilt
  screen. An SMS that came while the app was dead is lost, so the user types the code.
- **A screen closing does not end it.** A listen or a hint goes on, so a rebuilt screen can join. Call `stopListening()`
  when the user leaves the login.

## The SMS
The SMS Retriever only reads an SMS that has your app's hash in it:
```
<#> 4821 is your code. Do not share it.
FA+9qCX9VSu
```
- At most 140 bytes, and the hash on its own at the end.
- It must arrive after `listenForOtp` started, and within 5 minutes.

### The hash trap: it differs per signing key
The hash comes from the **package name and the signing key**. So the same app has a different hash for each key:
- a debug build (and each developer's debug key),
- a release build signed with your upload key,
- the build Play gives users, if you use Play App Signing: Google's key signs that one.

If the SMS carries the hash of the wrong key, nothing fails. The SMS arrives, the app isn't told, and the user sees a
timeout. So:
- Don't copy the hash from a debug build into your server. Read `Auth.appHash()` on the real build, from the same place
  users get it (an internal test track on Play), and keep one hash per key.
- Send `Auth.appHash()` to your server with the OTP request, or map it by package name on the server, as you prefer.
- A new package name, or a new key, means a new hash.

**Tested on a real phone (2026-11-06):** a real carrier SMS with the hash from `Auth.appHash()` reached
`listenForOtp`, and the code went straight into `OtpInput` with its ref's `setValue`. The login finished with no typing.
That build was a release build signed with a debug key. The Play build's hash (Google's key) is still yours to read and
add before real users.

## Limits
- Android only. On any other platform, or with no Play services (Huawei, some emulators), each call answers with a reason.
- The hint needs a SIM with a number the phone knows. A phone with none gives no sheet.
- The hint's number is what the user tapped. It proves nothing. Always verify it by OTP.
- The default pattern takes the first match. It can't tell a code from another 4 digit number in the SMS.

## Privacy and security
- An OTP is secret, and a phone number is private. The plugin never logs either, even in debug builds. Don't log them in
  your app. Don't save an OTP on disk, and don't put it in a `restorableSignal`.
- The SMS receiver is exported, because Play services is another app. It takes the broadcast only from a sender with
  Play services' permission, so no other app can feed it a fake OTP.
- The picked number is saved in the launch record (plain storage, like all launches), so it survives a kill. The plugin
  acks it as soon as JS reads it. If no screen asks again after a kill, it stays until the next `phoneHint` or
  `clearPhoneHint`.

## Size
What it adds to an APK before R8. R8 removes most of this. Measured in the sample's R8 release, 2026-11-03 (Play download with the brotli method in `docs/startup-and-performance.md` §3): the plugin and `play-services-auth` keep about 21 KB of
classes, under 15 KB of download. Play services code it shares with the scanner is about 50 KB more.

| Library | Version | Classes |
|---|---|---|
| `play-services-auth` | 21.5.0 | 178 KB |
| `play-services-auth-api-phone` | 18.0.2 | 30 KB |
| `play-services-auth-base` | 18.0.10 | 313 KB |
| `play-services-base` | 18.5.0 | 1,098 KB |
| `play-services-basement` | 18.9.0 | 389 KB |
| `play-services-fido` | 20.0.1 | 278 KB |
| `play-services-tasks` | 18.2.0 | 88 KB |
| `androidx.fragment` | 1.5.7 | 338 KB (AAR) |

Only the first two are direct. The rest come with them, and an app that uses other Google libraries has most of them
already.

## Tests
- `bun test plugins/android-play-auth`: the JS side.
- `gradlew :plugin-android-play-auth:testDebugUnitTest`: the rules apart from Android (`AuthRules.kt`).
- `bun run tools/plugin-phone.ts auth`: on a phone, with the lab screen `examples/sample/src/AuthLab.tsx`.
