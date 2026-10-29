# Startup and performance

Part of the zero-native spec. The summary is in `ARCHITECTURE.md` §8.1 and §19; this file has the rules, the
measurement methods and every number measured so far.

## 1. Startup rules (decided, 2026-10-29)
1. **No work at module load time.** A module's top level only declares things. No data generation, no I/O, no
   expensive computation. (exp4 generated 10,000 fake transactions at load and paid for it on every cold start.)
2. **No main-thread work in `onCreate` beyond creating the view host.** Package-manager queries, icon loading, disk
   reads and JSON parsing go to the I/O pool or happen on demand. (exp4 spent 81 ms on the main thread listing UPI
   apps and loading 9 icons before the first frame.)
3. **Per-screen bytecode, loaded on demand.** Cold start evaluates `core.hbc` + the first screen's `.hbc` only.
4. **The first frame is the native skeleton from the template**, drawn before JS has started (ARCHITECTURE §8.1). No
   "Loading…" placeholder screen.
5. **Bytecode is loaded without copying** where the platform allows (Hermes can run from a memory-mapped buffer); not
   read into a Java byte array and copied. [check the best Hermes API for this]
6. **Baseline Profiles on by default.** The framework ships profiles for Compose and the zn runtime; apps generate
   their own for their screens. (v0 exp 2: 191 ms without vs 158 ms with ahead-of-time compilation.)
7. **One JS runtime per process** (ARCHITECTURE §8.2). Recreating an Activity must not restart JS.
8. **Startup budget:** ≤ 250 ms `am start` TotalTime on the Lava Blaze 2 5G for a release build of a sample app
   (Flutter 1.6.0 measures ~300–330 ms on the same phone).

## 2. Measurement rules
- **Only release builds** (R8 on, debuggable off). Compose debug builds are several times slower; a debug number is
  never compared with anything. Check with `adb shell dumpsys package <pkg>`: `DEBUGGABLE` must not be in the flags.
- Write down the build type, device, Android version, and **where the clock starts and stops** for every number.
- Leave out the first run after an install (it includes one-time compilation); report the median of the rest.
- Check developer settings first: "Don't keep activities" (`adb shell settings get global always_finish_activities`)
  and the background process limit change behaviour. Turn them off after process-death tests.
- Compare with React Native or Flutter only on equal terms (both release, same screen, same device). Say so when a
  comparison is directional only (prototype vs full app).

## 3. How to measure
**Download size (Play):**
```
java -jar bundletool-all-1.18.3.jar build-apks --bundle=app.aab --output=out.apks --overwrite
java -jar bundletool-all-1.18.3.jar extract-apks --apks=out.apks --device-spec=device.json --output-dir=out
cat out/*.apk | brotli -q 11 -c | wc -c
```
`device.json` (Lava Blaze 2 5G): `{"supportedAbis":["arm64-v8a","armeabi-v7a","armeabi"],"supportedLocales":["en-IN"],"screenDensity":320,"sdkVersion":34}`.
This matched Play within ~0.2 MB. `bundletool get-size total` uses gzip and is 1–3 MB too high; don't use it.
When comparing variants, also compare each split APK and `unzip -l` the master APKs: a variant must differ only in
what it is meant to remove (exp 1 variant D had a bigger dex and gave a wrong answer).

**Cold start:** `adb shell am force-stop <pkg>`, then `adb shell am start -W -n <pkg>/<activity>`, read `TotalTime`.
`TotalTime` stops at the **first frame**, even if that frame is a placeholder; also log the time to
`reportFullyDrawn()` (real content). For a breakdown, read `adb logcat -v time` from `Start proc` to `Displayed`.

**Tap → update:** timestamp the native tap and the main-thread batch apply (`SystemClock.uptimeNanos`), 100 taps,
p50 / p95.

**Frames:** `adb shell dumpsys gfxinfo <pkg> reset`, do the action, `dumpsys gfxinfo <pkg>`; or log frame deltas from
the Compose frame clock.

**Memory:** `adb shell dumpsys meminfo <pkg>`, total PSS after 10 s idle on the screen.

## 4. Measured numbers so far (Lava Blaze 2 5G, Android 14)
| What | Number | Build / notes | Date |
|---|---|---|---|
| RN app 1.8.0 Play download | 14.88 MB | `166.aab` (`useLegacyPackaging = true`) | 10-27 |
| Flutter 1.6.0 Play download | 13.06 MB | `164.aab` | 10-27 |
| zn app shell (Compose + Hermes + ML Kit + Firebase + Play services, no screens) | **6.42 MB** | exp 1 variant A, reproduced by Claude byte-for-byte | 10-27 |
| …with material3 | +0.58 MB | variant B | 10-27 |
| …scanner share (ML Kit + CameraX + doc scanner) | 2.30 MB | variant C | 10-27 |
| …Hermes share | ≈0.83 MB | native split A vs D (variant D's own total was wrong) | 10-28 |
| Tap → update | p50 0.97 ms, p95 2.08 ms | exp 2, release, in-app timestamps | 10-28 |
| Batch apply (normal update) | 0.38 ms | exp 2 | 10-28 |
| Building a whole screen through ops | 17 ms | exp 3 (no template in v0) | 10-28 |
| Cold start, exp 2 (one screen) | 222 ms `am start`; 158 ms to ready with AOT, 191 ms JIT | release | 10-28 |
| Cold start, exp4-flow (5 screens + flow + lists) | ~400–420 ms | release, built by Claude | 10-29 |
| Cold start, exp4-flow | ~485–545 ms (1,318 ms first run) | **debug** build | 10-29 |
| Cold start, Flutter 1.6.0 | ~300–330 ms | release | 10-29 |
| Cold start, RN 1.8.0 staging | 1,147 ms | release | 10-28 |
| Frames behind a translucent UPI window | p50 16.6 ms, 56 fps, 0 `onStop` | exp 3 | 10-28 |
| Restore after process death | 91 ms to ready | **debug**, clock start not stated; re-measure | 10-28 |
| List fling, template rows | 2.8–4 ms per frame at 90 Hz | prototype | 10-28 |
| List fling, generic node tree per row | 18–25 ms per frame | prototype | 10-28 |
| Hot reload, save → screen | 127 ms (Bun build 5 ms + hermesc 74 ms + device ~48 ms) | debug, dev only | 10-28 |
| Memory, exp 2 one screen | 59 MB PSS | prototype; RN full app 181 MB, Flutter 213 MB (not comparable) | 10-28 |
| Cold start, Step 1.5 sample (AmountScreen) | **227 ms** median (min 197 ms, p90 263 ms, 10 runs) | release (`:sample:installRelease`), Lava Blaze 2 5G | 10-29 |
| First JS batch applied | 140 ms after process start (before composition at 159 ms) | release, 19 ops applied | 10-29 |
| Memory, Step 1.5 sample | **77.8 MB** PSS (total RSS 162 MB, Java Heap 3.2 MB) | release, after 10 s idle | 10-29 |
| Template read & preparation | 2.58 ms (7 templates prepared) | release, memory-mapped | 10-29 |

### 4.1 Where exp4-flow's ~400 ms went (one release cold start, from `logcat`, 2026-10-29)
| From process start | What | Cost |
|---|---|---|
| 0 → 85 ms | process start, app init, `onCreate` | normal |
| 88 → 169 ms | UPI app discovery + 9 icon loads **on the main thread** | 81 ms (breaks rule 2) |
| 177 → 360 ms | Hermes boot (3 ms), then evaluating the whole bundle: 5 screens, **10,000 fake rows at load**, flow restore | ~180 ms (breaks rules 1 and 3) |
| 351 ms | first frame = "Loading ZeroBill..." placeholder (`am start` stops here) | — |
| 360 → 448 ms | whole screen built through JSON ops, applied on the main thread, drawn | ~88 ms (breaks rule 4) |

Estimate with the rules followed: ~200–250 ms, in line with exp 2. **Not measured yet**; milestone 1 must measure it.

## 5. Common causes of slow numbers (checklist)
- A debug build was measured.
- Work at module load, or the whole app's bytecode evaluated at start.
- Main-thread I/O or package-manager calls in `onCreate`.
- No Baseline Profile.
- JSON parsing on the main thread.
- A "Loading…" screen instead of a native skeleton.
- Developer settings left on from process-death tests.
