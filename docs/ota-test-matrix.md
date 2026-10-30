# OTA phone test matrix (step 4.9)

Every OTA case from docs/ota.md §4, run on a real phone. Most run by themselves with one command:

```
bun run ota:phone              # ~15 min; debug sample, phone unlocked, one phone on adb
bun run ota:phone --list       # the cases
bun run ota:phone --until hold # stop after a case (cases build on the ones before)
```

`tools/ota/phone-matrix.ts` installs the debug sample fresh, releases small test bundles into its own store
(`.zn-ota-test/`, never `.zn-ota-store`), and checks each case by its log lines. The phone talks to a **fault proxy**
(port 8790, over `adb reverse`) in front of the reference server (8791): it passes everything through, or breaks it on
purpose (a changed zip byte, a wrong signature, an old answer replayed, a cut or slow download). It puts back what it
changed: the sample's sources (after each build), the screen timeout, `debug.zn.ota_free_bytes`, the port forward,
and the APK's serial-0 assets. Results: `.zn-ota-test/results.md`.

Cases build on each other (the store's seq, blocked and last good bundles, what the phone kept), so there is no
`--only`. To debug one failing case, repeat its steps by hand; the phone log of a failed case is saved as
`.zn-ota-test/<case>.log`.

Debug-only helpers it uses (not in release builds): `Device.crash()` (watchdog), `DebugWakeProvider` (a start
without UI, like a push), `adb shell setprop debug.zn.ota_free_bytes N` (low storage), `run-as` (files a kill can
leave behind).

## Cases

Last run: 2026-10-31, Lava Blaze 2 5G (Android 14), debug sample: **22 of 22 passed**. The cases take ~4.5 min; the
rest of the ~15 min is building and installing the sample (at the start, and twice for `apk-newer`). "Proof" is the
log line each case waited for.

| Case | Result | Time | Proof |
|---|---|---|---|
| first-install | pass | 6 s | check staging: NONE NO_CHANNEL in 140 ms |
| update | pass | 14 s | safety: sample_1 is healthy |
| apply-now | pass | 16 s | apply: now running sample_2 (#2) from files, 2 screen(s) opened again, in 44 ms (JS 16 ms) |
| hold | pass | 30 s | held, then: apply: now running sample_3 (#3) from files, 2 screen(s) opened again, in 37 ms (JS 8 ms) |
| rollback-kept | pass | 13 s | check staging: USE_LOCAL KEPT in 245 ms |
| kill-switch | pass | 7 s | check staging: BUILT_IN KILL_SWITCH in 114 ms |
| throw-start | pass | 10 s | report: error_rollback sample_4: start in script main.hbc failed: OTA test: this bundle fails at start on purpose; going back to sample_1 |
| blocked-pointer | pass | 6 s | check staging: NONE BLOCKED in 127 ms |
| watchdog | pass | 15 s | report: watchdog_block sample_5: a launch ended by a crash; last: crash |
| last-good-error | pass | 19 s | safety: sample_6 is the last good bundle: screen in screen "home" threw: Error: OTA test: the home screen throws on the second launch (reported, not blocked) |
| incompatible | pass | 8 s | check staging: NONE INCOMPATIBLE in 206 ms |
| tampered-zip | pass | 13 s | check failed (zip_sha): the downloaded zip doesn't match the signed manifest |
| bad-bundle-signature | pass | 6 s | check failed (signature): bad bundle signature on sample_9 |
| bad-pointer-signature | pass | 6 s | check staging: NONE POINTER_REFUSED in 153 ms |
| replayed-pointer | pass | 10 s | check staging: NONE POINTER_REFUSED in 107 ms (replayed seq 1) |
| network-cut | pass | 12 s | resuming sample_10 at 65410 of 130821 bytes |
| kill-download | pass | 15 s | resuming sample_11 at 49152 of 130820 bytes |
| low-storage | pass | 13 s | check failed (no_space): sample_12 needs 50.6 MB free (with 50.0 MB kept for the user), the phone has 1.0 MB |
| background-start | pass | 19 s | no check and no launch mark without UI; the UI start after it judged nothing |
| killed-install | pass | 5 s | bundle: not running sample_98: its folder has no zn-bundle.json; running the built-in bundle |
| server-down | pass | 7 s | check failed (failed): unexpected end of stream on http://127.0.0.1:8790/... |
| apk-newer | pass | 10 s | new APK: 8 bundle(s) that no longer fit (or are blocked) deleted; sample_98 is no longer next |

## Found while building the matrix (the Lava, Android 14)

- **Crash dialog keeps the process alive.** The Lava shows "zn sample has stopped" after a crash
  (`show_first_crash_dialog` = 1), and the crashed process stays until the dialog is closed. The script taps
  "Close app" (Android then records a crash, and the next start counts it). A force stop instead would be recorded as
  a force stop, which the watchdog ignores: second-opinions entry 1.
- **The ROM blocks manifest broadcast receivers for a stopped app** ("suppress to start process of staticReceiver"),
  so a test broadcast can't start the process. A content provider can, so `DebugWakeProvider` is one. Real push
  messages (FCM) are let through by the ROM.
- **A downloaded bundle that can't run** (planted by `killed-install`) falls back to the APK's bundle, not the last
  good one, and stays there until the channel moves on: second-opinions entry 6.
- **`server-down` sees "end of stream", not "refused":** `adb reverse` takes the phone's connection and then closes it
  when nothing listens on the PC. With the port forward removed, the same check fails with "Failed to connect"
  (seen by hand). Both are a quiet `check failed (failed)`, and the app runs on.
- **A cut download prints a Bun stack trace** in the script's output (the proxy closes the socket on purpose). The
  script says so; it is not a failure.

## Not run by the script

| Case | Why | How it is covered |
|---|---|---|
| Airplane mode during a check / download | The sample's server is `127.0.0.1` through `adb reverse`, which goes over adb, not the phone's network: airplane mode can't affect it (and on wireless adb it cuts the test's own connection) | Same code path as `server-down` (no connection) and `network-cut` (broken mid-download, resumed later). A real network test comes with an HTTPS server (milestone 5) |
| Kill during apply (`applyNow`) | The swap takes ~10 ms; a kill can't be timed into it | `applyNow` writes no files (the bundle became `current` at install); a kill mid-apply = a normal kill, the next start runs `current`. 4.6 checked apply, its fallback and holds |
| Kill exactly between the zip check and `current` | Same: microseconds | `current` is written last, atomically (`ZnOtaInstall.writeAtomic`); the folders a kill could leave are planted by `killed-install` |
| Android < 11 watchdog (no exit records) | No such phone here | Unit tests (`ZnOtaHealthTest`): 2 deaths in a row block |
| Release (R8) build | The script needs debug helpers | 4.8 ran the main paths in release; cold start 195 ms |
