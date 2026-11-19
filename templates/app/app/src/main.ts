// The app's JS entry. Native opens the first screen ("/", or a link's screen on top of it) and JS draws it.
import { installRuntime, startApp } from "@zeronative/core"
import { routes } from "./routes"

installRuntime()
startApp(routes)
