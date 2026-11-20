# OTA Updates & `zn-updates` Server

Over-the-air updates in `zero-native` are **part of the core architecture**, not a fragile add-on.

Every `zero-native` bundle is a **signed, contract-checked artifact** — paired with automatic crash rollback, staged rollouts, bsdiff patches (Android), and a self-hosted dashboard (`zn-updates`).

---

## 1. How the Capability Contract Works

Every time you build a bundle, the compiler inspects what your app actually uses and writes a `requires` block into `zn-bundle.json`:

- **`requires.registry`** — lowest UI registry version that supports every component/prop in the bundle
- **`requires.hostApi`** — required JS ↔ native bridge version
- **`requires.bytecode`** — exact Hermes bytecode format version
- **`requires.modules`** — native modules and minimum versions required on both OSes
- **`requires.os.{android,ios}`** — platform-specific native module requirements (one-OS modules go only under their OS)

When a phone checks for updates (`POST /v1/check`), it sends the native capabilities compiled into its installed binary. **Both the server and the phone verify compatibility** — a phone never downloads or boots a bundle whose native requirements it doesn't satisfy.

---

## 2. Trust & Cryptographic Signing

1. **ECDSA P-256 signatures** protect both the bundle archive and the channel pointer (which bundle is live on `production`, `staging`, etc.).
2. **Main & backup keys:** `zn keygen` stores your main private key locally in `~/.zero-native/keys` (and prints the public key). Keep your backup private key offline, and bake both public keys into your app binary so you can rotate keys without stranding users.
3. **Browser-signed pointers:** In the `zn-updates` web dashboard, channel pointers are signed **in your browser** using WebCrypto — the server never holds your private signing key.

---

## 3. Rollouts, Patches & Safety Nets

- **bsdiff binary patches (Android):** On Android, phones download a tiny binary patch against their current bundle (measured at **3–93 KB** on one production app vs. ~824 KB full) and verify the reconstructed bundle's SHA-256 before installing. *(iOS currently sends `patches: []` and downloads full bundles.)*
- **Staged rollouts, rollback & kill switch:** Roll out by percentage (`--rollout` / `rollout --percent`), roll back to any previous bundle, or trigger the kill switch (`kill`, pointing phones back to their built-in bundle).
- **Boot watchdog & automatic rollback:**
  - When a new bundle boots, native marks it *pending* until JS starts cleanly and renders the first screen.
  - If the new bundle crashes before becoming healthy, the runtime automatically rolls back to the last known-good bundle (or built-in bundle), marks the bad bundle blocked, and reports the failure outcome to the server.
- **Update priority & apply timing (`zn publish --priority normal|high|critical`):**
  - `normal` (default) — downloads in the background and runs from the **next cold start** (call `Updates.applyNow()` from JS to apply sooner).
  - `high` — may fetch and apply during the cold-start splash launch gate (bounded by a ~4 s cap), or on next start / `Updates.applyNow()`.
  - `critical` — gets a longer launch-gate cap (~5.8 s) to apply at cold start; otherwise runs from the next start or when your app calls `Updates.applyNow()` at a safe moment.
- **Silent push triggers:** When configured with `zn app --push '{"fcmProject":"<project-id>"}'`, the server automatically sends an FCM/APNs "check now" push after a publish, rollout, or kill — handled natively (without waking JS) to trigger a background download. *(On iOS, silent pushes are not delivered if the user swiped the app away.)*
- **Payment / critical flow protection (`Updates.holdApply()`):**
  ```ts
  import { Updates } from "@zeronative/core"

  const release = Updates.holdApply()
  try {
    await runSensitiveCheckoutFlow()
  } finally {
    release()
  }
  ```
  While a hold is active, the runtime defers any live bundle swap until your flow finishes.

---

## 4. JS API (`Updates`)

Import `Updates` from `@zeronative/core`:

```ts
import { Updates } from "@zeronative/core"

// Current bundle state (enabled, phase, channel, running, builtIn, next, pendingRestart, nextPriority, healthy, ...)
const status = await Updates.status()

// Manually trigger an update check
const result = await Updates.check()

// Apply a downloaded update immediately (refuses safely if a hold is active)
await Updates.applyNow()

// Prevent live reload during a sensitive flow
const release = Updates.holdApply()
```

---

## 5. Host Configuration (Android & iOS)

OTA is **off by default** until your native host configures it with your HTTPS server URL, channel, and pinned public keys. *(Release builds refuse non-`https://` servers.)*

- **Android (`Application.onCreate()`):**
  ```kotlin
  ZnOta.configure(
    this,
    ZnOta.Config(
      server = "https://updates.example.com",
      channel = "production",
      publicKeys = listOf(mainPublicKeyPem, backupPublicKeyPem),
    ),
  )
  ```
- **iOS (`AppDelegate.swift`):**
  ```swift
  ZnOta.configure(
    ZnOta.Config(
      server: "https://updates.example.com",
      channel: "production",
      publicKeys: [mainPublicKeyPem, backupPublicKeyPem]
    )
  )
  ```

Every store build shipped to Google Play or the App Store receives a **serial number** via `zn store-build` so phones never downgrade from a newer store build to an older OTA bundle.

---

## 6. CLI Workflow (`zn`)

Create a `zn-updates.json` file in your app folder (`zn new` does not create it yet):

```json
{
  "app": "my-app",
  "server": "https://updates.example.com",
  "build": ["bun", "run", "../zero-native/tools/zn-build.ts", "app", "--name", "my-app"],
  "assets": "android/app/src/main/assets"
}
```

Auth tokens from `zn login` live in `~/.zero-native/updates.json` (or `ZN_UPDATES_TOKEN`).

```bash
# 1. One-time setup: sign in, generate keys, register app
zn login --server https://updates.example.com --token <ADMIN_TOKEN> --by "Your Name"
zn keygen --name main      # private key saved in ~/.zero-native/keys
zn keygen --name backup    # move backup private key offline
zn app --keys <main.pub>,<backup.pub> --name "My App"

# 2. Register a Play / App Store build (reserves serial & uploads base for patches)
zn store-build --os android --channel production --label "play AAB" --version-code 10 --version-name 1.0.0

# 3. Build and upload a new OTA bundle (never publishes automatically)
zn release

# 4. Publish to staging, mark stable, then roll out to production
zn publish --channel staging --bundle 12 --rollout 100
zn stable --bundle 12 --note "Verified on test phone"
zn publish --channel production --bundle 12 --rollout 5 --priority normal  # requires typing PRODUCTION #12
zn rollout --channel production --percent 50

# 5. Operations: status, dashboard, kill switch, delete/keep, source maps
zn status
zn dashboard                                              # opens signed-in web dashboard (12 h session)
zn kill --channel production --reason "Revert checkout"   # requires typing KILL PRODUCTION
zn delete --bundle 12                                     # 30-day soft delete (undo with `zn keep --bundle 12`)
zn maps                                                   # uploads any local source maps not yet on the server
```

- **Symbolicating stack traces:** With `zn-updates`, the server symbolicates crash traces using uploaded maps. For the older local OTA store, run `zn ota symbolicate [file] [--bundle <id|sha>]`.
- Other commands: `zn rule` (store-update rules), `zn title`, `zn builtin`, `zn base`, `zn patches`, `zn push`.

---

## 7. Self-Hosting `zn-updates`

The `server/` directory is a self-hosted update server built with **Bun**, **PostgreSQL** (or embedded PGlite for local dev), local filesystem or **Google Cloud Storage**, and a built-in web dashboard (signed in via one-time link + session cookie from `zn dashboard`).

### Run locally (with demo data)
```bash
bun run updates:server --demo
# or: zn server --demo
```

### Run in production
```bash
bun run server/src/index.ts
# or from server/: bun run start
```

### Environment variables (`server/src/index.ts`)
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | `postgres://...` or `pglite:<dir>` (migrations run automatically on start) |
| `STORAGE` | `file:<dir>` or `gs://<bucket>/<prefix>` for bundle & patch blobs |
| `CACHE_DIR` | Local cache directory (default `./.cache`) |
| `ADMIN_TOKEN` | Admin bearer token (**at least 16 characters**) for CLI & one-time dashboard login links |
| `PORT` | HTTP port (default `3000`; run behind TLS / a CDN in production) |
| `FCM_ACCESS_TOKEN` | Optional token for local "check now" push testing |

For Docker and Kubernetes deployment details, see [zn-updates-deploy.md](../zn-updates-deploy.md).
