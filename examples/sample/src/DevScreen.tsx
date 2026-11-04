// Every screen we check on the phone, in one list (route /dev, button "Dev screens" on the home screen). Add a row here
// whenever a new dev screen is added to routes.ts.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev
import { Column, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { nav } from "@zero-native/core"
import { c } from "./tokens"

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
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 20, paddingBottom: 32, gap: 10 }}>
          <Entry title="Amount keypad" step="1.3–1.4, 3.6" detail="Keypad with ripple + press scale, hold to repeat, cashback lines" onOpen={() => nav.push("amount", { merchantId: "m1" })} />
          <Entry title="Offers feed" step="2.4" detail="Rails, carousel, gradients, impressions, real offer data" onOpen={() => nav.push("offers")} />
          <Entry title="Native modules" step="2.6–2.7" detail="Calls, cancel, error codes, native events, FlowStore visit counter" onOpen={() => nav.push("modules")} />
          <Entry title="Text input" step="3.2–3.3" detail="TextField: formatting, phone, PIN, multiline, keyboard, spans" onOpen={() => nav.push("input")} />
          <Entry title="fetch checks" step="3.4" detail="27 network cases; needs tools/fetch-test-server.ts + adb reverse" onOpen={() => nav.push("fetch")} />
          <Entry title="Storage checks" step="3.5" detail="MMKV storage, Kotlin access, concurrent writes, SecureStore, kill test" onOpen={() => nav.push("storage")} />
          <Entry title="Press feedback" step="3.6" detail="Ripple colours / opacity / borderless, highlight, press opacity and scale" onOpen={() => nav.push("press")} />
          <Entry title="Animation" step="3.6" detail="animate, enter / exit, swap, list rows (6 s demo loop on open)" onOpen={() => nav.push("animation")} />
          <Entry title="Components & a11y" step="3.7–3.8" detail="Switch, Checkbox, Spinner, Progress, Shimmer, Toast, TalkBack semantics, maxFontScale" onOpen={() => nav.push("components")} />
          <Entry title="Crash lab" step="3.9" detail="A screen, part, tap, async task or loop that fails; bad native data; Intl check" onOpen={() => nav.push("crashLab")} />
          <Entry title="Other apps" step="P.2" detail="Open the mock UPI app for a result, ack, permissions, Os, an app icon handle" onOpen={() => nav.push("launch")} />
          <Entry title="Core for plugins" step="P.3b" detail="Native screens and views, zn://file, tasks, secure screens, dark mode" onOpen={() => nav.push("coreLab")} />
          <Entry title="Scanner plugin" step="P.4" detail="QR scan: full screen and a view in a screen" onOpen={() => nav.push("scannerLab")} />
          <Entry title="Media plugin" step="P.4" detail="Pick, take, compress, upload by handle" onOpen={() => nav.push("mediaLab")} />
          <Entry title="Auth plugin" step="P.3b" detail="Phone number hint, SMS OTP" onOpen={() => nav.push("authLab")} />
          <Entry title="WebView plugin" step="P.6" detail="A page in a screen: cookies, upload, messages, links" onOpen={() => nav.push("webviewLab")} />
          <Entry title="SVG lab" step="S.4" detail=".svg files as components, icons, gradients, a clip, text over SVG, runtime parts, a list" onOpen={() => nav.push("svgLab")} />
          <Entry title="RN basics" step="RN pack" detail="Alert, Clipboard, Share, Linking, Platform, Dimensions, Keyboard, NetInfo, Vibration, URL, OTP focus" onOpen={() => nav.push("rnLab")} />
          <Entry title="Tabs" step="tabs" detail="A home with 4 tabs, own bar, Scan button, data from the test server; back, focus, links" onOpen={() => nav.push("tabsLab")} />
          <Entry title="PDF plugin" step="PDF" detail="Download and cache, a card preview, the full viewer with zoom, bad files" onOpen={() => nav.push("pdfLab")} />
          <Entry title="Location plugin" step="location" detail="One fix, updates, permission, location off, geocoder" onOpen={() => nav.push("locationLab")} />
          <Entry title="RN props" step="RN pack 2" detail="Long press, shadows, corners, pointerEvents, hitSlop, Image, onLayout, Modal, StatusBar, sticky rows" onOpen={() => nav.push("rnPropsLab")} />
          <Entry title="Crashlytics plugin" step="crashlytics" detail="JS errors, keys, user id, opt-out, test crashes" onOpen={() => nav.push("crashlyticsLab")} />
          <Entry title="Push plugin" step="push" detail="FCM token, data messages, notifications: channels, pictures, groups, taps" onOpen={() => nav.push("pushLab")} />
          <Entry title="Analytics plugin" step="analytics" detail="Off until consent, events, purchase, user, screen views by route" onOpen={() => nav.push("analyticsLab")} />
          <Entry title="Remote Config plugin" step="remote config" detail="Defaults, fetch and activate, values with their source, live updates" onOpen={() => nav.push("remoteConfigLab")} />
          <Entry title="Performance plugin" step="perf" detail="Custom traces, fetch traces, a trace per screen with slow frames" onOpen={() => nav.push("perfLab")} />
          <Entry title="Updates (OTA)" step="4.5" detail="What runs now and next, the last check, check now" onOpen={() => nav.push("updates")} />
        </Column>
      </Scroll>
    </Column>
  )
}
