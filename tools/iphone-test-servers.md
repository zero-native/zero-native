# Test servers for an iPhone

For the sample app in this repo (not part of the published `@zeronative/cli`). An iPhone has no `adb reverse`, so
these servers listen on every interface and print the Mac's LAN address. The phone must be on the same Wi-Fi; a
Debug build asks for Local Network access the first time, and the sample's `NSAllowsLocalNetworking` allows plain
http to a LAN address.

- Fetch and WebSocket labs: `bun run tools/fetch-test-server.ts` (`--host 127.0.0.1` keeps it on the Mac). Open
  `zn://sample/dev/fetch?host=<LAN address>` and `zn://sample/dev/websocket?host=<LAN address>`, then Run all
  (`host=<Mac>.local` works too: the other-host redirect then goes to the LAN address). The five FormData file cases read the lab files
  from a Mac folder (`--files`), so on a phone they say "skipped"; they run on the simulator.
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

  The app's `ZN_OTA_KEY` is the test server's public key (base64). `tools/ota/cli.ts` reads a `ZN_OTA_KEY` too, as
  the path of a private key: so set the app's only with the `SIMCTL_CHILD_` / `DEVICECTL_CHILD_` prefix, never
  exported in the shell.
