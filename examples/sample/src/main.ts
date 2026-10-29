// Sample app entry: starts the runtime and the app's routes. Native opens the first screen ("/", or a deep link's
// route on top of it) and tells JS which ones; JS renders them (packages/core/src/nav.ts).
import { installRuntime, startApp } from "@zero-native/core"
import { routes } from "./routes"

installRuntime()
startApp(routes)
console.info("sample: started")
