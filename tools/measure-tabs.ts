// Startup cost of a home screen with 4 tabs that each load data over HTTP (the tabs lab, /dev/tabs). Release builds
// only (docs/startup-and-performance.md §2). Each run is a cold start from a link:
//
//   bun run tools/measure-tabs.ts [--runs 11]
//
// Cases: a plain dev screen (the baseline), the tabs lab lazy with all four loads started with the screen (the default),
// with every tab built at start (?preload=1, like ZeroBill RN's `lazy: false`), and loading only the shown tab
// (?fetch=shown). Per run: `am start -W` TotalTime (first frame) and, from logcat times, ms from process start to the
// first tab's data and to the last tab's data in JS (drawn one frame later).
//
// The app is stopped with Home + `am kill` (only works in the background), not `am force-stop`: on MediaTek phones a
// force-stop puts the app on DuraSpeed's suppress list (docs/second-opinions.md entry 36). Each run must say COLD.
import { spawnSync } from "node:child_process"
import { tabsAnswer } from "./plugin-phone/tabs-server"

const PKG = "dev.zeronative.sample"
const args = process.argv.slice(2)
const runs = Number(args[args.indexOf("--runs") + 1] || 11) || 11

const adb = (...a: string[]) => spawnSync("adb", a, { encoding: "utf8" }).stdout ?? ""
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

try {
  Bun.serve({ port: 8788, fetch: async (req) => (await tabsAnswer(new URL(req.url))) ?? new Response("not found", { status: 404 }) })
} catch {
  // tools/fetch-test-server.ts already runs and answers /tabs/ too.
}
adb("reverse", "tcp:8788", "tcp:8788")
if (/DEBUGGABLE/.test(adb("shell", "dumpsys", "package", PKG).match(/pkgFlags=\[[^\]]*\]/)?.[0] ?? "")) {
  console.warn(`${PKG} is a debug build: these numbers are not comparable (install :sample:installRelease)`)
}

interface Case { name: string; path: string; loads: number }
const cases: Case[] = [
  { name: "baseline (/dev/rn)", path: "dev/rn", loads: 0 },
  { name: "tabs, lazy, 4 loads at start", path: "dev/tabs", loads: 4 },
  { name: "tabs, preload all 4", path: "dev/tabs?preload=1", loads: 4 },
  { name: "tabs, lazy, load shown tab only", path: "dev/tabs?fetch=shown", loads: 1 },
]

/** Epoch ms of a `logcat -v epoch` line. */
const at = (line: string) => Math.round(Number(line.trim().split(/\s+/)[0]) * 1000)

async function stop() {
  adb("shell", "input", "keyevent", "KEYCODE_HOME")
  await sleep(700)
  adb("shell", "am", "kill", PKG)
  for (let i = 0; i < 20 && adb("shell", "pidof", PKG).trim(); i++) await sleep(150)
}

async function once(c: Case) {
  await stop()
  adb("logcat", "-c")
  const out = adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", `zn://sample/${c.path}`, PKG)
  const total = Number(/TotalTime: (\d+)/.exec(out)?.[1] ?? NaN)
  const cold = /LaunchState: COLD/.test(out)
  let data: number[] = []
  let start = NaN
  for (let i = 0; i < 40; i++) {
    const log = adb("logcat", "-d", "-v", "epoch")
    start = at(log.split(/\r?\n/).find((l) => /Start proc \d+:dev\.zeronative\.sample\//.test(l)) ?? "NaN")
    data = log.split(/\r?\n/).filter((l) => /tabs-lab data \w+ 40/.test(l)).map((l) => at(l) - start)
    if (data.length >= c.loads) break
    await sleep(250)
  }
  return { total, cold, first: data.length ? Math.min(...data) : NaN, last: data.length >= c.loads && c.loads ? Math.max(...data) : NaN }
}

const median = (xs: number[]) => {
  const s = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN
}
const p90 = (xs: number[]) => {
  const s = xs.filter((x) => !Number.isNaN(x)).sort((a, b) => a - b)
  return s.length ? s[Math.ceil(0.9 * s.length) - 1] : NaN
}

for (const c of cases) {
  const rows = []
  for (let i = 0; i < runs; i++) rows.push(await once(c))
  const kept = rows.slice(1) // the first run is left out
  const warm = kept.filter((r) => !r.cold).length
  const col = (k: "total" | "first" | "last") => `${median(kept.map((r) => r[k]))} / ${p90(kept.map((r) => r[k]))}`
  console.log(
    `${c.name.padEnd(34)} TotalTime ${col("total")} ms` +
      (c.loads ? ` · first data ${col("first")} ms · all data ${col("last")} ms` : "") +
      ` (median / p90, n=${kept.length}${warm ? `, ${warm} NOT cold` : ""})`,
  )
}
await stop()
process.exit(0)
