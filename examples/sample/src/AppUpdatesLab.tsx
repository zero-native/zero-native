// A dev screen for @zeronative/app-updates. "Check store" runs an update check (`Updates.check()`: the sample's OTA
// server answers OTA and the store question in one call) and shows the store answer that came with it; the other buttons call
// Play directly. Play's in-app updates only answer for an app installed from Play (README: internal app sharing), so a
// sideloaded sample shows "available false". Each action logs one "app-updates-lab ..." line.
// iOS: "Ask store" asks the App Store's lookup and "Start" opens the App Store sheet in the app. The sample isn't in the
// App Store, so give a published app's id as a param: `--params '{"appStoreId":"<id>"}'` (its version is newer than
// the sample's 0.1, so it answers available; closing the sheet sends a "declined" or "canceled" state).
import { Column, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { onCleanup, Platform, signal, Updates } from "@zeronative/core"
import DeviceInfo from "@zeronative/device-info"
import { AppUpdates, storeAnswer } from "@zeronative/app-updates"
import { c } from "./tokens"

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

export function AppUpdatesLabScreen(props: { appStoreId?: string }) {
  // iOS: which App Store app to ask about (a param: the sample has no App Store page of its own)
  const askId = props.appStoreId
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
    const r = await Updates.check()
    const answer = await storeAnswer(r.status)
    appStoreId = answer?.store.appStoreId ?? appStoreId
    show(store, answer === null ? `no store answer (${r.error ?? "the server sent none"})` : JSON.stringify(answer))
  }

  const ask = async () => {
    const a = await AppUpdates.isUpdateAvailable({ appStoreId: askId })
    appStoreId = a.appStoreId ?? appStoreId
    show(play, JSON.stringify(a))
  }

  const start = async (flexible: boolean) =>
    show(play, `start ${flexible ? "flexible" : "immediate"}: ${JSON.stringify(await AppUpdates.start({ flexible, appStoreId: askId }))}`)

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
        {osName() === "ios" ? `App Store${askId ? ` (app ${askId})` : ""}` : "Play"}
      </Text>
      <Column style={{ gap: 8 }}>
        {/* In a Row: the button's flex: 1 fills the width there; straight in this Column it would take 0 height */}
        <Row>
          <UpdatesButton label={osName() === "ios" ? "Ask App Store" : "Ask Play"} onPress={() => void ask()} />
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
