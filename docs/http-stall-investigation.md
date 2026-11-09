# Investigation: all HTTP calls stuck until the app is swiped away (2026-11-09)

**Report:** in the ZeroBill zn app (`my-app`), HTTP calls sometimes get stuck all at once, across the
whole app, until the user swipes the app away and opens it again (a new process). Seems to come after a Play Store
update, or on coming back from a UPI app after a while in the background. No logs, can't be made to happen on purpose.

**Short answer:** the most likely cause is not the network stack (OkHttp) at all. Every native call from JS, `fetch`
too, is first run on **one shared pool of 2 threads** (`ZnModules.io`). ZeroBill's in-app-update plugin asks Play for
update info with `Tasks.await(...)` **with no time limit, on that pool**. If Play doesn't answer, that thread waits
forever. Two such waits (or one plus any other slow native call) and **no native call can start**: no `fetch`, no
`Os.info`, nothing. The UI keeps working (taps and screens don't use the pool). Only a new process frees the threads.
The pool part is reproduced on the emulator; the "Play never answers" part is reasoned, not seen.

Status (2026-11-09, later): fixes 1-4 of section 3 are built and checked on the emulator, waiting for Pavan's review
before commit (section 5). Fixes 5 and 6 are not done.

## 1. Findings

Each item: what, where, how it gives an app-wide stall, and how sure I am. "Framework" = zero-native, "ZeroBill" =
the app repo.

### F1. One 2-thread pool runs every native call, `fetch` included (framework, root of the stall). Reproduced.
- [ZnModules.kt:153](../android/runtime/src/main/java/dev/zeronative/runtime/ZnModules.kt:153):
  `Executors.newFixedThreadPool(2)`; [ZnModules.kt:257](../android/runtime/src/main/java/dev/zeronative/runtime/ZnModules.kt:257):
  every module function that isn't `onMain` goes there. `Fetch.send` is one of them
  ([ZnFetch.kt:324](../android/runtime/src/main/java/dev/zeronative/runtime/ZnFetch.kt:324)). Its own work is quick
  (build the request, `enqueue`), but it must first get a pool thread.
- If both threads are busy in calls that don't return, every later native call waits in the pool's queue. Nothing
  times out: OkHttp's call timeout is set in `send` ([ZnFetch.kt:365](../android/runtime/src/main/java/dev/zeronative/runtime/ZnFetch.kt:365)),
  so it only starts once `send` runs. The JS side has no timer of its own either (core `fetch.ts` passes `timeout` to
  native and waits).
- So the whole app's networking "pauses", while the UI works. A new process gets new threads. This matches Pavan's
  words ("as if it pauses the networking stack").
- The framework already knew the rule in one place: the AdId plugin runs its Play services call on its own thread
  because "on the shared call pool (2 threads) it would hold up other modules' calls"
  ([AdIdPlugin.kt:28](../plugins/android-ad-id/android/src/main/java/dev/zeronative/plugins/android/adid/AdIdPlugin.kt:28)).
  Nothing enforces it, and nothing logs a call that holds a thread too long.

### F2. ZeroBill's `InAppUpdate.isUpdateAvailable` blocks a pool thread with no time limit (ZeroBill). Reasoned.
- [InAppUpdatePlugin.kt:53](<apps>/my-app/plugins/in-app-update/android/src/main/java/com/example/app/inappupdate/InAppUpdatePlugin.kt:53)
  runs on the pool and calls `helper.isUpdateAvailable()`, which does
  `Tasks.await(appUpdateManager.appUpdateInfo)` with **no timeout**
  ([InAppUpdateHelper.kt:190](<apps>/my-app/plugins/in-app-update/android/src/main/java/com/example/app/inappupdate/InAppUpdateHelper.kt:190)).
  If Play's task never completes, the thread is gone for the life of the process.
- When it is called: only when the store answer (from zn's OTA check) says a newer Play build exists for this phone
  (`critical` 1 or 2), after `sessionReady`
  ([appUpdate.ts:193](<apps>/my-app/src/system/appUpdate.ts:193)). ZeroBill checks on every
  return to the app (`checkIntervalMs = 0`,
  [MyApp.kt:89](<apps>/my-app/android/app/src/main/java/com/example/app/MyApp.kt:89)).
  That fits "after a Play Store update" if it means "after a new Play build was released" (a phone on the old build
  then gets `critical > 0` and asks Play), and "coming back from the UPI app" (a return = a check).
- One JS runtime asks only once at a time (`running` guard,
  [appUpdate.ts:164](<apps>/my-app/src/system/appUpdate.ts:164)), so one stuck call holds
  one thread. The second thread goes when the JS runtime is replaced **in the same process** and asks again: an OTA
  apply, or a reopen from the launcher after Back closed the Activity (`ZnNav.startFresh`). `resetForReload` cancels the
  old runtime's calls, but a cancel can't wake a thread inside `Tasks.await`. Or the second thread is held for a while
  by any other slow call (see F5), which then stalls everything for that long.
- Not proven: that Play's `getAppUpdateInfo()` task can hang for good. I found no public report that confirms it (a
  quick web search found only stale-answer and "listener never called" reports). Play Core binds to the Play Store's
  service; a bind that never connects would leave the task open. The code is wrong either way: a Play answer that
  takes 20 s stalls every fetch for 20 s.
- Side effect even without the pool: while that call hangs, `running` stays true, so this process never checks for an
  app update again.
- The same code is in zero-native's own `app-updates` plugin
  ([AppUpdatesHelper.kt:177](../plugins/app-updates/android/src/main/java/dev/zeronative/plugins/appupdates/AppUpdatesHelper.kt:177),
  [AppUpdatesPlugin.kt:69](../plugins/app-updates/android/src/main/java/dev/zeronative/plugins/appupdates/AppUpdatesPlugin.kt:69)).
  ZeroBill doesn't use it; the sample does.

### F3. Every ZeroBill request first waits for `sessionReady`, with no time limit (ZeroBill). Reasoned.
- [services.ts:205](<apps>/my-app/app/src/services.ts:205): `sessionReady` waits for
  `Os.info()` (a native call, [services.ts:155](<apps>/my-app/app/src/services.ts:155)),
  the legacy-data move, the old SecureStore token move (native calls) and `initAuth`. Each client method does
  `await sessionReady` before anything else ([services.ts:250](<apps>/my-app/app/src/services.ts:250)
  and the next four). The request's own 15 s abort timer starts only after that
  ([client.ts:309](<apps>/my-app/src/net/client.ts:309)).
- So if any of those native calls never answers in a new process (for example the pool is already full, F1+F2 after an
  in-process JS restart), **every API call waits forever with no error and no log**: exactly "stuck until swipe-off".
  If the pool is free, these calls take milliseconds, so this is a multiplier of F1, not a cause on its own.
- When the pool is full but `sessionReady` had already settled, ZeroBill's requests don't hang forever: the 15 s abort
  fires (shown in the repro: an `AbortSignal` still works while the pool is full) and the user sees timeouts on every
  screen, again until a new process.

### F4. `fetch`'s `timeout` doesn't cover the wait for a pool thread (framework). Reproduced.
- `timeout` is documented as "the limit for the whole request" (core `fetch.ts`, docs/fetch.md). Measured: with both
  pool threads held for 6 s, `fetch(url, { timeout: 2000 })` waited 5.7 s and then **succeeded**. Apps that rely on
  `timeout` alone (no `AbortSignal`) can wait forever while the pool is full.

### F5. Other pool users that can hold a thread for a while (framework). Reasoned, bounded.
- `Location.reverseGeocode` / `geocode` wait up to 10 s on the pool
  ([LocationModule.kt:123](../plugins/location/android/src/main/java/dev/zeronative/plugins/location/LocationModule.kt:123),
  [LocationModule.kt:535](../plugins/location/android/src/main/java/dev/zeronative/plugins/location/LocationModule.kt:535));
  on Android 12 and older it is the platform's blocking geocoder, with no limit of ours. With one thread already lost
  (F2), one geocode stops every fetch for up to 10 s.
- `SecureStore` holds one lock across Keystore calls and sleeps between retries
  ([ZnSecureStore.kt:50](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSecureStore.kt:50),
  [ZnSecureStore.kt:173](../android/runtime/src/main/java/dev/zeronative/runtime/ZnSecureStore.kt:173)). A Keystore call that
  hangs would hold the lock, and a second SecureStore call would wait on the lock with the other pool thread. ZeroBill
  now reads tokens from plain storage and touches SecureStore only for the one-time move, so this is a low risk there.
- Checked and fine (they hand off to their own thread or a listener): AdId, Media, Pdf download, Installations, FCM
  token, InstallReferrer, OTA check / download (own `zn-ota` thread, time limits), Updates.check.

### Suspects from the brief that are not the cause
- **A dead HTTP/2 connection after background / Doze / a UPI app:** handled. A ping every 10 s drops a connection
  that stops answering and fails its calls; the next call opens a new one (`ZnFetchPingTest`, PAY-5). That gives
  errors for 10-20 s, not a stall until restart.
- **Client or pool swapped on a network change:** new calls get the new client; `derived` clients are built again
  (OTA, PDF, images, no-redirect). Calls already running finish on the old client by their own timeout or ping
  (second-opinions 215). No stale reference found in ZeroBill (it has no native client of its own) or the plugins it uses.
- **Dispatcher limit:** it is 10 per host here (not OkHttp's 5), and every call ends: the 30 s default call timeout,
  60 s idle limit for `timeout: 0`, 30 s read limit for images, and ZeroBill's own 15 s abort. A queued call waits only
  while the slots are busy. Note: OkHttp's call timeout also starts only when the dispatcher runs the call, not while it
  is queued (same shape as F4); ZeroBill's JS abort covers that.
- **Interceptors that never return:** ZeroBill adds none; `firebase-perf` (the only plugin that adds one) isn't used.
- **A JS promise that never settles when the native call fails or is cancelled:** `fetch`, `Os` and `SecureStore` are
  "unowned" calls, so a closing screen doesn't drop them; a native failure always rejects. The open risk is F3.
- **An app update over a running build:** `adb install -r` (and a Play update) kills the old process, so the old
  process's sockets and threads can't carry over. A stall "right after an update" is a stall in a fresh process, which
  points at start-time waits (F3) or at the Play check (F2), not at old connections.

## 2. Reproduction

Tools (committed): [CallPoolLab.tsx](../examples/sample/src/CallPoolLab.tsx) (sample routes `/dev/call-pool` and
`/dev/net-loop`) and [tools/repro/http-stall.ts](../tools/repro/http-stall.ts). The sample's `Device.slowEcho` blocks
one pool thread for a given time, standing in for a Play call that doesn't answer.

```
bun run examples/sample/build.ts            # then build and install the sample debug APK
bun run tools/repro/http-stall.ts pool       # emulator-5554 by default; --serial for another device
bun run tools/repro/http-stall.ts net --apk C:/work/zero-native/android/sample/build/outputs/apk/debug/sample-debug.apk
```

### Pool (emulator, Android 13, sample debug build, 2026-11-09)

| case | result |
|---|---|
| baseline fetch | HTTP 200 after 53 ms |
| 1 thread held 6 s, fetch | HTTP 200 after 8 ms |
| **2 threads held 6 s, fetch** | **HTTP 200 after 5737 ms** (waited for a thread) |
| 2 threads held, `Device.info` (any native call) | answered after 5712 ms |
| **2 threads held, `fetch({ timeout: 2000 })`** | **HTTP 200 after 5735 ms** (the timeout never fired) |
| 2 threads held, `fetch({ signal: AbortSignal.timeout(2000) })` | TimeoutError after 2002 ms |

With a hold that never ends (a Play task that never completes), the third and fifth rows never finish.

After fix 3 (fetch on its own thread), same run, same emulator:

| case | before | after |
|---|---|---|
| 2 threads held 6 s, fetch | 5737 ms | **15 ms** |
| 2 threads held, `Device.info` | 5712 ms | 5701 ms (still on the pool, as expected) |
| 2 threads held, `fetch({ timeout: 2000 })` | 5735 ms, timeout never fired | **19 ms** |
| 2 threads held, `fetch` with `AbortSignal.timeout(2000)` | TimeoutError at 2002 ms | **16 ms**, answered |

And the watch (fix 4) logged each hold, for example
`W/zn: native call Device.slowEcho has held a call thread for 5009 ms, and 1 other native calls wait for a thread...`
and `... gave its call thread back after 6019 ms`.

### Network changes (emulator)

A fetch every 3 s to `https://www.gstatic.com/generate_204` (HTTP/2) and to the local server (through `adb reverse`),
each one on its own, while the script changed the network. Emulator Android 13 (it has Wi-Fi and mobile data, so
turning one off is a Wi-Fi ↔ mobile switch), sample debug build, 2026-11-09.

| phase | ok | failed | slowest | first OK after the phase began |
|---|---|---|---|---|
| start, app in front | 10 | 0 | 839 ms | 0.1 s |
| mobile data off | 12 | 0 | 39 ms | 0.1 s |
| mobile data on | 12 | 0 | 30 ms | 2.9 s (next tick) |
| Wi-Fi off | 10 | 0 | 362 ms | 1.0 s |
| Wi-Fi on | 18 | 0 | 815 ms | 0.8 s |
| background (Home) 60 s | 40 | 0 | 58 ms | 2.8 s |
| back in front | 10 | 0 | 38 ms | 2.7 s |
| Doze (`deviceidle force-idle`) 60 s, in background | 2 | 27 | 30 008 ms | (2 just before Doze began) |
| Doze off, back in front | 20 | 5 | 18 804 ms | 0.6 s |
| `adb install -r` over the running app, then open | 10 | 0 | 516 ms | 8.3 s (new process starting) |

- In Doze the app has no network, so calls failed by their limits: local ones at 15 s (connect limit), gstatic ones at
  18-30 s (call timeout). None hung.
- After Doze ended, new calls answered in under 100 ms within 1 s. The calls started during Doze either answered late
  or failed at their limit; 7 s later nothing was left open. **No lasting stall in any phase.**
- Not covered by the emulator: a MediaTek phone (DuraSpeed), a real carrier network and its NAT, a UPI app in front for
  minutes, Play's update service. Those are the parts I could only reason about.

## 3. Fix plan (for Pavan's approval; nothing done)

Ordered by what to do first. "Blocks the release?" is my view.

1. **ZeroBill: make `isUpdateAvailable` never block a pool thread** (blocks the release: yes, small).
   Use `appUpdateManager.appUpdateInfo.addOnCompleteListener { ... }` and resolve from the listener, plus a 10 s
   main-thread timer that resolves `{ false, 0 }` if Play hasn't answered (the first answer wins, as InstallReferrer
   does). JS: also race `play.isAvailable()` with a 15 s timer in `appUpdate.ts`, so `running` can't stay true forever.
   Risk: low. A late Play answer is ignored (same as "no update" now, asked again on the next return). The forced-update
   path at launch (`InAppUpdateLaunch`) already uses listeners.
2. **zero-native app-updates plugin: same fix** (doesn't block ZeroBill; do it with 1 so the sample and docs match).
3. **zero-native: `fetch` must not wait behind other modules** (blocks the release: I'd say yes, because ZeroBill's
   payment calls ride on it). Options:
   - a. Run `Fetch.send` (and WebSocket's connect / send) on their own single thread instead of the shared pool. `send`
     never blocks (it only builds the request and calls `enqueue`), so one thread is enough. Smallest change, protects
     payments from any plugin. **My pick.**
   - b. Grow the shared pool (for example up to 8 threads) so one blocked module can't starve the rest. Helps every
     module, but a module that blocks forever still leaks a thread per call.
   - Both a and b can go together. Risk: a: `send` runs in a different order relative to other module calls (no code
     depends on that today that I found). b: more threads for a buggy module to eat.
4. **zero-native: a watchdog log for the pool** (doesn't block the release; cheap, and it is what would have caught
   this in the field). Every 5 s, if a native call has held a pool thread for more than 5 s, `Log.w("zn", "Module.method
   has held a native call thread for N s; other native calls wait")` once per call, and the queue length. Optional: a
   hook so the app can send it to Crashlytics. Risk: none to behaviour (a log).
5. **zero-native core: `fetch`'s `timeout` also as a JS timer** (doesn't block; F4). In `fetch.ts`, when `timeout > 0`,
   a JS timer of `timeout + 1 s` cancels the native call and rejects `FetchError("timeout")`. Then `timeout` really is
   the limit for the whole request, wherever the time goes. Risk: low; a POST cut by this timer may still reach the
   server (same as today's native timeout; ZeroBill already treats a timeout on a write as "may have been sent").
6. **ZeroBill: a time limit on `sessionReady`** (doesn't block once 1 and 3 are in, but cheap insurance; needs Pavan's
   call on what to do). For example after 10 s: log and let requests go with what is known (the device headers may be
   missing), or fail them with a clear error so the screen shows "try again". Product decision.

Order of deploy: 1-5 are native changes, so a new APK (not an OTA). 6 can go by OTA.

## 4. What Pavan can check on a phone where it happened

Today, on a release build (Play or the staging APK), there is no way to see the pool from outside: `adb shell kill -3`
(thread dump) needs a debuggable app. So:
- The quickest proof is fix 4 (the watchdog log), shipped in the next APK. Then, when it happens:
  `adb logcat -d -s zn | findstr "native call thread"`.
- On a debug build it can be checked by hand while it is stuck:
  `adb shell run-as <package> kill -3 <pid>`, then `adb logcat -d | findstr /C:"zn-call"` and read the stack lines after
  each `zn-call` thread. Both threads inside `Tasks.await` (or another wait) confirms F1 + F2.
- Also worth noting when it happens: was a Play build newer than the phone's out at that time (F2 only runs then), and
  was the app reopened from the launcher or did an OTA apply happen earlier in the same process.

## 5. What was built (2026-11-09, Pavan's go: "if all of them are very serious ... sure")

| fix | where | what |
|---|---|---|
| 1 | ZeroBill `plugins/in-app-update` (InAppUpdateHelper.kt, InAppUpdatePlugin.kt) | Play's answer comes from its listener; "no update" after 10 s; no `Tasks.await` |
| 1 | ZeroBill `src/system/appUpdate.ts` + test | Play's answer counts as none after 15 s, so `running` can't stay true |
| 2 | zero-native `plugins/app-updates` (AppUpdatesHelper.kt, AppUpdatesPlugin.kt, src/rules.ts + test) | the same |
| 3 | zero-native `ZnModules.kt` | `Fetch.send` on its own thread (`zn-fetch`). WebSocket already had its own thread |
| 4 | zero-native `ZnModules.kt` (`ZnSlowCalls`) + `ZnSlowCallsTest` | logs a pool call that holds its thread over 5 s, with the queue length, and when it ends |

Docs: guide-notes §90 (module functions must never wait on the pool), second-opinions 221.

Not done: fix 5 (a JS timer for fetch's `timeout`: with fetch off the pool it matters much less) and fix 6 (a limit on
ZeroBill's `sessionReady`: needs Pavan's call). Not built: an app hook to send the watch's lines to Crashlytics.

## 6. Follow-up: are images loaded one by one? (Pavan, 2026-11-09)

Lab: sample `/dev/image-par` ([CallPoolLab.tsx](../examples/sample/src/CallPoolLab.tsx)), 21 images from one host as
the offers tab lays them out (a row of 6 on screen, a `Scroll horizontal` rail of 10, a `Carousel` of 5). The local
server answers each after 2 s and counts how many it serves at once. `bun run tools/repro/http-stall.ts images`.

Result (emulator, sample debug build):
- **Parallel, 10 at a time per host.** The first 10 requests started within 13 ms of each other and all ended at 2.6 s.
  The 11th (rail3, on screen) waited for a free slot and loaded at 4.6 s. That is the dispatcher's 10-per-host limit
  ([ZnFetch.kt:239](../android/runtime/src/main/java/dev/zeronative/runtime/ZnFetch.kt:239)); images use the same
  OkHttp client and dispatcher as fetch (`useForImages`).
- **Only what is on screen is loaded.** Rail items 4-10 and banners 3-5 were never requested in 30 s: `Scroll
  horizontal` and `Carousel` load a picture when it comes into view. So scrolling an offers rail shows each new card
  with its shimmer and then its picture: on a slow image host this looks like "one after another", but it isn't.
- Not related to the pool stall: images load in Compose (Coil), never through JS or the native call pool.

Found on the way (not changed, needs Pavan's go): **merchant icons come from the API host**
(`merchantIcon`: `api.example.com/merchants/icon?mid=...`, ZB `app/src/services.ts:568`). Images and fetch share the
dispatcher, so up to 10 icon loads count against the same 10-per-host limit as API calls, payment verify included. A
screen full of merchant icons on a slow icon endpoint makes the next API call wait for a slot (each icon is bounded by
the 30 s image read limit). Offer pictures are on `storage.googleapis.com`, a separate host, so they don't compete.
Fix options: (a) images get a dispatcher of their own in `useForImages` (for example 6 per host), so they never take
fetch's slots; (b) raise fetch's per-host limit. (a) is my pick: it keeps payments apart from pictures. Risk: low; a
network change still rebuilds the image client (`derived`).

**Built (Pavan's go, 2026-11-09): option (a), 10 per host.** `ZnFetch.useForImages` gives the image client its own
`Dispatcher` (`imageDispatcher`, `IMAGE_MAX_PER_HOST = 10`). Measured in the image lab, a fetch to the same host while
images load:

| build | fetch waited | images at once | 11th on-screen image |
|---|---|---|---|
| before (shared dispatcher) | 1973 ms | 10 | 4.6 s (first image-lab run) |
| own dispatcher, 6 per host | 67 ms | 6 | 4.5 s (two rounds) |
| **own dispatcher, 10 per host (kept)** | **207 ms** | 10 | 4.5 s |

(207 ms includes opening a new connection on the emulator; the local server answers in ~10 ms.) Second-opinions 222,
guide-notes §89.
