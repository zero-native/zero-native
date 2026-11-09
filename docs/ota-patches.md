# OTA patches and priority (2026-11-09)

Why: a full ZeroBill bundle is about 824 KB. At a checkout counter on slow 4G that is many seconds, and ZeroBill's RN
app already sent small bsdiff patches. Pavan (2026-11-09): bsdiff (zstd adds a native library), priority 0 / 1 / 2 like
RN, a full update screen that carries on from the splash, and reload gates. All must be in the first zn AAB.

Plan context: `docs/ota-architecture-plan.md` §15.2 (patch format, "decide by measuring"), `docs/ota.md` D5.

## 1. Measured on real ZeroBill builds (2026-11-09)
Six consecutive commits of `my-app` (29bd563 → 811f38f), built with today's zn. Sizes in KB.

| Change | Full zip | Changed files only | bsdiff + deflate | bsdiff + bzip2 | bsdiff + xz |
|---|---|---|---|---|---|
| 29bd563 → 9aebed5 (iOS app, 328 lines, 14 files) | 824 | 572 | **89** | 86 | 71 |
| 9aebed5 → 0c16bc8 (20 lines) | 824 | 572 | **3** | 2 | 2 |
| 0c16bc8 → 8ada8d7 (68 lines) | 824 | 572 | **61** | 56 | 47 |
| 8ada8d7 → dd41290 (3 lines, templates changed) | 824 | 624 | **4** | 2 | 2 |
| dd41290 → 811f38f (app id) | 824 | 572 | **3** | 2 | 2 |
| 29bd563 → 811f38f (5 commits in one go) | 824 | 624 | **93** | 91 | 74 |

- Hermes output is stable: a small source change gives a small bytecode change.
- bzip2 saves only 5–10 % over deflate, and deflate is built into Android and iOS. **Choice: bsdiff with deflate**, no
  new phone library. Making one patch takes about 0.5 s in Bun.
- Images and Lottie files rarely change, so "changed files only" already drops about 250 KB.

## 2. The patch file: ZNBSDIFF1 (`tools/ota/bsdiff.ts`)
Percival's bsdiff 4.3 algorithm, own container (the classic BSDIFF40 needs bzip2). Numbers are 8-byte little endian.

```
0   "ZNBSDIF1"                       magic
8   newSize                          size of the file it makes
16  controls                         number of (add, copy, seek) triples
24  controls × (add, copy, seek)     signed int64 each
..  diff bytes (sum of add), then extra bytes (sum of copy)
```
Apply: for each triple, `add` bytes of `diff[i] + old[oldPos + i]` (old byte 0 outside the old file), then `copy` bytes
from extra, then `oldPos += seek`. Every length is checked against newSize, the patch's own size and the counts;
a patch that doesn't end exactly at newSize is refused. `applyPatch` in bsdiff.ts is the reference.

## 3. The patch zip (one per "from bundle → to bundle")
A zip, entries deflated:
- `zn-patch.json`:
  ```json
  { "format": "znbsdiff1",
    "from": { "id": "zerobill_11", "sha256": "<from bundle's bundle SHA-256>" },
    "to":   { "id": "zerobill_14", "sha256": "<to bundle's bundle SHA-256>" },
    "files": {
      "main.hbc":         { "patch": "p/main.hbc", "base": "main.hbc" },
      "main.zn.ui":       { "copy": "main.zn.ui" },
      "images/new.png":   { "zip": "f/images/new.png" } } }
  ```
  `files` names every file in the new `zn-bundle.json`'s `files`, and nothing else. `copy`: the base bundle has a file
  with exactly these bytes (`base` name). `patch`: apply this ZNBSDIFF1 entry to the base file. `zip`: the file itself.
- `zn-bundle.json`: the new bundle's info file, byte for byte (the same as in the full zip).
- `p/<name>`: patches. `f/<name>`: whole files.

**Trust: nothing new is signed, and nothing is weakened.** The signed manifest names the bundle SHA-256, which is a hash
over the file list in `zn-bundle.json`. The phone builds every file, checks its size and SHA against that list, and the
list against the signed bundle SHA, exactly as for a full zip. A wrong or hostile patch zip can only fail.

## 4. Protocol (still protocol 1: new fields are optional, old phones and old servers ignore them)
**Request** (POST /v1/check) adds:
- `patches: ["znbsdiff1"]`: the formats this phone applies.
- `builtIn.sha256`: the APK's own bundle SHA (so the server can use it as a base).

**Answer** adds, only with `action: "UPDATE"` and only when the phone listed the format:
```json
"patch": { "format": "znbsdiff1", "from": "zerobill_11", "fromSha256": "…", "url": "/v1/files/zerobill/patches/…zip", "sha256": "…", "size": 3412 }
```
`from` is a bundle the phone said it has: the running one, a kept one, or the built-in one. The server picks the
smallest patch it has. The full `bundle` (manifest + url) is always there too: the fallback.

## 5. Server (`server/`)
- **Bases:** every uploaded bundle's zip, plus the built-in bundle of each store build. New: `store-build` uploads the
  built-in bundle as a zip (same format as a release zip); stored as `<app>/bases/<sha>.zip`. A store build made before
  this has no base, so phones on it get full zips until their next OTA (then the OTA bundle is the base).
- **Making patches:** after a bundle upload, in the background: from the 5 newest earlier bundles of the app, and the
  built-in bases of the 3 newest store builds with a lower serial. Per new file: same SHA in the base → `copy`; else,
  32 KB or more and the base has a file of that name → bsdiff, kept if its deflated size is under 60 % of the deflated
  file; else `zip`. The whole patch zip is kept only if under 60 % of the full zip. Table `patches` (app, to_id,
  from_id, from_sha256, path, sha256, size, made_at). Paths `<app>/patches/<to id>/<from sha>.zip`, served by
  `/v1/files/` like zips (Range, immutable).
- **Check:** as §4. Only bases whose SHA the phone sent match (running: `running.sha256`; built-in: `builtIn.sha256`;
  kept: by id, ids are unique per bytes).
- **Admin:** the bundle page and `updates status` show the patches (from, size). `updates patches --bundle N` remakes them.

## 6. Phone (`android/runtime`, later iOS)
- Sends `patches` and `builtIn.sha256`.
- On UPDATE with `patch`: checks that `from` is the running, a kept or the built-in bundle and that its bundle SHA is
  `fromSha256`. Downloads the patch zip (resumable, `download.part`, checked against `patch.sha256` / `size`), builds
  the bundle into `tmp/<id>` from the base folder (or the APK's assets), checks everything as §3, then installs as
  usual. Limits: a patch entry may unpack to at most 2 × the file's listed size + 1 MiB; old files are read into
  memory (largest today: main.hbc, 1.6 MB).
- **Any failure** (bad zip, base missing, a SHA mismatch, no space): outcome `patch_failed` with the reason, the patch
  files are deleted, and the same check downloads the full zip. A patch never blocks an update.
- Free space: the patch size plus the unpacked bundle plus the 50 MB kept for the user.

## 7. Priority (unsigned, like RN; set per channel change)
| Value | Meaning | Phone |
|---|---|---|
| `normal` (0) | Next cold start | Downloads in the background; runs from the next cold start (today's behaviour) |
| `high` (1) | May swap at the splash | At a cold start, if the check says UPDATE: the update screen, download, swap before the first screen, within 4 s from the tap. Else it runs from the next start |
| `critical` (2) | Get the fix in now | As high, with 5.8 s; if it lands later in the visit, the app's gates apply it at the next calm moment (never during a payment). The kill switch is always critical |

- Not signed (as RN): a wrong value only makes a phone wait at the splash, or apply sooner, a bundle that is signed anyway.
- Server: `priority` accepts `normal | high | critical`; the CLI's `--priority`, the dashboard's select; the kill switch
  sends `critical`. "Check now" pushes for high and critical wait at most 10 min (normal: the channel's wait).
- Phone status for JS (`Updates.status()`): `nextPriority` 0 / 1 / 2 of the installed update waiting for a restart.

## 8. The launch gate and the update screen (Android: `ZnOtaGate.kt`)
Like RN's Gate 1 (`my-rn-app/src/services/ota/splashGate.ts`), in native code, so it works before JS.
- **When:** a start with UI. A cold start (the first Activity of the process; the tap is the process start), or a fresh
  start in a live process (the user closed the app from Recents and opened it again; the tap is now). The update check
  then runs at once, not after `firstCheckDelayMs`.
- **Waiting for the answer:** Android's launch screen stays while the check is out, at most `launchDecisionMs` from the
  tap (default 800 ms). Why not RN's 400 ms: RN's JS was ready about 1 s after the tap, so RN's check had time; zn draws
  its first screen about 0.3 s after the tap, and a new HTTPS check takes a few hundred ms on 4G. A start with no
  update waits only until the answer comes (or the limit), and only when the answer is slower than the first screen.
- **Answer UPDATE with priority high or critical:** the update screen takes over from the launch screen (same
  background, the icon in the same place, then "Updating for a better experience", a line and a progress bar). The
  bundle downloads (a patch when the server has one), installs, and the app swaps to it with `applyNow` (the same
  screens open again). A kill switch or a switch to a kept bundle with priority high or critical swaps at once.
- **Limits from the tap:** high `launchCapMs` 4 s, critical `launchCapCriticalMs` 5.8 s (RN's). After 400 ms of the
  update screen, the gate also leaves as soon as the download's pace says it can't end in time. Leaving: the app opens
  on the bundle it has; the download goes on; the update runs from the next start, or sooner when the app's gates call
  `applyNow` (`Updates.status().nextPriority`).
- **Never during a payment:** `applyNow` refuses while JS holds updates or another app's answer is pending (UPI), and
  the app opens on the old bundle.
- **Outcomes** (to the server with the next check): `gate_swap` (swapped at the update screen, ms after the tap) and
  `gate_timeout` (showed the screen but let the app open, with why). Starts with no update send nothing.
- **Config:** `ZnOta.Config(launchDecisionMs = 800, launchCapMs = 4000, launchCapCriticalMs = 5800, updateScreen =
  ZnUpdateScreen(title, subtitle, accent = <brand colour>, background = null))`. `launchDecisionMs = 0` turns the gate
  off. The app's JS still runs under the update screen while it waits (the old bundle's first screen is built); after
  the swap it runs again in the new bundle.
