# OTA phone test matrix (step 4.9)

Every OTA case from docs/ota.md §4, run on a real phone. Most run by themselves with one command:

```
bun run ota:phone              # ~30 min; debug sample, phone unlocked, one phone on adb, mock UPI app installed
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

Last run: 2026-11-03 (after P.3), Lava Blaze 2 5G (Android 14), debug sample: **38 of 38 passed**. The cases take
~11 min; the rest of the ~30 min is building and installing the sample. "Proof" is the log line each case waited for.

| Case | Result | Time | Proof |
|---|---|---|---|
| first-install | pass | 5 s | check staging: NONE NO_CHANNEL in 153 ms |
| update | pass | 14 s | safety: sample_1 is healthy |
| check-stall | pass | 42 s | check failed (server): no full answer within 30 s |
| download-stall | pass | 78 s | check failed (download): no data for 60 s, at 69465 of 138931 bytes |
| swipe-update | pass | 25 s | report: applied sample_3: fresh start, was sample_2, 11 ms |
| swipe-bad-update | pass | 13 s | report: apply_failed sample_4: OTA test: this bundle fails at start on purpose; running sample_3 |
| crash-on-return | pass | 70 s | report: watchdog_block sample_5: 3 launches in 24 h ended by a crash or a freeze; last: crash |
| apply-now | pass | 16 s | apply: now running sample_6 (#6) from files, 2 screen(s) opened again, in 22 ms (JS 6 ms) |
| hold | pass | 30 s | held, then: apply: now running sample_7 (#7) from files, 2 screen(s) opened again, in 23 ms (JS 6 ms) |
| rollback-kept | pass | 12 s | check staging: USE_LOCAL KEPT in 103 ms |
| kill-switch | pass | 7 s | check staging: BUILT_IN KILL_SWITCH in 75 ms |
| throw-start | pass | 9 s | report: error_rollback sample_8: start in script main.hbc failed: OTA test: this bundle fails at start on purpose; going back to sample_1 |
| blocked-pointer | pass | 6 s | check staging: NONE BLOCKED in 82 ms |
| watchdog | pass | 14 s | report: watchdog_block sample_9: a launch ended by a crash; last: crash |
| last-good-error | pass | 18 s | safety: sample_10 is the last good bundle: screen in screen "home" threw: Error: OTA test: the home screen throws on the second launch (reported, not blocked) |
| incompatible | pass | 7 s | check staging: NONE INCOMPATIBLE in 81 ms |
| tampered-zip | pass | 11 s | check failed (zip_sha): the downloaded zip doesn't match the signed manifest |
| bad-bundle-signature | pass | 7 s | check failed (signature): bad bundle signature on sample_13 |
| bad-pointer-signature | pass | 5 s | check staging: NONE POINTER_REFUSED in 88 ms |
| replayed-pointer | pass | 10 s | check staging: NONE POINTER_REFUSED in 71 ms (replayed seq 1) |
| network-cut | pass | 12 s | resuming sample_14 at 69466 of 138933 bytes |
| kill-download | pass | 14 s | resuming sample_15 at 49152 of 138936 bytes |
| low-storage | pass | 12 s | check failed (no_space): sample_16 needs 50.7 MB free (with 50.0 MB kept for the user), the phone has 1.0 MB |
| background-start | pass | 18 s | no check and no launch mark without UI; the UI start after it judged nothing |
| killed-install | pass | 5 s | bundle: not running sample_98: its folder has no zn-bundle.json (this app: registry v8, bytecode 99, host API v1–5, modules {Fetch=1, Toast=1, Os=1, Updates=3, Device=4, Keyboard=1, Permissions=1, Launches=1, SecureStore=1}) |
| unusable-no-good | pass | 5 s | bundle: not running sample_98: its folder has no zn-bundle.json (this app: registry v8, bytecode 99, host API v1–5, modules {Fetch=1, Toast=1, Os=1, Updates=3, Device=4, Keyboard=1, Permissions=1, Launches=1, SecureStore=1}) |
| result-alive | pass | 32 s | launch-test heard: result t1793644321361 code 0 |
| result-after-kill | pass | 18 s | launch-test first read: result t1793644349590 code 0 |
| result-under-see-through | pass | 14 s | launch-test first read: lost t1793644367711 |
| no-result-after-swipe | pass | 17 s | launch-test first read: lost t1793644381912 |
| link-while-waiting | pass | 17 s | sample: link zn://sample/offers?refuse=1 atStart=false |
| start-link-refused | pass | 5 s | sample: link zn://sample/offers?refuse=1 atStart=true |
| result-survives-rollback | pass | 33 s | launch-test first read: result t1793644428052 code 0 |
| server-down | pass | 7 s | check failed (failed): unexpected end of stream on http://127.0.0.1:8790/... |
| apk-newer | pass | 11 s | new APK: 6 bundle(s) that no longer fit (or are blocked) deleted |
| permission-grant | pass | 17 s | launch-test camera: granted |
| permission-blocked | pass | 27 s | launch-test camera: blocked |
| icon-handle | pass | 14 s | image failed: zn://app-icon/dev.zeronative.no.such.app — android.content.pm.PackageManager$NameNotFoundException: dev.zeronative.no.such.app |

## Found while building the matrix (the Lava, Android 14)

- **Crash dialog keeps the process alive.** The Lava shows "zn sample has stopped" after a crash
  (`show_first_crash_dialog` = 1), and the crashed process stays until the dialog is closed. The script taps
  "Close app" (Android then records a crash, and the next start counts it). A force stop instead would be recorded as
  a force stop, which the watchdog ignores: second-opinions entry 1.
- **The ROM blocks manifest broadcast receivers for a stopped app** ("suppress to start process of staticReceiver"),
  so a test broadcast can't start the process. A content provider can, so `DebugWakeProvider` is one. Real push
  messages (FCM) are let through by the ROM.
- **A downloaded bundle that can't run** (planted by `killed-install`) fell back to the APK's bundle, not the last good
  one. Since H.4 (2026-11-02) the last good bundle runs: second-opinions entry 6.
- **`server-down` sees "end of stream", not "refused":** `adb reverse` takes the phone's connection and then closes it
  when nothing listens on the PC. With the port forward removed, the same check fails with "Failed to connect"
  (seen by hand). Both are a quiet `check failed (failed)`, and the app runs on.
- **A cut download prints a Bun stack trace** in the script's output (the proxy closes the socket on purpose). The
  script says so; it is not a failure.
- **A see-through window on top changes what a kill does (P.2).** The mock UPI app's first window is see-through for
  1.8 s. Under it we are only paused, so Android has not saved our state, and `adb shell am kill` refuses (the process
  counts as visible). With `run-as ... kill -9`, Android drops our Activity and the result never comes: the next open reads
  `lost` (`result-under-see-through`). Under the opaque window `am kill` works, and the result arrives
  (`result-after-kill`). `docs/second-opinions.md` entry 15.
- **The system permission dialog uses a straight apostrophe** on the Lava: "Don't allow". Other phones may differ, so
  the permission cases may need a change there.

## Not run by the script

| Case | Why | How it is covered |
|---|---|---|
| Airplane mode during a check / download | The sample's server is `127.0.0.1` through `adb reverse`, which goes over adb, not the phone's network: airplane mode can't affect it (and on wireless adb it cuts the test's own connection) | Same code path as `server-down` (no connection) and `network-cut` (broken mid-download, resumed later). A real network test comes with an HTTPS server (milestone 5) |
| Kill during apply (`applyNow`) | The swap takes ~10 ms; a kill can't be timed into it | `applyNow` writes no files (the bundle became `current` at install); a kill mid-apply = a normal kill, the next start runs `current`. 4.6 checked apply, its fallback and holds |
| Kill exactly between the zip check and `current` | Same: microseconds | `current` is written last, atomically (`ZnOtaInstall.writeAtomic`); the folders a kill could leave are planted by `killed-install` |
| Android < 11 watchdog (no exit records) | No such phone here | Unit tests (`ZnOtaHealthTest`): 2 deaths in a row block |
| Release (R8) build | The script needs debug helpers | 4.8 ran the main paths in release; cold start 195 ms |
