// Reproduction for "every HTTP call stuck until the app is swiped away" (docs/second-opinions.md #221).
// Runs the sample app's lab screens (examples/sample/src/CallPoolLab.tsx) and prints what they log.
//
//   bun run tools/repro/http-stall.ts pool [--serial emulator-5554]
//     Holds the 2 native call threads with Device.slowEcho and times a fetch, a native call, fetch's `timeout` and an
//     AbortSignal behind them.
//   bun run tools/repro/http-stall.ts images [--serial emulator-5554]
//     The image lab: when each of 21 slow images (2 s each, one host) arrives, and how many the server served at once.
//   bun run tools/repro/http-stall.ts list [--serial emulator-5554]
//     The List image lab: are the pictures of the rows below the screen loaded before a scroll brings them on screen?
//   bun run tools/repro/http-stall.ts net [--serial emulator-5554] [--apk C:/path/sample-debug.apk]
//     A fetch every 3 s (public HTTPS host + local server) while the script turns mobile data and Wi-Fi off and on,
//     sends the app to the background, forces Doze, and (with --apk) installs the APK over the running app.
//     Prints each phase and whether calls worked again after it.
//
// Needs the sample debug APK installed. Starts tools/fetch-test-server.ts itself if port 8788 is free.
// Emulator only for `net` (it turns radios off). Never uses `am force-stop` (MediaTek DuraSpeed, see the phone notes).
import { join } from "node:path"

const PKG = "dev.zeronative.sample"
const args = process.argv.slice(2)
const mode = args[0] ?? "pool"
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const serial = opt("serial") ?? "emulator-5554"
const apk = opt("apk")

function adb(...a: string[]): string {
  const p = Bun.spawnSync(["adb", "-s", serial, ...a], { stdout: "pipe", stderr: "pipe", timeout: 120_000 })
  return (p.stdout.toString() + p.stderr.toString()).trim()
}
const sh = (cmd: string) => adb("shell", cmd)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s`

async function ensureServer(): Promise<void> {
  try {
    await fetch("http://localhost:8788/json", { signal: AbortSignal.timeout(1000) })
    return
  } catch {}
  Bun.spawn(["bun", "run", join(import.meta.dir, "../fetch-test-server.ts")], { stdout: "ignore", stderr: "inherit" })
  for (let i = 0; i < 20; i++) {
    await sleep(250)
    try {
      await fetch("http://localhost:8788/json", { signal: AbortSignal.timeout(500) })
      return
    } catch {}
  }
  throw new Error("fetch-test-server did not start on port 8788")
}

/** JS console lines of the app (zn-js log lines that contain [marker]), as they come. */
function watchLog(marker: string, onLine: (line: string) => void): () => void {
  adb("logcat", "-c")
  const proc = Bun.spawn(["adb", "-s", serial, "logcat", "-v", "brief"], { stdout: "pipe", stderr: "ignore" })
  ;(async () => {
    const reader = proc.stdout.getReader()
    const dec = new TextDecoder()
    let rest = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      rest += dec.decode(value, { stream: true })
      const lines = rest.split(/\r?\n/)
      rest = lines.pop() ?? ""
      for (const l of lines) {
        const i = l.indexOf(marker)
        if (i >= 0) onLine(l.slice(i))
        else if (/^[VDIWEF]\/zn\s*\(.*fetch: /.test(l)) onLine(`(native) ${l.slice(l.indexOf("fetch: "))}`)
        else if (/^[VDIWEF]\/zn\s*\(.*native call /.test(l)) onLine(`(native) ${l.slice(l.indexOf("native call "))}`) // the pool watch
      }
    }
  })()
  return () => proc.kill()
}

const open = (path: string) => sh(`am start -a android.intent.action.VIEW -d zn://sample${path} ${PKG}`)

async function pool(): Promise<void> {
  let done = false
  const stop = watchLog("pool-check", (l) => {
    console.log(`${at()}  ${l}`)
    if (l.endsWith("done")) done = true
  })
  open("/dev/call-pool")
  for (let i = 0; i < 120 && !done; i++) await sleep(500)
  stop()
  if (!done) console.log("pool-check: no 'done' line within 60 s")
}

type Phase = { name: string; start: number; ok: number; failed: number; maxMs: number; firstOkAfter?: number }

async function net(): Promise<void> {
  const phases: Phase[] = []
  let phase: Phase | null = null
  const begin = (name: string) => {
    phase = { name, start: Date.now(), ok: 0, failed: 0, maxMs: 0 }
    phases.push(phase)
    console.log(`${at()}  ---- ${name}`)
  }
  const stop = watchLog("net-loop", (l) => {
    console.log(`${at()}  ${l}`)
    const p = phase
    const m = /^net-loop #\d+ (\w+) (.*) in (\d+) ms/.exec(l)
    if (!p || !m) return
    const ms = Number(m[3])
    p.maxMs = Math.max(p.maxMs, ms)
    if (m[2]!.startsWith("HTTP")) {
      p.ok++
      if (p.firstOkAfter === undefined) p.firstOkAfter = Date.now() - p.start
    } else p.failed++
  })
  const front = () => open("/dev/net-loop")

  begin("start: app in front")
  front()
  await sleep(15_000)

  begin("mobile data off")
  sh("svc data disable")
  await sleep(15_000)
  begin("mobile data on")
  sh("svc data enable")
  await sleep(20_000)

  begin("Wi-Fi off")
  sh("svc wifi disable")
  await sleep(15_000)
  begin("Wi-Fi on")
  sh("svc wifi enable")
  await sleep(25_000)

  begin("background (Home) 60 s")
  sh("input keyevent KEYCODE_HOME")
  await sleep(60_000)
  begin("back in front")
  sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`)
  await sleep(15_000)

  begin("Doze: background + force-idle 60 s")
  sh("input keyevent KEYCODE_HOME")
  sh("dumpsys battery unplug")
  console.log(`${at()}  ${sh("dumpsys deviceidle force-idle").split("\n")[0]}`)
  await sleep(60_000)
  begin("Doze off, back in front")
  sh("dumpsys deviceidle unforce")
  sh("dumpsys battery reset")
  sh(`monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`)
  await sleep(20_000)

  if (apk) {
    begin("adb install -r over the running app, then open")
    console.log(`${at()}  ${adb("install", "-r", apk).split("\n").pop()}`)
    front()
    await sleep(20_000)
  }
  stop()

  console.log("\nphase                                         ok  failed  max ms  first ok after")
  for (const p of phases) {
    const first = p.firstOkAfter === undefined ? "never" : `${(p.firstOkAfter / 1000).toFixed(1)} s`
    console.log(`${p.name.padEnd(44)} ${String(p.ok).padStart(4)}  ${String(p.failed).padStart(6)}  ${String(p.maxMs).padStart(6)}  ${first}`)
  }
}

/** /dev/image-par: when each image arrives on the phone, and how many the server served at once. */
async function images(): Promise<void> {
  await fetch("http://localhost:8788/slow-image-reset")
  let done = false
  const stop = watchLog("image-par", (l) => {
    console.log(`${at()}  ${l}`)
    if (l.includes("image-par done") || / \((\d+) of \1\)$/.test(l)) done = true
  })
  open("/dev/image-par")
  for (let i = 0; i < 70 && !done; i++) await sleep(500)
  await sleep(1000)
  stop()
  const stats = (await (await fetch("http://localhost:8788/slow-image-stats")).json()) as { maxOpen: number; log: string[] }
  console.log(`\nserver: at most ${stats.maxOpen} images served at once`)
  for (const l of stats.log) console.log(`  ${l}`)
}

/**
 * /dev/image-list: a <List> of 60 rows with a slow picture each (1 s). Waits on the first screen, then scrolls one
 * screen at a time. Prints when each row's picture came after the scroll that brought it on screen, which pictures the
 * server was asked for before any scroll (the preloads), and the ones asked for twice (a preload and the on-screen load).
 */
async function list(): Promise<void> {
  await fetch("http://localhost:8788/slow-image-reset")
  const size = /(\d+)x(\d+)/.exec(sh("wm size")) ?? ["", "1080", "2400"]
  const w = Number(size[1])
  const h = Number(size[2])
  let scrollAt = 0
  let scrolls = 0
  const stop = watchLog("image-", (l) => {
    const m = / (row\d+) loaded at (\d+) ms/.exec(l)
    if (m && scrolls > 0) console.log(`${at()}  ${m[1]} shown ${Date.now() - scrollAt} ms after scroll ${scrolls}`)
    else console.log(`${at()}  ${l}`)
  })
  open("/dev/image-list")
  await sleep(6000)
  const before = (await (await fetch("http://localhost:8788/slow-image-stats")).json()) as { log: string[] }
  const asked = before.log.filter((l) => l.startsWith("start ")).map((l) => l.split(" ")[1])
  console.log(`
before any scroll the server was asked for ${asked.length} pictures: ${asked.join(" ")}
`)
  for (let i = 0; i < 3; i++) {
    scrolls++
    scrollAt = Date.now()
    sh(`input swipe ${Math.round(w / 2)} ${Math.round(h * 0.8)} ${Math.round(w / 2)} ${Math.round(h * 0.25)} 400`)
    await sleep(5000)
  }
  stop()
  const stats = (await (await fetch("http://localhost:8788/slow-image-stats")).json()) as { maxOpen: number; log: string[] }
  const count = new Map<string, number>()
  for (const l of stats.log) if (l.startsWith("start ")) count.set(l.split(" ")[1], (count.get(l.split(" ")[1]) ?? 0) + 1)
  const twice = [...count].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`)
  console.log(`
server: ${count.size} pictures, at most ${stats.maxOpen} at once; asked for more than once: ${twice.join(" ") || "none"}`)
}

await ensureServer()
adb("reverse", "tcp:8788", "tcp:8788")
if (mode === "pool") await pool()
else if (mode === "images") await images()
else if (mode === "net") await net()
else if (mode === "list") await list()
else console.log(`unknown mode "${mode}": use pool, images, list or net`)
process.exit(0)
