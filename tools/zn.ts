#!/usr/bin/env bun
// `zn`: one command for the zero-native tools, from any folder on this computer (2026-11-10).
// Each command runs the tool from this checkout, in the folder you are in.
//
// Two ways to have it:
//   - from npm: `@zeronative/cli` as a dev dependency of the app (this folder is the package; `zn new`, `zn ota` and
//     `zn server` need a zero-native checkout and say so);
//   - from a checkout, once per computer (from the zero-native root):  bun link  then  bun link zero-native -g
// Then from an app folder:
//   zn new <dir> [--name N] [--id ID] [--ios cmake|packages]   a new app outside this repo, from templates/app (tools/zn-new.ts)
//   zn dev [appDir] [--lan]    live reload to the phone or the iOS simulator (tools/zn-dev.ts); appDir defaults to this
//                              folder; --lan: also a real iPhone on the same Wi-Fi (Bonjour)
//   zn build <appDir> ...      build the app's JS bundle (tools/zn-build.ts)
//   zn release | builtin | store-build | dashboard | status | ...
//                              the zn-updates commands (tools/updates/cli.ts), same as `zn updates <command>`
//   zn updates <command> ...   the same, written in full
//   zn ota <command> ...       the older local OTA tool (tools/ota/cli.ts)
//   zn server [--demo]         a local zn-updates server (server/src/local.ts)
//   zn where                   print the zero-native folder this `zn` uses
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

// The CLI's own files sit next to this one (tools/ in a checkout, the package's folder from npm). The checkout's root
// is one up, and only a checkout has templates/app (zn new), tools/ota/cli.ts and server/.
const here = import.meta.dir
const root = resolve(here, "..")
const checkout = existsSync(join(root, "templates/app")) && existsSync(join(root, "server/src/local.ts"))
const tool = (path: string) => join(here, path)
const repoTool = (path: string, what: string) => {
  if (checkout) return join(root, path)
  console.error(`zn: ${what} needs a zero-native checkout (git clone https://github.com/zero-native/zero-native), then
run it from there: bun run tools/zn.ts ...`)
  process.exit(1)
}

// The zn-updates commands, so `zn release` works without `updates` in front (tools/updates/cli.ts, the `case` list).
const UPDATES = new Set([
  "login", "keygen", "app", "release", "publish", "rollout", "dashboard", "push", "kill", "delete", "keep", "stable", "unstable", "maps",
  "title", "builtin", "store-build", "base", "patches", "rule", "status", "public-key",
])

const [cmd, ...rest] = process.argv.slice(2)

function run(script: string, args: string[]): never {
  const p = Bun.spawnSync(["bun", "run", script, ...args], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  process.exit(p.exitCode ?? 1)
}

function help(): never {
  console.log(`zn: zero-native tools (from ${checkout ? root : here})

  zn new <dir> [--name N] [--id ID] [--ios cmake|packages]
                             start a new app outside this repo (iOS and Android hosts, two screens)
  zn dev [appDir] [--lan]    live reload to the phone or the iOS simulator; appDir defaults to this folder;
                             --lan: also a real iPhone on the same Wi-Fi
  zn build <appDir> ...      build the app's JS bundle
  zn release, zn builtin, zn store-build, zn dashboard, zn status, ...
                             zn-updates commands (also: zn updates <command>)
  zn ota <command> ...       the older local OTA tool
  zn server [--demo]         a local zn-updates server
  zn where                   the zero-native folder this zn uses`)
  process.exit(cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 1 : 0)
}

switch (cmd) {
  case "new":
    run(repoTool("tools/zn-new.ts", "zn new"), rest)
  case "dev": {
    // zn-dev.ts defaults to the sample app; from an app folder, the app is this folder (or its app/ folder, as in ZeroBill).
    const cwd = process.cwd()
    const appHere = existsSync(join(cwd, "src/main.ts")) ? [cwd] : existsSync(join(cwd, "app/src/main.ts")) ? [join(cwd, "app")] : []
    // Flags (--lan) don't name the app: without a folder named, it is still this one.
    run(tool("zn-dev.ts"), rest.some((a) => !a.startsWith("-")) ? rest : [...appHere, ...rest])
  }
  case "build":
    run(tool("zn-build.ts"), rest)
  case "updates":
    run(tool("updates/cli.ts"), rest)
  case "ota":
    run(repoTool("tools/ota/cli.ts", "zn ota"), rest)
  case "server":
    run(repoTool("server/src/local.ts", "zn server"), rest)
  case "where":
    console.log(checkout ? root : here)
    process.exit(0)
  default:
    if (cmd && UPDATES.has(cmd)) run(tool("updates/cli.ts"), [cmd, ...rest])
    if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") console.error(`zn: unknown command "${cmd}"\n`)
    help()
}
