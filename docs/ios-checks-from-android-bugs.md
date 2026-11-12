# iOS checks from bugs found on Android (2026-11-12)

Pavan asked for this list: the odd bugs we caught on Android phones over time (mostly the Lava, in the zn ZeroBill app),
so the Mac can check whether iOS has the same problem before the next App Store build. Written on Windows from
`docs/milestones.md`, the git history and the iOS code; **nothing here was run on an iPhone**.

Each row: what the user saw, the Android cause and fix (commit), why iOS might have it, how to check on an iPhone.
Status: **check** = not looked at on iOS; **code ok, hand check** = the iOS code handles it, one hand check left;
**done** = checked on iOS before (milestones entry named). Rule for fixes: native only, no registry or host API change.

## Results on the Mac (2026-11-12)

Simulator (zn iPhone 16, the sample) and code reading; Pavan's iPhone only for S1. Not pushed yet.

| # | Result | Fix | Seen / why |
|---|---|---|---|
| S1 | **fixed** | 401503b (pushed) | Our own sheet layer; 10 of 10 taps 40–190 ms after "Continue" landed; Pavan's iPhone 11 ok |
| S2 | **not affected** | — | Simulator: drag held on the processing sheet, JS closed it 6 s in: it went at once, the next sheet came up. Hand check on the referral sheet still good |
| S3 | **not affected** | — | Sample offers sheet: "View all" 166 → 253 pt, "Continue" stays on screen; "View less" back to 166 pt |
| S4 | **not affected** | — | Every sample sheet's last button sits above the home indicator. Not seen on a home-button iPhone (SE) |
| S5 | **not affected** | — | Code: closing dismisses from the presenter, so a share sheet / store page over it goes too. Two edge cases left: JS closes while that page still slides in (UIKit may refuse); an `Alert` over a closed sheet never settles its promise |
| T1 | **fixed** | 746a2e3 | hitSlop was not done on iOS at all. Now 15 pt outside counts, 26 pt doesn't |
| T4 | **code ok, hand check** | — | The edge swipe on a screen with a JS Back handler sends Back to JS, no pop; ZeroBill shows "Please wait" |
| R1 | **fixed** | fffd9be | Worse than Android: an old runtime's late answer settled the new runtime's call with the same id (reproduced). 3 restarts in a row: all answers right |
| R2, R3, R4 | **not checked** | — | Need the iPhone (a UPI app, iOS ending the app in background, Settings) |
| R5 | **code ok, hand check** | — | No read error deletes. Side risk: `forgetEarlierInstall` before first unlock (not seen) |
| R6 | **not affected** | — | iOS has no scroll commands yet (`scrollToIndex` etc. do nothing); ZeroBill uses none |
| R7 | **code ok, hand check** | — | Opens `openNotificationSettingsURLString` (iOS 17+) |
| N1, N2 | **not checked** | — | Need real UPI payments / network changes on the iPhone |
| B1 | **not checked** | — | Needs a Release (TestFlight) build on the iPhone |
| B2 | **not affected** | — | Simulator: `1,25,000`, `12 Nov 2026` (Hermes Intl on Foundation) |
| B3 | **not affected** | — | Code: errors are returned, not thrown (see the B3 row: no F_PREALLOCATE) |
| B4 | **fixed** | eef3800 | Single-line field in a 64 pt box had its text at the top; now centred. ZeroBill's own fields weren't hit (their boxes fit the text) |

## Sheets and modals

| # | What the user saw | Android cause and fix | iOS | How to check on the iPhone |
|---|---|---|---|---|
| S1 | After a sheet closes, the first tap below is lost (offers sheet → "Continue" → first keypad digit missing); `onDismiss` sent twice | The closing sheet window still took taps while it slid down. Fix: not touchable from the moment the close starts (4396e153); Android 14 also needed the dim flag gone (f638975, Android only) | **Done** (401503b, 2026-11-12) | 10 tries: digit tapped ~100 ms after "Continue" lands every time; one `onDismiss` log line. Same for `<Modal>` |
| S2 | JS closed a sheet while the finger still dragged it: the sheet sprang back and stayed, an empty scrim let taps through | The drag kept moving it after JS closed it (d489f2f) | **Code ok, hand check** (milestones 2026-11-11: UIKit owns the drag, dismiss is refused, so likely fine; the simulator couldn't test it) | Drag the referral reward sheet and hold while the app closes it (e.g. right after login); the sheet must go |
| S3 | "View all" added rows but the sheet kept its first height; the button below was cut | Content measured at the sheet's first height (b71d5b9) | **Done** (iOS i.5, "content detent follows the content") | ZeroBill offers sheet → "View all": the sheet rises, "Continue to Checkout" stays on screen; "View less" shrinks it |
| S4 | The sheet's last row was cut at the bottom | The dialog window learned its navigation-bar inset after the first layout | **Check** (the iPhone's home indicator is the same risk) | Every ZeroBill sheet: the last button is fully above the home indicator, also on an iPhone without a home button |
| S5 | A sheet that opened a share sheet / store page stayed up after JS closed it | `dismiss` closed only the top controller | **Done** (milestones 2026-11-11, "a sheet that presents something closes with it") | — |

## Taps and presses

| # | What the user saw | Android cause and fix | iOS | How to check |
|---|---|---|---|---|
| T1 | A small icon with `hitSlop` took taps ~100 dp away | An absolute child in a Stack measured its touch area on the whole Stack (80d8ff2) | **Check** | Sample RN props lab "pointer events slop": a tap 15 pt outside counts, 26 pt doesn't |
| T2 | Taps on a covered screen's buttons pressed through from the top screen | Found while building iOS (i.1c) | **Done** | — |
| T3 | Taps did nothing after switching tabs | iOS bug (milestones 2026-11-09, "taps after switching tabs") | **Done** | — |
| T4 | Back during "Opening UPI app…" left the payment half done | App fix (ZeroBill blocks Back while the UPI app opens) | **Check** the iOS edge swipe | Pay → while "Opening UPI app" shows, swipe back from the left edge: nothing happens |

## Process, restarts and native answers

| # | What the user saw | Android cause and fix | iOS | How to check |
|---|---|---|---|---|
| R1 | After a restart in the same process, start-up calls never answered (spinner forever) | While the runtime was replaced, native answers were dropped (8a311b2, `ZnRuntime.dispatchAnswer`) | **Check** (`Updates.applyNow`, dev reload replace the runtime on iOS too) | Apply an OTA in place (`applyNow`) and dev reload a few times: the main script's `Os.info` / `SecureStore` calls answer each time |
| R2 | After a kill during the UPI app, the screen showed "lost", then the result | The result came 24 ms after the first resume; the app had already said lost (ZnLaunch, 1 s wait) | **Check** (iOS returns from the UPI app by URL, not an activity result; the timing differs) | Pay, kill ZeroBill from the app switcher while in the UPI app, finish the payment, come back: one clear state, never "lost" then success |
| R3 | A typed OTP was gone after the app came back | The typed code lived only in the old Activity (R51) | **Check** with iOS restore (Phase 1b) | Type 3 OTP digits, background the app long enough for the system to end it (or use the simulator's memory warning), come back: digits kept, no second verify |
| R4 | A permission "no" was forgotten after a kill under the dialog | Android gives the answer to the new process (R50) | **Probably not on iOS** (iOS doesn't end an app under its permission alert; changing a permission in Settings does end it) | Change Location / Camera permission in Settings while ZeroBill runs, come back: the app reads the new state, no stuck prompt |
| R5 | User logged out after a read error of the saved token | Any read error deleted the value (1547 entry) | **Code ok, hand check** (`ZnBuiltInModules.swift`: `errSecInteractionNotAllowed` → `temporarily_unavailable`, value kept; saved with AfterFirstUnlockThisDeviceOnly) | Restart the iPhone, don't unlock, send a ZeroBill push that runs JS; unlock and open: still logged in |
| R6 | A list jumped / scrolled wrongly after its screen was rebuilt | A scroll command was replayed on the rebuild (e517bae) | **Check** | Screen with a list scrolled by code (e.g. back to top on tab re-tap), then a rebuild (rotate? font size change): no jump |
| R7 | "Notification settings" button did nothing | Wrong intent data (32b204d) | **Check** | Profile → notification settings: opens ZeroBill's notification page in Settings |

## Network

| # | What the user saw | Android cause and fix | iOS | How to check |
|---|---|---|---|---|
| N1 | After coming back from the UPI app, "verifying payment" hung for minutes | One HTTP/2 connection went dead silently; calls queued on it. Fix: HTTP/2 ping every 10 s (PAY-5, 4396e153) | **Check** (milestones 2026-11-11: URLSession has its own pool and per-call timers; not tested after a UPI round trip) | 5 payments in a row with a real UPI app: verify answers within a few seconds each time |
| N2 | Calls hung after Wi-Fi → mobile data | Old connection kept on the old network (af21335) | **Check** (milestones 2026-11-11 left this one iPhone check open) | ZeroBill on Wi-Fi, turn Wi-Fi off, refresh Home: answers within a few seconds |

## Release builds, storage, text

| # | What the user saw | Android cause and fix | iOS | How to check |
|---|---|---|---|---|
| B1 | The QR scanner never started in the store build (fine in debug) | R8 stripped ML Kit constructors (Android only) | **Check** the iOS Release config the same way | In the TestFlight / App Store build (not debug): scan a real UPI QR |
| B2 | ₹ amounts or dates wrong, or a crash on `Intl` | Hermes `Intl` crashed (2026-10-30) | **Check** | Amounts show `₹1,25,000` (Indian grouping) and dates in en-IN on the iPhone |
| B3 | App crash when the disk was full | FlowStore files with holes (posix_fallocate, 2026-11-04) | **Code ok** (flowstore.cpp's Apple path writes every block to fill the holes, no F_PREALLOCATE; ENOSPC is returned and the callers report it) | Hard to make on a phone; core tests on the simulator are enough |
| B4 | A single-line field with a tall box showed its text at the top | `ZnTextField` didn't centre single-line text (2026-11-05) | **Check** | ZeroBill login phone field and amount fields: text and cursor centred |
| B5 | `flexWrap` rows | iOS added flexWrap 2026-11-09 | **Done** | ZeroBill "You saved ₹X on this bill!" row wraps on a narrow iPhone |
