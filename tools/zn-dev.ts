// `zn dev` (ARCHITECTURE §17): rebuilds the app when you save a file and sends the new build to the phone, which
// reloads the screens (debug builds only; android/runtime/.../ZnDev.kt, ios/ZnRuntime/Swift/ZnDev.swift). JS errors
// from the phone come back here, are mapped to the TSX file and line, printed, and shown on the phone's error screen.
// One build serves every phone connected at once (Android and the iOS simulator run the same bytecode).
//
// Usage (repo root):
//   bun run dev                       → the sample app (examples/sample)
//   bun run tools/zn-dev.ts <appDir>  → another app laid out the same way (src/main.ts)
//   ... --lan                         → also a real iPhone on the same Wi-Fi (see below)
//   ... --name N                      → the app's bundle name, when it isn't zn-ota.json's app or the folder's name
// Android: a phone connected with USB debugging (this runs `adb reverse`). iOS simulator: a Debug build connects to
// this computer's 127.0.0.1 by itself. A real iPhone can't reach this computer's 127.0.0.1 (and iOS has no adb
// reverse), so it comes over the local network: --lan listens on every network of this computer (not only 127.0.0.1)
// and advertises `_zn-dev._tcp` with Bonjour (macOS's dns-sd; TXT app= and mac=), and the phone's Debug build finds it
// by itself (it asks for Local Network access the first time; it never takes another app's server). Without Bonjour (a network that blocks it), the app's ZN_DEV_HOST
// (environment) or ZNDevHost (Info.plist) names this computer's address, which --lan prints. Opt in: anyone on the
// network can then download the app's code from this port while it runs. Android works the same with or without it.
// ZN_DEV_PORT (tests): another port than 8082 (the phones only know 8082). ZN_DEV_ADB=0: no `adb reverse`.
// ZN_DEV_BONJOUR=0 (tests): --lan without advertising.
// ZN_DEV_OUT (tests): the folder for dev.js and dev.hbc instead of <appDir>/build (a running `zn dev` uses that one).
//
// Wire format, both ways: u32 length (big endian), then u8 type and the body. Same list as ZnDev.kt and ZnDevWire.swift.
import { createHash } from "node:crypto"
import { watch } from "node:fs"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import { hostname, networkInterfaces } from "node:os"
import { basename, join, relative, resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import type { Socket } from "bun"
import { buildApp, type AppBuild } from "@zeronative/compiler"
import { bytecodeVersion, hermesc } from "./hermesc"

const PORT = Number(process.env.ZN_DEV_PORT ?? 8082)
const BUILD = 1
const BUILD_FAILED = 2
const ERROR_MAPPED = 3
const HELLO = 10
const ERROR = 11
const RELOAD = 12

// In a zero-native checkout, the framework's own sources are watched too. Installed from npm (@zeronative/cli), only
// the app's: the packages in node_modules don't change while you work.
const usage = "usage: zn dev [appDir] [--lan] [--name N]   (--lan: also a real iPhone on the same Wi-Fi, found by Bonjour;\n" +
  "  --name: the app's bundle name, as zn-build's --name, for the iPhone to know this server is its app's)"
const readArgs = () =>
  parseArgs({
    allowPositionals: true,
    options: { lan: { type: "boolean" }, name: { type: "string" }, help: { type: "boolean", short: "h" } },
  })
// An unknown flag (zn dev --foo): the usage, not a stack trace.
let parsed: ReturnType<typeof readArgs>
try {
  parsed = readArgs()
} catch (e) {
  console.error(`${(e as Error).message}\n${usage}`)
  process.exit(1)
}
const { values: flags, positionals } = parsed
if (flags.help || positionals.length > 1) {
  console.log(usage)
  process.exit(flags.help ? 0 : 1)
}
const lan = flags.lan === true
const checkout = existsSync(join(import.meta.dir, "../plugins"))
const root = checkout ? resolve(import.meta.dir, "..") : resolve(positionals[0] ?? ".")
const appDir = resolve(positionals[0] ?? (checkout ? join(root, "examples/sample") : "."))
// The app's bundle name (zn-bundle.json's app, which the iPhone's build has): --name, else zn-ota.json's app (in the
// app's folder or the one above), else the folder's name (zn-build's default). Bonjour says it, so an iPhone never
// takes another app's server; a phone that says another one is warned about.
function appName(): string {
  if (flags.name) return flags.name
  for (const dir of [appDir, resolve(appDir, "..")]) {
    try {
      const app = JSON.parse(readFileSync(join(dir, "zn-ota.json"), "utf8")).app
      if (typeof app === "string" && app) return app
    } catch {}
  }
  return basename(appDir)
}
const app = appName()
const entry = join(appDir, "src/main.ts")
const asset = "main.zn.ui"
const tmpDir = process.env.ZN_DEV_OUT ? resolve(process.env.ZN_DEV_OUT) : join(appDir, "build")
mkdirSync(tmpDir, { recursive: true })

// Plain console output in simple words; colours only where they help.
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

// ---- Builds ---------------------------------------------------------------------------------------------------------

type Current = { ok: true; app: AppBuild; frame: Uint8Array; hash: string; bytecode: number } | { ok: false; message: string }
let current: Current | null = null
let building = false
let again = false

async function rebuild(reason: string): Promise<void> {
  if (building) {
    again = true
    return
  }
  building = true
  const t0 = performance.now()
  try {
    const app = await buildApp(entry)
    const t1 = performance.now()
    const jsPath = join(tmpDir, "dev.js")
    const hbcPath = join(tmpDir, "dev.hbc")
    await Bun.write(jsPath, app.js)
    // -g1: line numbers in JS stack traces, so errors can be mapped back to TSX.
    await hermesc(jsPath, hbcPath, ["-g1"])
    const hbc = new Uint8Array(await Bun.file(hbcPath).arrayBuffer())
    const t2 = performance.now()
    const hash = createHash("sha1").update(hbc).digest("hex")
    current = { ok: true, app, frame: buildFrame(app, hbc, hash), hash, bytecode: await bytecodeVersion(hbcPath) }
    const sent = broadcast(current.frame)
    console.log(
      `${reason}: built in ${Math.round(t2 - t0)} ms (bundle ${Math.round(t1 - t0)} ms, hermesc ${Math.round(t2 - t1)} ms, ` +
        `${(hbc.length / 1024).toFixed(0)} KB) → ${sent} phone(s)`,
    )
  } catch (e) {
    const message = buildError(e)
    current = { ok: false, message }
    console.log(red(`${reason}: build failed\n${message}`))
    broadcast(frame(BUILD_FAILED, JSON.stringify({ message })))
  } finally {
    building = false
    if (again) {
      again = false
      void rebuild("changed while building")
    }
  }
}

/** A failed build's text: Bun's bundler throws "Bundle failed" with the real messages (file, line) in `errors`. */
function buildError(e: unknown): string {
  const err = e as { message?: string; errors?: unknown[] }
  const lines = (Array.isArray(err?.errors) ? err.errors : []).map((m) => {
    const b = m as { message?: string; position?: { file?: string; line?: number; column?: number; lineText?: string } }
    const p = b?.position
    if (!b?.message) return String(m)
    // A plugin's error (the compiler's) names its file itself and has no line.
    const text = b.message.replaceAll(root + sep, "")
    if (!p?.file || !p.line) return text
    return `${relative(root, p.file).replaceAll("\\", "/")}:${p.line}:${p.column}: ${text}${p.lineText ? `\n  ${p.lineText.trim()}` : ""}`
  })
  return lines.length ? lines.join("\n") : String(err?.message ?? e)
}

function buildFrame(app: AppBuild, hbc: Uint8Array, hash: string): Uint8Array {
  const manifest = new TextEncoder().encode(JSON.stringify(app.manifest))
  const header = new TextEncoder().encode(
    JSON.stringify({ asset, hash, templates: app.templates.length, manifest: manifest.length, hbc: hbc.length }),
  )
  const body = new Uint8Array(4 + header.length + app.templates.length + manifest.length + hbc.length)
  new DataView(body.buffer).setUint32(0, header.length)
  let at = 4
  for (const part of [header, app.templates, manifest, hbc]) {
    body.set(part, at)
    at += part.length
  }
  return frame(BUILD, body)
}

function frame(type: number, body: Uint8Array | string): Uint8Array {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  const out = new Uint8Array(5 + bytes.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, bytes.length + 1)
  view.setUint8(4, type)
  out.set(bytes, 5)
  return out
}

// ---- Error mapping --------------------------------------------------------------------------------------------------

/** Replaces every `<file>.js:line:col` / `.hbc:line:col` in a JS stack with the TSX / TS file and line. */
function mapStack(text: string): string {
  if (!current?.ok) return text
  const app = current.app
  return text.replace(/((?:[A-Za-z]:)?[^\s():]*\.(?:js|hbc)):(\d+):(\d+)/g, (whole, _file, line, col) => {
    const pos = app.original(Number(line) - 1, Number(col) - 1)
    if (!pos) return whole
    return `${relative(root, pos.file).replaceAll("\\", "/")}:${pos.line + 1}:${pos.col + 1}`
  })
}

// ---- Phones ---------------------------------------------------------------------------------------------------------

// [out]: bytes the socket didn't take yet. Bun's write sends what the system takes now and returns how much; the
// rest must be written again on drain, or a build (MBs) arrives cut and the phone waits for its end forever.
type Phone = { name: string; buffer: Uint8Array; out: Uint8Array[] }
const phones = new Set<Socket<Phone>>()

function send(s: Socket<Phone>, f: Uint8Array): void {
  if (s.data.out.length) {
    s.data.out.push(f)
    return
  }
  const n = s.write(f)
  if (n < f.length) s.data.out.push(f.subarray(Math.max(n, 0)))
}

/** The socket can take more: what is waiting, in order. */
function drain(s: Socket<Phone>): void {
  while (s.data.out.length) {
    const f = s.data.out[0]
    const n = s.write(f)
    if (n < f.length) {
      s.data.out[0] = f.subarray(Math.max(n, 0))
      return
    }
    s.data.out.shift()
  }
}

function broadcast(f: Uint8Array): number {
  for (const s of phones) send(s, f)
  return phones.size
}

function onMessage(s: Socket<Phone>, type: number, body: Uint8Array): void {
  const json = () => JSON.parse(new TextDecoder().decode(body))
  switch (type) {
    case HELLO: {
      // os, bytecode and app: iOS sends them (Android's HELLO has device and hash only).
      const { device, hash, os, bytecode, app: phoneApp } = json()
      s.data.name = device
      // Where from: a phone over the local network (--lan) shows its address; USB (adb reverse) and the simulator
      // come from 127.0.0.1.
      const from = s.remoteAddress.replace(/^::ffff:/, "")
      const local = from === "127.0.0.1" || from === "::1"
      console.log(`phone connected: ${device}${os || !local ? dim(` (${[os, local ? "" : from].filter(Boolean).join(", ")})`) : ""}`)
      if (typeof phoneApp === "string" && phoneApp && phoneApp !== app) {
        console.log(red(`${device} runs the app "${phoneApp}", this serves "${app}": its builds replace that app's JS (zn dev --name ${phoneApp}, or the right app's folder)`))
      }
      if (typeof bytecode === "number" && current?.ok && bytecode !== current.bytecode) {
        console.log(red(`${device} runs Hermes bytecode ${bytecode}, this hermesc writes ${current.bytecode}: its builds won't run there`))
      }
      if (!current) return // the first build is still running; it will be broadcast
      if (!current.ok) send(s, frame(BUILD_FAILED, JSON.stringify({ message: current.message })))
      else if (hash !== current.hash) send(s, current.frame)
      return
    }
    case ERROR: {
      const { id, text } = json()
      const mapped = mapStack(text)
      console.log(red(`JS error on ${s.data.name}:`) + "\n" + mapped)
      const nl = mapped.indexOf("\n")
      send(s, frame(ERROR_MAPPED, JSON.stringify({ id, text: nl < 0 ? mapped : mapped.slice(nl + 1) })))
      return
    }
    case RELOAD:
      if (current?.ok) send(s, current.frame)
      return
    default:
      console.log(dim(`unknown message type ${type} from ${s.data.name}`))
  }
}

// --lan: every network of this computer, IPv4 and IPv6 ("::" takes both); else this computer only (adb reverse and
// the simulator come from 127.0.0.1).
Bun.listen<Phone>({
  hostname: lan ? "::" : "127.0.0.1",
  port: PORT,
  socket: {
    open(s) {
      s.data = { name: "phone", buffer: new Uint8Array(0), out: [] }
      phones.add(s)
    },
    data(s, chunk) {
      const merged = new Uint8Array(s.data.buffer.length + chunk.length)
      merged.set(s.data.buffer)
      merged.set(chunk, s.data.buffer.length)
      let at = 0
      while (merged.length - at >= 5) {
        const length = new DataView(merged.buffer, at).getUint32(0)
        if (merged.length - at - 4 < length) break
        onMessage(s, merged[at + 4], merged.slice(at + 5, at + 4 + length))
        at += 4 + length
      }
      s.data.buffer = merged.slice(at)
    },
    drain,
    close(s) {
      phones.delete(s)
      console.log(dim(`phone disconnected: ${s.data.name}`))
    },
  },
})

// ---- Start ----------------------------------------------------------------------------------------------------------

// An Android phone reaches this computer's port through USB (adb reverse). The iOS simulator shares this computer's
// network, so it needs nothing: without adb or an Android phone, say so instead of failing.
function adbReverse(): void {
  if (process.env.ZN_DEV_ADB === "0") return
  const iosHint = "iOS simulator: a Debug build connects by itself."
  if (!Bun.which("adb")) {
    console.log(dim(`Android: adb isn't on PATH, so no adb reverse (install the Android SDK platform-tools). ${iosHint}`))
    return
  }
  // Any phone adb lists (also one that is unauthorized or offline): adb reverse runs, and says what is wrong with it.
  const devices = Bun.spawnSync(["adb", "devices"], { stderr: "pipe" })
  const listed = devices.stdout.toString().split("\n").slice(1).some((l) => /\S+\t\S+/.test(l))
  if (devices.exitCode === 0 && !listed) {
    console.log(dim(`Android: no phone on adb; connect one with USB debugging on, then run this again. ${iosHint}`))
    return
  }
  const adb = Bun.spawnSync(["adb", "reverse", `tcp:${PORT}`, `tcp:${PORT}`], { stderr: "pipe" })
  if (adb.exitCode !== 0) {
    console.log(red(`adb reverse failed: ${adb.stderr.toString().trim()}`))
    console.log("Connect the phone with USB debugging on, then run this again.")
  }
}
adbReverse()

/** This computer's addresses a phone on the same network can use (IPv4, not 127.0.0.1), by network name (en0, ...). */
function lanAddresses(): { name: string; address: string }[] {
  return Object.entries(networkInterfaces()).flatMap(([name, list]) =>
    (list ?? []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, address: a.address })),
  )
}

/** This Mac's Bonjour name without .local (what a Debug build's ZNDevMac says: ios/cmake/ZnDev.cmake). */
function localHostName(): string {
  const r = Bun.which("scutil") ? Bun.spawnSync(["scutil", "--get", "LocalHostName"], { stderr: "ignore" }) : undefined
  const name = r?.success ? r.stdout.toString().trim() : ""
  return name || hostname().replace(/\.local$/, "")
}

// --lan: a real iPhone finds this server by Bonjour (`_zn-dev._tcp`, ZnDev.swift). macOS's dns-sd advertises it for as
// long as it runs; a small shell around it stops it within a second of this process ending in any way (Ctrl-C, kill,
// kill -9) or of the shell itself being stopped, so no advertisement outlives the server.
function advertise(): void {
  if (process.env.ZN_DEV_BONJOUR === "0") return
  const mac = localHostName()
  // A Bonjour name has at most 63 bytes (dns-sd refuses a longer one); cut by characters, not UTF-16 halves.
  const chars = [...`zn dev ${app} on ${mac}`]
  while (Buffer.byteLength(chars.join("")) > 63) chars.pop()
  const name = chars.join("")
  if (!Bun.which("dns-sd")) {
    console.log(dim("iPhone: no dns-sd on this computer (macOS has it), so no Bonjour: set ZN_DEV_HOST in the app to an address below."))
    return
  }
  // TXT: app= (the iPhone never takes another app's server) and mac= (it prefers the Mac it was built on: ZNDevMac).
  const watcher = 'dns-sd -R "$1" _zn-dev._tcp local "$2" "app=$3" "mac=$5" >/dev/null & d=$!; ' +
    "trap 'kill $d 2>/dev/null; exit 0' TERM INT HUP; " +
    'while kill -0 "$4" 2>/dev/null && kill -0 $d 2>/dev/null; do sleep 1; done; kill $d 2>/dev/null'
  const child = Bun.spawn(["/bin/sh", "-c", watcher, "zn-dev-bonjour", name, String(PORT), app, String(process.pid), mac], {
    stdout: "ignore",
    stderr: "ignore",
  })
  process.on("exit", () => child.kill())
  console.log(`iPhone: advertised on this network as "${name}" (Bonjour ${dim("_zn-dev._tcp")}).`)
}

if (lan) {
  advertise()
  const addresses = lanAddresses()
  const list = addresses.map((a) => `${a.address}${dim(` (${a.name})`)}`).join(", ")
  console.log(
    addresses.length
      ? `iPhone: this computer is ${list}. Without Bonjour, set ZN_DEV_HOST=<address> in the app's environment (Xcode scheme).`
      : red("--lan: this computer has no network address besides 127.0.0.1: connect it to the phone's Wi-Fi."),
  )
  console.log(dim(`--lan: anyone on this network can download the app's code from port ${PORT} while this runs.`))
} else {
  console.log(dim("iPhone (a real one): run with --lan (zn dev --lan, bun run dev --lan). The simulator and Android need nothing more."))
}

console.log(`zn dev: ${relative(root, appDir) || "."} on port ${PORT}. Open the app's debug build on the phone or the iOS simulator.`)
await rebuild("start")

// Rebuild on save: the app's sources and the framework packages and plugins it bundles. Editors often write a file twice.
let timer: ReturnType<typeof setTimeout> | null = null
let changed = ""
const onChange = (dir: string) => (_event: string, file: string | null) => {
  if (!file || file.includes("node_modules") || !/\.(tsx?|json|svg)$/.test(file)) return
  changed = relative(root, join(dir, file)).replaceAll("\\", "/")
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void rebuild(changed), 30)
}
// Only plugin folders with sources: plugins/ also holds files (module-names.test.ts), and watching a missing folder
// throws.
const pluginSources = checkout
  ? readdirSync(join(root, "plugins")).map((name) => join(root, "plugins", name, "src")).filter((dir) => existsSync(dir))
  : []
const framework = checkout ? [join(root, "packages/core/src"), join(root, "packages/ui/src"), ...pluginSources] : []
for (const dir of [join(appDir, "src"), ...framework]) {
  watch(dir, { recursive: true }, onChange(dir))
}
