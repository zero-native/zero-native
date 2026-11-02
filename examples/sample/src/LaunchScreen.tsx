// A dev screen for step P.2: permissions, and opening another app for a result (only the mock UPI app, test-kit/). The
// phone test reads these lines, and the log lines "launch-test ...", so keep their wording.
import { Column, Image, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { launches, nav, Os, Permissions, signal, type LaunchRecord, type NativeError } from "@zero-native/core"
import { Device } from "@zero-native/device-test"
import { c } from "./tokens"

const KEY = "mock-upi"

const show = (r: LaunchRecord | null) => (r ? `${r.status} ${r.id}${r.resultCode !== undefined ? ` code ${r.resultCode}` : ""}` : "none")

function LabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function LaunchScreen() {
  // Read while the screen is built: right after a kill this must already be the result, not "waiting".
  const first = show(launches.pending(KEY))
  console.info(`launch-test first read: ${first}`)
  const now = signal(first)
  const heard = signal("nothing yet")
  const status = signal("")
  const refresh = () => now.set(show(launches.pending(KEY)))
  const say = (text: string) => {
    console.info(`launch-test ${text}`)
    status.set(text)
    refresh()
  }

  launches.onResult(KEY, (r) => {
    heard.set(show(r))
    console.info(`launch-test heard: ${show(r)}`)
    refresh()
  })

  const failed = (e: NativeError) => say(`failed: ${e.code}`)
  const open = () =>
    Device.openMockUpi({ id: `t${Date.now()}` }).then((r) => say(`open: launched=${r.launched} reason=${r.reason ?? "-"}`), failed)
  const missing = () =>
    Device.openMissingApp({ id: `m${Date.now()}` }).then((r) => say(`missing: launched=${r.launched} reason=${r.reason ?? "-"}`), failed)
  const ack = () => {
    const r = launches.pending(KEY)
    if (!r) return say("ack: nothing saved")
    void launches.ack(KEY, r.id).then((ok) => say(`ack: ${ok}`), failed)
  }
  const wrongAck = () => void launches.ack(KEY, "wrong-id").then((ok) => say(`wrong ack: ${ok}`), failed)
  const ask = () => Permissions.request(["camera"]).then((r) => say(`camera: ${r.camera}`), failed)
  const check = () => Permissions.status(["camera"]).then((r) => say(`camera status: ${r.camera}`), failed)
  const info = () => Os.info().then((r) => say(`os: ${r.appVersion} build ${r.appBuild}, ${r.manufacturer} ${r.model}, SDK ${r.sdk}`), failed)
  const haptic = () => Os.haptic("success").then((r) => say(`haptic: ${r}`), failed)
  // Not upi: if the check ever broke, that would open a real payment app. A scheme nothing handles is safe either way.
  const badLink = () => Os.openUrl("zn-test://x").then((r) => say(`link opened: ${r}`), failed)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", padding: 20 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Other apps
        </Text>
      </Row>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 20, paddingBottom: 32, gap: 12 }}>
          <Text fontSize={14} color={c.ink}>
            First read: {first}
          </Text>
          <Text fontSize={14} color={c.ink}>
            Saved now: {now()}
          </Text>
          <Text fontSize={14} color={c.ink}>
            Heard: {heard()}
          </Text>
          <Row style={{ gap: 8 }}>
            <LabButton label="Open mock" onPress={open} />
            <LabButton label="Ack" onPress={ack} />
            <LabButton label="Wrong ack" onPress={wrongAck} />
          </Row>
          <Row style={{ gap: 8 }}>
            <LabButton label="Missing app" onPress={missing} />
            <LabButton label="Ask camera" onPress={ask} />
            <LabButton label="Camera status" onPress={check} />
          </Row>
          <Row style={{ gap: 8 }}>
            <LabButton label="Os info" onPress={info} />
            <LabButton label="Haptic" onPress={haptic} />
            <LabButton label="Bad link" onPress={badLink} />
          </Row>
          <Row style={{ gap: 12, alignItems: "center" }}>
            <Image src="zn://app-icon/p2pdops.android.p2pupiapp" style={{ width: 48, height: 48 }} />
            <Image src="zn://app-icon/dev.zeronative.no.such.app" style={{ width: 48, height: 48, backgroundColor: c.border }} />
            <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
              The mock's icon from a zn:// handle, then a handle that fails
            </Text>
          </Row>
          <Text fontSize={13} color={c.muted}>
            {status()}
          </Text>
        </Column>
      </Scroll>
    </Column>
  )
}
