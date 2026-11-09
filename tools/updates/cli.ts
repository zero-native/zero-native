// `bun run updates …`: the release command for zn-updates (docs/zn-updates-server.md). It builds on this computer,
// signs with the key on this computer, and talks to the server. The dashboard does every channel / rule action too;
// builds (an OTA bundle, a store build's built-in bundle) run only here.
//
//   bun run updates login --server https://appupdates.example.com --token <ADMIN_TOKEN> --by Pavan
//   bun run updates keygen [--name main|backup]          a signing key pair (private key in ~/.zero-native/keys)
//   bun run updates app --keys <main.pub>,<backup.pub> [--name "ZeroBill"] [--store '<json>']   create / update the app
//   bun run updates release                              build the app's JS, upload it as a new bundle (never publishes)
//   bun run updates publish --channel staging --bundle 12 [--rollout 100] [--priority high|critical] [--reason "…"]
//       priority: normal = next start (default), high = may update at the splash, critical = update now
//   bun run updates stable --bundle 12 [--note "checked login + pay on the Lava"]
//   bun run updates publish --channel production --bundle 12 --rollout 5        (asks to type PRODUCTION #12)
//   bun run updates rollout --channel production --percent 50
//   bun run updates kill --channel production --reason "…"                     (asks to type KILL PRODUCTION)
//   bun run updates store-build --os android --channel production --label "production AAB" --version-code 170 --version-name 1.7.0
//       builds the JS once (serial 0) to learn its SHA-256, takes the serial for those bytes (the same JS, from an OTA
//       release or an earlier store build, gets the same number), builds the built-in bundle into the host's assets with
//       it, records the store build, and uploads the built-in bundle as the base for OTA patches; then build the AAB / IPA as usual
//   bun run updates base --serial 14                     uploads the base for an older store build (from the assets folder;
//       the folder must hold that build's built-in bundle: the SHA-256 must match)
//   bun run updates patches --bundle 12                  makes the patches of a bundle again and prints them
//   bun run updates rule --os android --version 170 --critical 2 [--channel production] [--test] [--title …] [--message …]
//       (a rule is for one channel, default production; forced asks FORCE UPDATE 170; saving it sends the "check now" push)
//   bun run updates push --channel staging                                       ("check now" push to the channel's phones)
//   bun run updates dashboard [--print]                                         (opens the dashboard, signed in, for 12 h)
//   bun run updates status
//
// Options: --app-dir <dir> (default: the current folder; holds zn-updates.json), --key <private key PEM>,
// --confirm "<text>" (for scripts). Settings come from <app-dir>/zn-updates.json:
//   { "app": "zerobill", "server": "https://appupdates.example.com",
//     "build": ["bun", "run", "../../Futuristic/zero-native/tools/zn-build.ts", "app", "--name", "zerobill"],
//     "assets": "android/app/src/main/assets" }
// The token comes from `login` (~/.zero-native/updates.json) or ZN_UPDATES_TOKEN; who you are from --by / ZN_UPDATES_BY.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { readBundleInfo } from "../bundle-info"
import { BUILT_IN, generateKeys, keyId, publicKeyOf } from "../ota/signing"
import { PRIORITIES, type Priority } from "../ota/core"
import { type Conn, type PatchInfo, type PushResult, call, changeChannel, remakePatches, uploadBase, uploadBuilt } from "./client"

/** Opens [url] in the default browser. False when there is no way to (then the CLI prints it). */
function openInBrowser(url: string): boolean {
  // Windows: rundll32 hands the URL to the browser as is (cmd's `start` would read & and ^ in it as commands)
  const cmd = process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url]
  try {
    return Bun.spawnSync(cmd, { stdout: "ignore", stderr: "ignore" }).exitCode === 0
  } catch {
    return false
  }
}

/** One line about the "check now" push the server sent after a change. */
/** [what]: "bundle" (a channel change: phones download, it runs from their next start) or "rule" (a store rule). */
function pushNote(p: PushResult | null | undefined, what: "bundle" | "rule" = "bundle") {
  if (!p) return
  const after = what === "rule" ? "the app shows the store update after that check" : "only downloads; it runs from their next start"
  if (p.sent) console.log(`  push → ${p.topic}: phones check within ${Math.round((p.delayMs ?? 0) / 1000)} s (${after})`)
  else console.log(`  no push to ${p.topic}: ${p.error ?? "not sent"} (phones still find it at their next check)`)
}

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "app-dir": { type: "string" },
    key: { type: "string" },
    server: { type: "string" },
    token: { type: "string" },
    by: { type: "string" },
    name: { type: "string" },
    keys: { type: "string" },
    store: { type: "string" },
    push: { type: "string" },
    channel: { type: "string" },
    bundle: { type: "string" },
    rollout: { type: "string" },
    percent: { type: "string" },
    priority: { type: "string" },
    reason: { type: "string" },
    confirm: { type: "string" },
    note: { type: "string" },
    title: { type: "string" },
    message: { type: "string" },
    os: { type: "string" },
    label: { type: "string" },
    "version-code": { type: "string" },
    "version-name": { type: "string" },
    version: { type: "string" },
    serial: { type: "string" },
    critical: { type: "string" },
    test: { type: "boolean" },
    print: { type: "boolean" },
  },
})
const command = positionals[0]
const home = join(homedir(), ".zero-native")
const keysDir = join(home, "keys")
const loginFile = join(home, "updates.json")
const appDir = resolve(a["app-dir"] ?? process.cwd())
const repoRoot = resolve(import.meta.dir, "..", "..")

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

interface AppConfig {
  app: string
  server: string
  build?: string[]
  assets?: string
}

function config(): AppConfig {
  const file = join(appDir, "zn-updates.json")
  if (!existsSync(file)) fail(`no zn-updates.json in ${appDir} (pass --app-dir, or create it: see the top of tools/updates/cli.ts)`)
  const c = JSON.parse(readFileSync(file, "utf8")) as AppConfig
  if (!c.app || !c.server) fail(`${file} needs "app" and "server"`)
  return c
}

function conn(server?: string): Conn {
  const saved = existsSync(loginFile) ? (JSON.parse(readFileSync(loginFile, "utf8")) as Record<string, { token: string; by: string }>) : {}
  const s = (a.server ?? server ?? "").replace(/\/+$/, "")
  const login = saved[s]
  const token = a.token ?? process.env.ZN_UPDATES_TOKEN ?? login?.token
  if (!token) fail(`not signed in to ${s}: run \`bun run updates login --server ${s} --token <ADMIN_TOKEN> --by <your name>\``)
  return { server: s, token, by: a.by ?? process.env.ZN_UPDATES_BY ?? login?.by ?? "unknown" }
}

function privateKey(app: string): string {
  const path = a.key ?? process.env.ZN_UPDATES_KEY ?? join(keysDir, `${app}-main.pem`)
  if (!existsSync(path)) fail(`no private key at ${path}: run \`bun run updates keygen\` or pass --key`)
  if (resolve(path).toLowerCase().startsWith(repoRoot.toLowerCase())) fail(`the private key ${path} is inside the repo; keep it outside (${keysDir})`)
  return readFileSync(path, "utf8")
}

function confirmation(expected: string): string | undefined {
  if (a.confirm !== undefined) return a.confirm
  if (!process.stdin.isTTY) return undefined
  return prompt(`Type "${expected}" to go ahead:`) ?? undefined
}

function git(dir: string) {
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir }).stdout.toString().trim()
  return { commit: run(["rev-parse", "--short=10", "HEAD"]) || "unknown", dirty: run(["status", "--porcelain"]).length > 0, subject: run(["log", "-1", "--format=%s"]) }
}

/** Runs the app's build into [out] with [serial]; the source map goes to [map]. */
function build(c: AppConfig, out: string, serial: number, map: string) {
  if (!c.build?.length) fail(`zn-updates.json has no "build" command`)
  console.log(`… building ${c.app} (${c.build.join(" ")})`)
  const p = Bun.spawnSync([...c.build, "--out", out, "--serial", String(serial), "--map", map], { cwd: appDir, stdout: "inherit", stderr: "inherit" })
  if (p.exitCode !== 0) fail("the build failed")
}

/** Source maps stay on this computer, by bundle SHA (a stack trace from a phone names the SHA). */
function keepMap(app: string, sha: string, mapFile: string) {
  if (!existsSync(mapFile)) return
  const dir = join(home, "maps", app)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sha}.map`), readFileSync(mapFile))
}

function channelArg(): string {
  if (!a.channel) fail("--channel staging|production")
  return a.channel
}

/** --priority: normal (default), high or critical. */
function priorityArg(): Priority {
  if (a.priority === undefined) return "normal"
  if (!PRIORITIES.includes(a.priority as Priority)) fail("--priority is normal, high or critical")
  return a.priority as Priority
}

/** "from #11 (bundle) 3 KB (0.4 % of the full 824 KB zip)": one patch in words. */
function patchLine(p: PatchInfo, fullSize: number, bundleSerials: Set<number>): string {
  const serial = Number(p.fromId.slice(p.fromId.lastIndexOf("_") + 1))
  const kind = bundleSerials.has(serial) ? "bundle" : "built-in"
  return `from #${serial} (${kind}) ${(p.size / 1024).toFixed(1)} KB, ${((p.size / fullSize) * 100).toFixed(1)} % of the full ${Math.round(fullSize / 1024)} KB zip`
}

function rolloutArg(channel: string, value = a.rollout): number {
  if (value === undefined) {
    if (channel === "production") fail("production needs an explicit --rollout (1–100): start small")
    return 100
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 100) fail("--rollout is 1–100")
  return n
}

async function main() {
  switch (command) {
    case "login": {
      if (!a.server || !a.token) fail("login --server <url> --token <ADMIN_TOKEN> --by <your name>")
      const c: Conn = { server: a.server.replace(/\/+$/, ""), token: a.token, by: a.by ?? "unknown" }
      const env = await call<{ version: string; database: string }>(c, "GET", "/admin/env")
      mkdirSync(home, { recursive: true })
      const saved = existsSync(loginFile) ? JSON.parse(readFileSync(loginFile, "utf8")) : {}
      saved[c.server] = { token: c.token, by: c.by }
      writeFileSync(loginFile, JSON.stringify(saved, null, 2), { mode: 0o600 })
      console.log(`✓ signed in to ${c.server} (zn-updates ${env.version}, ${env.database}) as ${c.by}`)
      return
    }
    case "keygen": {
      const c = config()
      const name = a.name ?? "main"
      if (name !== "main" && name !== "backup") fail("--name is main or backup")
      const file = join(keysDir, `${c.app}-${name}.pem`)
      if (existsSync(file)) fail(`${file} exists; keys are never replaced by accident (move it away first)`)
      mkdirSync(keysDir, { recursive: true })
      const k = generateKeys()
      writeFileSync(file, k.privatePem, { mode: 0o600 })
      console.log(`✓ private key: ${file}  (keep it secret${name === "backup" ? "; move it offline after you note its public key" : ""})`)
      console.log(`  public key (${keyId(k.publicBase64)}): ${k.publicBase64}`)
      return
    }
    case "app": {
      const c = config()
      const keys = a.keys?.split(",").map((k) => k.trim()).filter(Boolean)
      const store = a.store ? (JSON.parse(a.store) as Record<string, unknown>) : undefined
      // --push '{"fcmProject":"my-firebase-project","delayMs":{"staging":3000,"production":21600000}}'
      const push = a.push ? (JSON.parse(a.push) as Record<string, unknown>) : undefined
      const saved = await call(conn(c.server), "POST", "/admin/apps", { id: c.app, name: a.name, publicKeys: keys, store, push })
      console.log(`✓ ${c.app}: ${JSON.stringify(saved)}`)
      return
    }
    case "release": {
      const c = config()
      const pem = privateKey(c.app)
      const g = git(appDir)
      const work = mkdtempSync(join(tmpdir(), "zn-updates-build-"))
      try {
        const out = join(work, "bundle")
        const map = join(work, "main.js.map")
        build(c, out, 0, map)
        const info = readBundleInfo(out)
        if (info.app !== c.app) fail(`the build is for app "${info.app}", zn-updates.json says "${c.app}"`)
        keepMap(c.app, info.sha256, map)
        const r = await uploadBuilt(conn(c.server), out, pem, g)
        const m = r.manifest
        if (r.reused) console.log(`✓ same bytes as #${m.serial} (${m.id}): nothing new`)
        else console.log(`✓ uploaded #${m.serial} (${m.id}), zip ${Math.round(m.zip.size / 1024)} KB${g.dirty ? ", from uncommitted changes (staging only)" : ""}`)
        console.log(`  next: bun run updates publish --channel staging --bundle ${m.serial}`)
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
      return
    }
    case "publish": {
      const c = config()
      const channel = channelArg()
      if (!a.bundle) fail("--bundle <serial>")
      const rollout = rolloutArg(channel)
      const serial = Number(a.bundle)
      const confirm = channel === "production" ? confirmation(`PRODUCTION #${serial}`) : undefined
      const r = await changeChannel(conn(c.server), privateKey(c.app), {
        app: c.app, channel, target: serial, rollout, priority: priorityArg(), reason: a.reason, confirm,
      })
      console.log(`✓ ${channel} → #${serial} at ${rollout} % (${r.kind}, seq ${r.pointer.seq})`)
      pushNote(r.push)
      return
    }
    case "rollout": {
      const c = config()
      const channel = channelArg()
      const cc = conn(c.server)
      const st = await call<{ channels: { name: string; current: { pointer: { target: string; priority: Priority } } | null }[] }>(cc, "GET", `/admin/apps/${c.app}/state`)
      const now = st.channels.find((x) => x.name === channel)?.current?.pointer
      if (!now || now.target === BUILT_IN) fail(`${channel} serves no bundle to roll out`)
      const rollout = rolloutArg(channel, a.percent ?? a.rollout)
      const r = await changeChannel(cc, privateKey(c.app), { app: c.app, channel, target: now.target, rollout, priority: now.priority, reason: a.reason })
      console.log(`✓ ${channel} ${now.target} now at ${rollout} % (seq ${r.pointer.seq})`)
      pushNote(r.push)
      return
    }
    case "dashboard": {
      // The token never goes to the browser: the server gives a one-time code (60 s), the browser trades it for a
      // session cookie (12 h). Without a session the dashboard's address shows nothing.
      const c = config()
      const cc = conn(c.server)
      const r = await call<{ code: string; expiresInSeconds: number }>(cc, "POST", "/admin/login-links")
      const link = `${cc.server}/open?code=${r.code}#/overview?app=${encodeURIComponent(c.app)}`
      if (a.print || !openInBrowser(link)) {
        console.log(`Open this link within ${r.expiresInSeconds} s (it works once):
  ${link}`)
      } else {
        console.log(`✓ opening the dashboard for ${c.app} as ${cc.by} (the link works once, for ${r.expiresInSeconds} s; the session lasts 12 h)`)
      }
      return
    }
    case "push": {
      const c = config()
      const channel = channelArg()
      pushNote(await call<PushResult>(conn(c.server), "POST", `/admin/apps/${c.app}/channels/${channel}/push`))
      return
    }
    case "kill": {
      const c = config()
      const channel = channelArg()
      const confirm = confirmation(`KILL ${channel.toUpperCase()}`)
      const r = await changeChannel(conn(c.server), privateKey(c.app), { app: c.app, channel, target: BUILT_IN, rollout: 100, priority: "critical", reason: a.reason, confirm })
      console.log(`✓ ${channel}: kill switch on (seq ${r.pointer.seq}); phones go back to their built-in bundle. Publish a bundle to end it.`)
      pushNote(r.push)
      return
    }
    case "stable":
    case "unstable": {
      const c = config()
      if (!a.bundle) fail("--bundle <serial>")
      await call(conn(c.server), "POST", `/admin/apps/${c.app}/bundles/${Number(a.bundle)}/stable`, { on: command === "stable", note: a.note })
      console.log(`✓ #${a.bundle} ${command === "stable" ? "marked stable" : "no longer stable"}`)
      return
    }
    case "title": {
      const c = config()
      if (!a.bundle) fail("--bundle <serial> --title <text>")
      await call(conn(c.server), "POST", `/admin/apps/${c.app}/bundles/${Number(a.bundle)}/title`, { title: a.title ?? "" })
      console.log(`✓ #${a.bundle} title: ${a.title ? `"${a.title}"` : "none (a silent fix)"}`)
      return
    }
    case "store-build": {
      const c = config()
      const os = a.os ?? "android"
      const channel = channelArg()
      const versionCode = Number(a["version-code"])
      const versionName = a["version-name"] ?? ""
      if (!Number.isInteger(versionCode) || versionCode <= 0 || !versionName) fail("--version-code <n> --version-name <x.y.z>")
      if (!c.assets) fail(`zn-updates.json has no "assets" (the host's assets folder, e.g. android/app/src/main/assets)`)
      const g = git(appDir)
      if (channel === "production" && g.dirty) fail("a production store build needs a clean working tree (commit first)")
      const cc = conn(c.server)
      const work = mkdtempSync(join(tmpdir(), "zn-updates-store-"))
      try {
        const map = join(work, "main.js.map")
        // The store build's own --assets (if the build command has one) is for the host's folder: we set it ourselves.
        const buildHere = { ...c, build: [...c.build!.filter((x, i, l) => !(x === "--assets" || l[i - 1] === "--assets"))] }
        // One bundle = one serial: build once with serial 0 (as `release` does) to learn the bytes, then take the serial for them.
        const probe = join(work, "probe")
        build(buildHere, probe, 0, join(work, "probe.js.map"))
        const probed = readBundleInfo(probe)
        if (probed.app !== c.app) fail(`the build is for app "${probed.app}", zn-updates.json says "${c.app}"`)
        if (!probed.requires) fail("the build's zn-bundle.json has no requires (rebuild with the current tools)")
        const reserved = await call<{ serial: number; existing: unknown }>(cc, "POST", `/admin/apps/${c.app}/serials`, {
          kind: "store",
          sha256: probed.sha256,
          requires: probed.requires,
        })
        const serial = reserved.serial
        if (reserved.existing) console.log(`  same bytes as the OTA bundle #${serial}: the store build gets that number`)
        // The build writes straight into the host's assets with the serial.
        build(buildHere, resolve(appDir, c.assets), serial, map)
        const info = readBundleInfo(resolve(appDir, c.assets))
        if (info.serial !== serial) fail(`the built-in bundle has serial ${info.serial}, expected ${serial}`)
        // The bundle's SHA-256 covers the file list only, never the serial: it must not change. If it did, a file holds the serial.
        if (info.sha256 !== probed.sha256) {
          fail(`the build with serial ${serial} has another bundle SHA-256 (${info.sha256.slice(0, 12)}) than the build with serial 0 (${probed.sha256.slice(0, 12)}): some file changed between the two builds (does the JS use the serial or the time?). Serial ${serial} is taken for the first bytes: run the command again after fixing it.`)
        }
        keepMap(c.app, info.sha256, map)
        await call(cc, "POST", `/admin/apps/${c.app}/store-builds`, {
          os, channel, label: a.label ?? `${channel} ${os === "ios" ? "IPA" : "AAB"}`, versionCode, versionName,
          builtinSerial: serial, builtinSha256: info.sha256, git: { commit: g.commit, dirty: g.dirty },
        })
        console.log(`✓ store build ${versionName} (${versionCode}) for ${channel}: built-in bundle #${serial} (${info.id}) is in ${c.assets}`)
        // The built-in bundle is a base for patches: phones on this build then get small OTA downloads.
        try {
          const base = await uploadBase(cc, c.app, serial, resolve(appDir, c.assets))
          console.log(`✓ base for patches uploaded (${Math.round(base.size / 1024)} KB)`)
        } catch (e) {
          fail(`the store build is recorded, but its base for patches was not uploaded: ${(e as Error).message}\n  Run \`bun run updates base --serial ${serial}\` before you change the assets folder.`)
        }
        console.log(`  now build the ${os === "ios" ? "IPA" : "AAB"} as usual. Its family shows on the dashboard after the first phone checks.`)
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
      return
    }
    case "base": {
      // The base for an older store build: the assets folder must still hold that build's built-in bundle.
      const c = config()
      const serial = Number(a.serial)
      if (!Number.isInteger(serial) || serial < 1) fail("base --serial <the store build's built-in serial>")
      if (!c.assets) fail(`zn-updates.json has no "assets" (the host's assets folder, e.g. android/app/src/main/assets)`)
      const dir = resolve(appDir, c.assets)
      const cc = conn(c.server)
      const st = await call<{ storeBuilds: { builtinSerial: number; builtinSha256: string; label: string; baseSize: number | null }[] }>(cc, "GET", `/admin/apps/${c.app}/state`)
      const build = st.storeBuilds.find((b) => b.builtinSerial === serial)
      if (!build) fail(`no store build with built-in serial #${serial}`)
      const info = readBundleInfo(dir)
      if (info.sha256 !== build.builtinSha256) {
        fail(`${c.assets} holds bundle ${info.sha256.slice(0, 12)} (#${info.serial}), the store build "${build.label}" has ${build.builtinSha256.slice(0, 12)}: check out that build's code and build it again, or point --app-dir at the right folder`)
      }
      const r = await uploadBase(cc, c.app, serial, dir)
      console.log(`✓ base for store build #${serial} ("${build.label}") uploaded (${Math.round(r.size / 1024)} KB)${build.baseSize ? " (it had one: replaced)" : ""}`)
      console.log(`  Patches use it for bundles made after it. To use it for an older one: bun run updates patches --bundle <n>`)
      return
    }
    case "patches": {
      const c = config()
      if (!a.bundle) fail("patches --bundle <serial>")
      const serial = Number(a.bundle)
      const cc = conn(c.server)
      const r = await remakePatches(cc, c.app, serial)
      const st = await call<{ bundles: { serial: number; manifest: { zip: { size: number } } }[] }>(cc, "GET", `/admin/apps/${c.app}/state`)
      const full = st.bundles.find((b) => b.serial === serial)?.manifest.zip.size ?? 1
      const serials = new Set(st.bundles.map((b) => b.serial))
      console.log(`✓ patches for #${serial}: ${r.patches.length} kept (${r.result.made.length} made now, ${r.result.tooBig.length} too big, ${r.result.failed.length} failed)`)
      for (const p of r.patches) console.log(`  ${patchLine(p, full, serials)}`)
      for (const t of r.result.tooBig) console.log(`  not kept: from ${t.from}, ${(t.size / 1024).toFixed(1)} KB is 60 % or more of the full zip`)
      for (const f of r.result.failed) console.log(`  ✗ from ${f.from}: ${f.error}`)
      return
    }
    case "rule": {
      const c = config()
      const os = a.os ?? "android"
      if (!a.version || a.critical === undefined) fail("rule --os android|ios --version <v> --critical 0|1|2 [--channel production] [--test]")
      const critical = Number(a.critical)
      const channel = a.channel ?? "production"
      const confirm = critical === 2 && !a.test ? confirmation(`FORCE UPDATE ${a.version}`) : undefined
      const r = await call<{ push: PushResult | null }>(conn(c.server), "POST", `/admin/apps/${c.app}/store-rules`, {
        os, channel, version: os === "ios" ? a.version : Number(a.version), critical, isTest: !!a.test, title: a.title, message: a.message, note: a.note, confirm,
      })
      console.log(`✓ ${os} ${a.version} on ${channel}: ${["no update", "optional update", "forced update"][critical]}${a.test ? " (test version)" : ""}`)
      pushNote(r.push, "rule")
      return
    }
    case "status": {
      const c = config()
      const st = await call<{
        channels: { name: string; current: { pointer: { target: string; rollout: number; seq: number; priority: Priority }; kind: string; at: string } | null }[]
        bundles: { serial: number; gitSubject: string; stableAt: string | null; liveOn: string[]; manifest: { zip: { size: number } }; patches: PatchInfo[] }[]
      }>(conn(c.server), "GET", `/admin/apps/${c.app}/state`)
      for (const ch of st.channels) {
        const p = ch.current?.pointer
        console.log(`${ch.name.padEnd(11)} ${p ? `${p.target === BUILT_IN ? "KILL SWITCH" : p.target} at ${p.rollout} % (seq ${p.seq}, ${ch.current!.kind}${p.priority !== "normal" ? `, ${p.priority} priority` : ""})` : "nothing published"}`)
      }
      const serials = new Set(st.bundles.map((b) => b.serial))
      for (const b of st.bundles.slice(0, 10)) {
        console.log(`  #${String(b.serial).padEnd(4)} ${b.stableAt ? "stable " : "       "}${b.liveOn.join(",").padEnd(19)} ${b.gitSubject}`)
        for (const p of b.patches ?? []) console.log(`        patch ${patchLine(p, b.manifest.zip.size, serials)}`)
      }
      return
    }
    case "public-key": {
      const c = config()
      const pk = publicKeyOf(privateKey(c.app))
      console.log(`${keyId(pk)} ${pk}`)
      return
    }
    default:
      fail(`unknown command "${command ?? ""}". Commands: login, keygen, app, release, publish, stable, unstable, title, rollout, kill, store-build, base, patches, rule, status, public-key`)
  }
}

await main()
