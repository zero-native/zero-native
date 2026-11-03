// Helpers for tools/plugin-phone.ts. The sample app only: no monkey, no real UPI, settings put back after each step.
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

export const PKG = "dev.zeronative.sample"
/** Screenshots go here (git ignores it). */
export const OUT = join(import.meta.dir, "..", "..", ".zn-ota-test", "plugin-phone")
mkdirSync(OUT, { recursive: true })

/** One check on the phone. `hands`: what a person must do; the script prints it and waits. A step with hands runs last. */
export interface Step {
  name: string
  hands?: string
  run: () => Promise<void>
}

export const adb = (...a: string[]) => spawnSync("adb", a, { encoding: "utf8" }).stdout ?? ""
export const shell = (...a: string[]) => adb("shell", ...a)
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const unesc = (s: string) => s.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")

/** The text on screen, with where each one is. */
export function texts() {
  shell("rm", "-f", "/sdcard/zn-ui.xml")
  shell("uiautomator", "dump", "/sdcard/zn-ui.xml")
  const xml = shell("cat", "/sdcard/zn-ui.xml")
  shell("rm", "-f", "/sdcard/zn-ui.xml")
  return [...xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?content-desc="([^"]*)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
    .map((m) => ({ text: unesc(m[1] || m[2]), x: (+m[3] + +m[5]) >> 1, y: (+m[4] + +m[6]) >> 1 }))
    .filter((t) => t.text)
}
const matches = (t: string, text: string | RegExp) => (typeof text === "string" ? t === text : text.test(t))

/** Waits until [text] is on screen. */
export async function see(text: string | RegExp, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (texts().some((t) => matches(t.text, text))) return
    await sleep(300)
  }
  throw new Error(`no "${text}" on screen: ${texts().map((t) => t.text).join(" | ")}`)
}

/** Taps [text]; scrolls down to find it if it isn't on screen. */
export async function tap(text: string | RegExp) {
  for (let i = 0; i < 14; i++) {
    const n = texts().find((t) => matches(t.text, text))
    if (n) return void shell("input", "tap", String(n.x), String(n.y))
    if (i % 3 === 2) shell("input", "swipe", "360", "1100", "360", "500", "250")
    await sleep(350)
  }
  throw new Error(`no "${text}" on screen: ${texts().map((t) => t.text).join(" | ")}`)
}

const log = () => adb("logcat", "-d", "-v", "brief", "-s", "zn-js:*", "zn:*", "zn-sample:*", "AndroidRuntime:E")
export const lines = (re: RegExp) => log().split(/\r?\n/).filter((l) => re.test(l))

/** Waits for a log line and gives it back. */
export async function expectLog(re: RegExp, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = lines(re).at(-1)
    if (hit) return hit.replace(/^.*?: /, "").trim()
    await sleep(250)
  }
  throw new Error(`never logged ${re}. Last: ${lines(/-lab |fake view|task|FATAL/).slice(-8).join(" | ")}`)
}
export const clearLog = () => adb("logcat", "-c")

/**
 * Ends the app's process. Not `am force-stop`: on MediaTek phones that puts the app on DuraSpeed's suppress list, and then
 * no WebView page loads (docs/second-opinions.md entry 36). A kill -9 (run-as, debug builds) is what low memory does, and
 * the OTA health check ignores it. Start again with [CLEAR_TASK] for a fresh start: the old task may still be there.
 */
export async function stopApp() {
  const p = pid()
  if (!p) return
  shell("run-as", PKG, "kill", "-9", p)
  for (let i = 0; i < 30 && pid() === p; i++) await sleep(100)
}
/** `am start -f`: FLAG_ACTIVITY_NEW_TASK | FLAG_ACTIVITY_CLEAR_TASK, so no screen of an old task comes back. */
export const CLEAR_TASK = "0x10008000"

/** A fresh start of the sample on a route with `deepLink: true`, like "dev/core". Waits for [ready]. */
export async function openFresh(path: string, ready: string | RegExp) {
  await stopApp()
  clearLog()
  shell("am", "start", "-f", CLEAR_TASK, "-a", "android.intent.action.VIEW", "-d", `zn://sample/${path}`, PKG)
  await see(ready, 15000)
}

/** Sends the app to the background, then kills its process as Android would. */
export async function killInBackground() {
  shell("input", "keyevent", "KEYCODE_HOME")
  await sleep(1500)
  const before = pid()
  shell("am", "kill", PKG)
  await sleep(800)
  check(pid() !== before, "the process lived")
}
export const pid = () => shell("pidof", PKG).trim()
export const reopen = () => shell("am", "start", "-n", `${PKG}/.MainActivity`)
export const ok = (name: string, proof: string) => console.log(`ok  ${name}: ${proof.slice(0, 170)}`)
export function check(cond: unknown, what: string): asserts cond {
  if (!cond) throw new Error(what)
}
export const shot = () => spawnSync("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 1 << 26 }).stdout as Buffer
