// A dev screen for the RN basics pack: React Native's small everyday APIs, with their RN names. Each button logs one
// "rn-lab ..." line; the phone check reads those lines, so keep their wording.
import { Box, Column, Pressable, Row, Scroll, Stack, Text, TextField } from "@zero-native/ui"
import {
  Alert,
  AppState,
  Clipboard,
  createRef,
  Dimensions,
  flowStore,
  Keyboard,
  Linking,
  NetInfo,
  PixelRatio,
  Platform,
  requestAnimationFrame,
  Share,
  signal,
  ToastAndroid,
  useNetInfo,
  useWindowDimensions,
  Vibration,
  type TextFieldHandle,
} from "@zero-native/core"
import { c } from "./tokens"

function RnButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function RnTitle(props: { text: string }) {
  return (
    <Text fontSize={15} fontWeight={700} color={c.ink} style={{ marginTop: 8 }}>
      {props.text}
    </Text>
  )
}

/** The web globals from React Native that Hermes may lack: one line, "ok" or what failed. */
function webCheck(): string {
  const failed: string[] = []
  const check = (name: string, fn: () => boolean) => {
    try {
      if (!fn()) failed.push(name)
    } catch (err) {
      failed.push(`${name} (${String(err)})`)
    }
  }
  check("URL", () => {
    const u = new URL("upi://pay?pa=shop@upi&am=10.00&tn=Hello%20World")
    const web = new URL("../b?x=1#h", "https://Example.com:443/a/c")
    return u.searchParams.get("tn") === "Hello World" && u.protocol === "upi:" && web.href === "https://example.com/b?x=1#h"
  })
  check("URLSearchParams", () => new URLSearchParams({ q: "a b", n: "₹5" }).toString() === "q=a+b&n=%E2%82%B95")
  check("atob/btoa", () => btoa("zero-native") === "emVyby1uYXRpdmU=" && atob("emVyby1uYXRpdmU=") === "zero-native")
  check("TextEncoder", () => new TextDecoder().decode(new TextEncoder().encode("₹ ok")) === "₹ ok")
  return failed.length === 0 ? "ok" : `failed: ${failed.join(", ")}`
}

const DIGITS = [0, 1, 2, 3]

export function RnBasicsLabScreen() {
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`rn-lab ${text}`)
    status.set(text)
  }
  const net = useNetInfo()
  const otp = signal("")
  const otpRef = createRef<TextFieldHandle>()
  const nextRef = createRef<TextFieldHandle>()
  const second = signal("")

  AppState.addEventListener("change", (s) => say(`appstate ${s}`))
  Keyboard.addListener("keyboardDidShow", (e) => say(`keyboard shown ${Math.round(e.endCoordinates.height)}`))
  Keyboard.addListener("keyboardDidHide", () => say("keyboard hidden"))
  Dimensions.addEventListener("change", ({ window }) => say(`window ${Math.round(window.width)}x${Math.round(window.height)}`))
  Linking.addEventListener("url", ({ url }) => say(`link ${url}`))

  const platform = () => {
    const k = Platform.constants
    say(`platform ${Platform.OS} ${Platform.Version} ${k.Release} ${k.Brand} ${k.Model} select=${Platform.select({ android: "a", default: "d" })}`)
  }
  const sizes = () => {
    const w = Dimensions.get("window")
    const s = Dimensions.get("screen")
    say(`dims window ${w.width}x${w.height} screen ${s.width}x${s.height} ratio ${PixelRatio.get()} font ${PixelRatio.getFontScale()} px10 ${PixelRatio.getPixelSizeForLayoutSize(10)}`)
  }
  const alert = (buttons: number) =>
    Alert.alert(
      "Cancel payment?",
      "The amount is not taken yet.",
      [
        { text: "Keep", style: "cancel" as const, onPress: () => say("alert keep") },
        { text: "Later", onPress: () => say("alert later") },
        { text: "Cancel it", style: "destructive" as const, onPress: () => say("alert cancel") },
      ].slice(3 - buttons),
      { cancelable: true, onDismiss: () => say("alert dismissed") },
    )
  const copy = () => {
    Clipboard.setString("zn-copied-123")
    // Read back once the copy has landed (a native round trip).
    setTimeout(() => {
      Promise.all([Clipboard.getString(), Clipboard.hasString()]).then(([t, has]) => say(`clipboard ${t} has=${has}`))
    }, 300)
  }
  const links = () =>
    Promise.all([Linking.canOpenURL("https://example.com"), Linking.canOpenURL("tel:+911234567890"), Linking.canOpenURL("whatsapp://send?text=x")]).then(
      ([web, tel, wa]) => say(`canopen https=${web} tel=${tel} whatsapp=${wa}`),
    )
  const refused = () => Linking.openURL("whatsapp://send?text=x").then(() => say("open whatsapp: opened (wrong)"), (e) => say(`open whatsapp: ${e.code}`))
  const raf = () => {
    const t0 = Date.now()
    requestAnimationFrame((time) => say(`raf ${Date.now() - t0}ms time=${time > 0}`))
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.bg }}>
      <Column gap={10} style={{ padding: 16, paddingBottom: 48 }}>
        <Text fontSize={13} color={c.ink}>
          {`status: ${status()}`}
        </Text>
        <Text fontSize={12} color={c.muted}>
          {`window ${Math.round(useWindowDimensions().width)} · keyboard ${Keyboard.isVisible() ? Math.round(Keyboard.metrics()?.height ?? 0) : "hidden"} · app ${AppState.currentState} · net ${net.type} ${net.isConnected} ${net.isInternetReachable}`}
        </Text>

        <RnTitle text="OTP (ref.focus)" />
        <Stack style={{ height: 56 }}>
          <Row gap={8}>
            {DIGITS.map((i) => (
              <Pressable
                key={i}
                onPress={() => otpRef.current?.focus()}
                alignItems="center"
                justifyContent="center"
                style={{ width: 52, height: 56, borderRadius: 12, backgroundColor: otp().length === i ? "#E0E7FF" : c.white }}
              >
                <Text fontSize={22} fontWeight={700} color={c.ink}>
                  {otp().charAt(i)}
                </Text>
              </Pressable>
            ))}
          </Row>
          {/* One hidden field holds the code, as react-native-otp-entry does; the boxes only draw it. */}
          <TextField
            ref={otpRef}
            value={otp()}
            onChangeText={(t) => {
              const digits = t.replace(/\D/g, "").slice(0, 4)
              otp.set(digits)
              if (digits.length === 4) {
                say(`otp filled ${digits}`)
                otpRef.current?.blur()
              }
            }}
            onFocus={() => say("otp focus")}
            onBlur={() => say("otp blur")}
            keyboardType="number-pad"
            maxLength={4}
            style={{ position: "absolute", top: 0, start: 0, width: 1, height: 1, opacity: 0 }}
          />
        </Stack>
        <Row gap={8}>
          <RnButton label="Focus" onPress={() => otpRef.current?.focus()} />
          <RnButton label="Blur" onPress={() => otpRef.current?.blur()} />
          <RnButton label="Clear" onPress={() => otpRef.current?.clear()} />
          <RnButton label="Focused?" onPress={() => say(`otp isFocused ${otpRef.current?.isFocused()}`)} />
        </Row>
        <TextField
          value={second()}
          onChangeText={(t) => second.set(t)}
          placeholder="Second field (Next jumps here from the first)"
          returnKeyType="next"
          onSubmitEditing={() => nextRef.current?.focus()}
          onFocus={() => say("second focus")}
          style={{ height: 44, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.white }}
        />
        <TextField
          ref={nextRef}
          placeholder="Third field"
          onFocus={() => say("third focus")}
          style={{ height: 44, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.white }}
        />
        <RnButton label="Keyboard.dismiss" onPress={() => void Keyboard.dismiss()} />

        <RnTitle text="Device" />
        <RnButton label="Platform" onPress={platform} />
        <RnButton label="Dimensions" onPress={sizes} />
        <RnButton label="NetInfo.fetch" onPress={() => NetInfo.fetch().then((s) => say(`netinfo ${s.type} ${s.isConnected} ${s.isInternetReachable} ${s.details?.isConnectionExpensive}`))} />
        <RnButton label="AppState now" onPress={() => say(`appstate now ${AppState.currentState}`)} />

        <RnTitle text="Dialogs and sheets" />
        <RnButton label="Alert (3 buttons)" onPress={() => alert(3)} />
        <RnButton label="Alert (1 button)" onPress={() => alert(1)} />
        <RnButton label="Share" onPress={() => Share.share({ message: "Try zero-native", title: "Invite" }, { dialogTitle: "Share via" }).then((r) => say(`share ${r.action}`))} />
        <RnButton label="Toast (long)" onPress={() => ToastAndroid.show("Saved", ToastAndroid.LONG)} />

        <RnTitle text="Clipboard, links, vibration" />
        <RnButton label="Copy and read back" onPress={copy} />
        <RnButton label="canOpenURL" onPress={links} />
        <RnButton label="openURL whatsapp (refused)" onPress={refused} />
        <RnButton label="openURL https" onPress={() => Linking.openURL("https://example.com").then(() => say("open https: ok"), (e) => say(`open https: ${e.code}`))} />
        <RnButton label="Vibrate 200 ms" onPress={() => { Vibration.vibrate(200); say("vibrate sent") }} />

        <RnTitle text="Web globals" />
        <RnButton label="URL, atob, TextEncoder" onPress={() => say(`web ${webCheck()}`)} />
        <RnButton label="requestAnimationFrame" onPress={raf} />
        <RnButton label="flowStore limit" onPress={() => say(`flowstore max ${flowStore.MAX_BYTES}`)} />
      </Column>
    </Scroll>
  )
}
