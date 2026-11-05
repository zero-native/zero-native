// The sample's routes (ARCHITECTURE.md §11). The compiler reads this at build time: the order here is the route
// order in the manifest, and "/" is where the app starts.
import { defineRoutes } from "@zero-native/core"
import { HomeScreen } from "./HomeScreen"
import { AmountScreen } from "./AmountScreen"
import { ReceiptScreen } from "./ReceiptScreen"
import { OffersScreen } from "./OffersScreen"
import { LaunchScreen } from "./LaunchScreen"
import { ModulesScreen } from "./ModulesScreen"
import { InputScreen } from "./InputScreen"
import { FetchScreen } from "./FetchScreen"
import { StorageScreen } from "./StorageScreen"
import { AnimationScreen } from "./AnimationScreen"
import { DevScreen } from "./DevScreen"
import { PressScreen } from "./PressScreen"
import { ComponentsScreen } from "./ComponentsScreen"
import { CrashLabScreen, CrashScreen } from "./CrashLabScreen"
import { UpdatesScreen } from "./UpdatesScreen"
import { CoreLabScreen, SecureLabScreen } from "./CoreLabScreen"
import { ScannerLabScreen } from "./ScannerLab"
import { MediaLabScreen } from "./MediaLab"
import { AuthLabScreen } from "./AuthLab"
import { WebViewLabScreen } from "./WebViewLab"
import { SvgLabScreen } from "./SvgLab"
import { RnBasicsLabScreen } from "./RnBasicsLab"
import { TabsLabScreen } from "./TabsLab"
import { PdfLabScreen } from "./PdfLab"
import { LocationLabScreen } from "./LocationLab"
import { RnPropsLabScreen } from "./RnPropsLab"
import { RnNamesLabScreen } from "./RnNamesLab"
import { CrashlyticsLabScreen } from "./CrashlyticsLab"
import { PushLabScreen } from "./PushLab"
import { AnalyticsLabScreen } from "./AnalyticsLab"
import { RemoteConfigLabScreen } from "./RemoteConfigLab"
import { PerfLabScreen } from "./PerfLab"
import { LottieLabScreen } from "./LottieLab"

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
  crashLab: { path: "/dev/crash", screen: CrashLabScreen, deepLink: true },
  // restore: false: not reopened after Android kills the app (step 3.9); the crash lab is reopened instead.
  crashScreen: { path: "/dev/crash/screen", screen: CrashScreen, restore: false },
  updates: { path: "/dev/updates", screen: UpdatesScreen, deepLink: true },
  launch: { path: "/dev/launch", screen: LaunchScreen, deepLink: true },
  coreLab: { path: "/dev/core", screen: CoreLabScreen, deepLink: true },
  fakeScreen: { path: "/dev/core/native", native: "device.fake-screen" },
  secureLab: { path: "/dev/core/secure", screen: SecureLabScreen, secure: true },
  scannerLab: { path: "/dev/scanner", screen: ScannerLabScreen, deepLink: true },
  scan: { path: "/dev/scanner/full", native: "scanner.full", safeArea: "none" },
  mediaLab: { path: "/dev/media", screen: MediaLabScreen, deepLink: true },
  authLab: { path: "/dev/auth", screen: AuthLabScreen, deepLink: true },
  webviewLab: { path: "/dev/webview", screen: WebViewLabScreen, deepLink: true },
  svgLab: { path: "/dev/svg", screen: SvgLabScreen, deepLink: true },
  rnLab: { path: "/dev/rn", screen: RnBasicsLabScreen, deepLink: true },
  // A home screen with four tabs. A link to /dev/tabs/<tab> opens that tab.
  tabsLab: { path: "/dev/tabs", screen: TabsLabScreen, deepLink: true, tabs: ["pay", "stores", "offers", "rewards"] },
  pdfLab: { path: "/dev/pdf", screen: PdfLabScreen, deepLink: true },
  locationLab: { path: "/dev/location", screen: LocationLabScreen, deepLink: true },
  rnPropsLab: { path: "/dev/rn-props", screen: RnPropsLabScreen, deepLink: true },
  rnNamesLab: { path: "/dev/rn-names", screen: RnNamesLabScreen, deepLink: true },
  crashlyticsLab: { path: "/dev/crashlytics", screen: CrashlyticsLabScreen, deepLink: true },
  pushLab: { path: "/dev/push", screen: PushLabScreen, deepLink: true },
  analyticsLab: { path: "/dev/analytics", screen: AnalyticsLabScreen, deepLink: true },
  remoteConfigLab: { path: "/dev/remote-config", screen: RemoteConfigLabScreen, deepLink: true },
  perfLab: { path: "/dev/perf", screen: PerfLabScreen, deepLink: true },
  lottieLab: { path: "/dev/lottie", screen: LottieLabScreen, deepLink: true },
})

// Typed navigation: nav.push("amount", { merchantId }) is checked against these routes.
declare module "@zero-native/core" {
  interface Register {
    routes: typeof routes
  }
}
