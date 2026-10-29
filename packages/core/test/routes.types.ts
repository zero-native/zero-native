// Type-level checks for defineRoutes (run with `bunx tsc -p packages/core/test/tsconfig.types.json`).
// Lines marked @ts-expect-error must fail to type-check; everything else must pass.
import { defineRoutes, type RouteParams } from "../src/routes"
import { nav } from "../src/nav"
import type { View } from "../src/view"

declare function Home(props: {}): View
declare function Amount(props: { merchantId: string }): View
declare function Tab(props: { merchantId: string; tab: string; extra?: number }): View
declare function Numeric(props: { merchantId: number }): View

const routes = defineRoutes({
  home: { path: "/", screen: Home },
  amount: { path: "/pay/:merchantId", screen: Amount, deepLink: true },
  tab: { path: "/pay/:merchantId/:tab", screen: Tab, transition: "modal" },
})
const p: RouteParams<typeof routes, "amount"> = { merchantId: "m1" }
void p

// Typed navigation once the app registers its routes (apps do this in routes.ts).
declare module "../src/nav" {
  interface Register {
    routes: typeof routes
  }
}
nav.push("home")
nav.push("amount", { merchantId: "m1" })
nav.replace("tab", { merchantId: "m1", tab: "upi" })
// @ts-expect-error missing params
nav.push("amount")
// @ts-expect-error wrong param name
nav.push("amount", { merchant: "m1" })
// @ts-expect-error unknown route
nav.push("nope")

// A path param the screen doesn't take.
defineRoutes({
  // @ts-expect-error
  bad: { path: "/pay/:merchantId", screen: Home },
})
// A path param that isn't a string.
defineRoutes({
  // @ts-expect-error
  bad: { path: "/pay/:merchantId", screen: Numeric },
})
// Unknown transition.
defineRoutes({
  // @ts-expect-error
  bad: { path: "/", screen: Home, transition: "slide" },
})
