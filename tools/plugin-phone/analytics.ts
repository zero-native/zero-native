// Phone steps for the Analytics plugin (examples/sample/src/AnalyticsLab.tsx). No hands. Needs a sample built WITH
// android/sample/google-services.json; without it every step says SKIP and passes (other machines and CI have no json).
// Proof: Firebase's own "FA" log lines, made verbose with setprop. Debug mode (debug.firebase.analytics.app) sends
// events at once, and the Firebase console's DebugView shows them.
import { adb, check, expectLog, ok, openFresh, PKG, see, shell, sleep, tap, type Step } from "./helpers"

/** Firebase's measurement lines: the app's (FA) and Play services' (FA-SVC). helpers' log filter leaves them out. */
const faLog = () => adb("logcat", "-d", "-v", "brief", "-s", "FA:*", "FA-SVC:*", "zn-analytics:*")

async function expectFa(re: RegExp, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = faLog().split(/\r?\n/).filter((l) => re.test(l)).at(-1)
    if (hit) return hit.replace(/^.*?: /, "").trim()
    await sleep(500)
  }
  throw new Error(`never logged ${re}`)
}

/** Opens the lab with Analytics' logs on. False (and a SKIP line) when Firebase is off in this build. */
async function lab(): Promise<boolean> {
  shell("setprop", "log.tag.FA", "VERBOSE")
  shell("setprop", "log.tag.FA-SVC", "VERBOSE")
  shell("setprop", "debug.firebase.analytics.app", PKG)
  await openFresh("dev/analytics", "Read status")
  const s = await expectLog(/analytics-lab status /)
  if (s.includes("available=true")) return true
  console.log(`SKIP analytics: Firebase is off in this build (no android/sample/google-services.json): ${s}`)
  return false
}

export const steps: Step[] = [
  {
    name: "analytics events after consent",
    run: async () => {
      if (!(await lab())) return
      ok("status", "available=true")
      await tap("Collection on")
      ok("on", await expectLog(/analytics-lab collection on ok=true/))
      await tap("Consent granted")
      ok("consent", await expectLog(/analytics-lab consent analytics=true ok=true/))
      await tap("Log an event")
      ok("event", await expectLog(/analytics-lab event sent=true/))
      ok("firebase", await expectFa(/Logging event.*name=zn_lab_tap/))
      check(/zn_bundle=/.test(await expectFa(/Logging event.*name=zn_lab_tap/)), "the event has no zn_bundle parameter")
      await tap("Log a purchase")
      ok("purchase", await expectFa(/Logging event.*name=purchase/))
      await tap("Log a bad name")
      ok("bad name", await expectLog(/analytics-lab bad name sent=false/))
      await tap("Set user and property")
      ok("user", await expectLog(/analytics-lab user set ok=true/))
      await tap("App instance id")
      const id = await expectLog(/analytics-lab instance id /)
      check(!/instance id 0$/.test(id), `no app instance id: ${id}`)
      ok("instance id", id)
      // Debug mode sends at once. Play services' measurement service logs Google's answer.
      ok("uploaded", await expectFa(/Successful upload\. Got network response\. code, size: 204/, 60000))
    },
  },
  {
    name: "analytics screen views by route",
    run: async () => {
      if (!(await lab())) return
      await tap("Collection on")
      await expectLog(/analytics-lab collection on ok=true/)
      await tap("Open the Crashlytics lab")
      await see("Read status")
      ok("screen view", await expectFa(/Logging event.*name=screen_view.*crashlyticsLab/))
    },
  },
  {
    name: "analytics off sends nothing",
    run: async () => {
      if (!(await lab())) return
      await tap("Collection off")
      ok("off", await expectLog(/analytics-lab collection off ok=true/))
      adb("logcat", "-c")
      await tap("Log an event")
      await expectLog(/analytics-lab event sent=true/)
      await sleep(3000)
      check(!/Logging event.*name=zn_lab_tap/.test(faLog()), "an event was logged with collection off")
      ok("nothing logged", "no zn_lab_tap in FA")
      // Leave it on for the next run's screen views (Firebase keeps the setting across starts).
      await tap("Collection on")
      await expectLog(/analytics-lab collection on ok=true/)
    },
  },
]
