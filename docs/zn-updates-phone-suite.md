# zn-updates phone suite: OTA end to end on a real phone

`tools/updates/phone-suite.ts` tests the whole OTA line (release, publish, download, run, rollback, kill switch, push,
the server's numbers) on a real Android phone over adb, for any app that uses the zn-updates server. It works with a
**release-type build** too (not debuggable): it never uses `run-as` or a debug helper.

```bash
bun run updates:phone --app-dir <app folder> --package <package> [--serial <adb serial>] [--channel staging]
                      [--server <url>] [--until <case>] [--push-wait 90] [--healthy-wait 20] [--no-logs] [--list]
```

- `--app-dir`: the app's folder with `zn-updates.json` (`app`, `server`, `build`). `--server` replaces its server (for a local one).
- `--package`: the app on the phone. The app must be installed, and must be built for this server and channel.
- `--channel`: default `staging`. **`production` is refused.** If the server says the package is a production package
  (`store.android.packages`), or belongs to another channel, the suite stops.
- `--until <case>`: stop after that case (cases build on each other, so there is no "only this case").
- `--push-wait`: seconds to wait for the background download after a push. `--healthy-wait`: seconds to wait for
  "marked healthy" (0 = don't check; an app that marks itself healthy only after login needs this). `--no-logs`: don't read
  the app's log, use the server only.
- Sign in first: `bun run updates login --server <url> --token <ADMIN_TOKEN>` (the suite uses the CLI's saved login, or
  `ZN_UPDATES_TOKEN`), and the app's main private key from `~/.zero-native/keys/<app>-main.pem` (or `--key`).
- With two devices on adb (a phone and an emulator), pass `--serial` or set `ANDROID_SERIAL`.

## What it changes
- **The channel:** it publishes test bundles and a kill switch to `--channel`. At the end it publishes the newest test
  bundle again if needed, so the channel is **not** left killed or on an older bundle. It prints what the channel served
  before and the command to put that back. Run it on a quiet channel: other phones on it will take the test bundles too.
- **The phone:** the app is started and ended. The screen timeout is raised while it runs and put back.
  It never uses `am force-stop` (on a MediaTek phone it blocks the app's WebView). To end the app it does what low memory
  does: Home, open Settings, Home, `am kill`, and checks with `pidof`.
- **The app's folder:** nothing. Test bundles are the app's real build (`zn-updates.json` `build`, run once) plus one small
  file `zn-suite-marker.txt` with a new text each time, written into a temporary copy, listed in `zn-bundle.json`, then
  signed and uploaded like any bundle (`tools/updates/client.ts`). Same code, different bytes, so the server gives each one
  a new serial. The server lists them as "phone suite <run id> test bundle N".
- **One script at a time:** `~/.zero-native/phone.lock` (a dead owner's lock is taken over).
- Results: `.zn-updates-phone/results.md`, and `.zn-updates-phone/<case>.log` for each failed case (the app's log lines, the
  server's stats). The folder is git-ignored.

**Last run: 2026-11-09, Lava (Android 14), ZeroBill staging release APK 169 against https://appupdates.example.com:
7 of 7 passed** (push-background: the bundle was installed 4 s after the publish, with the app not running). Then by
hand: APK 170 (`store-build`, built-in #11) installed over the phone running OTA #10 → it ran its own #11, deleted the
old bundles, and the server answered `NONE APK_NEWER`.
- Publishes are quiet (`push: false`) except in push-background: with the push on, the phone downloads within a second
  or two, before the suite's own cold start (seen on the first run).
- When `am kill` can't end the app, the suite uses `am stop-app` (see `endApp`).

## The cases (each builds on the one before)
| Case | Steps | Proof |
|---|---|---|
| `start` | cold start | log: `zn: bundle: running <id>`, `zn-ota: check <channel>: <action> <reason>` (not failed, the right channel). Server: a phone today on that bundle |
| `update` | release, publish, cold start, cold start | log: `UPDATE NEW_BUNDLE`, `installed <id>`, then `bundle: running <id>`, `report: started <id>`, `safety: <id> is healthy`. Server: events `downloaded` and `started` for the bundle (new since the case began), a phone on it |
| `kept` | release a newer bundle, run it, publish the first one again (a rollback), cold start twice | log: `USE_LOCAL KEPT`, no `installed` line, then runs the first bundle again. Server: `started` again, `switched`, no new `downloaded` |
| `kill-switch` | kill the channel (`KILL STAGING` typed for it), cold start twice | log: `BUILT_IN KILL_SWITCH`, then the built-in bundle runs. Server: a `switched` to built-in, a phone on `built-in:<id>` |
| `push-background` | start once (the phone subscribes to its topic), end the app, release, publish (the server sends the push) | log: the app's process starts by itself and logs `installed <id>`; no activity of the app is on top (`dumpsys activity activities`); the next cold start runs it with `NONE UP_TO_DATE` and no second download. Server: `downloaded`, `started` |
| `settle` | if the channel is killed, publish a bundle; start until the phone runs what the channel serves | log: runs the served bundle. Server: a phone on it |
| `server-view` | cold start | server: this phone today on the expected bundle, every event of the earlier cases is there (`downloaded`, `started`, `switched`), a `healthy` event for each bundle that was healthy in the log, no error rows for the test bundles |

**`push-background` is SKIPPED (not failed)** when: the server has no push config for the app
(`updates app --push '{"fcmProject":"…"}'`), the app's log has no `OTA topic` line at start (tag `zn-push`: no push
plugin, or `PushPlugin(otaCheck = false)`), or the server could not send the push (for example a local server without an
FCM token). Lines come from `plugins/firebase-messaging/README.md`, "OTA pushes".

Exit code 0 when every case that ran passed (skipped ones don't count). Not 0 when one failed, or a tool problem stopped the run.

## What a release build can hide
- **Logs.** A release build may strip or shorten `Log` lines (R8). The suite checks at the first start: no `zn` lines in
  25 s means "logs off", and from then on only the server is the proof (the same as `--no-logs`). Then these are **not**
  checked: the exact check answer (`UPDATE` / `USE_LOCAL`), "no download" on a rollback (the server's `downloaded` count is
  used instead), "no screen" during the push (the activity check still works: it uses `dumpsys`, not logs), "marked
  healthy" and "no second download".
- **Which phone is yours.** The server's stats count phones per bundle, not by name. The proof "a phone is on bundle X"
  is exact for a bundle nobody else has (a new test bundle), and weak for the built-in bundle or when several phones
  use the channel.
- **Healthy and started events** reach the server with the phone's next check, so the suite waits up to 25 s for them.
- **The first healthy mark.** It waits for `safety: <id> is healthy` only the first time a bundle runs.

## Before you run it on the phone
- The phone: unlocked, one adb connection, the app installed (an app whose OTA state is older than the server's seq
  fails with `STALE_SEQ`: reinstall it).
- A local server: `bun run updates:server --port 8791 --dir <folder>`, `adb reverse tcp:8790 tcp:8791`, a debug (or
  `allowHttpInRelease`) app that talks to `http://127.0.0.1:8790`.
- Time: about 3 to 5 minutes without the push case, up to 3 more minutes with it.
