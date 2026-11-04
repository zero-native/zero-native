// Phone steps for the Crashlytics plugin (examples/sample/src/CrashlyticsLab.tsx). No hands. Needs a sample built WITH
// android/sample/google-services.json; without it every step says SKIP and passes (other machines and CI have no json).
// Each step proves the report left the phone (Firebase's transport logs its request to crashlyticsreports-pa and
// "Status Code: 200"); the Firebase console shows it a few minutes later.
// The native crash step runs only for a build with `-PznCrashlyticsNdk`: set ZN_NDK=1.
import { adb, check, CLEAR_TASK, clearLog, expectLog, ok, openFresh, PKG, see, shell, sleep, stopApp, tap, texts, type Step } from "./helpers"

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

export const steps: Step[] = [
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
]
