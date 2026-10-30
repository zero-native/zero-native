// zn ota: the release CLI (docs/ota.md §4 step 4.3). Every rule lives in core.ts; this file reads arguments and the
// app's zn-ota.json, takes the lock (one release action at a time on this computer), and asks for typed confirmations.
//
//   bun run ota keygen  [--name main|backup]                  make a signing key pair (private key outside the repo)
//   bun run ota build                                          build the app and release the bundle (never publishes)
//   bun run ota publish --channel staging --bundle 12          point a channel at a bundle (also: roll back)
//   bun run ota stable  --bundle 12                            mark it stable after testing it on staging
//   bun run ota publish --channel production --bundle 12 --rollout 10      (asks to type PRODUCTION #12)
//   bun run ota rollout --channel production --percent 50
//   bun run ota kill    --channel production --reason "..."    (asks to type KILL PRODUCTION)
//   bun run ota status                                         channels, bundles, and what phones reported (7 days)
//   bun run ota verify                                         check every signature and zip in the store
//   bun run ota serve   [--port 8790] [--host 127.0.0.1]       the reference update server over the local store
//
// Common options: --app-dir <dir> (default examples/sample; holds zn-ota.json), --key <private key PEM file>,
// --confirm "<text>" (for scripts; otherwise you are asked).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import * as core from "./core"
import { generateKeys, keyId, publicKeyOf } from "./signing"
import { startServer } from "./server"
import { LocalStore, type Store } from "./store"

/** An app's release settings: `zn-ota.json` next to its sources. Paths are relative to that file. */
interface AppConfig {
  app: string
  /** The build command; the CLI adds `--out <dir> --serial 0`. Runs in the app's folder. */
  build: string[]
  /** The store: a local folder now (GCS and others come as adapters). */
  store: string
  /** The private key; default ~/.zero-native/keys/<app>-main.pem (or ZN_OTA_KEY). Never inside the repo. */
  key?: string
  /** The public keys the app trusts (base64 SPKI): main first, backup second. Used by `verify`. */
  publicKeys?: string[]
}

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "app-dir": { type: "string" },
    key: { type: "string" },
    name: { type: "string" },
    channel: { type: "string" },
    bundle: { type: "string" },
    rollout: { type: "string" },
    percent: { type: "string" },
    priority: { type: "string" },
    confirm: { type: "string" },
    reason: { type: "string" },
    port: { type: "string" },
    host: { type: "string" },
    data: { type: "string" },
  },
})
const command = positionals[0]
const root = resolve(import.meta.dir, "../..")
const appDir = resolve(root, a["app-dir"] ?? "examples/sample")
const keysDir = join(homedir(), ".zero-native", "keys")

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function config(): AppConfig {
  const f = join(appDir, "zn-ota.json")
  if (!existsSync(f)) fail(`no zn-ota.json in ${appDir}`)
  return JSON.parse(readFileSync(f, "utf8")) as AppConfig
}

function store(c: AppConfig): Store {
  if (/^[a-z]+:\/\//.test(c.store)) fail(`store "${c.store}": only local folders are supported so far`)
  return new LocalStore(resolve(appDir, c.store))
}

function privateKey(c: AppConfig): string {
  const path = a.key ?? process.env.ZN_OTA_KEY ?? c.key ?? join(keysDir, `${c.app}-main.pem`)
  if (!existsSync(path)) fail(`no private key at ${path}: run \`bun run ota keygen\` or pass --key`)
  if (resolve(path).startsWith(root + "\\") || resolve(path).startsWith(root + "/")) {
    fail(`the private key ${path} is inside the repo; keep it outside (default ${keysDir})`)
  }
  return readFileSync(path, "utf8")
}

/** Asks for a typed confirmation unless --confirm gave one. */
function confirmation(expected: string): string | undefined {
  if (a.confirm !== undefined) return a.confirm
  if (!process.stdin.isTTY) return undefined
  return prompt(`Type "${expected}" to go ahead:`) ?? undefined
}

/** One release action at a time on this computer (two terminals can't race for a serial or a seq). */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = join(homedir(), ".zero-native", "ota.lock")
  mkdirSync(dirname(lock), { recursive: true })
  try {
    writeFileSync(lock, String(process.pid), { flag: "wx" })
  } catch {
    const ageMin = Math.round((Date.now() - statSync(lock).mtimeMs) / 60000)
    fail(`another release action holds ${lock} (${ageMin} min old). If none is running, delete that file.`)
  }
  return fn().finally(() => unlinkSync(lock))
}

function git(): { commit: string; dirty: boolean } {
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root }).stdout.toString().trim()
  return { commit: run(["rev-parse", "HEAD"]) || "unknown", dirty: run(["status", "--porcelain"]).length > 0 }
}

async function main() {
  switch (command) {
    case "keygen": {
      const c = config()
      const name = a.name ?? "main"
      if (name !== "main" && name !== "backup") fail("--name is main or backup")
      const file = join(keysDir, `${c.app}-${name}.pem`)
      if (existsSync(file)) fail(`${file} exists; keys are never replaced by accident (move it away first)`)
      mkdirSync(keysDir, { recursive: true })
      const k = generateKeys()
      writeFileSync(file, k.privatePem, { mode: 0o600 })
      console.log(`✓ private key: ${file}  (keep it secret; back up the backup key offline)`)
      console.log(`  public key (${keyId(k.publicBase64)}), add it to the app and to zn-ota.json "publicKeys":`)
      console.log(`  ${k.publicBase64}`)
      return
    }
    case "build": {
      const c = config()
      const pem = privateKey(c)
      const g = git()
      await withLock(async () => {
        const out = mkdtempSync(join(tmpdir(), "zn-ota-build-"))
        try {
          console.log(`… building ${c.app} (${c.build.join(" ")})`)
          const p = Bun.spawnSync([...c.build, "--out", out, "--serial", "0"], { cwd: appDir, stdout: "inherit", stderr: "inherit" })
          if (p.exitCode !== 0) fail("the build failed")
          const r = await core.releaseBuilt({ store: store(c), app: c.app, privatePem: pem }, out, g)
          const m = r.manifest
          if (r.reused) console.log(`✓ same bytes as #${m.serial} (${m.id}): nothing new to release`)
          else console.log(`✓ released #${m.serial} (${m.id}), zip ${Math.round(m.zip.size / 1024)} KB${g.dirty ? ", from uncommitted changes (staging only)" : ""}`)
          console.log(`  next: bun run ota publish --channel staging --bundle ${m.serial}`)
        } finally {
          rmSync(out, { recursive: true, force: true })
        }
      })
      return
    }
    case "publish": {
      const c = config()
      if (!a.channel || !a.bundle) fail("publish needs --channel and --bundle")
      const ctx = { store: store(c), app: c.app, privatePem: privateKey(c) }
      const serial = (await core.manifest(ctx, a.bundle)).serial
      const confirm = a.channel === core.PRODUCTION ? confirmation(`PRODUCTION #${serial}`) : undefined
      const p = await withLock(() =>
        core.publish(ctx, {
          channel: a.channel!,
          bundle: a.bundle!,
          rollout: a.rollout === undefined ? undefined : Number(a.rollout),
          priority: a.priority === "high" ? "high" : "normal",
          confirm,
          reason: a.reason,
        }),
      )
      console.log(`✓ ${p.channel} → ${p.target} at ${p.rollout}% (seq ${p.seq})`)
      return
    }
    case "rollout": {
      const c = config()
      if (!a.channel || !a.percent) fail("rollout needs --channel and --percent")
      const ctx = { store: store(c), app: c.app, privatePem: privateKey(c) }
      const p = await withLock(() => core.setRollout(ctx, a.channel!, Number(a.percent)))
      console.log(`✓ ${p.channel} → ${p.target} at ${p.rollout}% (seq ${p.seq})`)
      return
    }
    case "kill": {
      const c = config()
      if (!a.channel) fail("kill needs --channel")
      const ctx = { store: store(c), app: c.app, privatePem: privateKey(c) }
      const confirm = confirmation(`KILL ${a.channel.toUpperCase()}`)
      const p = await withLock(() => core.kill(ctx, a.channel!, confirm, a.reason))
      console.log(`✓ kill switch on ${p.channel} (seq ${p.seq}): phones go back to the APK's own bundle`)
      return
    }
    case "stable": {
      const c = config()
      if (!a.bundle) fail("stable needs --bundle")
      await withLock(() => core.markStable({ store: store(c), app: c.app }, a.bundle!))
      console.log(`✓ #${a.bundle} marked stable on staging; production may now take it`)
      return
    }
    case "status": {
      const c = config()
      const s = await core.status({ store: store(c), app: c.app })
      console.log(`${c.app} in ${store(c).where}`)
      console.log("channels:")
      for (const ch of s.channels) {
        console.log(`  ${ch.channel.padEnd(11)} → ${ch.target} ${ch.rollout}% (seq ${ch.seq}, ${ch.at})${ch.reason ? ` ${ch.reason}` : ""}`)
      }
      if (s.channels.length === 0) console.log("  (nothing published)")
      console.log("bundles:")
      for (const b of s.bundles) {
        const marks = [b.stable ? "stable" : "", b.dirty ? "uncommitted" : "", ...b.servedBy].filter(Boolean).join(", ")
        console.log(`  #${b.serial} ${b.id} ${b.zipKb} KB ${b.builtAt}${marks ? ` [${marks}]` : ""}`)
      }
      // What phones reported (the reference server's telemetry, last 7 days; step 4.7).
      const dataDir = join(resolve(appDir, a.data ?? join(c.store, "..", ".zn-ota-data")), c.app)
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10)
      const files = existsSync(dataDir) ? readdirSync(dataDir).filter((f) => /^checks-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f) && f.slice(7, 17) >= since).sort() : []
      const health = core.summarizeChecks(files.flatMap((f) => readFileSync(join(dataDir, f), "utf8").split("\n")))
      console.log(`phones (last 7 days, ${dataDir}):`)
      for (const h of health) {
        const kinds = Object.entries(h.outcomes).sort(([x], [y]) => Number(core.SERIOUS_OUTCOMES.includes(y)) - Number(core.SERIOUS_OUTCOMES.includes(x)) || x.localeCompare(y))
        const text = kinds.map(([k, n]) => `${core.SERIOUS_OUTCOMES.includes(k) ? "!" : ""}${k} ${n}`).join(", ")
        console.log(`  ${h.bundle.padEnd(24)} ${String(h.phones).padStart(4)} phone(s)${text ? `  ${text}` : ""}`)
      }
      if (health.length === 0) console.log("  (no checks recorded)")
      else if (health.some((h) => Object.keys(h.outcomes).some((k) => core.SERIOUS_OUTCOMES.includes(k)))) {
        console.log("  ! = a safety net acted on phones (rollback, block, OTA off): see docs/ota.md §3.6")
      }
      return
    }
    case "verify": {
      const c = config()
      const keys = c.publicKeys?.length ? c.publicKeys : [publicKeyOf(privateKey(c))]
      const problems = await core.verifyStore({ store: store(c), app: c.app }, keys)
      if (problems.length > 0) fail(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`)
      console.log(`✓ every signature and zip in ${store(c).where} checks out (${keys.length} trusted key(s))`)
      return
    }
    case "serve": {
      const c = config()
      if (/^[a-z]+:\/\//.test(c.store)) fail("serve reads a local store folder")
      const storeRoot = resolve(appDir, c.store)
      const dataDir = resolve(appDir, a.data ?? join(c.store, "..", ".zn-ota-data"))
      const server = startServer({ storeRoot, dataDir, port: a.port ? Number(a.port) : undefined, hostname: a.host })
      console.log(`✓ update server on http://${server.hostname}:${server.port} (store ${storeRoot}, telemetry ${dataDir})`)
      console.log(`  phone over USB: adb reverse tcp:${server.port} tcp:${server.port}   Ctrl+C stops it`)
      return
    }
    default:
      fail(`unknown command "${command ?? ""}". Commands: keygen, build, publish, stable, rollout, kill, status, verify, serve`)
  }
}

main().catch((e) => fail(e instanceof core.ReleaseError ? e.message : String(e instanceof Error ? e.stack : e)))
