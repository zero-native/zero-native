// The app's screens. The compiler reads this at build time: "/" is where the app starts. With `deepLink: true` a link
// opens the screen: __APP_NAME__://app/about?from=link
import { defineRoutes } from "@zeronative/core"
import { HomeScreen } from "./HomeScreen"
import { AboutScreen } from "./AboutScreen"

export const routes = defineRoutes({
  home: { path: "/", screen: HomeScreen },
  about: { path: "/about", screen: AboutScreen, deepLink: true },
})

// Typed navigation: nav.push("about", { from: "home" }) is checked against these routes.
declare module "@zeronative/core" {
  interface Register {
    routes: typeof routes
  }
}
