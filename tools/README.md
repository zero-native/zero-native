# @zeronative/cli

The `zn` command of [zero-native](https://github.com/zero-native/zero-native). Runs on [Bun](https://bun.sh).

```bash
bun add -d @zeronative/cli
```

From the app's folder:

| Command | What it does |
|---|---|
| `zn build <appDir> --name <app> --assets <dir>` | the app's JS bundle: templates, Hermes bytecode, `zn-bundle.json` |
| `zn dev [appDir] [--lan]` | live reload to debug builds: an Android phone over USB (`adb reverse`), the iOS simulator (no setup), and with `--lan` an iPhone on the same Wi-Fi (Bonjour; opt in, as anyone on the network can then fetch the app's code) |
| `zn builtin`, `zn release`, `zn store-build`, `zn status`, ... | OTA releases with a zn-updates server (`zn-updates.json` in the app) |
| `zn where` | the folder this `zn` runs from |

`zn new`, `zn ota` and `zn server` need a zero-native checkout for now. Hermes's bytecode compiler comes with it,
pinned to the Hermes version of the runtime, so the bytecode matches the app. In the repo, this folder also holds
the framework's own scripts; only the files listed in `package.json` are published. Apache-2.0.

## In the repo: test servers for an iPhone

An iPhone has no `adb reverse`, so these servers listen on every interface and print the Mac's LAN address. The
phone must be on the same Wi-Fi; a Debug build asks for Local Network access the first time, and the sample's
`NSAllowsLocalNetworking` allows plain http to a LAN address.

- Fetch and WebSocket labs: `bun run tools/fetch-test-server.ts` (`--host 127.0.0.1` keeps it on the Mac). Open
  `zn://sample/dev/fetch?host=<LAN address>` and `zn://sample/dev/websocket?host=<LAN address>`, then Run all.
- An OTA install (full zip, then a `znbsdiff1` patch): `bun run tools/ota/test-server.ts` starts a throwaway
  zn-updates on port 8796 with its own key pair, token and store in `/tmp/zn-ota-test` (never the sample's real key).
  `bun run tools/ota/test-server.ts release --mark one` builds the sample with that mark, uploads it and points
  staging at it; a second `release --mark two` is the patch. Launch a Debug build so it asks that server and trusts
  that key:

  ```bash
  DEVICECTL_CHILD_ZN_OTA_URL=http://<LAN address>:8796 DEVICECTL_CHILD_ZN_OTA_KEY="$(cat /tmp/zn-ota-test/test-key.pub)" \
    xcrun devicectl device process launch --terminate-existing --device <device id> dev.zeronative.sample
  ```

  (the simulator: `SIMCTL_CHILD_ZN_OTA_URL=http://localhost:8796 SIMCTL_CHILD_ZN_OTA_KEY=…` and
  `xcrun simctl launch`). Open `zn://sample/dev/updates`, Check now, then Apply now: "Running now" names the bundle and
  the console logs `ota-test mark <mark>` and `installed sample_2 (patch from sample_1, … KB)`. Launch it the same way
  each time: started from the home screen, the app asks localhost and trusts only the sample's own key.
