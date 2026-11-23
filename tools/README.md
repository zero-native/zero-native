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
