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

## 2. Watchdog: an ANR counts, but as "not sure" (2 needed) (step 4.8)
- **Where:** `ZnOtaHealth.kt`, `exitOf` (`REASON_ANR -> Exit.Counts(..., sure = false)`).
- **Chosen:** a launch killed for "not responding" counts toward the watchdog, but needs 2 in a row, like Android < 11.
- **Why:** an ANR may be the phone (a slow phone on its first start after an update, a busy disk), not the bundle.
  JS hangs are caught earlier by our own JS time limit (that path rolls back at once), so an ANR is more often native
  or system trouble.
- **Risk if wrong:** a bundle that freezes the main thread stays for one more launch.
- **Other options:** `sure = true` (block after 1); or don't count ANRs at all.
- **Evidence:** ANR rate per bundle vs the APK's own bundle in telemetry / Play Console.

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
