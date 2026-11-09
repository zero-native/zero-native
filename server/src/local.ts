// Runs zn-updates on this computer: PGlite (no Postgres needed) and a files folder under server/.local/.
//   bun run updates:server            → http://127.0.0.1:8790 (the dashboard at / after its one-time link, phones at /v1/*)
//   bun run updates:server --demo     → also creates a demo app "demo" with a key pair and two bundles (dashboard work)
// The admin token is printed at start (ADMIN_TOKEN, or a fixed local one). A phone reaches it with
// `adb reverse tcp:8790 tcp:8790` and ZnOta's server "http://127.0.0.1:8790" (a debug build: release builds refuse http).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { writeBundleInfo } from "../../tools/bundle-info"
import { generateKeys } from "../../tools/ota/signing"
import { call, changeChannel, uploadBuilt } from "../../tools/updates/client"
import { migrate, openDb } from "./db"
import { SERVER_VERSION, startServer } from "./index"
import { openStore } from "./storage"

const { values } = parseArgs({ options: { demo: { type: "boolean" }, port: { type: "string" }, dir: { type: "string" } } })
const root = values.dir ?? join(import.meta.dir, "..", ".local")
mkdirSync(root, { recursive: true })
const token = process.env.ADMIN_TOKEN ?? "local-admin-token-0000"
const port = Number(values.port ?? process.env.PORT ?? 8790)

const db = await openDb(process.env.DATABASE_URL ?? `pglite:${join(root, "db")}`)
const applied = await migrate(db)
if (applied.length) console.log(`database: applied ${applied.join(", ")}`)
const store = openStore(process.env.STORAGE ?? `file:${join(root, "files")}`, join(root, "cache"))
const { server } = startServer({ db, store, adminToken: token, port, hostname: "0.0.0.0" })
const base = `http://127.0.0.1:${server.port}`
console.log(`zn-updates ${SERVER_VERSION} (local) at ${base}`)
console.log(`  admin token: ${token}`)
console.log(`  data: ${root}`)

if (values.demo) await demo()

// The dashboard opens only through a one-time link (src/session.ts). One for right now; later ones come from the CLI:
//   bun run updates login --server <base> --token <token> --by <you>, then `bun run updates dashboard` in an app folder
const link = await call<{ code: string }>({ server: base, token, by: "local" }, "POST", "/admin/login-links")
console.log(`  dashboard (this link works once, within 60 s): ${base}/open?code=${link.code}`)
console.log(`  later: bun run updates dashboard --server ${base} (in an app folder, after \`updates login\`)`)

/** A demo app with real signed bundles: staging and production live, a store rule, some phone checks. */
async function demo() {
  const keyFile = join(root, "demo-key.pem")
  const c = { server: base, token, by: "demo" }
  if ((await call<{ id: string }[]>(c, "GET", "/admin/apps")).some((a) => a.id === "demo")) {
    console.log(`  demo app exists (private key: ${keyFile})`)
    return
  }
  const keys = generateKeys()
  const backup = generateKeys()
  writeFileSync(keyFile, keys.privatePem)
  await call(c, "POST", "/admin/apps", {
    id: "demo",
    name: "Demo shop",
    publicKeys: [keys.publicBase64, backup.publicBase64],
    store: { android: { packages: { "com.demo.shop": "production", "com.demo.shop.staging": "staging" } }, ios: { appStoreId: "1234567890" } },
  })
  const requires = { registry: 24, bytecode: 99, hostApi: 9, modules: { Fetch: 1, Device: 6 } }
  const build = async (code: string) => {
    const dir = mkdtempSync(join(tmpdir(), "znu-demo-"))
    writeFileSync(join(dir, "main.hbc"), code.repeat(2000))
    writeFileSync(join(dir, "main.zn.ui"), "templates")
    writeFileSync(join(dir, "main.zn.ui.json"), "{}")
    await writeBundleInfo(dir, { app: "demo", serial: 0, names: ["main.hbc", "main.zn.ui", "main.zn.ui.json"], requires })
    return dir
  }
  const git = (subject: string) => ({ commit: Math.random().toString(16).slice(2, 9), dirty: false, subject })
  const one = await uploadBuilt(c, await build("v1"), keys.privatePem, git("+ Home cards"))
  await changeChannel(c, keys.privatePem, { app: "demo", channel: "staging", target: one.manifest.serial, rollout: 100 })
  await call(c, "POST", `/admin/apps/demo/bundles/${one.manifest.serial}/stable`, { on: true, note: "Checked on a phone" })
  await changeChannel(c, keys.privatePem, { app: "demo", channel: "production", target: one.manifest.serial, rollout: 25, confirm: `PRODUCTION #${one.manifest.serial}` })
  const two = await uploadBuilt(c, await build("v2"), keys.privatePem, git("Fix the receipt total"))
  await changeChannel(c, keys.privatePem, { app: "demo", channel: "staging", target: two.manifest.serial, rollout: 100 })
  await call(c, "POST", `/admin/apps/demo/bundles/${two.manifest.serial}/title`, { title: "Faster receipts" })
  await call(c, "POST", "/admin/apps/demo/store-rules", { os: "android", version: 150, critical: 1, note: "1.5.0 has the new Home" })
  for (let i = 0; i < 12; i++) {
    await fetch(`${base}/v1/check`, {
      method: "POST",
      body: JSON.stringify({
        app: "demo", channel: i % 3 ? "production" : "staging", installId: `demo-install-${i}`,
        capabilities: { registry: 24, bytecode: 99, hostApi: 9, hostApiOldest: 1, modules: { Fetch: 1, Device: 6 } },
        running: i % 2 ? { id: one.manifest.id, sha256: one.manifest.bundleSha256 } : null,
        builtIn: { id: "demo_0", serial: 0 }, kept: [], seq: 0,
        outcomes: i === 5 ? [{ kind: "error_screen", bundle: one.manifest.id, detail: "render", stack: "at Home (main.js:12:3)" }] : [],
      }),
    })
  }
  console.log(`  demo app created; its private key (for signing in the dashboard): ${keyFile}`)
}


