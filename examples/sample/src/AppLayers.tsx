// startApp's app layers (main.ts): an offline strip above every screen (`top`) and one "No internet" sheet over all of
// them (`overlay`), the way the RN app does it. The strip follows NetInfo; the lab screen can also fake "offline".
// The phone test reads the log lines "layers ...", so keep their wording.
import { Column, Pressable, Row, Scroll, Sheet, Text } from "@zero-native/ui"
import { nav, NetInfo, scheme, signal } from "@zero-native/core"
import { c } from "./tokens"

const RED = "#D92D20"
const GREEN = "#12B76A"

/** "offline": red strip. "back": green "Back online" for 1.5 s. "none": no strip. */
const strip = signal<"none" | "offline" | "back">("none")
/** The strip's colour, kept while it closes (the layer shrinks in its root's background). */
const stripColor = signal(RED)
const fakeOffline = signal(false)
const realOffline = signal(false)
const noInternetSheet = signal(false)
let backTimer: ReturnType<typeof setTimeout> | null = null

function update(): void {
  const offline = fakeOffline() || realOffline()
  if (offline) {
    if (backTimer) clearTimeout(backTimer)
    backTimer = null
    strip.set("offline")
    stripColor.set(RED)
  } else if (strip() === "offline") {
    strip.set("back")
    stripColor.set(GREEN)
    backTimer = setTimeout(() => {
      backTimer = null
      strip.set("none")
    }, 1500)
  }
  console.info(`layers strip ${strip()}`)
}

/** startApp `top`: built once, kept while the app runs. No status bar padding here: zn adds it. */
export function AppTop() {
  NetInfo.addEventListener((s) => {
    realOffline.set(s.isConnected === false || s.isInternetReachable === false)
    update()
  })
  return (
    <Column style={{ backgroundColor: stripColor() }}>
      {strip() !== "none" && (
        <Row alignItems="center" justifyContent="center" style={{ height: 24 }}>
          <Text fontSize={12} fontWeight={600} color="#FFFFFF">
            {strip() === "offline" ? "You are offline" : "Back online"}
          </Text>
        </Row>
      )}
    </Column>
  )
}

/** startApp `overlay`: one sheet over every screen; it stays open while screens change under it. */
export function AppOverlay() {
  const close = () => {
    console.info("layers sheet closed")
    noInternetSheet.set(false)
  }
  return (
    <Column>
      <Sheet visible={noInternetSheet()} onDismiss={close}>
        <Column gap={8} style={{ padding: 24 }}>
          <Text fontSize={18} fontWeight={700} color={scheme("#111111", "#EEEEEE")}>
            No Internet Connection
          </Text>
          <Text fontSize={14} color={scheme("#475467", "#BBBBBB")}>
            Please turn on Mobile Data or WiFi
          </Text>
          <Pressable onPress={close} alignItems="center" style={{ marginTop: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: c.primary }}>
            <Text fontSize={15} fontWeight={600} color={c.white}>
              OK
            </Text>
          </Pressable>
        </Column>
      </Sheet>
    </Column>
  )
}

function LayerButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function LayerLabScreen() {
  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
          {`strip: ${strip()}  fake offline: ${fakeOffline()}`}
        </Text>
        <LayerButton label="Fake offline" onPress={() => {
          fakeOffline.set(true)
          update()
        }} />
        <LayerButton label="Fake back online" onPress={() => {
          fakeOffline.set(false)
          update()
        }} />
        <LayerButton label="Show 'No internet' sheet" onPress={() => {
          console.info("layers sheet opened")
          noInternetSheet.set(true)
        }} />
        <LayerButton label="Sheet, then open another screen" onPress={() => {
          noInternetSheet.set(true)
          setTimeout(() => nav.push("coreLab"), 300)
        }} />
        <LayerButton label="Open the native screen" onPress={() => void nav.pushForResult("fakeScreen", { title: "Strip check" })} />
        <LayerButton label="Open the WebView lab" onPress={() => nav.push("webviewLab")} />
      </Column>
    </Scroll>
  )
}
