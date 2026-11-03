# Independent review of P.3b–P.6 (2026-11-03)

**What:** a fresh Opus 5.5 agent read the uncommitted P.3b–P.6 code (core: native screens, `<NativeView>`, `zn://file`, background
tasks, secure screens, appearance; plugins: `scanner`, `auth`, `media`, `webview`). It saw the code and the RN references, not my
conclusions. It read only: no build, no tests, no phone. Then Claude (the session that built P.3b–P.6) read each finding in the code.

**All framework.** Nothing here is ZeroBill code.

**Status:** found and checked. **All 6 fixed 2026-11-03** (Pavan: "your call plan and fix"), by the session that built P.3b–P.6:
1. `ZnRuntime.jsError`: a hang with a task running and no screen in front is the task's (second-opinions entry 37).
2. `ZnLaunch.onResult`: the marker is deleted after the save and flush. A kill before the delete leaves a harmless marker.
3. `ZnNavHost`: FLAG_SECURE stays on while any secure screen is drawn (exit and cover animations), counted per screen. The app's
   own flag set after ours is still cleared by our dispose: not fixed, rare.
4. `nav.ts onSystemBack`: a Back for a screen JS already left is ignored (test in `nav-native.test.ts`).
5. `MediaModule forget`: the check and the delete run on the main thread, where every new job is written.
6. Media with no Activity answers `failed("no_activity")`.
Fixes 1, 2, 3 and 5 have no unit test (Android code); the phone suite and the OTA matrix ran after them.

## Findings

| # | Where | What is wrong | Checked by Claude | What can happen |
|---|---|---|---|---|
| 1 | `android/runtime/.../ZnRuntime.kt:366` (`jsError`), `packages/core/src/tasks.ts` | A JS **hang** always goes to `ZnOta.errorScreen` and `ZnNav.hung`, also when the JS that hung was a **background task** | Confirmed in code. Not confirmed: that Hermes' time limit fires inside a task's event | A task with >2 s of sync work can **roll back and block a new OTA bundle** that isn't healthy yet. With the app on screen, it marks the user's top screen as failed (and on a native screen the error is lost). Breaks `docs/guide-notes.md` §36: a task "can't block an update" |
| 2 | `android/runtime/.../ZnLaunch.kt:192` (`onResult`) | The "launch in flight" marker is deleted **before** the result is written and flushed (:201–203) | Confirmed | A kill in that gap (a few ms, wider now that a plugin's result reader runs there) leaves the record "waiting" **for good**: no marker means nothing marks it lost. Every later launch with that key answers "busy"; `Auth.phoneHint` with the same draft never resolves. The order is from P.2 |
| 3 | `android/runtime/.../ZnNavHost.kt:74`, `SecureWindow` | FLAG_SECURE follows the **top** route. It comes off when a secure screen is popped or covered, while that screen still shows in the ~300 ms animation | Confirmed | A screenshot or recording in that moment can capture the secure screen. Also: if the app set FLAG_SECURE after our effect, our dispose removes the app's flag |
| 4 | `packages/core/src/nav.ts:488` (`onSystemBack`), with `:213` | JS ignores which screen native's BACK was for and pops whatever is on top | Plausible: the window is a few frames | Scan a QR and press Back at nearly the same time: the result pops the scanner, then BACK pops Home, and with one screen left the **app exits** instead of going on to pay |
| 5 | `plugins/media/.../MediaModule.kt:106` (`forget`) | Checks the job id, does slow work (release URI permission), then deletes JOB **without checking again** | Confirmed, narrow window | `ack()` then an immediate `pickPhotos()` can delete the **new** job: that pick comes back "lost" |
| 6 | `plugins/media/.../MediaModule.kt:65, 83`, `plugins/media/src/index.ts:112` | With no Activity, `pickPhotos` / `takePhoto` **reject** | Confirmed | The types and docs promise `{ status: "failed", reason: "no_activity" }`; app code gets an unhandled rejection instead |

## Proposed fixes (each small; unit tests where the code allows)
1. A hang while a background task runs is reported as a task error. It never reaches `errorScreen` or `ZnNav.hung`. **OTA safety path:**
   this makes the rollback trigger narrower, never wider.
2. Delete the marker only after the record is written and flushed.
3. Keep FLAG_SECURE while any secure screen is still composed (count it per entry), not only while it is on top.
4. Ignore a system BACK whose screen id is not JS's top screen.
5. Check the job id again just before the delete.
6. Return `failed("no_activity")` instead of rejecting.

## Checked and found fine (by the reviewer)
- **Scanner:** ScanGate (the 500 ms stale window again on resume and on scan again, the lock and release), torch off on pause and not back
  by itself, camera follows the screen's lifecycle, the camera thread can't crash the app, close and unbind order.
- **Auth:** a second call settles the first, every Play services failure answers, the receiver is unregistered on every end and when JS
  is replaced, no phone number or OTP in any log.
- **`zn://file`:** refuses `..`, dot names, `/` and folders, and checks the real parent folder.
- **Background tasks:** one answer per task, timeout and abort, the queue across a reload, a launch mark only with the app in front.
- **Native results:** saved before NAV_RESULT; `onNavResult` and `pushForResult` don't both get one answer.
- **WebView:** URL and host rules, bridge origins, main-frame checks, the upload callback always answered, renderer-gone flow, threads.

## Not checked
The C++ / Hermes side (including whether the time limit fires in a task), registry v9 numbers against `Registry.kt` (a test covers it),
the `device-test` plugin, OTA internals beyond `errorScreen` and `markLaunch`, and the phone scripts in `tools/plugin-phone/`.
