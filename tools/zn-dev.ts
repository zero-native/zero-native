// `zn dev` (ARCHITECTURE §17): rebuilds the app when you save a file and sends the new build to the phone, which
// reloads the screens in place (debug builds only; android/runtime/.../ZnDev.kt). JS errors from the phone come back
// here, are mapped to the TSX file and line, printed, and shown on the phone's error screen.
//
// Usage (repo root, phone connected with USB debugging):
//   bun run dev                       → the sample app (examples/sample)
//   bun run tools/zn-dev.ts <appDir>  → another app laid out the same way (src/main.ts)
//
// Wire format, both ways: u32 length (big endian), then u8 type and the body. Same list as ZnDev.kt.
import { createHash } from "node:crypto"
import { watch } from "node:fs"
import { mkdirSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import type { Socket } from "bun"
import { buildApp, type AppBuild } from "../compiler/src"
import { hermesc } from "./hermesc"

const PORT = 8082
const BUILD = 1
const BUILD_FAILED = 2
const ERROR_MAPPED = 3
const HELLO = 10
const ERROR = 11
const RELOAD = 12

const root = resolve(import.meta.dir, "..")
const appDir = resolve(process.argv[2] ?? join(root, "examples/sample"))
const entry = join(appDir, "src/main.ts")
const asset = "main.zn.ui"
const tmpDir = join(appDir, "build")
mkdirSync(tmpDir, { recursive: true })

// Plain console output in simple words; colours only where they help.
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

// ---- Builds ---------------------------------------------------------------------------------------------------------

type Current = { ok: true; app: AppBuild; frame: Uint8Array; hash: string } | { ok: false; message: string }
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
    current = { ok: true, app, frame: buildFrame(app, hbc, hash), hash }
    const sent = broadcast(current.frame)
    console.log(
      `${reason}: built in ${Math.round(t2 - t0)} ms (bundle ${Math.round(t1 - t0)} ms, hermesc ${Math.round(t2 - t1)} ms, ` +
        `${(hbc.length / 1024).toFixed(0)} KB) → ${sent} phone(s)`,
    )
  } catch (e) {
    const message = (e as Error).message
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

type Phone = { name: string; buffer: Uint8Array }
const phones = new Set<Socket<Phone>>()

function broadcast(f: Uint8Array): number {
  for (const s of phones) s.write(f)
  return phones.size
}

function onMessage(s: Socket<Phone>, type: number, body: Uint8Array): void {
  const json = () => JSON.parse(new TextDecoder().decode(body))
  switch (type) {
    case HELLO: {
      const { device, hash } = json()
      s.data.name = device
      console.log(`phone connected: ${device}`)
      if (!current) return // the first build is still running; it will be broadcast
      if (!current.ok) s.write(frame(BUILD_FAILED, JSON.stringify({ message: current.message })))
      else if (hash !== current.hash) s.write(current.frame)
      return
    }
    case ERROR: {
      const { id, text } = json()
      const mapped = mapStack(text)
      console.log(red(`JS error on ${s.data.name}:`) + "\n" + mapped)
      const nl = mapped.indexOf("\n")
      s.write(frame(ERROR_MAPPED, JSON.stringify({ id, text: nl < 0 ? mapped : mapped.slice(nl + 1) })))
      return
    }
    case RELOAD:
      if (current?.ok) s.write(current.frame)
      return
    default:
      console.log(dim(`unknown message type ${type} from ${s.data.name}`))
  }
}

Bun.listen<Phone>({
  hostname: "127.0.0.1",
  port: PORT,
  socket: {
    open(s) {
      s.data = { name: "phone", buffer: new Uint8Array(0) }
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
    close(s) {
      phones.delete(s)
      console.log(dim(`phone disconnected: ${s.data.name}`))
    },
  },
})

// ---- Start ----------------------------------------------------------------------------------------------------------

// The phone reaches this computer's port through USB.
const adb = Bun.spawnSync(["adb", "reverse", `tcp:${PORT}`, `tcp:${PORT}`], { stderr: "pipe" })
if (adb.exitCode !== 0) {
  console.log(red(`adb reverse failed: ${adb.stderr.toString().trim()}`))
  console.log("Connect the phone with USB debugging on, then run this again.")
}

console.log(`zn dev: ${relative(root, appDir) || "."} on port ${PORT}. Open the app's debug build on the phone.`)
await rebuild("start")

// Rebuild on save: the app's sources and the framework packages it bundles. Editors often write a file twice.
let timer: ReturnType<typeof setTimeout> | null = null
let changed = ""
const onChange = (dir: string) => (_event: string, file: string | null) => {
  if (!file || file.includes("node_modules") || !/\.(tsx?|json)$/.test(file)) return
  changed = relative(root, join(dir, file)).replaceAll("\\", "/")
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void rebuild(changed), 30)
}
for (const dir of [join(appDir, "src"), join(root, "packages/core/src"), join(root, "packages/ui/src")]) {
  watch(dir, { recursive: true }, onChange(dir))
}
