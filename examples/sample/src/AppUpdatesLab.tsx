// A dev screen for @zero-native/app-updates. "Check store" asks the update server on this computer
// (`bun run updates:server`, reached over `adb reverse tcp:8790 tcp:8790`) for app "sample"; the other buttons call
// Play directly. Play's in-app updates only answer for an app installed from Play (README: internal app sharing), so a
// sideloaded sample shows "available false". Each action logs one "app-updates-lab ..." line.
import { Column, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { onCleanup, Platform, signal } from "@zero-native/core"
import DeviceInfo from "@zero-native/device-info"
import { AppUpdates, checkStore } from "@zero-native/app-updates"
import { c } from "./tokens"

const SERVER = "http://127.0.0.1:8790"

function UpdatesButton(p: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={p.onPress}
      alignItems="center"
      style={{ flex: 1, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}
    >
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {p.label}
      </Text>
    </Pressable>
  )
}

const osName = (): "android" | "ios" => (Platform.OS === "ios" ? "ios" : "android")
// Android compares versionCodes, iOS the "1.6.2" version (the server's store rules)
const appVersion = () => (osName() === "ios" ? DeviceInfo.getVersion() : DeviceInfo.getBuildNumber())

export function AppUpdatesLabScreen() {
  const store = signal("not checked yet")
  const play = signal("Play not asked yet")
  const events = signal<string[]>([])
  const busy = signal(false)
  let appStoreId: string | undefined

  const show = (target: typeof store, text: string) => {
    console.info(`app-updates-lab ${text}`)
    target.set(text)
  }

  // Play's install state (accepted / declined / downloading / downloaded / failed); stops when the screen closes
  AppUpdates.onState((s) => {
    const line = `${s.status}${s.totalBytes ? ` ${s.bytesDownloaded}/${s.totalBytes}` : ""}${s.errorCode ? ` error ${s.errorCode}` : ""}`
    console.info(`app-updates-lab state ${line}`)
    events.set([line, ...events()].slice(0, 8))
  })

  // Busy is kept on disk: never leave it on after this screen
  onCleanup(() => {
    if (busy()) void AppUpdates.setBusy(false)
  })

  const check = async () => {
    store.set("checking…")
    const answer = await checkStore({ server: SERVER, app: "sample", os: osName(), version: appVersion() })
    appStoreId = answer?.store.appStoreId
    show(store, answer === null ? "no answer (server off, or offline)" : JSON.stringify(answer))
  }

  const ask = async () => show(play, JSON.stringify(await AppUpdates.isUpdateAvailable()))

  const start = async (flexible: boolean) => show(play, `start ${flexible ? "flexible" : "immediate"}: ${JSON.stringify(await AppUpdates.start({ flexible }))}`)

  return (
    <Scroll style={{ flex: 1, padding: 16, gap: 16 }}>
      <Text fontSize={15} fontWeight={700} color={c.ink}>
        {`Store rules (${osName()}, version ${appVersion()})`}
      </Text>
      <UpdatesButton label="Check store" onPress={() => void check()} />
      <Text testID="app-updates-store" fontSize={13} color={c.muted}>
        {store()}
      </Text>

      <Text fontSize={15} fontWeight={700} color={c.ink}>
        Play
      </Text>
      <Column style={{ gap: 8 }}>
        {/* In a Row: the button's flex: 1 fills the width there; straight in this Column it would take 0 height */}
        <Row>
          <UpdatesButton label="Ask Play" onPress={() => void ask()} />
        </Row>
        <Row style={{ gap: 8 }}>
          <UpdatesButton label="Start optional" onPress={() => void start(true)} />
          <UpdatesButton label="Start forced" onPress={() => void start(false)} />
        </Row>
        <Row style={{ gap: 8 }}>
          <UpdatesButton label="Install downloaded" onPress={() => void AppUpdates.complete().then((r) => show(play, `complete: ${JSON.stringify(r)}`))} />
          <UpdatesButton label="Open store" onPress={() => void AppUpdates.openStore({ appStoreId }).then((ok) => show(play, `openStore: ${ok}`))} />
        </Row>
        <Row>
          <UpdatesButton
            label={busy() ? "Busy: on (tap to end)" : "Busy: off (tap to start)"}
            onPress={() => {
              busy.set(!busy())
              void AppUpdates.setBusy(busy())
              console.info(`app-updates-lab busy ${busy()}`)
            }}
          />
        </Row>
      </Column>
      <Text testID="app-updates-play" fontSize={13} color={c.muted}>
        {play()}
      </Text>
      <Text fontSize={13} color={c.ink}>
        {events().length ? `State events:\n${events().join("\n")}` : "No state events yet"}
      </Text>
    </Scroll>
  )
}
