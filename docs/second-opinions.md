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

## 38. SVG is compiled at build time and drawn by our own small interpreter (SVG design, not built)
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

## 39. SVG part overrides are one `parts` prop, grouped by part (SVG design, not built)
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

## 40. SVG draw data lives in the template file, not in its own file (SVG design, not built)
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
  writes paths as SVG path text (entry 41), which is already compact; a binary form would now save much less.

## 41. SVG paths are written as minified SVG path text, arcs kept (SVG phase 1, built)
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

## 42. A big SVG is still parsed on the main thread at its first draw (SVG phase 1, measured on the Lava)
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
