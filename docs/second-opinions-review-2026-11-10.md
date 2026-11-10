# Review of the framework second opinions (Fable 5.2, 2026-11-10)

A second look at entries 8 to 223 of [second-opinions.md](second-opinions.md). The question for each one: is the choice
right for a payments app with many Android users on low-end phones?

**Result:** 208 entries read. 4 "change", 9 "concern", 195 "keep" (some keeps carry a note or a check to run). Every
entry has its own **Reviewed** line in the doc.

**How deep the review went (read this first):**
- **Code read, line by line:** the OTA client (`ZnOta.kt`), the launch gate (`ZnOtaGate.kt`), patches (`ZnBsPatch.kt`,
  `ZnOtaInstall.kt`), the store answer (`ZnOtaStore.kt`, `AppUpdatesLaunch.kt`, `AppUpdatesRules.kt`), fetch
  (`ZnFetch.kt`), the splash hold (`ZnSplash.kt`), the server's check, decision and serial code (`server/src/phone.ts`,
  `model.ts`, `tools/ota/decide.ts`).
- **Code read in part:** `ZnOtaHealth.exitOf`, `ZnSecureStore` (rules, read, key), the call pool in `ZnModules.kt`,
  `jni_bridge.cpp` and `core/src` (only for 32-bit problems).
- **Entry text only, no code read:** everything else (UI, compiler, SVG, motion, plugins: about 170 entries). A "keep"
  there means "the reasoning holds", not "I checked the code".
- **Nothing was run.** No phone, no emulator, no tests. Every finding below comes from reading. What I say about
  Android's Keystore on old phones (152) comes from what I know of Android's source and field reports, not from a test.

---

## 1. Where I disagree, or see a real risk (worst first)

### 1.1 [#218](second-opinions.md:3482) 32-bit ARM is shipped but never run. **Blocks the Play release until the run passes.**
- **Risk:** the phones that get the 32-bit build are the cheapest ones. A native problem there is a crash at start for
  exactly those users, and RN never ran there, so there is no earlier data.
- **What I found:** nothing wrong in the code. On-disk formats use fixed-size numbers (`storage.cpp`, `flowstore.cpp`),
  the runtime pointer in a `jlong` is fine, files are far below 2 GB. So I expect it to work.
- **Do:** `adb install --abi armeabi-v7a` on the Lava; run the full sample steps, then a ZeroBill login and a payment
  with a kill in the UPI app. Turn on Crashlytics NDK for ZeroBill (see 1.12), so a 32-bit crash has a stack.
- **Evidence that settles it:** that run passing. Then Play vitals split by ABI in a staged rollout.

### 1.2 [#223](second-opinions.md:3569) A Play build can ship with a serial that was only looked at. **Check before the Play upload; the guard itself is small.**
- **Risk:** `updates builtin` gives a production build the next free serial without taking it, and only prints a hint
  to use `store-build`. If that build goes to Play with #N, and an OTA bundle later takes #N with other bytes, every
  phone on that build skips that OTA for good, with no error: the server answers `APK_NEWER`
  (`decide.ts`: `req.builtIn.serial >= target.serial`) and the phone has the same rule (`m.serial <= builtIn.serial`).
  A critical fix published as #N would not reach them.
- **Change:** one of these. (a) Write "taken: false" beside the built-in bundle, and make the release Gradle task
  refuse it for a production build. (b) In `decide.ts` and on the phone, count an equal serial as "the APK is newer"
  only when the SHA-256 is the same. (a) needs no new APK logic and is enough.
- **Evidence:** the build log of the AAB that goes to Play shows `store-build`, and the server's store builds list has
  its serial and SHA-256.

### 1.3 [#152](second-opinions.md:2484) SecureStore can still delete good values on old phones. **Does not block; fix soon after.**
- **Risk:** a silent logout (and whatever the app wipes at logout) for a user who did nothing. This is the harm the
  entry set out to stop.
- **Case 1:** `UnrecoverableKeyException` is in `lostForGood`. Below Android 13 the Keystore wraps every failure to
  load a key in that exception ("Failed to obtain information about key"), also passing ones. The three tries in a
  row can all fail while the Keystore is busy. The value is then deleted.
- **Case 2:** on a save, `secretKey(create = true)` makes a new key whenever `getEntry` answers null. A null is not an
  error, so the "known passing error" rule never sees it. If the null came from a passing failure, the new key
  replaces the old one and every other stored value becomes unreadable (bad tag → deleted on its next read).
- **Change:** treat `UnrecoverableKeyException` as `temporarily_unavailable` unless its cause says the key is missing
  or its blob is invalid. Before making a new key while value files exist: wait, try again, then reject the save.
- **Evidence:** counts of `temporarily_unavailable` and of "reads as missing" per Android version and phone maker from
  the first weeks. If "reads as missing" shows up on Android 7 to 12 in clusters after boot or an app update, it is this.

### 1.4 [#217](second-opinions.md:3467) Failed checks push serious outcomes out of the queue. **Does not block; small fix.**
- **Risk:** every failed check stores an outcome (`runCheck`'s catch), and only the last 20 are kept (`MAX_OUTCOMES`,
  `saveState`). ZeroBill checks on every return with no floor. A phone that is offline, or behind a bad network, for
  20 returns loses its `launch_crashed`, `error_rollback` and `watchdog_block` outcomes before they reach the server.
  Those are the numbers the watchdog limits (entries 1 to 3) are to be tuned from, and bad-network phones are the
  ones most likely to have trouble.
- **Change:** keep one counted outcome for failed checks (or store none for plain network failures), and never drop a
  serious outcome to make room for a plain one.
- **Also check:** server load. Every return of every phone is one `/v1/check`, with two database writes
  (`recordCheck`, `learnCapabilities`).
- **Evidence:** a unit test: 25 failed checks after a `launch_crashed`; the outcome must still be sent.

### 1.5 [#214](second-opinions.md:3421) The launch gate: three things to check. **Check before the first high or critical update.**
- **(a) Start cost.** The check now starts at process start. Its JSON, state file and TLS handshake run next to the JS
  start on a slow phone. The older rule (`firstCheckDelayMs`) was "never in the way of startup". Measure first frame
  on the Lava on 4G: gate on, and `launchDecisionMs = 0`.
- **(b) Slow networks pay at every cold start.** Up to ~0.5 s, for the users with the worst network, for an update that
  is rare. Send the gate's wait time with the outcomes, so the real spread is known. If it is often near 800 ms, lower it.
- **(c) A swap during start work.** The entry notes that JS start work can run twice. The harder case: the old
  runtime is replaced while one of its start calls is in flight. If that call is a refresh-token call and the server
  rotates the token, the new token is answered into a runtime that is gone, and the user may be logged out.
  `Updates.holdApply()` covers payments, not start calls.
- **Evidence:** the two start-time numbers; a list of ZeroBill's calls at start that are not safe to lose.

### 1.6 [#221](second-opinions.md:3535) The shared call pool still has 2 threads for everything but fetch. **Does not block.**
- **Risk:** SecureStore, Storage and every plugin share it. Two slow calls (a geocode waits up to 10 s; a Keystore read
  retries with sleeps) hold up a token read or a save in the middle of a payment.
- **Why I disagree with "no bigger pool":** the reason given was that it hides a blocking module. The watch
  (`ZnSlowCalls`) now shows such a module, so that reason is weaker.
- **Change:** give the core storage modules their own thread, as fetch got, or raise the pool to 4. Send `ZnSlowCalls`
  to `onReport`, so it shows in Crashlytics and not only in logcat.
- **Evidence:** `ZnSlowCalls` lines from staging phones.

### 1.7 [#219](second-opinions.md:3498) Forced store update at launch. **Blocks using a forced rule, not the release.**
- **Not tested on a phone**, as the entry says.
- **Play is asked at every cold start** (`AppUpdatesLaunch.onLaunch`), also when no forced rule exists. That wakes the
  Play Store process during our start on low-RAM phones. Measure cold start with and without the launcher; if it
  costs, ask Play only when the saved or the fresh answer is forced.
- **A saved forced answer opens Play's screen before the fresh answer comes.** So a rule that was taken back still
  shows once per phone. Small harm; know it.

### 1.8 [#106](second-opinions.md:1421) FlowStore's "can't fail" save was tested on ext4 only. **Does not block; one test.**
- **Risk:** a SIGBUS in the middle of the "in-upi" save on a full disk. Most low-end phones use f2fs for app data; the
  f2fs part of the entry is reasoned, not tested. I think the reasoning is right.
- **Do:** fill the Lava's disk for real, then: the first save of a new key answers false, a second save of an existing
  key works, no crash.

### 1.9 [#120](second-opinions.md:1726) The OTA "check now" push to all phones. **Does not block; don't send to all yet.**
- **Risk:** one topic message makes every online phone call `/v1/check` within seconds.
- **Change:** a way to send in waves (for example a topic per group of rollout buckets), and a load test first.

### 1.10 [#47](second-opinions.md:579) A link closes the screens above its target. **Does not block; check ZeroBill's `onLink`.**
- **Risk:** a link (a notification tap) during a payment closes the payment screen, unless the app's `onLink` refuses.
- **Change I would make:** core refuses the stack change by itself while a launch waits for its result or updates are
  held. One forgotten check in an app should not close a payment.

### 1.11 [#36](second-opinions.md:415) DuraSpeed: fixed in our test tools, open for users. **Does not block (RN has the same).**
- **Do:** on the Lava, Force stop in Settings, open the app from a notification, then load a WebView and send a push.

### 1.12 [#92](second-opinions.md:1213) Crashlytics NDK is opt-in. **Not a framework change; ZeroBill should turn it on.**
- zn's C++ and Hermes run in every start, and 32-bit ARM is new. Without it a native crash is only a count.

### 1.13 Known and parked: [#184](second-opinions.md:3017) and [#193](second-opinions.md:3118). **Do not block.**
- **184:** the 3-button case is not fixed and Android 16 is not tested. The safe choice for the first Play release is
  to turn predictive back off in the ZeroBill manifest (one line) and turn it on again with the fix.
- **193:** looks only. The proposed one-frame pre-build is the right fix.

### 1.14 [#10](second-opinions.md:174) A skipped plugin is only a logcat line. **Does not block.**
- Send it to `onReport`, so a failure on one phone model shows up before users fail at checkout.

---

## 2. Kept, with a note

Small points; none blocks anything. The full text is on each entry.

- [#8](second-opinions.md:149): use `BOOT_COUNT` and ask for the exit record by pid.
- [#135](second-opinions.md:2018), [#147](second-opinions.md:2358): ZeroBill must treat Markdown links and FCM tap
  data as outside input.
- [#161](second-opinions.md:2650): close sockets in the background (10 s pings cost battery).
- [#210](second-opinions.md:3358): measure the first-use font load on the Lava.
- [#213](second-opinions.md:3410), [#215](second-opinions.md:3439), [#216](second-opinions.md:3453),
  [#222](second-opinions.md:3555): the release-critical ones I read in code and keep as they are.
- Questions the entries asked the reviewer: 174 ("lands close" is good enough), 180 (yes, fail the build on a bad
  colour literal), 181 (leave List rows as they are).

## 3. Kept as they are

9, 11–35, 37–46, 48–91, 93–105, 107–109, 111–119, 121–134, 136–146, 148–151, 153–160, 162–164, 171–183, 185–192,
194, 196–209, 211, 212, 220 (without the numbers named in sections 1 and 2).

Two I want to name as good calls: 31 (an OTP is never on disk) and 104 (a handler written as a call is made once: it
removes a double `/pay` risk). 176 (soft core modules) is also right, and its rule for later should be followed strictly.

## 4. Where I stopped

- All 208 entries from 8 to 223 have a Reviewed line. No entry was skipped as "ZeroBill only": for 218 and 219 only
  the framework part was judged.
- The depth is uneven, as said at the top. If more review time is spent, the next best use is a code read of:
  `ZnLaunch.kt` (entries 11, 12, 156), `ZnSecureStore.kt` in full (152), `flowstore.cpp` (106) and `ZnOtaHealth.kt`
  in full (8, and the reviewed entries 1 to 3).
- Not looked at: iOS code, the dashboard, anything in the ZeroBill app repo.
