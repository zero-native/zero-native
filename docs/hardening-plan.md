# Hardening plan: before the plugin work

**Status: 2026-11-02. H.1 to H.7 are built and tested on the Lava: full matrix 28 of 28, release cold start 180 ms.** This touches OTA and start-up code, so no more code changes until Pavan says go. Findings come from the Fable review
(`docs/cross-communication/2026-11-02-fable-review-response.md`, F1–F11), Argon's review and `docs/second-opinions.md`.

**Assumptions:**
- No real users run zero-native yet, so `health.json` and the host API can change freely.
- The sample stands in for the pilot app. The same rules go into the pilot app's manifest and host Activity.
- UPI tests use only the mock UPI app (`p2pdops.android.p2pupiapp`). Never a real UPI app, and never a real payment.

**Decided:**
- **F4: option D** (Fable + Claude, Pavan left it to us). See H.3.
- **Left for later, before real users:** F5 (a hang or late first screen on a slow phone blocks a good update for
  good), F8 (pinning rules). F5 matters only with real phones in the field, and the pilot starts with the team.

## Steps, in order
Each step ends with its tests passing. Sizes are rough.

### H.1 A second Activity must never restart JS (F11 + link guard). About 40 lines
**Problem:** the sample is `singleTask`, which can close the UPI app when the user taps our icon. With `singleTop`, a
link while the UPI app is on top makes a second `MainActivity` with no saved state, and `ZnNav.start` then treats it
as a swipe from recents: `startFresh` replaces JS during a payment.

**Change:**
1. `android:launchMode="singleTop"` in the sample.
2. New `ZnNav.handleExtraActivity(activity, savedState): Boolean`, called at the top of the host's `onCreate`, before
   any hook is set. It answers true when screens are up, there is no saved state, and `activity.isTaskRoot` is false.
   The host then calls `finish()` and returns, so `onExit` and the batch listener stay with the first Activity.
3. In that case: forward the link with `openLink`, then bring our task to the front with the launcher intent, or the
   user sees nothing (a link from an app that doesn't set `NEW_TASK`). With `singleTop` this shows the task as it is.
4. `startFresh` stays for the true case: `isTaskRoot` and no saved state.
5. JS: `startApp(routes, { onLink })`, called before the push; returning false refuses the link. For apps with no
   `onLink`, nothing changes. Query values in links reach `onLink` as params.

**Comes with P.2, not here:** "never start fresh and never bring the task forward while a launch waits for its result".
That needs the saved "launch pending" record. Until then the rule is `isTaskRoot` alone.

**Risks:**
- `isTaskRoot` is from memory of Android's docs. A ROM may differ; phone tests below check the Lava only.
- A wrong "false" means a real relaunch doesn't start fresh, and the user sees the old stack. Annoying, not unsafe.
- A wrong "true" is the bad one: JS restarts during a payment. P.2's rule is the second lock.
- `ZnOta` counts started Activities. The second Activity finishes in `onCreate`, so it never reaches `onStart`, and
  the count stays right. To confirm on the phone.

**Tests:** JS unit tests for `onLink`. Phone, with a debug-only button in the sample that opens the mock UPI app for a
result: (1) link with `NEW_TASK` while the mock is on top; (2) link from the mock without `NEW_TASK` (needs a button in
the mock app, `test-kit/`); (3) our icon while the mock is on top: the mock stays; (4) swipe, reopen: fresh start;
(5) kill while in the mock, return: restored; (6) a link while the Activity was destroyed for memory (Fable's edge: is
the link dropped?); (7) link from another app with nothing open: the route shows.

**Result (2026-11-02, debug build, Lava Android 14):** all pass, with the same pid and no JS restart except where a
restart is the point.
1. Link with `NEW_TASK`, mock on top: the mock stays, the link is forwarded.
2. Link from the mock without `NEW_TASK`: same.
3. Our icon, mock on top: the mock stays.
4. Swipe, reopen: fresh start, home shows.
5. Kill in the mock, return: screens restored. A route pushed while in the background isn't saved, because saving
   happens at `onSaveInstanceState`.
6. With "Don't keep activities", a link while our Activity is gone: not dropped, it shows after the mock closes.
7. Link with the app in the background: the route shows, one Activity.
8. Added: link from an app in its own task: our task comes to the front on the route.

A query link reached the route with its names merged (`/pay/m1?from=qr&merchantId=evil` gives `[merchantId, from]`).
The path value wins: that link opened the same merchant as `/pay/m1`, on the release build.
**Not tested:** `onLink` on the phone (JS unit tests only, the sample sets none), other ROMs.

### H.2 OTA calls need time limits (F1). About 15 lines
**Problem:** the check and download use a client with no read limit. A server that accepts and never answers blocks
the single `zn-ota` thread for good: no more checks, and `applyNow` never answers.

**Change:** the check gets a 30 s limit for the whole call. The download gets a 60 s idle limit, so a slow download
that still moves is fine and a dead one fails as `download` and resumes next time. The check answer is capped while
reading, not after.

**Risks:** too short a limit fails real checks on bad networks. They retry at the next check, and 30 s is long for a
small JSON answer.

**Tests:** a stall mode in the reference server (accepts, never answers; and sends half a zip, then stops). A new
matrix case: the check fails with `server`, the next check works, `applyNow` still answers.

**Result (2026-11-02, debug build, Lava Android 14):** both new matrix cases pass.
- `check-stall`: `check failed (server): no full answer within 30 s`, `applyNow` answered, the next check worked.
- `download-stall`: `check failed (download): no data for 60 s, at 66196 of 132392 bytes`, then the next check resumed
  and installed it.

**Changed from the plan:** the stall modes are in the matrix's fault proxy, next to `cut` and `slow`, so the reference
server keeps no test code. The two cases run right after `update`, so `--until download-stall` tests them in ~3 min.

**Not covered:** a server that sends one byte every 59 s keeps a download alive, and `applyNow` waits behind it. No
real server does this, and a total limit could fail real downloads on slow networks.

### H.3 Crash counting and last good (F4 option D, F6, F9, entry 1). About 60 lines, all in `ZnOtaHealth.kt`
**Problem:** a crash after the healthy mark is never counted, since the pending mark ends at healthy. And the count
resets on every return from the background, so a crash on return from the UPI app would never count.

**Change:**
1. **Every foreground period is pending,** healthy or not. Going to the background clears `pending` only.
2. **Replace `crashes: Int` with the times of the last 3 counted deaths of `crashBundle`.** Older than 24 h: dropped. A
   different bundle or a new APK starts over. The background and the healthy mark no longer clear it.
3. **Limits within 24 h:** 1 for a sure crash of a bundle never healthy here; 2 for an unsure death of such a bundle;
   3 for the phone's last good bundle. One list, one rule. Block as `WATCHDOG`, cleared by the next APK.
4. `launch_crashed` is sent each time, as today, so the server shows the rate per bundle. The kill switch stays the
   tool for all phones.
5. **F6:** `Rules.healthy` changes nothing for a blocked bundle, and `screensUp` doesn't arm the healthy timer for one.
6. **F9:** a start failure (`main.hbc` threw) of the last good bundle counts as an unsure death in the same list:
   2 in 24 h blocks it, and the APK's bundle runs. Screen errors stay "reported only" (Pavan's option (a)).
7. **Entry 1:** a default uncaught-exception handler writes a small mark (pid + time), then always calls the previous
   handler. At start, a mark with the pending pid counts as a sure crash, whatever Android's exit record says. This
   closes the force-stop gap, and makes Java crashes "sure" on Android below 11. It can't see native crashes.

**Risks:**
- A flaky native SDK crashing 3 times in a day loses that phone's update until the next APK. Accepted: the rate shows
  in telemetry, and a limit is one constant.
- A clock change moves the window. Times in the future are dropped. The worst case is one count too many or too few.
- Every return to the front now writes `health.json` on the main thread (0.5–0.8 ms measured for the same write, no
  sync). To re-measure.
- The handler must never break the chain, or Crashlytics stops seeing crashes. So the write is inside try / catch, and
  the previous handler is always called. Install order doesn't matter: each handler keeps the one before it.

**Tests:** rewrite the tests in `ZnOtaHealthTest` that touch this, and add: three deaths with a background between
each; deaths older than 24 h; different bundle; new APK; blocked bundle can't become last good; start failures; a mark
with the wrong pid is ignored. Phone: crash on return from the mock UPI app 3 times (debug `Device.crash`): blocked on
the third. Before this step, one day's count of `REASON_CRASH` for the sample on the Lava (Fable's check).

**Result (2026-11-02, debug build, Lava Android 14):** unit tests pass, and so does the new matrix case
`crash-on-return`: the last good bundle crashed 3 times on return from the mock UPI app, with the background between
each. The log counted 1, 2 and 3 of 3, then `watchdog_block sample_3: 3 launches in 24 h ended by a crash or a freeze`,
and that bundle didn't run again.

**Not tested on the phone:** a start failure of the last good bundle (F9; unit tests only). The health file write time
is to be measured on the release build at the end.

**Added beyond the plan:**
- A phone restart after the pending mark never counts (`docs/second-opinions.md` entry 8).
- A switch to the APK's bundle clears `pending`, or a later death would count against the bundle that ran before.
- A blocked bundle also can't be marked healthy from JS (`Updates.markHealthy`).

**Skipped:** the one-day `REASON_CRASH` count. The sample's APK is reinstalled for every matrix run, so its record says
nothing about real crash noise. That number is worth taking on the pilot app.

### H.4 Unusable bundle and private data (entries 6, 4). About 40 lines
**Entry 6:** when `current` can't run, use the last good bundle if it passes the same checks, and point `current` at
it. Else the APK's bundle. Send `bundle_unusable` with the reason, once per bundle id, so a repeat doesn't fill the
event list. The folder goes in the next `prune`.

**Entry 4:** before a JS error's text is stored or sent: mask runs of 6 or more digits, anything like `a@b` (VPAs,
emails), URL query strings and `Bearer ...`. Then `ZnOta.Config.redact`, if the app gave one. Applied only to JS error
text, not to all outcome details, since those hold bundle ids. Stack frames stay as they are.

**Risks:** a mask can hide a useful number in an error. Fine. The app's own `onJsError` still gets the raw text, so an
app must not send that anywhere private data can't go: a guide note.

**Tests:** unit tests on the mask with real shapes. The `killed-install` matrix case stays, plus a new case with a last
good bundle present.

**Result (2026-11-02, debug build, Lava Android 14):** unit tests pass for the mask and the report-once rule. By hand on
the phone: a broken `current` with a last good bundle present ran `sample_1`, and `current` then named it. With no last
good bundle, the APK's bundle ran and `current` was gone. `bundle_unusable sample_98: its folder has no zn-bundle.json`
was sent each time, and the next start was quiet.

**Changed from the plan:**
- `killed-install` now expects the last good bundle, because that is what the matrix has at that point. The new case
  `unusable-no-good` covers the APK's bundle. Both run in the full matrix after H.7.
- `prune` now deletes any folder that fails its checks. This needs no list of bad bundles to keep up to date.
- With no last good bundle, `current` is removed, so a broken bundle isn't checked at every start.
- `bundle_unusable` is a serious outcome, so it reaches `onReport` as worth logging.
- The digit mask also takes runs with single spaces or dashes in them, since phone numbers are often written `98765 43210`.

**Not tested on the phone:** the mask on a real error (unit tests only), and `Config.redact` (the sample sets none).

### H.5 JS time limit and the storage comment. About 15 lines
**Problem:** the limit reads a clock that keeps counting while the process is frozen. If Android freezes the app in the
middle of a JS task, the task looks like a hang when it wakes up. Not reproduced yet.

**Change:** the watcher thread notes when it woke last. If it woke much later than it should have, the process was
stopped, so that gap doesn't count toward the limit. Only the watcher's own values change; `entryStart_` is not written.

**Storage comment:** `packages/core/src/storage.ts` says a `set` survives a kill. Add that a damaged store opens empty
(`docs/storage.md`, 6 of 100 rounds), so nothing that can't be lost goes there.

**Risks:** a real hang on a badly starved phone gets a little longer before it is stopped. Harmless.

**Tests:** on the Lava, start a 1.5 s JS loop from the Crash lab, `kill -STOP` the process for 3 s, then `-CONT`: no
hang reported. An endless loop must still be stopped, including one inside `try / catch` (Fable's suggested case).

**Result (2026-11-02, debug build, Lava Android 14, limit 3 s):**
- The problem is real. Before the fix, a 1.5 s JS task frozen for 6 s was reported as a hang (`onJsError kind=hang`).
- After the fix, the same test logged `slow JS: ... ran for 7695 ms` and no hang, with the same pid.
- An endless loop inside `try / catch` is stopped: JS can't catch the time limit.
- The C++ core tests pass (148 checks).

**Not tested:** a real Android freeze (`kill -STOP` stands in for it), a release build.

### H.6 Swipe applies a waiting update (F10). About 60 lines
Only after H.1, since it makes a wrong fresh start cost more.

**Change:** `ZnNav.startFresh` goes through a new `ZnOta.startFresh(link)`: set the cover at once (no flash of the old
screen), take `candidate()` on the worker, then `swap` with a `FRESH` kind, which opens the start screen instead of the
saved stack. With no waiting update, or OTA off: today's path, plus the cover. Outcome `applied`, detail "fresh start".

**Risks:** one more path through `swap`, the most delicate code here. A bad waiting bundle must fall back like
`applyNow`.

**Tests:** two matrix cases: swipe with a good waiting update; swipe with a bad one (back to the bundle that ran).

**Result (2026-11-02, debug build, Lava Android 14):** `swipe-update` passes: with no waiting update the same bundle
starts fresh; with one, `applied sample_3: fresh start, was sample_2`, and its home screen shows, in the same process.
`swipe-bad-update`: the log shows `apply_failed`, then the bundle that ran came back, and it became healthy. Its first
run failed only on a text check, since the dev error screen covers the app in debug builds; the check now uses the log,
and the full matrix after H.7 re-runs it.

**Changed from the plan:** `candidate()` runs on its own short thread, not the worker. A download on the worker would
keep the user on the cover for minutes. `current` is written last and atomically, so this read is safe. With updates
held (a payment), it starts fresh on the running bundle, as before.

### H.7 App state to JS (F3). About 50 lines
**Change:** `onAppState((state) => ...)` and a readable current state, `"active"` or `"background"`, sent from the same
lifecycle callbacks `ZnOta` uses. New app event, **host API 5**.

**Risks:** a bundle using it needs an app with host API 5; the capability check covers that. A translucent UPI window
gives no `onStop`, so state stays "active" there. To document.

**Tests:** JS unit tests. On the phone: the state changes when the mock opaque screen covers us.

**Result (2026-11-02, debug build, Lava Android 14):** JS tests pass (5 new). On the phone: Home, then back, gave
`background`, `active`. The mock's see-through first screen gave the same, with our Activity `PAUSED` and not stopped.
A launch and a dark mode change gave nothing.

**Changed from the plan:** the state follows resume and pause, not the start and stop that `ZnOta` uses. So a
see-through window counts, and the "stays active" risk above is gone. This is how React Native's AppState works on
Android, and the ZeroBill port asks for it (`docs/second-opinions.md` entry 9). It has its own `ZnAppState`, so apps with
OTA off get it too. A permission dialog also reads as `background`.

**To know:** an old bundle on a newer app logs `no handler for event 11` at each change. Harmless.

## How the work is checked
- After each step: Kotlin tests, JS tests, and the C++ core tests on the phone if core changed.
- By hand on the Lava for the new case; the full `bun run ota:phone` matrix runs **once at the end**.
- Debug builds for work; one release build at the end for cold start, as `health.json` writes changed.
- Each step updates `docs/ota.md`, `docs/guide-notes.md`, `docs/milestones.md` and `docs/second-opinions.md`.

**Final check (2026-11-02, Lava Android 14):** full matrix 28 of 28 (debug); C++ core tests 148 checks; JS tests 214; Kotlin
tests pass. Release build: cold start 180 ms median (p90 194 ms, n=10) on a downloaded bundle; the visit mark takes 0.42–0.50 ms.

## Side effects
- **New:** host API 5 (H.7). An app with the older native side won't run bundles that use `onAppState`.
- **`health.json`** changes shape: old files lose their crash count, which is fine with no users.
- **Host Activity:** every app adds one line to `onCreate` and sets `singleTop`.
- **No new dependencies.** The test kit's mock app and the reference server get small test-only additions.
