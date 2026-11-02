# Second opinions: judgment calls to review

Choices where we picked a sensible default, but a subject expert (or a bigger model) might choose differently. Each
entry says what we chose, why, what could go wrong, and how to change it. Add an entry whenever a step makes such a
call; mark it **reviewed** with the date and the outcome once someone has looked at it.

How to ask for a review: give the reviewer this file, the design doc section named in the entry, and the code it
points to. Ask: "Is the choice right for a payments app with many Android users on low-end phones? What would you
change, and what evidence would make you change it?"

---

## 1. Watchdog: one crash blocks a new bundle, but the last good bundle needs two (step 4.8)
- **Where:** `android/runtime/.../ZnOtaHealth.kt`, `Rules.atStart` (`val limit = ...`); docs/ota.md §3.6.
- **Chosen:** a launch that Android's exit record says **crashed** (crash, native crash) blocks a bundle that was
  never healthy on this phone at once. The phone's **last good** bundle (it ran well here before) still needs 2
  crashed launches in a row.
- **Why:** a crash before the healthy mark usually repeats on every start, so waiting for a second one only costs the
  user one more crash. But the healthy mark is per process (see entry 3), so a bundle that worked for weeks is still
  watched for 4 s on every launch. One crash there may be bad luck (a native SDK, low memory) and blocking it takes
  away the update until the next APK.
- **Risk if wrong:** too strict → good updates lost on some phones; too loose → a user sees a crash twice.
- **Other options:** (a) 1 crash for every bundle (Pavan's D4 as first said; revert: `val limit = if (e.sure) 1 else
  WATCHDOG_LIMIT`); (b) 2 for every bundle (the 4.7 rule).
- **Evidence that would settle it:** from telemetry, how often `launch_crashed` on a last good bundle is followed by a
  second one (repeats → be stricter; one-offs → keep).
- **Seen in 4.9 (a gap, not changed):** some phones (the Lava) show "<app> has stopped" after a crash and keep the
  crashed process until the user closes it. "Close app" → Android records a crash (counted). But if the user picks
  "App info" → "Force stop", or the app is force-stopped while the dialog is up, Android records a **force stop**, and
  the watchdog doesn't count force stops (on purpose: users force-stop healthy apps too). That crash is missed; the
  next one counts. Possible fix: an uncaught-exception handler (not there today) writes a small "crashed" mark before
  Android's handler runs; a force stop with that mark counts as a crash. Low priority unless telemetry shows crash loops without `launch_crashed`.
- **Reviewed 2026-11-02 (Fable, Argon):** 1 vs 2 kept for the launch. Two changes, planned in `docs/hardening-plan.md`
  H.3, not built yet:
  - The crash mark is in: it also makes Java crashes "sure" on Android below 11.
  - **The count changes (decided by Fable + Claude; Pavan left it to us).** Today a crash after the healthy mark is
    never counted, and going to the background resets the count, so a crash on return from a UPI app is always "1 of
    N". New rule: every foreground period is watched; the last 3 counted deaths are kept with their times; deaths
    older than 24 h drop out; neither the background nor the healthy mark clears them. Limits in 24 h: 1 sure crash
    (never healthy), 2 unsure (never healthy), 3 (last good). A plain "3 in a row" was rejected, as was "only report and
    use the kill switch", which needs a person to notice while the user can't pay.
  - **Evidence that would change it:** if `launch_crashed` on healthy bundles is mostly one event per phone with no
    cluster per bundle, raise the limit to 4 or stop blocking after healthy. If it clusters per bundle, tighten it.

## 2. Watchdog: an ANR counts, but as "not sure" (2 needed) (step 4.8)
- **Where:** `ZnOtaHealth.kt`, `exitOf` (`REASON_ANR -> Exit.Counts(..., sure = false)`).
- **Chosen:** a launch killed for "not responding" counts toward the watchdog, but needs 2 in a row, like Android < 11.
- **Why:** an ANR may be the phone (a slow phone on its first start after an update, a busy disk), not the bundle.
  JS hangs are caught earlier by our own JS time limit (that path rolls back at once), so an ANR is more often native
  or system trouble.
- **Risk if wrong:** a bundle that freezes the main thread stays for one more launch.
- **Other options:** `sure = true` (block after 1); or don't count ANRs at all.
- **Evidence:** ANR rate per bundle vs the APK's own bundle in telemetry / Play Console.
- **Reviewed 2026-11-02 (Fable, Argon):** keep. JS doesn't run on the main thread, so an ANR is native or the phone.

## 3. Errors of the phone's last good bundle are only reported (step 4.7, changed in 4.8)
- **Where:** `ZnOtaHealth.Rules.errorsRollBack`, used by `ZnOta.errorScreen` and the first-screen timer;
  `ZnOtaHealth.healthyBundle` (in memory); docs/ota.md §3.6.
- **Background:** the healthy mark lasts one process only, so every launch of a downloaded bundle is "on trial" for
  its first ~4 s, even if it was healthy before on this phone. In 4.7, an error screen, a hang or no first screen in
  10 s during that window **blocked the bundle forever** ("error", not cleared by a new APK) and rolled back.
- **Chosen (Pavan, 2026-10-31: option a):** for the phone's **last good** bundle these are only reported
  (`error_screen`, detail "last good bundle: reported only"); no block, no rollback, the error screen shows. Any other
  bundle not healthy yet in this process is still blocked and rolled back. Its crashes still count (entry 1: 2 in a
  row).
- **Why:** one bad moment (a screen that throws only on odd server data, a slow phone missing the 10 s first-screen
  limit) shouldn't take away an update that worked on this phone for weeks.
- **Risk if wrong:** a bundle that turns bad only later on a phone (for example after a server change) keeps showing
  the error screen at start on every launch until a fixed bundle is published; the safety net no longer moves the user
  to an older bundle by itself. Only the last good bundle is exempt, so a phone with an older healthy bundle that then
  takes a newer one judges the newer one fully.
- **Other options:** (b) block / roll back after N error launches in a row of the last good bundle (a counter like the
  watchdog's); (c) the 4.7 rule (block at once); (d) keep the healthy mark across processes for a time (e.g. 24 h).
- **Evidence:** `error_screen` with "last good bundle: reported only" in telemetry: how many installs repeat it on
  every launch (→ consider (b)) vs once (→ keep).
- **Checked:** on the Lava (debug): bundle healthy on launch 1, home throws on launch 2 → reported only, launch 3 runs
  it normally. Unit test: `ZnOtaHealthTest.errorsOfTheLastGoodBundleAreOnlyReported`.
- **Reviewed 2026-11-02 (Fable, Argon):** keep option (a) for screen errors. A **start** failure repeats on every launch,
  so it will count: 2 in 24 h blocks the bundle (`docs/hardening-plan.md` H.3, not built yet). The check still runs on
  an error screen, so a fixed bundle or a kill switch reaches the phone. Hangs and a late first screen on a slow phone
  block a new bundle for good (Fable's F5): to fix before real users.

## 4. What error text goes to our server (step 4.7 / 4.8)
- **Where:** `ZnOta.errorScreen` (`detail`: the first line of the error message), `jsTopFrames` (`stack`); the
  reference server keeps them in `.zn-ota-data`.
- **Chosen:** outcomes carry the first line of the JS error message (≤300 chars) and the top stack frames (function
  names and main.js positions only, ≤1 KB). No user id is sent; the install id is random.
- **Risk if wrong:** an error message can contain data the app put in it (`amount 500 for 98xxxxxx21 failed`): that
  would reach our telemetry. For a payments app this may matter for privacy rules.
- **Other options:** send only the error type (`TypeError`) and frames; or let the app filter messages
  (`ZnOta.Config.redact`).
- **Evidence:** a look at real `detail` values from a staging rollout; ask whoever owns privacy / compliance.
- **Reviewed 2026-11-02 (Fable, Argon):** change the default. Mask digit runs, VPAs and emails, URL query strings and
  bearer tokens on the phone, and add `ZnOta.Config.redact` (`docs/hardening-plan.md` H.4, built 2026-11-02). Whether
  messages may leave the phone at all is still for whoever owns compliance.

## 5. How much free space a download needs (step 4.9)
- **Where:** `ZnOta.checkSpace` (`UNZIP_FACTOR = 4`, `MIN_FREE_BYTES = 50 MB`); guide-notes "When the phone is full".
- **Chosen:** download only if free space ≥ the rest of the zip + 4× the zip (unzipped files; measured ~2.9× for the
  sample) + 50 MB left for the user. Else `no_space`, nothing written, try again at the next check. Running out of
  space mid-write (ENOSPC) removes the half-written files at once.
- **Why:** the signed manifest has no unzipped size (adding one changes the signed format: not done without a
  decision), so the zip size is the base. 50 MB keeps OTPs, photos and the payment app working.
- **Risk if wrong:** too strict → phones with 50–100 MB free never update (common on 32 GB low-end phones); too loose
  → an update pushes the phone into Android's "storage full" state.
- **Other options:** a lower floor (20 MB) or a % of the disk; add the unzipped size to the manifest (exact numbers);
  delete kept older bundles first to make room before giving up.
- **Evidence:** count of `no_space` outcomes per install in telemetry, and the free space phones report (not sent
  today).
- **Reviewed 2026-11-02 (Fable, Argon):** keep the formula. Later, cheap additions: send free space with the check, and
  prune old bundles before giving up.

## 6. A downloaded bundle that can't run falls back to the APK's bundle, not the last good one (found in 4.9)
- **Where:** `ZnBundles.downloaded` ("not running X: …; running the built-in bundle"); the server's `ALREADY_DONE` in
  `tools/ota/decide.ts`.
- **Today:** if the bundle named by `current` is missing files, fails its hash check or needs a module the app lacks,
  the phone runs the APK's bundle. `current` stays as it is. The phone already saved that pointer's seq, so the
  server answers `ALREADY_DONE` and the phone stays on the APK's bundle until the channel moves to a newer pointer.
  (A *blocked* bundle is different: there the last good bundle runs and becomes `current`.)
- **Why it is like this:** this case needs a broken disk or a kill at a moment the install order should rule out
  (`current` is written last), so 4.5 kept the simplest safe answer. The phone matrix makes it on purpose
  (`killed-install`) and sees it.
- **Risk if wrong:** users on such a phone silently lose fixes that were in the last good bundle (they run the APK's
  older code) until the next release on the channel; nothing tells us, since no outcome is sent for it.
- **Other options:** (a) fall back to the last good bundle like a blocked one, and point `current` at it; (b) also
  send an outcome (`bundle_unusable`, with the reason) so it shows in telemetry; (c) drop the saved seq so the next
  check downloads the bundle again. (a) + (b) look cheap and safe; (c) risks a download loop if the cause repeats.
- **Evidence:** how often (b) would fire in a staging rollout. If it never fires, keep it as is.
- **Reviewed 2026-11-02 (Fable, Argon):** do (a) + (b) (`docs/hardening-plan.md` H.4, built 2026-11-02). A new APK that
  registers a module late would make every bundle unusable on every phone, and today only a log line shows it.

## 7. restorableSignal values come back only into the bundle that saved them (after milestone 4)
- **Where:** `ZnNav.start` (`SAVED_BUNDLE`, the running bundle's `id@sha12`); guide-notes §26.1.
- **Chosen:** when Android restores the app, screen values come back only if the same bundle runs now. If another
  bundle runs (an OTA update was installed while the app was in the background, or the watchdog rolled back), the
  screens still open again but start fresh. A dev reload and an update applied in place also start screens fresh.
- **Why:** a newer bundle may read a value differently (a renamed key, an amount in paise instead of rupees). A
  wrong value on a payment screen is worse than an empty one; this case is rare (an install, then a background kill).
- **Risk if wrong:** a user loses a typed value once in that rare case. No safety risk.
- **Other options:** (a) always hand values back and let the app check them (like `storage`, guide notes "saved
  data across updates"); (b) a version number per value (`restorableSignal("amount", "0", { version: 2 })`), kept
  only if equal.
- **Evidence:** none needed unless users report lost values after updates; (b) is a small, safe addition later.
- **Reviewed 2026-11-02 (Fable, Argon):** keep.

## 8. A phone restart never counts as a death (H.3)
- **Where:** `ZnOtaHealth.exitOf` (`docs/hardening-plan.md` H.3). Not in the plan; added while building it.
- **Chosen:** if the phone started after the pending mark, the death is ignored, whatever Android's record says.
- **Why:** every visit is now watched, not only the first seconds. With the app on screen, a flat battery leaves a
  pending mark and no exit record, which would count as an unsure death of a good bundle.
- **Risk if wrong:** a bundle that makes the whole phone restart isn't counted. That needs a phone-level failure, which
  a JS bundle can't normally cause.
- **Other options:** count it; or use `Settings.Global.BOOT_COUNT` in place of the clock sum.
- **Evidence:** `launch_crashed` with "no exit record" from the field would show what this misses.

## 9. App state follows resume and pause, not start and stop (H.7)
- **Where:** `ZnAppState.kt`, `packages/core/src/app-state.ts`; guide-notes §29.
- **Chosen:** `"background"` means the user can't touch the app: the Activity paused. Not "the app is out of sight".
- **Why:** a see-through payment window pauses us without stopping us. With start and stop, JS would never hear that
  the user came back. React Native does the same on Android.
- **Risk if wrong:** a permission dialog, or losing focus in split screen, also reads as `background`. An app that does
  heavy work on `active` runs it after each one.
- **Other options:** a third state like iOS's `inactive` for "visible but not in front".
- **Evidence:** what the pilot's verify-on-return code needs. A third state can be added with a new host API.

## 10. A plugin that fails is skipped in release, not a crash (P.1)
- **Where:** `ZnPlugins.register` (`android/runtime/.../ZnPlugins.kt`); guide-notes §30.
- **Chosen:** a debug build throws at once. A release build logs the error, skips that plugin and starts. A plugin is added
  whole or not at all, so a failure after its first `r.module` leaves nothing behind.
- **Why:** a crash here happens in `Application.onCreate`, so the app can't open at all, and an OTA update can't fix it. A
  skipped plugin costs one feature. Its calls reject with `unavailable`, which JS already handles, and the OTA check
  refuses bundles that need it.
- **Risk if wrong:** an app whose core flow needs the plugin opens and then fails later, in a worse place. A payment app with
  a missing UPI plugin would show its home screen and fail at checkout. Only the log says why, until the app reports it.
- **Other options:** crash in release too (fails loud, and a crash reporter sees it); or let each plugin say it is required.
- **Evidence:** this shouldn't fire at all in a tested APK: `register` only declares things. If it ever shows up in the
  field, look at why first. A `required` flag is a small addition later.

## 11. A new launch is refused while a result isn't acked (P.2)
- **Where:** `ZnLaunch.Rules.refusal`; guide-notes §31.
- **Chosen:** `launched: false, reason: "unacked"`. The app must `ack` the old record before the same key launches again.
- **Why:** replacing it would lose a result in silence. That's the one thing this code exists to prevent.
- **Risk if wrong:** an app that forgets `ack` can't start a payment. It shows at once in testing, but a rare path could reach
  users.
- **Other options:** replace the record and log it; or keep a short history per key.
- **Evidence:** how often the pilot logs `unacked`.

## 12. START waits for Android's answer, so `pending()` can be sync (P.2)
- **Where:** `ZnLaunch.whenSettled`, `ZnNav.startWith`.
- **Chosen:** if a launch from an earlier process may be waiting, START is held until the Activity's first resume. A marker
  file decides this with one stat, so a normal start doesn't touch storage on the main thread.
- **Why:** after a kill, Android delivers the result just before `onResume`, while JS may be building the first screen. A read
  then says `waiting`, and the restore code picks the wrong path.
- **Risk if wrong:** the first screen comes a little later on that one path. If the Activity never resumes, JS never builds
  screens, but nothing is on show then either.
- **Other options:** an async `pending()`: every restore path would have to wait, and the first screen would need a loading state.
- **Evidence:** `result-after-kill` in the phone matrix. Timing on other ROMs.

## 13. Only Kotlin can open another app (P.2)
- **Where:** `ZnLaunch.start` has no JS form. `Os.openUrl` takes only http, https, mailto and tel.
- **Chosen:** JS calls a plugin, and the plugin builds the Intent.
- **Why:** bundles change over OTA. A stolen signing key, or a bad update, must not be able to open any app with any data.
- **Risk if wrong:** each new kind of app needs a plugin and an APK release.
- **Other options:** a generic `launch(intent)` with an allow-list in the manifest.
- **Evidence:** how many plugins end up doing nothing but one `startActivity`.

## 14. The other app's answer sits in a plain store until ack (P.2)
- **Where:** the store `zn.launch`, in `noBackupFilesDir`, excluded from backups. It holds the result's simple extras, at most 16 KB.
- **Chosen:** not encrypted, like a saved flow.
- **Why:** a UPI answer has refs and a status, no secrets, and it must be readable at once on the first screen. SecureStore is
  async and slower.
- **Risk if wrong:** some other app's result might hold something private, on a rooted phone. A plugin controls what it opens.
- **Other options:** encrypt with a Keystore key, read async; or drop the extras a plugin doesn't list.
- **Evidence:** a review of what P.3's real UPI apps and the auth plugin put in their results.

## 15. Under a see-through window, a killed app can't get its result (P.2)
- **Where:** Android, not our code. Found with the mock's first window; `result-under-see-through` in the matrix.
- **What happens:** a see-through window only pauses us, so our state isn't saved yet. If the process dies then, Android drops
  the Activity. The other app's result reaches nobody, and the user lands on the launcher. The next open reads `lost`.
- **Chosen:** accept it. It's rare: Android counts the process as visible, and `am kill` refused it; the test needed `kill -9`.
  The safe path holds: the app asks its server.
- **Risk if wrong:** on a phone with hard memory pressure, a user who just paid sees the launcher. The money part is still right.
- **Other options:** save state on pause (Android gives no such hook for this); a foreground service during a payment,
  which keeps the process alive, at the cost of a notification.
- **Evidence:** how often the pilot logs `lost` right after a launch.
