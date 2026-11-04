// Phone steps for the Crashlytics plugin (examples/sample/src/CrashlyticsLab.tsx). No hands. Needs a sample built WITH
// android/sample/google-services.json; without it every step says SKIP and passes (other machines and CI have no json).
// Each step proves the report left the phone (Firebase's transport logs its request to crashlyticsreports-pa and
// "Status Code: 200"); the Firebase console shows it a few minutes later.
// The native crash step runs only for a build with `-PznCrashlyticsNdk`: set ZN_NDK=1.
// The OTA step (ZN_OTA=1) builds a bundle into a test store of its own (.zn-ota-test/plugin-phone/ota-store, signed
// with the sample's key in ~/.zero-native/keys), serves it on this computer only (port 8790, `adb reverse`), and
// clears the sample's data before and after. Nothing is published anywhere else.
import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { startServer } from "../ota/server"
import { adb, check, CLEAR_TASK, clearLog, expectLog, ok, OUT, openFresh, PKG, see, shell, sleep, stopApp, tap, texts, type Step } from "./helpers"

/** Opens the lab. False (and a SKIP line) when Firebase is off in this build. */
async function lab(): Promise<boolean> {
  debugLogs()
  await openFresh("dev/crashlytics", "Read status")
  const s = await expectLog(/crashlytics-lab status /)
  if (s.includes("available=true")) return true
  console.log(`SKIP crashlytics: Firebase is off in this build (no android/sample/google-services.json): ${s}`)
  return false
}

/** Crashlytics' own lines and the plugin's: helpers' log filter leaves them out. */
const firebaseLog = () =>
  adb("logcat", "-d", "-v", "brief", "-s", "FirebaseCrashlytics:*", "TRuntime.CctTransportBackend:*", "zn-crashlytics:*", "AndroidRuntime:E", "zn-js:*")
async function expectFirebase(re: RegExp, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = firebaseLog().split(/\r?\n/).filter((l) => re.test(l)).at(-1)
    if (hit) return hit.replace(/^.*?: /, "").trim()
    await sleep(500)
  }
  throw new Error(`never logged ${re}`)
}

/** Crashlytics sends a launch's reports at the next start: start again, and wait for the upload's answer. */
async function startAgainAndSee(what: string) {
  await stopApp()
  clearLog()
  shell("am", "start", "-f", CLEAR_TASK, "-a", "android.intent.action.VIEW", "-d", "zn://sample/dev/crashlytics", PKG)
  await see("Read status", 15000)
  await expectFirebase(/Making request to: https:\/\/crashlyticsreports-pa\.googleapis\.com/, 60000)
  ok(`${what} sent`, await expectFirebase(/Status Code: \d+/, 20000))
  check(/Status Code: 200/.test(firebaseLog()), "the upload was not answered 200")
}

/** Debug builds show a JS error over the screen (core's dev error screen): close it to tap on. */
async function dismissDevError() {
  await sleep(800)
  if (texts().some((t) => t.text === "Dismiss")) await tap("Dismiss")
}

/** Crashlytics logs its uploads only at debug level. */
const debugLogs = () => shell("setprop", "log.tag.FirebaseCrashlytics", "DEBUG")

const otaLog = () => adb("logcat", "-d", "-v", "brief", "-s", "zn-ota:*", "zn:*", "zn-sample:*")
async function expectOta(re: RegExp, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = otaLog().split(/\r?\n/).filter((l) => re.test(l)).at(-1)
    if (hit) return hit.replace(/^.*?: /, "").trim()
    await sleep(500)
  }
  throw new Error(`never logged ${re}`)
}

/** `bun run ota <args>` against the step's own test store. */
function otaCli(store: string, ...args: string[]): string {
  const root = resolve(import.meta.dir, "../..")
  const p = spawnSync("bun", ["run", "tools/ota/cli.ts", ...args, "--store", store], { cwd: root, encoding: "utf8" })
  if (p.status !== 0) throw new Error(`ota ${args[0]} failed:\n${(p.stdout + p.stderr).trim().split("\n").slice(-6).join("\n")}`)
  return p.stdout
}

/** A JS error from a downloaded (OTA) bundle: the report must say zn_built_in=false and that bundle's id. */
async function otaBundleError() {
  const store = join(OUT, "ota-store")
  rmSync(store, { recursive: true, force: true })
  shell("pm", "clear", PKG) // no OTA bundle or setting kept from earlier runs
  const out = otaCli(store, "build")
  const m = /released #(\d+) \((\S+)\)/.exec(out)
  if (!m) throw new Error(`ota build said:\n${out.trim().split("\n").slice(-4).join("\n")}`)
  const [, serial, id] = m
  otaCli(store, "publish", "--channel", "staging", "--bundle", serial)
  const server = startServer({ storeRoot: store, dataDir: join(OUT, "ota-data"), port: 8790, log: false })
  adb("reverse", "tcp:8790", "tcp:8790")
  try {
    debugLogs()
    await openFresh("dev/crashlytics", "Read status")
    ok("downloaded", await expectOta(new RegExp(`installed ${id}; it runs from the next start`), 60000))
    await openFresh("dev/crashlytics", "Read status")
    ok("running", await expectOta(new RegExp(`running bundle ${id}@`)))
    await tap("Read status")
    const s = await expectLog(/crashlytics-lab status /)
    if (!s.includes("available=true")) return console.log(`SKIP crashlytics ota: Firebase is off in this build: ${s}`)
    await tap("Record a caught error")
    ok("caught", await expectLog(/crashlytics-lab caught error recorded ok=true/))
    await startAgainAndSee(`a JS non-fatal from OTA bundle ${id}`)
    console.log(`    console check: the event's keys say zn_built_in=false, zn_bundle_id=${id}`)
  } finally {
    adb("reverse", "--remove", "tcp:8790")
    server.stop(true)
    await stopApp()
    shell("pm", "clear", PKG) // back to the APK's own bundle for the next steps
  }
}

export const steps: Step[] = [
  {
    name: "firebase app and installations",
    run: async () => {
      if (!(await lab())) return
      await tap("Firebase app")
      const line = await expectLog(/crashlytics-lab firebase /)
      check(/available=true project=\S+ installId=[1-9]/.test(line), `no project or install id: ${line}`)
      ok("firebase", line)
    },
  },
  {
    name: "crashlytics status and opt-out",
    run: async () => {
      if (!(await lab())) return
      ok("status", "available=true")
      await tap("Sending off")
      ok("off", await expectLog(/crashlytics-lab sending off/))
      await tap("Sending on")
      ok("on", await expectLog(/crashlytics-lab sending on/))
    },
  },
  {
    name: "crashlytics js errors",
    run: async () => {
      if (!(await lab())) return
      await tap("Set user and keys")
      ok("keys", await expectLog(/crashlytics-lab user and keys set/))
      await tap("Record a caught error")
      ok("caught", await expectLog(/crashlytics-lab caught error recorded ok=true/))
      await tap("Throw in a tap handler")
      ok("handler", await expectLog(/a tap handler threw/))
      await dismissDevError()
      await tap("Reject a promise")
      ok("async", await expectLog(/a promise nobody caught/, 6000))
      await dismissDevError()
      await startAgainAndSee("3 JS non-fatals")
    },
  },
  {
    name: "crashlytics kotlin crash",
    run: async () => {
      if (!(await lab())) return
      await tap("Kotlin crash")
      ok("crashed", await expectFirebase(/Test crash from Crashlytics\.crash\(\)/, 8000))
      await startAgainAndSee("the crash")
    },
  },
  ...(process.env.ZN_NDK === "1"
    ? [
        {
          name: "crashlytics native crash (ndk build)",
          run: async () => {
            if (!(await lab())) return
            await tap("Native crash (needs NDK)")
            await sleep(3000)
            check(!shell("pidof", PKG).trim(), "the app still runs after the native crash")
            ok("crashed", "process gone")
            await startAgainAndSee("the native crash")
          },
        } satisfies Step,
      ]
    : []),
  ...(process.env.ZN_OTA === "1" ? [{ name: "crashlytics error from an OTA bundle", run: otaBundleError } satisfies Step] : []),
]
