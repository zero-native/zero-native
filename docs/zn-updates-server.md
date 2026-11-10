# zn-updates: the update server (OTA + store updates), built 2026-11-09

**What:** one Bun app (`server/`) that phones ask "what should I run, and should I update from the store?", plus a
web dashboard to build, publish, roll out, roll back, kill, and set Play / App Store update rules. It replaces the
reference server (`tools/ota/server.ts`) for real use. First user: ZeroBill, at `https://appupdates.example.com`.

**Pavan's brief (2026-11-09):** build from scratch, zn's ideas only (no native hash, nothing forced to fit RN), a full
stack for OTA and store updates (forced / optional, with test versions that only test builds see), its own Postgres,
a dashboard and controls as good as or better than RN's `build:manage`. Security on the developer side later; the
phone side keeps every check it has.

Sources: `docs/ota.md` (the phone side, built), `docs/ota-architecture-plan.md` (the big plan; this is its lean first
version), RN `tools/release` (the dashboard to match), RN backend `src/routes/ota.ts` (store rules, test versions,
stats), the zn-ota-server session's notes (one-call streaming, families, delta zips).

## 1. Pieces
| Piece | Where | What |
|---|---|---|
| Server | `server/src/` | `Bun.serve`: phone API, admin API, dashboard. Postgres (`Bun.sql`; PGlite for local runs and tests). Files on GCS (or a local folder) |
| Dashboard | `server/web/` | React, served by the same server. Signs pointers **in the browser** (WebCrypto) with the key file loaded from the owner's laptop: the server never holds the private key |
| CLI | `tools/updates/` (`bun run updates ...`) | Builds an app's bundle, signs it, uploads it; registers store builds (reserves their serial); every dashboard action too |
| Phone | `android/runtime` `ZnOta` (built), iOS later | Unchanged protocol 1 (POST `/v1/check`, then GET the zip). Protocol 2 (one call that streams the zip) comes with the next store build |
| Store updates | `plugins/app-updates` | Play in-app updates (Android), App Store page (iOS); the app shows its own screens. The store answer comes with the check (§4.6): no second request |

## 2. Trust (unchanged from docs/ota.md)
- The phone runs only a bundle whose manifest is signed and a pointer that is signed, with a seq above the last one it
  accepted, for its own app and channel, that its capabilities cover, newer than its built-in bundle.
- The server is trusted for **availability only**. It stores what the CLI and the dashboard signed and picks answers.
- Not signed (a wrong value can't run code): rollout %, priority (normal / high / critical, §4.5), customer title, store rules. Hence the admin token
  (§7) even before real logins: without it anyone could set a forced store update.

## 3. Data (Postgres; `server/src/migrations/*.sql`)
- `apps` (id = the zn app id, e.g. `zerobill`; name; public keys), `channels` (app, name).
- `bundles`: app, serial, id `<app>_<serial>`, bundle SHA, `requires`, zip path / SHA / size, the signed manifest (as
  JSON, byte for byte what phones get), git commit / subject / dirty, built by / at, stable mark (at, by, note),
  customer title, the delete mark (`delete_at`, `delete_by`: migration 007, §5.2). Same bytes + same requires = same
  serial (see `serials` below).
- `serials`: one number line per app, shared by OTA bundles and store builds' built-in bundles. Each serial records the
  bytes it was taken for (bundle SHA-256 + requires). **One bundle = one serial = one SHA** (migration 006): the same
  bytes get the same serial back, whether an OTA release or a store build asks first. Two store builds with the same JS
  share a serial; an OTA release of the JS inside a store build gets that store build's number. (A serial made before
  migration 006 has no bytes recorded and is never given back.)
- `store_builds`: app, os, channel, version code, version name, label, **built-in serial** (reserved from the same
  serial line as bundles, so a new store build never loses to an older OTA bundle; several store builds can have the
  same one; the same OS + channel + version code + serial recorded twice is one row), capabilities, **family** (a hash of
  the capabilities), git, built by / at, and the **base** (`base_path`, `base_size`: the built-in bundle as a zip, kept
  as a base for patches; empty for a store build made before patches), and (migration 007) the **live mark**
  (`live_at`, `live_by`: "customers can download it from Play / the App Store") and the delete mark (§5.2).
- Source maps (no table): `<app>/maps/<bundle sha>.map` in the file store, one per bundle SHA (§5.3).
- `pointers`: app, channel, seq, target (bundle id or `BUILT_IN`), rollout, priority (`normal` / `high` / `critical`),
  reason, kind (publish / rollback / rollout / kill), the signed pointer JSON, by, at. Append-only; the highest seq is
  what the channel serves.
- `patches` (migration 004): app, to id, from id, from SHA-256 (the base bundle's bundle SHA), path, patch zip SHA-256,
  size, made at. One row per "from bundle → to bundle". The zip is `<app>/patches/<to id>/<from sha>.zip`; the base zips
  of store builds are `<app>/bases/<bundle sha>.zip`. Format and rules: `docs/ota-patches.md`.
- `store_rules`: app, os, **channel** (migration 005; rules made before it are production's), version (Android
  versionCode; iOS "1.6.2" as one number), critical 0 / 1 / 2, test flag, note, by, at. One rule per
  (app, os, channel, version). A rule is for the phones of its own channel: a staging rule never reaches a production
  phone, and the other way round. Same thresholds as the RN backend (per channel): optional = highest version with critical ≥ 1, forced = highest with
  critical 2; test rows count only for phones whose own version is a test row.
- Stats: `installs_daily` (day, app, channel, install hash, running bundle: one row per phone per day),
  `events_daily` (day, app, channel, bundle, kind, detail, count), `errors` (the last error stacks, for symbolicate).
  35 days kept.
- `activity`: every admin action (who, what, detail).

## 4. Phone API
- `POST /v1/check` (protocol 1): the phone's **one** call. Request and answer as `tools/ota/decide.ts` / `server.ts`,
  plus the store question (§4.6). The OTA decision is `decide()` from `tools/ota/decide.ts`, unchanged.
- `GET /v1/files/<path>`: a bundle zip (`<app>/bundles/<id>/<sha>.zip`) or a patch zip
  (`<app>/patches/<to id>/<from sha>.zip`), resumable (Range), cached forever (the path has a SHA in it). Base zips
  (`<app>/bases/…`) are for the server only: phones get a 404.
- `GET /health`.
- **Removed 2026-11-09:** `GET /v1/store` and `GET /v1/updates/check` (the store-only route, and the `x-zota-*` header
  one). They answer 404 now. The phone asks the store question in the check (§4.6).

### 4.3 Patches in the check (`docs/ota-patches.md` §4, 2026-11-09)
- The request may carry two optional fields: `patches: ["znbsdiff1"]` (the formats the phone applies) and
  `builtIn.sha256` (the APK's own bundle SHA-256). Old phones send neither, and a wrong-looking value is dropped, never an
  error: the check always works.
- When the decision is UPDATE and the phone listed `znbsdiff1`, the answer also has
  `patch: { format, from, fromSha256, url, sha256, size }`. The server picks the smallest patch whose base the phone
  has: its running bundle (matched by `running.sha256`), its built-in bundle (by `builtIn.sha256`), or a kept bundle (by
  id). `from` is the id the phone sent for that bundle. The full `bundle` is always in the answer too (the fallback).
- Made in the background after each bundle upload (`server/src/patches.ts`; the upload never waits for it): from the 5
  newest earlier bundles, and from the built-in bundles of the 3 newest store builds with a lower serial (only those with a
  base). Per file: same SHA in the base → copy; 32 KB or more with a file of the same name in the base → bsdiff (kept if
  under 60 % of the deflated file); else the file whole. A patch zip is kept only if under 60 % of the full zip.
  Two bases with the same bundle SHA give one patch. The jobs run one at a time; `patches.made` and
  `patches.failed` go in the activity log.
- Trust: nothing new is signed. The phone checks every file against `zn-bundle.json` and the bundle SHA-256 against the
  signed manifest, as for a full zip. A bad patch can only fail, then the phone downloads the full zip.

### 4.6 The store question in the check (2026-11-09)
- The request may carry one more optional field: `store: { os, version }`. `os` is `"android"` (version = the
  versionCode, a number) or `"ios"` (version = the app version, a string like `"1.6.2"`). Old phones don't send it.
  A field in the wrong shape is dropped with a warning in the server log: it never fails the check.
- When the request had a good `store`, the answer also has
  `store: { update: { version, critical, title?, message? } | null, appStoreId? }`.
  - `update` is the rules answer for the phone's **channel** (the request's `channel`): `null` = nothing to do;
    `critical` 1 = ask, 2 = must update; `version` = the store version to reach (Android versionCode, iOS "1.6.2");
    `title` / `message` = the text for the app's own update screen, if the rule has any. The rules are those of §3
    (`store_rules`), test rows included: they count only for a phone whose own version is a test row **on that channel**.
  - `appStoreId` is only there for iOS, when the app's store facts have it (`store.ios.appStoreId`).
- No `store` in the request = no `store` in the answer. If the store lookup fails, `store` is left out of the answer
  and the error is logged; the OTA part always answers as before.
- Rules are cached for 10 s per app + channel + OS (saving or deleting a rule clears the cache at once).

### 4.4 "Check now" pushes (`server/src/push.ts`, 2026-11-09)
After a publish, a rollback, a kill switch or a higher rollout, the server sends one FCM data message to the topic
`zn-ota-<app>-<channel>`: `{ zn_ota: "check", zn_ota_delay_ms: "<n>" }`, Android priority high, TTL 1 day. The phone
(PushPlugin with `otaCheck`, subscribed to that topic) waits a random 0..n ms (WorkManager, needs a network), then runs
the normal check. The check only downloads: the bundle runs from the next start, as at launch. Same idea as ZeroBill's RN
app (`OtaCheckWorker.kt`).
- Per app (`apps.push`): `{ fcmProject, delayMs: { <channel>: ms } }`. Defaults: staging 3 s, production 6 h. A kill
  switch, and a change with priority `high` or `critical`, wait at most 10 min; a `normal` change keeps the channel's wait.
  No `fcmProject` = no pushes. Set with `updates app --push '{"fcmProject":"…"}'`.
- Saving or deleting a **store rule** sends the same push, to the rule's channel (so phones ask the store question
  soon, not at their next start). The answer of the rule route has `push`, like the pointer route. `push: false` in the
  body (for a delete: `?push=false`) makes it quiet. A failed push never fails the save.
- A lower rollout sends nothing (it gives nobody anything). `POST /admin/apps/<app>/channels/<ch>/push` (CLI
  `updates push --channel <ch>`) sends one by hand.
- A failed push never fails the change: the answer says so and the activity log has `push.failed`; phones still find
  the update at their next start.
- Token: the pod's Google account from the GKE metadata server (it needs *Firebase Cloud Messaging Admin* on the
  Firebase project); `FCM_ACCESS_TOKEN` for a local run.

### 4.5 Priority (`docs/ota-patches.md` §7)
`normal` (next cold start), `high` (the phone may update at the splash screen), `critical` (update now). It is in the
pointer but not signed. The server accepts exactly these three. The kill switch is always `critical` (the CLI, the
dashboard and the phone suite send it). Set per channel change: `updates publish --priority high|critical`, or the
dashboard's Priority choice.

## 5. Admin API (`/admin/*`, `Authorization: Bearer <ADMIN_TOKEN>`)
Read: apps, state (bundles, channels with history, store builds, families, rules), stats, activity.
Write: create app / channel; reserve a serial; upload a bundle (manifest + zip); register a store build; publish /
roll back / roll out / kill (the body carries the signed pointer; the server checks the signature with the app's keys
and the rules below); stable mark on / off; customer title; store rule add / change / delete (per channel); mark a
bundle or a store build for delete (§5.2); the live mark; source maps (§5.3).
- `POST /admin/apps/<app>/serials` `{ kind: "bundle" | "store", sha256, requires }`: the serial for these bytes
  (`{ serial, existing }`: `existing` is the released bundle, or null). Both kinds send the bytes; the same bytes give
  the same serial back (§3). A store build may leave them out (an older CLI): then it only gets a new number.
- `POST /admin/apps/<app>/store-rules` `{ os, channel?, version, critical, isTest?, title?, message?, note?, confirm?, push? }`
  (`channel` default `production`) and `DELETE /admin/apps/<app>/store-rules/<os>/<version>?channel=<channel>`: the answer is
  `{ rules, push }` (`rules`: every rule of that OS; `push`: the check-now push, §4.4). `GET …/store-check?channel=&os=&version=`
  is the dashboard's phone checker (the same answer as `store.update` in a check).
- `POST /admin/apps/<app>/store-builds`: several store builds can use the same built-in serial. The serial must be
  reserved, and if it has bytes on record they must be the build's `builtinSha256`.
- `updates store-build` builds the JS twice: first with serial 0 (to learn its SHA-256 and requires), then, after the
  serial is taken for those bytes, with that serial into the host's assets. It stops if the second build has another
  bundle SHA-256 (a file must not hold the serial or the time).
- `POST /admin/apps/<app>/serials/peek` `{ sha256, requires }`: read-only, takes nothing. `{ serial, taken }`: the serial
  these bytes already have (`taken: true`), else the next free one. `updates builtin` (an app's `app:js`) uses it, so a
  test APK's built-in bundle never has serial 0 and never uses up a number. Capabilities a phone reports are learned
  for a store build only when the phone's built-in SHA-256 matches (a test APK can carry the same serial).
- `POST /admin/apps/<app>/store-builds/<built-in serial>/base` (multipart `zip`): keeps a store build's built-in bundle as a
  base for patches. Refused when the zip is not a good bundle zip of this app, or its bundle SHA-256 or id is not the store
  build's. The same bytes again is fine (also for a second store build with that serial: every one of them points to the
  base). `updates store-build` does it for you; `updates base --serial N` does it for an older store build.
- `POST /admin/apps/<app>/bundles/<serial>/patches`: makes that bundle's patches again (waits for the job; answers with
  what was made, dropped and failed, and the patches kept). CLI: `updates patches --bundle N`.
- `GET …/state` and `GET …/bundles/<serial>` list each bundle's patches (from, size); the dashboard's bundle page shows
  them with the size as a % of the full zip, and `updates status` prints them. `state` also shows each store build's base size.

**Rules (checked by the server, again in the dashboard):** production takes only a bundle that is stable, built from a
commit (not dirty), with an explicit rollout and the typed `PRODUCTION #N`; stable needs a bundle staging served after
it was built; the kill switch needs `KILL <CHANNEL>` (+ a reason on production) and carries priority `critical`; a forced production store rule needs
`FORCE UPDATE <version>`; a delete is a mark with a 30-day hold (§5.2), never for a bundle a channel serves or the
built-in bundle of a store build marked live; a bundle marked for delete can't be published;
seq must be the channel's next one (a 409 if someone else published first).

### 5.2 Delete with a 30-day hold, the live mark (migration 007, 2026-11-10; Pavan's ask)
- **Live mark** on a store build: `POST /admin/apps/<app>/store-builds/<id>/live` `{ on }`. A person sets it when customers
  can download that build from Play / the App Store. While it is on, the store build can't be marked for delete, and nor
  can its built-in bundle (as an OTA bundle): its phones need those bytes as a patch base. Refused while the build is
  marked for delete ("undo that first").
- **Delete = a mark.** `POST /admin/apps/<app>/bundles/<serial>/delete` `{ on }` (`DELETE …/bundles/<serial>` is the same
  as `on: true`) and `POST …/store-builds/<id>/delete` `{ on }`. The mark sets `delete_at` = now + 30 days. Until then the
  row is hidden in the dashboard (own filter / own list) and `{ on: false }` undoes it. A bundle can't be marked while a
  channel serves it ("publish another bundle there first"), and a marked bundle can't be published. Any older bundle can
  be marked now, also one production served before (the old rule "only the newest, never one production had" is gone).
- **The purge** (`model.purgeDeleted`): hourly, and once a minute after start. Safe with more than one server copy (each
  row is taken with `DELETE … RETURNING` in a transaction). For a due bundle: a channel serving it again (someone
  changed the rows by hand) only takes the mark off; else the row, its zip, the patches **to** it, and, when no store build
  has the same bytes, the patches from it and its map. For a due store build (not live): the row; when no other store
  build has the same built-in serial, its base zip; and, when no OTA bundle has the same bytes, the patches from it and its
  map. Files go after the rows (a failed file remove is logged, never retried: an orphan file costs a few KB).
- **The serial stays taken** (the `serials` row is kept): a number is never given to other bytes.
- `GET …/bundles/<serial>/phones` and `GET …/store-builds/<id>/phones`: `{ phones, days }`, the phones that ran it (as an
  OTA bundle, or as the APK's own bundle `built-in:<app>_<serial>`) in the last 30 days, from `installs_daily`. The delete
  dialogs show it. Those phones keep running the bundle; their next update is a full zip (the patches from it are gone).
- Activity: `bundle.delete.mark` / `.undo`, `bundle.delete` (by `server`), `storebuild.live` / `.unlive`,
  `storebuild.delete.mark` / `.undo`, `storebuild.delete`.

### 5.3 Source maps on the server (2026-11-10; Pavan's ask)
- `POST /admin/apps/<app>/maps/<bundle sha>` (multipart `map`, at most 40 MB; JSON with `mappings` and `sources`) and
  `GET …/maps/<bundle sha>` (the map, or 404 "no source map"). Stored at `<app>/maps/<sha>.map` (GCS in production).
  Bun's maps have file names and positions, no source text.
- The CLI uploads the map with each `release`, `store-build` and online `builtin` (and still keeps a copy in
  `~/.zero-native/maps/<app>/`). An offline `builtin` keeps it locally only. `updates maps` uploads every local map
  (for bundles made before this). A failed upload only warns.
- `stats` decodes each error stack with the map (`decoded`: the stack with `src/Pay.tsx:12:5 (main.js:1:2345)` per
  frame), so the dashboard's Phones page shows TSX lines. 4 decoded maps are kept in memory.
- `GET …/bundles/<serial>/size`: `{ sizes, before }`, the JS size by file and by folder (an npm package counts as one
  folder) from the map, and the same for the nearest of the 5 older bundles that has a map. Sizes are the JS before Hermes,
  read from the map's positions: about 9 % under the real size on the sample, evenly across files. Good for "what is big"
  and "what grew", not exact bytes.

### 5.1 Dashboard sign-in (`server/src/session.ts`, 2026-11-09)
- The browser never gets the admin token. `updates dashboard` sends the token (`POST /admin/login-links`, with
  `x-by`) and gets a one-time code (60 s, one use). It opens `/open?code=…`; the server trades the code for a session
  cookie (`zn_session`, HttpOnly, SameSite=Lax, Secure behind HTTPS, 12 h) and redirects to `/`.
- Without a session, `/` and every dashboard file answer a plain 404 (the server builds the dashboard in memory and
  serves it only to a session: `src/dashboard.ts`). `/health` and `/v1/*` stay public for phones.
- The dashboard's calls send the cookie plus `x-zn-admin: 1`; a cookie without that header gets 403 (another site
  can make a browser send the cookie, not the header). A session can't make new links. `POST /admin/logout` ends it.
- Only SHA-256 hashes of codes and session ids are stored (`login_codes`, `sessions`; migration 003).
- 20 wrong tokens or links from one address in 10 min → 429 for the rest of those 10 min (the client address is the
  X-Forwarded-For entry before Google's load balancer).
- Later: per-person tokens; key changes signed by the current key.

## 6. Dashboard (pages)
Overview · Bundles (+ bundle page; a bundle that is also built into a store build is one row, with the "In the app" chip;
each row shows its patches; marked bundles under "Marked for delete"; the bundle page has "Size by file" from the source
map, with the change since the bundle before) · Channels · Store updates (Play, App Store, one channel at a time; with a phone checker) · Store builds
& families (live mark, delete / keep, and "next download": the patch or full zip a phone on that build gets for the newest
bundle) · Phones (1 / 7 / 35 days) · Activity · Environment (server, database, storage, keys). Dialogs with typed
confirms as in §5, a live log for long actions, and the key file picked once per browser session (kept in memory).

## 7. Config (environment)
`DATABASE_URL` (postgres://…; `pglite:<folder>` for local), `STORAGE` (`gs://<bucket>/<prefix>` or `file:<folder>`),
`ADMIN_TOKEN`, `PUBLIC_URL`, `PORT` (3000). Deploy: Docker image, GKE like the other Bun services
(`server/k8s/`, Cloud Build).

## 8. Not in this first version (planned)
Protocol 2 (one call streams the zip; resume by SHA), per-family targets (today: one pointer per channel, phones that can't run it keep what they have and
the dashboard warns at publish), OIDC logins and per-person tokens, the automatic rollout pause.
