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
| Store updates | `plugins/app-updates` | Play in-app updates (Android), App Store page (iOS); the app's JS asks the server and shows its own screens |

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
  customer title. Same bytes + same requires = same serial (unique key).
- `store_builds`: app, os, channel, version code, version name, label, **built-in serial** (reserved from the same
  serial line as bundles, so a new store build never loses to an older OTA bundle), capabilities, **family** (a hash of
  the capabilities), git, built by / at, and the **base** (`base_path`, `base_size`: the built-in bundle as a zip, kept
  as a base for patches; empty for a store build made before patches).
- `pointers`: app, channel, seq, target (bundle id or `BUILT_IN`), rollout, priority (`normal` / `high` / `critical`),
  reason, kind (publish / rollback / rollout / kill), the signed pointer JSON, by, at. Append-only; the highest seq is
  what the channel serves.
- `patches` (migration 004): app, to id, from id, from SHA-256 (the base bundle's bundle SHA), path, patch zip SHA-256,
  size, made at. One row per "from bundle → to bundle". The zip is `<app>/patches/<to id>/<from sha>.zip`; the base zips
  of store builds are `<app>/bases/<bundle sha>.zip`. Format and rules: `docs/ota-patches.md`.
- `store_rules`: app, os, version (Android versionCode; iOS "1.6.2" as one number), critical 0 / 1 / 2, test flag, note,
  by, at. Same thresholds as the RN backend: optional = highest version with critical ≥ 1, forced = highest with
  critical 2; test rows count only for phones whose own version is a test row.
- Stats: `installs_daily` (day, app, channel, install hash, running bundle: one row per phone per day),
  `events_daily` (day, app, channel, bundle, kind, detail, count), `errors` (the last error stacks, for symbolicate).
  35 days kept.
- `activity`: every admin action (who, what, detail).

## 4. Phone API
- `POST /v1/check` (protocol 1, today's phones): request and answer exactly as `tools/ota/decide.ts` / `server.ts`.
  The answer also gets `store: { version, critical }` when a store rule applies (old phones ignore it). The decision
  is `decide()` from `tools/ota/decide.ts`, unchanged.
- `GET /v1/files/<path>`: a bundle zip (`<app>/bundles/<id>/<sha>.zip`) or a patch zip
  (`<app>/patches/<to id>/<from sha>.zip`), resumable (Range), cached forever (the path has a SHA in it). Base zips
  (`<app>/bases/…`) are for the server only: phones get a 404.
- `GET /v1/store?app=&os=&version=&channel=`: the store answer alone, for an app's JS (the ZB app's
  `storeUpdateSource.ts` today asks the main backend with `x-zota-*` headers; `GET /v1/updates/check` answers those
  headers too, so only the base URL changes).
- `GET /health`.

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

### 4.4 "Check now" pushes (`server/src/push.ts`, 2026-11-09)
After a publish, a rollback, a kill switch or a higher rollout, the server sends one FCM data message to the topic
`zn-ota-<app>-<channel>`: `{ zn_ota: "check", zn_ota_delay_ms: "<n>" }`, Android priority high, TTL 1 day. The phone
(PushPlugin with `otaCheck`, subscribed to that topic) waits a random 0..n ms (WorkManager, needs a network), then runs
the normal check. The check only downloads: the bundle runs from the next start, as at launch. Same idea as ZeroBill's RN
app (`OtaCheckWorker.kt`).
- Per app (`apps.push`): `{ fcmProject, delayMs: { <channel>: ms } }`. Defaults: staging 3 s, production 6 h. A kill
  switch, and a change with priority `high` or `critical`, wait at most 10 min; a `normal` change keeps the channel's wait.
  No `fcmProject` = no pushes. Set with `updates app --push '{"fcmProject":"…"}'`.
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
and the rules below); stable mark on / off; customer title; store rule add / change / delete; delete an unreleased
bundle.
- `POST /admin/apps/<app>/store-builds/<built-in serial>/base` (multipart `zip`): keeps a store build's built-in bundle as a
  base for patches. Refused when the zip is not a good bundle zip of this app, or its bundle SHA-256 or id is not the store
  build's. `updates store-build` does it for you; `updates base --serial N` does it for an older store build.
- `POST /admin/apps/<app>/bundles/<serial>/patches`: makes that bundle's patches again (waits for the job; answers with
  what was made, dropped and failed, and the patches kept). CLI: `updates patches --bundle N`.
- `GET …/state` and `GET …/bundles/<serial>` list each bundle's patches (from, size); the dashboard's bundle page shows
  them with the size as a % of the full zip, and `updates status` prints them. `state` also shows each store build's base size.

**Rules (checked by the server, again in the dashboard):** production takes only a bundle that is stable, built from a
commit (not dirty), with an explicit rollout and the typed `PRODUCTION #N`; stable needs a bundle staging served after
it was built; the kill switch needs `KILL <CHANNEL>` (+ a reason on production) and carries priority `critical`; a forced production store rule needs
`FORCE UPDATE <version>`; delete only the newest unreleased serial, never one a production pointer or store build names;
seq must be the channel's next one (a 409 if someone else published first).

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
Overview · Bundles (+ bundle page) · Channels · Store updates (Play, App Store; with a phone checker) · Store builds
& families · Phones (1 / 7 / 35 days) · Activity · Environment (server, database, storage, keys). Dialogs with typed
confirms as in §5, a live log for long actions, and the key file picked once per browser session (kept in memory).

## 7. Config (environment)
`DATABASE_URL` (postgres://…; `pglite:<folder>` for local), `STORAGE` (`gs://<bucket>/<prefix>` or `file:<folder>`),
`ADMIN_TOKEN`, `PUBLIC_URL`, `PORT` (3000). Deploy: Docker image, GKE like the other Bun services
(`server/k8s/`, Cloud Build).

## 8. Not in this first version (planned)
Protocol 2 (one call streams the zip; resume by SHA), per-family targets (today: one pointer per channel, phones that can't run it keep what they have and
the dashboard warns at publish), OIDC logins and per-person tokens, the automatic rollout pause.
