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

### 3.2 Capability manifest (new; replaces RN's native hash for compatibility)
- **The app** (built into the runtime, computed at start): `registry` version, `bytecode` version (Hermes root API),
  `hostApi` version (we bump it whenever a host function or event format changes), and every registered native module
  with its version (built-ins: Keyboard, Fetch, SecureStore, Device...).
- **The bundle** (written by the compiler / release CLI): the registry version its templates use, its bytecode
  version, the host-API version of the `@zero-native/core` it bundles, and every native module it calls
  (`nativeModule("X", { version })`, `callNative("X", ...)`, read from the code at build time) with the lowest version.
- **Rule:** the bundle runs only if the app covers all of it. Checked by the server (it doesn't offer it) **and** by
  the phone before loading (a broken server can't push an incompatible bundle). The must-pass test: **an older app is
  offered a newer bundle and safely ignores it.**
- A native hash is still computed, but only for logs and the release page.

### 3.3 Signatures
- Bundle (once): `zn-ota-v1 \n bundle \n <app id> \n <bundle id> \n <bundle sha256> \n <assets digest> \n <requires digest>`.
- Pointer (every change): `zn-ota-v1 \n pointer \n <channel> \n <seq> \n <bundle id | BUILT_IN>`.
- Rollout % and priority are not signed (they only delay or speed up a bundle already chosen). Main + backup public
  keys in the app; the private key never in the repo.

### 3.4 The check (one request)
`GET /check` with headers: app id + channel, capabilities (digest + list), running bundle id + sha, built-in id, kept
ids, seq, install id, outcomes. A **pure decision function** (unit-tested row by row, like RN's `otaDecide`):
no channel → none; no pointer → none; stale seq → none; kill switch → `BUILT_IN`; already running → none; not in
rollout → none; built-in serial ≥ pointer → `BUILT_IN`; **app can't run it → none (`INCOMPATIBLE`)**; kept on the
phone → `USE_LOCAL`; else `UPDATE` (full download; patch later, D5). Resumable downloads (Range), `no-store`.

### 3.5 On the phone (Kotlin, `ZnOta`)
- **Process start** (every start, no network): new APK or changed capabilities → drop bundles that no longer fit;
  apply a downloaded bundle (SHA checked again); pick the bundle; **load from the bundle folder or the APK** (the
  runtime's loader, templates and images all go through one "where is the bundle" place).
- **UI launch and returns:** run the check on a background thread (one at a time); download to a part file; verify
  SHA, signature, capabilities; unzip into a temp folder; rename into place (atomic); mark it downloaded.
- **JS API** (`@zero-native/core`): `Updates.status()` (phase, progress, bundle, priority, title),
  `Updates.check()`, `Updates.applyNow()`, `Updates.holdApply()` / `releaseApply()`, `Updates.markHealthy()`.
  Native never applies while held.
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
| 4.2 | Capability manifest: native side, compiler side (requirements), load-time check | unit tests + "an older app ignores a newer bundle" on the phone |
| 4.3 | Signing + release CLI (`zn ota`): build, serial, sign, zip, publish (local folder / GCS), pointers with seq, kill switch, rollback, stable / approve, typed confirmation for production | publish → pointer → files on disk, all signed |
| 4.4 | Reference update server (Bun): the check, the pure decision function (one test per row), Range downloads | decision tests + manual checks with curl |
| 4.5 | Client: check, resumable download, verify, atomic install, kept bundles, seq, `Updates` JS API | phone downloads and installs; kill mid-download / mid-install leaves the old bundle running |
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
