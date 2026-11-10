#!/usr/bin/env bun
// `zn`: one command for the zero-native tools, from any folder on this computer (2026-11-10).
// Each command runs the tool from this checkout, in the folder you are in.
//
// Set up once (from the zero-native root):  bun link  then  bun link zero-native -g
// Then from an app folder:
//   zn dev [appDir]            live reload to the phone (tools/zn-dev.ts); appDir defaults to this folder
//   zn build <appDir> ...      build the app's JS bundle (tools/zn-build.ts)
//   zn release | builtin | store-build | dashboard | status | ...
//                              the zn-updates commands (tools/updates/cli.ts), same as `zn updates <command>`
//   zn updates <command> ...   the same, written in full
//   zn ota <command> ...       the older local OTA tool (tools/ota/cli.ts)
//   zn server [--demo]         a local zn-updates server (server/src/local.ts)
//   zn where                   print the zero-native folder this `zn` uses
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const tool = (path: string) => join(root, path)

// The zn-updates commands, so `zn release` works without `updates` in front (tools/updates/cli.ts, the `case` list).
const UPDATES = new Set([
  "login", "keygen", "app", "release", "publish", "rollout", "dashboard", "push", "kill", "stable", "unstable", "maps",
  "title", "builtin", "store-build", "base", "patches", "rule", "status", "public-key",
])

const [cmd, ...rest] = process.argv.slice(2)

function run(script: string, args: string[]): never {
  const p = Bun.spawnSync(["bun", "run", tool(script), ...args], { cwd: process.cwd(), stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  process.exit(p.exitCode ?? 1)
}

function help(): never {
  console.log(`zn: zero-native tools (from ${root})

  zn dev [appDir]            live reload to the phone; appDir defaults to this folder
  zn build <appDir> ...      build the app's JS bundle
  zn release, zn builtin, zn store-build, zn dashboard, zn status, ...
                             zn-updates commands (also: zn updates <command>)
  zn ota <command> ...       the older local OTA tool
  zn server [--demo]         a local zn-updates server
  zn where                   the zero-native folder this zn uses`)
  process.exit(cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h" ? 1 : 0)
}

switch (cmd) {
  case "dev": {
    // zn-dev.ts defaults to the sample app; from an app folder, the app is this folder (or its app/ folder, as in ZeroBill).
    const cwd = process.cwd()
    const here = existsSync(join(cwd, "src/main.ts")) ? [cwd] : existsSync(join(cwd, "app/src/main.ts")) ? [join(cwd, "app")] : []
    run("tools/zn-dev.ts", rest.length ? rest : here)
  }
  case "build":
    run("tools/zn-build.ts", rest)
  case "updates":
    run("tools/updates/cli.ts", rest)
  case "ota":
    run("tools/ota/cli.ts", rest)
  case "server":
    run("server/src/local.ts", rest)
  case "where":
    console.log(root)
    process.exit(0)
  default:
    if (cmd && UPDATES.has(cmd)) run("tools/updates/cli.ts", [cmd, ...rest])
    if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") console.error(`zn: unknown command "${cmd}"\n`)
    help()
}
