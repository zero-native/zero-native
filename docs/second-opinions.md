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
- **Evidence:** how often the pilot logs `lost` right after a launch. A real UPI app does open such a window for 1 to 4 seconds
  (noted in the private app's older reference code), so the case is real, not only the mock's.

## 16. UPI is the app's plugin, not an official one (P.3)
- **Where:** `docs/plugins.md` D7, reversed in part. The plugin lives in the app's private repo.
- **Chosen:** only one app needs it today, and building it outside this repo tests what no sample could: a real app, with its
  own host, build and plugin. It uses only public plugin APIs, so it can move here later with no change.
- **Risk if wrong:** the framework ships with no UPI plugin, and other Indian apps each write their own. The same mistakes (a
  chooser, a retry with the same id) would then repeat. The rules are in `docs/guide-notes.md` §31 for that reason.
- **Other options:** keep `@zero-native/upi` here, and the pilot only uses it.
- **Evidence:** a second app that wants UPI is the moment to move it.

## 17. An outside app uses a composite build and `bun link` until packages exist (P.3)
- **Where:** `docs/guide-notes.md` §34.
- **Chosen:** Gradle's `includeBuild`, and `bun link`. Framework edits show at once, the app already asks for
  `dev.zeronative:runtime`, and moving to Maven later removes one block. `:runtime` can't simply be included by path: it needs
  `:baselineprofile`, which points at `:sample`.
- **Risk if wrong:** the app's plugin versions must match the framework's by hand, and `bun link` is per computer, so a CI needs
  its own setup. Two apps on one computer share the one link.
- **Other options:** publish to a local Maven folder; npm `file:` paths, which copy, so a framework edit needs a new install.
- **Evidence:** the first CI build of the pilot.

## 18. A native screen's answer goes in the launch store (P.3b)
- **Where:** `ZnLaunch.saveScreenResult`, `ZnNav.answer`, `packages/core/src/nav.ts` `onNavResultEvent`.
- **Chosen:** the same record as another app's result, under the key `nav.<route>`, on disk before JS hears it, kept until ack. One record format, and the
  rules for a kill are already tested.
- **Risk if wrong:** `launches.pending("nav.scan")` can see these records, and a new launch under that key is refused until ack. Only a misnamed key can
  meet them.
- **Other options:** a small store of its own: more code for the same rules.
- **Evidence:** the kill case on the phone passed. A second writer of records would show the limit.

## 19. `pushForResult` works only on native routes (P.3b)
- **Where:** `packages/core/src/nav.ts`. The type limits it to native routes too.
- **Chosen:** refuse a normal screen. A zn screen has no way to answer, and adding one is a new feature nobody asked for yet.
- **Risk if wrong:** a screen picker written in TSX can't use it; it must pass a callback or use a store. RN apps do that today.
- **Other options:** `nav.finish(value)` from a zn screen, later, on the same path.
- **Evidence:** a real picker screen that wants it.

## 20. `<NativeView>` props are one JSON string (P.4b)
- **Where:** `compiler/src/compile.ts` `nativeViewElement`.
- **Chosen:** `JSON.stringify` in a slot. A frame with no change sends nothing, as a slot compares values, and one registry prop serves all views.
- **Risk if wrong:** each change pays for the whole JSON, and the view parses it. Fine for a torch flag; poor for a prop that changes each frame.
- **Other options:** typed props per view: a registry change per plugin, which is what D3 avoids.
- **Evidence:** a view with a prop that changes per frame. It should use its module instead.

## 21. Dark mode comes after the template (P.6)
- **Where:** `docs/guide-notes.md` §37, `ZnRuntime.afterMainScript`, `packages/core/src/appearance.ts`.
- **Chosen:** JS chooses colours, as in RN's `useColorScheme`. Native sends the scheme after the main script and before START, so the first screen reads it right.
- **Risk if wrong:** templates are drawn before JS fills slots, so a slot colour can show its default for a frame at cold start. On the Lava the first screen
  looked right, but a slow phone may flash. Only colours that can change at runtime can use it.
- **Other options:** light and dark values in the template, chosen natively with no JS: no flash, but a template format change and a colour token system.
- **Evidence:** the first app that ships a dark mode, on a slow phone.

## 22. Background JS has no user yet (P.5)
- **Where:** `ZnBackground.kt`, `packages/core/src/tasks.ts`.
- **Chosen:** built now, since `push` will need it. It doesn't change the start path; it adds one event, one module, a queue and a timer. The limit is enforced in
  Kotlin, so JS that hangs can't hold a task open.
- **Risk if wrong:** push may want something else: a foreground service, or a task that outlives 30 s. Only the debug provider calls it today. It adds the
  `Tasks` module to every bundle's needs, so bundles built from here need a new APK; host API 6 needs that anyway.
- **Other options:** wait for push.
- **Evidence:** the first push plugin.

## 23. `secure` ends as the closing animation starts (P.6)
- **Where:** `ZnNavHost.kt` `SecureWindow`.
- **Chosen:** the flag follows the top of the stack. On Back it clears at once, while the secure screen still slides out for about 300 ms.
- **Risk if wrong:** a screenshot in that moment can catch the sliding screen. Also, Android may apply the flag a frame after a push.
- **Other options:** keep the flag until the entry has left: more state in the host, for a small window. RN's `FLAG_SECURE` libraries set it per Activity or by hand.
- **Evidence:** a security review that asks for it.

## 24. `ZnLaunch.readResult`: a plugin reads its own answer (P.3b)
- **Where:** `ZnLaunch.kt`.
- **Chosen:** a function set in `register`, keyed by launch key. **Why:** the phone hint's number is read with Play services from the Intent, not from plain extras, and after
  a kill only code run at start can be there. It runs on the main thread, so it must be quick.
- **Risk if wrong:** the 16 KB limit on extras doesn't apply to it, as the plugin is trusted code. A slow reader would stall the return from the other app.
- **Other options:** keep raw extras and parse in JS: Play services' format isn't ours to read.
- **Evidence:** the `auth` plugin on the phone.

## 25. `zn://file` is one flat folder in the cache (P.3b)
- **Where:** `ZnHandles.kt`.
- **Chosen:** `cacheDir/zn-files`, plain names only. A bundle can't name any other path. Cache, as a picked photo is temporary.
- **Risk if wrong:** Android can clear it while a handle is still saved in JS: the image falls back to `<Image fallback>`, and an upload fails. An app that keeps a
  handle over days must copy the file.
- **Other options:** `filesDir`, with a cleanup rule. Survives, but it grows.
- **Evidence:** the first app that keeps a handle for long.

## 26. `onLowMemory` doesn't clear images (P.6)
- **Where:** `ZnActivity.kt`.
- **Chosen:** dropped the plan's line. Coil's own `AndroidSystemCallbacks` clears its memory cache at trim level 40 and above (checked in the 3.6.3 bytecode). A second clear adds nothing.
- **Risk if wrong:** below level 40 the cache stays; on Android 14 those levels aren't sent anyway. A new Coil version could change it.
- **Evidence:** a memory test on a low-end phone.

## 27. The scanner's stale window counts from the first real frame (P.4)
- **Where:** `plugins/scanner/.../ScannerRules.kt` `ScanGate`.
- **Chosen:** 500 ms from the first frame, not from mount as RN does. RN has no frame event; a camera can take a second to open, which uses up RN's whole window. After "scan again" it is 500 ms, not RN's 300.
- **Risk if wrong:** assumes the first frame we see is the stale one. A slower scan open by up to 500 ms.
- **Other options:** RN's way, from mount.
- **Evidence:** the `scanner stale frames` phone steps.

## 28. CameraX 1.4.2, not the newest (P.4)
- **Where:** `plugins/scanner/android/build.gradle.kts`.
- **Chosen:** the version RN runs today. The newest, 1.6, has a new camera backend, which nobody here has tried in the field.
- **Risk if wrong:** we stay on an older line with fewer fixes for new phones.
- **Evidence:** a camera bug that a newer version fixes.

## 29. ML Kit's start provider is removed (P.4)
- **Where:** `plugins/scanner/android/src/main/AndroidManifest.xml`, `CameraSession.kt`.
- **Chosen:** `tools:node="remove"` and `MlKit.initialize` on the camera's thread. It would otherwise run in every app start, also for users who never scan.
- **Risk if wrong:** another ML Kit user in the same app must start it itself. A second `initialize` throws, so the scanner starts it once per process, and a start by another user counts.
- **Evidence:** the sample's cold start with the plugin on.

## 30. The picked number stays in a plain store until read (P.3b)
- **Where:** `plugins/auth/src/index.ts`, the launch record.
- **Chosen:** a hint goes through `ZnLaunch`, so it survives a kill, and it is acked as soon as JS reads it, unlike a payment. If no screen asks after a kill, it stays until the next `phoneHint` or `clearPhoneHint`.
- **Risk if wrong:** a phone number sits unencrypted in app storage for a time. It is not a credential, and the app's private folder holds it.
- **Other options:** SecureStore for this record: a special case in `ZnLaunch`.
- **Evidence:** a security review.

## 31. An OTP is never on disk (P.3b)
- **Where:** `plugins/auth`. RN writes it to its login draft.
- **Chosen:** memory only. A rebuilt screen joins by `key`; after a kill the code is gone, and the user types it. RN's receiver dies with a kill too, so only a code that came just before the kill is affected.
- **Risk if wrong:** a user who gets a kill right after the SMS retypes. The SMS is in their inbox.
- **Evidence:** a login drop report.

## 32. WebView refuses `intent:` outright (P.6)
- **Where:** `plugins/webview/.../WebViewRules.kt`.
- **Chosen:** `intent:` and `android-app:` are never opened, even if the app lists them. They can name any Activity in any app, and filtering them is a known source of bugs.
- **Risk if wrong:** a payment page that uses `intent:` for its UPI button won't work. Plain `upi:` does, but with no answer back.
- **Other options:** parse the Intent, allow only `ACTION_VIEW` to a listed package, and strip everything else.
- **Evidence:** the first payment page an app must host.

## 33. WebView upload doesn't use `ZnLaunch` (P.6)
- **Where:** `plugins/webview/.../WebViewPage.kt`.
- **Chosen:** a new `activityResultRegistry` key per launch. WebView's callback is in memory, so after a kill there is no one to give the file to, and a saved record would only block the next launch: one upload would make a UPI launch answer `busy`.
- **Risk if wrong:** a kill while the picker is open loses the pick. The user picks again.
- **Evidence:** the `webview kill while the picker is open` phone step.

## 34. A pushed screen destroys the WebView (P.6)
- **Where:** core's `NavDisplay`, `plugins/webview`.
- **Chosen:** accepted. Keeping it needs a change to how screens are drawn, or `WebView.saveState`, which keeps little.
- **Risk if wrong:** a page state, such as a half-filled form, is lost when the app pushes a screen on top. Use a sheet, which stays on the same screen.
- **Evidence:** an app that needs a screen over a web page.

## 35. Media re-encodes every photo (P.4)
- **Where:** `plugins/media`.
- **Chosen:** decode, turn, write a new JPEG. The only way to be sure no location leaves the phone, and rotation can't be lost by a server. The limits are ours: 7 days and 256 MB in the folder, 100 MB per copy, 24 MP per decode.
- **Risk if wrong:** a PNG with see-through parts turns white, and a small photo gets a second round of JPEG loss.
- **Other options:** copy as is when the photo is small and has no EXIF.
- **Evidence:** a complaint about quality, or a PNG need.

## 36. WebView pages don't load on the Lava: DuraSpeed, not our code (P.6)
- **Where:** the Lava's MediaTek ROM; `plugins/webview/`.
- **Found:** every page fails in debug and release. Android refuses to start the page's renderer: "Unable to launch app
  dev.zeronative.sample/... for service SandboxedProcessService0: process is bad". `dumpsys duraspeed suppress_list` has
  `dev.zeronative.sample` and the mock UPI app on it, even while the app is in front. Google's app, which is on DuraSpeed's
  whitelist, starts renderers fine. Turning DuraSpeed off in settings does not empty the list, and a shell launch does not either.
  The same block stopped a manifest receiver earlier (why `DebugWakeProvider` exists). `com.example.app.rc` is on the list too.
- **Wrong first guess, corrected:** I blamed `setWebContentsDebuggingEnabled` and made it opt-in. That check was false: the
  pages it "loaded" were refused before any renderer was needed. Debugging stays opt-in anyway, as in react-native-webview.
- **What puts it on, and takes it off (checked one by one, 2026-11-03):** `am force-stop` puts it on. One tap on the app's icon in
  the launcher takes it off. A start from adb doesn't take it off, even with the launcher's intent. `am kill` and a kill -9 don't put it on.
- **Fix in our tools:** the phone scripts end the app with a kill -9 (`stopApp()` in `tools/plugin-phone/helpers.ts`), not
  `am force-stop`. With that, all 13 WebView steps pass on the Lava.
- **Real users:** "Force stop" in Android's app settings, or a cleaner app, may do the same. The next open from the icon clears it,
  so a user would hit it only on a start that doesn't come from the icon (a link, a notification). Not seen yet; not tested.
  DuraSpeed's own cleaning (`ScreenOffClean: true`) is not checked either.
- **For tests:** if WebView pages stay blank on a MediaTek phone, tap the app's icon once, and don't use `am force-stop`.
- **Not the whole story:** later the same day, with the sample on the list again (after an OTA matrix run), the WebView steps passed.
  So being on the list doesn't always block the renderer; something else (time on the list, DuraSpeed's own state) matters too. The
  rule "force-stop on, icon tap off" held in every one-by-one check; the "always blank while listed" part is not proven.
- **Risk:** if real users hit it, any WebView in a ZeroBill app shows a blank page on these phones, RN or zero-native.
  The plugin already reports a renderer that is gone; a renderer that never starts gives no event yet.
- **Evidence wanted:** the same app on a non-MediaTek phone; the list after a reboot or an icon tap.

## 37. A JS hang while a background task runs: whose is it? (review fix 1, P.5)
- **Where:** `android/runtime/.../ZnRuntime.kt` `jsError`.
- **Found by the independent review:** every hang went to the OTA safety net and the top screen, also one inside a task. A task with
  over 2 s of sync work could roll back a new bundle that isn't healthy yet. That broke "a task can't block an update".
- **Chosen:** a hang counts as the task's when a task is queued or running **and** no Activity is in front: it is logged, it doesn't
  judge the bundle, and no screen is marked failed. The task ends by its own time limit. With a screen in front, it stays a screen hang.
- **Why not always the task's while one runs:** the runtime can't tell whose JS froze. A screen's hang while a task happens to run
  would then hide a real freeze the user saw, and weaken the OTA safety net. This way the rollback trigger only gets narrower.
- **Risk if wrong:** a task that freezes the UI for 2 s with the app open still fails the top screen and can roll back a new bundle.
  That is a real freeze, so it is arguably right; the guide says not to do long sync work in a task (§36).
- **Evidence wanted:** whether Hermes' time limit fires inside a task's event at all (not tested; the reviewer couldn't confirm it).

## 38. RN names live in `@zero-native/core`, next to the zn names (RN basics pack)
- **Where:** `packages/core/src/index.ts` (`Alert`, `Clipboard`, `Share`, `Linking`, `Platform`, `Dimensions`, `PixelRatio`,
  `Keyboard`, `AppState`, `Vibration`, `ToastAndroid`, `NetInfo`, `useNetInfo`, `useWindowDimensions`, `createRef`).
- **Chosen (Pavan agreed):** export them from core, not from a `@zero-native/core/rn` entry point. Where a zn name already
  existed (`Os.share`, `Os.openUrl`, `toast`, `appState`, `onAppState`) it stays; the RN object sits on top of it.
- **Why:** one import line for authors; the build loads every core file anyway (compiler/src/plugin.ts), so a second
  entry point would save nothing. Nothing that existed breaks. `AppState` is now both a value and the old type name,
  which TypeScript allows; `AppStateStatus` is the RN type name.
- **Risk if wrong:** two names for one thing (`Os.share` and `Share.share`). The docs point ported code to the RN name.
- **Also:** `docs/rn-compatibility.md` §11 names ZeroBill, as asked. The leak audit wants neutral names in public docs:
  the public-repo pass must reword it ("the reference RN app").

## 39. `TextField` focus: `ref={createRef()}`, a new event kind (RN basics pack)
- **Where:** `packages/template/src/registry.ts` (`EventKind.ref = 16`, registry 10), `compiler/src/compile.ts`,
  `packages/core/src/text-field.ts`, `android/runtime/.../ZnTextField.kt`, `ZnKeyboard.kt` (v2).
- **Chosen:** `ref` is not a handler. The compiler gives it an event id; native keeps the field's FocusRequester under
  (instance, id) while it is composed; JS's `focus()` / `blur()` / `clear()` are `Keyboard` module calls with that pair,
  and native sends true / false on the same id when focus changes (for `isFocused()`). `createRef()`, not `useRef()`.
- **Why not a `focused={signal}` prop:** if the user blurs the field and the code doesn't set the signal back,
  setting it true again does nothing. A ref has no state to drift. **Why not `useRef`:** there are no hooks; a body runs
  once, so `createRef()` does the job without suggesting hooks exist.
- **Risk if wrong:** `focus()` on a field that is not composed (a lazy list row off screen) rejects `not_shown` (logged).
  `blur()` clears the window's focus, so it only acts when this field has focus.
- **Evidence wanted:** the phone check of the OTP demo (`examples/sample/src/RnBasicsLab.tsx`) on a few keyboards
  (Gboard, SwiftKey): focus from a tap on a box, auto-blur after 4 digits. Passed on the emulator's Gboard.
- **Also changed:** `onFocus` / `onBlur` (and the ref's focus events) are sent only for a real change. Compose calls
  `onFocusChanged` when a field appears and when the Activity is made again, and every untouched field sent `onBlur`.
  **Known edge:** if a field has focus and the phone turns, Compose doesn't give focus back, and no `onBlur` is sent for
  the lost focus (`isFocused()` stays true until the next change). Sending one when the field leaves composition would
  log "no handler" warnings each time a screen closes with a focused field, so it isn't done.

## 40. Alert: Android's own dialog, one at a time, shown again after rotation (RN basics pack)
- **Where:** `android/runtime/.../ZnAlert.kt`, `packages/core/src/alert.ts`.
- **Chosen (Pavan agreed):** `android.app.AlertDialog` with the app's theme, as RN. Alerts queue and show one at a time.
  `ZnAlert.Host()` in `ZnNavHost` shows the first one in the live Activity; a new Activity (rotation) shows it again.
  Only a button or a cancel answers. No buttons → "OK". No Activity (push, background task) → `no_activity`, logged.
  Alerts of a replaced JS runtime are dropped through the call's cancel, not `ZnNav.generation` (the generation moves
  only after the new main script ran, so an alert from its top level would be dropped by mistake).
- **Why:** RN parity, no drawing code. **Risk if wrong:** the dialog follows the app theme, not `colorScheme()`: an app
  with a light-only theme shows a light alert in dark mode (RN does the same). An app that never shows `ZnNavHost` keeps
  alerts queued for ever.

## 41. Platform, Dimensions and the keyboard come as app events, not sync constants (RN basics pack)
- **Where:** `android/runtime/.../ZnWindow.kt`, `ZnNavHost.kt` (`ReportWindow`, `ReportKeyboard`), app events 16–18
  (host API 7), `packages/core/src/platform.ts`, `dimensions.ts`, `keyboard.ts`.
- **Chosen:** DEVICE (sdk, release, model, brand, manufacturer) and a first WINDOW go right after the main script, like
  COLOR_SCHEME. Compose then sends the measured window (`LocalWindowInfo.containerSize`) and the keyboard's target height
  (`WindowInsets.imeAnimationTarget`, one event per show or hide). JS keeps them in signals.
- **Why not sync constants:** that needs a new JNI argument and a C++ global for 3 numbers. Every ZeroBill use of
  `Platform.Version` is inside a function. **Risk if wrong:** a read at a file's top level gives 0 (a warning is logged).
- **Keyboard height:** dp from the bottom of the window, so it includes the navigation bar under the keyboard. RN's
  Android number has differed between versions; ours is written in the guide. **Window:** includes the system bars
  (we draw edge to edge).
- **Evidence wanted:** split screen and font-size changes on a phone; a keyboard that changes height (emoji panel).

## 42. NetInfo: Android's "validated" for `isInternetReachable`, 250 ms settle (RN basics pack)
- **Where:** `android/runtime/.../ZnNetInfo.kt`.
- **Chosen:** `isInternetReachable` = `NET_CAPABILITY_VALIDATED` (Android's own check), no HTTP probe like the library.
  Type order as the library: bluetooth > cellular > ethernet > wifi > vpn, so a VPN over Wi-Fi reads "wifi". A burst of
  callbacks sends one event 250 ms after the last one. The network is watched only while JS listens.
- **Risk if wrong:** a network Android validated may still block our API host (a firewall), and the 250 ms delay makes
  a change arrive late. For payments, still handle `FetchError` `offline` on each call; don't gate a payment on NetInfo.

## 43. Smaller calls in the RN basics pack
- **`Vibration` needs `VIBRATE` in the app's manifest** (Pavan agreed: same as RN). The runtime doesn't add it, so apps
  that never vibrate don't list it. Without it: `not_declared`, logged once.
- **`Linking.canOpenURL`:** the runtime's manifest gains `<queries>` for VIEW with https, http, mailto, tel (merged into
  every app). It shows no list of apps; it only lets Android answer for those 4 link kinds.
- **`Linking.getInitialURL` / `addEventListener("url")`:** read-only copies of links that already opened their route.
  RN apps route from them; here routing is built in and `onLink` refuses. Kept small on purpose.
- **`URL`:** no IDNA, so a non-ASCII host throws instead of guessing. Where Bun 1.4.4 and the standard differ (4 setter
  and backslash cases, listed in `packages/core/test/url.test.ts`), we follow the standard. 791 lines, about 5 KB gzipped.
- **`requestAnimationFrame`** is a 16 ms timer: JS doesn't draw here, and a real frame callback would cross to native
  each frame for nothing.
- **`flowStore` warning at 128 KB** in every build (JS has no "debug build" flag), once per key per run.
- **`Share.share({ url })`:** RN shares `url` only on iOS; here it is shared as the text when there is no `message`, so
  iOS-style code doesn't share nothing.
- **Not built, on purpose:** `StatusBar` (route option; `setBarStyle` later if a screen needs it), toast gravity,
  `Alert.prompt` (iOS only in RN), RN's Android-only `AppState` `focus` / `blur`.

## 44. Tabs live inside one screen, not as stack entries (tabs)
- **Where:** `packages/core/src/tabs.ts`, `nav.ts`, registry 11 `Tabs` (`ZnRenderer.kt` `ZnTabs`), route option `tabs`.
- **Chosen (Pavan agreed, "make sure it is ok for other app devs"):** a tabs screen is one route. `useTabs(route)` gives the
  selected tab; a native `<Tabs selected>` container draws one child; the bar is the app's JSX. Tab names are in routes.ts,
  so they are typed, links can reach them, and the selected tab survives a kill (a `restorableSignal`, key `zn.tab`).
- **Why not each tab as its own stack entry (closer to React Navigation):** it changes the core of nav: the stack's shape,
  the saved-stack format, the "top screen" rule of impressions, the error screen per entry, and iOS later. A bundle has
  one `main.hbc`, so separate tab routes would not load less JS either.
- **Cost of the choice:** tabs share their screen's `restorableSignal` keys and its one `useImpressions`. A tab can't be
  pushed as a screen of its own. Both are written in guide notes §40.
- **Risk if wrong:** an app that needs a stack inside each tab (Instagram-style) can't have it. Today screens pushed from
  a tab cover the whole screen, bar too, which is what ZeroBill does.

## 45. A hidden tab is not drawn; its state is kept (tabs)
- **Where:** `ZnRenderer.kt` `ZnTabs`.
- **Chosen:** only the selected child is composed. The others keep their instances (JS state, slot values) and their
  Compose saved state (scroll positions) through a `SaveableStateHolder`. React Navigation's `freezeOnBlur`.
- **Why not keep every visited tab composed and just hide it:** a switch back would be a little faster, but every hidden
  tab would recompose when its data arrives (four HTTP answers at start) and keep its memory. Measured cost of a switch
  back: see docs/startup-and-performance.md (tabs rows).
- **Risk if wrong:** a `NativeView` in a hidden tab is made again on return (a WebView reloads). Documented as a "don't".
- **Default lazy** (Pavan agreed): a tab is built on first show; `preload: true` builds all at start.

## 46. Back on the only screen goes to JS only when asked (NAV BACK_WANTED, host API 8)
- **Where:** `nav.ts` `setBackWanted`, `ZnNav.backWanted`, `ZnNavHost` (a `BackHandler` when the stack has one screen).
- **Chosen:** tabs tell native "send me Back" only while a tab other than the first is shown. Otherwise the system takes
  Back on the last screen at once, as before.
- **Why not ask JS on every last-screen Back:** Android 14's predictive "back to home" animation needs to know ahead that
  the app won't handle Back. A handler that is always on would turn that animation off for every app.
- **Also changed:** `useBack` can now be called in any part of a screen (it finds its screen through the owner, like
  `restorableSignal`), and a screen can have several handlers: the newest is asked first. Before, a second `useBack` in a
  screen replaced the first. No sample or test relied on that.
- **Risk if wrong:** a `useBack` on a root screen's first tab is still not asked (the system takes Back). Same as before.

## 47. A link to a tabs screen in the stack goes back to it (tabs)
- **Where:** `nav.ts` `onOpenLink` / `tabHostFor`.
- **Chosen (Pavan agreed):** if a screen of the link's route is in the stack and its own params match the link's, the
  screens above it close and the link's tab is selected. Otherwise the route is pushed as before. `onLink` decides first.
- **Why:** React Navigation's `navigate` does the same, and a second home screen on the stack would be a bug.
- **Risk if wrong:** a link during a payment would close the payment screen. Apps must refuse links in `onLink` while a
  payment is open (guide notes §40 says so).
- **Also changed (host API 8):** a cold link that matches the start route itself now gives its params to the start screen
  (before, they were dropped and `onLink` was never asked). Refused, the start screen opens without them.

## 48. `useFocus` and `tabs.onFocus` (tabs)
- **Where:** `nav.ts` `useFocus`, `watchFocus`; `tabs.ts` `onFocus`.
- **Chosen (Pavan agreed):** focus = the screen is on top of the stack (and, in a tab, the tab is selected). It is
  computed in JS from the stack; nothing new from native. The returned function runs on blur, like `useFocusEffect`.
- **Why:** ZeroBill reloads a tab's data on focus, so the cashback balance is fresh after a payment.
- **Not done:** focus does not follow the app going to the background (React Navigation doesn't either). Use `onAppState`.

## 49. Pull to refresh: drawn on the list itself, Android's look, a 1 second wait for JS (registry 12)
- **Where:** `android/runtime/.../ZnPullRefresh.kt`, `ZnRenderer.kt` (vertical `Scroll`, `ZnLazyList`),
  `compiler/src/compile.ts` `refreshControl()`.
- **Chosen:**
  - Compose foundation only. The pull is the scroll left over at the top (a `NestedScrollConnection`). The disc is
    drawn with `drawWithContent` on the Scroll's / LazyColumn's own modifier chain, not in a wrapper `Box`, so the
    layout rules (flex, stretch) stay exactly as before. The disc's position is read only while drawing (no
    recomposition during a pull); `refreshing` is read in a `snapshotFlow`, so a change doesn't recompose the list.
  - Android's look: the content doesn't move, a disc slides over it. Line 80 dp, the disc moves at half the finger's
    speed, past the line at half again, up to 120 dp. Like material3's numbers, drawn by hand (no material shadow:
    two faint rings).
  - Controlled (ARCHITECTURE §9.7): a release past the line sends `onRefresh` and shows the spinner at once; then
    `refreshing` decides. If JS doesn't set `refreshing` to true within **1 second**, the spinner goes away.
  - A pull only starts while the spinner is hidden; a fling that ends a pull is eaten (the content doesn't jump).
  - React Native's `refreshControl={<RefreshControl .../>}` is turned into the flat props by the compiler (Pavan: do it if
    easy). It must be written inside the prop: RN code that keeps it in a variable needs a small edit.
- **Why:** a wrapper box would change how a `flex: 1` list is measured, and material3 would add ~1 MB and a second
  design system. The wait lets a refresh that never sets `refreshing` still end cleanly.
- **Risk if wrong:** a JS thread blocked for over 1 second (a long GC pause) after a pull makes the spinner go away and
  come back when `refreshing` arrives. A sync `onRefresh` that sets true and false in the same turn shows the spinner
  for 1 second. iOS: SwiftUI's `.refreshable` moves the content; it maps as "send onRefresh, then await `refreshing`
  false" [check when iOS starts].
- **Not done:** `progressViewOffset` (where the disc rests, for a header drawn over the list), `size`, `enabled`. Add
  when a screen needs them.

## 50. SVG is compiled at build time and drawn by our own small interpreter (SVG design, not built)
- **Where:** `docs/svg.md` §3, §5, §6, §8.
- **Chosen:** the compiler reads `.svg` files and inline `<Svg>` at bundle build time, checks them against a fixed subset, and writes
  compact draw data. The phone draws it with Compose `DrawScope` calls (paths, strokes, gradient shaders, clips, layers). No XML on the
  phone, no SVG library. Text, images, patterns, filters, non-trivial masks and SMIL fail the build with a hint.
- **Why:** OTA needs data, not APK resources (rules out VectorDrawable); parsing XML on the phone costs cold start and a library
  (AndroidSVG); Compose's `ImageVector` has no group opacity, dashes or gradient matrix, and keeps a bitmap per instance. ZeroBill's 27 SVG
  files and 13 inline SVGs use nothing outside the subset except one pattern and one Figma mask (which the compiler turns into a clip).
- **Risk if wrong:** our drawing differs from browsers in a corner case (stroke joins under skew, gradient spread, clip smoothness on old
  Android), or authors hit build errors for exports we refuse. A library would cover more features for free.
- **Other options:** AndroidSVG at runtime (more features, ~100+ KB, parse per start); a WebView (no); bitmaps exported at build time
  (lose runtime colours and animation).
- **Evidence wanted:** a side-by-side check of real SVGs (S.4, S.5 in `docs/svg.md`), and how many real files fail the build.

## 51. SVG part overrides are one `parts` prop, grouped by part (SVG design, not built)
- **Where:** `docs/svg.md` §4.3.
- **Chosen:** `<Logo parts={{ ring: { fill: brand() }, dot: { opacity: 0.4 } }} />`. Each value is a slot when it changes at runtime; the
  compiler writes one `SvgPart` template node per part. A part's `fill` / `stroke` replaces the paint of every shape inside it.
- **Why:** phase 2 adds per-part `animate`, which belongs next to the part's values; one prop can later be typed per file; no new child
  rules in JSX.
- **Risk if wrong:** a nested object prop is new in zn (only `<NativeView props>` is close). The lead session's first idea,
  `fill={{ ring: brand }}`, is shorter for one colour.
- **Other options:** per-attribute maps (`fill={{ ring }}`, `opacity={{ dot }}`); `<Part id="ring" fill={...} animate={...} />` children
  (reuses the existing `style` / `animate` props exactly, but part names can't be typed and children get special rules).
- **Evidence wanted:** how screens look after porting the RN app's 13 inline SVG files.

## 52. SVG draw data lives in the template file, not in its own file (SVG design, not built)
- **Where:** `docs/svg.md` §6.1, §7.
- **Chosen:** the draw data is an ASCII string prop of the `Svg` node in `main.zn.ui`. The template writer stores each distinct string
  once, and the phone parses an SVG only when it is first drawn (cached per string, shared by all instances).
- **Why:** no change to the template format, bundle files, bundle loading, OTA checks or signing; an older app never meets a new file.
  Pavan's wish that the `.svg` "exists in the output and is attached where it's used" holds: one copy per bundle, used by every node.
- **Risk if wrong:** template reading decodes all SVG strings at cold start (estimated a fraction of a ms per 100 KB, not measured);
  choosing an SVG by a runtime value would have to send the whole string through the bridge, so phase 1 offers only ternaries.
- **Other options:** a `main.zn.svg` pack file, read with the templates and indexed by number (cheap runtime choice, but a new bundle
  file that `ZnBundles`, OTA bundles and the start path must handle); binary data in the template (~30 % smaller, needs a new value kind).
- **Evidence wanted:** `main.zn.ui` size and template read time with the lab screen (S.6), and whether real apps need runtime choice.
- **Update (built, 2026-11-03):** the "~30 % smaller binary" number was a guess for the first format (absolute cubics). The built format
  writes paths as SVG path text (entry 53), which is already compact; a binary form would now save much less.

## 53. SVG paths are written as minified SVG path text, arcs kept (SVG phase 1, built)
- **Where:** `docs/svg.md` §6.1, §14; `compiler/src/svg-data.ts` (`writePath`); `ZnSvg.kt` reads paths with Compose's `PathParser`.
- **Chosen:** each path is SVG path data (`M9.55 15.15l8.47-8.47q.3-.3.7-.3`), relative or absolute per command (whichever is shorter),
  with `Q`, `T`, `S`, `H`, `V` and `A` kept. Arcs become cubics only when a transform changes their shape. Numbers are rounded to
  1/2,000 of the viewBox's larger side, and relative steps are taken between rounded points, so rounding never adds up.
- **Why:** the first version (absolute `M L C Z` only, as the design said) made draw data bigger than the source: 162 KB of RN assets
  became 190 KB, icons ~1.2 KB each. Path text: 180 KB → 112 KB, icons ~450 B. Compose's `PathParser` (already used by `Icon`) reads it,
  so the phone code stayed small.
- **Risk if wrong:** the phone depends on `PathParser`'s reading of minified paths (it is lenient: a bad path may draw wrong rather than
  fail); the iOS renderer later needs its own path reader with arcs. A rounding error near a sharp corner at 1/2,000 (0.012 dp on a
  24 dp icon) is far below a pixel.
- **Other options:** absolute cubics (simplest reader, biggest data); a binary path form (smaller, new value kind in the template format).
- **Evidence wanted:** the lab screen on the Lava next to the source SVGs. The browser side-by-side check of 39 files (draw data turned back
  into SVG) showed no strong pixel differences. **Update:** the lab looks right on the Lava (debug and release).

## 54. A big SVG is still parsed on the main thread at its first draw (SVG phase 1, measured on the Lava)
- **Where:** `docs/svg.md` §13, §14; `ZnSvgCache.get` in `ZnSvg.kt`.
- **Chosen:** no change. Each distinct SVG is parsed when it is first drawn, on the main thread, and cached.
- **Measured:** a 23 KB SVG (~400 shapes) parses in 6.3–7.3 ms right after an adb install (no AOT code), 1.4–1.5 ms after
  `compile -m speed`. Icons: 0.13–0.5 ms, then 0.03–0.1 ms. The design said: move parsing off the main thread above ~4 ms.
- **Why not now:** the slow case is uncompiled code, which hits every zn screen the same way, not only SVG; real apps have few SVGs that
  big (the largest RN asset is 30 KB of XML, about 20 KB of draw data); and a background parse needs a "not ready yet" frame, which can
  flash. The bigger win for all screens would be a baseline profile for the runtime (none exists today).
- **Risk if wrong:** one dropped frame (90 Hz: 11 ms budget) the first time a big illustration shows after an install or update.
- **Other options:** parse every SVG of the bundle on the I/O thread after the first frame; a baseline profile with the SVG reader and
  Compose's `PathParser` in it.
- **Evidence wanted:** first-draw time of a real big illustration on a Play-installed build (cloud profiles), and on a slower phone.

## 55. `repeat` counts all plays, not extra ones (motion, registry 11)
- **Where:** `docs/svg.md` §9; `timing()` in `compiler/src/compile.ts`; `motionAt` in `ZnAnimation.kt`.
- **Chosen:** `repeat: 2` plays twice in all; `"forever"` loops. Same as CSS `animation-iteration-count`, Compose `repeatable(iterations)`,
  RN `Animated.loop({ iterations })` and Reanimated `withRepeat(x, n)`.
- **Why:** authors coming from any of these get what they expect. The word "repeat" alone could mean "play again n times" (n + 1 in all).
- **Risk if wrong:** an author who reads it as extra plays sees one play fewer. `repeat: 0` and `1` would mean the same, so `0` is a build
  error that names the rule.
- **Other options:** `iterations` as the name (clearer, longer); `repeat` as extra plays (like GSAP).
- **Evidence wanted:** what authors write first in the lab and in ZeroBill screens; any confusion in review.

## 56. `paused` and `replay` are element props, not timing options (motion, registry 11)
- **Where:** `docs/svg.md` §9; `Base` in `packages/ui/src/index.ts`; `znMotionInputs` in `ZnAnimation.kt`.
- **Chosen:** `<Box paused={p()} replay={n()} animate={...} />`. They change at runtime (slots). The timing inside `animate` stays build-time.
  The approved plan listed `paused` with the timing options; it moved while building.
- **Why:** `animate` is folded at build time into one string. A runtime `paused` inside it would need a runtime timing, a new value kind.
  As element props they are plain slots, and one `paused` covers every looping prop of the element (CSS `animation-play-state` works the same).
- **Risk if wrong:** no way to pause one prop of an element while another loops. Rare; split the element in two.
- **Other options:** a runtime `animate`; a `paused` per prop (`animate={{ rotate: { ..., paused } }}`) compiled to a slot per prop.
- **Evidence wanted:** a real screen that needs per-prop pause.

## 57. A new registry entry kind, `format`, for new forms inside a string value (motion, registry 11)
- **Where:** `Formats` in `packages/template/src/registry.ts`; the check in `writer.ts`; `registry.lock.json` (`format:timing.motion`).
- **Chosen:** the `~` options in a timing string (`95=t1000e3~f0~r-1`) are a "format" added in registry 11. The writer raises the
  bundle's registry to 11 only when a value uses them; an old-style `animate` still asks for the old registry.
- **Why:** an older app reads `t1000e3~f0~r-1` as a plain 1 s tween with the default easing (checked in its parser: `"3~f0~r-1"` is not a
  number, so the easing falls back to 0) that plays only on a value change. A spinner would never turn.
  Raising the registry makes the older app refuse the bundle, as for any new prop, instead of drawing it wrong. Bundles without loops
  still run on old apps.
- **Risk if wrong:** a future string form that forgets to add a `Formats` entry would slip past the check. The lock file lists the kind, so
  `gen:registry` shows it in review.
- **Other options:** a new prop (`animateMotion`) for the new form; always raising the registry for any `animate`.
- **Evidence wanted:** none; review the idea once.

## 58. SVG moved from registry 10 to 11 (motion, 2026-11-03)
- **Where:** `packages/template/src/registry.ts` (history comment), `registry.lock.json`, `Registry.kt`; `docs/svg.md` §7.
- **Chosen:** main took registry 10 for the RN basics `TextField` `ref` (event id 16). The SVG branch's entries are now in 11. The ids did
  not change and do not clash with main's.
- **Why:** the version must only grow, and main already shipped 10 in its history.
- **Risk if wrong:** none for users (nothing shipped with SVG yet). When this branch merges main, `registry.ts`, `registry.lock.json` and
  `Registry.kt` conflict; keep both sides' entries, then run `bun run gen:registry`.
- **Other options:** none useful.
- **Evidence wanted:** a clean `gen:registry` and registry test after the merge.
- **Merged main (2026-11-03):** done as written: event `ref` (16, since 10) and the SVG entries (since 11) are both in the lock; no id is
  used twice. The RN basics pack had also taken second-opinions 38–43 and guide §39, so the SVG entries moved to 44–56 and the SVG guide
  section to §40, with every link fixed.

## 59. Animated .svg files: geometry becomes a scale and a move (S.14, built)
- **Where:** `docs/svg.md` §15; `motionParts` in `compiler/src/svg-anim.ts`.
- **Chosen:** SMIL / CSS changes to `cx`, `cy`, `r`, `rx`, `ry`, `x`, `y`, `width`, `height` on a circle, ellipse or rect with no stroke become
  the part's scale and translate around the shape's centre. A size that starts at 0 is baked at its largest and scaled down. The same
  change on a stroked shape fails the build (the stroke would grow with it).
- **Why:** for a filled shape it is exact, and it needs no new runtime feature: the phone already moves parts. 44 of the 104 corpus files
  animate geometry this way (bars, dots, pulses).
- **Risk if wrong:** a shape with rounded corners (`rx` on a rect) whose width animates gets its corners stretched too; the corpus
  has none. A size baked at its largest is drawn at that precision, so a tiny-to-huge pulse may look slightly soft at its smallest.
- **Other options:** real geometry animation (the phone rebuilds the circle / rect path each frame): exact for strokes and corners,
  but a new draw-data form and runtime code.
- **Evidence wanted:** files that people actually bring with stroked growing shapes (`puff`, `ball-triangle` in the corpus).

## 60. SMIL begin chains are solved at build time into one cycle (S.14, built)
- **Where:** `solveBegins`, `smilTiming`, `mergeSame` in `compiler/src/svg-anim.ts`.
- **Chosen:** every SMIL start time over the first 120 s is worked out (offsets, `x.begin`, `x.end`, restarts). A series that repeats
  evenly becomes one loop: period P, its first start as `delay`, and the wait as a hold inside the cycle. Several animations of one
  attribute merge by SMIL's rule (the one that started last sets the value).
- **Why:** 24 of the 104 corpus files use chains; the phone has no SMIL clock and needs none.
- **Risk if wrong:** a chain whose first round differs from the rest shows the steady cycle from the start; before an animation's
  first start, the phone shows its first keyframe, where SMIL shows the attribute's base value (the same in every corpus file).
  A chain that never settles fails the build.
- **Other options:** a small SMIL timeline engine on the phone (exact, more runtime code, per-frame work).
- **Evidence wanted:** a loader that looks wrong in the lab next to the browser.

## 61. Third-party SVG files live in the repo as test fixtures (S.14)
- **Where:** `compiler/test/fixtures/animated-svg/` (104 files, with each set's MIT licence), `examples/sample/src/svg/loaders/` (6).
- **Chosen:** keep unchanged copies with their licence files and a README naming source and commit, so the corpus test runs offline
  and lists each refused file by name. The sample's six copies only add `fill="currentColor"`.
- **Why:** Pavan asked for the corpus "as tests"; MIT allows copies with the notice kept.
- **Risk if wrong:** the public repo later carries third-party files; they must keep the licence files (they do).
- **Other options:** fetch the corpus in CI (network in tests), or our own handmade SVGs only (misses what real files do).
- **Evidence wanted:** a licence check before the public repo.

## 62. One easing per keyframe segment, and a step easing, in the timing format (S.14, registry 11)
- **Where:** the `z` option in `ZnTiming` (`android/runtime/.../ZnAnimation.kt`), `encode` in `compiler/src/svg-anim.ts`.
- **Chosen:** `~z<seg:seg>`, one easing per segment between keyframes (`3` linear, `5` step, `4,x1,y1,x2,y2` a curve).
  Easing id 5 is a new step (holds the start value, jumps at the end). `fill-opacity` / `stroke-opacity` go into the colour's
  alpha, not the part's opacity.
- **Why:** SMIL `keySplines` and CSS per-keyframe timing need it (16 corpus files), and `calcMode="discrete"` / `step-end`
  need a step. Registry 11 is not shipped yet, so it is a free change to the format (entry 57). A fill-only fade must not fade the stroke.
- **Risk if wrong:** a phone on an older runtime reading a newer template ignores `z` (unknown options are skipped) and plays
  every segment with one easing: a wrong curve, not a crash.
- **Other options:** split each segment into its own sub-animation (many more parts), or bake the curve into many keyframes (big strings).
- **Evidence wanted:** none before shipping; the lab's Ring and Bars loaders use it.

## 63. SVG phase 3 is registry 12, though 11 has not shipped (2026-11-03)
- **Where:** `packages/template/src/registry.ts` (ids 192–196), `registry.lock.json`, `Registry.kt`; `docs/svg.md` §7.
- **Chosen:** raise to 12, as `docs/adding-components.md` §1 says (once per step). `gen:registry` refuses new entries at a
  version the lock already has.
- **Why:** the rule keeps every entry's version right without anyone remembering which versions shipped.
- **Risk if wrong:** none for users. Bundles that use the new props ask for 12; the rest still ask for 11 or less.
- **Other options:** hand-edit the lock to add them to 11 (fewer numbers, but breaks the rule the tests check).
- **Evidence wanted:** none.

## 64. One animated dash becomes trims, cut at the line's ends (phase 3, built)
- **Where:** `bakeStroke` and `clampSplit` in `compiler/src/svg-anim.ts`; `docs/svg.md` §16.
- **Chosen:** when every keyframe has one dash and a gap at least as long as the line (and the offset keeps other dashes
  away), the visible piece is `[-offset, dash - offset]` along the line, clamped to it. That becomes `trimStart` /
  `trimEnd` with no `trimOffset` (trims wrap round; SVG dashes don't). Segments are split where a clamped end reaches the
  line's end, with the easing split too, so it stays exact. The shape is then drawn solid.
- **Why:** it is the trick nearly every "ring" and "draw the line" file uses, and trims already exist on the phone.
- **Risk if wrong:** a line of several pieces (two `M`s) dashes differently in SVG: it falls to the other mode or fails.
  The length is measured in small steps (64 per curve), so the fractions can differ from the phone's own measure by
  about 0.01 %.
- **Other options:** real dash animation on the phone for every pattern (more runtime work per frame).
- **Evidence wanted:** a file with a moving multi-dash pattern that people want; then `dashOffset` plus animated dash
  lengths.

## 65. Morphs are mixed number by number in one cubic form (phase 3, built)
- **Where:** `cubicForm` in `compiler/src/svg-anim.ts`; `ZnSvgMorph` in `ZnSvg.kt`.
- **Chosen:** every keyframe is written as M / C / Z (lines and arcs become cubics, exactly), and keyframes must have the
  same commands. The part's `morphAt` (an ordinary animated number) says where it is; -1 is the shape's own `d`.
- **Why:** SMIL itself only morphs paths with the same structure, and this needs no path matching on the phone. Reusing
  the timing system gives easing, repeat, pause and replay for free.
- **Risk if wrong:** files whose keyframes only match after a smarter conversion (a line in one, an arc in another, with
  different cubic counts) fail at build. Flubber-style matching would cover them, at a cost.
- **Other options:** resample both paths to the same number of points at build time (works on any pair, not exact).
- **Evidence wanted:** real files that fail with "the paths of this morph don't match".

## 66. Part name types are generated files next to each .svg, not committed (phase 3, built)
- **Where:** `writeSvgTypes` in `compiler/src/compile.ts`; `.gitignore`; the sample's tsconfig.
- **Chosen:** `logo.d.svg.ts` beside `logo.svg`, written when a TSX file imports it (only when it changes), and ignored by
  git. TypeScript's `allowArbitraryExtensions` picks it up before the `*.svg` wildcard.
- **Why:** autocomplete and typo errors in the editor with no build step of their own. Without the file the old loose
  type still works, so a fresh clone type-checks.
- **Risk if wrong:** files in source folders surprise people; an app that forgets the tsconfig flag gets no types (no harm).
  A stale file after a part is renamed fixes itself on the next build.
- **Other options:** one generated `svg-types.d.ts` per app (needs a module name per file); commit the files.
- **Evidence wanted:** Pavan's view on files in source folders.

## 67. A non-scaling stroke is a negative width in the draw data (phase 3, built)
- **Where:** `svg.ts` shape(), `svg-data.ts` writer, `ZnSvgReader.strokeSpec` and `strokeFor` in `ZnSvg.kt`.
- **Chosen:** no new token in format v1: a negative width means "that many dp". The phone divides by the scale in force
  (viewBox to screen, the shape's matrix, the parts' scales) each draw.
- **Why:** smallest change, and the format had not shipped. Dashes on such a stroke fail at build, because their lengths
  would need the same rule.
- **Risk if wrong:** a part that scales a group non-uniformly uses its average scale. An older reader refuses the
  negative width, so the draw data is a new form: the registry `format` "svg.nonScaling" (since 12) makes a bundle that
  has one ask for registry 12, also for a static file (found while writing this entry; test in `registry.test.ts`).
- **Other options:** a flag token after the stroke, or a new format version Z2.
- **Evidence wanted:** none more.

## 68. `begin="click"` starts on a tap anywhere on the Svg (phase 4, built)
- **Where:** `solveBegins` in `compiler/src/svg-anim.ts` (the `~w` timing option); `ZnSvg` composable (`pointerInput`)
  and `znMotion` in `ZnAnimation.kt`; `docs/svg.md` §17.
- **Chosen:** a browser starts a `click` animation when the named element is clicked. We start it on a tap anywhere on the
  `<Svg>` node, and each tap starts it again. The tap is counted, not consumed, so a `Pressable` around it still works.
  A tap mixed with a time (`begin="click;2s"`) fails at build.
- **Why:** Pavan: "follow the industry standard". Lottie and Rive start on a tap of the whole view; small icons are too
  small to hit one shape inside them. Hit-testing shapes on the phone would need a path-contains check per tap.
- **Risk if wrong:** a file with two click targets (two buttons in one SVG) plays both on any tap. Rare in icon and
  loader files; the build could refuse files with two different click sources.
- **Other options:** hit-test the clicked element's shape; refuse `click` and ask for `replay`.
- **Evidence wanted:** a real file with more than one click target.

## 69. Filters below Android 12 draw a plain shadow, not a blur (phase 4, built)
- **Where:** `ZnSvgEffects.drawFiltered`; the shadow list at the end of each "FL" in `svg-data.ts`; `docs/svg.md` §17.
- **Chosen:** Android 12+ runs the filter as a `RenderEffect`. Older phones draw the group without the filter, under the
  plain drop shadows the compiler found in it (`BlurMaskFilter`, Android 9+). A blur alone draws sharp.
- **Why:** Pavan: "your call". There is no filter engine before 12. A software blur of a bitmap per frame is too slow on
  the low-end phones we target; a missing shadow looks fine, a slow list doesn't.
- **Risk if wrong:** a design that needs the blur to read (frosted glass with text on it) looks different on Android
  9–11 (how many ZeroBill users have those is not known yet).
- **Other options:** blur once into a cached bitmap (fine for still pictures, not for moving ones); refuse filters below 12.
- **Evidence wanted:** the lab on an Android 9–11 phone or emulator; share of such phones among ZeroBill users.

## 70. Small calls in the animated import (phase 4, built)
- **Where:** `compiler/src/svg-anim.ts` (`motionTrack`, `cssMotion`, `mediaApplies`, `resolveVars`, the begin hold).
- **Chosen:**
  - `calcMode="linear"` on a motion path moves at an even speed, like `paced`. Browsers do the same for a path.
  - CSS `offset-path` coordinates are read in the parent's space (the element's own transform is not applied first).
  - `@media (prefers-reduced-motion: reduce)` rules are skipped: "Remove animations" already shows the rest values.
  - A loop with a delay shows its first keyframe during the delay; only a single play gets the base value first.
  - Custom property names are read in lower case.
- **Why:** each one matches what loader files on the web need, and keeps the phone side simple.
- **Risk if wrong:** a file drawn slightly differently from Chrome (a wrong pose for the delay, a `--Name` and `--name`
  that clash). None of the 182 corpus files hit them.
- **Other options:** a base hold in every loop (one more keyframe per loop); case-kept names.
- **Evidence wanted:** a real file where Chrome and the phone differ.

## 71. Big SVGs are read in the background after the first frame, from 8 KB (phase 4, built)
- **Where:** `ZnSvgCache.prefetch` / `bigOf` in `ZnSvg.kt`, set in `ZnTemplates.templatesOf`; `docs/svg.md` §13, §17.
- **Chosen:** at load, the file's draw data strings of 8 KB or more are listed. After the first frame a background
  thread reads them one at a time and hands each to the main thread. A draw before that still reads on the main thread.
- **Why:** Pavan: "your call". The measured cost was 6–7 ms for a 23 KB SVG on a fresh install (§13). Reading before the
  first frame would slow every cold start; small SVGs cost less than the thread hop.
- **Risk if wrong:** a bundle with many big SVGs keeps one background core busy for a few frames after start. Memory:
  every big SVG in the file is kept parsed, also ones the user never opens.
- **Other options:** read on first composition (not first draw) in the background and draw nothing until ready; a lower
  or higher limit.
- **Evidence wanted:** a startup trace on the Lava with a real bundle that has big SVGs.

## 72. A non-scaling stroke is drawn in screen space only when the scale is uneven (phase 4, built)
- **Where:** `screenStroke` / `strokePath` in `ZnSvg.kt`; `docs/svg.md` §17 (known limit 4).
- **Chosen:** when the matrix from the shape to the screen is a plain scale plus a turn, the old way stays (width divided
  by the scale). Otherwise the path is moved into screen space and stroked there at its dp width. Not inside a filter's
  own drawing, a mask's content or a pattern tile (they keep the average scale).
- **Why:** it is what the browser does, and the common case pays nothing extra.
- **Risk if wrong:** a stretched chart line inside a filtered or masked group is a little thicker or thinner on one axis.
- **Other options:** always draw non-scaling strokes in screen space (one more path transform per stroke per frame).
- **Evidence wanted:** none.

## 73. All SVG at registry 13 after main took 11 and 12 (merge, 2026-11-03)
- **Where:** `packages/template/src/registry.ts` (`Added`, the version comment), `registry.lock.json`, `Registry.kt`;
  `docs/svg.md` §7; this file's entries 50–72 (were 44–66).
- **Chosen:** SVG phases 1–4 were built as registry 11, 12 and 13 on their branch. Main took 11 (Tabs) and 12 (pull to
  refresh) first. Every SVG entry now says 13: components, props, dynamic props and the formats "timing.motion",
  "svg.nonScaling", "svg.effects", "timing.tap". Pavan's call, the parent session agreed.
- **Why:** none of 11–13 had shipped outside the sample, so one number is simplest. A bundle with any SVG or any
  "~" timing asks for 13.
- **Risk if wrong:** none for users. "timing.motion" (loops, keyframes on every element, not only SVG) now needs 13,
  so a non-SVG bundle that uses a loop also asks for 13. That is the same app, as nothing between 11 and 13 shipped.
- **Other options:** 13, 14 and 15, one per phase (keeps the phase history in the numbers).
- **Evidence wanted:** none.

## 74. An element with no handlers lets taps through, except an absolute layer (RN props pack 2, built)
- **Where:** `android/runtime/src/main/java/dev/zeronative/runtime/ZnTouch.kt` (`znBlockTouches`), `ZnRenderer.kt`
  (`ZnNode`), `ZnTemplate.kt` (`absoluteLayer`); guide-notes §43.
- **Pavan decided (2026-11-04): option B, scoped.** An absolute `Box` / `Column` / `Row` / `Stack` with a background or
  children stops taps without `pointerEvents`, as an RN view does: that is the "busy layer" case. Everything else keeps
  Compose's rule (a tap goes past an element that has no handler). Runtime only, no registry change; parents (a
  `Pressable` around a badge) still get the tap. The rest of this entry is the first build, kept for the record.
- **Chosen at first:** zn keeps Compose's rule: a tap goes past an element that has no handler to the one under it. Written
  `pointerEvents="auto"` or `"box-only"`, an element stops taps, as every RN view does. `"none"` / `"box-none"` as in RN.
- **Why:** making every element stop taps (RN's rule) changes how every zn screen built so far behaves, a big change
  for one pack. Ported RN code mostly writes `pointerEvents="none"` on overlays, which works either way.
- **Risk if wrong:** a ported RN "busy layer" (a see-through `View` over the screen during a payment, with no
  `pointerEvents`) stops taps in RN but not in zn: a second tap on Pay can get through. The guide says to write
  `pointerEvents="auto"` there. **This is the one I'd most like Pavan to decide.**
- **Other options:** RN's rule for all `Stack` children (overlapping is only possible there), behind a registry
  version; or a compile warning for an absolute full-size child with no `pointerEvents`.
- **Evidence wanted:** how many ZeroBill overlays rely on RN's blocking (a grep for absolute `View`s over pressables).

## 75. hitSlop is Compose's minimum touch size, not touchBoundsExpansion (RN props pack 2, built)
- **Where:** `ZnTouch.kt` (`WithHitSlop`).
- **Chosen:** the Pressable's minimum touch size becomes its size plus the slop on each side, through a
  `ViewConfiguration` for that element. Each axis takes its larger side's slop on both sides.
- **Why:** Compose 1.12's `touchBoundsExpansion` only works for a stylus (its hit test checks the pointer type; tested
  on the emulator: a finger tap outside got nothing). The minimum touch size is the only way a finger may hit outside.
- **Risk if wrong:** a tap in the slop loses to another tappable element right under the finger, where RN would give it
  to the one on top. Uneven slops (`{ left: 4, right: 20 }`) reach 20 on both sides.
- **Other options:** a bigger invisible touch box drawn over the element (changes layout); our own hit test.
- **Evidence wanted:** a phone check of small icon buttons near other buttons in a ported screen.

## 76. The iOS shadow keys are dropped, not drawn (RN props pack 2, built)
- **Where:** `compiler/src/compile.ts` (`IGNORED_STYLE_KEYS`).
- **Chosen:** `shadowOffset`, `shadowOpacity`, `shadowRadius` are accepted and dropped, as RN on Android does.
- **Why:** "same as RN" (Pavan): ZeroBill's Android app shows only the `elevation` shadow today, so a port looks the
  same. Compose 1.12 has `dropShadow` (offset, radius, opacity) if we ever want iOS-like shadows.
- **Risk if wrong:** a designer who tuned shadows on iOS sees none of that on Android (as in the RN app).
- **Other options:** draw them with `dropShadow` when they are set (a visible change from the RN app).
- **Evidence wanted:** none.

## 77. StatusBar backgroundColor is drawn by zn, per screen (RN props pack 2, built)
- **Where:** `ZnSystemBars.kt`, `ZnNavHost.kt` (`barStrips`, `BarIcons`).
- **Chosen:** `<StatusBar>` / `<NavigationBar>` belong to their screen (the screen entry they are drawn in, also from a
  Modal or Sheet window). The top screen's merged values set the icons and `hidden`; each screen draws its own colour
  strips behind the bars, under its content. With a navigation bar colour, Android's own scrim is turned off.
- **Why:** Android 15+ (we target 36) ignores `window.statusBarColor` / `navigationBarColor`. Drawing it ourselves works
  on every version, and per screen it moves with the screen during a push.
- **Risk if wrong:** 3-button navigation not checked on a phone (only gesture navigation on the emulator). `hidden` uses
  "swipe shows it for a moment"; a full-screen app may want a different behaviour.
- **Other options:** RN's imperative `StatusBar.setBarStyle` (global, not per screen); not built.
- **Evidence wanted:** a 3-button-navigation phone with `<NavigationBar backgroundColor>`.

## 78. RN's Modal is its own window with no look of its own (RN props pack 2, built)
- **Where:** `ZnModal.kt`.
- **Chosen:** a Compose `Dialog` window over the whole screen (no system dim), the content laid out like a Column that
  fills it, fade / slide of 250 ms, the keyboard always pushes the content up, the bar icons copied from the app window.
  Back sends `onRequestClose`; only JS closes it.
- **Why:** as RN on Android: ZeroBill's dialogs draw their own dim and card inside a `transparent` Modal. A separate
  "centred dialog" component would need a rewrite of each.
- **Risk if wrong:** a Modal and a Sheet open at once, or a Modal over a native screen: not checked. RN's slide is
  about 300 ms with its own curve; ours is a plain 250 ms tween.
- **Other options:** draw it inside the screen's window (cheaper, but it can't cover the status bar or come above a
  Sheet).
- **Evidence wanted:** ZeroBill's `TxnV1ProcessingModalSheet` ported and compared side by side.

## 79. Registry 14 is only the long press change; the rest of the pack is 15 (RN props pack 2)
- **Where:** `packages/template/src/registry.ts`, `registry.lock.json`.
- **Chosen:** as the parent session planned: 14 = `hasLongPress` (the long press fix the SVG session left), 15 =
  everything else. The lock steps 13 → 14 → 15, as its rules want.
- **Why:** 14 was reserved for the long press fix before this pack was planned; bundles without `hasLongPress` behave
  as before on any app. Nothing between 13 and 15 has shipped.
- **Risk if wrong:** none for users. A bundle that uses only the long press change runs on a 14 app.
- **Other options:** all at 14.
- **Evidence wanted:** none.

## 80. PDF downloads use the app's OkHttp, so the plugin compiles against it (PDF plugin, built)
- **Where:** `plugins/pdf/android/build.gradle.kts` (`implementation("com.squareup.okhttp3:okhttp:5.5.1")`),
  `PdfModule.kt` (`client`).
- **Chosen:** downloads go through `ZnFetch.client.newBuilder()`, with our own redirects, a 30 s read limit and a 5 min
  call limit. To compile, the plugin names OkHttp 5.5.1, the same version the runtime ships. The brief said "no new Maven
  dependency"; the plan recommended this (decision A) and Pavan said go, 2026-11-03.
- **Why:** pinning or interceptors an app sets with `ZnFetch.configure` then cover PDFs too, and connections are shared.
  The APK gains 0 bytes: Gradle resolves one OkHttp.
- **Risk if wrong:** if the runtime moves to another OkHttp, this line must move with it, or Gradle takes the higher one.
- **Other options:** (a) `HttpURLConnection`: no Gradle line, but it skips the app's pinning; (b) make the runtime expose
  OkHttp as `api`: a runtime change for one plugin.
- **Evidence wanted:** none, unless a second plugin needs the client; then (b).

## 81. A redirect to another host drops the app's headers (PDF plugin, built)
- **Where:** `PdfModule.kt` (`fetch`), `PdfRules.sameOrigin`.
- **Chosen:** redirects are followed by hand, up to 5. Each target must pass the https rule. The app's headers go only
  to the same scheme, host and port as the first URL; elsewhere the request goes with no headers.
- **Why:** ZeroBill sends its login token as a custom header (`_zcc`). OkHttp drops only `Authorization` across hosts,
  so a redirect to a CDN would carry the token there. Browsers' `fetch` keeps custom headers too.
- **Risk if wrong:** a server that redirects to another host which also needs the token fails with `http` 401/403.
- **Other options:** keep headers on every redirect (like OkHttp); an option `headersOnRedirect: true`.
- **Evidence wanted:** what ZeroBill's receipt endpoint does: serve the PDF itself, or redirect to a signed GCS link.
  Both work now.

## 82. PdfRenderer runs in the app's own process, on one thread for the whole app (PDF plugin, built)
- **Where:** `PdfDoc.kt` (`PdfThread`).
- **Chosen:** every PdfRenderer of the app (all views, and the module's check after a download) runs on one thread,
  `zn-pdf`, in the app's process.
- **Why:** PdfRenderer is not thread-safe, and pdfium keeps state for the whole process. One thread is the simplest way
  to be sure. A card and the receipt screen take turns, which costs a few tens of ms.
- **Risk if wrong:** a PDF that crashes pdfium in native code kills the app; Kotlin can't catch it. Receipts come from
  our own server, so we take that risk. One thread also means a 50-page document drawing pages can delay a card on the
  next screen a little.
- **Other options:** run the renderer in a separate process (`android:process`) behind a Binder: a bad PDF then kills
  only that process; costs ~30 MB of memory while open, and every bitmap crosses processes. Worth it only for PDFs from
  outside (user uploads, third-party links).
- **Evidence wanted:** crash reports with a pdfium frame in them.

## 83. The viewer is a Canvas with two layers, not a list of page images (PDF plugin, built)
- **Where:** `PdfViewer.kt`, `PdfRules.budget`, `baseWidth`, `areaScale`.
- **Chosen:** one Canvas draws the pages from our own camera (zoom and scroll); gestures are our own. Page bitmaps,
  as wide as the view, for the pages on screen and one on each side, use 2/3 of a budget: 1/8 of the heap limit, 16 to
  48 MB, 16 MB on low-RAM phones. One view-sized "sharp layer" at the real zoom, drawn 150 ms after the fingers rest, uses
  the other 1/3.
- **Why:** a `LazyColumn` of images scaled with `graphicsLayer` fights the pinch for the fingers, and sharp text at 5×
  would need page bitmaps 5 times wider (an A4 page at 5400 px is ~120 MB). The sharp layer keeps memory flat at any zoom,
  and also makes a long receipt sharp when its page bitmap had to be narrow. RN's library caps at 2048 px and stays soft
  above ~2×.
- **Risk if wrong:** our own gesture code can feel different from Android's (fling speed, edge stop). Pinch was not
  tried by a finger in this session: adb can't pinch. The numbers (2/3, 1/3, 1/8, 16 MB) are first guesses for low-end
  phones.
- **Other options:** tiles (pdf.js, Android's own PDF viewer): sharper while moving, more code; `androidx.pdf`: an alpha
  library that needs Android 11+ (we support 7+).
- **Evidence wanted:** on the Lava and a 2 GB phone, `dumpsys meminfo` while flinging the 50-page lab file and zooming,
  and how pinch feels next to the RN app.

## 84. The cache name leaves out the headers, and release builds take https only (PDF plugin, built)
- **Where:** `PdfRules.fileName`, `PdfRules.urlAllowed`; README "Downloads"; guide notes §44.
- **Chosen:** the file is `pdf-<sha256(url + key)>.pdf`, the same for any headers. A cached file is checked (it must
  open), not downloaded again. Release builds refuse http; debug builds take http to localhost and 127.0.0.1 only.
- **Why:** headers carry tokens that change at every login. With them in the name, every new login would download every
  receipt again. ZeroBill's receipt URLs are per receipt, so two users never share a name. http in release would let a
  network on the way change the receipt.
- **Risk if wrong:** an app whose URL is the same for every user ("/me/statement.pdf") shows the last user's file to the
  next one unless it calls `Pdf.cleanup({ olderThanMs: 0 })` at logout (README and guide notes say so). Also, a file
  that changed on the server is not fetched again while the old one is on disk: use a new `key` for a new version.
- **Other options:** put a hash of the headers in the name; send `If-None-Match` and check the server each time.
- **Evidence wanted:** whether a ZeroBill receipt can change after it is first served (a corrected bill under the same
  file key).

## 85. Location from Android's LocationManager, not Play's fused provider (location plugin, built)
- **Where:** `plugins/location/android/.../LocationModule.kt`; `plugins/location/README.md`.
- **Chosen:** fixes from `LocationManager` (through `LocationManagerCompat`) and `Geocoder`. GPS and network start
  together. **Changed 2026-11-04 (Pavan):** Google's "Turn on location" dialog is in, from Play's `SettingsClient`
  (`play-services-location` 21.4.0, in the plugin itself, not a second plugin), as `Location.turnOn()` (module v2). It
  opens through core's `ZnLaunch` with the dialog's `IntentSender`, so its answer survives a kill. Only status 6
  (RESOLUTION_REQUIRED) opens it; any other answer is "unavailable" and the app opens the Location screen.
- **Why:** first, no new library and no Play services version to break (Pavan's first ask). Then, after testing on the
  Lava, Pavan wanted the usual one-tap dialog: the Location screen is one more step for the user, and ZeroBill ships Play
  services anyway. ZeroBill's RN app uses the fused provider today (`ZLocationModule.kt`), but only for one fix within
  8 s, which the network provider gives indoors in 1–3 s.
- **Risk if wrong:** on a phone where "Google Location Accuracy" is off, the network provider is missing, so only the GPS
  is left: slow, and indoors nothing. The fused provider uses Wi-Fi and cell data more cleverly. Every app with this
  plugin now carries `play-services-location` (about 8 KB compressed code in the sample's release, after R8).
- **Swap later (not built):** fixes from Play's `FusedLocationProviderClient`, behind the same JS API and module version,
  chosen at `LocationPlugin(fused = true)`. The library is already in. Android 12+ also has
  `LocationManager.FUSED_PROVIDER`, the platform's own mix of GPS and network: a middle option, but each phone maker
  fills it in differently.
- **Other options for the dialog:** a separate `@zero-native/location-play` plugin, so a non-Play build (Huawei) carries
  no Play code. Not chosen: no such build is planned, and the fallback to the Location screen already covers it.
- **Evidence wanted:** time to the first fix and its accuracy on the Lava, indoors and outdoors, with and without Google
  Location Accuracy, against the RN app's fused fix at the same spot.

## 86. Location calls answer a reason and never reject (location plugin, built)
- **Where:** `plugins/location/src/index.ts`.
- **Chosen:** `{ position, reason, lastKnown }`, like `@zero-native/auth`. The last known fix is handed back on its own,
  with its age, never used as the answer by itself. An RN-style `Geolocation` object gives RN's callbacks and error codes.
- **Why:** a rejected promise that no one catches leaves a "Detecting location..." spinner forever. ZeroBill's RN code
  wraps every call in try/catch for this. Its native module also falls back to a cached fix of any age, while its screen
  says "never reuse stale coordinates": the two disagree, so the plugin makes the app choose.
- **Risk if wrong:** an author who wants errors as exceptions writes an `if` instead. Small.
- **Other options:** reject with `NativeError` codes, as most zn modules do.
- **Evidence wanted:** none.

## 87. A hidden app: one-shots answer at once, watches pause (location plugin, built)
- **Where:** `LocationModule.onBack` / `onFront`.
- **Chosen:** on the Activity's stop, a running one-shot answers `background` (or the best fix so far), and every watch
  removes its requests. On start, watches ask again. JS keeps its watch and sees no gap but time.
- **Why:** Android gives a hidden app no fix without the background permission, which we never ask, so a running request
  only costs battery and ends in a timeout. Pausing in native means an author can't forget it.
- **Risk if wrong:** a see-through window from another app pauses the Activity without stopping it, so a watch keeps
  running then. That is right: the user can still see our app.
- **Other options:** keep one-shots running to their timeout; stop watches for good and make JS start them again.
- **Evidence wanted:** none (checked with `dumpsys location` on the Lava, see milestones).

## 88. The plugin asks for both location permissions; core's "location" stays the precise one alone (location plugin)
- **Where:** `plugins/location/src/index.ts` (`requestPermission`), `ZnPermissions.kt:24`.
- **Chosen:** the plugin asks for `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION` by full name. Granted if either one
  is; blocked only when neither is and Android won't ask again (ZeroBill's rule). Core's short name was not changed.
- **Why:** Android's docs say 12+ may ignore a request for the precise permission alone from an app that targets 31 or
  higher, and they want both asked together so the user can pick "Approximate". Changing core is outside this plugin's
  work, so it is a question for Pavan.
- **Seen on the Lava (Android 14, target 36):** core's `Permissions.request(["location"])` still showed a dialog. So the
  feared "no dialog" did not happen there. Not checked: which choices that dialog offered.
- **Risk if wrong:** other phones may follow the docs and show nothing for core's "location".
- **Other options:** make core's "location" ask for both (one line in `ZnPermissions.kt`, no host API change), or remove
  the short name and point to the plugin.
- **Evidence wanted:** the same button on an Android 12 or 13 phone.
- **Also seen:** after `pm revoke` + `clear-permission-flags` (a test reset, not a user action), core still says
  `blocked` until the next dialog, because it remembers "the user refused" in its own store (`ZnPermissions` `asked`).
  Real users can't reset a permission that way, so it only matters for test scripts.

## 89. Accuracy levels, limits, and the geocoder in the same plugin (location plugin, built)
- **Where:** `LocationRules.kt`; `plugins/location/README.md`.
- **Chosen:** `"high"` waits for 25 m, `"balanced"` (default) for 100 m, `"low"` takes any fix and never starts the GPS when
  the network can answer. Timeout default 10 s, cap 60 s. Watch interval at least 1 s. A fix more than 2 s older than the
  request counts as cached and is skipped. With the rough permission only, a fix up to 11 minutes old counts and the first
  one wins, because Android sends such an app a new fix at most every 10 minutes (on the Lava, before this rule, every
  approximate one-shot ran to its timeout). 0,0 and out-of-range fixes are dropped. The Geocoder (reverse and forward) is
  part of the plugin, with a 10 s wait on Android 13+.
- **Why:** "near me" lists need 100 m, not 5 m; the cap stops a forgotten call from keeping the GPS on; ZeroBill had to
  filter 0,0 itself. ZeroBill shows "Area, pincode" from the geocoder, and it is the same `android.location` package.
- **Risk if wrong:** `"high"` indoors often runs to the timeout, then gives the network fix. RN code that maps
  `enableHighAccuracy: true` to it waits longer than on RN's fused provider.
- **Other options:** RN's limits (no timeout cap); a separate geocoder plugin.
- **Evidence wanted:** accuracy numbers from the Lava at a few spots.

## 90. JS errors reach Crashlytics by themselves, through add-only listener lists in core (Crashlytics plugin, built)
- **Where:** `ZnRuntime.addJsErrorListener`, `ZnOta.addReportListener` (core, Kotlin only); `CrashlyticsPlugin.register`.
- **Chosen:** core keeps its one `onJsError` / `onReport` hook for the app and adds listener lists next to them. The
  plugin adds a listener at register time, so every JS error (also hangs, start failures, renderer errors) becomes a
  non-fatal with no app code. `CrashlyticsPlugin(jsErrors = false)` turns that off.
- **Why:** Pavan asked for what is nearest to RN and Flutter Firebase. RN Firebase hooks the global JS handler by
  itself and chains the old one; Flutter asks the app for one line. A single hook would let the app (the sample sets
  both) silently replace the plugin's, or the other way round. Add-only lists change nothing for existing apps.
- **Risk if wrong:** an app that also sends JS errors to Crashlytics in its own `onJsError` sends each one twice.
- **Other options:** the app forwards to the plugin by hand (Flutter style); the plugin chains the old hook (breaks if
  the app sets it later).
- **Evidence wanted:** none.

## 91. Nothing is masked before Crashlytics; the app can pass `redact` (Crashlytics plugin, built)
- **Where:** `CrashlyticsPlugin(redact = ...)`, `CrashlyticsModule.clean`.
- **Chosen:** JS error text, logs and string keys go to Crashlytics as they are. An app that wants masking passes
  `redact`; if it throws, the text is left out (never the raw text). The README says: your own id in `setUserId`,
  never a phone number, email or VPA.
- **Why:** Pavan: "it's the app developer's call". OTA telemetry masks because it goes to our update server; Crashlytics
  is the app's own project. Built-in masks (digit runs of 6+) would also hide useful ids in error messages.
- **Risk if wrong:** an app puts a phone number in an error message and it lands in the console for 90 days. ZeroBill's
  RN app sends the raw phone today as an attribute (ZeroBill item, not the framework's).
- **Other options:** core's OTA masks on by default with an opt-out (my first proposal).
- **Evidence wanted:** none; a privacy review of ZeroBill's keys before the pilot.

## 92. Native crash reporting (firebase-crashlytics-ndk) is opt-in (Crashlytics plugin, built)
- **Where:** `plugins/crashlytics/README.md` "Native crashes"; the sample adds it only with `-PznCrashlyticsNdk`.
- **Chosen:** the plugin doesn't bring it. The app adds one Gradle line.
- **Why:** measured on the sample's R8 release: +1.30 MB in the APK (4 `.so` files, stored uncompressed), about 460 KB
  to download, against about 232 KB for the rest of Crashlytics. Pavan chose opt-in. Without it a native crash still
  counts in core's OTA health check (Android's exit record), so a bad bundle is still rolled back.
- **Risk if wrong:** Hermes or C++ crashes are invisible in the console for apps that skip it.
- **Other options:** always on (RN Firebase's default); a separate `plugin-crashlytics-ndk` Gradle project.
- **Evidence wanted:** how often native crashes happen in the pilot (Android vitals shows them without the NDK).

## 93. One JS task for every push message, in front, behind or closed (push plugin, built)
- **Where:** `ZnMessagingService.onMessageReceived` → `ZnBackground.run("push.message")`; `Push.onMessage`.
- **Chosen:** no separate "front only" event. Every data message runs the same task, with `inFront`. The service thread
  waits for the task, at most 15 s (FCM gives about 20).
- **Why:** RN's split (`onMessage` in front, `setBackgroundMessageHandler` behind) is where "works only when open" bugs
  come from. One path is tested once. A screen that wants a live refresh reads a store the task writes.
- **Risk if wrong:** a message that only matters on screen still costs a task when the app is closed (a cold JS start).
- **Other options:** RN's two handlers.
- **Evidence wanted:** cold-start time of a task started by FCM on the Lava.

## 94. Group summaries are kept by the plugin, from 2 notifications on; FCM's own notifications open the app only (push plugin, built)
- **Where:** `Groups.refresh` (after show, cancel and swipe; summary options saved per group in a small prefs file).
- **Chosen:** a group with 2 or more shows one inbox summary (newest 5 lines), silent; at 1 it is removed. A message with
  a `notification` block, shown by Android while the app is behind, opens the app on a tap (no route in v1).
- **Why:** ZeroBill's RN app does exactly this summary by hand on Notifee; Android's own grouping starts at 4 and shows
  no text. ZeroBill's RN app doesn't route FCM-shown taps either (taps go through Notifee for its custom ones), so
  v1 loses nothing. Routing them needs core to read the launch intent's extras.
- **Risk if wrong:** `activeNotifications` right after `notify` can miss the new one (Android posts it later); the plugin
  adds it by hand. A launcher that hides groups shows the summary only.
- **Other options:** leave grouping to Android; route FCM-shown taps with a `link` data key (core change).
- **Evidence wanted:** the group on the Lava and one Android 8–10 phone.

## 95. Firebase Gradle plugins only when google-services.json is there; R8 mapping upload only on request (Firebase plugins)
- **Where:** `plugins/firebase-app/firebase.gradle.kts` (applied at the end of `android/sample/build.gradle.kts` since
  2026-11-04, first written in that file), `.gitignore`.
- **Chosen:** the sample applies `com.google.gms.google-services` and `com.google.firebase.crashlytics` only when
  `android/sample/google-services.json` exists (never committed), and logs one line when not. Release builds upload the
  R8 mapping only with `-PznUploadMapping`.
- **Why:** other sessions and CI have no json and must still build and run (Firebase then doesn't start; both plugins
  answer "not available"). An everyday release build (size numbers) must not send anything to Firebase.
- **Risk if wrong:** a release build sent to testers without `-PznUploadMapping` has obfuscated Kotlin stacks in the
  console (JS stacks are not affected).
- **Other options:** commit a dummy json (Crashlytics then reports to nowhere); always upload (ZeroBill's production
  flavour does). The shared file sets Crashlytics' `mappingFileUploadEnabled` by name (a script file can't see
  Firebase's Gradle classes): if Firebase renames it, the build fails at once, which is the safe side.
- **Evidence wanted:** none.

## 96. Analytics starts off, in the plugin's manifest; the app turns it on (Analytics plugin, built)
- **Where:** `plugins/analytics/android/src/main/AndroidManifest.xml`.
- **Chosen:** the plugin's manifest sets `firebase_analytics_collection_enabled=false`. JS calls
  `setAnalyticsCollectionEnabled(true)` after consent; Firebase keeps it. An app that wants it on from the first start
  overrides the value in its own manifest (`tools:replace`).
- **Why:** Pavan's call (2026-11-04): off until consent. Firebase starts before JS, so only the manifest can stop the
  first launch's events (first_open, session_start).
- **Risk if wrong:** an app that forgets the call collects nothing, silently. The README and §50 say it first.
- **Other options:** on by default like RN Firebase (the app opts out); a plugin option (but the manifest is read
  before any Kotlin code runs).
- **Evidence wanted:** none.

## 97. One screen_view per top route, Firebase's own screen views off (Analytics plugin, built)
- **Where:** `AnalyticsPlugin.watchRoute`, the plugin's manifest (`google_analytics_automatic_screen_reporting_enabled=false`).
- **Chosen:** each change of the top route (`ZnNav.stack`) sends `screen_view` with `screen_name` and `screen_class`
  set to the route's name. `screenName` renames or leaves out routes; `screenViews = false` turns it off.
- **Why:** the app is one Activity, so Firebase's own screen views would all be "MainActivity". RN apps get the same
  thing by hand from React Navigation's `onStateChange`; here routes are known natively.
- **Risk if wrong:** tabs inside a screen are not separate screens (one route); a sheet over a screen is one if it is a
  route. Apps call `logScreenView` for parts of a screen.
- **Other options:** screen_class = "zero-native" for all; no automatic views at all (RN Firebase's default).
- **Evidence wanted:** what ZeroBill's reports need (route names vs friendlier names) once Pavan uses it.

## 98. Names checked in the plugin; booleans sent as 1 or 0 (Analytics plugin, built)
- **Where:** `AnalyticsRules.kt`.
- **Chosen:** bad event, parameter or property names (Analytics' published rules) answer `false` with the reason as a
  JS console warning, and nothing is sent. Strings are cut to 100 characters, property values to 36. Booleans become
  1 / 0; only `items` can be a list.
- **Why:** Firebase drops a bad event with only a logcat line, so authors never see it. Analytics has no booleans: a
  Bundle boolean would be dropped.
- **Risk if wrong:** if Google relaxes a rule, the plugin refuses names Firebase would take, until the rule is updated.
- **Other options:** pass everything to Firebase and let it drop; booleans as "true" / "false" strings.
- **Evidence wanted:** none.

## 99. The app removes the ad id permissions, not the plugin (Analytics plugin, built)
- **Where:** `android/sample/src/main/AndroidManifest.xml`, the plugin README step 5.
- **Chosen:** the plugin turns ad id collection off (`google_analytics_adid_collection_enabled=false`), but leaves
  Play services' `AD_ID`, `ACCESS_ADSERVICES_AD_ID` and `ACCESS_ADSERVICES_ATTRIBUTION` permissions in. The app removes
  them with `tools:node="remove"` (the sample does).
- **Why:** a library's remove marker is not a sure thing against other libraries in the manifest merge, and an app
  with ads needs them. The app's own manifest wins every time.
- **Risk if wrong:** an app that forgets step 5 ships the permissions, and Play's data safety form asks about the ad id.
- **Other options:** remove them in the plugin's manifest; exclude `play-services-ads-identifier` in Gradle.
- **Evidence wanted:** none.

## 120. The OTA "check now" push runs natively and never reaches JS (push plugin v2, built)
- **Where:** `ZnMessagingService.otaCheck`, `PushRules.OTA_KEY`.
- **Chosen:** a data message `zn_ota=check` calls `ZnOta.check()` in the FCM service and waits for it (at most 15 s),
  without starting the JS task. `PushPlugin(otaCheck = false)` turns it off.
- **Why:** Pavan's D (2026-11-04): an OTA "check now" push after v1. A broken JS bundle is exactly when a fix must
  still arrive, so the path must not need JS. The check asks only the app's configured OTA server, with the same
  signature checks as a start, so a forged push can at most cause one extra check.
- **Risk if wrong:** a topic message to every phone makes every phone hit the OTA server at once. Send it to a small
  topic, or in waves.
- **Other options:** a JS handler that calls `Updates.check()` (fails with a broken bundle); a separate FCM service in
  core (core would then depend on Firebase).
- **Evidence wanted:** the OTA server's load from one topic message, before ZeroBill uses it for all phones.

## 121. A tap on FCM's own notification gives the data to JS; the plugin opens no link by itself (push plugin v2, built)
- **Where:** `Opens.kt`, `Push.getInitialNotification`, `Push.onNotificationOpenedApp`.
- **Chosen:** as in RN Firebase: the message's data comes to JS once (the app was closed) or as an event (it was
  behind). The app opens `data.link` itself. The plugin's own `Notifications.show` still opens its `link` natively.
- **Why:** on a cold start the tap's Intent has no link (FCM builds it), and core's start link is read before plugins
  can add one; an automatic link would open on some starts and not others. JS deciding is the same on both paths.
- **Risk if wrong:** apps that forget the two calls land on the start screen after a tap. §51 says to call them.
- **Other options:** core API to add a start link from a plugin (host API 9); `click_action` intent filters.
- **Evidence wanted:** none.

## 122. A button with no link runs a JS task; a button with a link opens the app (push plugin, Notifications v2, built)
- **Where:** `Actions.kt`, `ZnNotificationAction`, `Notifications.onAction`.
- **Chosen:** like notifee's background `ACTION_PRESS`: a button without `link` goes to a broadcast receiver, which runs
  the JS task `push.action` (8 s) with the notification's data and the typed reply. A button with `link` is an
  Activity PendingIntent, the same as a tap on the notification. The notification is not cancelled by itself.
- **Why:** Android 12+ blocks "trampolines" (a receiver that starts an Activity), so a button that must open a screen
  has to be an Activity intent from the start. Leaving the notification as it is lets the task decide (update after a
  reply, cancel after "Mark as read").
- **Risk if wrong:** apps that forget to cancel leave a stale notification; after a reply, a spinner stays. README and
  §52 say it.
- **Other options:** cancel on every press (notifee doesn't); open the app for every button.
- **Evidence wanted:** none.

## 123. Lock screen default is "private" (push plugin, Notifications v2, built)
- **Where:** `PushRules.visibility`, `NotificationsModule.show`.
- **Chosen:** every notification the app shows sets `VISIBILITY_PRIVATE` unless `visibility` says otherwise.
- **Why:** it is already Android's default for most phones, but some phones and user settings show everything; a
  payments app should hide amounts unless it chose to show them.
- **Risk if wrong:** promotional notifications show only "zn sample" on the lock screen; apps set `"public"` for those.
- **Other options:** Android's own default (no call).
- **Evidence wanted:** none.

## 124. Scheduled notifications are shown natively by an alarm; inexact by default; the boot receiver is the app's (push plugin, Notifications v2, built)
- **Where:** `Schedule.kt`, `ZnNotificationTrigger`, `ZnNotificationBoot`.
- **Chosen:** `schedule` saves the `show` options and sets `setWindow` with a 10-minute window (exact only when asked
  and allowed). Not `setAndAllowWhileIdle`: on the emulator its window was 3/4 of the wait (+44 min for an alarm an hour
  ahead), so a reminder for tomorrow could show many hours late. `setWindow` waits in deep Doze until the phone wakes.
  The alarm's receiver runs the same `show` code with no JS. Repeats (hourly, daily, weekly) set the next alarm after
  each show. The plugin sets all alarms again at every app start; the boot receiver is in the plugin but declared only
  by an app that wants it (Pavan: opt-in, 2026-11-04). `cancel` and `cancelAll` remove scheduled ones too (notifee does).
- **Why:** an alarm must work with the app closed and JS not started, and a broken bundle must not stop a reminder.
  No exact-alarm or boot permission is added to every app that uses push.
- **Risk if wrong:** times can be up to 10 minutes late, and later in deep Doze (shown when the phone wakes); on phones with aggressive battery savers (Xiaomi, Oppo) alarms of a
  swiped-away app may not fire at all (`isBatteryOptimized`, `openSettings("battery")`).
- **Other options:** WorkManager (no exact times, minimum 15 minutes for periodic); notifee's AlarmManager with exact
  alarms by default.
- **Evidence wanted:** a check on a Xiaomi or Oppo phone with the app swiped away.

## 125. Remote Config values are pushed to JS with each answer, so reads are plain calls (Remote Config plugin, built)
- **Where:** `plugins/remote-config/src/index.ts`, `RemoteConfigModule.result`.
- **Chosen:** every answer of `setDefaults`, `fetch`, `activate`, `fetchAndActivate` and `getAll` carries all values
  with their source; JS keeps them and `getValue` reads that copy. Before the first answer, JS's own defaults answer.
- **Why:** RN Firebase's `getValue` is synchronous (it reads native constants at start); zero-native calls are async,
  and a payment screen must not wait on a promise to read a switch. Remote Config templates are small (a few KB).
- **Risk if wrong:** a very large template (hundreds of keys, long JSON values) crosses the bridge on each answer.
- **Other options:** an async `getValue`; a native snapshot read at runtime start (core change).
- **Evidence wanted:** none.

## 126. Performance: on by default, URLs without the query, network traces through a new add-only core hook (Perf plugin, built)
- **Where:** `plugins/perf/android/.../PerfPlugin.kt`, `ZnFetch.addClientSetup` (core).
- **Chosen:** collection on by default (Firebase's default; it is diagnostics, like Crashlytics). An OkHttp interceptor
  on core's client makes one HttpMetric per request, with the URL's query and fragment removed (`url` rewrites or
  drops). Screen traces per top route with frame counts from Android's FrameMetrics on the Activity's window. Core
  gets `ZnFetch.addClientSetup` (add-only, after the app's `configure`), like `addJsErrorListener` (Pavan's B).
- **Why:** the app is one Activity, so Firebase's automatic screen traces would be one screen; its Gradle plugin's
  bytecode rewrite isn't needed because all fetches go through one client. A plugin must not replace the app's pins.
- **Risk if wrong:** a team that treats performance data as needing consent must turn it off until then
  (`setPerformanceCollectionEnabled(false)` or `firebase_performance_collection_enabled=false` in the manifest).
- **Other options:** off until consent like Analytics; the Firebase Perf Gradle plugin.
- **Evidence wanted:** whether ZeroBill's consent screen covers diagnostics.
