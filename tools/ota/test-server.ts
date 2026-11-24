// A throwaway OTA update server for trying an install on the iOS simulator or an iPhone (docs/ota.md §3.5, "Trying
// it"), with its own key pair, store and admin token: never the sample's real signing key, never a real server.
//
//   bun run tools/ota/test-server.ts                      start it (port 8796, data in /tmp/zn-ota-test); keep it running
//   bun run tools/ota/test-server.ts release --mark two   build the sample with that mark, upload it, point staging at it
//
// Options: --port N (default 8796), --dir <folder> (default /tmp/zn-ota-test; the key pair, the server's data and the
// token stay there; delete the folder to start over).
//
// The first run makes a key pair (test-key.pem, test-key.pub), starts zn-updates (server/src/local.ts) on every
// interface with a random admin token, and creates the app "sample" trusting the test key. Each `release` builds the
// real sample JS plus one console line with the mark (`ota-test mark <mark>`), so each release is a new bundle; the
// server makes znbsdiff1 patches from the bundles before it. A phone running the first release gets the second as a
// patch; one running the built-in bundle (serial 0, not on this server) gets the full zip.
//
// The app (a Debug build; release builds ignore both) trusts the test key and asks this server when launched with:
//   simulator:  SIMCTL_CHILD_ZN_OTA_URL=http://localhost:8796 SIMCTL_CHILD_ZN_OTA_KEY="$(cat /tmp/zn-ota-test/test-key.pub)"
//               xcrun simctl launch --terminate-running-process "<your simulator>" dev.zeronative.sample
//   iPhone:     DEVICECTL_CHILD_ZN_OTA_URL=http://<the Mac's LAN address>:8796 DEVICECTL_CHILD_ZN_OTA_KEY="$(cat …)"
//               xcrun devicectl device process launch --terminate-existing --device <id> dev.zeronative.sample
// Then open /dev/updates (zn://sample/dev/updates): Check, then Apply. "Running now" names the bundle
// (sample_<serial>); the console says `zn-ota: … downloaded … patch from sample_1` or `full zip`. Start the app with
// the same environment each time: a start from the home screen trusts only the sample's own key.
// The build runs with HOME set to <dir>/home, so nothing is written to ~/.zero-native.
import { randomBytes } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { networkInterfaces } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { generateKeys, keyId } from "./signing"

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: { port: { type: "string" }, dir: { type: "string" }, mark: { type: "string" } },
})
const repo = resolve(import.meta.dir, "../..")
const port = Number(a.port ?? 8796)
const dir = resolve(a.dir ?? "/tmp/zn-ota-test")
const base = `http://127.0.0.1:${port}`
const appDir = join(dir, "app")
const home = join(dir, "home")
const files = { pem: join(dir, "test-key.pem"), pub: join(dir, "test-key.pub"), token: join(dir, "token") }

// The zn-updates this run started, stopped on any exit (a failure too) so port 8796 is free for the next run.
let server: ReturnType<typeof Bun.spawn> | undefined
process.on("exit", () => server?.kill())

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

/** `bun run updates …` against this server, with its token and key, and HOME inside [dir]. Returns its output. */
function updates(...args: string[]): string {
  const p = Bun.spawnSync(
    ["bun", "run", join(repo, "tools/updates/cli.ts"), ...args, "--app-dir", appDir, "--key", files.pem, "--by", "ota-test"],
    {
      cwd: repo,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOME: home, ZN_UPDATES_TOKEN: readFileSync(files.token, "utf8").trim() },
    },
  )
  const out = p.stdout.toString() + p.stderr.toString()
  if (p.exitCode !== 0) fail(`updates ${args[0]} failed:\n${out.trim()}`)
  return out
}

/** The app folder the release builds: its entry runs the sample's main.ts and logs the mark; the sample's own assets. */
function writeApp(mark: string) {
  mkdirSync(join(appDir, "src"), { recursive: true })
  rmSync(join(appDir, "assets"), { recursive: true, force: true })
  cpSync(join(repo, "examples/sample/assets"), join(appDir, "assets"), { recursive: true })
  writeFileSync(join(appDir, "src/main.ts"), [
    "// Made by tools/ota/test-server.ts: the sample, plus a line that makes each test release a new bundle.",
    `import ${JSON.stringify(join(repo, "examples/sample/src/main.ts"))}`,
    `console.info(${JSON.stringify(`ota-test mark ${mark}`)})`,
    "",
  ].join("\n"))
  writeFileSync(join(appDir, "zn-updates.json"), JSON.stringify({
    app: "sample",
    server: base,
    build: ["bun", "run", join(repo, "tools/zn-build.ts"), appDir, "--name", "sample"],
  }, null, 2))
}

async function serve() {
  mkdirSync(home, { recursive: true })
  if (!existsSync(files.pem)) {
    const k = generateKeys()
    writeFileSync(files.pem, k.privatePem, { mode: 0o600 })
    writeFileSync(files.pub, k.publicBase64)
    console.log(`made a test key pair in ${dir} (${keyId(k.publicBase64)})`)
  }
  if (!existsSync(files.token)) writeFileSync(files.token, randomBytes(24).toString("hex"), { mode: 0o600 })
  writeApp("built-in")
  // zn-updates on every interface (local.ts), its data in [dir]; the token is never printed.
  const child = Bun.spawn(["bun", "run", join(repo, "server/src/local.ts"), "--port", String(port), "--dir", join(dir, "server")], {
    cwd: repo,
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ADMIN_TOKEN: readFileSync(files.token, "utf8").trim() },
  })
  server = child
  process.on("SIGINT", () => process.exit(0))
  // Its log, without the lines that hold the token or a sign-in link.
  void (async () => {
    let rest = ""
    for await (const chunk of child.stdout) {
      const lines = (rest + new TextDecoder().decode(chunk)).split("\n")
      rest = lines.pop() ?? ""
      for (const l of lines) if (!/token|open\?code=|dashboard/i.test(l)) console.log(`  server: ${l}`)
    }
  })()
  let healthy = false
  for (let i = 0; i < 100 && !healthy; i++) {
    healthy = await fetch(`${base}/health`).then((r) => r.ok, () => false)
    if (!healthy) await Bun.sleep(200)
  }
  if (!healthy) fail(`zn-updates did not answer ${base}/health within 20 s (is port ${port} in use?)`)
  updates("app", "--keys", readFileSync(files.pub, "utf8").trim(), "--name", "Sample (OTA test)")
  const lan = Object.values(networkInterfaces()).flat().filter((x) => x && x.family === "IPv4" && !x.internal).map((x) => x!.address)
  console.log(`OTA test server at ${base} (store and key in ${dir})`)
  console.log(`  simulator: SIMCTL_CHILD_ZN_OTA_URL=http://localhost:${port} SIMCTL_CHILD_ZN_OTA_KEY="$(cat ${files.pub})"`)
  for (const ip of lan) console.log(`  iPhone:    DEVICECTL_CHILD_ZN_OTA_URL=http://${ip}:${port} DEVICECTL_CHILD_ZN_OTA_KEY="$(cat ${files.pub})"`)
  console.log(`  a release: bun run tools/ota/test-server.ts release --mark one${a.dir ? ` --dir ${dir}` : ""}${a.port ? ` --port ${port}` : ""}`)
  await child.exited
}

function release() {
  if (!existsSync(files.token)) fail(`no test server data in ${dir}: start it first (bun run tools/ota/test-server.ts)`)
  const mark = a.mark ?? fail("--mark <text>: what this release logs at start (ota-test mark <text>)")
  writeApp(mark)
  const out = updates("release")
  const serial = /uploaded #(\d+)/.exec(out)?.[1] ?? /same bytes as #(\d+)/.exec(out)?.[1]
  if (!serial) fail(`no bundle number in:\n${out}`)
  console.log(out.split("\n").filter((l) => l.startsWith("✓")).join("\n"))
  console.log(updates("publish", "--channel", "staging", "--bundle", serial).trim())
}

if (positionals[0] === "release") release()
else if (positionals.length === 0) await serve()
else fail(`unknown command ${positionals[0]}: none (start the server) or release --mark <text>`)
