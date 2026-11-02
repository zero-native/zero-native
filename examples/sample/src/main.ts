// Sample app entry: starts the runtime and the app's routes. Native opens the first screen ("/", or a deep link's
// route on top of it) and tells JS which ones; JS renders them (packages/core/src/nav.ts).
import { installRuntime, startApp } from "@zero-native/core"
import { routes } from "./routes"

installRuntime()
// A link with ?refuse=1 is refused: how the phone test checks the guard, at start and while the app runs.
startApp(routes, {
  onLink: (link) => {
    console.info(`sample: link ${link.url} atStart=${link.atStart}`)
    return link.params.refuse !== "1"
  },
})
console.info("sample: started")
