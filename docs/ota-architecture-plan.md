# zero-native OTA: the full architecture plan (zn-updates server, `zn` CLI, phone side)

**Status: plan, 2026-11-06. Nothing in §6 onward is built.** This is the doc to come back to: it holds what exists
today (zn and ZeroBill RN), what Pavan asked for, the full design, the build plan in phases, and the open decisions.
Framework work: the image, protocol and CLI name nothing ZeroBill-specific. ZeroBill appears only as the first user
(§24) and as the source of lessons (§3).

**Goal (Pavan, 2026-11-06):** the zn ZeroBill app is being built for a **production release** (about its users on the
RN app today), not a pilot. OTA must be safe enough for that, and good enough that other app teams can self-host it,
the way teams use Expo's EAS Update.

**Sources:** `docs/ota.md` (the zn OTA design, built), `docs/ota-test-matrix.md`, `docs/production-readiness.md`,
`tools/ota/*`, `android/runtime/.../ZnOta*.kt`, `ZnBundles.kt`; ZeroBill RN: `my-rn-app/docs/ota_architecture.md`
(OTA v2), `docs/updates_db_design.md`, `tools/release/*` (`build:manage`), backend `v1-nodejs-backend-api/src/routes/ota.ts`,
`src/utils/otaDecide.ts`. Line references below were read on 2026-11-06.

---

## Contents
1. Pavan's brief, word for word in short
2. What zero-native has today (built)
3. What ZeroBill RN OTA v2 has today (built, in production use)
4. Take, change, drop: the comparison
5. Gaps that must close before OTA is on for production
6. The architecture in one page
7. Trust model and signing
8. Bundle identity, serials and store builds (versionCode, iOS, checkpoint AABs)
9. Compatibility: which bundle may run on which app
10. Channels, releases, rollout, rollback, kill switch, store rules
11. The phone protocol (v1 today, v2 additions)
12. Server API
13. Data model (Postgres)
14. Storage, downloads, CDN
15. Worker jobs
16. Three ways to answer phones: hosted, your own server, static
17. Login and permissions
18. Config: `package.json` and the image
19. The `zn` CLI
20. The console (release page)
21. Stats, alerts and automatic rollout pause
22. Running it: Cloud Run, Docker, backups, upgrades
23. Phone-side work
24. ZeroBill as the first user: how it moves over
25. Testing plan
26. Phases, tasks, estimates
27. Risks
28. Decisions for Pavan
29. Words used here

---

## 1. Pavan's brief (2026-11-06)
1. A **self-deployable Docker image**, built and managed like Expo's updates service.
2. App developers can have **their own servers serve the content**, but ask zn-updates in time for the latest patches
   and their details (especially patch URLs).
3. The image is configured by environment: `POSTGRES_DB_URL`, `GCP_AUTH_MODE={SERVICE_JSON|WORKLOAD_IDENTITY|...}`, and so
   on. Once configured, **one deployment manages many zn apps**, each with staging, production and other channels.
4. The zn project's **`package.json` holds the deployment's URL**, and a suggested way to authenticate both sides
   (CLI ↔ server, phone ↔ server).
5. The **`zn` CLI builds and uploads bundles, patches and so on**, with the same ideas as `eas`.
6. **Learn from ZeroBill RN's OTA** architecture and its `build:manage` tool.
7. Earlier concerns, still open (side chat, 2026-11-05/06):
   - A new checkpoint AAB must sometimes ship with no native change, so versionCode goes up. Old installs must still get
     OTA after that, and the AAB must not lose to an older OTA bundle.
   - **Big versionCodes** in other teams' apps, **apps that reset versionCode** (to 1 on each marketing version), and
     **iOS build numbers that reset**: we must not force other teams to change how they number builds.

---

## 2. What zero-native has today (built, Android)
Built in milestone 4 (2026-10-30/31), hardened 2026-11-02, push-started checks 2026-11-04. 38 of 38 phone-matrix cases
pass on the Lava (`docs/ota-test-matrix.md`).

### 2.1 A bundle
- Files: `main.hbc` (Hermes bytecode), `main.zn.ui` (templates), `main.zn.ui.json` (routes, components), the app's
  `asset:` images, and `zn-bundle.json` (`tools/zn-build.ts:57-73`). On the phone: `noBackupFilesDir/zn-ota/bundles/<id>/`
  (`ZnBundles.kt:169`).
- `zn-bundle.json`: `format: 1, app, serial, id = <app>_<serial>, sha256, requires, files{path: {size, sha256}}, builtAt`
  (`tools/bundle-info.ts:31-45`).
- **Bundle SHA** = SHA-256 of the sorted lines `"name size sha256\n"`, one per file, `zn-bundle.json` left out
  (`bundle-info.ts:52-57`, same in `ZnOtaInstall.kt:89-92`). So the serial can be stamped in after the build without
  changing the SHA (`setBundleSerial`, `bundle-info.ts:104-110`).
- **`requires`** (`bundle-info.ts:20-29`): `registry` (lowest registry version the templates use), `bytecode` (Hermes
  format number from the `.hbc` header, 99 today, must match exactly), `hostApi` (from `packages/core/src/host-api.ts`,
  9 since 2026-11-06), `modules{name: minVersion}` (scanned from `nativeModule` / `callNative` literals).
- Size: the sample is about 346 KB raw, about 115 KB zipped. ZeroBill's RN bundle is 4.3 MB JS + 0.6 MB images.

### 2.2 Compatibility check
Refused if `requires.registry > app`, bytecode differs, `hostApi > app.hostApi` or `< app.hostApiOldest`, or a module
is missing or older (`tools/ota/decide.ts:77-88`, same rule as `ZnCapabilities.kt:17`). At load the phone also checks:
same app, serial above the built-in one, all code files there, sizes match, capabilities fit, no unknown template id
(`ZnBundles.kt:364-389`).

### 2.3 Finding updates
- One request: `POST {server}/v1/check` (`ZnOta.kt:267-296`), then a zip download from `bundle.url` (relative to
  `server`, `ZnOta.kt:436`). No static pointer files.
- Request: `app, channel, installId` (random UUID, `ZnOta.kt:548`), `capabilities{registry, bytecode, hostApi,
  hostApiOldest, modules}`, `running{id, sha256}` or null, `builtIn{id, serial}`, `kept[]` (max 16), `seq`, `outcomes[]`
  (`kind, bundle, detail, at, stack, sha`; phone keeps max 20, server takes max 50). Body max 64 KB; answer max 256 KB;
  30 s timeout (`ZnOta.kt:66-67`).
- Answer: `{protocol: 1, action: NONE|UPDATE|USE_LOCAL|BUILT_IN, reason, detail?, pointer?, bundle?}`. `pointer` = the
  signed pointer record; `bundle` = signed manifest + `url`.
- **Decision** (pure, `tools/ota/decide.ts:103-136`, one test per row; `docs/ota.md` §3.4): 1 `NO_CHANNEL`, 2
  `STALE_SEQ`, 3 `KILL_SWITCH`, 4 `UP_TO_DATE`, 5 `NOT_IN_ROLLOUT`, 6 `MISSING_BUNDLE`, 7 `APK_NEWER`, 8 `INCOMPATIBLE`,
  9 `KEPT` (USE_LOCAL), 10 `NEW_BUNDLE` (UPDATE), 11 `ALREADY_DONE`.
- When: 3 s after the first Activity shows, then on each return to the front at most every 5 min, never for a start
  with no UI (`ZnOta.kt:79-81, 141-170`). A push data message `zn_ota=check` runs a check in native code and waits up to
  15 s (`plugins/firebase-messaging/.../ZnMessagingService.kt:22, 53-61`); off with `PushPlugin(otaCheck = false)`.
- Downloads resume with `Range` (`download.part` + `download.json`, `ZnOta.kt:425-474`). Zips are served
  `public, max-age=31536000, immutable`, ETag = zip SHA, Range 206/416 (`tools/ota/server.ts:139-163`).
- Config in code: `ZnOta.Config(server, channel, publicKeys, checkIntervalMs, firstCheckDelayMs, returnCheckDelayMs, healthyAfterMs,
  firstScreenTimeoutMs, onReport, redact)` (`ZnOta.kt:71-99`).

### 2.4 Signing
- ECDSA P-256, SHA-256; signatures base64 DER; keys base64 SPKI DER; `keyId` = first 16 hex of SHA-256 of the key
  (`tools/ota/signing.ts:50-72`).
- **Bundle text** (lines joined by `\n`): `zn-ota-v1, bundle, app, id, serial, bundleSha256, requiresLine, zipSha256,
  zipSize`; `requiresLine` like `registry=8;bytecode=99;hostApi=2;modules=A:1,B:1` (`signing.ts:33-43`,
  `ZnOtaSignature.kt:27-36`).
- **Pointer text:** `zn-ota-v1, pointer, app, channel, seq, target` (bundle id or `BUILT_IN`).
- Not signed: rollout %, priority.
- Keys in the app: `publicKeys` (main, backup); either is accepted (`ZnOtaSignature.kt:46-66`). Private keys at
  `~/.zero-native/keys/<app>-main.pem` or `ZN_OTA_KEY`; the CLI refuses a key inside the repo (`tools/ota/cli.ts:91-98`).
- No rotation beyond the backup key; the key drill is a to-do (`docs/production-readiness.md:52`).

### 2.5 Serials, rollout, rollback, kill switch
- Serial = highest + 1; same bytes + same `requires` reuse their serial; records are create-only (`tools/ota/core.ts:166-171`).
- Rollout bucket = SHA-256(`app\nchannel\ninstallId`), first 4 bytes mod 100; in the rollout when bucket < % (`decide.ts:94-97`).
- Production needs a `stable.json` mark (only after the bundle was on staging), a clean git build, an explicit
  `--rollout`, and the typed text `PRODUCTION #N` (`core.ts:263-277, 333-340`).
- Rollback = publish an older bundle (arrives as `USE_LOCAL KEPT`, no download). Kill = signed pointer to `BUILT_IN`,
  typed `KILL <CHANNEL>`, production needs `--reason` (`core.ts:291-296`).
- The phone saves a seq only after acting, refuses lower or equal (`ZnOta.kt:304-310`).

### 2.6 Health and roll back on the phone (`ZnOtaHealth.kt`, `docs/ota.md` §3.6)
- Healthy after 4 s in front with screens up (JS sent NAV STARTED), or `Updates.markHealthy()`; then it is "last good".
- Before healthy, any of: the start throws, an error screen, a JS hang, no first screen in 10 s → the bundle is
  blocked for good and the app rolls back in place to last good (else the APK's bundle).
- Launch watchdog: a mark per foreground visit, judged by Android exit records + a `crash-mark` file. Within 24 h:
  blocked after 1 sure crash, 2 unsure deaths, or 3 deaths for the last good bundle.
- Startup fuse: 2 failed starts turn OTA off until the next APK. Low-space guard: free space ≥ rest of zip + 4× zip + 50 MB.
- Apply: next cold start by itself, `Updates.applyNow()` at moments the app chooses, `Updates.holdApply()` during a
  checkout (D4).

### 2.7 Reporting
Outcomes ride on the next check; the reference server writes one NDJSON line per check (`server.ts:116-136`); `ota status`
sums 7 days. Kinds: `downloaded, switched, started, applied, apply_failed, healthy, error_screen, error_rollback,
launch_crashed, watchdog_block, blocked, bundle_unusable, apk_changed, init_failed, ota_off, pointer_refused` + a failed
check's code (`server, download, zip_sha, signature, incompatible, bundle, no_space`). JS error text is masked (URL
queries, bearer tokens, emails, 6+ digit runs) before it is stored or sent. Crashlytics gets the bundle id.

### 2.8 Tools
`bun run ota <cmd>`: `keygen, build, publish, stable, rollout, kill, status, verify, keep-map, symbolicate
[--from-telemetry], serve` (`tools/ota/cli.ts:4-16`). Settings in the app's `zn-ota.json` (`app, build[], store, key?,
publicKeys[]`). Store = a local folder only (`tools/ota/store.ts`): `<app>/bundles/<id>/<zipSha>.zip`,
`.../manifest.json`, `.../stable.json`, `<app>/channels/<ch>/<seq, 10 digits>.json`, `<app>/maps/<bundleSha>.map`.
`ota serve` gives `/v1/check`, `/v1/files/<path>`, `/health` and never holds the private key. One release action per
machine (`~/.zero-native/ota.lock`). There is no `zn` binary yet (`ARCHITECTURE.md:122` plans one).

---

## 3. What ZeroBill RN OTA v2 has today
In-house "bootloader", not CodePush, expo-updates or hot-updater (`my-rn-app/AGENTS.md:36`). v2 since
2026-10-21, unit-tested, **not yet checked on a phone** (`docs/ota_architecture.md:8, 635`). Chosen over expo-updates
for BSDiff patches (about 100 KB instead of about 5 MB on Indian mobile data), a strict native-hash contract, and
control over when an update applies (never in a checkout) (`:107-109`). v2 replaced v6 after unreadable ids, two
copies per channel, no guard against an untested production bundle, and a 2026-10-21 bundle that crashed Home on every
staging phone while the watchdog missed it (`ZErrorBoundary` caught the error) (`:45-57`).

### 3.1 Server
- In the main API (`v1-nodejs-backend-api/src/routes/ota.ts`, 961 lines; pure `src/utils/otaDecide.ts` with tests).
- Files on GCS `my-gcp-project.appspot.com` under `ota2/<os>/<native hash>/bundles/<id>/`: signed `manifest.json`,
  `bundle.zip`, `patch-from-<serial>.zip`. Private objects, no CDN: Express streams from a local SSD cache or from GCS
  (`ota.ts:396-407`). The phone follows `x-zota-download-url`, so a CDN is a backend-only change.
- Postgres via Prisma: `zappupdates` (append-only log: `type STORE_UPDATE|OTA_UPDATE|OTA_KILL_SWITCH`, `target
  staging|production`, `critical 0|1|2`, `os, app, native_hash, bundle_serial, bundle_id, rollout_pct, seq,
  update_signature, store_version_code, is_test, removed, flags, reason, published_by`; unique `(os, app, target,
  native_hash, seq)`) and `zappbundles` (`bundle_id, native_hash, bundle_serial, bundle_hash, bundle_size,
  assets_digest, bundle_signature, full_zip, patches, state building|ready|failed, git_commit, git_subject, git_dirty,
  in_store_builds, stable_on_staging, stable_by, customer_title, built_by, built_at`; unique on serial and on bytes).
- Cache: 30 s in memory, 5 min in Redis; last good answer if the database is down. Dev and production backends share
  one database.
- Check: `GET /v1/updates/check` with `x-zota-*` headers (app id, native hash, running, running sha, apk bundle, local,
  seq, install id, version code, outcomes) + `Range`; statuses `NO_CHANNEL, NO_ACTIVE_RELEASE, UP_TO_DATE,
  REVERT_TO_BASE, NOT_IN_ROLLOUT, APK_NEWER, USE_BUILT_IN, USE_LOCAL, UPDATE` (bsdiff or full). URLs hardcoded per
  channel (`OtaCheck.kt:29`).
- Admin: `admin/hashes, state, bundles/reserve, /ready, /failed, /stable, /title, /store-build, /delete, admin/updates,
  store-rules/update, /delete, native-hashes/forget, push-ota`, `/v1/ota/sync, /invalidate, /stats`, public `/pointer`.
  Auth: `security-date` + `security-hash` = HMAC-SHA256(`DEPLOY_TOKEN`, date), ±5 min. Signing only on the owner's
  computer (ECDSA P-256, `~/.zerobill/ota-signing.pem` + backup; public keys in the APK assets).

### 3.2 Concepts
- **Native hash** `nat_<16 hex>`: native packages `name@version`, `patches/`, `android/app/src/**`, Gradle, proguard;
  excludes versionCode, includes versionName. **`--as-hash`** is a workaround: after a `bun install` the same native code
  hashed differently, so every OTA must be built "as" the Play hash with a typed confirm, and nothing checks the native
  code really matches. To be removed "when zero-native replaces this app".
- Pool + serials per native hash, shared by both channels; same bytes = same serial; `reserve` hands out serials.
- Channels = separate apps (`com.example.app.staging` vs `com.example.app`); each channel a signed pointer
  with seq.
- Mark stable (only if staging pointed at it after it was built); production needs stable, clean git, explicit
  rollout %, typed `PRODUCTION #N`. Rollout 0–100 not signed, bucket = `sha256(installId:bundleId)`. Priority 0/1/2.
  Rollback = pointer back (phones keep 4 old bundles). Kill switch row with typed `KILL <CHANNEL>` + reason.
- **Store rules**: `STORE_UPDATE` rows → forced-below and optional-below thresholds (and a pair for test phones),
  headers `x-zota-store-version`, `x-zota-store-critical`; JS opens Play's own update sheets.
- Customer title (≤ 30 chars, unsigned header) for an "update ready" banner.

### 3.3 `build:manage`
- `bun run tools/release/server.ts`: a local web page (Bun + React), 127.0.0.1, random port, per-run token, Host check.
  Pages: Overview, OTA bundles, Channels, Play/Apple updates, Builds, Phones, Activity, Native versions, Environment.
  CLI twin: `tools/release/cli.ts`. Rules in `tools/release/core/` with tests.
- Build: typecheck → refuse older code unless confirmed → Gradle JS bundle only → SHA + image map → reserve serial →
  BSDiff patches from the last 5 ready bundles + the newest 3 store builds' bundles → full zip → sign manifest → upload
  zips first, manifest last → `bundles/ready` → source map kept locally and uploaded privately. Builds never publish.
- Store builds write `bundle_id.txt`, `apk_images.json`, `native_hash.txt` into assets, re-check the production JS SHA
  against the pool, and record the build.
- Publish appends a signed `zappupdates` row (seq-conflict retry), then FCM topic `ota-android-<channel>`; phones wait a
  random delay (≤ 3 s staging, ≤ 6 h production). Lock file; `published_by` etc. = the gcloud account.

### 3.4 App side
Native `android/app/src/main/java/com/example/app/ota/` (~2,300 lines: `ZBootloaderManager`, `OtaCheck`,
`OtaInstall`, `OtaLaunch`, `BsPatch`, `OtaCheckWorker`, `ZReactHostFactory`, `ZBootloaderModule`); JS gates in
`src/services/ota/` (splash, pre-scan, login, home return, resume, push, update strip). Checks on every UI launch,
every real return, back on Home with nothing downloaded, and on push (WorkManager). Applies a staged `next` at process
start, or during the visit at gates (never in a checkout). Verifies SHA, every image hash, both signatures. Outcomes:
up to 6 in `x-zota-outcomes`, stored per day for 35 days. Watchdog: 2 launches without "healthy" → built-in. Error
screen before healthy → roll back at once.

### 3.5 Lessons and pain points (keep all)
- Patch only against the exact built bytes; carry images forward; no PowerShell zip backslashes; pick the bundle path on
  every JS load; count only UI launches in the watchdog; kill switch is a signed row, not a cache delete; no default
  deploy token (`:96-105`).
- `--as-hash` drift; no CDN; one owner, one key, rules only in the tool, "stable" a manual mark (later: Cloud KMS,
  require one healthy staging phone in stats) (`:644-652`); error screens after healthy aren't rolled back; cold-start
  splash wait rarely helps (check answers ~740 ms after tap on a new HTTPS connection, `:417`); push must be high
  priority, and Data Saver, OEM savers and force-stop block it (`:517-555`); saved checkout data must stay readable by
  the next bundle (only add optional fields, `AGENTS.md:64`); iOS has no client.

---

## 4. Take, change, drop

| Topic | zn today | RN v2 | Plan |
|---|---|---|---|
| Which bundle may run | Capabilities (no native hash) | Native hash + `--as-hash` | **zn's capabilities** (no hash, no drift) |
| Signing | P-256, main + backup, local | Same | Same, + KMS option, + key drill |
| Pool | One per app, all channels | One per native hash | **One per app** (capabilities replace hashes) |
| Serial of a store build | 0 unless `--serial N` by hand | Reserved from the server | **Reserved from the server** (§8) |
| Patches | None | BSDiff, 5 + 3 bases | **File-level first, then binary patches made by the server** (§15) |
| Release rules | In the CLI | In the tool | **In the CLI and checked again by the server** |
| Store update rules | None | Forced / optional below | **Add** (§10.7) |
| Console | None | Local web page | **Hosted console** in the image (§20) |
| Server | Reference Bun server, local folder | Inside the main API | **Its own image**, many apps (§6) |
| Push check | `zn_ota=check`, at once | Topic push + random delay ≤ 6 h | **Add random delay and payment hold** (§23) |
| Stats | NDJSON lines | Per day, 35 days | **Postgres, per day, 35 days + automatic pause** (§21) |
| Customer title | None | ≤ 30 chars, unsigned | **Add** as `message` (signed, since it's ours) |

---

## 5. Gaps that must close before OTA is on for production
1. **Built-in serial 0** (store builds lose to older OTA bundles). Fixed by §8. **Blocks.**
2. **A real server**: HTTPS, Postgres, GCS, many apps, CLI login. §6–§22. **Blocks.**
3. **Push check downloads during a payment** (C4, `docs/ota.md` known limit) and **no random delay** (every phone checks
   at once after a topic push). §23. **Blocks.**
4. **Native-change guard**: a plugin's Kotlin changes but its module version doesn't, so an old APK gets a bundle that
   calls native code it doesn't have. A build check (§9.3). **Blocks.**
5. **Key drill** (switch to the backup key once, on purpose). §7.4. **Blocks.**
6. **Automatic rollout pause** on bad outcomes. §21. Strongly wanted; not strictly blocking with a careful person.
7. **F5**: a hang or late first screen on a slow phone blocks a good update for good (`docs/hardening-plan.md:13`).
   Phone-side fix (count it as unsure, retry once). §23. **Blocks** (its users include slow phones).
8. Patches: not blocking at today's sizes (sample 115 KB zipped); measure ZeroBill's zn bundle first (§15.2).
9. iOS client: not blocking (Android first).

---

## 6. The architecture in one page

```
  developer / CI                          zn-updates (one Docker image)                      phones
 ┌────────────────┐  HTTPS + token  ┌──────────────────────────────────────┐  POST /v1/check  ┌────────────┐
 │ zn CLI         │ ──────────────▶ │ api     : admin API, /v1/check,       │ ◀─────────────── │ zn app     │
 │  build, upload │                 │           /v1/snapshot, /v1/outcomes  │                  │ (ZnOta)    │
 │  SIGNS bundles │                 │ worker  : file checks, patches, stats,│ ── answer ─────▶ │ verifies   │
 │  and pointers  │                 │           rollout guard, cleanup      │                  │ signatures │
 │  (local key    │                 │ console : release page (web)          │                  │ and SHAs   │
 │   or cloud KMS)│                 └─────┬──────────────────┬──────────────┘                  │            │
 └────────────────┘                       │                  │                                 │ downloads  │
                                    Postgres            object storage ◀──── CDN (optional) ◀── │ files      │
                                    (metadata)        (GCS / S3 / disk)        file GETs        └────────────┘
            app's own backend (mode B) ── pulls the signed release snapshot ──▶ answers phones itself
```

- **One image, three roles** in one binary: `ZN_ROLE=api|worker|all` (default `all`). Run one container for a small team,
  or api and worker apart to scale.
- **Stack:** Bun + Hono (HTTP), Postgres via Drizzle ORM (or Kysely; both type-safe and plain SQL underneath),
  `postgres.js` driver. **No Redis**: each api instance keeps an in-memory snapshot per (app, channel), refreshed by
  Postgres `LISTEN/NOTIFY` when a release changes, and by a 30 s timer as a fallback. Jobs live in a Postgres table read
  with `FOR UPDATE SKIP LOCKED`. Fewer moving parts for a self-hosted product.
- **The server is trusted for availability, not for code.** Everything that decides what code runs is signed before it
  reaches the server (§7).
- **Same protocol** as today's phones (protocol 1), so the phone side needs only additions (§11, §23).
- **Shares code with the CLI:** `decide()`, signing texts, the release rules and the manifest types live in one package,
  `@zero-native/updates-core` (pure TypeScript, no I/O), used by the server, the CLI, mode-B servers, and tests.

---

## 7. Trust model and signing

### 7.1 What each part can do
| Who has it | Can | Can't |
|---|---|---|
| The **signing key** (developer laptop or KMS) | Make any bundle and pointer phones accept | — (protect it most) |
| A **server admin token** | Upload bundles (phones refuse unsigned ones), change rollout % / priority of releases you already signed, mark stable, read stats, edit store rules | Point a channel at other code; make phones run a bundle you didn't sign |
| **Database or bucket write access** | Delete or hide releases (phones keep what they run), replay an old signed pointer (phones refuse a lower seq) | Make phones run unsigned code |
| A **CDN or proxy in the middle** | Serve wrong bytes (phone: SHA mismatch → refused) | Anything else |
| **Phones** | Send outcomes (could lie about stats) | Anything that changes other phones |

Store update rules (forced update) are not code but can annoy users: they get signed too (§10.7), so a token alone
can't force every user to the store.

### 7.2 What is signed (protocol v1 texts unchanged; v2 adds two)
- Bundle text and pointer text as in §2.4.
- **New in v2 — store rule text:** `zn-ota-v2, store-rule, app, channel, seq, forcedBelow, optionalBelow, message`.
- **New in v2 — file list:** the bundle manifest already carries every file's SHA (through `bundleSha256` over the
  sorted file lines), so file-level downloads need no new signature.
- **Patches are not signed.** The phone applies a patch, then checks the result's SHA against the signed manifest's
  file SHA. A bad patch can only fail (then the phone downloads the full file).

### 7.3 Where the private key lives
- **Laptop** (today): `~/.zero-native/keys/<app>-main.pem`; the CLI refuses keys inside the repo. The backup key's
  private half is kept **offline** (printed or on a USB key in a safe), never on the same laptop. RN today has both on
  disk (`ota-signing-backup.pem`), which a todo already flags.
- **Cloud KMS** (phase 3; GCP Cloud KMS `EC_SIGN_P256_SHA256`, or AWS KMS `ECC_NIST_P256`): the CLI calls KMS
  `asymmetricSign` on the SHA-256 digest of the text. The key can't be copied out; access is per person or per CI
  identity, logged by the cloud. Same signature format (DER), so phones don't change. `zn.updates.signing = "kms://…"`.
- **Never on the server.** A server that can sign is one breach from pushing code to every phone.

### 7.4 Key drill and rotation
- `zn update:keys drill --app X`: signs a no-change pointer (same bundle, new seq) with the **backup** key and publishes it
  to staging; the phone accepts it (proves the backup key in the APK works). Run once before production, then yearly.
- **Rotation:** a new APK ships with keys `[new main, old main]`; once enough users have it (store rule: optional below),
  sign with the new key; drop the old one in a later APK. `project_keys` (§13) records each key's state: `active`,
  `backup`, `retiring`, `retired`. The server refuses uploads signed by a `retired` key.
- **Lost key:** sign with the backup at once; ship an APK with `[backup, new]`; the CLI's `keys rotate` walks through it.

### 7.5 Phone checks (all exist today, kept)
Manifest signature (either key), pointer signature, zip SHA and size, bundle SHA over the files, each file's size,
capabilities, serial above built-in, seq above saved. v2 adds: each downloaded file's SHA (file-level), patched
result's SHA, store-rule signature.

---

## 8. Bundle identity, serials and store builds

### 8.1 Rules
- A bundle is `(app, serial)`; id `<app>_<serial>`, shown as **#serial**. Serials are per app, assigned by the server
  (`POST /v1/admin/apps/:app/bundles/reserve`), strictly increasing, never reused. Same bundle SHA + same `requires` =
  same serial (the server returns the existing one).
- **Store builds reserve a serial too.** `zn build --android --release` (APK or AAB) builds the JS, asks the server for
  the serial of those bytes (new or existing), stamps it into the built-in bundle (`setBundleSerial`, exists today), and
  records a `store_builds` row. So the built-in bundle of every store build has a real serial, and "a newer APK wins"
  (decision row 7) works with no versionCode involved.
- **versionCode and iOS build numbers are only shown, never compared.** They are recorded in `store_builds` for people
  to read. This answers Pavan's concern: teams with huge versionCodes, or ones that reset to 1 per marketing version, or
  iOS build numbers that reset per version, change nothing.
- **Offline builds** (no server reachable, or `--offline`): serial 0, with a loud warning: "this build will lose to any
  OTA bundle already on phones; don't upload it to a store". The upload check in §8.4 catches it.

### 8.2 The checkpoint-AAB case, step by step (Pavan's scenario)
1. Phones run APK v1 (built-in #10) with OTA #14 applied.
2. You ship a new AAB with **no native change**, from code that includes #14's changes plus more. `zn build` reserves
   **#15** for its built-in bundle (new bytes), versionCode 169.
3. A phone updates from Play: built-in is now #15. Its kept #14 is older → the phone uses #15 at once (`APK_NEWER`, today's
   load rule `serial > builtIn.serial`). Nothing waits for the server.
4. Production channel still points at #14: the server sees built-in #15 ≥ #14 → `APK_NEWER`, the phone stays on #15.
5. You publish OTA #16 to production: every phone (v1 APK and the new AAB) whose capabilities fit gets #16, since
   capabilities, not versionCode, decide. **Old installs keep getting OTA.**
6. If the new AAB's JS is **the same bytes** as #14 (a store build only to bump something non-JS), `zn build` gets #14
   back; phones on #14 change nothing.

### 8.3 What if a store build carries an older JS than a live OTA?
For example, an urgent AAB built from an old branch. Its built-in bundle gets a **new, higher** serial (#17) even though
its code is older than OTA #16. Phones that update from Play run #17 (the older code). This is correct by the rules
(the newest *release* wins), and it is what a store release means. The CLI warns: "this build's git commit is behind the
commit of #16 on production (not an ancestor): phones that update will run older code than OTA users". RN's tool has
the same check ("refuses older code unless confirmed").

### 8.4 Guards around store builds
- `zn build --release` refuses to stamp serial 0 unless `--offline`.
- `zn store:check <apk|aab>` (also run by `zn build` at the end): reads the built-in `zn-bundle.json` from the artifact,
  checks the serial is registered on the server for this app, and that the public keys in it match the project's
  active keys. Run in CI before uploading to Play.

### 8.5 iOS later
Same: the built-in bundle in the `.ipa` gets a reserved serial; build numbers are recorded, never compared.

---

## 9. Compatibility: which bundle may run on which app

### 9.1 Kept from D1
The phone sends its capabilities; a bundle lists `requires`; the server answers only with a bundle that fits; the phone
checks again. No native hash, no runtime version. One fix reaches every app version that can run it.

### 9.2 Several live bundles per channel (new, phase 2)
Today a channel points at one bundle; an old APK that can't run it gets `INCOMPATIBLE` and nothing. With many app
versions in the field (its users update slowly), allow a channel to carry a **fallback list**: the pointer names a
target, and the release may name older compatible targets per capability band (for example "apps with hostApi < 9 get
#13"). The phone still gets one signed pointer; the server picks which. Signed pointer text gains a `target` per band:
phase 2, protocol v2 only, after measuring how many users sit on old APKs. Until then: `INCOMPATIBLE` users stay on what
they have, and a store rule (optional below) nudges them.

### 9.3 Native-change guard (gap 4)
A plugin's module version must go up whenever its native API changes, or the capability check is a lie.
- `zn build` computes, per native module, a **fingerprint of its public native API** (the module's function names,
  argument counts, event names, from the plugin's `ZnModule` declaration, plus its declared version) and stores it with
  the store build.
- On each OTA build, for each module the bundle uses, the CLI compares the fingerprint of the module version it
  requires against the store builds that have that version. Same version + different fingerprint = **build error**
  ("plugin X changed its native API but kept version 3: raise it").
- This is cheaper and more exact than RN's native hash: only what the bundle calls matters.

### 9.4 Known false refusals (from milestones)
The module scan reads literals in the source, including built-in modules the bundle doesn't call, so a bundle can need a
newer app than it really does ("scan the final bundle", `docs/milestones.md:1172-1174`). Fix in phase 1: scan the final
bundled JS, not the sources.

---

## 10. Channels, releases, rollout, rollback, kill switch, store rules

### 10.1 Apps and channels
- An **app** = one application id (Android package / iOS bundle id), e.g. `com.example.app` and
  `com.example.app.staging` can be two apps or one app with two channels: the project chooses. Many apps per server.
- A **channel** = a name (`^[a-z][a-z0-9-]{0,31}$`): `staging`, `production`, `beta`, `qa`, `preview-123`… Each phone is
  built with one channel (from `package.json` per build type, §18). `zn update:channel --set beta` can't change a
  phone's channel over the air in phase 1 (that would need a signed channel switch; phase 3 maybe).
- Release rules per channel: `production` (and any channel marked `guarded`) need the stable mark, clean git, explicit
  rollout and typed confirm. Other channels publish freely.

### 10.2 A release
An append-only row: (app, channel, seq) → target bundle or `BUILT_IN`, signed pointer, rollout %, priority, message,
kind (`publish, promote, rollback, kill, rollout, priority`), reason, by whom, when. The newest row is live. `seq` per
channel, unique; a conflict means someone else released first: the CLI reloads and asks again.

### 10.3 Stable mark
"This bundle worked on channel X." Allowed only if channel X pointed at it after it was built. Phase 2 adds the
evidence rule from RN's to-do: **at least N healthy outcomes** (default 1 phone, configurable) for that bundle on that
channel before the mark is allowed. The console shows the evidence.

### 10.4 Rollout
- Bucket = SHA-256(`app\nchannel\ninstallId`) first 4 bytes mod 100 (zn today: stable per install across bundles, so
  raising the % only adds installs, and the same 10 % test every bundle). RN uses `installId:bundleId` (a new 10 % per
  bundle). **Keep zn's**, and add an optional per-release `salt` for teams that want a new sample each time.
- Rollout % is unsigned (as both today). Lowering it doesn't take the bundle away from phones that have it (they keep
  it); to take it away, roll back.

### 10.5 Rollback
Publish an older bundle (new seq). Phones that kept it switch with no download (`USE_LOCAL KEPT`). The console offers
"roll back to the previous release" in one step.

### 10.6 Kill switch
A signed pointer to `BUILT_IN`; production needs a reason; typed `KILL <CHANNEL>`. Phones go back to the APK's bundle on
the next check (or push). Also: **per-bundle block** (phase 2): mark a bundle bad so the server never answers with it,
on any channel, even through a fallback band.

### 10.7 Store update rules (new for zn)
- Per app and channel: `forcedBelow` and `optionalBelow` **versionName ranges or store build ids**, not versionCode.
  Rule kinds: "everyone on a store build older than build B must update" (forced) / "should update" (optional). A store
  build is identified by its `store_builds` row (recorded by `zn build`), so it works with any numbering.
- Signed (§7.2), sent in the check answer as `store: { forced, optional, message, signature }`.
- The phone side gives JS `Updates.storeRule()` and the in-app update plugin (planned, RN API names) shows Play's sheet.
- Test phones: a rule may target installs in a `testers` list (install ids) first, like RN's test thresholds.

### 10.8 Priority
`normal` / `high` on the release (exists, unused on the phone today). Phase 2 phone side: `high` = apply at the next safe
moment the app allows (`applyNow` gates) instead of the next cold start, and skip the push random delay's long tail.

---

## 11. The phone protocol

### 11.1 v1 (today, unchanged)
`POST /v1/check` as §2.3. The server keeps answering v1 phones exactly as today for as long as they exist.

### 11.2 v2 additions (phase 1 for files and store rules; later items marked)
Request gains:
- `protocol: 2`
- `files: true` (the phone can download per file)
- `patches: ["bsdiff"]` or `["zstd"]` (phase 2: the formats it can apply)
- `free: <bytes>` (free space, so the server can prefer a patch or say `NO_SPACE` early)
- `storeBuild: "<store build id>"` (read from the built-in bundle; the server uses it for store rules)
- `push: true` when the check came from a push (for stats and the delay rule)

Answer gains:
- `bundle.files: [{ path, size, sha256, url }]` (only files the phone lacks, by SHA against `kept` and running bundles'
  file lists the server knows), or the full zip `url` as today if `files` wasn't sent.
- `bundle.patches: [{ path, from, kind, size, sha256, url }]` (phase 2).
- `store` (signed store rule, §10.7), `message` (≤ 60 chars, shown by the app, part of the signed manifest in v2).
- `next: { afterMs }` (server-suggested next check time; lets the server spread load).

The phone still refuses anything whose signature or SHAs don't check. Answers stay `no-store`.

### 11.3 Push-started checks (phone, phase 1)
- The data message carries `zn_ota=check` and optional `zn_ota_delay=<max seconds>` (default: 3 s on non-guarded
  channels, 6 h on production, as RN). The phone waits a random time in [0, max] (WorkManager, survives process death)
  before checking. High priority releases may set a short max.
- While `Updates.holdApply()` is held (payment), a push-started check **doesn't download**; it reschedules after the
  hold (gap 3, C4).

---

## 12. Server API

All JSON. Admin routes need a token (§17) with the listed scope. Every admin call writes `audit_log`.

### 12.1 Public (phones, mode-B servers)
| Method + path | What |
|---|---|
| `POST /v1/check` | The check, protocol 1 and 2 |
| `GET /v1/files/<app>/<path>` | File bytes (fs driver or no CDN); `Range`, immutable cache |
| `GET /v1/snapshot/<app>/<channel>` | Signed release snapshot (§16), ETag; for mode B/C |
| `POST /v1/outcomes` | Outcomes in batches from a mode-B server (token with `outcomes:write`) |
| `GET /health`, `GET /ready` | Liveness; readiness (database and storage reachable) |

### 12.2 Admin (CLI, console)
| Method + path | Scope | What |
|---|---|---|
| `POST /v1/admin/apps` | `admin` | Create an app (id, name, public keys) |
| `GET /v1/admin/apps`, `/apps/:app` | `read` | List, details |
| `POST /v1/admin/apps/:app/keys` | `admin` | Add a public key, change its state (§7.4) |
| `POST /v1/admin/apps/:app/channels` | `admin` | Create a channel, set `guarded` |
| `POST /v1/admin/apps/:app/bundles/reserve` | `bundles:upload` | Serial for a bundle SHA + requires (new or existing) |
| `POST /v1/admin/apps/:app/files/missing` | `bundles:upload` | Which file SHAs the server lacks |
| `POST /v1/admin/apps/:app/files/upload-urls` | `bundles:upload` | Signed upload URLs for missing files (direct to bucket) |
| `POST /v1/admin/apps/:app/bundles/:serial/ready` | `bundles:upload` | Signed manifest; server checks the signature, all files, then `ready`; queues patch jobs |
| `POST /v1/admin/apps/:app/bundles/:serial/failed` | `bundles:upload` | Mark a failed upload |
| `POST /v1/admin/apps/:app/store-builds` | `bundles:upload` | Record a store build (platform, versionName, versionCode / build number, built-in serial, commit) |
| `POST /v1/admin/apps/:app/channels/:ch/releases` | `publish:<ch>` | New release (signed pointer, rollout, priority, message, kind, reason, `expectSeq`); server re-checks the rules |
| `PATCH /v1/admin/apps/:app/channels/:ch/rollout` | `publish:<ch>` | Change rollout % of the live release (a `rollout` row) |
| `POST /v1/admin/apps/:app/bundles/:serial/stable` | `publish:<ch>` | Stable mark for a channel (evidence rule in phase 2) |
| `POST /v1/admin/apps/:app/bundles/:serial/block` | `publish:production` | Block a bundle everywhere (phase 2) |
| `POST /v1/admin/apps/:app/channels/:ch/store-rules` | `publish:<ch>` | Signed store rule |
| `GET /v1/admin/apps/:app/state` | `read` | Everything the console's overview needs, one call |
| `GET /v1/admin/apps/:app/stats?bundle=&channel=&days=` | `read` | Outcome counts per day |
| `GET /v1/admin/apps/:app/maps/:bundleSha` | `maps:read` | Source map (private) |
| `POST /v1/admin/apps/:app/maps` | `bundles:upload` | Upload a source map |
| `POST /v1/admin/apps/:app/push` | `publish:<ch>` | Optional: send the FCM check push (needs FCM credentials in the image, phase 2) |
| `POST /v1/admin/tokens`, `DELETE /v1/admin/tokens/:id` | `admin` | Project and CI tokens |
| `POST /v1/auth/device`, `POST /v1/auth/device/token` | — | `zn login` device flow (§17.1) |

Uploads go **straight to the bucket** with short-lived signed upload URLs (create-only), so the server doesn't carry
bytes and the CLI can upload files in parallel. With the `fs` driver the server takes `PUT /v1/admin/upload/<token>`.

---

## 13. Data model (Postgres)

Names are a sketch; types in Postgres terms. Append-only tables get no UPDATE except the noted state fields.

```
apps             (id text pk, name, created_at, settings jsonb)            -- settings: rules per channel, rollout salt mode
app_keys         (app_id, key_id text, public_key text, state text, created_at, pk(app_id, key_id))
channels         (app_id, name, guarded bool, created_at, pk(app_id, name))
bundles          (app_id, serial int, bundle_sha text, requires jsonb, requires_line text, manifest jsonb,
                  signature text, key_id text, zip_sha text null, zip_size int null, kind text  -- 'ota' | 'store'
                  git_commit, git_subject, git_dirty bool, message text, built_by, built_at,
                  state text,                                               -- uploading | ready | failed | blocked
                  pk(app_id, serial), unique(app_id, bundle_sha, requires_line))
files            (sha256 text pk, size int, storage_key text, created_at)   -- shared by all apps? no: per app, see note
bundle_files     (app_id, serial, path text, sha256 text, size int, pk(app_id, serial, path))
patches          (app_id, to_serial, path, from_sha, kind text, sha256, size, storage_key, state, created_at,
                  pk(app_id, to_serial, path, from_sha, kind))
store_builds     (app_id, id uuid pk, platform text, version_name, version_code text, built_in_serial int,
                  git_commit, created_by, created_at)
releases         (app_id, channel, seq int, target text,                   -- bundle id or 'BUILT_IN'
                  pointer jsonb, signature, key_id, rollout int, priority text, kind text, reason text,
                  message text, by_whom, at, pk(app_id, channel, seq))
stable_marks     (app_id, serial, channel, by_whom, at, evidence jsonb, pk(app_id, serial, channel))
store_rules      (app_id, channel, seq, forced_below jsonb, optional_below jsonb, message, signature, by_whom, at,
                  pk(app_id, channel, seq))
outcomes_raw     (app_id, day date, at, install_hash text, bundle text, kind text, detail text, stack text)
                  -- partitioned by day, kept 35 days; install_hash = SHA-256 of the install id, never the id
outcome_counts   (app_id, day, channel, bundle, kind, count, pk(...))     -- kept for 400 days
checks_daily     (app_id, day, channel, running_bundle, installs int)     -- adoption: distinct install hashes per day
tokens           (id uuid pk, name, hash text, scopes text[], app_id null, created_by, expires_at, last_used_at,
                  revoked_at)
users            (id, email, name, oidc_sub, created_at)                    -- console logins
audit_log        (id bigserial, at, who, token_id, action, app_id, details jsonb, ip)
jobs             (id bigserial, kind, payload jsonb, state, run_after, attempts, last_error, locked_by, locked_at)
```
Notes:
- **Files are per app** (`storage_key` under the app's prefix) so deleting an app deletes its files; dedup inside an app
  is what matters.
- `requires_line` is the exact signed text, so "same bundle" is the same signed meaning.
- `outcomes_raw` never stores the install id itself: a SHA-256 of it (a phone can be followed for debugging by asking
  the user for their install id, shown in the app's About screen).
- Migrations with Drizzle Kit, run at start only when `ZN_MIGRATE=on`, and refused if the database is newer than the image.

---

## 14. Storage, downloads, CDN

### 14.1 Layout (per app prefix `<app>/`)
```
<app>/files/<sha256>                 content-addressed file (hbc, templates, images…)
<app>/zips/<serial>-<zipSha>.zip     full zip (v1 phones and the fallback)
<app>/patches/<toSerial>/<path>/<fromSha>.<kind>
<app>/maps/<bundleSha>.map           private
<app>/snapshots/<channel>.json       signed snapshot (mode B/C)
```
All create-only: GCS `ifGenerationMatch=0`, S3 `If-None-Match: *`, fs `O_EXCL`. Nothing is ever overwritten; cleanup
(§15.5) deletes, never replaces.

### 14.2 Drivers
- `gcs`: `@google-cloud/storage`; auth per `GCP_AUTH_MODE` (§18.2).
- `s3`: AWS SDK v3, any S3-compatible (AWS, Cloudflare R2, MinIO, Backblaze B2).
- `fs`: a folder (dev, small teams, tests). Served by the server itself.

### 14.3 Downloads
Per answer, each URL is one of:
1. `CDN_BASE_URL + key` (public bucket behind a CDN: Cloud CDN, Cloudflare, Fastly) — cheapest, recommended.
2. A signed URL, valid 15 min (`ZN_SIGNED_URLS=on`, private bucket) — for teams that don't want public objects.
3. `ZN_PUBLIC_URL/v1/files/<app>/<key>` — the server streams it (fs, or no CDN).
Files are immutable by name, so `Cache-Control: public, max-age=31536000, immutable`. The phone resumes with `Range`.

### 14.4 Size and cost sketch (ZeroBill scale)
10k installs × 1 update/week × ~150 KB (zn bundle zipped, files only changed) ≈ 1.5 GB/week egress. Negligible on a CDN.
Checks: 10k installs × ~4 checks/day ≈ 40k requests/day ≈ 0.5/s average; a topic push without delay would spike to
thousands/s — hence the random delay (§11.3) and in-memory answers.

---

## 15. Worker jobs

### 15.1 After `bundles/:serial/ready`
1. **Verify**: every file in `bundle_files` exists in storage with the right size (and SHA on first upload); the manifest
   signature checks with an active key; the zip (if any) matches `zip_sha`. Fail → `failed`, the CLI shows why.
2. **Zip**: build the full zip for v1 phones if the CLI didn't upload one (deterministic: sorted names, fixed mtime,
   like `core.ts:129-140`).
3. **Patches** (phase 2): for each changed file over 32 KB (in practice `main.hbc`, `main.zn.ui`), from the same path in
   (a) the last 5 ready bundles, (b) the built-in bundles of the newest 3 store builds (RN's choice); make a patch, keep it
   only if it is < 60 % of the file. Checked by applying it in the worker and comparing SHA.
4. **Snapshot**: rebuild the signed snapshot for channels pointing at it (mode B/C), `NOTIFY` api instances.

### 15.2 Patch format (decide by measuring, phase 2)
- Candidates: **bsdiff** (RN uses it; small Java/C decoder; slow to make, fine in a worker) and **zstd `--patch-from`**
  (fast, similar size on many inputs, needs libzstd in the APK, about 150 KB arm64, check). Hermes bytecode moves a lot
  for small source changes, so the win must be measured on real ZeroBill zn bundles: 10 real consecutive builds, sizes
  of full / file-level / bsdiff / zstd. Then choose one. Phone verifies the result's SHA either way.
- File-level alone already removes images and unchanged templates from each download (phase 1).

### 15.3 Stats rollup
Every 5 min: `outcomes_raw` → `outcome_counts`, `checks_daily`. Daily: drop raw partitions older than 35 days.

### 15.4 Rollout guard (phase 2, §21)

### 15.5 Cleanup
Never delete a file used by: any release in the last 90 days, any kept-on-phone candidate (the last 16 released bundles
per channel), any store build's built-in bundle. Everything else may go after 90 days (setting). Source maps kept 400 days.

---

## 16. Three ways to answer phones (Pavan's point 2)

| Mode | `/v1/check` answered by | Files served by | Who runs what |
|---|---|---|---|
| **A. Hosted** (default) | zn-updates | its storage via CDN | One image |
| **B. Your own server** | the app's backend, with `@zero-native/updates-core` `decide()` over the signed snapshot | the app's own bucket/CDN, or zn-updates' | Image for publishing + the app's backend for phones |
| **C. Static** (phase 3) | nobody: the phone reads the signed snapshot from a static host and decides itself | any static host | Image only for publishing, or even just the CLI + a bucket |

### 16.1 The release snapshot
```json
{ "format": 1, "app": "com.example.app", "channel": "production", "seq": 42, "generatedAt": "…",
  "pointer": { "...signed pointer..." }, "rollout": 25, "priority": "normal", "salt": null,
  "bundles": [ { "manifest": { "...signed..." }, "files": [ { "path", "size", "sha256", "key" } ],
                 "patches": [ { "path", "fromSha", "kind", "size", "sha256", "key" } ], "zip": { "key", "sha256", "size" } } ],
  "bands": [ ... phase 2 fallback targets ... ],
  "store": { "...signed store rule..." },
  "fileBase": "https://cdn.example.com/com.example.app/",
  "signature": "<snapshot signed by the SERVER's own snapshot key (integrity in transit only)>" }
```
- Holds the live bundle, the last 16 released bundles (for `KEPT` answers), and the bundles in the 3 newest store builds.
- The server signs the snapshot with its own key (`ZN_SNAPSHOT_KEY`), only so a mode-B server can tell it came from
  zn-updates. Phones never trust this key; they still check the developer's signatures inside.
- `GET /v1/snapshot/<app>/<channel>` with ETag; mode-B servers poll every 30 s, or get a webhook
  (`POST <your url>` with `{app, channel, seq}`) on change.
- A mode-B server: `import { decide } from "@zero-native/updates-core"`; keep the snapshot in memory; on each check call
  `decide(snapshot, request)`; rewrite file URLs to its own CDN if it mirrors files (`zn update:mirror` copies them, or
  it proxies); send outcomes to `POST /v1/outcomes` in batches every minute.

### 16.2 Why not only mode B
A team that just wants OTA shouldn't need a backend. Mode A is the product; mode B is the escape hatch (ZeroBill may want
the check on `api.example.com` next to its other APIs and its own rate limits).

---

## 17. Login and permissions

### 17.1 People (CLI and console)
- **Console login: OIDC** (Google Workspace, GitHub, Okta, any OIDC issuer): `ZN_OIDC_ISSUER`, `ZN_OIDC_CLIENT_ID`,
  `ZN_OIDC_CLIENT_SECRET`, `ZN_ALLOWED_EMAILS` or `ZN_ALLOWED_DOMAIN`. Roles per app: `viewer`, `developer`
  (upload, publish non-guarded), `releaser` (publish guarded), `admin`. Phase 1 can ship with tokens only (§28 Q3).
- **`zn login`**: device-code flow (RFC 8628, like `gh auth login`): the CLI asks `/v1/auth/device`, prints a code and
  opens the console page; you sign in there and approve; the CLI receives a token (30 days, refreshable) and stores it in
  the **OS keychain** (Windows Credential Manager, macOS Keychain, libsecret), never in the repo or a plain file.
- **First admin**: `ZN_BOOTSTRAP_TOKEN` (one-time, from the environment) creates the first user/token; the server logs
  a warning while it is still set.

### 17.2 Machines (CI)
- Project tokens with narrow scopes, shown once, stored hashed (SHA-256, constant-time compare):
  `read`, `bundles:upload`, `publish:<channel>`, `publish:*`, `maps:read`, `outcomes:write`, `admin`.
- Phase 3: **GitHub Actions OIDC** (no stored secret, like npm trusted publishing): the server trusts tokens from
  `token.actions.githubusercontent.com` for a named repo + branch + workflow, and maps them to scopes.
- Recommended CI split: CI may build and upload and publish to `staging`; a person publishes to `production`.

### 17.3 Guarded actions
Publishing to a guarded channel needs: a `publish:<ch>` token **and** a pointer signed by an active key **and** the
server-side rules (stable mark with evidence, clean git recorded on the bundle, explicit rollout ≤ the channel's
first-step limit, e.g. 20 %) **and** the typed confirm in CLI or console (`PRODUCTION #N`). The server re-checks the
rules so a script calling the API can't skip them.

### 17.4 Phones
No login (as Expo and RN). Answers are signed, so a fake server can't do harm beyond "no update". Abuse limits: per-IP
and per-install rate limits on `/v1/check`, body size limits (64 KB), an optional `x-zn-app-key` header (a public value
from `package.json`) so random scanners get 404s. The install id is a random UUID, never a user id.

### 17.5 Transport
HTTPS only in production (the phone refuses `http://` outside debug builds: phase 1 phone change). TLS from the load
balancer (Cloud Run, a proxy). No certificate pinning (the ZeroBill app doesn't pin today; signatures already protect code).

---

## 18. Config

### 18.1 The app's `package.json` (public values only)
```json
"zn": {
  "app": "com.example.app",
  "updates": {
    "url": "https://updates.example.com",
    "checkUrl": "https://api.example.com/zn",          // optional: mode B, phones ask the app's own server
    "channels": { "debug": "staging", "release": "production", "staging": "staging" },  // per build type / flavor
    "publicKeys": ["MFkw…main", "MFkw…backup"],
    "appKey": "pk_live_…",                              // optional public value for x-zn-app-key
    "signing": "file:~/.zero-native/keys/com.example.app-main.pem"   // or "kms://projects/…/cryptoKeyVersions/1"
  }
}
```
- The Gradle plugin reads it at build time and writes the values into the APK (a generated `ZnOtaConfig`), replacing the
  hand-written `ZnOta.Config(server = …, publicKeys = …)`. The code can still override.
- `signing` is a pointer, never a key. Tokens are never here (keychain or `ZN_UPDATES_TOKEN` in CI).
- Today's `zn-ota.json` (`app, build[], store, key?, publicKeys[]`) moves here; `zn update:init` migrates it.

### 18.2 The image (environment)
| Variable | Meaning | Default |
|---|---|---|
| `DATABASE_URL` (or `POSTGRES_DB_URL`) | Postgres connection | required |
| `ZN_MIGRATE` | `on` runs migrations at start | `off` |
| `ZN_ROLE` | `api`, `worker`, `all` | `all` |
| `ZN_PUBLIC_URL` | how phones and the CLI reach it | required |
| `ZN_STORAGE` | `gcs`, `s3`, `fs` | `fs` |
| `GCS_BUCKET` | bucket name | — |
| `GCP_AUTH_MODE` | `adc` (Application Default Credentials: Cloud Run / GKE workload identity, or `gcloud auth application-default login`), `service_account_json` (`GCP_SERVICE_ACCOUNT_JSON` with the JSON, or `GOOGLE_APPLICATION_CREDENTIALS` with a path), `workload_identity_federation` (credential config file from AWS / Azure / GitHub OIDC) | `adc` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3-compatible | — |
| `ZN_FS_ROOT` | folder for `fs` | `/data` |
| `CDN_BASE_URL` | public base for files | none (server streams) |
| `ZN_SIGNED_URLS` | `on` = signed download links | `off` |
| `ZN_SNAPSHOT_KEY` | server's snapshot key (P-256 PEM) | generated and stored in the database on first start |
| `ZN_OIDC_ISSUER`, `ZN_OIDC_CLIENT_ID`, `ZN_OIDC_CLIENT_SECRET`, `ZN_ALLOWED_DOMAIN`, `ZN_ALLOWED_EMAILS` | console login | off (tokens only) |
| `ZN_BOOTSTRAP_TOKEN` | first admin, one time | — |
| `ZN_FCM_CREDENTIALS` | optional, for `admin/push` (phase 2) | — |
| `ZN_WEBHOOK_URLS` | Slack / generic webhooks for alerts | — |
| `ZN_LOG_LEVEL`, `OTEL_EXPORTER_OTLP_ENDPOINT` | logs, traces, metrics | `info`, off |

The image refuses to start on: no database, `ZN_PUBLIC_URL` not https (unless `ZN_DEV=on`), a storage driver whose test
write fails.

---

## 19. The `zn` CLI (Pavan's point 5)

One binary `zn` (a Bun-compiled single file, plus `bunx zn`), replacing `bun run ota`. Close to `eas update` so RN
teams feel at home.

| Command | What it does |
|---|---|
| `zn login` / `zn logout` / `zn whoami` | §17.1 |
| `zn update:init` | Creates the app on the server, makes main + backup keys (backup printed for offline storage), writes `package.json` `zn.updates`, migrates `zn-ota.json` |
| `zn build --android [--release] [--aab]` | Builds the JS; for release: reserves the serial, stamps it, runs Gradle, records the store build, runs `zn store:check` |
| `zn update --channel <ch> -m "<message>"` | Typecheck → build JS → `requires` from the final bundle → reserve serial → upload missing files (parallel, signed URLs) and the source map → sign manifest → `ready` → wait for the worker's verify → sign pointer → publish → print the console link. For guarded channels it stops after `ready` and tells you to promote |
| `zn update:promote --from staging --to production --rollout 10` | Same bundle; needs the stable mark + evidence; typed `PRODUCTION #N` |
| `zn update:stable --bundle N --channel staging` | Stable mark |
| `zn update:rollout --channel production --percent 50` | Rollout change |
| `zn update:rollback --channel production [--to N]` | Previous (or named) bundle, new seq |
| `zn update:kill --channel production --reason "..."` | Kill switch; typed `KILL PRODUCTION` |
| `zn update:block --bundle N --reason "..."` | Never serve this bundle (phase 2) |
| `zn update:list [--channel]`, `zn update:view N` | Bundles, releases, adoption, outcomes, git commit |
| `zn update:store-rule --channel production --forced-below <build> --optional-below <build> -m "..."` | Signed store rule |
| `zn update:keys drill / rotate / list` | §7.4 |
| `zn update:symbolicate [--from-telemetry]` | Maps JS stacks with the bundle's source map |
| `zn store:check <apk|aab>` | §8.4 |
| `zn update:serve` | Today's local reference server, for dev and the phone matrix |
| `zn update:mirror --to gs://…` | Copy an app's files to your own bucket (mode B) |

Every command prints what it will do before doing it, and asks for a typed confirm on guarded channels. `--json` for CI.
One release action per machine (`~/.zero-native/ota.lock`, today). Exit codes: 0 done, 1 refused by a rule (with the rule
and how to satisfy it), 2 error.

---

## 20. The console (release page)
A small web app served by the image (React + Vite, built into the image), like `build:manage` but hosted and multi-app.
- **Apps**: list, with each channel's live bundle, rollout, adoption, alerts.
- **Overview per app**: channels side by side (staging → production), the live release, "promote", "rollout", "roll
  back", "kill" buttons. Buttons that need a signature show the exact CLI command to run (signing stays local or in KMS).
  Rollout changes and stable marks (unsigned) work from the console.
- **Bundles**: serial, message, git commit and subject, dirty flag, size (full / files / patches), requires, where it
  ran, outcomes, stable marks with evidence.
- **Store builds**: versionName, versionCode / build number (shown only), built-in serial, commit, date; store rules.
- **Phones**: adoption per bundle per day, outcome counts, the worst outcomes with masked stacks and a "symbolicate" link.
- **Activity**: the audit log.
- **Settings**: channels (guarded or not), keys and their states, tokens, webhooks.

---

## 21. Stats, alerts and automatic rollout pause
- Every check brings outcomes (≤ 50); the api writes them to `outcomes_raw` (batched inserts) and counts installs per
  running bundle per day (`checks_daily`, distinct install hashes via a daily HyperLogLog-style sketch or a set per day).
- **Rollout guard** (phase 2, per guarded channel, every 5 min): compare the live bundle with the previous live bundle
  over the same number of installs (at least 200 installs, or 1 hour): rates per 1,000 installs of the serious kinds
  (`error_rollback, launch_crashed, watchdog_block, apply_failed, init_failed, ota_off, signature, zip_sha,
  bundle_unusable`). If the new rate is above `max(2 × old, old + 5 per 1,000)` (settings per channel), **pause**: a
  `rollout` row that freezes the % (no new installs get it), plus a webhook alert. **Never kills by itself**; a person
  decides. Phones that have it keep their own health checks.
- Alerts (webhooks): pause, a guarded publish, a kill, a failed upload, a key nearing `retired` while still used.
- Metrics (OpenTelemetry, optional): checks/s, answer kinds, download bytes, job queue length, rule refusals.
- Logs: one JSON line per request (no install ids, no IPs beyond the audit log).

---

## 22. Running it

### 22.1 Cloud Run (recommended on GCP; ZeroBill's case)
1. Cloud SQL Postgres (or a schema in an existing instance), private IP or the Cloud SQL connector.
2. A GCS bucket for files; a second private one for source maps (or a private prefix).
3. A service account with `storage.objectCreator` + `storage.objectViewer` on the bucket(s), `cloudsql.client`; for
   signed URLs, `iam.serviceAccountTokenCreator` on itself. `GCP_AUTH_MODE=adc` (workload identity: no key file).
4. Deploy the image twice from one revision: `ZN_ROLE=api` (min instances 1, concurrency 80) and `ZN_ROLE=worker`
   (min 1, no public ingress). Or one with `all` for a start.
5. Cloud CDN in front of the bucket (or Cloudflare), set `CDN_BASE_URL`.
6. A domain (`updates.example.com`), HTTPS by Cloud Run.

### 22.2 Docker Compose (try it, small teams)
`docker compose up` with Postgres 17, MinIO, and the image (`ZN_STORAGE=s3`, `S3_ENDPOINT=http://minio:9000`). Doc page:
"zn-updates in 10 minutes".

### 22.3 Backups and upgrades
- Postgres: daily backups + point-in-time (managed DB). The bucket: object versioning off (create-only already), a
  lifecycle rule only through §15.5's cleanup.
- Losing the database without a backup: phones keep running; republish from the CLI (it can rebuild a release from the
  bucket's manifests: `zn update:recover`). Document it.
- Image versions follow semver; a new image runs the old database's migrations first (`ZN_MIGRATE=on` once); the
  protocol stays backward compatible (v1 phones forever).

---

## 23. Phone-side work
| # | Change | Phase | Blocks production |
|---|---|---|---|
| P1 | Generated `ZnOtaConfig` from `package.json` (server, channel per build type, keys, appKey) | 1 | yes |
| P2 | Refuse `http://` server in release builds | 1 | yes |
| P3 | Built-in serial from `zn build` (the loader already supports it) + `storeBuild` id in the built-in bundle | 1 | yes |
| P4 | Protocol 2: `files: true`, per-file download into the bundle folder, reuse files from kept/running bundles by SHA, verify each SHA | 1 | no (size), but cheap |
| P5 | Push check: random delay (`zn_ota_delay`), WorkManager, no download while `holdApply()` is held | 1 | yes |
| P6 | F5: a hang or late first screen counts as "unsure" once (retry on the next start) before blocking for good | 1 | yes |
| P7 | Store rules: `Updates.storeRule()` + event; the in-app update plugin uses it | 1–2 | yes for forced updates |
| P8 | `free` space in the request; prune old kept bundles before giving up on space | 1 | no |
| P9 | `message` shown by the app (`Updates.pendingMessage()`) | 2 | no |
| P10 | Patches: apply bsdiff or zstd, verify | 2 | no |
| P11 | `priority: high` behaviour | 2 | no |
| P12 | iOS client (same protocol) | 3 | no |

---

## 24. ZeroBill as the first user
- The zn ZeroBill app is a **new store build** of the same package (`com.example.app`) replacing the RN app. Its
  OTA is zn's, not RN's bootloader: RN bundles, `zappbundles` and `zappupdates` don't apply to it.
- **Where it runs:** zn-updates on Cloud Run in ZeroBill's GCP project, its own database (or schema `zn_updates` in the
  existing Cloud SQL), its own bucket (e.g. `myapp-zn-ota`), behind `updates.example.com` (or mode B later:
  `api.example.com/zn/v1/check` with `updates-core`).
- **Apps:** `com.example.app` (production channel), `com.example.app.dev` / `.staging` (staging channel) —
  matching how the RN app splits environments today. Push topics `zn-ota-<channel>`.
- **First zn store build** reserves its serial on the server (§8): e.g. #1. Every later AAB gets the next one.
- **Keys:** a new zn key pair (don't reuse the RN key), main on Pavan's machine (or KMS), backup offline.
- **Testing account**: the existing test bucket `gs://my-test-bucket/zn-ota` (memory note) serves the staging trial before
  the real bucket exists.
- **Push safety** (Pavan's rule): test pushes only to the Lava dev app's own token until the random delay (P5) is on.

---

## 25. Testing plan
- **Unit** (`updates-core`): `decide()` one test per row (exists) + v2 rows (files, store rules, bands); signing texts
  against Kotlin's (exists, extend); release rules (stable evidence, guarded checks, seq conflicts).
- **Server integration** (Bun test + Postgres + MinIO in Docker, run in CI): upload → ready → verify → publish → check →
  download → outcomes → stats; create-only conflicts; two publishers at once; database down (answers from memory);
  storage down (`ready` refused); token scopes; migration up from an empty database and from the previous release.
- **Phone matrix** (`tools/ota/phone-matrix.ts`, 38 cases today): run against the image over HTTPS (a Cloud Run dev
  service or a tunnel) instead of `adb reverse`; add: file-level update, store build serial (APK newer), store rule,
  push delay + hold, F5 retry, `http://` refused in release, key drill.
- **Load**: 2,000 checks/s against one api instance with a warm snapshot (k6 or autocannon), p99 < 50 ms.
- **Chaos**: kill the worker mid-patch (job retries), kill the api mid-upload (CLI resumes), Postgres restart (LISTEN
  reconnects).
- **Security review** before production: token storage, OIDC flow, upload URL scope, path handling, rate limits.

---

## 26. Phases, tasks, estimates (my work; Pavan's checks extra)

### Phase 1: OTA on for the production release (≈ 2–2.5 weeks)
1. `@zero-native/updates-core`: move `decide`, signing, rules, types out of `tools/ota` (no behaviour change). 1 day
2. Server skeleton: Hono app, config, Postgres schema + migrations, storage drivers `fs` + `gcs`, health. 2 days
3. Admin API: apps, keys, channels, reserve, files missing / upload URLs, ready, releases, rollout, stable, store builds,
   state, tokens, audit. 2–3 days
4. Worker: verify, zip, snapshot, stats rollup, cleanup. 1.5 days
5. `/v1/check` v1 + v2 (files, store rules), in-memory snapshots with LISTEN/NOTIFY. 1.5 days
6. `zn` CLI: login (device flow, keychain), update:init, update, promote, stable, rollout, rollback, kill, list, view,
   store-rule, keys drill, store:check, build serial stamping, final-bundle module scan. 3 days
7. Native-change guard (§9.3). 1 day
8. Phone: P1–P3, P5, P6, P7 (rule plumbing), P4 (files), P8. 2–3 days
9. Console, read-only + rollout/stable buttons. 2 days
10. Cloud Run guide + compose file; integration tests; phone matrix over HTTPS; load test. 2 days
**Done when:** the phone matrix passes against the image on Cloud Run over HTTPS; a store build with a reserved serial
beats an older OTA on the Lava; a key drill passes; Pavan signs off a staging → production run with 10 % rollout on the
dev app.

### Phase 2 (≈ 2 weeks): patches (after measuring), console actions with CLI signing, rollout guard + webhooks,
fallback bands, per-bundle block, OIDC console login, S3 driver, mode B (snapshot endpoint + `updates-core` docs +
`update:mirror`), FCM push from the server, P9–P11.

### Phase 3: iOS client, static mode C, KMS signing, GitHub Actions OIDC, multi-org, signed channel switch.

---

## 27. Risks
| Risk | How it's handled |
|---|---|
| The server goes down | Phones keep what they run; checks fail quietly and retry later; no code changes without a signature. Health checks, two api instances |
| A wrong file list or patch | The phone checks every SHA and the signed bundle SHA before switching; a mismatch drops the piece and fetches the full file |
| Topic push makes every phone check at once | Random delay on the phone (P5), answers from memory, files from a CDN, `next.afterMs` |
| Two releases at once | `(app, channel, seq)` unique; the loser reloads and asks again |
| A token leaks | Scopes, expiry, audit log, revoke in the console; it still can't change code (signatures) |
| The signing key leaks | Backup key drill done in advance; rotation steps; KMS in phase 3 |
| A store build with older JS than live OTA | CLI warning (§8.3); it's a conscious store release |
| Capability check lies (native change, same version) | Native-change guard (§9.3) |
| Postgres grows | Raw outcomes 35 days in day partitions; counts kept small |
| Building too much (an EAS clone) | Phase 1 is only what production OTA needs; cloud builds (EAS Build) are out of scope |
| Users on old APKs left behind | Store rules to nudge; fallback bands (phase 2) after measuring |
| Privacy | No user ids; install ids hashed at rest; masked error text (exists); IPs only in the audit log of admin calls |

---

## 28. Decisions for Pavan
1. **Where the code lives:** `zero-native/server/` + `packages/updates-core/` + `packages/cli/` in this repo (one version
   with the protocol and the phone code), image `ghcr.io/<org>/zn-updates`. *Recommended.* Or a repo of its own.
2. **Phase 1 = mode A** on Cloud Run with its own database (or a schema in the existing Cloud SQL); mode B in phase 2.
   *Recommended.* Or build mode B first so ZeroBill's API answers checks from day one.
3. **Login in phase 1:** tokens + `zn login` with a token pasted from the console (no OIDC yet), OIDC console login in
   phase 2. *Recommended.* Or OIDC (Google) from day one (+2 days).
4. **Patches:** measure bsdiff vs zstd on 10 real zn bundles in phase 2, then choose. *Recommended.* Or bsdiff now (RN's
   known path).
5. **Config:** `package.json` `"zn"` field as §18.1 (your ask). *Recommended.* Or a `zn.config.ts`.
6. **Rollout bucket:** zn's per-install bucket (same 10 % every release), optional salt. *Recommended.* Or RN's per-bundle
   bucket.
7. **Store rules by store build id** (not versionCode). *Recommended*, follows from your numbering concern.
8. **Name:** `zn-updates` (image) / `zn update` (CLI). Or something else.

---

## 29. Words used here
- **Bundle**: one set of JS bytecode, templates and images, with one serial and one SHA.
- **Serial**: a bundle's number per app, bigger = newer, given by the server.
- **Built-in bundle**: the bundle inside the APK/AAB; the phone's fallback.
- **Store build**: an APK, AAB or IPA uploaded to a store.
- **Channel**: a named line of releases (`staging`, `production`). A phone is built for one.
- **Release / pointer**: "channel X now runs bundle N" (or the built-in one), signed, with a seq.
- **Seq**: the release number per channel; the phone refuses going back to a lower one.
- **Capabilities / requires**: what an app has / what a bundle needs (registry, bytecode, host API, native modules).
- **Rollout %**: the share of installs that get a release; the same installs each time.
- **Stable mark**: "this bundle worked on staging", needed before production.
- **Kill switch**: a release that sends every phone back to its built-in bundle.
- **Store rule**: "builds older than X must / should update from the store".
- **Snapshot**: one signed file with everything needed to answer checks for a channel (modes B and C).
- **Mode A / B / C**: who answers phones — zn-updates, your own server, or nobody (static).
