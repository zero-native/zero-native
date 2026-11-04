// Phone steps for the Performance plugin (examples/sample/src/PerfLab.tsx). No hands. Needs a sample built WITH
// android/sample/google-services.json; without it every step says SKIP and passes. Proof: Firebase Performance's own
// logcat lines (the sample's manifest turns them on: firebase_performance_logcat_enabled).
import { adb, check, expectLog, ok, openFresh, see, sleep, tap, type Step } from "./helpers"

const perfLog = () => adb("logcat", "-d", "-v", "brief", "-s", "FirebasePerformance:*")

async function expectPerf(re: RegExp, ms = 30000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = perfLog().split(/\r?\n/).filter((l) => re.test(l)).at(-1)
    if (hit) return hit.replace(/^.*?: /, "").trim()
    await sleep(500)
  }
  throw new Error(`never logged ${re}`)
}

export const steps: Step[] = [
  {
    name: "perf traces: custom, fetch and screen",
    run: async () => {
      await openFresh("dev/perf", "Read status")
      await tap("Read status")
      const s = await expectLog(/perf-lab status /)
      if (!s.includes("available=true")) return console.log(`SKIP perf: Firebase is off in this build: ${s}`)
      ok("status", s)
      await tap("Custom trace")
      await expectLog(/perf-lab trace stopped/)
      ok("custom trace", await expectPerf(/Logging trace metric.*zn_lab_trace/))
      await tap("Fetch a page")
      ok("fetch", await expectLog(/perf-lab fetch status=204/, 20000))
      const net = await expectPerf(/Logging network request trace.*gstatic\.com\/generate_204/)
      check(!net.includes("lab=perf"), `the query reached Firebase: ${net}`)
      ok("fetch trace, no query", net)
      await tap("Open the Analytics lab")
      await see("Read status")
      ok("screen trace", await expectPerf(/Logging trace metric.*screen_perfLab/))
    },
  },
]
