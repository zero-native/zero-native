# App storage and SecureStore

Step 3.5 (**built 2026-10-30**, checked on the Lava, release build). Three places to keep data, each for one job:

| | `storage` (this step) | `SecureStore` (this step) | `flowStore` (step 2.7) |
|---|---|---|---|
| For | preferences, drafts, cached data, small tables | tokens, keys, small secrets | a few records that must never be lost (a pending payment) |
| Calls | **synchronous** (no `await`): ~4–10 µs a write, ~1–3 µs a read; `flush()` ~1 ms | async (system Keystore): ~10–20 ms a call, first `set` ~65 ms | synchronous: ~5 µs a write |
| Types | string, number, boolean, bytes; comes back with its type | strings | JSON |
| After a kill | kept as soon as `set` returns | kept (written, synced, renamed) | kept, never half-written (two copies + checksum) |
| After a power cut | kept if the system wrote it to flash (usually within ~30 s), or right away after `flush()` | kept (synced on every `set`) | as storage (no sync), but falls back to the previous copy |
| After damage (power loss / kill mid-write) | the whole store can be dropped (§3) | that value reads as missing | falls back to the previous copy |
| Backups | not backed up | not backed up (the Keystore key can't leave the phone) | not backed up |
| Built on | MMKV 2.4.3 (C++ source, vendored) | Android Keystore, AES-256-GCM | our own file format |

## 1. API
```ts
import { storage, createStorage, persistedSignal, SecureStore } from "@zeronative/core"

storage.set("lastStoreId", "42")
if (!storage.getBoolean("onboarded")) nav.replace("welcome")
const user = createStorage(`user.${userId}`)   // its own file: sign-out = user.clear()
const lang = persistedSignal("lang", "en")    // a signal kept in storage as JSON; lang.set("kn") saves at once
user.onChange((key) => ...)                    // JS-side changes; ends with the screen

await SecureStore.set("refreshToken", token)
const token = await SecureStore.get("refreshToken")   // null: missing or no longer readable → sign in again
```
- `get` returns the value with the type it was saved with. `getString` / `getNumber` / `getBoolean` / `getBytes`
  return `undefined` for a missing key and throw a `TypeError` for a key of another type (never a wrong value).
- `set(key, null | undefined | object)` is a `TypeError`: use `delete`, or `JSON.stringify` / `persistedSignal`.
- `flush()`: forces the store to flash (~1 ms on the Lava). Call it after an important write (a sign-in, a setting
  the user just chose), not after every write.
- Store ids: 1–64 characters from `A-Z a-z 0-9 . _ -` (they become file names). Default store: `zn.default`.

### From Kotlin (`ZnStorage`)
```kotlin
val store = ZnStorage.store(context)            // or ZnStorage.store(context, "user.42")
store.set("lastStoreId", "42")
val onboarded = store.getBoolean("onboarded") ?: false
```
The same stores JS uses, for a widget, a push-notification handler or a native module. Synchronous, safe from any
thread (calls are serialized; microseconds each), works before `ZnRuntime.start`. JS and Kotlin see each other's writes
at once; JS `onChange` hears only JS writes. Same types and the same "wrong type throws" rule
(`IllegalStateException`). Checked on the Lava: JS writes Hindi + emoji, Kotlin reads it and writes a string, a number
and a boolean back, JS reads all three with their types.

## 2. How it is built
- **MMKV from source, not the AAR.** `core/third_party/mmkv/Core` (MMKV 2.4.3, BSD-3, unchanged; upgrade = replace
  the folder) is built by its own CMake file into `libzn.so`. The AAR's `libmmkv.so` carries its own copy of the C++
  library plus a Java layer: 1.15 MB raw / ~372 KB download. Built from source against the `libc++_shared` we already
  ship: ~87 KB download (measured with a probe library). The same C++ serves iOS later, and our core tests run against
  real MMKV on the phone.
- **Hidden symbols in `libzn.so`:** it now exports only its JNI entry points (`-Wl,--exclude-libs,ALL`,
  `--gc-sections`), so the linker drops MMKV and core code nothing calls. `libzn.so`: 509 KB → 356 KB raw
  (145 KB deflated) with MMKV in it.
- **Path:** JS `storage.set` → host function `__zn_kv_set` (C++, `hermes_engine.cpp`) → `Runtime` →
  `zn::Storage` (`core/src/storage.cpp`) → MMKV. All on the JS thread; no JNI, no Kotlin, no threads.
- **Kotlin path:** `ZnStorage` → JNI (`jni_bridge.cpp`, ids / keys / values as UTF-8 and tagged bytes) → a second
  `zn::Storage` behind a lock → the same MMKV instances (MMKV keeps one per store per process, with its own lock).
- **Tagged values** (`core/include/zn/storage.h`): `[u8 type][payload]`, type 1 string (UTF-8), 2 number (float64
  LE), 3 boolean, 4 bytes. This format is now on users' phones: keep it stable. Native code that reads a store must
  use it.
- **Folder:** `noBackupFilesDir/zn-storage`. Not in Android backups: a restored copy would bring back stale state, and
  MMKV files copied while being written can be damaged. What must follow the user to a new phone belongs on our server.
- **SecureStore** (`ZnSecureStore.kt`): one AES-256-GCM key in the Android Keystore (alias `zn.securestore.v1`, no
  user authentication). One file per key in `noBackupFilesDir/zn-secure`, named by SHA-256 of the key; format
  `[version][IV length][IV][ciphertext + tag]`, with the key name as GCM associated data (a file copied over another
  key's file fails instead of returning the wrong secret). Written to a temp file, `fsync`ed, renamed. A value that
  can never be decrypted again (the Keystore key is gone or broken, `AEADBadTagException`, a damaged file) is deleted
  and reads as `null`. If the Keystore key itself is unusable when saving, a new key is made once.
- **"Can't right now" is not "gone"** (2026-11-06, old-phone audit): every Keystore or file step is tried 3 times (50,
  200 ms apart). Still failing with anything else (a `ProviderException` "Keystore operation failed", seen on some
  Android 7-9 phones, a busy or not-ready Keystore, a file that can't be read now), `get` / `set` reject with code
  `"temporarily_unavailable"` and **nothing is deleted**; `SecureStore.isTemporary(e)` tells it. Saving never makes a
  new key for a failure known to pass (it would make every other value unreadable). Before, any Keystore error deleted
  the value, and an app that logs out on "no token" signed the user out and wiped their data on such a phone. Android
  13+ also uses the Keystore's own code and "transient" flag. A key the Keystore still lists but doesn't load (an
  empty answer on old phones) counts as "can't right now" too: no new key is made while values are stored
  (2026-11-10, second-opinions #152). The rules: `ZnSecureStore.Rules`, `ZnSecureStoreTest`.
  **App rule:** on `isTemporary`, keep the user signed in, retry, and offer "Log in again" (a key really broken in a
  way the phone doesn't tell would otherwise keep failing).

## 3. When data can be lost (and when it can't)
- **The app is killed (swipe away, low memory, crash, force-stop) after `set` returned:** the value is safe. MMKV's
  file is memory-mapped: `set` copies the value into memory the kernel owns, so it outlives the process. Checked on
  the Lava: a value written on one open read back exactly after a force-stop, three times in a row.
- **The app is killed during a `set` (a few µs) or while MMKV compacts the file (when it fills up; ms):** the file can
  be damaged. The store then opens empty (below). This needs bad luck: the kill must land in that window.
- **Power cut / battery dies / hard reboot:** the kernel writes memory pages to flash on its own schedule (usually
  within ~30 s). Values written in that window can be lost, or the file damaged (store opens empty). `flush()` closes
  the window for what it covers.
- **Verified correctness, not just speed:** the `/dev/storage` speed check writes 10,000 different keys with Hindi
  values, reads every one back and compares: all equal on every run.

## 4. What happens when a store is damaged (measured)
Core test `testStorageKill` (on the Lava): a child process writes nonstop to a store (a counter + 40 keys of changing
size) and is killed with SIGKILL at a random moment, 100 times; the parent then reads everything.
- In **6 of 100** rounds the store was damaged. MMKV's checksum catches it. The likely cause is a kill while MMKV
  rewrites its file in place to compact it.
- MMKV's **"recover" mode returned garbage**: value bytes read as keys (137 keys instead of ≤ 41, the counter gone).
  So we use MMKV's **"discard" mode**: a damaged store opens **empty** (logged as an error). With it, every round read
  back clean: **100 / 100, never a wrong value**.
- Real apps are far less exposed than this test (it writes nonstop, so every kill lands mid-write; apps write rarely
  and are usually killed while idle). The real risk is a hard power-off or battery death soon after a write: we don't
  force data to disk (no `fsync`), like FlowStore.
- **Rule for authors:** keep in `storage` only what the app can rebuild or live without (preferences, drafts, caches).
  Money state: FlowStore + the server. Secrets: SecureStore.

## 5. Not in this step (later)
| Item | Notes |
|---|---|
| Encrypted stores (`createStorage(id, { encrypted: true })`) | MMKV can encrypt (AES-CFB); the key would come from SecureStore. Opening a store with the wrong key loses its data, so it needs a careful design (key rotation, `reKey`). Not needed while files are app-private. |
| Keep a backup copy of important stores | MMKV can copy a store to another folder; restore it when a store was dropped as damaged (§3). Only if dropped stores show up in practice. |
| Stores that go into Android backups | `createStorage(id, { backup: true })` → a folder Android's Auto Backup includes (subject to the app's backup rules and the 25 MB limit). Android stops the app before an Auto Backup, so files aren't copied mid-write [check]. Good for preferences (language, theme). Not for staying signed in: see §6. |

## 6. Staying signed in after an app update or a reinstall
- **App update:** nothing to do. Updates never touch app files or Keystore keys: `storage`, `SecureStore` and
  `flowStore` all survive.
- **Uninstall + reinstall (same or new phone):** Android deletes the app's files **and its Keystore keys**. Only
  Android Auto Backup (Google Drive) brings files back, and only as of the last backup (taken about once a day, when
  the phone is idle, charging and on Wi-Fi). A token kept in SecureStore can't come back that way: its key was in the
  Keystore and is gone.
- **The right tool for "stay signed in after reinstall": Google's Block Store** (`play-services-auth-blockstore`). It
  keeps a small token (up to 4 KB) through uninstall / reinstall and onto a new phone, end-to-end encrypted with the
  user's screen lock, made for exactly this. Cost: a Google Play Services dependency (size not measured).
- **For a payment app, think before restoring sessions:** a restored token means the session moves to another phone
  without a fresh sign-in. Many payment apps prefer a quick re-login (OTP read automatically with the SMS Retriever
  API, or Google One Tap). A product call for ZeroBill, not a framework default.
| SecureStore with user authentication | Fingerprint / screen lock before reading a secret (a Keystore key with `setUserAuthenticationRequired`). |
| iOS | MMKV (same C++), Keychain for SecureStore. |

## 7. Background work (push messages, workers) while the app is open
**Same process (the default):** a `FirebaseMessagingService`, a WorkManager worker or a `BroadcastReceiver` runs in
the app's main process unless its manifest entry says `android:process`. Then:
- **The app is open:** the push handler (on its own thread, through `ZnStorage`) and JS (on the JS thread) use the
  **same** MMKV instance; MMKV's lock makes each `get` / `set` atomic. Checked on the Lava: a Kotlin thread and JS
  each wrote 20,000 times at once, including one key both wrote; JS saw Kotlin's value ~3,000 times mid-run; **0 torn
  values, both counters exact**, 3 runs out of 3.
- **The app is closed:** Android starts the process for the message (`Application.onCreate`, so `ZnRuntime.start`
  runs too) and `ZnStorage` works at once; it doesn't need JS.
- **What is not atomic:** a read-then-write across calls. If the push handler does `count = get + 1; set(count)`
  while JS does the same, one increment can be lost (last writer wins). Give each key one writer (the handler writes
  `push.unread`, JS only reads it), or keep a list of separate keys (`push.msg.<id>`).
- **JS isn't told about Kotlin writes:** `storage.onChange` fires only for writes made from JS. To refresh the screen
  when a push arrives, send a native module event (`emit`) from the handler, or re-read the key when the screen comes
  back. (A built-in "changed from native" event is a possible later addition.)

**Another process (`android:process=":something"`):** not allowed. Stores are opened in MMKV's single-process mode,
where two processes writing one file can damage it, and a second process would not see the first one's writes.
- `ZnStorage.store()` throws `IllegalStateException` outside the main process.
- `ZnRuntime.start` does nothing outside the main process (logged): some SDKs declare their own process, and
  `Application.onCreate` runs there too; it must not start a second JS runtime that could open the same files.
- If an app really needs another process to share data: MMKV's multi-process mode (file locks, slower) as an opt-in
  per store; not built.
