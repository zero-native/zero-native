// OTA end to end on a real Android phone, over adb, for any zn app that uses the zn-updates server
// (docs/zn-updates-phone-suite.md). It also works with a release-type build (not debuggable): it never uses
// `run-as` or a debug helper. It only uses what any phone owner can see: the app's log lines (tags zn-ota, zn, zn-push),
// `pidof`, `am start` / `am kill`, and the server's admin API (which bundle each phone runs, and its events).
//
//   bun run updates:phone --app-dir <app folder> --package <package> [--serial <adb serial>] [--channel staging]
//                         [--server <url>] [--until <case>] [--push-wait 90] [--healthy-wait 20] [--no-logs] [--list]
//
// What it changes: the channel (it publishes small test bundles and a kill switch to --channel; never production),
// and the phone's screen timeout for a while (put back at the end). The app on the phone is only started and ended;
// never force-stopped (on a MediaTek phone a force stop breaks the app's WebView: android-phone-notes.md).
// A test bundle is the app's real build plus one small text file (zn-suite-marker.txt) with a new value each time:
// the bytes differ, the app does not. Nothing in the app's folder is changed.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { readBundleInfo, writeBundleInfo } from "../bundle-info"
import { BUILT_IN, publicKeyOf } from "../ota/signing"
import { type Conn, type PushResult, call, changeChannel, uploadBuilt } from "./client"

const { values: a } = parseArgs({
  options: {
    "app-dir": { type: "string" },
    package: { type: "string" },
    serial: { type: "string" },
    channel: { type: "string" },
    server: { type: "string" },
    key: { type: "string" },
    until: { type: "string" },
    "push-wait": { type: "string" },
    "healthy-wait": { type: "string" },
    "no-logs": { type: "boolean" },
    list: { type: "boolean" },
  },
})

const repoRoot = resolve(import.meta.dir, "..", "..")
const home = join(homedir(), ".zero-native")
const outDir = join(repoRoot, ".zn-updates-phone")
const appDir = resolve(a["app-dir"] ?? process.cwd())
const channel = (a.channel ?? "staging").toLowerCase()
const pushWaitS = Number(a["push-wait"] ?? "90")
const healthyWaitS = Number(a["healthy-wait"] ?? "20")
const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12) + "-" + Math.random().toString(36).slice(2, 6)

class Fail extends Error {}
/** The case can't run here (not a failure): its note says why. */
class Skip extends Error {}

const sleep = (ms: number) => Bun.sleep(ms)
const say = (s: string) => console.log(s)

// ---- Phone: adb ---------------------------------------------------------------------------------------------------------

let serial = ""
let pkg = ""
let component = ""

const adbArgs = (args: string[]) => (serial ? ["-s", serial, ...args] : args)

function adb(args: string[], timeoutMs = 30_000): string {
  const p = Bun.spawnSync(["adb", ...adbArgs(args)], { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
  return (p.stdout.toString() + p.stderr.toString()).replace(/\r/g, "")
}

/** One shell command line, run by the phone's shell (so quotes and pipes work there). */
const sh = (cmd: string) => adb(["shell", cmd])

const pidsOfApp = () => sh(`pidof ${pkg}`).trim().split(/\s+/).filter((x) => /^\d+$/.test(x)).map(Number)
const isRunning = () => pidsOfApp().length > 0

function wake() {
  sh("input keyevent KEYCODE_WAKEUP")
}

/**
 * Ends the app the way Android does when memory is low (never `am force-stop`: on a MediaTek phone it blocks the
 * app's WebView until its icon is tapped). Home, open another app, Home, then `am kill` (it only kills a cached process,
 * and skips the app you left last).
 */
async function endApp() {
  for (let i = 0; i < 3; i++) {
    if (!isRunning()) return
    sh("input keyevent KEYCODE_HOME")
    await sleep(800)
    sh("am start -a android.settings.SETTINGS")
    await sleep(1500)
    sh("input keyevent KEYCODE_HOME")
    await sleep(800)
    sh(`am kill ${pkg}`)
    await sleep(1200)
  }
  if (!isRunning()) return
  // `am kill` skips a process Android holds above "cached". On the Lava, ZeroBill's staging app sat at BACKUP_APP_ADJ
  // (300) with no backup running (2026-11-09). Android 14's `am stop-app` ends it without force-stop's "stopped" state,
  // so FCM still reaches it, and DuraSpeed did not suppress it. Checked below, each time.
  sh(`am stop-app ${pkg}`)
  await sleep(1200)
  if (isRunning()) throw new Fail(`${pkg} did not end with "am kill" or "am stop-app" (a foreground service? the app still on screen?). I never force-stop it`)
  if (/stopped=true/.test(sh(`dumpsys package ${pkg}`))) throw new Fail(`"am stop-app" left ${pkg} in the stopped state: FCM won't reach it. Tap its launcher icon once`)
  if (sh("dumpsys duraspeed suppress_list").includes(pkg)) throw new Fail(`DuraSpeed suppressed ${pkg} after "am stop-app": tap its launcher icon once, then run again`)
}

// ---- Phone: the log -----------------------------------------------------------------------------------------------------

interface LogLine {
  pid: number
  level: string
  tag: string
  msg: string
  raw: string
}

const LOG_RE = /^\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(\d+)\s+\d+\s+([VDIWEF])\s+(.*?)\s*: (.*)$/

/** One long `adb logcat` for the whole run. Lines are kept with their pid; the app's pids are found with `pidof`. */
class LogTap {
  lines: LogLine[] = []
  readonly pids = new Set<number>()
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private stopped = false

  start() {
    this.proc = Bun.spawn(["adb", ...adbArgs(["logcat", "-v", "threadtime", "-T", "1", "zn-ota:V", "zn:V", "zn-push:V", "AndroidRuntime:E", "*:S"])], {
      stdout: "pipe",
      stderr: "ignore",
    })
    void this.read(this.proc)
  }

  private async read(p: ReturnType<typeof Bun.spawn>) {
    const dec = new TextDecoder()
    let rest = ""
    try {
      const reader = (p.stdout as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        rest += dec.decode(value, { stream: true })
        const parts = rest.split(/\r?\n/)
        rest = parts.pop() ?? ""
        for (const raw of parts) {
          const m = LOG_RE.exec(raw)
          if (m) this.lines.push({ pid: Number(m[1]), level: m[2]!, tag: m[3]!, msg: m[4]!, raw })
        }
      }
    } catch {
      // the stream ended (the phone went away): restart below
    }
    if (!this.stopped) {
      await sleep(1000)
      if (!this.stopped) this.start()
    }
  }

  stop() {
    this.stopped = true
    this.proc?.kill()
  }

  mark() {
    return this.lines.length
  }

  refreshPids() {
    for (const p of pidsOfApp()) this.pids.add(p)
  }

  /** The app's own lines since [from]. */
  since(from: number): LogLine[] {
    return this.lines.slice(from).filter((l) => this.pids.has(l.pid))
  }

  /** Waits for a line (the message part) matching [re]; null when it didn't come in [ms]. */
  async wait(re: RegExp, from: number, ms: number): Promise<LogLine | null> {
    const end = Date.now() + ms
    for (;;) {
      this.refreshPids()
      const hit = this.since(from).find((l) => re.test(l.msg))
      if (hit) return hit
      if (Date.now() > end) return null
      await sleep(700)
    }
  }
}

const tap = new LogTap()
/** undefined: not known yet. false: the app's log lines never show up (a release build can strip them): the server is the proof. */
let logsWork: boolean | undefined = a["no-logs"] ? false : undefined

// ---- Server -------------------------------------------------------------------------------------------------------------

interface Stats {
  phones: { day: string; running: string; phones: number }[]
  events: { day: string; bundle: string; kind: string; detail: string; count: number }[]
  errors: { at: string; bundle: string; kind: string; detail: string }[]
}

interface ChannelState {
  name: string
  current: { pointer: { target: string; rollout: number; seq: number }; kind: string; at: string } | null
}

interface ServerState {
  app: { id: string; publicKeys: string[]; store: Record<string, unknown>; push: Record<string, unknown> }
  channels: ChannelState[]
}

let conn: Conn
let privatePem = ""
let appId = ""
let buildCmd: string[] = []

const getStats = () => call<Stats>(conn, "GET", `/admin/apps/${appId}/stats?channel=${channel}&days=2`)
const getState = () => call<ServerState>(conn, "GET", `/admin/apps/${appId}/state`)
const todayUtc = () => new Date().toISOString().slice(0, 10)

const evCount = (s: Stats, bundle: string, kind: string) => s.events.filter((e) => e.bundle === bundle && e.kind === kind).reduce((n, e) => n + e.count, 0)
const phonesOn = (s: Stats, test: (running: string) => boolean) => s.phones.filter((p) => p.day === todayUtc() && test(p.running)).reduce((n, p) => n + p.phones, 0)

/** Polls the server's stats until [fn] gives a text (the evidence), or fails after [ms]. */
async function waitServer(what: string, fn: (s: Stats) => string | null, ms = 25_000): Promise<string> {
  const end = Date.now() + ms
  let last: Stats | null = null
  for (;;) {
    last = await getStats()
    const r = fn(last)
    if (r) return r
    if (Date.now() > end) throw new Fail(`server: ${what} was not there after ${Math.round(ms / 1000)} s`)
    await sleep(2000)
  }
}

// ---- Test bundles -------------------------------------------------------------------------------------------------------

interface Rel {
  serial: number
  id: string
}

let workDir = ""
let baseBuilt = ""
let variantNo = 0

function gitInfo(dir: string) {
  const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: dir }).stdout.toString().trim()
  return { commit: run(["rev-parse", "--short=10", "HEAD"]) || "unknown", dirty: run(["status", "--porcelain"]).length > 0 }
}

/** The app's real build, once per run (serial 0, like `updates release`). */
function buildBase() {
  baseBuilt = join(workDir, "base")
  say(`… building ${appId} once (${buildCmd.join(" ")})`)
  const p = Bun.spawnSync([...buildCmd, "--out", baseBuilt, "--serial", "0", "--map", join(workDir, "main.js.map")], { cwd: appDir, stdout: "pipe", stderr: "pipe" })
  if (p.exitCode !== 0) throw new Error(`the app's build failed:\n${(p.stdout.toString() + p.stderr.toString()).split("\n").slice(-12).join("\n")}`)
  const info = readBundleInfo(baseBuilt)
  if (info.app !== appId) throw new Error(`the build is for app "${info.app}", zn-updates.json says "${appId}"`)
}

/** Releases a new test bundle: the base build + a marker file with a new text. Never publishes. */
async function release(): Promise<Rel> {
  if (!baseBuilt) buildBase()
  const n = ++variantNo
  const dir = join(workDir, `variant-${n}`)
  cpSync(baseBuilt, dir, { recursive: true })
  writeFileSync(join(dir, "zn-suite-marker.txt"), `zn-updates phone suite, run ${runId}, test bundle ${n}\n`)
  const base = readBundleInfo(baseBuilt)
  await writeBundleInfo(dir, { app: base.app, serial: 0, names: [...Object.keys(base.files), "zn-suite-marker.txt"], requires: base.requires })
  const g = gitInfo(appDir)
  const r = await uploadBuilt(conn, dir, privatePem, { ...g, subject: `phone suite ${runId} test bundle ${n}` })
  if (r.reused) throw new Fail(`the server already had these bytes as #${r.manifest.serial} (a marker must be new each time)`)
  say(`  released #${r.manifest.serial} (${r.manifest.id})`)
  return { serial: r.manifest.serial, id: r.manifest.id }
}

let changedChannel = false

/**
 * Publishes a test bundle. Quiet by default (no "check now" push), so the cold-start cases test the check at a start
 * alone; with a push the phone may download before the suite's start (seen on ZeroBill staging: the push came in 1 s).
 * Only push-background asks for the push.
 */
async function publish(rel: Rel, why: string, push = false) {
  changedChannel = true
  const r = await changeChannel(conn, privatePem, { app: appId, channel, target: rel.serial, rollout: 100, priority: "normal", reason: `phone suite: ${why}`, push })
  say(`  published ${rel.id} to ${channel} (${r.kind}, seq ${r.pointer.seq})`)
  return r
}

// ---- One cold start with its check --------------------------------------------------------------------------------------

interface Run {
  /** Log position at the start of this run. */
  from: number
  /** The bundle the app runs (null when logs are off). */
  running: string | null
  fromFiles: boolean | null
  check: { channel: string; action: string; reason: string } | null
}

const RUNNING_RE = /bundle: running (\S+) \(#\d+\) (built-in|from files)/
const CHECK_RE = /^check (?:failed \(|\S+: \S+ \S+ in)/

/** End the app, start it fresh (new task), and wait for its check to answer. */
async function startAndCheck(): Promise<Run> {
  wake()
  await endApp()
  const from = tap.mark()
  const out = sh(`am start -f 0x10008000 -n ${component}`)
  if (/Error|Exception/.test(out)) throw new Fail(`am start failed: ${out.trim().split("\n").slice(-2).join(" ")}`)
  await sleep(1500)
  tap.refreshPids()
  const run: Run = { from, running: null, fromFiles: null, check: null }
  if (logsWork !== false) {
    const m = await tap.wait(RUNNING_RE, from, logsWork === undefined ? 25_000 : 20_000)
    if (!m) {
      if (!isRunning()) throw new Fail("the app did not start")
      if (logsWork === undefined) {
        logsWork = false
        say("  ! no zn log lines from the app in 25 s: the build seems to strip its logs. From now on the server is the only proof.")
      } else {
        throw new Fail(`no "bundle: running" line within 20 s of the start, but the earlier starts had log lines`)
      }
    } else {
      logsWork = true
      const r = RUNNING_RE.exec(m.msg)!
      run.running = r[1]!
      run.fromFiles = r[2] === "from files"
    }
  }
  if (logsWork) {
    const c = await tap.wait(CHECK_RE, from, 40_000)
    if (!c) throw new Fail("no check answer in the log within 40 s of the start (is the server reachable from the phone? `adb reverse` for a local server)")
    const f = /^check failed \((\w+)\): (.*)$/.exec(c.msg)
    if (f) throw new Fail(`the phone's check failed (${f[1]}): ${f[2]}`)
    const m = /^check (\S+): (\S+) (\S+) in/.exec(c.msg)!
    run.check = { channel: m[1]!, action: m[2]!, reason: m[3]! }
    if (m[1] !== channel) throw new Fail(`the app checks channel "${m[1]}", not "${channel}"`)
    if (m[3] === "STALE_SEQ") throw new Fail("STALE_SEQ: the phone saw a newer pointer than this server has (a reset server?). Reinstall the app so its OTA state is empty")
    if (m[3] === "POINTER_REFUSED") throw new Fail("the phone refused the channel's pointer (wrong signing key for this APK, or an old seq)")
  } else {
    await sleep(12_000) // the first check comes a few seconds after the app is on screen
  }
  return run
}

function expectCheck(run: Run, action: string, reason: string, ev: string[]) {
  if (!run.check) return
  if (run.check.action !== action || run.check.reason !== reason) throw new Fail(`the check answered ${run.check.action} ${run.check.reason}, expected ${action} ${reason}`)
  ev.push(`log: check ${action} ${reason}`)
}

function expectRunning(run: Run, id: string, ev: string[]) {
  if (run.running === null) return
  if (run.running !== id) throw new Fail(`the app runs ${run.running}, expected ${id}`)
  ev.push(`log: runs ${id}`)
}

/** "installed <id>" came in this run (the download), or didn't (no download). */
const installedIn = (run: Run, id?: string) => tap.since(run.from).some((l) => l.tag === "zn-ota" && (id ? l.msg.startsWith(`installed ${id};`) : l.msg.startsWith("installed ")))

const healthySeen = new Set<string>()

/** The first time a bundle runs, it must be marked healthy (the log says so). */
async function expectHealthy(run: Run, id: string, ev: string[]) {
  if (!logsWork || healthyWaitS <= 0 || healthySeen.has(id)) return
  const l = await tap.wait(new RegExp(`safety: ${id} is healthy`), run.from, healthyWaitS * 1000)
  if (!l) throw new Fail(`${id} was not marked healthy within ${healthyWaitS} s (the app must stay on screen; --healthy-wait <s>, 0 = don't check)`)
  healthySeen.add(id)
  ev.push("log: healthy")
}

// ---- Cases --------------------------------------------------------------------------------------------------------------

interface Ctx {
  bundles: Rel[]
  /** What the server must have seen by the end: (bundle, event kind). */
  expect: { bundle: string; kind: string }[]
  /** The bundle the phone runs now (server's name: an id, or "built-in:<id>"). */
  runningNow: string | null
  builtInId: string | null
}

const ctx: Ctx = { bundles: [], expect: [], runningNow: null, builtInId: null }

interface Case {
  id: string
  title: string
  run: () => Promise<string[]>
}

function noteRun(run: Run) {
  if (run.running) {
    ctx.runningNow = run.fromFiles ? run.running : `built-in:${run.running}`
    if (!run.fromFiles) ctx.builtInId = run.running
  }
}

const cases: Case[] = [
  {
    id: "start",
    title: "Cold start: the check answers, and the server sees the phone",
    async run() {
      const ev: string[] = []
      const run = await startAndCheck()
      noteRun(run)
      if (run.check) {
        ev.push(`log: check ${run.check.action} ${run.check.reason}`)
        ev.push(`runs ${run.running}${run.fromFiles ? "" : " (built-in)"}`)
      }
      ev.push(
        "server: " +
          (await waitServer("a phone check for today", (s) => {
            const n = phonesOn(s, (r) => (ctx.runningNow ? r === ctx.runningNow : true))
            return n > 0 ? `${n} phone(s) today${ctx.runningNow ? ` on ${ctx.runningNow}` : ""}` : null
          })),
      )
      return ev
    },
  },
  {
    id: "update",
    title: "Release + publish: a cold start downloads it, the next one runs it, and it is marked healthy",
    async run() {
      const ev: string[] = []
      const before = await getStats()
      const A = await release()
      ctx.bundles.push(A)
      await publish(A, "update")
      const s1 = await startAndCheck()
      expectCheck(s1, "UPDATE", "NEW_BUNDLE", ev)
      if (logsWork) {
        if (!(await tap.wait(new RegExp(`installed ${A.id};`), s1.from, 15_000))) throw new Fail(`no "installed ${A.id}" line`)
        ev.push("log: installed")
      }
      const s2 = await startAndCheck()
      noteRun(s2)
      expectRunning(s2, A.id, ev)
      if (logsWork) {
        if (!(await tap.wait(new RegExp(`report: started ${A.id}`), s2.from, 15_000))) throw new Fail(`no "report: started ${A.id}" line`)
        ev.push("log: started")
      }
      await expectHealthy(s2, A.id, ev)
      ctx.runningNow = A.id
      ev.push(
        "server: " +
          (await waitServer(`${A.id} downloaded, started, and a phone on it`, (s) => {
            const d = evCount(s, A.id, "downloaded") - evCount(before, A.id, "downloaded")
            const st = evCount(s, A.id, "started") - evCount(before, A.id, "started")
            const on = phonesOn(s, (r) => r === A.id)
            return d >= 1 && st >= 1 && on >= 1 ? `downloaded ${d}, started ${st}, phones on it ${on}` : null
          })),
      )
      ctx.expect.push({ bundle: A.id, kind: "downloaded" }, { bundle: A.id, kind: "started" })
      return ev
    },
  },
  {
    id: "kept",
    title: "Roll back to the older bundle the phone still keeps: no download",
    async run() {
      const ev: string[] = []
      const A = ctx.bundles[0]
      if (!A) throw new Fail("needs the update case first")
      const before = await getStats()
      const B = await release()
      ctx.bundles.push(B)
      await publish(B, "newer bundle")
      const s1 = await startAndCheck()
      expectCheck(s1, "UPDATE", "NEW_BUNDLE", [])
      const s2 = await startAndCheck()
      expectRunning(s2, B.id, [])
      await expectHealthy(s2, B.id, [])
      ev.push(`${B.id} ran`)
      const r = await publish(A, "rollback to the kept bundle")
      ev.push(`server says ${r.kind}`)
      const s3 = await startAndCheck()
      expectCheck(s3, "USE_LOCAL", "KEPT", ev)
      if (logsWork) {
        if (installedIn(s3)) throw new Fail("the phone downloaded a bundle, but it had a kept copy")
        ev.push("log: no download")
      }
      const s4 = await startAndCheck()
      noteRun(s4)
      expectRunning(s4, A.id, ev)
      if (logsWork && !(await tap.wait(new RegExp(`report: started ${A.id}`), s4.from, 15_000))) throw new Fail(`no "report: started ${A.id}" line after the rollback`)
      ctx.runningNow = A.id
      ev.push(
        "server: " +
          (await waitServer(`${A.id} started again, ${B.id} started, a phone on ${A.id}`, (s) => {
            const sa = evCount(s, A.id, "started") - evCount(before, A.id, "started")
            const sb = evCount(s, B.id, "started")
            const sw = evCount(s, A.id, "switched") - evCount(before, A.id, "switched")
            const dl = evCount(s, A.id, "downloaded") - evCount(before, A.id, "downloaded")
            if (dl > 0) throw new Fail(`server: the phone downloaded ${A.id} again (it should use its kept copy)`)
            return sa >= 1 && sb >= 1 && sw >= 1 && phonesOn(s, (x) => x === A.id) >= 1 ? `${A.id} started again ${sa}, switched ${sw}, ${B.id} started ${sb}, no new download` : null
          })),
      )
      ctx.expect.push({ bundle: B.id, kind: "started" }, { bundle: A.id, kind: "switched" })
      return ev
    },
  },
  {
    id: "kill-switch",
    title: "Kill switch: the phone goes back to its built-in bundle",
    async run() {
      const ev: string[] = []
      const before = await getStats()
      changedChannel = true
      const r = await changeChannel(conn, privatePem, {
        app: appId, channel, target: BUILT_IN, rollout: 100, priority: "high", reason: "phone suite: kill switch", confirm: `KILL ${channel.toUpperCase()}`, push: false,
      })
      say(`  kill switch on ${channel} (seq ${r.pointer.seq})`)
      const s1 = await startAndCheck()
      expectCheck(s1, "BUILT_IN", "KILL_SWITCH", ev)
      const s2 = await startAndCheck()
      noteRun(s2)
      if (s2.running !== null) {
        if (s2.fromFiles) throw new Fail(`after the kill switch the app still runs ${s2.running} from files`)
        ev.push(`log: runs built-in ${s2.running}`)
      }
      if (s2.check) {
        if (s2.check.reason !== "KILL_SWITCH") throw new Fail(`the second check said ${s2.check.action} ${s2.check.reason}, expected KILL_SWITCH`)
      }
      ev.push(
        "server: " +
          (await waitServer("a switch to built-in and a phone on built-in", (s) => {
            const sw = evCount(s, "built-in", "switched") - evCount(before, "built-in", "switched")
            return sw >= 1 && phonesOn(s, (x) => x.startsWith("built-in:")) >= 1 ? `switched ${sw}, phones on built-in ${phonesOn(s, (x) => x.startsWith("built-in:"))}` : null
          })),
      )
      return ev
    },
  },
  {
    id: "push-background",
    title: "Push: with the app ended, a publish downloads the bundle in the background, with no screen",
    async run() {
      const ev: string[] = []
      const st = await getState()
      if (!st.app.push?.fcmProject) throw new Skip(`the app has no push config on the server (updates app --push '{"fcmProject":"…"}')`)
      // One normal start first: the phone subscribes to its topic (zn-ota-<app>-<channel>) at each start.
      const s0 = await startAndCheck()
      noteRun(s0)
      if (logsWork) {
        const t = await tap.wait(/OTA topic/, s0.from, 15_000)
        if (!t) throw new Skip("the app's log has no \"OTA topic\" line (tag zn-push) at start: the app has no push plugin, or its OTA push is off")
        ev.push(`log: ${t.msg}`)
      }
      await sleep(5000) // the subscription needs a moment
      await endApp()
      ev.push("app ended (am kill)")
      const before = await getStats()
      const C = await release()
      ctx.bundles.push(C)
      const mark = tap.mark()
      const r = await publish(C, "push test", true)
      let push: PushResult | null = r.push
      if (!push) push = await call<PushResult>(conn, "POST", `/admin/apps/${appId}/channels/${channel}/push`)
      if (!push.sent) throw new Skip(`the server could not send the push to ${push.topic}: ${push.error ?? "no reason"} (${C.id} is published)`)
      ev.push(`server sent the push to ${push.topic}`)
      const t0 = Date.now()
      let installed: LogLine | null = null
      let wasForeground = false
      let serverSawIt = false
      while (Date.now() - t0 < pushWaitS * 1000) {
        installed = await tap.wait(new RegExp(`installed ${C.id};`), mark, 3000)
        if (installed) break
        // The app is not on screen at any time while we wait.
        if (sh("dumpsys activity activities | grep -i resumedactivity").includes(`${pkg}/`)) wasForeground = true
        if (!logsWork) {
          // The "downloaded" event reaches the server with the phone's next check, so this only works after a start:
          // without logs we look at the phone's process instead and let the cold start below prove the download.
          if (isRunning()) {
            serverSawIt = true
            await sleep(8000) // let the job finish its download
            break
          }
        }
      }
      const secs = Math.round((Date.now() - t0) / 1000)
      if (logsWork && !installed) {
        const jobLines = tap.since(mark).filter((l) => l.tag === "zn-push").slice(-4).map((l) => l.msg)
        throw new Fail(`no "installed ${C.id}" within ${pushWaitS} s of the push (app running: ${isRunning()}). zn-push lines: ${jobLines.join(" | ") || "none"}`)
      }
      if (!logsWork && !serverSawIt) throw new Fail(`the app's process did not start within ${pushWaitS} s of the push`)
      if (!logsWork) ev.push(`app process started by the push after ${secs} s (no logs: the download is proved by the next start)`)
      if (wasForeground) throw new Fail("the app came to the front during the background download")
      if (logsWork) ev.push(`log: installed in ${secs} s, app process started by the push`)
      const top = sh("dumpsys activity activities | grep -i resumedactivity")
      if (top.includes(`${pkg}/`)) throw new Fail(`the app is on screen after the push: ${top.trim().split("\n")[0]}`)
      ev.push("no screen shown")
      // The next cold start runs it, with no second download.
      const s1 = await startAndCheck()
      noteRun(s1)
      expectRunning(s1, C.id, ev)
      expectCheck(s1, "NONE", "UP_TO_DATE", ev)
      if (logsWork) {
        if (installedIn(s1)) throw new Fail("the cold start downloaded the bundle again")
        ev.push("log: no second download")
      }
      await expectHealthy(s1, C.id, ev)
      ctx.runningNow = C.id
      ev.push(
        "server: " +
          (await waitServer(`${C.id} downloaded and started`, (s) => {
            const d = evCount(s, C.id, "downloaded") - evCount(before, C.id, "downloaded")
            const x = evCount(s, C.id, "started") - evCount(before, C.id, "started")
            return d >= 1 && x >= 1 ? `downloaded ${d}, started ${x}` : null
          })),
      )
      ctx.expect.push({ bundle: C.id, kind: "downloaded" }, { bundle: C.id, kind: "started" })
      return ev
    },
  },
  {
    id: "settle",
    title: "End state: the phone runs what the channel serves (a publish ends the kill switch)",
    async run() {
      const ev: string[] = []
      let cur = (await getState()).channels.find((c) => c.name === channel)?.current?.pointer
      if (!cur || cur.target === BUILT_IN) {
        const D = await release()
        ctx.bundles.push(D)
        await publish(D, "end the kill switch")
        cur = (await getState()).channels.find((c) => c.name === channel)?.current?.pointer
        ev.push("a publish ended the kill switch")
      }
      const target = cur!.target
      let run = await startAndCheck()
      if (run.running !== null && run.running !== target) {
        if (run.check?.action !== "UPDATE" && run.check?.action !== "USE_LOCAL") throw new Fail(`the phone runs ${run.running}, the channel serves ${target}, and the check said ${run.check?.action} ${run.check?.reason}`)
        run = await startAndCheck()
      } else if (run.running === null) {
        run = await startAndCheck() // logs are off: one more start, the server decides below
      }
      noteRun(run)
      expectRunning(run, target, ev)
      await expectHealthy(run, target, ev)
      ctx.runningNow = target
      ev.push("server: " + (await waitServer(`a phone on ${target}`, (s) => (phonesOn(s, (x) => x === target) >= 1 ? `${phonesOn(s, (x) => x === target)} phone(s) on ${target}` : null))))
      if (!ctx.expect.some((e) => e.bundle === target && e.kind === "started") && ctx.bundles.some((b) => b.id === target)) ctx.expect.push({ bundle: target, kind: "started" })
      return ev
    },
  },
  {
    id: "server-view",
    title: "The server's view: this phone today on the expected bundle, every step's events there, no errors",
    async run() {
      const ev: string[] = []
      const run = await startAndCheck() // its check also reports what the last start noted
      noteRun(run)
      const expected = ctx.runningNow
      if (!expected) throw new Fail("no bundle to expect (an earlier case failed?)")
      ev.push(
        "server: " +
          (await waitServer(`a phone today on ${expected}`, (s) => (phonesOn(s, (x) => x === expected) >= 1 ? `${phonesOn(s, (x) => x === expected)} phone(s) today on ${expected}` : null))),
      )
      const s = await waitServer("all events of the earlier cases", (st) => {
        const missing = ctx.expect.filter((e) => evCount(st, e.bundle, e.kind) < 1)
        return missing.length === 0 ? "ok" : null
      })
      ev.push(`all ${ctx.expect.length} expected events seen (${s})`)
      const st = await getStats()
      const ours = new Set(ctx.bundles.map((b) => b.id))
      const bad = st.errors.filter((e) => ours.has(e.bundle))
      if (bad.length) throw new Fail(`the server holds errors for the test bundles: ${bad.map((e) => `${e.bundle} ${e.kind} ${e.detail}`).join("; ")}`)
      ev.push("no errors for the test bundles")
      if (logsWork) {
        // Healthy reports reach the server with a later check.
        const noHealthy = [...healthySeen].filter((id) => evCount(st, id, "healthy") < 1)
        if (noHealthy.length) throw new Fail(`healthy was logged on the phone but the server has no healthy event for: ${noHealthy.join(", ")}`)
        ev.push(`healthy events for ${healthySeen.size} bundle(s)`)
      }
      return ev
    },
  },
]

// ---- Run ----------------------------------------------------------------------------------------------------------------

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  cleanup()
  process.exit(1)
}

const lockFile = join(home, "phone.lock")
let lockHeld = false

function takeLock() {
  mkdirSync(home, { recursive: true })
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: "wx" })
      lockHeld = true
      return
    } catch {
      const pid = Number(readFileSync(lockFile, "utf8"))
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        alive = false
      }
      if (alive) fail(`another phone script holds ${lockFile} (pid ${pid}, ${Math.round((Date.now() - statSync(lockFile).mtimeMs) / 60000)} min). Two scripts on one phone fight over the screen`)
      unlinkSync(lockFile) // its owner is gone
    }
  }
  fail(`can't take ${lockFile}`)
}

function loadConn(server: string): Conn {
  const loginFile = join(home, "updates.json")
  const saved = existsSync(loginFile) ? (JSON.parse(readFileSync(loginFile, "utf8")) as Record<string, { token: string; by: string }>) : {}
  const s = server.replace(/\/+$/, "")
  const login = saved[s]
  const token = process.env.ZN_UPDATES_TOKEN ?? login?.token
  if (!token) fail(`not signed in to ${s}: run \`bun run updates login --server ${s} --token <ADMIN_TOKEN> --by <your name>\` (or set ZN_UPDATES_TOKEN)`)
  return { server: s, token, by: process.env.ZN_UPDATES_BY ?? login?.by ?? "phone-suite" }
}

let screenTimeout = ""

function cleanup() {
  tap.stop()
  if (screenTimeout && /^\d+$/.test(screenTimeout)) sh(`settings put system screen_off_timeout ${screenTimeout}`)
  if (workDir) rmSync(workDir, { recursive: true, force: true })
  if (lockHeld) {
    try {
      unlinkSync(lockFile)
    } catch {
      // already gone
    }
    lockHeld = false
  }
}

/** The channel is left on the newest test bundle (not killed, not on an older one). Prints what it left. */
async function leaveSane(): Promise<string> {
  const newest = ctx.bundles.at(-1)
  if (!newest || !changedChannel) return "the channel was not changed"
  let cur = (await getState()).channels.find((c) => c.name === channel)?.current?.pointer
  if (!cur || cur.target !== newest.id) {
    await publish(newest, "end of the suite")
    cur = (await getState()).channels.find((c) => c.name === channel)?.current?.pointer
  }
  return `${channel} serves ${cur?.target} at ${cur?.rollout} % (seq ${cur?.seq}); not killed`
}

async function main() {
  if (a.list) {
    for (const c of cases) say(`${c.id.padEnd(16)} ${c.title}`)
    return
  }
  if (a.until && !cases.some((c) => c.id === a.until)) fail(`no case "${a.until}" (--list)`)
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(channel)) fail(`channel "${channel}": use a-z, 0-9 and -`)
  if (channel === "production") fail("this suite never touches production: it publishes test bundles and a kill switch. Use --channel staging")
  if (!a.package) fail("--package <the app's package name, e.g. com.example.app.staging>")
  pkg = a.package
  const cfgFile = join(appDir, "zn-updates.json")
  if (!existsSync(cfgFile)) fail(`no zn-updates.json in ${appDir} (--app-dir <the app's folder>)`)
  const cfg = JSON.parse(readFileSync(cfgFile, "utf8")) as { app: string; server: string; build?: string[] }
  if (!cfg.app || !cfg.server || !cfg.build?.length) fail(`${cfgFile} needs "app", "server" and "build"`)
  appId = cfg.app
  buildCmd = cfg.build
  conn = loadConn(a.server ?? cfg.server)

  // The phone
  const devices = adb(["devices"]).split("\n").slice(1).filter((l) => /\tdevice$/.test(l)).map((l) => l.split("\t")[0]!)
  const want = a.serial ?? process.env.ANDROID_SERIAL
  if (want) {
    if (!devices.includes(want)) fail(`${want} is not on adb (devices: ${devices.join(", ") || "none"}). If Git Bash sees none, try PowerShell`)
    serial = want
  } else if (devices.length === 1) {
    serial = devices[0]!
  } else {
    fail(`need exactly one phone on adb, found ${devices.length}: pass --serial`)
  }
  if (!adb(["shell", `pm path ${pkg}`]).includes("package:")) fail(`${pkg} is not installed on ${serial}`)
  const resolved = sh(`cmd package resolve-activity --brief ${pkg}`).split("\n").map((l) => l.trim()).filter((l) => l.includes("/")).pop()
  if (!resolved) fail(`no launcher activity for ${pkg}`)
  component = resolved
  takeLock()
  process.on("SIGINT", () => {
    say("\n(stopped: the channel may still hold test bundles)")
    cleanup()
    process.exit(130)
  })
  mkdirSync(outDir, { recursive: true })

  try {
    wake()
    if (/mDreamingLockscreen=true|mShowingLockscreen=true/.test(sh("dumpsys window | grep -i -E 'mDreamingLockscreen|mShowingLockscreen'"))) fail("the phone is locked: unlock it and run again")
    screenTimeout = sh("settings get system screen_off_timeout").trim()
    sh("settings put system screen_off_timeout 1800000")
    const model = sh("getprop ro.product.model").trim()
    const debuggable = /DEBUGGABLE/.test(sh(`dumpsys package ${pkg} | grep -i 'flags='`))
    say(`• phone ${model} (${serial}), ${pkg} (${debuggable ? "debuggable" : "release-type"} build; no run-as is used), activity ${component}`)
    if (sh("dumpsys duraspeed suppress_list").includes(pkg)) say(`  ! ${pkg} is on DuraSpeed's suppress list: tap its launcher icon once if the screens stay blank`)

    // The server and the app on it
    await call(conn, "GET", "/admin/env")
    const st = await getState().catch(() => fail(`the server ${conn.server} has no app "${appId}" (create it: bun run updates app --keys <public key>)`))
    const ch = st.channels.find((c) => c.name === channel)
    if (!ch) fail(`the app has no channel "${channel}" (channels: ${st.channels.map((c) => c.name).join(", ")})`)
    const mapped = (st.app.store as { android?: { packages?: Record<string, string> } }).android?.packages?.[pkg]
    if (mapped === "production") fail(`${pkg} is a production package on the server (store.android.packages): this suite will not publish for it`)
    if (mapped && mapped !== channel) fail(`${pkg} belongs to channel "${mapped}" on the server, not "${channel}" (use --channel ${mapped} if that is right)`)
    privatePem = (() => {
      const path = a.key ?? process.env.ZN_UPDATES_KEY ?? join(home, "keys", `${appId}-main.pem`)
      if (!existsSync(path)) fail(`no private key at ${path} (--key, or run \`bun run updates keygen\`)`)
      if (resolve(path).toLowerCase().startsWith(repoRoot.toLowerCase())) fail(`the private key ${path} is inside the repo; keep it outside`)
      return readFileSync(path, "utf8")
    })()
    if (!st.app.publicKeys.includes(publicKeyOf(privatePem))) fail("the signing key is not one of the app's public keys on the server")
    const before = ch.current?.pointer
    say(`• server ${conn.server}, app ${appId}, channel ${channel}: ${before ? `serves ${before.target} at ${before.rollout} % (seq ${before.seq})` : "serves nothing yet"}`)
    say(`  the suite will change this channel (test bundles, a kill switch) and leave it on the newest test bundle.`)

    workDir = mkdtempSync(join(tmpdir(), "zn-updates-phone-"))
    tap.start()
    await sleep(800)

    const results: { id: string; status: "pass" | "FAIL" | "skipped"; s: number; note: string }[] = []
    for (const c of cases) {
      const t0 = Date.now()
      say(`▶ ${c.id}: ${c.title}`)
      const mark = tap.mark()
      try {
        const ev = await c.run()
        results.push({ id: c.id, status: "pass", s: (Date.now() - t0) / 1000, note: ev.join("; ") })
        say(`  ✓ ${ev.join("; ")}`)
      } catch (e) {
        const note = e instanceof Error ? e.message : String(e)
        if (e instanceof Skip) {
          results.push({ id: c.id, status: "skipped", s: (Date.now() - t0) / 1000, note })
          say(`  – skipped: ${note}`)
        } else {
          results.push({ id: c.id, status: "FAIL", s: (Date.now() - t0) / 1000, note })
          say(`  ✗ ${note}`)
          const file = join(outDir, `${c.id}.log`)
          const stats = await getStats().catch(() => null)
          writeFileSync(
            file,
            [
              `case ${c.id} failed: ${note}`,
              `run ${runId}, phone ${serial}, ${pkg}, channel ${channel}, logs ${logsWork === undefined ? "unknown" : logsWork ? "work" : "stripped"}`,
              ``,
              `--- the app's own log lines since the case began (tags zn-ota, zn, zn-push) ---`,
              ...tap.since(mark).map((l) => l.raw),
              ``,
              `--- crashes and every other zn line, last 80 ---`,
              ...tap.lines.slice(-80).map((l) => l.raw),
              ``,
              `--- server stats (2 days, ${channel}) ---`,
              JSON.stringify(stats, null, 2),
            ].join("\n"),
          )
          say(`    log: ${file}`)
          if (!(e instanceof Fail)) break // a tool problem (adb, server, build): later cases would fail the same way
        }
      }
      if (c.id === a.until) break
    }

    say("• leaving the channel in a sane state…")
    let left = ""
    try {
      left = await leaveSane()
    } catch (e) {
      left = `could not tidy the channel: ${e instanceof Error ? e.message : e}`
    }
    say(`  ${left}`)
    if (before) say(`  before the suite it served ${before.target} at ${before.rollout} %: to put it back, \`updates publish --channel ${channel} --bundle ${before.target.split("_").pop()}\``)

    const passed = results.filter((r) => r.status === "pass").length
    const skipped = results.filter((r) => r.status === "skipped").length
    const failed = results.filter((r) => r.status === "FAIL").length
    const table = [
      `| Case | Result | Time | Proof |`,
      `|---|---|---|---|`,
      ...results.map((r) => `| ${r.id} | ${r.status === "FAIL" ? "**FAIL**" : r.status} | ${r.s.toFixed(0)} s | ${r.note.replaceAll("|", "\\|")} |`),
    ].join("\n")
    writeFileSync(
      join(outDir, "results.md"),
      `# zn-updates phone suite ${new Date().toISOString()}\n\nApp ${appId}, package ${pkg}, channel ${channel}, server ${conn.server}, phone ${model} (${serial}), logs ${logsWork === undefined ? "unknown" : logsWork ? "work" : "stripped (server proof only)"}.\nTest bundles: ${ctx.bundles.map((b) => b.id).join(", ") || "none"}.\nChannel left: ${left}\n\n${table}\n`,
    )
    say(`\n${table}\n`)
    say(`${passed} passed, ${skipped} skipped, ${failed} failed (of ${cases.length}); table in ${join(outDir, "results.md")}`)
    if (failed > 0 || results.length < (a.until ? cases.findIndex((c) => c.id === a.until) + 1 : cases.length)) process.exitCode = 1
  } finally {
    cleanup()
  }
}

await main().catch((e) => {
  cleanup()
  console.error(`✗ ${e instanceof Error ? e.message : e}`)
  process.exit(1)
})
