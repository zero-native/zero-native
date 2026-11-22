// Sample app entry: starts the runtime and the app's routes. Native opens the first screen ("/", or a deep link's
// route on top of it) and tells JS which ones; JS renders them (packages/core/src/nav.ts).
import { defineTask, installRuntime, onNavResult, Os, startApp } from "@zeronative/core"
import { routes } from "./routes"
import { installPushLab } from "./PushLab"
import { AppOverlay, AppTop } from "./AppLayers"

installRuntime()
// A link with ?refuse=1 is refused: how the phone test checks the guard, at start and while the app runs.
startApp(routes, {
  onLink: (link) => {
    console.info(`sample: link ${link.url} atStart=${link.atStart}`)
    return link.params.refuse !== "1"
  },
  // A link that matches no route: logged (phone test: `adb shell am start -a android.intent.action.VIEW -d zn://sample/nowhere`).
  onUnmatchedLink: (link) => {
    console.info(`sample: unmatched link ${link.url} atStart=${link.atStart}`)
  },
  // An offline strip above every screen and one sheet over all of them (AppLayers.tsx).
  top: AppTop,
  overlay: AppOverlay,
})
// The core phone check (CoreLabScreen.tsx). Tasks are named here, so they exist on a start with no screen.
defineTask("lab.echo", (data: { from: string }) => console.info(`core-lab task echo from ${data.from}`))
defineTask("lab.slow", (_, signal) => {
  signal.addEventListener("abort", () => console.info("core-lab task slow: aborted"))
  return new Promise(() => {})
})
defineTask("lab.throw", () => {
  throw new Error("core-lab task threw")
})
// Ends after data.ms: the iOS check that a task started just before the app goes to the background still ends there
// (ZnTasks' background time; the sample's notifyutil hook dev.zeronative.sample.task).
defineTask("lab.wait", async (data: { ms?: number }, signal) => {
  const ms = data?.ms ?? 8000
  const t0 = Date.now()
  await new Promise<void>((done) => {
    const t = setTimeout(done, ms)
    signal.addEventListener("abort", () => {
      clearTimeout(t)
      console.info(`core-lab task wait: aborted after ${Date.now() - t0} ms`)
      done()
    })
  })
  console.info(`core-lab task wait: ${ms} ms passed (${Date.now() - t0} ms)`)
})
// The push lab (PushLab.tsx): a message, a new token or a swipe can start the app with no screen.
installPushLab()
// With no pushForResult waiting: after a kill, or from nav.push.
onNavResult<{ code: string }>("fakeScreen", (value, ack) => {
  console.info(`core-lab nav result: ${value?.code}`)
  ack()
})
// A native call from the main script, before the first screen: its answer must come on every start, also when the
// runtime is replaced (Back, then the launcher icon: ZnNav.startFresh; Updates.applyNow). The phone test reads this line.
const asked = Date.now()
void Os.info().then(() => console.info(`sample: Os.info answered at start after ${Date.now() - asked} ms`))
console.info("sample: started")
