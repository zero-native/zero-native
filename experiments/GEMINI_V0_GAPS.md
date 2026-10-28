# zero-native v0: closing the gaps (brief for Gemini)

Written by Claude (Opus) for Pavan, 2026-10-28.

Great work on v0. The results hold up: Claude rebuilt variant A's device APKs and got exactly 6,422,175 bytes, and the
renderer, UPI animation and flow results are convincing. Before v0 is closed, a few things are missing or need fixing.
This brief lists them. **Same hard rules as `GEMINI_BRIEF.md` §1** (no real payments, no commits, no production, debug
keystore, Bun, PowerShell 5.1, stop and report).

Read first: `ARCHITECTURE.md` (it was updated on 2026-10-28 with your v0 lessons; see sections 5.2, 5.3, 7.2, 8.2,
12.4, 14, 19 and the decision log §24).

Order of work: **G1 → G2 → G3 → G4 → G5 → G6**. G1 and G2 matter most. Stop and report after G2, then after G6.

---

## G1. Exp 4: the missing scenarios (most important)
`GEMINI_BRIEF.md` §7.4 listed 14 scenarios. These were not run. They are exactly the double-payment edge cases, so
"zero double payments" is not proven until they pass.

| # | What to do | Expected |
|---|---|---|
| S4b | Debug-only crash point **right after** the `launchUpi` effect record is written as `started`, **before** `startActivity`. Restart the app. | Flow restores into `verifying`. UPI is **not** launched. `/stats`: 1 `/pay`. |
| S4c | Debug-only crash point **after** `/pay` is sent and the mock has received it, **before** the response is written to FlowStore. Restart. | `/pay` is `once` today → `verifying`, **no second `/pay`**. If G2 finds the backend is idempotent, re-test as `keyed`: re-sent with the **same** key, mock records one payment. |
| S7 | Press **Back** in the UPI app (no button tap). | `resultCode 0` → CANCELLED path, same `upi_response` string as RN (`RESULTCODE=0...`). |
| S8 | Cancel, then tap Pay again on the same screen. | New attempt allowed. New effect id. Old effect record stays `done`. `/stats`: 2 `/pay` calls, one per attempt. |
| S11 | Mock returns SUCCESS. Then kill the app (`am kill` while in background). Reopen. | Restores to the Success screen. No new `/pay` or `/verify` loop beyond what the flow defines. |
| S12a | `expiresAfter` = 60 s. Type an amount (no `/pay`). Wait 70 s. Restart. | Flow dropped, Home. |
| S12b | `expiresAfter` = 60 s. Start `/pay`, launch UPI, kill. Wait 70 s. Restart. | **Not** dropped: opens in `verifying` first (money may have moved). |
| S17a | Flow saved with schema v1. Install a bundle with schema v2 + `migrate[1]`. Cold start. | Migrated, continues at the same step. |
| S17b | Same, but v2 has no migration path. | `verifying` if a `/pay` or UPI effect was started, else dropped. No crash. |

- Crash points: guarded by a debug-only flag you set with `adb shell setprop debug.zn.crash <point>` (or a file in app
  storage). Release builds must not contain them.
- Run each scenario **3 times**. Report `/stats` for every run.
- **Pass:** every row as expected in all runs; never more than one `/pay` per attempt and never more than one UPI
  launch per attempt.

## G2. Is `/transactions/pay` idempotent?
Find out from the code, don't guess:
- RN repo (read-only): `src/store/useTxnStore.ts`, `src/backend/`, and the request headers sent with `/pay`.
- If Pavan's backend code is available locally (ask him for the path; the RN docs mention
  `payments-api`), read the `/transactions/pay` handler: does a second call for the same session
  create a second payment, return the first one, or fail?
- Write the answer in `exp-notes/5-pay-idempotency.md`: what you read (file + line), what happens on a repeat call,
  and the resulting effect kind (`keyed` or `once`). If it's `once`, write a short proposal for an idempotency key
  for Pavan's backend (header name, how long the server keeps keys). **Don't change any backend code.**

**Stop and report after G2.**

## G3. Exp 4 timing in a release build
- Rebuild exp 4 as **release** (R8 on, debug keystore).
- Re-measure "process death → screen ready" 10 times: start the clock at **process start**
  (`android.os.Process.getStartUptimeMillis()`, API 24+, compared with `SystemClock.uptimeMillis()`) and stop at `reportFullyDrawn()`. Report the median and
  p90, and say exactly where the clock starts.

## G4. Exp 3: proof for the JS-driven bar
`GEMINI_BRIEF.md` §6.3 asked for a second bar driven from JS (JS sets progress every 16 ms with a timer). The logs only
show `native_bar`.
- Log the JS bar the same way (`[FRAME] js_bar progress=… dt=…`), from the native side when the batch is applied.
- Run the PhonePe and P2pUPIapp test again. Report frame-gap stats for **both** bars between `onPause` and `onStop`
  (or the 2.4 s fallback).
- If the JS bar stutters while the native bar is smooth, that's fine: say so. It means progress animations must be
  native (which `ARCHITECTURE.md` §10 already says).

## G5. Exp 1: rebuild variant D correctly
Variant D's `base-master` APK has two dex files and is ~1.5 MB bigger than variant A's. So D was not "A minus Hermes":
something else changed (R8 / keep rules / a dependency). Claude's direct measurement of the native part gives a
Hermes share of **≈0.83 MB**, not 0.39 MB.
- Make D identical to A except: no `hermes-android`, no `libzn`, and the smoke screen skips the Hermes call.
- Check: `unzip -l` of both master APKs should differ only by the small bridge classes. Show that check.
- Report the new A − D difference (total, and per split APK).

## G6. Use the v0 lessons in the prototype code
Bring the prototype in line with the updated `ARCHITECTURE.md`, so the code you hand over is a good starting point
for v1:
1. **One JS runtime per process** (§8.2): create the JS thread + Hermes runtime from the `Application`, once. An
   Activity only attaches/detaches its Compose host. Remove `quitSafely()` from Activity callbacks.
   **Test:** with "Don't keep activities" on, type an amount, leave the app (Home button), come back: the amount is
   still there **and** logcat shows the runtime was **not** created again (log a runtime id).
2. **Timers** (§14): logical handles, `clear*` always wins (including an already-queued tick), all timers of a screen
   cleared when the screen is removed. Add `bun test` unit tests for the timer polyfill with a fake host.
3. **Signals** (§5.2): `set()` ignores `Object.is`-equal values. Unit test.
4. **Press lifecycle** (§5.3): `onPressOut` fires on cancel too, with `{ cancelled }`. Native key repeat
   `onPressRepeat={{ delay, interval }}`; switch the keypad backspace to it and delete the JS timer path.
   **Test:** hold backspace, drag the finger off the key, release: repeating stops at once. Hold past "0", release,
   type 5: the 5 stays.
5. **Hermes config** (§7.2): confirm `withMicrotaskQueue(true)` and `drainMicrotasks()` after every entry. Add a test:
   a Promise resolved inside an event handler runs its `.then` before the batch for that event is flushed.

## Report
Update `RESULTS.md` with a new section "v0 gaps (G1–G6)", using the same format as before. Put details in
`exp-notes/5-…` files. For every number, say the build type and where the clock starts.
Also correct two things in `RESULTS.md`:
- Mark the RN tap-latency values as **estimates** (the RN app has no tap instrumentation).
- Note that the cold-start and memory comparisons are prototype vs full app (directional only).
