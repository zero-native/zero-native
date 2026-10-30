// The sample's routes (ARCHITECTURE.md §11). The compiler reads this at build time: the order here is the route
// order in the manifest, and "/" is where the app starts.
import { defineRoutes } from "@zero-native/core"
import { HomeScreen } from "./HomeScreen"
import { AmountScreen } from "./AmountScreen"
import { ReceiptScreen } from "./ReceiptScreen"
import { OffersScreen } from "./OffersScreen"
import { ModulesScreen } from "./ModulesScreen"
import { InputScreen } from "./InputScreen"
import { FetchScreen } from "./FetchScreen"
import { StorageScreen } from "./StorageScreen"
import { AnimationScreen } from "./AnimationScreen"
import { DevScreen } from "./DevScreen"
import { PressScreen } from "./PressScreen"
import { ComponentsScreen } from "./ComponentsScreen"

export const routes = defineRoutes({
  home: { path: "/", screen: HomeScreen },
  amount: { path: "/pay/:merchantId", screen: AmountScreen, deepLink: true },
  // Full-bleed: its green header runs behind the status bar (light icons on it).
  receipt: { path: "/receipt/:ztc", screen: ReceiptScreen, transition: "modal", safeArea: { top: false }, statusBar: "light" },
  offers: { path: "/offers", screen: OffersScreen, deepLink: true },
  modules: { path: "/dev/modules", screen: ModulesScreen, deepLink: true },
  input: { path: "/dev/input", screen: InputScreen, deepLink: true },
  fetch: { path: "/dev/fetch", screen: FetchScreen, deepLink: true },
  storage: { path: "/dev/storage", screen: StorageScreen, deepLink: true },
  animation: { path: "/dev/animation", screen: AnimationScreen, deepLink: true },
  dev: { path: "/dev", screen: DevScreen, deepLink: true },
  press: { path: "/dev/press", screen: PressScreen, deepLink: true },
  components: { path: "/dev/components", screen: ComponentsScreen, deepLink: true },
})

// Typed navigation: nav.push("amount", { merchantId }) is checked against these routes.
declare module "@zero-native/core" {
  interface Register {
    routes: typeof routes
  }
}
