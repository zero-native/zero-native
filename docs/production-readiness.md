# Production readiness: what is left before apps with 10M+ users

Started 2026-11-05, from the parent session's answer to Pavan ("what is pending before we can say zero-native is ready
for prod 10M+ user apps, including iOS"). Tick items off here as they land, with the date and the commit.

**Where we stand (2026-11-05):**
- **Android:** the foundations are built and ready for the ZeroBill pilot. The work left is mostly **proving it at
  scale**, plus a few real gaps.
- **iOS:** not built. No host yet (`ARCHITECTURE.md` "Where things stand").

**How to read the tags:**
- **[fact]** checked in the repo when written.
- **[view]** the parent session's judgment, not measured.
- "Blocks" says which step of the ladder (end of this file) needs it.

---

## A. Blocks 10M users on Android

### A1. 32-bit phones can't install apps. Blocks: 10k beta
- [fact] The sample and the runtime ship only `arm64-v8a`, plus `x86_64` in debug builds
  (`android/sample/build.gradle.kts:22`, `android/runtime/build.gradle.kts:18`).
- [view] Many low-end Indian phones (Android Go, 2–3 GB RAM) run a 32-bit system, so today they are shut out.
  Hermes supports `armeabi-v7a`.
- To do:
  - [ ] Build `armeabi-v7a` for the runtime and the plugins.
  - [ ] Measure memory and cold start on one real 32-bit phone.
  - [ ] Note the APK size cost: ship an App Bundle, so each phone downloads only its own ABI.

### A2. Tested on two devices only. Blocks: 10k beta
- [fact] Phone tests ran on the Lava Blaze 2 5G (Android 14, MediaTek) and the Android 13 emulator. An Android 9 (API 24-era)
  AVD exists but no full run was recorded.
- To do: a device matrix, through a cloud device farm (Firebase Test Lab or BrowserStack) for the smoke flows.
  - [ ] **Brands:** Samsung (One UI), Xiaomi (HyperOS kills background apps hard), Oppo / Vivo / Realme, Pixel.
  - [ ] **Android versions:** 7 to 9 (minSdk 24 is promised but not run on a phone); 14 to 16 (edge-to-edge,
    predictive back).
  - [ ] **Phone settings:** big font and display size, small screens, foldables.

### A3. No CI. Blocks: 10k beta
- [fact] There is no `.github` folder. All tests run by hand.
- To do:
  - [ ] On every push: JS, Kotlin and C++ tests, lint, a release build.
  - [ ] Budgets that fail the build: APK size, bundle size, cold start (`startup-and-performance.md`).
  - [ ] Nightly: the OTA test matrix (`ota-test-matrix.md`) on a device farm.

### A4. OTA at scale. Blocks: 10k beta (rollout), 100k (key drill)
- [fact] Today's server is the reference Bun server (`ota.md`).
- To do:
  - [ ] A CDN in front of the bundles.
  - [ ] Staged rollout by percentage, with an **automatic stop when crashes jump**: Crashlytics and the health
    marks stop the rollout.
  - [ ] Signing keys: where the key lives, who can sign, and a drill for switching to the backup key.
  - [ ] Test the kill switch on a real fleet.

### A5. Security for a payments app. Blocks: 100k–1M
- [fact] Certificate pinning is not built (`plugins.md`). RN has none either, so the pilot is fine without it.
- To do:
  - [ ] Pinning, with a pin rotation plan.
  - [ ] An outside security test: deep links, exported Android components, WebView rules, the OTA bundle chain,
    FlowStore files.
  - [ ] Fuzz tests for everything that reads untrusted bytes: OTA zips and manifests, template files, batch reading.

### A6. The "before real users" audit list. Blocks: first real users
Parked by Pavan until building is done (2026-11-04). Details are in the shared notes, `audit-2026-11-04.md`.
- [ ] C4: a push "check for an OTA update" must wait while a payment hold is open.
- [ ] C5: Crashlytics data is not masked by default.
- [ ] C6: Perf keeps URL paths and wraps the OTA clients.
- [ ] C10 (low): a refused start link's params come back after a restore.
- [ ] Analytics and DPDP (India's data protection law).

### A7. Seeing problems in the field. Blocks: 10k beta
- [fact] The Crashlytics and Perf plugins are built.
- To do:
  - [ ] ANR reports with JS stacks.
  - [ ] A dashboard per bundle: crash-free %, cold start p50 / p95, slow-JS events, OTA adoption.
  - [ ] Alerts on those numbers.

## B. Needed for a mass-market app, not for the pilot

### B1. Accessibility. Blocks: 100k–1M
- [fact] Accessibility props exist (`components.md`). No full TalkBack pass is recorded.
- [ ] One whole flow with TalkBack, big fonts and high contrast.

### B2. Languages. Blocks: 100k–1M
- [fact] `packages/core/src/intl.ts` exists, and `Intl` works since 2026-10-30 (guide §25).
- To prove end to end:
  - [ ] Hindi plus 2–3 regional languages: Indic text shaping, line breaks, fonts, mixed scripts in one line.
  - [ ] ₹ grouping in lakh and crore.
  - [ ] Plural rules.
  - [ ] How translations travel in OTA bundles.

### B3. Long sessions. Blocks: 100k–1M
- [ ] Memory over 30+ minutes: many screens, the image cache under pressure, Hermes heap growth.
- [ ] One leak pass (LeakCanary-style) and a soak test.

### B4. Text input on Indian keyboards. Blocks: 100k–1M
- [ ] Gboard Hindi, SwiftKey, Indic transliteration, OTP autofill on many brands. Input is where cross-platform
  frameworks break most often.

### B5. Long lists. Blocks: when an app needs it
- [ ] Above a few thousand rows, the native list source may be needed (`sqlite-plugin-proposal.md` DB.11, `lists.md`).

### B6. Authors coming from React Native. Blocks: before many app screens are written
- [fact] 2026-11-05: the first RN-style app (the ZeroBill pilot) hit a blank screen from an early `return`. Fixed in
  50f3bb2: the build now fails for it (guide §4).
- [ ] `docs/coming-from-react-native.md` and a sweep of 15–20 common RN screen shapes. In progress since 2026-11-05.
- [ ] Turn each "compiles but wrong" row of that page into a build error or a runtime warning (Pavan decides each).

## C. Feature gaps for general apps (ZeroBill's pilot doesn't need them)
- [ ] SQL: proposed (`sqlite-plugin-proposal.md`), to build in its own session.
- [ ] Maps, video, charts.
- [ ] Gesture-driven animation (Reanimated level).
- [ ] Background job scheduling (WorkManager).
- [ ] Play in-app update and in-app review.
- [ ] Biometrics: check what the auth plugin already covers first.
- [ ] A file system API.
- [ ] The flow engine is parked (`ARCHITECTURE.md` §12). Apps follow the save-then-verify pattern by hand
  (guide §16). It works, but needs discipline.

## D. iOS: a whole second track. Blocks: 10M (start it in parallel with step 4)
The C++ core, Hermes and the template format are shared. **The iOS host doesn't exist.** It needs:
- [ ] **A SwiftUI renderer:** slot cells, lists, sheets, `NavigationStack`, safe areas, keyboard. Plus conformance
  tests so Android and iOS draw the same templates the same way (`ARCHITECTURE.md` 9.5).
- [ ] **Every core module in Swift:** fetch (URLSession), storage, FlowStore (the mmap code mostly carries over),
  permissions, app state, links, dark mode, OTA. Same protocol: Apple allows downloaded JS as long as it doesn't
  change the app's main purpose.
- [ ] **Every plugin again:**
  - scanner (AVFoundation / Vision), PDF (PDFKit), push (APNs, plus FCM's iOS SDK), Firebase, WebView (WKWebView),
    media;
  - login: iOS has **no phone number hint** and **no SMS Retriever**; it uses `oneTimeCode` autofill.
- [ ] **UPI:** iOS can open a UPI app by URL scheme, but **there is no result callback**. The payment flow must lean
  fully on server verify and coming back to the app. The "never trust the UPI result, always verify" rule fits, but
  the screens and timings change.
- [view] Size: about as much work as Android milestones 1–3 plus the plugins, minus the design work. Months, not weeks.
  Start only after Android is proven in the field.

## E. Beyond code
- [ ] **Bus factor:** today it is Pavan plus Claude. A human Android or iOS expert reviewing `second-opinions.md`
  (100+ entries) is worth more than any one feature.
- [ ] **API stability:** semver for the public API, a deprecation policy, migration notes per release. Host API and
  registry versions already exist (`adding-components.md`), which is a good base.
- [ ] **Open source:** last, as planned (a step-by-step history replay that also hunts missed bugs).

---

## The ladder: each step has a pass bar
1. **Pilot** (now): the Lava pass, Pavan's SMS test, the ZeroBill pilot app.
2. **10k beta:** A1 32-bit, A2 device farm smoke runs, A3 CI, A4 staged rollout with auto-stop, A6 the audit
   list, A7 the field dashboard.
3. **100k–1M:** A5 security test and pinning, B1 TalkBack, B2 Hindi, B3 soak tests, B4 keyboards, the A4 key drill.
4. **10M:** proven numbers from step 3. iOS (D) starts in parallel here.

## Done log
| Date | Item | Commit |
|---|---|---|
| 2026-11-05 | A screen with an early `return` fails the build instead of drawing blank (B6, first part) | 50f3bb2 |
