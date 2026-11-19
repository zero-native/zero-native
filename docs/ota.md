# OTA updates for zero-native apps (milestone 4): design

> **Next (plan, 2026-11-06):** the self-hosted server (zn-updates image), the `zn` CLI and the phone changes for a
> production release are planned in `docs/ota-architecture-plan.md`. This doc stays the record of what is built.

**Status: built on Android (steps 4.0–4.9 done 2026-10-31; the phone test matrix passed 28 of 28 on the Lava after the hardening steps, 2026-11-02;
`docs/ota-test-matrix.md`). Decided 2026-10-30 (Pavan accepted D1–D5 as recommended, §2). Not built: the GCS store
adapter (waits for a test bucket), BSDiff patches, iOS (§4 "later").** Built from
ARCHITECTURE §16 and ZeroBill's React Native OTA v2 (`my-rn-app/docs/ota_architecture.md`, v7.1),
keeping every lesson that applies.

## 1. What an OTA bundle is in zero-native
- The app's **bytecode** (`main.hbc`), **templates** (`main.zn.ui`), **manifest** (`main.zn.ui.json`: routes,
  components) and the app's own **images** (`asset:` paths). All of these load either from the APK's assets (the
  built-in bundle) or from a downloaded bundle's folder; one place decides which (`ZnBundles.kt`, step 4.1).
- Size now: the sample is **346 KB raw, ~115 KB compressed** (no React, no framework JS beyond our small runtime).
  ZeroBill's RN bundle is 4.3 MB JS + 0.6 MB images (hence its BSDiff patches).
- What can't change over the air: Kotlin / C++ (the renderer, native modules, Hermes), the registry, host functions.
  The **capability manifest** (§3.2) is how a bundle knows whether the installed app can run it.

## 2. Decisions (2026-10-30: the recommendation was taken for all five)
| # | Question | Decided | Other option (not taken) |
|---|---|---|---|
| D1 | **When may a bundle run on an installed app?** | **Capability manifest** (ARCHITECTURE §16.2, already decided): the app lists what it has (registry version, Hermes bytecode version, host-API version, native modules + versions); a bundle lists what it needs; it runs on **any** app version that covers it. One fix reaches every compatible install. | RN's way: an exact **native hash** per pool. Safest by construction, but every native change starts a new pool and old installs get nothing. |
| D2 | **Which server?** | The framework defines a small **check protocol** and ships a **reference server** (Bun) + release CLI with storage adapters (local folder, GCS). In milestone 5, ZeroBill's backend serves the same protocol from its `zappbundles` / `zappupdates` tables. | Reuse ZeroBill's `/v1/updates/check` (`x-zota-*` headers) as is. Faster for the pilot, but ties a community framework to ZeroBill's backend. |
| D3 | **Signatures** | **ECDSA P-256** with a main + an offline backup public key in the app (RN v2's proven setup; works on Android 7). | Ed25519 (ARCHITECTURE §16.1): Android has it natively only from API 33, so it would need a bundled library. |
| D4 | **When is a bundle applied?** | The framework gives the pieces: download in the background, apply at the **next cold start** by itself, and `Updates.applyNow()` (a release-safe JS restart, from 3.1's reload) for **moments the app chooses** (RN gates: after login, back on Home, Scan). The app marks busy times (`Updates.holdApply()` during a checkout). | Cold start only (ARCHITECTURE §16.1). Simpler, but RN learned customers open the app 1–2× a month, so fixes arrive a month late. |
| D5 | **Patches** | **Full compressed bundles first** (~115 KB today). Binary patches (BSDiff) later, only if real bundles pass ~500 KB compressed. | BSDiff from day one, like RN (+ bspatch / bzip2 in the core, ~70 KB, and more code to get right). |

**Notes on the decisions:**
- D1, "bytecode version": this is the **Hermes bytecode format number** (99 today), not the Hermes release. Hermes
  loads only bytecode with exactly its own format number; several Hermes releases share one number. So a new Hermes
  in an APK that keeps format 99 still runs old bundles, and one that moves to 100 can't (the check catches it).
- D5, later (Pavan, 2026-10-30): look at **smaller downloads by design**, not only BSDiff:
  (a) split the bytecode per screen (or per group of screens), so an update downloads only the screens that
  changed; (b) make builds patch-friendly: stable output order and ids, so a small TSX change gives a small
  binary change and BSDiff patches stay small. To be measured on real ZeroBill screens before choosing.

## 3. Design (assuming the recommendations)

### 3.1 Bundles, ids and the pool (RN v2's rules)
- **One bundle = one serial = one SHA-256.** Ids `<app>_<serial>` shown as **#12**; bigger = newer. Same bytes reuse
  their serial. The APK carries its built-in bundle's id; a **newer APK always wins** at once (no server).
- **One pool for staging and production; a channel is a signed pointer** (`staging → #12`, `production → #10`) with a
  `seq` the phone never lets go backwards. Production can only point at a bundle staging ran and the owner marked
  stable. **Rollback = move the pointer back. Kill switch = a signed pointer to "built-in".**
- On the phone: `noBackupFilesDir/zn-ota/bundles/<id>/` (not in backups: a restored bundle could be for another app
  version). A bundle folder mirrors the APK's assets: `main.hbc`, `main.zn.ui`, `main.zn.ui.json`, the app's images
  at their `asset:` paths, and `zn-bundle.json` (app, serial, id, one SHA-256 for the bundle, every file with its size
  and SHA-256; written by `tools/bundle-info.ts`). `zn-ota/current` holds the running id: one saved value, switched
  only at a safe moment; up to **K = 4** kept bundles, so going back downloads nothing. A bundle folder is never
  changed after install (bytecode is memory-mapped from it while JS runs).

### 3.2 Capability manifest (built in step 4.2; replaces RN's native hash for compatibility)
- **The app** (`ZnCapabilities.kt`, computed when a downloaded bundle is considered): the `registry` version its
  renderer knows (`Registry.VERSION`), the Hermes `bytecode` format (Hermes root API, 99 today), the `hostApi`
  range of its native side (`kHostApiVersion` / `kHostApiOldest` in `core/include/zn/engine.h`), and every
  registered native module with its version. Built-in modules (Keyboard, Fetch, SecureStore, Toast) are always
  registered; **apps register their own modules before `ZnTemplates.preload` / `ZnRuntime.evalAsset`** (a later
  `ZnModules.register` throws in debug builds and logs an error in release).
- **The bundle** (`requires` in `zn-bundle.json`, written by the build):
  - `registry`: the **lowest registry version that has everything its templates use** (components, props, props
    bound to slots, enum values, events). Everything that exists today is `BASE_VERSION` (8); anything added or
    visibly changed later is listed in `Added` in `registry.ts` with its version. So a bundle that doesn't use a
    new component still runs on older apps. The same number is in the `.zn.ui` header.
  - `bytecode`: read from `main.hbc`'s header (must match the app exactly).
  - `hostApi`: `HOST_API_VERSION` of the bundled `@zeronative/core` (`packages/core/src/host-api.ts`; a test keeps
    it equal to the C++ number).
  - `modules`: every `nativeModule("X", { version })` / `callNative("X", ..., { __v })` in the bundled code, with
    the highest version asked for, read from the source at build time. The name must be a string literal (else a
    build error). These are the modules needed on **both** OSes.
  - `os` (2026-11-11, docs/ota-requires-per-os.md): modules needed on one OS only, `{ "android": {...}, "ios": {...} }`,
    absent when there are none. A module's OS comes from the package of the file that calls it: a plugin's
    `zeroNative.platforms`, else its `android/` and `ios/` folders; core and the app's own files count for both.
  - Next to `requires`, not in it: `moduleFrom` (2026-11-11), each needed module → the package whose files call it
    (`@zeronative/core`, `@zeronative/firebase-messaging`, the app's own `@acme/upi`...; core wins when core calls
    it too). Not signed and ignored by phones; the release copies it into the manifest, and the dashboard groups a
    bundle's needs by it (framework, core, zero-native plugins, the app's own). Module names follow their plugin
    (docs/plugins.md, "Module names").
- **Rule:** the bundle runs only if the app covers all of it: `modules` plus `os` for the app's own OS (the phone sends
  `capabilities.os`; a check without it counts as Android). Checked by the phone before loading (`ZnBundles`) and,
  from step 4.4, by the server. **Safety net:** the phone also reads the bundle's templates while choosing it and
  refuses any id it doesn't know (unknown component, prop, enum value, event, or a slot on a prop that can't change
  at runtime in this app). A mistake in `requires` costs one refused update, never a wrong screen.
- **Registry changes are checked by machine:** `packages/template/registry.lock.json` keeps the last accepted
  registry. The registry test (and `bun run gen:registry`, which then refuses to write) fails if anything is removed,
  renumbered or retyped, if something new isn't in `Added` with the new `REGISTRY_VERSION`, or if a `since` goes
  down. A visible change in how Kotlin draws an existing entry can't be detected: that is a review rule (raise its
  `since` in `Added`).
- The must-pass test **an older app is offered a newer bundle and safely ignores it** passes on the Lava (step 4.2
  log in `docs/milestones.md`).
- A native hash is still computed later, but only for logs and the release page.

### 3.3 Signatures (built in step 4.3)
ECDSA P-256 with SHA-256; signatures are base64 DER (what Android's `SHA256withECDSA` verifies); public keys are
base64 SPKI DER, one line each. The texts are byte-identical in `tools/ota/signing.ts` (CLI, server) and
`ZnOtaSignature.kt` (phone); a JVM test verifies a signature the CLI made (`ZnOtaSignatureTest`).
- **Bundle** (once, at release): `zn-ota-v1 \n bundle \n <app> \n <bundle id> \n <serial> \n <bundle sha256> \n
  <requires line> \n <zip sha256> \n <zip size>`. The bundle SHA covers every file (code and images), so no separate
  image digest is needed; the requires line (`registry=8;bytecode=99;hostApi=2;modules=Device:1,Fetch:1`, modules
  sorted; one-OS modules appended as `;android=AndroidAdId:1;ios=…` only when there are some) is signed because `zn-bundle.json` itself isn't hashed; the zip SHA lets the phone check the download
  before unzipping it.
- **Pointer** (every change): `zn-ota-v1 \n pointer \n <app> \n <channel> \n <seq> \n <bundle id | BUILT_IN>`. The app
  is in the text (not in the first proposal), so a pointer of one app can't be replayed to another signed by the
  same key.
- Rollout % and priority are not signed (they only delay or speed up a bundle already chosen). Main + backup public
  keys in the app; the private key never in the repo (`~/.zero-native/keys/<app>-main.pem`; the CLI refuses a key
  inside the repo).

### 3.3b The store and the release CLI (built in step 4.3)
**Store** (`tools/ota/store.ts`): every record is a file created once and never changed, so two releases can't take
the same serial or seq (the second create fails) and no database or compare-and-swap is needed (RN OTA v2 left
compare-and-swap JSON on GCS because it was slow and easy to break). Per app:
```
<app>/bundles/<id>/<zip sha256>.zip     the files (the name has the SHA: a retry never replaces another zip)
<app>/bundles/<id>/manifest.json        the signed record; creating it is the moment the bundle exists
<app>/bundles/<id>/stable.json          "stable on staging" (created once)
<app>/channels/<channel>/<seq>.json     one file per pointer change (seq zero-padded); the highest is current
```
Adapters: a local folder now (development, tests, any static web server). **GCS: not built yet**: create-only
maps to an upload with `ifGenerationMatch=0`; it needs a test bucket to be built and checked against.

**CLI** (`bun run ota <command>`; settings in the app's `zn-ota.json`): `keygen`, `build` (builds the app, releases
the bundle; the same bytes reuse their serial; never publishes), `publish` (staging, production; rollback = publish an
older bundle), `stable`, `rollout`, `kill`, `status`, `verify` (every signature and zip). Rules (all in
`tools/ota/core.ts`, tested): production only for a bundle staging served and the owner marked stable, built from a
commit (not uncommitted changes), with an explicit rollout and the typed `PRODUCTION #N`; the kill switch needs
`KILL <CHANNEL>` (production also a reason) and is a signed pointer to `BUILT_IN`; one release action at a time on a
computer (`~/.zero-native/ota.lock`).

### 3.4 The check (one request; built in step 4.4)
The reference server (`tools/ota/server.ts`, `bun run ota serve`) is Bun.serve over the release store: the store's
zips are plain static files, and one route makes the decision (option B, Pavan 2026-10-30: the rules stay on the
server, where they can change without a store release; telemetry rides along). It never holds the private key.

**`POST /v1/check`** (JSON, at most 64 KB; answer `cache-control: no-store`):
```jsonc
{ "app": "sample", "channel": "production", "installId": "<random id made once by the app>",
  "capabilities": { "registry": 8, "bytecode": 99, "hostApi": 2, "hostApiOldest": 1, "modules": { "Fetch": 1 } },
  "running": { "id": "sample_12", "sha256": "…" } /* null = the APK's built-in bundle */,
  "builtIn": { "id": "sample_10", "serial": 10 }, "kept": ["sample_11", "sample_12"], "seq": 6,
  "outcomes": [{ "kind": "applied", "bundle": "sample_12", "at": "…", "detail": "…" }] }
```
Answer: `{ protocol: 1, action, reason, detail?, pointer?, bundle? }`. `pointer` is the signed pointer record,
sent whenever its seq is newer than the phone's (so the phone records it, even with NONE). `bundle` is the signed
manifest plus `url` (`/v1/files/<app>/bundles/<id>/<zip sha256>.zip`).

**The store question (optional, 2026-11-09):** the request may also carry `store: { os, version }` (`os` `"android"` with the
versionCode as a number, or `"ios"` with the app version like `"1.6.2"`; old phones send none; a wrong shape is dropped,
never an error). Then the answer also has `store: { update: { version, critical, title?, message? } | null, appStoreId? }`:
whether to update from Play / the App Store (`critical` 1 = ask, 2 = must), by the store rules of the phone's channel.
The reference server (`tools/ota/server.ts`) only parses the field; the update server (`docs/zn-updates-server.md` §4.6)
answers it. No `store` in the request = none in the answer, and the OTA part is the same either way.

**The decision** (`tools/ota/decide.ts`, pure, one test per row, in this order; RN's `otaDecide` lessons):
| # | When | Action / reason |
|---|---|---|
| 1 | nothing published on the channel | NONE `NO_CHANNEL` |
| 2 | the pointer's seq < the phone's (a stale server or cache) | NONE `STALE_SEQ` |
| 3 | kill switch (pointer → BUILT_IN) | BUILT_IN `KILL_SWITCH` (NONE if already on its built-in bundle) |
| 4 | the phone runs the pointer's bundle | NONE `UP_TO_DATE` |
| 5 | the install's bucket (SHA-256 of app, channel, install id; 0–99, stable) ≥ rollout % | NONE `NOT_IN_ROLLOUT` |
| 6 | the store lacks the named bundle | NONE `MISSING_BUNDLE` |
| 7 | the APK's built-in serial ≥ the bundle's | BUILT_IN `APK_NEWER` (NONE if already on it) |
| 8 | the app can't run it (same rule as `ZnCapabilities.kt`) | NONE `INCOMPATIBLE` + what it lacks |
| 9 | the phone keeps the bundle | USE_LOCAL `KEPT` (a rollback downloads nothing) |
| 10 | otherwise | UPDATE `NEW_BUNDLE` |
| 11 | (applied last, step 4.6) rows 3, 7, 9 or 10 gave a change, but the phone already has this pointer's seq | NONE `ALREADY_DONE` |

Row 11: the phone saves a seq only once its action is done, so a change at the same seq means it already acted: the
change waits for the next start, or it failed there (an `applyNow` whose code threw goes back to the old bundle). The
phone can't take a change without a newer signed pointer anyway; before this row every such check ended in an error
("USE_LOCAL without a signed pointer").

Rollout applies to rollbacks too: roll back at 100 % so every phone on the bad bundle moves.
**`GET /v1/files/<zip path>`**: only released zips (a strict path pattern), Range for resuming (206 / 416),
`cache-control: public, max-age=31536000, immutable` and the SHA as ETag (zips never change, so a CDN can serve
them later). **Telemetry**: one line per check in `<data>/<app>/checks-<date>.ndjson` (install id, running bundle,
seq, decision, the phone's outcomes). `GET /health`.

### 3.5 On the phone (Kotlin, `ZnOta`)
- **Process start** (every start, no network): new APK or changed capabilities → drop bundles that no longer fit;
  apply a downloaded bundle (SHA checked again); pick the bundle; **load from the bundle folder or the APK** (the
  runtime's loader, templates and images all go through one "where is the bundle" place).
- **UI launch and returns (built in step 4.5, `ZnOta.kt`, `ZnOtaInstall.kt`):** `ZnOta.configure(context,
  Config(server, channel, publicKeys))` in Application.onCreate (main process only). A check runs ~3 s after an
  Activity comes on screen and on returns to the foreground (at most every 5 min); never for a start without UI. One
  check at a time on its own thread. The phone keeps these rules whatever the server says:
  - a pointer counts only if its signature is valid, it is for this app and channel, and its seq is above the
    highest one accepted; UPDATE / USE_LOCAL / BUILT_IN need such a pointer naming the bundle;
  - **a seq is saved only once its action is done**, so a failed download is retried with the same signed pointer;
  - with NONE, an accepted pointer still decides what runs next: a kill switch or APK_NEWER clears `current`, and
    UP_TO_DATE sets it back to the running bundle (an installed update waiting for the next start must not start
    after a kill switch or a rollback; the server only sees what runs now);
  - the bundle must be signed, fit this app, and be newer than the APK's own.
  Time limits (2026-11-02): the check has 30 s for the whole call and fails as `server`; its answer is capped at
  256 KB while reading. The download has no total limit, so a slow one that still moves is fine, but 60 s with no bytes
  fails it as `download`, and the next check resumes it. Without these, a server that accepts and never answers would
  block the one OTA thread for good.
  Download: `download.part` (+ `download.json` naming the zip's SHA), resumed with Range after a cut, then size and
  SHA checked. Install: `zn-bundle.json` is read first and must name the signed bundle; only the files it lists are
  extracted, each stopped at its listed size and checked against its listed SHA (no zip bombs, no paths outside the
  folder); then the bundle SHA and needs must equal the manifest's; then `tmp/<id>` is renamed to `bundles/<id>` and
  `current` is written last (atomically). The new bundle runs from the **next cold start**. Up to 4 older bundles are
  kept besides the running and the current one. `state.json` holds the install id, the seq per channel and the
  outcomes not yet sent (downloaded, switched, started, zip_sha, ...), which go with the next check.
- **JS API** (`@zeronative/core`): built in 4.5: `Updates.status()` (enabled, phase, progress, running, next,
  pendingRestart, held, last check / result / error), `Updates.check()`, `Updates.onStatus()`. Built in 4.6:
  `Updates.applyNow()`, `Updates.holdApply()` (returns the release function); 4.7: `Updates.markHealthy()`, and
  status gets healthy, lastGood, blocked, otaOff. Native never applies while held. Module `Updates` is version 3
  since 4.7 (2 in 4.6).
- **Apply = JS restart in place** (built in step 4.6: `ZnOta.applyNow`, `ZnRuntime.restart`, `ZnBundles.candidate` /
  `switchTo`; 3.1's reload made release-safe):
  1. On the main thread: refused if updates are off, held, an apply is running, or the screens aren't up yet.
  2. On the client's thread (after any check in progress): the bundle `current` names is checked like at a cold
     start (info, sizes, needs, template ids) and its template files are read. The old screens keep running.
     `nothing` if it is what runs now; `failed` (nothing changed) if it can't run.
  3. On the main thread: held again? refused. Else a **cover** in the top screen's background colour goes over
     everything and takes every touch; back presses wait; the process switches to the new bundle's files; the JS
     runtime is destroyed and a fresh one runs the new main script; running native calls are cancelled (fetch
     included; their answers are dropped), timers and events of the old JS are dropped.
  4. The screens open again by route name and params (routes the new bundle no longer has are skipped; the start
     screen is always at the bottom); their JS state starts fresh. FlowStore, storage, SecureStore and files are
     untouched. The cover fades out once the new screens are built (NAV STARTED, step 4.7; 3 s at most).
  5. If the new main script throws while it starts, it is blocked on this phone (4.7), the bundle that ran before
     runs again the same way, `current` goes back to it, and the outcome `apply_failed` is sent with the next check.
  `restorableSignal` values (ARCHITECTURE §11) are not carried over an apply: the new code starts its screens fresh.
  Android's own restore (after it killed the app in the background) brings them back only if the same bundle runs.
- **Closed from recents while the process lives (added 2026-10-31):** some phones (the Lava) keep the process after
  the user swipes the app away. The next launch then starts fresh like other apps do: the JS runtime is replaced
  with the **same** bundle and the start screen opens (`ZnNav.startFresh`). It does **not** switch to a waiting
  update: that still waits for a real cold start or `applyNow()`. (Open question: should it pick up `current` here
  too? It is a natural safe moment, since no screen is open yet.)
     Otherwise the outcome is `applied`.
  JS that called `applyNow` is gone when it applies, so its Promise never settles; it resolves only with a refusal.
  `holdApply()` is a native call that is never answered: releasing it (or closing the screen that asked) cancels it,
  and native counts the open ones. Both run on the main thread, so a hold sent before `applyNow` is always seen.

### 3.6 Safety nets (all RN lessons; built in step 4.7: `ZnOtaHealth.kt`, `ZnOta.kt`)
Only a **downloaded** bundle is ever judged; the APK's own bundle always runs. What the phone remembers is in
`zn-ota/health.json` (the rules are pure functions, unit-tested: `ZnOtaHealthTest`).
- **"Screens up":** JS sends NAV STARTED (kind 8, host API 3) right after it built the first screens. A bundle built
  for host API 2 doesn't, so for it "the JS thread handled START" stands in.
- **Healthy mark:** a downloaded bundle is healthy once its screens were up `Config.healthyAfterMs` (4 s) **while the
  app is in the foreground**, or when JS calls `Updates.markHealthy()` (earlier; with `healthyAfterMs = 0`, only
  then). Healthy → it becomes **last good**: where a rollback goes. Going to the background before 4 s is not bad:
  the next launch starts the 4 s again.
- **Error before healthy → rollback in place:** JS fails to start, a screen throws while it is built (the error
  screen), or JS hangs (time limit), on a downloaded bundle not healthy yet → it is **blocked ("error", forever)** and
  the last good bundle (or, if none, or it can't run any more, the APK's) runs **in place**, the same way as
  `applyNow` (cover, screens opened again; ~12 ms swap on the Lava). The error screen isn't shown (debug builds still
  show the dev error box). If JS holds updates (`holdApply`: a payment), or the runtime can't be replaced yet, the
  good bundle only becomes `current` (next start) and the error screen shows. After healthy, errors are only counted
  (outcome `error_screen`). Decision D1 (a): back to last good, not straight to the APK's (RN goes to built-in).
  **Not for the phone's last good bundle** (added in step 4.8, Pavan's choice; `docs/second-opinions.md` entry 3):
  the healthy mark is per process, so it is on trial again for 4 s at every launch, but an error screen, a hang or no
  first screen there is only reported (`error_screen`, "last good bundle: reported only") and the error screen shows.
  It ran well on this phone before, and an "error" block is forever. Its crashes still count (watchdog, 3 in 24 h).
  One exception (2026-11-02): JS that throws at start comes back at every launch, so 2 failed starts in 24 h block it
  ("watchdog": until the next APK) and the APK's bundle runs.
- **First-screen rule:** a downloaded bundle not healthy whose screens aren't up `Config.firstScreenTimeoutMs`
  (10 s) after the app came on screen (counted while in the foreground) → rolled back the same way (a bundle that
  never calls `startApp`, or waits forever).
- **Launch watchdog, UI launches only** (FCM / WorkManager starts never count). **Changed 2026-11-02 (F4 option D):**
  whenever an Activity comes on screen on a downloaded bundle, healthy or not, the visit is marked *pending* (with the
  process id; 0.5–0.8 ms on the main thread in release, no fsync). Only going to the background clears it. At the next
  start a pending visit is judged: a crash mark from that process (below) or Android's exit record **of that process**
  (Android 11+): crash, native crash or ANR **count**; anything else (force stop, low memory, swipe away, reboot)
  **doesn't**. A phone restart after the mark never counts. Android < 11 can't say why: every other such death counts.
  **The times of the last 3 deaths are kept for 24 h.** The background and the healthy mark don't clear them; a new APK
  or a different bundle does, and times in the future are dropped. **Blocking ("watchdog"):** within 24 h, **1 sure
  crash** of a bundle never healthy on this phone (it comes back on the next start, so waiting only costs a second
  crash), **2 deaths** when Android can't be sure (Android < 11, no exit record, an ANR: a slow phone can freeze too),
  **3 deaths** of the phone's last good bundle (it ran well here; one crash may be a native SDK's bad luck). So a crash
  on return from a UPI app counts, and so does one after the healthy mark. The next start runs last good or the APK's.
  A watchdog block is cleared by the next APK install (it may fix a native cause); an error block never is.
  `launch_crashed` goes to the server every time, so it shows the rate per bundle, and the kill switch stays the tool
  for all phones.
- **Crash mark** (2026-11-02): a default uncaught-exception handler writes `zn-ota/crash-mark` (pid + time), then always
  calls the handler before it, so Crashlytics keeps working. It makes Java and Kotlin crashes "sure" below Android 11,
  and when a crash dialog was closed with a force stop. Native crashes never reach it.
- **A bundle that fails its checks at a start** (missing files, wrong hash, a module the app lacks; 2026-11-02): the last
  good bundle runs if it passes the same checks, and `current` points at it; else the APK's bundle runs and `current`
  goes. `bundle_unusable` is sent once per bundle id, and the next prune deletes the folder. A bundle that is only
  older than the APK's own bundle (a store update came after it) is normal: it sends `bundle_superseded` instead, which
  is not serious (no crash report, and a rollout's health doesn't count it). Seen on the Lava 2026-11-09 as a
  Crashlytics non-fatal after installing a newer staging APK.
- **Blocked bundles** never run, are never switched to, never offered as `kept`, and their folders are deleted. A
  channel pointing to a blocked bundle (a newer seq) → the seq is saved, nothing downloaded, result NONE BLOCKED,
  outcome `blocked`. The way forward is a fixed bundle (a new id).
- **New APK install** (versionCode or install time changed: Play updates, `adb install -r` even of the same build,
  checked on the Lava; Android Studio's Run installs the same way, but "Apply Changes" doesn't reinstall):
  crash counts, pending and the startup fuse reset, watchdog blocks clear, event `apk_changed`; at the first check
  bundles that no longer fit are deleted and `current` / last good stop naming them.
- **Startup guard + fuse:** if choosing the bundle throws (OTA's own code or files), the APK's bundle runs and OTA is
  off for that process (`init_failed`); twice in a row → **OTA off until the next APK install** (`ota_off`). The app
  always starts. While OTA is off no check runs (`NONE OTA_OFF`), so these two reach `onReport` but the server only
  after the next APK.
- **Reporting, never silent:** every outcome goes to the server with the next check and to
  `ZnOta.Config.onReport(ZnOtaReport)` at once on the main thread (`kind`, `bundle`, `detail`, `serious`): the app
  logs it to Crashlytics (e.g. `recordException` when serious). **Update 2026-11-04:** the Crashlytics plugin does this
  too (through `ZnOta.addReportListener`): a rollback, a blocked bundle or a failed install becomes a non-fatal named
  `zn.ota.<kind>` (one issue per kind), the other outcomes become log lines. Without the plugin, do it yourself in `onReport`. `bun run ota status` sums the last 7 days of
  telemetry per bundle (phones running it, outcome counts; safety-net ones marked `!`).
- **Cost** (release, Lava, n=10): cold start median 192–196 ms, as before 4.7 (196 ms); start checks 1–3 ms off the
  main thread; `health.json` is written at start only when something changed.
- **Never during a checkout:** `holdApply` + guide notes; a cold start with a saved payment applies the bundle before
  JS, so bundles must keep reading saved flow state (FlowStore formats are versioned by the app).
- **Low storage (added in step 4.9):** before a download, free space must cover the rest of the zip + 4× the zip
  (unzipped) + 50 MB left for the user; else the check fails with `no_space`, nothing written, retried at the next
  check. ENOSPC while writing removes the half-written files at once (`no_space`). `ZnOta.freeSpaceOverride` (debug
  tests: `debug.zn.ota_free_bytes` in the sample). Numbers: `docs/second-opinions.md` entry 5.

### 3.7 Crash traces and telemetry (built in step 4.8)
- **Bundle label everywhere:** `<id>@<sha12>` (`sample_8@1a2b3c4d5e6f`, `ZnBundles.Running.label`). The SHA is
  needed because the APK's own bundle is `<app>_0` in every APK. It is in `ZnJsError.bundleLabel`, in the message of
  `ZnJsError.asThrowable()`, and `ZnBundles.watchRunning { }` gives it at start and on every switch (an update applied
  in place, a rollback): an app sets it as a Crashlytics custom key, so native crashes name the bundle too.
  **Update 2026-11-04:** the `@zeronative/firebase-crashlytics` plugin does this for you: it sets the key `zn_bundle`
  (and `zn_bundle_id`) at start and on every switch. Without the plugin, do it yourself as above.
- **Release stacks have positions:** hermesc's default is `-g1` (same bytes as no flag): frames read
  `at HomeScreen (main.js:2051:22)`. `-g0` would save ~16% of the bytecode but lose them: not used.
- **Same source → same bytes on any machine:** hermesc runs in the input's folder with only the file name (it bakes
  the path into the bytecode), and `buildApp` names Bun's `// path` module comments from the entry's folder (they
  were relative to the working folder: `ota keep-map`, run in the app's folder, gave a different SHA than
  `bun run sample:js` at the repo root). Both changed every bundle's SHA once.
- **Source maps:** `buildApp(...).sourceMap()` composes Bun's map with the compiler's TSX map into one standard v3 map
  (main.js → TSX, sources relative to the app folder, no source text), with `x_zn_bundle: {app, id, sha256}`. The app's
  build writes it with `--map FILE`. The store keeps it at `<app>/maps/<bundle sha256>.map` (create-only):
  `ota build` keeps it with each released bundle (it fails if the build made none); **`ota keep-map`** builds the
  sources as they are now and keeps the map of the APK's own bundle: run it from the commit the APK is built from, at
  every APK release. `ota verify` lists released bundles without a map (those built before 4.8).
- **`bun run ota symbolicate [file] [--bundle <id|sha>]`** (or paste on stdin): finds the bundle label in the text (or
  `--bundle`: an id, a serial, or a SHA prefix of 8+; the APK's `_0` needs its SHA), and rewrites every main.js
  position: `at HomeScreen (src/HomeScreen.tsx:24:38 (main.js:2051:22))`. Reads Hermes frames, pre-4.8 full paths,
  and Crashlytics frames without a column (`at zn.js.HomeScreen(main.js:2051)` → `HomeScreen.tsx:24`: the source
  line most points on that main.js line map to, because Bun maps a line's leading spaces to the line before).
  `--from-telemetry` does the same for the last 5 outcomes with a stack in the server's telemetry.
- **Stacks in telemetry (D2):** `error_screen`, `error_rollback` and `apply_failed` carry `stack` (the top JS frames:
  `at` lines, at most 8 and 1 KB) and `sha` (the bundle's full SHA). The server keeps them (1 KB / 64 chars);
  `ZnOtaReport.stack` has them too. Other JS errors (handlers, async, parts) are the app's: `onJsError` →
  Crashlytics (D3). No extra requests: they go with the next check.
- **Crashlytics form:** `ZnJsError.asThrowable()` is a `ZnJsException` (kept by name in the runtime's R8 rules: R8
  had merged it into an unrelated exception class) whose message is `JS error [label] kind in where: first line` and
  whose stack is the JS frames as `zn.js.<function>(main.js:<line>)` (frames without a position left out), so issues
  group by JS function.
- Checked on the Lava (release): a tap handler and an async error in the APK's bundle map to their exact TSX lines
  from logcat, with and without columns; a bundle whose home screen throws rolls back and `--from-telemetry` gives
  `HomeScreen.tsx:24`; a never-healthy bundle that crashes once is blocked at the next start (debug build:
  `Device.crash`); cold start median 195 ms (n=10, as before).
- Small telemetry with the next check, no extra requests. Outcome kinds so far: `downloaded`, `switched`, `started`,
  `applied`, `apply_failed`, `healthy`, `error_screen`, `error_rollback`, `launch_crashed`, `watchdog_block`,
  `blocked`, `bundle_unusable`, `bundle_superseded`, `apk_changed`, `init_failed`, `ota_off`, `pointer_refused`, and a failed check's code
  (`server`, `download`, `zip_sha`, `signature`, `incompatible`, `bundle`, `no_space`, ...). Serious (a safety net acted,
  or a signed file didn't check out): `error_rollback`, `launch_crashed`, `watchdog_block`, `apply_failed`, `init_failed`,
  `ota_off`, `signature`, `zip_sha`, `bundle_unusable`.
- **Private data in error text** (2026-11-02): before a JS error's text is stored or sent, the phone masks URL query
  strings, bearer tokens, anything like `a@b`, and runs of 6 or more digits (spaces or dashes may be between them). Then
  `ZnOta.Config.redact` runs, if the app set one. Stack frames stay as they are. `onJsError` still gets the raw text.

## 4. Proposed steps (milestone 4)
| Step | What | Done when |
|---|---|---|
| 4.0 | This proposal + Pavan's decisions (§2) → `docs/ota.md` becomes the design; ARCHITECTURE §16 / §24 updated | decisions logged |
| 4.1 | Bundle format and loader: one place decides where hbc / templates / manifest / images come from; built-in bundle id + serial in the APK | **done 2026-10-30** (`ZnBundles.kt`; see `docs/milestones.md` log) |
| 4.2 | Capability manifest: native side, compiler side (requirements), load-time check | **done 2026-10-30** (§3.2; `docs/milestones.md` log) |
| 4.3 | Signing + release CLI (`zn ota`): build, serial, sign, zip, publish (local folder / GCS), pointers with seq, kill switch, rollback, stable / approve, typed confirmation for production | **done 2026-10-30** for the local store (§3.3, §3.3b); GCS adapter waits for a test bucket |
| 4.4 | Reference update server (Bun): the check, the pure decision function (one test per row), Range downloads | **done 2026-10-30** (§3.4; `docs/milestones.md` log) |
| 4.5 | Client: check, resumable download, verify, atomic install, kept bundles, seq, `Updates` JS API | **done 2026-10-30** (§3.5; `docs/milestones.md` log) |
| 4.6 | Apply: cold start + `applyNow()` (release-safe restart), `holdApply()`, cover screen | **done 2026-10-31** (§3.5; `docs/milestones.md` log) |
| 4.7 | Safety nets: watchdog, error-before-healthy rollback, healthy mark, startup guard, APK-newer, capability change | **done 2026-10-31** (§3.6; `docs/milestones.md` log) |
| 4.8 | Crash traces + telemetry: bundle id everywhere, source maps per bundle, `zn symbolicate` | **done 2026-10-31** (§3.7; `docs/milestones.md` log) |
| 4.9 | Phone test matrix (below), docs, guide notes ("what OTA can and can't change", busy moments, state formats) | **done 2026-10-31** (22 of 22 on the Lava: `docs/ota-test-matrix.md`) |
| later | BSDiff patches (D5), CDN / signed download links, push-started checks (an `Updates.checkInBackground()` hook for apps' FCM handlers) *(built 2026-11-04 in push v2, see below)*, iOS client | when needed |
| push v2 | Push-started checks: a data message `zn_ota=check` runs `ZnOta.check` in native code (`plugins/firebase-messaging`). On by default; turn it off with `PushPlugin(otaCheck = false)`. | **done 2026-11-04** |

**Known limit (push check):** the check from a push runs **at once**. It does not wait for the start delay that normal
checks use (about 3 s, "never in the way of startup"). A new bundle is still **not applied** while `Updates.holdApply()`
is held, but it **can download and unzip while a payment screen is open**. If that matters for a payment, send
this push only at quiet times, or set `otaCheck = false`. The apply itself stays safe.

**Changed 2026-11-09 (push v3, Android):** the push no longer checks at once. It schedules a WorkManager job after a
random wait of 0 .. `zn_ota_delay_ms` (clamped to 24 h), online only, one job at a time (a second push doesn't move
it), at most 3 runs. Phones join the topic `zn-ota-<app>-<channel>` by themselves. Contract and logs:
`plugins/firebase-messaging/README.md`, "OTA pushes". The limit above still holds for a wait of 0 (a staging push).

**Phone test matrix (4.9):** first install → no OTA; publish #1 → downloads, applies on next cold start; `applyNow`
during a visit; held during checkout; kill during download / install / apply; tampered zip; wrong bundle signature;
wrong pointer signature; replayed old pointer (lower seq); kill switch; rollback to a kept bundle (no download);
bundle that throws at start → rollback in one launch; bundle that crashes → watchdog (once on Android 11+, twice for
the last good bundle or on Android < 11); APK update newer than the
OTA bundle; **older app offered a newer bundle needing a module it lacks → ignores it**; low storage; airplane mode;
FCM-style background start doesn't count as a launch. **Built:** `bun run ota:phone` runs it (28 cases) on a phone;
results and what can't be run there: `docs/ota-test-matrix.md`.

## 5. What stays the app's job (as in the RN app)
Which moments are safe to apply (the gates), the update banner and its wording, ~~push messages that trigger checks~~
(*superseded 2026-11-04: the push plugin runs the check; the app only decides when to send the push*),
and the release workflow's human rules (who approves production). The framework gives the building blocks and a
sample that shows a sensible default (apply at cold start + after login + back on the start screen).
