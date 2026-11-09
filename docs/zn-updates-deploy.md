# zn-updates: deploy and first release (ZeroBill, 2026-11-09)

The server is `server/` (design: `docs/zn-updates-server.md`). It runs as one container on the GKE cluster, like
`receipt-viewer`. Files: `server/Dockerfile`, `server/k8s/deployment.yaml`, `server/k8s/cloud-build.yaml`.

## 1. One-time setup (Pavan)
1. **Postgres:** a new empty database just for zn-updates. The server creates its tables at start (migrations in
   `server/src/migrations/`); it needs CREATE rights on its own schema only.
2. **Bucket:** a private bucket, e.g. `gs://my-app-updates` (no public access: phones download through the server).
   If you pick another name, change `STORAGE` in `server/k8s/deployment.yaml`.
3. **Access to the bucket:** a Google service account `zn-updates@my-gcp-project.iam.gserviceaccount.com` with Storage
   Object Admin on this bucket only, used by the pod's Kubernetes account `default/zn-updates` (Workload Identity; the
   Kubernetes account is in `server/k8s/deployment.yaml`). Made once:
   ```bash
   gcloud iam service-accounts create zn-updates --project=my-gcp-project --display-name="zn-updates server"
   ```
   ```bash
   gcloud storage buckets add-iam-policy-binding gs://my-app-updates --member=serviceAccount:zn-updates@my-gcp-project.iam.gserviceaccount.com --role=roles/storage.objectAdmin
   ```
   ```bash
   gcloud iam service-accounts add-iam-policy-binding zn-updates@my-gcp-project.iam.gserviceaccount.com --role=roles/iam.workloadIdentityUser --member="serviceAccount:my-gcp-project.svc.id.goog[default/zn-updates]"
   ```
   For the "check now" pushes (`docs/zn-updates-server.md` §4.4), the same account sends FCM messages:
   ```bash
   gcloud projects add-iam-policy-binding my-gcp-project --member=serviceAccount:zn-updates@my-gcp-project.iam.gserviceaccount.com --role=roles/firebasecloudmessaging.admin
   ```
   Then once: `updates app --push '{"fcmProject":"my-gcp-project"}'` (staging waits up to 3 s, production up to 6 h).
4. **Secret** `zn-updates` with `DATABASE_URL` and `ADMIN_TOKEN` (made 2026-11-09 from the values in
   `my-app/.env`: `ZN_UPDATES_DATABASE_URL`, `ZN_UPDATES_ADMIN_TOKEN`; that file is git-ignored):
   ```bash
   kubectl create secret generic zn-updates --from-literal=DATABASE_URL='postgres://USER:PASS@HOST:5432/zn-updates-01' --from-literal=ADMIN_TOKEN='<32+ random characters>'
   ```
5. **Domain:** `appupdates.example.com` already points at the gateway (203.0.113.10), and TLS comes from the
   `*.example.com` cert in `my-cert-map`. The HTTPRoute `app-updates-route` is in `server/k8s/deployment.yaml`,
   so each deploy applies it. Phones refuse plain HTTP in release builds.
   The same file has a HealthCheckPolicy: the load balancer checks `/health`, because `/` answers 404 without a
   dashboard session. Without it a new pod never gets traffic and Cloud Build fails after 5 min (seen 2026-11-09).
6. **Upload size:** the root `.gcloudignore` makes `gcloud builds submit` send only the files the image needs.

## 2. Deploy (each time the server changes)
From the zero-native repo root:
```bash
gcloud builds submit --config server/k8s/cloud-build.yaml --substitutions "_CLOUDSDK_COMPUTE_ZONE=asia-south1-b,_CLOUDSDK_CONTAINER_CLUSTER=my-cluster" .
```
Keep the quotes: without them PowerShell splits the value at the comma and gcloud says `_CLOUDSDK_CONTAINER_CLUSTER`
"is not matched in the substitution data".
Check: `https://appupdates.example.com/health` answers `{"ok":true,...}`, and the address itself answers 404 (the
dashboard opens only through `updates dashboard`, §3).

## 3. First release setup (once per app)
Run from the app's folder (it holds `zn-updates.json`: `app`, `server`, `build`, `assets`).
1. Keys, on your computer (never in a repo):
   ```bash
   bun run ../../Futuristic/zero-native/tools/updates/cli.ts keygen
   ```
   ```bash
   bun run ../../Futuristic/zero-native/tools/updates/cli.ts keygen --name backup
   ```
   Note both public keys, then move the backup private key offline (it is for the key drill and a lost main key).
2. Sign in, and create the app with both public keys and its store facts:
   ```bash
   bun run ../../Futuristic/zero-native/tools/updates/cli.ts login --server https://appupdates.example.com --token <ADMIN_TOKEN> --by Pavan
   ```
   ```bash
   bun run ../../Futuristic/zero-native/tools/updates/cli.ts app --name ZeroBill --keys <MAIN_PUBLIC>,<BACKUP_PUBLIC> --store '{"android":{"packages":{"com.example.app":"production","com.example.app.staging":"staging"}},"ios":{"appStoreId":"1234567890","bundles":{"com.example.app.ios":"production"}}}'
   ```
   Open the dashboard (from the app folder; signs this browser in for 12 h, the token stays in the terminal):
   ```bash
   bun run ../../Futuristic/zero-native/tools/updates/cli.ts dashboard
   ```
   The admin token lives only in `~/.zero-native/updates.json` (per person, outside every repo) or `ZN_UPDATES_TOKEN`
   for scripts. Without a session the server's address answers 404.
3. The same two public keys go into the app's `ZnOta.Config(publicKeys = …)`, with
   `server = "https://appupdates.example.com"` and the channel of each build type.

## 4. A store build (AAB / IPA) and its OTA line
```bash
bun run ../../Futuristic/zero-native/tools/updates/cli.ts store-build --os android --channel production --label "production AAB" --version-code 170 --version-name 1.7.0
```
This reserves the store build's serial (always above every OTA bundle), builds the built-in bundle into the host's
assets with it, records the build, and **uploads the built-in bundle as a zip** (the base for OTA patches: phones on this
build then download small patches, not the full zip). Then build the AAB as usual. Its family appears on the dashboard
after the first phone checks in.

Run it from a clean build: the base must be the bundle that goes into the AAB (the server refuses a zip with another
bundle SHA-256). If the base upload fails, the store build is still recorded; run `updates base --serial <built-in serial>`
before you change the assets folder. A store build made before patches has no base: its phones get full zips until their
first OTA, then the OTA bundle is the base.

## 5. An OTA update
```bash
bun run ../../Futuristic/zero-native/tools/updates/cli.ts release
```
Then on the dashboard: Bundles → To staging → test on a staging phone → Mark stable → To production (type
`PRODUCTION #N`, start at 5 %) → watch Phones → raise the rollout. Roll back = publish an older bundle; kill switch =
phones go back to their built-in bundle. The same actions exist on the command line (`publish`, `stable`, `rollout`,
`kill`).

Patches (`docs/ota-patches.md`) are made by the server in the background after `release`. See them with `status`, or
`patches --bundle N` (makes them again). Priority per publish: `--priority high` (may update at the splash) or
`--priority critical` (update now); the default is `normal` (next start). The kill switch is always critical.

## 6. Store updates (Play / App Store)
Dashboard → Store updates, or `rule --os android --version 170 --critical 1|2 [--test]`. Forced (2) for customers asks
you to type `FORCE UPDATE <version>`. Test rows reach only phones whose own version is a test row.

## 7. Wiring an app (ZeroBill, before its AAB)
1. `zn-updates.json` in the app folder: `{"app":"<id>","server":"https://appupdates.example.com","build":[…],"assets":"<host assets folder>"}`.
   The app id is written into every bundle and the server's records, so pick it before the first production build
   (ZeroBill: `zerobill`).
2. The Android host: `ZnOta.configure(this, ZnOta.Config(server = "https://appupdates.example.com", channel = <per build
   type>, publicKeys = listOf(MAIN, BACKUP)))`. Release builds refuse `http://` (only the sample sets
   `allowHttpInRelease`).
3. Store updates: register `AppUpdatesPlugin()` (and forward `onActivityResult` to `AppUpdatesModule.onActivityResult`),
   then in JS `checkStore({ server, app, os, version })` and `createAppUpdateEngine` (`plugins/app-updates/README.md`).
   An app that keeps its old JS store check can point it at `GET /v1/updates/check` (the same `x-zota-*` headers).
4. During a payment: `AppUpdates.setBusy(true)` and the OTA hold, so neither a forced store update nor an OTA restart
   lands mid-checkout. `false` again when it ends.
5. Push-triggered background updates: keep `PushPlugin()` (otaCheck on). The phone subscribes to `zn-ota-<app>-<channel>`
   by itself; after each publish the server sends the "check now" push and the phone downloads within the channel's
   wait (staging 3 s, production up to 6 h), for its next start (`docs/zn-updates-server.md` §4.4).
6. Every AAB: `store-build` first (§4), so its own bundle's serial is above every OTA bundle. A store build made without
   it keeps running an older OTA bundle that still fits (seen on the Lava, 2026-11-09: built-in serial 0 lost to OTA #1).

## 8. Local run (no Postgres, no bucket)
```bash
bun run updates:server --demo
```
It prints a one-time dashboard link (60 s) and the token `local-admin-token-0000`; later links come from
`updates dashboard --server http://127.0.0.1:8790` after `updates login`. A debug app reaches it with
`adb reverse tcp:8790 tcp:8790` and `server = "http://127.0.0.1:8790"`.
