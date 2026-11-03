// Sample app entry: starts the runtime and the app's routes. Native opens the first screen ("/", or a deep link's
// route on top of it) and tells JS which ones; JS renders them (packages/core/src/nav.ts).
import { defineTask, installRuntime, onNavResult, startApp } from "@zero-native/core"
import { routes } from "./routes"

installRuntime()
// A link with ?refuse=1 is refused: how the phone test checks the guard, at start and while the app runs.
startApp(routes, {
  onLink: (link) => {
    console.info(`sample: link ${link.url} atStart=${link.atStart}`)
    return link.params.refuse !== "1"
  },
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
// With no pushForResult waiting: after a kill, or from nav.push.
onNavResult<{ code: string }>("fakeScreen", (value, ack) => {
  console.info(`core-lab nav result: ${value?.code}`)
  ack()
})
console.info("sample: started")
