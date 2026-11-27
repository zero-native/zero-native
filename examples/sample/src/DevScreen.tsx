// Every screen we check on the phone, in one list (route /dev, button "Dev screens" on the home screen), with a search at
// the top. Add a row to LABS (or MORE_LABS) whenever a new dev screen is added to routes.ts.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev
import { Column, Pressable, Row, Scroll, Text, TextField } from "@zeronative/ui"
import { computed, nav, signal } from "@zeronative/core"
import { c } from "./tokens"

type Lab = { title: string; step: string; detail: string; open: () => void }

const LABS: Lab[] = [
  { title: "Amount keypad", step: "1.3–1.4, 3.6", detail: "Keypad with ripple + press scale, hold to repeat, cashback lines", open: () => nav.push("amount", { merchantId: "m1" }) },
  { title: "Offers feed", step: "2.4", detail: "Rails, carousel, gradients, impressions, real offer data", open: () => nav.push("offers") },
  { title: "Native modules", step: "2.6–2.7", detail: "Calls, cancel, error codes, native events, FlowStore visit counter", open: () => nav.push("modules") },
  { title: "Text input", step: "3.2–3.3", detail: "TextField: formatting, phone, PIN, multiline, keyboard, spans", open: () => nav.push("input") },
  { title: "fetch checks", step: "3.4", detail: "27 network cases; needs tools/fetch-test-server.ts + adb reverse", open: () => nav.push("fetch") },
  { title: "WebSocket checks", step: "r23", detail: "Echo, close codes, protocols, limits, binary, pings; needs tools/fetch-test-server.ts", open: () => nav.push("wsLab") },
  { title: "Storage checks", step: "3.5", detail: "MMKV storage, Kotlin access, concurrent writes, SecureStore, kill test", open: () => nav.push("storage") },
  { title: "Press feedback", step: "3.6", detail: "Ripple colours / opacity / borderless, highlight, press opacity and scale", open: () => nav.push("press") },
  { title: "Animation", step: "3.6", detail: "animate, enter / exit, swap, list rows (6 s demo loop on open)", open: () => nav.push("animation") },
  { title: "Components & a11y", step: "3.7–3.8", detail: "Switch, Checkbox, Spinner, Progress, Shimmer, Toast, TalkBack semantics, maxFontScale", open: () => nav.push("components") },
  { title: "Crash lab", step: "3.9", detail: "A screen, part, tap, async task or loop that fails; bad native data; Intl check", open: () => nav.push("crashLab") },
  { title: "Other apps", step: "P.2", detail: "Open the mock UPI app for a result, ack, permissions, Os, an app icon handle", open: () => nav.push("launch") },
  { title: "Chat list", step: "L.2", detail: "<List inverted>: newest at the bottom, new message stays in view, older load at the top", open: () => nav.push("chatLab") },
  { title: "App layers", step: "L.1", detail: "Offline strip above every screen, one sheet over all of them", open: () => nav.push("layerLab") },
  { title: "Core for plugins", step: "P.3b", detail: "Native screens and views, zn://file, tasks, secure screens, dark mode", open: () => nav.push("coreLab") },
  { title: "Scanner plugin", step: "P.4", detail: "QR scan: full screen and a view in a screen", open: () => nav.push("scannerLab") },
  { title: "Media plugin", step: "P.4", detail: "Pick, take, compress, upload by handle", open: () => nav.push("mediaLab") },
  { title: "Auth plugin", step: "P.3b", detail: "Phone number hint, SMS OTP", open: () => nav.push("authLab") },
  { title: "WebView plugin", step: "P.6", detail: "A page in a screen: cookies, upload, messages, links", open: () => nav.push("webviewLab") },
  { title: "SVG lab", step: "S.4", detail: ".svg files as components, icons, gradients, a clip, text over SVG, runtime parts, a list", open: () => nav.push("svgLab") },
  { title: "RN basics", step: "RN pack", detail: "Alert, Clipboard, Share, Linking, Platform, Dimensions, Keyboard, NetInfo, Vibration, URL, OTP focus", open: () => nav.push("rnLab") },
  { title: "Tabs", step: "tabs", detail: "A home with 4 tabs, own bar, Scan button, data from the test server; back, focus, links", open: () => nav.push("tabsLab") },
  { title: "PDF plugin", step: "PDF", detail: "Download and cache, a card preview, the full viewer with zoom, bad files", open: () => nav.push("pdfLab") },
  { title: "Location plugin", step: "location", detail: "One fix, updates, permission, location off, geocoder", open: () => nav.push("locationLab") },
  { title: "RN props", step: "RN pack 2", detail: "Long press, shadows, corners, pointerEvents, hitSlop, Image, onLayout, Modal, StatusBar, sticky rows", open: () => nav.push("rnPropsLab") },
  { title: "RN names", step: "RN sweep", detail: "View, FlatList renderItem, Touchables, ActivityIndicator, marginLeft, colour names, gap with justifyContent, effect cleanup", open: () => nav.push("rnNamesLab") },
  { title: "Crashlytics plugin", step: "crashlytics", detail: "JS errors, keys, user id, opt-out, test crashes", open: () => nav.push("crashlyticsLab") },
  { title: "Push plugin", step: "push", detail: "FCM token, data messages, notifications: channels, pictures, groups, taps", open: () => nav.push("pushLab") },
  { title: "Analytics plugin", step: "analytics", detail: "On by default, opt-out, events, purchase, user, screen views by route", open: () => nav.push("analyticsLab") },
  { title: "Remote Config plugin", step: "remote config", detail: "Defaults, fetch and activate, values with their source, live updates", open: () => nav.push("remoteConfigLab") },
  { title: "Performance plugin", step: "perf", detail: "Custom traces, fetch traces, a trace per screen with slow frames", open: () => nav.push("perfLab") },
  { title: "Lottie plugin", step: "lottie", detail: "JSON and .lottie files, play, pause, reset by ref, progress, finish, colours, bad files", open: () => nav.push("lottieLab") },
  { title: "OTP input", step: "registry 18", detail: "OtpInput as the RN Verify screen: SMS fill, paste, disabled, wrong OTP, TalkBack", open: () => nav.push("otpLab") },
  { title: "Device info", step: "plugin", detail: "react-native-device-info: sync values at module level, battery, disk, network", open: () => nav.push("deviceInfoLab") },
  { title: "App updates plugin", step: "plugin", detail: "Store rules from the update server, Play's optional and forced updates, open the store, busy", open: () => nav.push("appUpdatesLab") },
  { title: "Markdown package", step: "markdown", detail: "Server Markdown as native text: offer details, lists, links through the app, notifications", open: () => nav.push("markdownLab") },
  { title: "Document scanner plugin", step: "docscan", detail: "ML Kit scanner: module status, download, pages and PDF, cancel, a kill while it is open", open: () => nav.push("docScanLab") },
  { title: "Image viewer plugin", step: "image viewer", detail: "Full-screen photos: pinch, pan, double tap, swipe between and to close, sharp zoom, errors", open: () => nav.push("imageViewerLab") },
  { title: "RN gaps lab", step: "registry 24", detail: "App fonts (fontFamily, weights, spans, TextField), flexWrap chips", open: () => nav.push("rnGapsLab") },
  { title: "Accessibility lab", step: "registry 15", detail: "Labels, hints, roles, disabled, long press action, hidden, pictures, fields, testID", open: () => nav.push("a11yLab") },
  { title: "Grid lab", step: "registry 24", detail: "FlatList numColumns: 2 / 3 columns, columnWrapperStyle, short last row, load more, empty, scroll to index", open: () => nav.push("gridLab") },
  { title: "Dynamic layout lab", step: "H.1", detail: "Reactive width/height, animated 40..300, % widths, display: none/flex, dynamic radii & fonts", open: () => nav.push("dynamicLayoutLab") },
  { title: "Canvas primitive", step: "H.4", detail: "200-pt candlestick chart, donut ring, dashed Bezier wave, rotated text (draw-only, no Skia)", open: () => nav.push("canvasLab") },
  { title: "Motion: floating video", step: "M.1", detail: "Drag a card in 2D, flick to a corner, magnet dismiss, pinch to resize, trailing dots, rises with the keyboard, busy JS", open: () => nav.push("motionVideoLab") },
  { title: "Motion: payment controls", step: "M.1", detail: "Slide to pay ₹499, loan slider with ₹ text and ticks, two-knob range slider, circular dial", open: () => nav.push("motionPayLab") },
  { title: "Motion: cards and stories", step: "M.1", detail: "Swipe cards (tilt, LIKE / NOPE, fly out), story viewer (timelines, tap zones, hold to pause, drag down to close)", open: () => nav.push("motionCardsLab") },
  { title: "Motion: photo and chart", step: "M.1", detail: "Zoom photos in a pager (useZoom: pinch around the fingers, edges, double tap), chart you can scrub", open: () => nav.push("motionMediaLab") },
  { title: "Scroll snapping and events", step: "M.2", detail: "Cards snap to the centre, List pager, snapToOffsets, onScroll / drag / momentum log, scrollTo", open: () => nav.push("scrollLab") },
  { title: "Motion: feed", step: "M.1", detail: "Swipe actions on list rows (Archive / Delete, long swipe deletes), bottom panel with a scrolling list inside", open: () => nav.push("motionFeedLab") },
  { title: "Motion: layout", step: "M.1", detail: "Expanding cards that push the rest down, rows removed and moved, every enter / exit preset, animated ₹ counters, a coach tip placed by measure()", open: () => nav.push("motionLayoutLab") },
  { title: "Motion: sheets and tabs", step: "M.1", detail: "Tab underline that follows the pages, sheet with backdrop and header that follow it, input bar on the keyboard, A–Z side bar for a list", open: () => nav.push("motionSheetsLab") },
  { title: "Motion: screens", step: "M.1", detail: "Store photo that flies to the next screen and back, drag-to-reorder list, chips dropped on Keep / Archive", open: () => nav.push("motionScreensLab") },
  { title: "Motion: extension", step: "M.1", detail: "Tilt card, dot moved by a plugin, wobble curve, plugin view drawn from a motion value, frame counter, drag with a manual start", open: () => nav.push("motionExtensionLab") },
  { title: "Motion: core", step: "M.1", detail: "Commands and their promises, timeline, formulas, env, 3D and blur, corners, element values, plugin values and curves, tilt, animateLayout, useFrame; no gestures", open: () => nav.push("motionCoreLab") },
  { title: "Updates (OTA)", step: "4.5", detail: "What runs now and next, the last check, check now", open: () => nav.push("updates") },
]

// Labs added by the iOS gap rounds (registry 24, 2026-11-21 to 11-24), and older ones that had only a link.
const MORE_LABS: Lab[] = [
  { title: "Layout conformance", step: "9.5", detail: "One case per flex rule, each frame checked by onLayout; logs layout-conformance <passed>/<total>", open: () => nav.push("layoutLab") },
  { title: "Lifecycle", step: "r2b", detail: "Dimensions and PixelRatio on rotation and text size, motion env, the keyboard frame, app state", open: () => nav.push("lifecycleLab") },
  { title: "Motion engine checks", step: "M.1", detail: "Commands, promises, derive / map / follow, useFrame: pass / fail from JS (runs on open)", open: () => nav.push("motionEngineLab", { run: true }) },
  { title: "Motion: bindings", step: "M.1", detail: "One timeline drives slide, flip, blur, corners, a fill bar and a width, with no JS per frame", open: () => nav.push("motionBindingsLab") },
  { title: "Gestures", step: "r3", detail: "A 3D-turned card's taps, double tap before tap, rotate, fling, a press on a draggable card", open: () => nav.push("gestureLab") },
  { title: "Element values", step: "r3", detail: "useElementMotion: box, pressed, Scroll / List / Carousel values, follow; a Pressable drawn away from its place", open: () => nav.push("elementValuesLab") },
  { title: "Impressions", step: "r3", detail: "Hidden tabs, clipped boxes, minMs, rows and a rail; logs imp-lab +keys", open: () => nav.push("impressionsLab") },
  { title: "Lists 2", step: "r4", detail: "Item animation, drag to reorder, snap and scroll events, pinned rows, an inverted chat", open: () => nav.push("listsTwoLab") },
  { title: "Shared elements", step: "r4", detail: "sharedTag over push, modal, fade, secure, see-through and none routes; the edge swipe scrubs the flight", open: () => nav.push("sharedLab") },
  { title: "Push at start", step: "r4", detail: "A start screen that pushes the shared lab while it is built (open it with --route navStartLab for the real start)", open: () => nav.push("navStartLab", { then: "sharedLab" }) },
  { title: "Navigation race", step: "polish", detail: "A push or back while a slide or a back swipe is under way; logs nav-race <ok>/<all>", open: () => nav.push("navRaceLab") },
  { title: "Modal drag", step: "r7", detail: "Drag a modal route down to close it: plain, with a list, wants Back, secure, see-through", open: () => nav.push("modalDragLab") },
  { title: "Touch", step: "polish", detail: "Who takes a tap where Pressables, scrolls and overlays meet", open: () => nav.push("touchLab") },
  { title: "Paint", step: "polish", detail: "A rounded Pressable's clip, opacity as one picture, elevation without a background", open: () => nav.push("paintLab") },
  { title: "Text polish", step: "polish", detail: "Multiline maxHeight, Next between fields, a Text in a tall box, field letterSpacing, numberOfLines 0", open: () => nav.push("textPolishLab") },
  { title: "Sheets that leave", step: "L.1", detail: "Sheets and Modals whose node leaves the tree while open, and layers over one another", open: () => nav.push("sheetLeaveLab") },
  { title: "Image viewer page", step: "r4", detail: "One imageviewer.page moved by buttons: loading, events, the zoom's move, sharp parts", open: () => nav.push("imageViewerPageLab") },
  { title: "Call pool", step: "ZB", detail: "Native calls that hold the pool while fetch goes on; needs tools/fetch-test-server.ts", open: () => nav.push("callPool") },
  { title: "Net loop", step: "ZB", detail: "A fetch every 3 s to a public host and the local server, for network changes", open: () => nav.push("netLoop") },
  { title: "Images in parallel", step: "ZB", detail: "Slow pictures in a column, a rail and banners load side by side; needs the test server", open: () => nav.push("imagePar") },
  { title: "Images in a List", step: "ZB", detail: "60 rows of slow pictures while scrolling; needs the test server", open: () => nav.push("imageList") },
]

// The search box's words, any case, each found in the title, the detail or the step.
function matches(lab: Lab, query: string): boolean {
  const text = `${lab.title} ${lab.detail} ${lab.step}`.toLowerCase()
  return query.trim().toLowerCase().split(/\s+/).every((word) => text.includes(word))
}

function Entry(props: { title: string; detail: string; step: string; onOpen: () => void }) {
  return (
    <Pressable
      onPress={props.onOpen}
      style={{ padding: 14, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
    >
      <Row style={{ alignItems: "center", gap: 8 }}>
        <Text fontSize={15} fontWeight={600} color={c.ink} style={{ flex: 1 }}>
          {props.title}
        </Text>
        <Text fontSize={11} fontWeight={600} color={c.muted}>
          {props.step}
        </Text>
      </Row>
      <Text fontSize={12} color={c.muted}>
        {props.detail}
      </Text>
    </Pressable>
  )
}

export function DevScreen() {
  const query = signal("")
  const labs = computed(() => LABS.filter((lab) => matches(lab, query())))
  const moreLabs = computed(() => MORE_LABS.filter((lab) => matches(lab, query())))
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Dev screens
        </Text>
      </Row>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingBottom: 10 }}>
        <TextField
          testID="dev-search"
          accessibilityLabel="Search dev screens"
          placeholder="Search screens"
          value={query()}
          onChangeText={(t) => query.set(t)}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          fontSize={15}
          color={c.ink}
          style={{ flex: 1, height: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.white }}
        />
        {query().trim() !== "" && (
          <Pressable testID="dev-search-clear" onPress={() => query.set("")} style={{ paddingHorizontal: 8, paddingVertical: 10, borderRadius: 8 }}>
            <Text fontSize={14} fontWeight={600} color={c.primary}>
              Clear
            </Text>
          </Pressable>
        )}
      </Row>
      <Scroll style={{ flex: 1 }} keyboardDismissMode="on-drag">
        <Column style={{ paddingHorizontal: 20, paddingBottom: 32, gap: 10 }}>
          {labs().map((lab) => (
            <Entry key={lab.title} title={lab.title} step={lab.step} detail={lab.detail} onOpen={lab.open} />
          ))}
          {moreLabs().length > 0 && (
            <Text fontSize={13} fontWeight={700} color={c.muted} style={{ marginTop: 12 }}>
              More labs
            </Text>
          )}
          {moreLabs().map((lab) => (
            <Entry key={lab.title} title={lab.title} step={lab.step} detail={lab.detail} onOpen={lab.open} />
          ))}
          {labs().length === 0 && moreLabs().length === 0 && (
            <Text testID="dev-search-none" fontSize={14} color={c.muted} style={{ paddingVertical: 24, textAlign: "center" }}>
              No screens match
            </Text>
          )}
        </Column>
      </Scroll>
    </Column>
  )
}
