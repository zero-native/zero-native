// The sample's routes (ARCHITECTURE.md §11). The compiler reads this at build time: the order here is the route
// order in the manifest, and "/" is where the app starts.
import { defineRoutes } from "@zeronative/core"
import { HomeScreen } from "./HomeScreen"
import { AmountScreen } from "./AmountScreen"
import { ReceiptScreen } from "./ReceiptScreen"
import { OffersScreen } from "./OffersScreen"
import { ImpressionsLabScreen } from "./ImpressionsLab"
import { LaunchScreen } from "./LaunchScreen"
import { ModulesScreen } from "./ModulesScreen"
import { InputScreen } from "./InputScreen"
import { FetchScreen } from "./FetchScreen"
import { CallPoolLab, ImageListLab, ImageParLab, NetLoopLab } from "./CallPoolLab"
import { StorageScreen } from "./StorageScreen"
import { AnimationScreen } from "./AnimationScreen"
import { DevScreen } from "./DevScreen"
import { PressScreen } from "./PressScreen"
import { TouchLabScreen } from "./TouchLab"
import { ComponentsScreen } from "./ComponentsScreen"
import { CrashLabScreen, CrashScreen } from "./CrashLabScreen"
import { UpdatesScreen } from "./UpdatesScreen"
import { CoreLabScreen, SecureLabScreen, SeeThroughLabScreen } from "./CoreLabScreen"
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
import { SheetLeaveLabScreen } from "./SheetLeaveLab"
import { LayoutLabScreen } from "./LayoutLab"
import { RnGapsLabScreen } from "./RnGapsLab"
import { A11yLabScreen } from "./A11yLab"
import { GridLabScreen } from "./GridLab"
import { RnNamesLabScreen } from "./RnNamesLab"
import { CrashlyticsLabScreen } from "./CrashlyticsLab"
import { PushLabScreen } from "./PushLab"
import { AnalyticsLabScreen } from "./AnalyticsLab"
import { RemoteConfigLabScreen } from "./RemoteConfigLab"
import { PerfLabScreen } from "./PerfLab"
import { LottieLabScreen } from "./LottieLab"
import { OtpLabScreen } from "./OtpLab"
import { DeviceInfoLabScreen } from "./DeviceInfoLab"
import { AppUpdatesLabScreen } from "./AppUpdatesLab"
import { MarkdownLabScreen } from "./MarkdownLab"
import { DocScanLabScreen } from "./DocScanLab"
import { ImageViewerLabScreen } from "./ImageViewerLab"
import { InvisibleLayerScreen } from "./ImageViewerLab"
import { ImageViewerPageLabScreen } from "./ImageViewerPageLab"
import { ImageViewerScreen } from "@zeronative/image-viewer/screen"
import { LayerLabScreen } from "./AppLayers"
import { ChatListLabScreen } from "./ChatListLab"
import { DynamicLayoutLabScreen } from "./DynamicLayoutLab"
import { CanvasLabScreen } from "./CanvasLab"
import { MotionVideoLabScreen } from "./MotionVideoLab"
import { MotionPayLabScreen } from "./MotionPayLab"
import { MotionFeedLabScreen } from "./MotionFeedLab"
import { MotionMediaLabScreen } from "./MotionMediaLab"
import { ScrollLabScreen } from "./ScrollLab"
import { MotionCardsLabScreen } from "./MotionCardsLab"
import { MotionLayoutLabScreen } from "./MotionLayoutLab"
import { MotionSheetsLabScreen } from "./MotionSheetsLab"
import { MotionScreensDetailScreen, MotionScreensLabScreen } from "./MotionScreensLab"
import { MotionExtensionLabScreen } from "./MotionExtensionLab"
import { WebSocketLabScreen } from "./WebSocketLab"
import { LifecycleLabScreen } from "./LifecycleLab"
import { GestureLabScreen } from "./GestureLab"
import { MotionCoreLabScreen } from "./MotionCoreLab"
import { MotionEngineLabScreen } from "./MotionEngineLab"
import { MotionBindingsLabScreen } from "./MotionBindingsLab"
import { ElementValuesLabScreen } from "./ElementValuesLab"
import { ListsTwoLabScreen } from "./ListsTwoLab"
import { NavStartLabScreen, SharedLabDetailScreen, SharedLabScreen, SharedLabSeeThroughScreen } from "./SharedLab"
import { PaintLabScreen, PaintFadeListLabScreen } from "./PaintLab"
import { TextPolishLabScreen, TextPolishLinesLabScreen, TextSpacingLabScreen } from "./TextPolishLab"
import { NavRaceLabScreen, NavRaceTargetScreen } from "./NavRaceLab"
import { TouchFixLabScreen } from "./TouchFixLab"
import { ChecksLabScreen } from "./ChecksLab"

export const routes = defineRoutes({
  home: { path: "/", screen: HomeScreen },
  amount: { path: "/pay/:merchantId", screen: AmountScreen, deepLink: true },
  // Full-bleed: its green header runs behind the status bar (light icons on it).
  receipt: { path: "/receipt/:ztc", screen: ReceiptScreen, transition: "modal", safeArea: { top: false }, statusBar: "light" },
  offers: { path: "/offers", screen: OffersScreen, deepLink: true },
  modules: { path: "/dev/modules", screen: ModulesScreen, deepLink: true },
  input: { path: "/dev/input", screen: InputScreen, deepLink: true },
  fetch: { path: "/dev/fetch", screen: FetchScreen, deepLink: true },
  callPool: { path: "/dev/call-pool", screen: CallPoolLab, deepLink: true },
  netLoop: { path: "/dev/net-loop", screen: NetLoopLab, deepLink: true },
  imagePar: { path: "/dev/image-par", screen: ImageParLab, deepLink: true },
  imageList: { path: "/dev/image-list", screen: ImageListLab, deepLink: true },
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
  layerLab: { path: "/dev/layers", screen: LayerLabScreen, deepLink: true },
  chatLab: { path: "/dev/chat", screen: ChatListLabScreen, deepLink: true },
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
  layoutLab: { path: "/dev/layout", screen: LayoutLabScreen, deepLink: true },
  rnGapsLab: { path: "/dev/rn-gaps", screen: RnGapsLabScreen, deepLink: true },
  a11yLab: { path: "/dev/a11y", screen: A11yLabScreen, deepLink: true },
  gridLab: { path: "/dev/grid", screen: GridLabScreen, deepLink: true },
  rnNamesLab: { path: "/dev/rn-names", screen: RnNamesLabScreen, deepLink: true },
  crashlyticsLab: { path: "/dev/crashlytics", screen: CrashlyticsLabScreen, deepLink: true },
  pushLab: { path: "/dev/push", screen: PushLabScreen, deepLink: true },
  analyticsLab: { path: "/dev/analytics", screen: AnalyticsLabScreen, deepLink: true },
  remoteConfigLab: { path: "/dev/remote-config", screen: RemoteConfigLabScreen, deepLink: true },
  perfLab: { path: "/dev/perf", screen: PerfLabScreen, deepLink: true },
  lottieLab: { path: "/dev/lottie", screen: LottieLabScreen, deepLink: true },
  otpLab: { path: "/dev/otp", screen: OtpLabScreen, deepLink: true },
  deviceInfoLab: { path: "/dev/device-info", screen: DeviceInfoLabScreen, deepLink: true },
  appUpdatesLab: { path: "/dev/app-updates", screen: AppUpdatesLabScreen, deepLink: true },
  markdownLab: { path: "/dev/markdown", screen: MarkdownLabScreen, deepLink: true },
  docScanLab: { path: "/dev/document-scanner", screen: DocScanLabScreen, deepLink: true },
  imageViewerLab: { path: "/dev/image-viewer", screen: ImageViewerLabScreen, deepLink: true },
  dynamicLayoutLab: { path: "/dev/dynamic-layout", screen: DynamicLayoutLabScreen, deepLink: true },
  canvasLab: { path: "/dev/canvas", screen: CanvasLabScreen, deepLink: true },
  // Gestures and motion labs (docs/gestures-and-motion-v1.md §4). The video lab sets keyboard "none": the card moves up by env.keyboardHeight itself.
  motionVideoLab: { path: "/dev/motion/video", screen: MotionVideoLabScreen, deepLink: true, keyboard: "none" },
  motionPayLab: { path: "/dev/motion/pay", screen: MotionPayLabScreen, deepLink: true },
  motionFeedLab: { path: "/dev/motion/feed", screen: MotionFeedLabScreen, deepLink: true },
  motionMediaLab: { path: "/dev/motion/media", screen: MotionMediaLabScreen, deepLink: true },
  scrollLab: { path: "/dev/scroll", screen: ScrollLabScreen, deepLink: true },
  motionCardsLab: { path: "/dev/motion/cards", screen: MotionCardsLabScreen, deepLink: true },
  motionLayoutLab: { path: "/dev/motion/layout", screen: MotionLayoutLabScreen, deepLink: true },
  // The sheets lab sets keyboard "none": its input bar moves up by env.keyboardHeight itself.
  motionSheetsLab: { path: "/dev/motion/sheets", screen: MotionSheetsLabScreen, deepLink: true, keyboard: "none" },
  motionScreensLab: { path: "/dev/motion/screens", screen: MotionScreensLabScreen, deepLink: true },
  // The store page of the screens lab: the photo of the tapped store flies here (sharedTag). Full-bleed, light status bar icons.
  // Fade, not slide: the photo is what moves; dragged down to close, the page fades where it is instead of sliding sideways.
  motionScreensDetail: { path: "/dev/motion/screens/detail", screen: MotionScreensDetailScreen, safeArea: { top: false }, statusBar: "light", transition: "fade" },
  motionExtensionLab: { path: "/dev/motion/extension", screen: MotionExtensionLabScreen, deepLink: true },
  motionEngineLab: { path: "/dev/motion/engine", screen: MotionEngineLabScreen, deepLink: true },
  motionBindingsLab: { path: "/dev/motion/bindings", screen: MotionBindingsLabScreen, deepLink: true },
  imageViewer: { path: "/dev/image-viewer/full", native: "imageviewer.full", safeArea: "none", transition: "fade" },
  // The TSX viewer (registry 24): see-through, so the lab stays drawn under it while the photo flies and fades.
  photoViewer: { path: "/dev/image-viewer/tsx", screen: ImageViewerScreen, transparent: true, accessibilityHidesBelow: true, safeArea: "none", statusBar: "light", restore: false, transition: "none" },
  // Sheets that leave the tree while open (zn ca3734d). Last, so the numbers of the routes before it do not move.
  sheetLeaveLab: { path: "/dev/sheet-leave", screen: SheetLeaveLabScreen, deepLink: true },
  // The secure lab's native screen: `secure: true` on a plugin's screen. Last, as above.
  secureNative: { path: "/dev/core/secure-native", native: "device.fake-screen", secure: true },
  // WebSocket checks (docs/fetch.md §8). Last, after the secure native screen, so the numbers of the routes before it do not move.
  wsLab: { path: "/dev/websocket", screen: WebSocketLabScreen, deepLink: true },
  // The app's life: Dimensions on rotation and text size, motion env, app state. Last, so the numbers before it stay.
  lifecycleLab: { path: "/dev/lifecycle", screen: LifecycleLabScreen, deepLink: true },
  // See-through screens over the core lab (registry 24): transition "none" (the content fades itself in), and "push"
  // (it slides in alone over the still screen below; the edge swipe moves it alone). Last, as above.
  seeThroughLab: { path: "/dev/core/see-through", screen: SeeThroughLabScreen, transparent: true, transition: "none", safeArea: "none", restore: false },
  seeThroughSlide: { path: "/dev/core/see-through-slide", screen: SeeThroughLabScreen, transparent: true, transition: "push", safeArea: "none", statusBar: "light", restore: false },
  // Gestures no motion lab covers (iOS's native gestures, W3-A). Last, so the numbers of the routes before it do not move.
  gestureLab: { path: "/dev/motion/gestures", screen: GestureLabScreen, deepLink: true },
  // useElementMotion values (box, pressed, Scroll / List / Carousel values, follow) and a Pressable drawn away from its
  // place by its transforms. Last, as above.
  elementValuesLab: { path: "/dev/motion/element-values", screen: ElementValuesLabScreen, deepLink: true },
  // The same lab on a modal route: its box values once the screen has come up (W3-B review). Last, as above.
  elementValuesModal: { path: "/dev/motion/element-values-modal", screen: ElementValuesLabScreen, transition: "modal", restore: false },
  // The motion core with no gestures: commands, timeline, formulas, env, 3D, elements, plugin values, tilt,
  // animateLayout, useFrame (registry 24). Last, so the numbers of the routes before it do not move.
  motionCoreLab: { path: "/dev/motion/core", screen: MotionCoreLabScreen, deepLink: true },
  // Impressions: hidden tabs, clipping, minMs, rails and rows (ImpressionsLab.tsx). Last, as above.
  impressionsLab: { path: "/dev/impressions", screen: ImpressionsLabScreen, deepLink: true },
  // Lists 2: item animation, drag to reorder, scroll extras, pinned rows and an inverted chat on <List>. Last, as above.
  listsTwoLab: { path: "/dev/lists2", screen: ListsTwoLabScreen, deepLink: true },
  // Shared elements over every kind of route (SharedLab.tsx): push, modal, fade, secure, see-through, none; and a
  // start screen that pushes a route before NAV STARTED (no slide in). Last, so the numbers before them stay.
  sharedLab: { path: "/dev/nav/shared", screen: SharedLabScreen, deepLink: true },
  sharedLabDetail: { path: "/dev/nav/shared/detail", screen: SharedLabDetailScreen, restore: false },
  sharedLabModal: { path: "/dev/nav/shared/modal", screen: SharedLabDetailScreen, transition: "modal", restore: false },
  sharedLabFade: { path: "/dev/nav/shared/fade", screen: SharedLabDetailScreen, transition: "fade", restore: false },
  sharedLabSecure: { path: "/dev/nav/shared/secure", screen: SharedLabDetailScreen, secure: true, restore: false },
  sharedLabNone: { path: "/dev/nav/shared/none", screen: SharedLabDetailScreen, transition: "none", restore: false },
  sharedLabSeeThrough: { path: "/dev/nav/shared/see-through", screen: SharedLabSeeThroughScreen, transparent: true, transition: "fade", safeArea: "none", restore: false },
  navStartLab: { path: "/dev/nav/start", screen: NavStartLabScreen, restore: false },
  // The image viewer's page view alone, moved by buttons (no gestures): loading, events, the zoom's move, sharp parts.
  // Last, as above.
  imageViewerPageLab: { path: "/dev/image-viewer/page", screen: ImageViewerPageLabScreen, deepLink: true },
  // An absolute layer at opacity 0 over the image viewer lab (see-through): it stops taps, as on Android. Last, as above.
  ivInvisibleLayer: { path: "/dev/image-viewer/invisible-layer", screen: InvisibleLayerScreen, transparent: true, transition: "none", restore: false },
  // Who takes a tap where Pressables, scrolls and overlays meet (TouchLab.tsx). Last, as above.
  touchLab: { path: "/dev/touch", screen: TouchLabScreen, deepLink: true },
  // Paint parity: a rounded Pressable's clip, opacity as one picture, elevation without a background. Last, as above.
  paintLab: { path: "/dev/paint", screen: PaintLabScreen, deepLink: true },
  // Text and field polish (TextPolishLab.tsx): multiline maxHeight, returnKeyType next, a Text in a tall box, a field's
  // letterSpacing, numberOfLines 0, fields on a hidden tab or clipped by a Scroll. Last, as above.
  textPolishLab: { path: "/dev/text-polish", screen: TextPolishLabScreen, deepLink: true },
  // numberOfLines={0} on its own screen (Android throws there until ZnTemplate.kt maps 0). Last, as above.
  textPolishLinesLab: { path: "/dev/text-polish/lines", screen: TextPolishLinesLabScreen, deepLink: true },
  // A second push or back while a slide is under way (NavRaceLab.tsx). Last, as above.
  navRaceLab: { path: "/dev/nav/race", screen: NavRaceLabScreen, deepLink: true },
  navRaceTarget: { path: "/dev/nav/race/target", screen: NavRaceTargetScreen, restore: false },
  // A Switch or Checkbox inside a Pressable, a disabled button in a card, a long press in a Scroll, the ripple timings
  // (TouchFixLab.tsx). Last, as above.
  touchFixLab: { path: "/dev/touch/fixes", screen: TouchFixLabScreen, deepLink: true },
  // letterSpacing centred and lineHeight (TextPolishLab.tsx §11 and §12), in a Scroll Android can open. Last, as above.
  textSpacingLab: { path: "/dev/text-polish/spacing", screen: TextSpacingLabScreen, deepLink: true },
  // 100 List rows with an enter fade (PaintLab.tsx §8), to measure scrolling them. Last, as above.
  paintFadeListLab: { path: "/dev/paint/fade-list", screen: PaintFadeListLabScreen, deepLink: true },
  // Checks that had no screen: motion text grouping, taps on 3D-turned views, a NativeView's testID and pointerEvents
  // (ChecksLab.tsx; UI test ChecksLabTests). Last, as above.
  checksLab: { path: "/dev/checks", screen: ChecksLabScreen, deepLink: true },
})

// Typed navigation: nav.push("amount", { merchantId }) is checked against these routes.
declare module "@zeronative/core" {
  interface Register {
    routes: typeof routes
  }
}
