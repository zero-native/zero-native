// The OTA phone test matrix (step 4.9, docs/ota-test-matrix.md): runs every case on a real phone over adb, with the
// sample app, and prints a pass / fail table.
//
//   bun run ota:phone                     build + install the debug sample (fresh: its OTA state is wiped), run all
//   bun run ota:phone --until watchdog    stop after that case (cases depend on the ones before: no --only)
//   bun run ota:phone --list              the cases
//
// What it touches: the sample app on the phone (uninstalled and installed again; never another app), a test store
// `.zn-ota-test/` (its own bundles and telemetry, signed with the sample's key from ~/.zero-native/keys; never the
// real `.zn-ota-store`), the sample's sources for a moment (each test bundle is a small change, put back right after
// its build; a backup in `.zn-ota-test/sources-backup` is put back at the next run if this one was killed), and two
// phone settings put back at the end (screen timeout, debug.zn.ota_free_bytes). Ports: 8790 (a fault proxy the phone
// talks to, over `adb reverse`) and 8791 (the reference server). Needs the phone unlocked; debug builds only
// (Device.crash and DebugWakeProvider).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { startServer } from "./server"

const { values: args } = parseArgs({ options: { until: { type: "string" }, list: { type: "boolean" } } })

const root = resolve(import.meta.dir, "../..")
const work = join(root, ".zn-ota-test")
const storeDir = join(work, "store")
const dataDir = join(work, "data")
const backupDir = join(work, "sources-backup")
const PKG = "dev.zeronative.sample"
const OTA_DIR = "no_backup/zn-ota" // in the app's data folder (ZnBundles.otaDir)
const PORT = 8790
const INNER_PORT = 8791
const androidDir = join(root, "android")
const apk = join(androidDir, "sample/build/outputs/apk/debug/sample-debug.apk")

// ---- Small helpers --------------------------------------------------------------------------------------------------

function run(cmd: string[], o: { cwd?: string; allowFail?: boolean } = {}): string {
  const p = Bun.spawnSync(cmd, { cwd: o.cwd ?? root, stdout: "pipe", stderr: "pipe" })
  const out = p.stdout.toString() + p.stderr.toString()
  if (p.exitCode !== 0 && !o.allowFail) throw new Error(`${cmd.join(" ")} failed (exit ${p.exitCode}):\n${out.trim().split("\n").slice(-8).join("\n")}`)
  return out
}

const adb = (...a: string[]) => run(["adb", ...a], { allowFail: true })
const shell = (...a: string[]) => adb("shell", ...a)
const sleep = (ms: number) => Bun.sleep(ms)
const gradle = (...tasks: string[]) =>
  run(process.platform === "win32" ? ["cmd", "/c", join(androidDir, "gradlew.bat"), ...tasks, "-q"] : ["./gradlew", ...tasks, "-q"], { cwd: androidDir })
const cli = (...a: string[]) => run(["bun", "run", "tools/ota/cli.ts", ...a, "--store", storeDir])

class Fail extends Error {}
function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Fail(what)
}

// ---- Phone ----------------------------------------------------------------------------------------------------------

function logcat(): string {
  return adb("logcat", "-d", "-v", "brief", "-s", "zn-ota:*", "zn-sample:*", "zn:*", "zn-js:*", "AndroidRuntime:E")
}

/** Waits for a log line matching [re] (logs since the last [clearLog]). Returns it. */
async function expectLog(re: RegExp, timeoutMs = 20_000): Promise<string> {
  const end = Date.now() + timeoutMs
  while (true) {
    const line = logcat().split(/\r?\n/).find((l) => re.test(l))
    if (line) return line.trim()
    if (Date.now() > end) throw new Fail(`no log line matching ${re} within ${timeoutMs / 1000} s`)
    await sleep(500)
  }
}

/** Fails if a line matching [re] shows up within [waitMs]. */
async function expectNoLog(re: RegExp, waitMs: number) {
  await sleep(waitMs)
  const line = logcat().split(/\r?\n/).find((l) => re.test(l))
  if (line) throw new Fail(`unexpected log line: ${line.trim()}`)
}

const clearLog = () => adb("logcat", "-c")
// Android 14+: `am stop-app` ends the app like a force stop, without the "stopped" state. A force stop puts the app on
// MediaTek DuraSpeed's suppress list (the Lava), which then refuses its WebView renderer and manifest receivers
// (~/.claude/android-phone-notes.md). Older phones (the emulator) have no stop-app; there force-stop is fine.
let sdk = 0
const forceStop = () => {
  if (!sdk) sdk = Number(shell("getprop", "ro.build.version.sdk").trim()) || 1
  shell("am", sdk >= 34 ? "stop-app" : "force-stop", PKG)
}

/** A cold start with the UI (force stop first), logs cleared. */
async function launch() {
  shell("input", "keyevent", "KEYCODE_WAKEUP")
  forceStop()
  await sleep(800)
  clearLog()
  shell("am", "start", "-n", `${PKG}/.MainActivity`)
}

/**
 * After a crash, some phones (the Lava: `show_first_crash_dialog` = 1) show "<app> has stopped" and keep the crashed
 * process alive until the dialog is closed. Closes it like a user would ("Close app", else Back), then waits for the
 * process to end. A force stop would not do: Android would record the exit as a force stop, not a crash.
 */
async function closeCrashDialog(crashLine: string) {
  // Only the crashed process counts: Android may start the app again at once for a background job (Firebase's
  // JobInfoSchedulerService uploads the crash), so "no process at all" may never come (seen on the Lava, 2026-11-10).
  const pid = /\(\s*(\d+)\)/.exec(crashLine)?.[1]
  check(pid, `no process id in "${crashLine}"`)
  for (let i = 0; i < 20; i++) {
    if (!shell("pidof", PKG).trim().split(/\s+/).includes(pid!)) return
    const close = screenTexts().find((t) => /^close app$/i.test(t.text))
    if (close) shell("input", "tap", String(close.x), String(close.y))
    else if (i >= 4) shell("input", "keyevent", "KEYCODE_BACK")
    await sleep(500)
  }
  throw new Fail("the crashed process didn't end within 10 s")
}

async function openDeepLink(path: string) {
  shell("am", "start", "-a", "android.intent.action.VIEW", "-d", `zn://sample/${path}`, PKG)
  await sleep(1500)
}

function screenTexts(): Array<{ text: string; x: number; y: number }> {
  shell("rm", "-f", "/sdcard/zn-ui.xml") // a failed dump must not leave the last screen's text in place
  shell("uiautomator", "dump", "/sdcard/zn-ui.xml")
  const xml = shell("cat", "/sdcard/zn-ui.xml")
  const out: Array<{ text: string; x: number; y: number }> = []
  const re = /<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g
  for (const m of xml.matchAll(re)) {
    const text = m[1] || m[2]
    if (text) out.push({ text, x: (Number(m[3]) + Number(m[5])) >> 1, y: (Number(m[4]) + Number(m[6])) >> 1 })
  }
  return out
}

async function tap(text: string) {
  for (let i = 0; i < 6; i++) {
    const n = screenTexts().find((t) => t.text === text)
    if (n) {
      shell("input", "tap", String(n.x), String(n.y))
      await sleep(800)
      return
    }
    await sleep(700)
  }
  throw new Fail(`"${text}" isn't on screen`)
}

/**
 * Scrolls down (slowly: a tap during a fling only stops the list) until [text] is on screen, then taps it. The row's
 * place moves: after a crash the crash lab shows more lines at the top (2026-11-10).
 */
async function scrollToAndTap(text: string) {
  for (let i = 0; i < 6; i++) {
    const n = screenTexts().find((t) => t.text === text)
    if (n) {
      shell("input", "tap", String(n.x), String(n.y))
      await sleep(800)
      return
    }
    shell("input", "swipe", "500", "1300", "500", "700", "1000")
    await sleep(900)
  }
  throw new Fail(`"${text}" isn't on screen after scrolling`)
}

async function expectText(re: RegExp, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (screenTexts().some((t) => re.test(t.text))) return
    await sleep(700)
  }
  throw new Fail(`no text matching ${re} on screen`)
}

/** Closes the app from recents, like a user's swipe; this phone keeps the process alive. */
async function swipeAway() {
  const m = /taskId=(\d+): dev\.zeronative\.sample/.exec(shell("am", "stack", "list"))
  check(m, "the sample has no task")
  shell("am", "stack", "remove", m[1])
  await sleep(1000)
}

const MOCK = "p2pdops.android.p2pupiapp"
const focused = () => /mCurrentFocus=.*/.exec(shell("dumpsys", "window", "displays"))?.[0] ?? ""

/** A cold start on the launch dev screen, with no saved launch left from a case before. */
async function launchScreen(): Promise<void> {
  shell("input", "keyevent", "KEYCODE_WAKEUP")
  forceStop()
  await sleep(800)
  clearLog()
  await openDeepLink("dev/launch")
  await expectLog(/launch-test first read/)
  const saved = await expectLog(/launch-test first read/)
  if (!saved.endsWith(": none")) {
    await tap("Ack")
    await expectLog(/launch-test ack: true/)
    clearLog()
  }
}

/** Opens the mock for a result. [opaque]: waits for its payment screen; its first window is see-through for 1.8 s. */
async function openMock(opaque: boolean) {
  if (opaque) {
    await tap("Open mock")
    for (let i = 0; i < 20 && !focused().includes("PaymentActivity"); i++) await sleep(300)
    check(focused().includes("PaymentActivity"), `the mock's payment screen didn't open: ${focused()}`)
    await sleep(1000)
    return
  }
  const open = screenTexts().find((t) => t.text === "Open mock")
  check(open, "no Open mock button")
  shell("input", "tap", String(open.x), String(open.y))
  await sleep(600)
}

async function leaveMock() {
  for (let i = 0; i < 5 && focused().includes(MOCK); i++) {
    shell("input", "keyevent", "KEYCODE_BACK")
    await sleep(900)
  }
}

/** Runs a shell command as the app (debug builds): its files. */
const asApp = (cmd: string) => shell("run-as", PKG, "sh", "-c", `'${cmd}'`)

// ---- Test bundles: small changes to the sample, built and released into the test store -----------------------------

const src = (f: string) => join(root, "examples/sample/src", f)
type Patch = { file: string; old: string; new: string }

const HOME_TITLE = (label: string): Patch => ({ file: "HomeScreen.tsx", old: "          Pay a merchant\n", new: `          OTA ${label}\n` })
const HOME_START = (code: string): Patch => ({ file: "HomeScreen.tsx", old: "export function HomeScreen() {\n", new: `export function HomeScreen() {\n${code}` })

const KINDS: Record<string, Patch[]> = {
  good: [],
  "throw-start": [{ file: "main.ts", old: "installRuntime()\n", new: 'installRuntime()\nif (Date.now() > 0) throw new Error("OTA test: this bundle fails at start on purpose")\n' }],
  "crash-home": [
    { file: "HomeScreen.tsx", old: 'import { createStorage, nav, signal, Splash } from "@zeronative/core"\n', new: 'import { createStorage, nav, setTimeout, signal, Splash } from "@zeronative/core"\nimport { Device } from "@zeronative/device-test"\n' },
    HOME_START("  setTimeout(() => void Device.crash(), 1500) // OTA test: crash before the healthy mark\n"),
  ],
  "throw-second": [
    { file: "HomeScreen.tsx", old: 'import { createStorage, nav, signal, Splash } from "@zeronative/core"\n', new: 'import { createStorage, nav, signal, Splash, storage } from "@zeronative/core"\n' },
    HOME_START('  const launch = (storage.getNumber("zn-test.launch") ?? 0) + 1\n  storage.set("zn-test.launch", launch)\n  if (launch === 2) throw new Error("OTA test: the home screen throws on the second launch")\n'),
  ],
  // Needs Device v99; the app has a lower one (v6 on 2026-11-10): an older app offered a bundle for newer native code.
  // The build takes the highest version it finds, so one more line is enough; the plugin's own files stay as they are.
  // (v6 here went stale once Device itself reached v6.)
  "needs-module": [{ file: "HomeScreen.tsx", old: 'import { createStorage, nav, signal, Splash } from "@zeronative/core"\n', new: 'import { createStorage, nativeModule, nav, signal, Splash } from "@zeronative/core"\nconst newerDevice = nativeModule("Device", { version: 99 })\n' }],
}

/** Puts the sample's sources back from the backup; [stopped]: left by a run that was killed (say so). */
function restoreBackup(stopped = false) {
  if (!existsSync(backupDir)) return
  for (const f of readdirSync(backupDir)) {
    writeFileSync(src(f), readFileSync(join(backupDir, f)))
    if (stopped) console.log(`  (put back examples/sample/src/${f} from a run that was stopped)`)
  }
  rmSync(backupDir, { recursive: true, force: true })
}

/** Builds and releases a test bundle of [kind] into the test store; the home screen says "OTA <label>". */
function release(kind: string, label: string): { serial: number; id: string } {
  const patches = [HOME_TITLE(label), ...KINDS[kind]]
  const files = [...new Set(patches.map((p) => p.file))]
  mkdirSync(backupDir, { recursive: true })
  for (const f of files) writeFileSync(join(backupDir, f), readFileSync(src(f)))
  try {
    for (const p of patches) {
      const text = readFileSync(src(p.file), "utf8")
      const nl = text.includes("\r\n") ? "\r\n" : "\n"
      const old = p.old.replaceAll("\n", nl)
      if (text.split(old).length !== 2) throw new Error(`test bundle ${kind}: "${p.old.trim()}" not found once in ${p.file}`)
      writeFileSync(src(p.file), text.replace(old, p.new.replaceAll("\n", nl)))
    }
    const out = cli("build")
    const m = /released #(\d+) \((\S+)\)/.exec(out)
    if (!m) throw new Error(`ota build said:\n${out.trim().split("\n").slice(-5).join("\n")}`)
    return { serial: Number(m[1]), id: m[2] }
  } finally {
    restoreBackup()
  }
}

const publish = (serial: number) => cli("publish", "--channel", "staging", "--bundle", String(serial))

// ---- The fault proxy: the phone talks to it; it passes everything to the real server, or breaks it on purpose -------

type Fault = "none" | "zip" | "bundle-sig" | "pointer-sig" | "replay" | "cut" | "slow" | "stall-check" | "stall-file"
let fault: Fault = "none"
let replay: string | null = null
/** Check answers that carried a pointer, oldest first (for the replay case). */
const answers: Array<{ seq: number; target: string; text: string }> = []
let onFileRequest: (() => void) | null = null

/**
 * One base64 character changed at 3/4 of the signature: inside the second number of the DER signature (not a length
 * byte), so it still parses and is simply wrong.
 */
const breakSig = (b64: string) => {
  const i = Math.floor(b64.length * 0.75)
  return b64.slice(0, i) + (b64[i] === "A" ? "B" : "A") + b64.slice(i + 1)
}

function startProxy() {
  return Bun.serve({
    port: PORT,
    hostname: "127.0.0.1",
    idleTimeout: 0, // Bun's default closes a quiet connection after 10 s, which would hide a stall
    async fetch(req) {
      const url = new URL(req.url)
      const target = `http://127.0.0.1:${INNER_PORT}${url.pathname}${url.search}`
      const headers = new Headers(req.headers)
      headers.delete("host")
      if (url.pathname === "/v1/check") {
        const body = await req.text()
        if (fault === "stall-check") return new Promise<Response>(() => {}) // accepts, never answers
        if (fault === "replay" && replay) return new Response(replay, { headers: { "content-type": "application/json" } })
        const r = await fetch(target, { method: "POST", body, headers })
        let text = await r.text()
        if (r.ok) {
          const j = JSON.parse(text)
          if (j.pointer) answers.push({ seq: j.pointer.seq, target: j.pointer.target, text })
          if (fault === "bundle-sig" && j.bundle) j.bundle.signature.value = breakSig(j.bundle.signature.value)
          if (fault === "pointer-sig" && j.pointer) j.pointer.signature.value = breakSig(j.pointer.signature.value)
          text = JSON.stringify(j)
        }
        return new Response(text, { status: r.status, headers: { "content-type": "application/json" } })
      }
      if (url.pathname.startsWith("/v1/files/")) {
        onFileRequest?.()
        const r = await fetch(target, { headers })
        const bytes = new Uint8Array(await r.arrayBuffer())
        const h = new Headers()
        for (const k of ["content-type", "content-range", "accept-ranges", "etag"]) {
          const v = r.headers.get(k)
          if (v) h.set(k, v)
        }
        if (fault === "zip" && bytes.length > 0) bytes[bytes.length >> 1] ^= 0xff
        if (fault === "cut") {
          // Half the bytes, then the connection breaks (a network cut).
          const half = bytes.slice(0, bytes.length >> 1)
          const stream = new ReadableStream({
            start(c) {
              c.enqueue(half)
              setTimeout(() => c.error(new Error("cut on purpose")), 300)
            },
          })
          return new Response(stream, { status: r.status, headers: h })
        }
        if (fault === "stall-file") {
          // Half the bytes, then silence: the connection stays open and nothing more comes.
          const half = bytes.slice(0, bytes.length >> 1)
          return new Response(new ReadableStream({ start: (c) => c.enqueue(half) }), { status: r.status, headers: h })
        }
        if (fault === "slow") {
          // 8 KB every 400 ms: a 128 KB zip takes ~6 s, time to kill the app in the middle.
          let at = 0
          const stream = new ReadableStream({
            async pull(c) {
              if (at >= bytes.length) return c.close()
              await sleep(400)
              c.enqueue(bytes.slice(at, at + 8192))
              at += 8192
            },
          })
          return new Response(stream, { status: r.status, headers: h })
        }
        return new Response(bytes, { status: r.status, headers: h })
      }
      return fetch(target, { method: req.method, headers })
    },
  })
}

// ---- The cases (docs/ota-test-matrix.md), in order: each starts from the state the one before left ------------------

interface Case {
  id: string
  title: string
  run: () => Promise<string | void>
}

let b: Record<string, { serial: number; id: string }> = {}
let proxy: ReturnType<typeof startProxy> | null = null
let apkSerialChanged = false

const cases: Case[] = [
  {
    id: "first-install",
    title: "First install: runs the APK's bundle, nothing to download",
    async run() {
      await launch()
      await expectLog(/running bundle sample_0@/)
      return await expectLog(/check staging: NONE NO_CHANNEL/)
    },
  },
  {
    id: "update",
    title: "Publish #1: downloads, runs from the next cold start, becomes healthy",
    async run() {
      b.a = release("good", "A")
      publish(b.a.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.a.id} \\([^)]*\\); it runs from the next start`))
      await launch()
      await expectLog(new RegExp(`running bundle ${b.a.id}@`))
      await expectText(/^OTA A$/)
      return await expectLog(new RegExp(`safety: ${b.a.id} is healthy`))
    },
  },
  {
    id: "check-stall",
    title: "The server accepts a check and never answers: it fails after 30 s, applyNow answers, the next check works",
    async run() {
      fault = "stall-check"
      await launch()
      await openDeepLink("dev/updates")
      await tap("Apply now") // waits behind the stalled check on the same thread
      const line = await expectLog(/check failed \(server\): no full answer within 30 s/, 45_000)
      await expectText(/^Apply: /)
      fault = "none"
      await launch()
      await expectLog(/check staging: /)
      return line
    },
  },
  {
    id: "download-stall",
    title: "A download stops halfway with the connection open: it fails after 60 s, the next check resumes it",
    async run() {
      b.stall = release("good", "S")
      publish(b.stall.serial)
      fault = "stall-file"
      await launch()
      const line = await expectLog(/check failed \(download\): no data for 60 s/, 80_000)
      fault = "none"
      await launch()
      await expectLog(new RegExp(`resuming ${b.stall.id} at \\d+ of \\d+ bytes`))
      await expectLog(new RegExp(`installed ${b.stall.id}`))
      await launch() // back to what the next case expects: a healthy downloaded bundle runs
      await expectLog(new RegExp(`safety: ${b.stall.id} is healthy`))
      return line
    },
  },
  {
    id: "swipe-update",
    title: "Swipe from recents, reopen: starts fresh in the same process, and a waiting update runs",
    async run() {
      await launch()
      await expectLog(new RegExp(`safety: ${b.stall.id} is healthy`))
      const pid = shell("pidof", PKG).trim()
      await swipeAway()
      shell("am", "start", "-n", `${PKG}/.MainActivity`)
      await expectLog(/nav: a new Activity without saved state/)
      await expectText(/^OTA S$/) // no update waits: the same bundle, fresh
      await expectNoLog(/apply: now running/, 500)
      b.w = release("good", "W")
      publish(b.w.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.w.id}`))
      const pid2 = shell("pidof", PKG).trim()
      await swipeAway()
      clearLog()
      shell("am", "start", "-n", `${PKG}/.MainActivity`)
      const line = await expectLog(new RegExp(`report: applied ${b.w.id}: fresh start`))
      await expectText(/^OTA W$/)
      await expectLog(new RegExp(`safety: ${b.w.id} is healthy`))
      check(shell("pidof", PKG).trim() === pid2 && pid !== "", "the process changed: this phone didn't keep it alive")
      return line
    },
  },
  {
    id: "swipe-bad-update",
    title: "The same with a bundle that throws at start: the bundle that ran comes back, fresh",
    async run() {
      b.badSwipe = release("throw-start", "WB")
      publish(b.badSwipe.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.badSwipe.id}`))
      await swipeAway()
      clearLog()
      shell("am", "start", "-n", `${PKG}/.MainActivity`)
      const line = await expectLog(new RegExp(`report: apply_failed ${b.badSwipe.id}`))
      // By log, not on screen: in debug builds the dev error screen covers the app after any JS error.
      await expectLog(new RegExp(`apply: now running ${b.w.id} .*1 screen\\(s\\) opened again`))
      await expectLog(new RegExp(`safety: ${b.w.id} is healthy`))
      return line
    },
  },
  {
    id: "crash-on-return",
    title: "The last good bundle crashes on return from the UPI app, 3 times with the background between: blocked on the third",
    async run() {
      b.ret = release("good", "R")
      publish(b.ret.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.ret.id}`))
      await launch()
      await expectLog(new RegExp(`safety: ${b.ret.id} is healthy`))
      for (let i = 1; i <= 3; i++) {
        await openDeepLink("dev/crash")
        await scrollToAndTap("Open the mock UPI app")
        await sleep(2500)
        check(/topResumedActivity.*p2pupiapp/.test(shell("dumpsys", "activity", "activities")), "the mock UPI app didn't open")
        // The mock has two screens to go back through; then we are in front again.
        const onTop = (re: RegExp) => re.test(shell("dumpsys", "activity", "activities").match(/topResumedActivity.*/)?.[0] ?? "")
        for (let k = 0; k < 4 && !onTop(/zeronative\.sample/); k++) {
          shell("input", "keyevent", "KEYCODE_BACK")
          await sleep(1000)
        }
        check(onTop(/zeronative\.sample/), "the sample didn't come back from the mock UPI app")
        await sleep(800)
        await tap("Crash the app")
        await closeCrashDialog(await expectLog(/crashing on purpose/))
        await launch()
        await expectLog(new RegExp(`launch_crashed ${b.ret.id}: crash \\(${i} of 3\\)`))
      }
      const line = await expectLog(new RegExp(`report: watchdog_block ${b.ret.id}`))
      await expectNoLog(new RegExp(`running bundle ${b.ret.id}@`), 500)
      return line
    },
  },
  {
    id: "apply-now",
    title: "applyNow during a visit: the new bundle runs at once",
    async run() {
      b.b = release("good", "B")
      publish(b.b.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.b.id}`))
      await openDeepLink("dev/updates")
      await tap("Apply now")
      const line = await expectLog(new RegExp(`apply: now running ${b.b.id}`))
      await expectLog(new RegExp(`safety: ${b.b.id} is healthy`))
      return line
    },
  },
  {
    id: "hold",
    title: "holdApply (a checkout): applyNow is refused until released",
    async run() {
      b.c = release("good", "C")
      publish(b.c.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.c.id}`))
      await openDeepLink("dev/updates")
      await tap("Hold updates")
      await tap("Apply now")
      await expectText(/^Apply: held$/)
      await expectNoLog(new RegExp(`apply: now running ${b.c.id}`), 1500)
      await tap("Release hold")
      await tap("Apply now")
      const line = await expectLog(new RegExp(`apply: now running ${b.c.id}`))
      await expectLog(new RegExp(`safety: ${b.c.id} is healthy`))
      return `held, then: ${line}`
    },
  },
  {
    id: "rollback-kept",
    title: "Roll back to a kept bundle: no download",
    async run() {
      publish(b.a.serial)
      await launch()
      const line = await expectLog(/check staging: USE_LOCAL KEPT/)
      await expectNoLog(/installed /, 500)
      await launch()
      await expectLog(new RegExp(`running bundle ${b.a.id}@`))
      await expectLog(new RegExp(`safety: ${b.a.id} is healthy`))
      return line
    },
  },
  {
    id: "kill-switch",
    title: "Kill switch: back to the APK's bundle",
    async run() {
      cli("kill", "--channel", "staging", "--confirm", "KILL STAGING", "--reason", "phone matrix")
      await launch()
      const line = await expectLog(/check staging: BUILT_IN KILL_SWITCH/)
      await launch()
      await expectLog(/running bundle sample_0@/)
      return line
    },
  },
  {
    id: "throw-start",
    title: "A bundle that throws at start: blocked and rolled back in the same launch",
    async run() {
      b.throwStart = release("throw-start", "TS")
      publish(b.throwStart.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.throwStart.id}`))
      await launch()
      const line = await expectLog(new RegExp(`report: error_rollback ${b.throwStart.id}`))
      await expectLog(/safety: rollback done/)
      return line
    },
  },
  {
    id: "blocked-pointer",
    title: "The channel points to a blocked bundle again: nothing downloaded",
    async run() {
      publish(b.throwStart.serial)
      await launch()
      const line = await expectLog(/check staging: NONE BLOCKED/)
      await expectNoLog(/installed /, 500)
      return line
    },
  },
  {
    id: "watchdog",
    title: "A bundle that crashes before healthy: blocked after 1 crash (Android 11+)",
    async run() {
      b.crash = release("crash-home", "CR")
      publish(b.crash.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.crash.id}`))
      await launch()
      await closeCrashDialog(await expectLog(/crashing on purpose/))
      // The next start judges the crash; logs aren't cleared, to keep the crash lines.
      shell("am", "start", "-n", `${PKG}/.MainActivity`)
      await expectLog(new RegExp(`launch_crashed ${b.crash.id}: crash \\(1 of 1\\)`))
      return await expectLog(new RegExp(`report: watchdog_block ${b.crash.id}`))
    },
  },
  {
    id: "last-good-error",
    title: "An error screen on the phone's last good bundle: reported only, not blocked",
    async run() {
      b.second = release("throw-second", "TW")
      publish(b.second.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.second.id}`))
      await launch()
      await expectLog(new RegExp(`safety: ${b.second.id} is healthy`))
      await launch()
      const line = await expectLog(new RegExp(`${b.second.id} is the last good bundle: .*reported, not blocked`))
      await expectNoLog(new RegExp(`error_rollback ${b.second.id}`), 1000)
      await launch()
      await expectLog(new RegExp(`running bundle ${b.second.id}@`))
      return line
    },
  },
  {
    id: "incompatible",
    title: "An older app offered a bundle that needs a module it lacks: ignored",
    async run() {
      b.module = release("needs-module", "NM")
      publish(b.module.serial)
      await launch()
      const line = await expectLog(/check staging: NONE INCOMPATIBLE/)
      await expectNoLog(/installed /, 500)
      return line
    },
  },
  {
    id: "tampered-zip",
    title: "A tampered zip: refused, nothing installed; the real one installs after",
    async run() {
      b.d = release("good", "D")
      publish(b.d.serial)
      fault = "zip"
      await launch()
      const line = await expectLog(/check failed \(zip_sha\)/)
      fault = "none"
      await launch()
      await expectLog(new RegExp(`installed ${b.d.id}`))
      return line
    },
  },
  {
    id: "bad-bundle-signature",
    title: "A wrong bundle signature: refused",
    async run() {
      b.e = release("good", "E")
      publish(b.e.serial)
      fault = "bundle-sig"
      await launch()
      const line = await expectLog(/check failed \(signature\)/)
      fault = "none"
      return line
    },
  },
  {
    id: "bad-pointer-signature",
    title: "A wrong pointer signature: the whole answer is ignored",
    async run() {
      fault = "pointer-sig"
      await launch()
      const line = await expectLog(/check staging: NONE POINTER_REFUSED/)
      await expectNoLog(/installed /, 500)
      fault = "none"
      return line
    },
  },
  {
    id: "replayed-pointer",
    title: "A replayed old answer (lower seq, valid signature): refused",
    async run() {
      const old = answers.find((x) => x.target === b.a.id)
      check(old, "no recorded answer for the first bundle")
      replay = old.text
      fault = "replay"
      await launch()
      const line = await expectLog(/check staging: NONE POINTER_REFUSED/)
      fault = "none"
      replay = null
      await launch()
      await expectLog(new RegExp(`installed ${b.e.id}`))
      return `${line} (replayed seq ${old.seq})`
    },
  },
  {
    id: "network-cut",
    title: "The network breaks mid-download: the next check resumes it",
    async run() {
      b.f = release("good", "F")
      publish(b.f.serial)
      fault = "cut"
      console.log("  (Bun prints the proxy's \"cut on purpose\" error below: expected)")
      await launch()
      await expectLog(/check failed/)
      fault = "none"
      await launch()
      const line = await expectLog(new RegExp(`resuming ${b.f.id} at \\d+ of \\d+ bytes`))
      await expectLog(new RegExp(`installed ${b.f.id}`))
      return line
    },
  },
  {
    id: "kill-download",
    title: "The app is killed mid-download: the next start resumes it",
    async run() {
      b.g = release("good", "G")
      publish(b.g.serial)
      fault = "slow"
      const started = new Promise<void>((ok) => (onFileRequest = ok))
      await launch()
      await Promise.race([started, sleep(20_000)])
      onFileRequest = null
      await sleep(2500)
      forceStop()
      fault = "none"
      await launch()
      const line = await expectLog(new RegExp(`resuming ${b.g.id} at \\d+ of \\d+ bytes`))
      await expectLog(new RegExp(`installed ${b.g.id}`))
      return line
    },
  },
  {
    id: "low-storage",
    title: "Low storage: no download (no_space), the app runs on; installs once there is room",
    async run() {
      b.h = release("good", "H")
      publish(b.h.serial)
      shell("setprop", "debug.zn.ota_free_bytes", "1000000")
      try {
        await launch()
        await expectLog(/OTA sees 1000000 bytes free/)
        const line = await expectLog(/check failed \(no_space\)/)
        await expectNoLog(/installed /, 500)
        shell("setprop", "debug.zn.ota_free_bytes", "0")
        await launch()
        await expectLog(new RegExp(`installed ${b.h.id}`))
        return line
      } finally {
        shell("setprop", "debug.zn.ota_free_bytes", "0")
      }
    },
  },
  {
    id: "background-start",
    title: "A start without UI (like a push): no check, not a watched launch",
    async run() {
      // b.h is installed and runs from the next start, never run yet: a UI start would mark its launch.
      shell("input", "keyevent", "KEYCODE_WAKEUP")
      forceStop()
      await sleep(800)
      clearLog()
      shell("content", "query", "--uri", "content://dev.zeronative.sample.debugwake/start") // DebugWakeProvider
      await expectLog(/background start: no Activity/)
      await expectLog(new RegExp(`running bundle ${b.h.id}@`))
      await expectNoLog(/launch of .* marked|check staging/, 8000)
      await launch() // force-stops that process first: a pending launch would now be judged
      await expectLog(new RegExp(`launch of ${b.h.id} marked`))
      await expectNoLog(/the last launch ended/, 1000)
      await expectLog(new RegExp(`safety: ${b.h.id} is healthy`))
      return "no check and no launch mark without UI; the UI start after it judged nothing"
    },
  },
  {
    id: "killed-install",
    title: "Files a kill mid-install could leave (half folder, a broken `current`): the last good bundle runs and is reported",
    async run() {
      forceStop()
      asApp(`mkdir -p ${OTA_DIR}/tmp/sample_99 ${OTA_DIR}/bundles/sample_98 && echo half > ${OTA_DIR}/tmp/sample_99/main.hbc && echo half > ${OTA_DIR}/bundles/sample_98/main.hbc && echo sample_98 > ${OTA_DIR}/current`)
      await launch()
      const line = await expectLog(/bundle: not running sample_98: /)
      await expectLog(new RegExp(`running bundle ${b.h.id}@`))
      await expectLog(/report: bundle_unusable sample_98/)
      await expectLog(/check staging: /)
      return line
    },
  },
  {
    id: "unusable-no-good",
    title: "A broken `current` and no last good bundle: the APK's bundle runs, `current` is removed",
    async run() {
      forceStop()
      asApp(`rm ${OTA_DIR}/health.json; echo sample_98 > ${OTA_DIR}/current`)
      await launch()
      const line = await expectLog(/bundle: not running sample_98: /)
      await expectLog(/running bundle sample_0@/)
      await expectLog(/report: bundle_unusable sample_98/)
      await launch()
      await expectNoLog(/not running sample_98/, 2000)
      return line
    },
  },
  {
    id: "result-alive",
    title: "Another app's result, process alive: saved, heard, comes again at the next start until ack; a wrong id clears nothing",
    async run() {
      await launchScreen()
      await openMock(true)
      await leaveMock()
      const line = await expectLog(/launch-test heard: result t\d+ code 0/)
      await tap("Wrong ack")
      await expectLog(/launch-test wrong ack: false/)
      forceStop()
      await sleep(800)
      clearLog()
      await openDeepLink("dev/launch")
      await expectLog(/launch-test first read: result t\d+/)
      await expectLog(/launch-test heard: result t\d+/)
      await tap("Open mock")
      await expectLog(/launch-test open: launched=false reason=unacked/)
      await tap("Ack")
      await expectLog(/launch-test ack: true/)
      await tap("Missing app")
      await expectLog(/launch-test missing: launched=false reason=no_app/)
      return line
    },
  },
  {
    id: "result-after-kill",
    title: "Android kills the process while the other app is open: the first screen of the new process already reads the result",
    async run() {
      await launchScreen()
      await openMock(true)
      const before = shell("pidof", PKG).trim()
      shell("am", "kill", PKG)
      await sleep(1000)
      if (shell("pidof", PKG).trim()) asApp(`kill -9 ${before}`)
      await sleep(1000)
      check(!shell("pidof", PKG).trim(), "the process didn't end")
      clearLog()
      await leaveMock()
      const line = await expectLog(/launch-test first read: /)
      check(/first read: result t\d+ code/.test(line), `the first read must be the result: ${line}`)
      await expectLog(/Android restored the app; reopening 2 screen/)
      await expectLog(/launch-test heard: result t\d+/)
      await sleep(800)
      await tap("Ack")
      await expectLog(/launch-test ack: true/)
      return line
    },
  },
  {
    id: "late-result-after-kill",
    title: "The same, with the result after the resume (seen on the Lava): the resume waits for it; the first read is the result",
    async run() {
      shell("setprop", "debug.zn.launch_result_delay_ms", "300")
      try {
        await launchScreen()
        await openMock(true)
        const before = shell("pidof", PKG).trim()
        shell("am", "kill", PKG)
        await sleep(1000)
        if (shell("pidof", PKG).trim()) asApp(`kill -9 ${before}`)
        await sleep(1000)
        check(!shell("pidof", PKG).trim(), "the process didn't end")
        clearLog()
        await leaveMock()
        await expectLog(/launch results come 300 ms late/)
        await expectLog(/no result yet at the resume; waiting up to 1000 ms/)
        const line = await expectLog(/launch-test first read: /)
        check(/first read: result t\d+ code/.test(line), `the first read must be the result: ${line}`)
        await expectNoLog(/no result came/, 0)
        await sleep(800)
        await tap("Ack")
        await expectLog(/launch-test ack: true/)
        return line
      } finally {
        shell("setprop", "debug.zn.launch_result_delay_ms", "0")
      }
    },
  },
  {
    id: "result-after-the-wait",
    title: "A result later than the wait: marked lost, then the result replaces it",
    async run() {
      shell("setprop", "debug.zn.launch_result_delay_ms", "1800")
      try {
        await launchScreen()
        await openMock(true)
        const before = shell("pidof", PKG).trim()
        shell("am", "kill", PKG)
        await sleep(1000)
        if (shell("pidof", PKG).trim()) asApp(`kill -9 ${before}`)
        await sleep(1000)
        check(!shell("pidof", PKG).trim(), "the process didn't end")
        clearLog()
        await leaveMock()
        // A busy main thread at a cold start can run both late, so the first read may already be the result.
        const line = await expectLog(/launch mock-upi: no result came/)
        await expectLog(/launch-test first read: (lost|result) t\d+/)
        await expectLog(/launch-test heard: result t\d+ code/)
        await sleep(800)
        await tap("Ack")
        await expectLog(/launch-test ack: true/)
        return line
      } finally {
        shell("setprop", "debug.zn.launch_result_delay_ms", "0")
      }
    },
  },
  {
    id: "result-under-see-through",
    title: "The process dies under a see-through window: Android can't keep our Activity; the next open reads lost",
    async run() {
      await launchScreen()
      await openMock(false)
      check(!focused().includes("PaymentActivity"), "the payment screen came too soon")
      asApp(`kill -9 ${shell("pidof", PKG).trim()}`)
      await sleep(1200)
      check(!shell("pidof", PKG).trim(), "the process didn't end")
      await leaveMock()
      shell("am", "force-stop", MOCK)
      clearLog()
      await openDeepLink("dev/launch")
      const line = await expectLog(/launch-test first read: /)
      check(/first read: lost t\d+/.test(line), `expected lost: ${line}`)
      await tap("Ack")
      await expectLog(/launch-test ack: true/)
      return line
    },
  },
  {
    id: "no-result-after-swipe",
    title: "The app is swiped away while the other app is open: lost, and a fresh start works",
    async run() {
      await launchScreen()
      await openMock(true)
      clearLog()
      await swipeAway()
      await sleep(800)
      await openDeepLink("dev/launch")
      const line = await expectLog(/launch-test first read: /)
      check(/first read: lost t\d+/.test(line), `expected lost: ${line}`)
      await tap("Ack")
      await expectLog(/launch-test ack: true/)
      return line
    },
  },
  {
    id: "link-while-waiting",
    title: "A link while the other app is open reaches onLink; JS isn't restarted and the other app stays on top",
    async run() {
      await launchScreen()
      await openMock(true)
      const before = shell("pidof", PKG).trim()
      clearLog()
      shell("am", "start", "-a", "android.intent.action.VIEW", "-d", "zn://sample/offers?refuse=1", PKG)
      const line = await expectLog(/sample: link zn:\/\/sample\/offers\?refuse=1 atStart=false/)
      await expectLog(/a second Activity while the app runs/)
      await sleep(1500)
      check(focused().includes(MOCK), `the other app must stay on top: ${focused()}`)
      check(shell("pidof", PKG).trim() === before, "the process changed")
      await expectNoLog(/starting fresh/, 0)
      await leaveMock()
      await sleep(800)
      await tap("Ack")
      await expectLog(/launch-test ack: true/)
      return line
    },
  },
  {
    id: "start-link-refused",
    title: "The link guard is asked about the link that started the app; refused, the start screen shows",
    async run() {
      forceStop()
      await sleep(800)
      clearLog()
      await openDeepLink("offers?refuse=1")
      const line = await expectLog(/sample: link zn:\/\/sample\/offers\?refuse=1 atStart=true/)
      await expectText(/^Pay a merchant$/)
      return line
    },
  },
  {
    id: "result-survives-rollback",
    title: "A result not acked, then a bad update rolls back: the same result is still there for the bundle that runs",
    async run() {
      b.rs = release("good", "RS")
      publish(b.rs.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.rs.id}`))
      await launchScreen()
      await expectLog(new RegExp(`running bundle ${b.rs.id}@`))
      await openMock(true)
      await leaveMock()
      const heard = await expectLog(/launch-test heard: result (t\d+) code/)
      const id = /result (t\d+)/.exec(heard)![1]
      b.rsBad = release("throw-start", "RT")
      publish(b.rsBad.serial)
      await launch()
      await expectLog(new RegExp(`installed ${b.rsBad.id}`))
      await launch()
      await expectLog(new RegExp(`report: error_rollback ${b.rsBad.id}`))
      await launch()
      await expectLog(new RegExp(`running bundle ${b.rs.id}@`))
      await openDeepLink("dev/launch")
      const line = await expectLog(new RegExp(`launch-test first read: result ${id} code`))
      await expectLog(new RegExp(`launch-test heard: result ${id} code`))
      await tap("Ack")
      await expectLog(/launch-test ack: true/)
      return line
    },
  },
  {
    id: "server-down",
    title: "The update server can't be reached: the check fails quietly, the app runs",
    async run() {
      proxy?.stop(true)
      proxy = null
      try {
        await launch()
        await expectLog(/running bundle /)
        return await expectLog(/check failed \(failed\)/)
      } finally {
        proxy = startProxy()
      }
    },
  },
  {
    id: "apk-newer",
    title: "An APK update newer than the OTA bundles: its own bundle runs, old ones are deleted",
    async run() {
      run(["bun", "run", "examples/sample/build.ts", "--serial", "50"])
      apkSerialChanged = true
      gradle(":sample:assembleDebug")
      check(adb("install", "-r", apk).includes("Success"), "install of the serial-50 APK failed")
      await launch()
      await expectLog(/running bundle sample_50@/)
      const line = await expectLog(/new APK: \d+ bundle\(s\) that no longer fit/)
      await expectLog(/check staging: NONE APK_NEWER/)
      return line
    },
  },
  {
    id: "permission-grant",
    title: "Permissions: never asked reads denied; the dialog grants; a second request shows no dialog",
    async run() {
      forceStop()
      shell("pm", "clear", PKG) // last: this also clears the app's OTA files
      clearLog()
      await openDeepLink("dev/launch")
      await tap("Camera status")
      await expectLog(/launch-test camera status: denied/)
      await tap("Ask camera")
      await sleep(1200)
      await tap("While using the app")
      const line = await expectLog(/launch-test camera: granted/)
      clearLog()
      await tap("Ask camera")
      await expectLog(/launch-test camera: granted/)
      return line
    },
  },
  {
    id: "permission-blocked",
    title: "Permissions: closing the dialog isn't a refusal; a first refusal is denied; a second is blocked, with no dialog after",
    async run() {
      forceStop()
      shell("pm", "clear", PKG)
      clearLog()
      await openDeepLink("dev/launch")
      await tap("Ask camera")
      await sleep(1200)
      shell("input", "keyevent", "KEYCODE_BACK")
      await expectLog(/launch-test camera: denied/)
      clearLog()
      await tap("Ask camera")
      await sleep(1200)
      await tap("Don't allow")
      await expectLog(/launch-test camera: denied/)
      clearLog()
      await tap("Ask camera")
      await sleep(1200)
      await tap("Don't allow")
      const line = await expectLog(/launch-test camera: blocked/)
      await tap("Camera status")
      await expectLog(/launch-test camera status: blocked/)
      return line
    },
  },
  {
    id: "icon-handle",
    title: "A zn:// handle shows the mock's icon, a handle that fails is a normal image error, and Os and plugin events work",
    async run() {
      forceStop()
      shell("pm", "clear", PKG) // leaves CAMERA as Android first set it
      await sleep(800)
      clearLog()
      await openDeepLink("dev/launch")
      const line = await expectLog(/image failed: zn:\/\/app-icon\/dev\.zeronative\.no\.such\.app/)
      await expectNoLog(/image failed: zn:\/\/app-icon\/p2pdops/, 500)
      await expectLog(/activity event: front/)
      await tap("Os info")
      await expectLog(/launch-test os: 0\.1\.0 build 1, /)
      await tap("Haptic")
      await expectLog(/launch-test haptic: /)
      await tap("Bad link")
      await expectLog(/launch-test failed: not_allowed/)
      return line
    },
  },
]

// ---- Run ------------------------------------------------------------------------------------------------------------

async function main() {
  if (args.list) {
    for (const c of cases) console.log(`${c.id.padEnd(22)} ${c.title}`)
    return
  }
  if (args.until && !cases.some((c) => c.id === args.until)) throw new Error(`no case "${args.until}" (--list)`)
  restoreBackup(true)

  const devices = adb("devices").split(/\r?\n/).slice(1).filter((l) => /\tdevice$/.test(l))
  // ANDROID_SERIAL (adb's own variable) picks one device when a phone and an emulator are both connected.
  const serial = process.env.ANDROID_SERIAL
  if (serial ? !devices.some((l) => l.startsWith(`${serial}\t`)) : devices.length !== 1) {
    throw new Error(serial ? `ANDROID_SERIAL=${serial} is not on adb` : `need exactly one phone on adb, found ${devices.length} (set ANDROID_SERIAL)`)
  }
  shell("input", "keyevent", "KEYCODE_WAKEUP")
  if (/mDreamingLockscreen=true|mShowingLockscreen=true/.test(shell("dumpsys", "window"))) {
    throw new Error("the phone is locked: unlock it and run again")
  }

  console.log("• building the debug sample (serial 0) and installing it fresh…")
  run(["bun", "run", "examples/sample/build.ts"])
  gradle(":sample:assembleDebug")
  adb("uninstall", PKG)
  check(adb("install", apk).includes("Success"), "install failed")

  rmSync(work, { recursive: true, force: true })
  mkdirSync(storeDir, { recursive: true })
  const server = startServer({ storeRoot: storeDir, dataDir, port: INNER_PORT, log: false })
  proxy = startProxy()
  adb("reverse", `tcp:${PORT}`, `tcp:${PORT}`)
  const timeout = shell("settings", "get", "system", "screen_off_timeout").trim()
  shell("settings", "put", "system", "screen_off_timeout", "1800000")

  const results: Array<{ id: string; ok: boolean; s: number; note: string }> = []
  try {
    for (const c of cases) {
      const t0 = Date.now()
      process.stdout.write(`▶ ${c.id}: ${c.title}\n`)
      try {
        const note = (await c.run()) ?? ""
        results.push({ id: c.id, ok: true, s: (Date.now() - t0) / 1000, note })
        console.log(`  ✓ ${note}`)
      } catch (e) {
        const note = e instanceof Error ? e.message : String(e)
        results.push({ id: c.id, ok: false, s: (Date.now() - t0) / 1000, note })
        console.log(`  ✗ ${note}`)
        const logFile = join(work, `${c.id}.log`) // the phone's log since the last cold start, to see why
        writeFileSync(logFile, adb("logcat", "-d", "-v", "time"))
        console.log(`    phone log: ${logFile}`)
        fault = "none"
        replay = null
        if (!(e instanceof Fail)) break // a tool problem (build, adb): later cases would fail for the same reason
      }
      if (c.id === args.until) break
    }
  } finally {
    console.log("• putting things back…")
    shell("setprop", "debug.zn.ota_free_bytes", "0")
    shell("setprop", "debug.zn.launch_result_delay_ms", "0")
    if (/^\d+$/.test(timeout)) shell("settings", "put", "system", "screen_off_timeout", timeout)
    adb("reverse", "--remove", `tcp:${PORT}`)
    proxy?.stop(true)
    server.stop(true)
    if (apkSerialChanged) {
      run(["bun", "run", "examples/sample/build.ts"]) // the APK's assets back to serial 0
      gradle(":sample:assembleDebug")
      adb("install", "-r", apk)
    }
    forceStop()
  }

  const passed = results.filter((r) => r.ok).length
  const table = [
    `| Case | Result | Time | Proof |`,
    `|---|---|---|---|`,
    ...results.map((r) => `| ${r.id} | ${r.ok ? "pass" : "**FAIL**"} | ${r.s.toFixed(0)} s | ${r.note.replace(/[VDIWEF]\/[\w-]+\s*\(\s*\d+\):\s*/, "").replaceAll("|", "\\|")} |`),
  ].join("\n")
  writeFileSync(join(work, "results.md"), `# Phone matrix ${new Date().toISOString()}\n\n${table}\n`)
  console.log(`\n${passed} of ${results.length} passed (of ${cases.length} cases); table in .zn-ota-test/results.md`)
  if (passed !== results.length || results.length !== cases.length) process.exitCode = 1
}

await main().catch((e) => {
  restoreBackup(true)
  console.error(`✗ ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
