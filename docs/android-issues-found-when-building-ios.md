# Android issues found while building iOS

Problems in the Android side or the shared code that the iOS port turned up. iOS work happens on the `ios` branch; Pavan
forwards these entries to sessions on his other machine (Windows, the Lava phone), which check and land them on
Android. **Add an entry whenever the iOS work finds one**, newest last, and keep each entry readable on its own: a
session reading it has no other context.

Each entry says:
- **Status:** `open` (not fixed anywhere), `fixed on ios` (fixed on the `ios` branch, waiting for an Android check),
  `checked on Android` (the phone or the Android build confirmed it; say who and when), or `won't fix` (with why).
- **Problem**, **why it matters**, **fix** (what changed, files, commit once there is one), and **check on Android**:
  what the other machine must run to confirm, because this Mac has no Android SDK.

## Summary
| # | Found | Area | Problem | Status |
|---|---|---|---|---|
| A1 | 2026-11-07 | OTA | Bundle choice, health and signature rules exist only in Kotlin | open (iOS step i.0) |
| A2 | 2026-11-07 | Tools | Tools and docs assume Windows | open (core tests done, A2 below) |
| A3 | 2026-11-08 | Core tests | The "unknown NAV kind" test used kind 11, which is now `LAYER` | fixed on ios |
| A4 | 2026-11-08 | Sample | The sample doesn't build from a fresh clone (`offers-data.json` not in git) | fixed on ios |
| A5 | 2026-11-08 | Core build | Shared core assumed Android: `posix_fallocate`, MMKV headers, `liblog` | fixed on ios |
| A6 | 2026-11-08 | FlowStore | Without space reservation, the first write of a key rewrote the whole file and could fail on a full disk | fixed on ios |
| A7 | 2026-11-08 | JS tests | `app-events.test.ts` passes alone but fails in the full `bun test` run on the Mac | open |

---

## A1. OTA decision logic exists only in Kotlin
- **Status:** open. Planned as iOS step i.0 (`milestones.md`).
- **Problem:** which bundle runs, the launch watchdog and blocking rules, and signature checks live in
  `ZnBundles.kt`, `ZnOtaHealth.kt`, `ZnOtaSignature.kt` and `ZnOta.kt` (about 2.1k lines). iOS needs the same rules.
- **Why it matters:** two copies of safety-net rules drift apart. A phone on one platform could keep running a bundle
  the other would block. These are the rules that stop a bad OTA from bricking the app.
- **Fix (proposed):** move the decisions into the C++ core; each platform only reports facts (Android:
  `ApplicationExitInfo` reasons; iOS: MetricKit reports on the next launch). Not started.
- **Check on Android:** the whole OTA phone matrix (`bun run ota:phone`, 38 cases) after the move.

## A2. Tools and docs assume Windows
- **Status:** open. Core tests are done.
- **Problem:** `tools/*.ps1` (`run-core-tests.ps1`, `measure-startup.ps1`, `measure-frames.ps1`) and the docs'
  `.\gradlew.bat` commands only work on Windows.
- **Why it matters:** iOS work happens on a Mac, and contributors on Mac or Linux can't run the checks.
- **Fix so far:** `tools/run-core-tests-apple.ts` builds and runs the core tests on a Mac and the iOS simulator
  (no phone). Still open: Mac versions of the measuring scripts and the docs' build commands.
- **Check on Android:** nothing yet.

## A3. Stale core test for unknown NAV kinds
- **Status:** fixed on ios.
- **Problem:** `core/tests/core_tests.cpp` ("nav ops") sent NAV kind 11 and expected the runtime to drop it as
  unknown. Kind 11 became `LAYER` with the app layers (commit 96418b4), so the test has failed (2 checks) on the phone
  since then. Core tests only run by hand on the phone, so nobody saw it.
- **Why it matters:** a red core test nobody notices hides real failures. It's an argument for CI
  (`production-readiness.md` A3).
- **Fix:** the test sends kind 12 and expects "unknown kind 12".
- **Check on Android:** `.\tools\run-core-tests.ps1` on the phone: 166 checks, 0 failed.

## A4. The sample doesn't build from a fresh clone
- **Status:** fixed on ios.
- **Problem:** `examples/sample/src/offers.ts` imports `test-kit/offers-data.json`, which is in `.gitignore` (real
  offers). On a fresh clone `bun run sample:js` fails with "Cannot find module '../../../test-kit/offers-data.json'".
- **Why it matters:** anyone new (or a new machine) can't build the sample. It's a community project.
- **Fix:** `test-kit/offers-data.example.json` (made-up offers in the same shape) is committed;
  `examples/sample/build.ts` copies it to `offers-data.json` when that file is missing. A machine that has the real
  file keeps using it.
- **Check on Android:** none needed on a machine that has the real file. On a fresh clone: `bun run sample:js` works.

## A5. The shared core assumed Android
- **Status:** fixed on ios.
- **Problem:** three things in `core/` only built on Android:
  1. `flowstore.cpp` called `posix_fallocate`, which Apple platforms don't have.
  2. `storage.cpp` uses MMKV's C++ API. On Apple, MMKV's headers switch to their Objective-C API (`NSString` logs, a
     namespace) unless `FORCE_POSIX` is defined. MMKV's own CMake sets it, but only for MMKV's files, not ours.
  3. `core/CMakeLists.txt` linked `log` (Android's `liblog`) on every platform.
- **Fix:** `core/CMakeLists.txt` links `log` only `if(ANDROID)` and defines `FORCE_POSIX` for `zn_core_base`
  `if(APPLE)`. `flowstore.cpp` calls `posix_fallocate` only when not `__APPLE__` (Apple uses the fallback path, A6).
  The tests take their folder from `ZN_TEST_DIR` (default stays `/data/local/tmp`) and use `std::filesystem`
  instead of `std::system`, which iOS doesn't have.
- **Check on Android:** `.\gradlew.bat :sample:assembleDebug` (the CMake change), then `.\tools\run-core-tests.ps1`.

## A6. FlowStore: the first write of a key could fail on a full disk
- **Status:** fixed on ios.
- **Problem:** `reserve()` in `core/src/flowstore.cpp` makes sure every byte of a FlowStore file has a disk block, so a
  write into the memory map can't crash (SIGBUS) on a full disk. A file opened in a new process isn't marked reserved,
  so its first write calls `reserve()` again. Where `posix_fallocate` isn't supported, the fallback rewrites the whole
  file block by block, and on a full disk that rewrite fails, **although the write itself would fit**. This is the
  write made at payment time, right before opening the UPI app.
- **Where it happens:** on Android only on file systems where `posix_fallocate` returns `EOPNOTSUPP` / `ENOSYS` /
  `EINVAL` (not seen on the Lava). On Apple it is the only path.
- **How it was found:** the core test "a write that fits still works on the full disk" failed on the Mac.
- **Fix:** before the fallback rewrite, `reserve()` checks `fstat`: if the file is already big enough and
  `st_blocks * 512` covers it, there is nothing to fill. Side finding: APFS backs small files fully (a 16 KB file made
  with `ftruncate` has no hole; a 100 MB one does), so on Apple the test's "file with a hole" setup can't make a hole
  and prints a note instead. On Android the test still requires the hole.
- **Check on Android:** `.\tools\run-core-tests.ps1` ("flowstore: files have no holes ..." passes, no note printed).

## A7. A JS test depends on test file order
- **Status:** open.
- **Problem:** on the Mac, `bun test packages plugins compiler tools` gives 1164 pass, 1 fail:
  `packages/core/test/app-events.test.ts` "native calls still settle after startApp". It passes when run alone
  (`bun test packages/core/test/app-events.test.ts`). In the full run its host logs about 50 lines like "app event 12
  already has a handler; the new one replaces it": an earlier test file leaves app-event handlers installed.
  Same result without the 2026-11-08 changes.
- **Why it matters:** a test that passes or fails depending on the order hides real breakage. The order likely differs
  between Windows and the Mac.
- **Fix (proposed):** find which file installs the handlers without resetting them (run `bun test packages` and
  bisect the file list), and reset app-event handlers in `installEvents()` or in that file's teardown.
- **Check on Android:** `bun test` on Windows, and the full run on the Mac.
