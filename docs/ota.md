# OTA updates for zero-native apps (milestone 4): design

**Status: decided 2026-10-30 (Pavan accepted D1–D5 as recommended, §2); building from step 4.1.** Built from
ARCHITECTURE §16 and ZeroBill's React Native OTA v2 (`my-rn-app/docs/ota_architecture.md`, v7.1),
keeping every lesson that applies.

## 1. What an OTA bundle is in zero-native
- The app's **bytecode** (`main.hbc`), **templates** (`main.zn.ui`), **manifest** (`main.zn.ui.json`: routes,
  components) and the app's own **images** (`asset:` paths). Today all of these load from the APK's assets.
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
  - `hostApi`: `HOST_API_VERSION` of the bundled `@zero-native/core` (`packages/core/src/host-api.ts`; a test keeps
    it equal to the C++ number).
  - `modules`: every `nativeModule("X", { version })` / `callNative("X", ..., { __v })` in the bundled code, with
    the highest version asked for, read from the source at build time. The name must be a string literal (else a
    build error).
- **Rule:** the bundle runs only if the app covers all of it. Checked by the phone before loading (`ZnBundles`) and,
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
  sorted) is signed because `zn-bundle.json` itself isn't hashed; the zip SHA lets the phone check the download
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
  Download: `download.part` (+ `download.json` naming the zip's SHA), resumed with Range after a cut, then size and
  SHA checked. Install: `zn-bundle.json` is read first and must name the signed bundle; only the files it lists are
  extracted, each stopped at its listed size and checked against its listed SHA (no zip bombs, no paths outside the
  folder); then the bundle SHA and needs must equal the manifest's; then `tmp/<id>` is renamed to `bundles/<id>` and
  `current` is written last (atomically). The new bundle runs from the **next cold start**. Up to 4 older bundles are
  kept besides the running and the current one. `state.json` holds the install id, the seq per channel and the
  outcomes not yet sent (downloaded, switched, started, zip_sha, ...), which go with the next check.
- **JS API** (`@zero-native/core`): built in 4.5: `Updates.status()` (enabled, phase, progress, running, next,
  pendingRestart, last check / result / error), `Updates.check()`, `Updates.onStatus()`. Step 4.6: `Updates.applyNow()`,
  `Updates.holdApply()` / `releaseApply()`; 4.7: `Updates.markHealthy()`. Native never applies while held.
- **Apply = JS restart in place** (3.1's reload, made release-safe): the screens reopen by route name; FlowStore,
  storage and SecureStore are untouched; running native calls are cancelled (fetch included). Covered by a native
  cover screen so nothing flashes.

### 3.6 Safety nets (all RN lessons)
- **Launch watchdog on UI launches only** (FCM / WorkManager starts never count): a bundle that fails 2 launches in a
  row is blocked and the app goes back to its **built-in** bundle.
- **Error before healthy → rollback:** a JS error reaching the error screen (our `Platform.jsError` path) before the
  bundle is marked healthy blocks it and restarts on the built-in bundle. After healthy it is only counted.
- **Healthy mark:** automatically 4 s after the first screen is drawn (or `Updates.markHealthy()`).
- **Startup guard:** if OTA itself fails at start, OTA is off for that process and the built-in bundle runs; the app
  always starts.
- **Never during a checkout:** `holdApply` + guide notes; a cold start with a saved payment applies the bundle before
  JS, so bundles must keep reading saved flow state (FlowStore formats are versioned by the app).

### 3.7 Crash traces and telemetry
- Every log and crash report carries the running bundle id. The release CLI keeps each bundle's **source map**;
  `zn symbolicate` maps a release stack trace back to TSX lines (3.1's mapping, for release builds).
- Small telemetry with the next check (`downloaded`, `applied`, `rollback`, `error_screen`, `sig_rejected`,
  `incompatible` ...), no extra requests.

## 4. Proposed steps (milestone 4)
| Step | What | Done when |
|---|---|---|
| 4.0 | This proposal + Pavan's decisions (§2) → `docs/ota.md` becomes the design; ARCHITECTURE §16 / §24 updated | decisions logged |
| 4.1 | Bundle format and loader: one place decides where hbc / templates / manifest / images come from; built-in bundle id + serial in the APK | **done 2026-10-30** (`ZnBundles.kt`; see `docs/milestones.md` log) |
| 4.2 | Capability manifest: native side, compiler side (requirements), load-time check | **done 2026-10-30** (§3.2; `docs/milestones.md` log) |
| 4.3 | Signing + release CLI (`zn ota`): build, serial, sign, zip, publish (local folder / GCS), pointers with seq, kill switch, rollback, stable / approve, typed confirmation for production | **done 2026-10-30** for the local store (§3.3, §3.3b); GCS adapter waits for a test bucket |
| 4.4 | Reference update server (Bun): the check, the pure decision function (one test per row), Range downloads | **done 2026-10-30** (§3.4; `docs/milestones.md` log) |
| 4.5 | Client: check, resumable download, verify, atomic install, kept bundles, seq, `Updates` JS API | **done 2026-10-30** (§3.5; `docs/milestones.md` log) |
| 4.6 | Apply: cold start + `applyNow()` (release-safe restart), `holdApply()`, cover screen | apply during a visit, screens reopen; held during a fake checkout |
| 4.7 | Safety nets: watchdog, error-before-healthy rollback, healthy mark, startup guard, APK-newer, capability change | each one forced on the phone (a bundle that throws at start, one that crashes, a tampered file, a wrong signature) |
| 4.8 | Crash traces + telemetry: bundle id everywhere, source maps per bundle, `zn symbolicate` | a release crash maps back to the TSX line |
| 4.9 | Phone test matrix (below), docs, guide notes ("what OTA can and can't change", busy moments, state formats) | matrix green on the Lava |
| later | BSDiff patches (D5), CDN / signed download links, push-started checks (an `Updates.checkInBackground()` hook for apps' FCM handlers), iOS client | when needed |

**Phone test matrix (4.9):** first install → no OTA; publish #1 → downloads, applies on next cold start; `applyNow`
during a visit; held during checkout; kill during download / install / apply; tampered zip; wrong bundle signature;
wrong pointer signature; replayed old pointer (lower seq); kill switch; rollback to a kept bundle (no download);
bundle that throws at start → rollback in one launch; bundle that crashes twice → watchdog; APK update newer than the
OTA bundle; **older app offered a newer bundle needing a module it lacks → ignores it**; low storage; airplane mode;
FCM-style background start doesn't count as a launch.

## 5. What stays the app's job (as in the RN app)
Which moments are safe to apply (the gates), the update banner and its wording, push messages that trigger checks,
and the release workflow's human rules (who approves production). The framework gives the building blocks and a
sample that shows a sensible default (apply at cold start + after login + back on the start screen).
