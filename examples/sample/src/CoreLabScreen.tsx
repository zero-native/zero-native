// A dev screen for the core parts plugins stand on: native screens and views, zn://file, background tasks, secure screens,
// dark mode. The phone test reads these lines, and the log lines "core-lab ...", so keep their wording.
import { Box, Column, Image, NativeView, Pressable, Scroll, Text } from "@zero-native/ui"
import { colorScheme, nav, onLowMemory, Os, scheme, signal } from "@zero-native/core"
import { Device } from "@zero-native/device-test"
import { c } from "./tokens"

function CoreButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function CoreLabScreen() {
  const status = signal("ready")
  const label = signal("one")
  const file = signal("")
  const say = (text: string) => {
    console.info(`core-lab ${text}`)
    status.set(text)
  }
  onLowMemory(() => say("low memory"))

  const openScreen = () => nav.pushForResult<{ code: string }>("fakeScreen", { title: "Pay" }).then((v) => say(`answer: ${v ? v.code : "null"}`))
  const task = (name: string, timeoutMs: number) => Device.runTask({ name, timeoutMs }).then((r) => say(`task ${name}: ${r}`))
  const makeFile = () =>
    Device.makeFile().then((r) => {
      file.set(r.handle)
      say(`file: ${r.handle} outside refused: ${r.outsideRefused}`)
    })
  const info = () => Os.info().then((r) => say(`rtl: ${r.rtl}`))
  // A tap whose button hides itself right after it asks native and starts a timeout (second-opinions 151): both must
  // still answer. Before, the hidden button's part took the call and the timeout with it (no answer, no error).
  const oneShotHidden = signal(false)
  const hideThenAsk = () => {
    const asked = Os.info()
    setTimeout(() => say("one-shot timeout fired"), 300)
    oneShotHidden.set(true)
    void asked.then(() => console.info("core-lab one-shot call answered"))
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
          {`status: ${status()}`}
        </Text>
        <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
          {`scheme: ${colorScheme()}`}
        </Text>
        <CoreButton label="Open native screen" onPress={openScreen} />
        <CoreButton label="Push native screen" onPress={() => nav.push("fakeScreen", { title: "Kill" })} />
        <NativeView name="device.fake-view" props={{ label: label() }} onEvent={(e) => say(`view event: ${e.name} ${e.data.label}`)} style={{ height: 60 }} />
        <CoreButton label="Change view prop" onPress={() => label.set("two")} />
        <CoreButton label="Run task" onPress={() => task("lab.echo", 5000)} />
        <CoreButton label="Slow task" onPress={() => task("lab.slow", 1000)} />
        <CoreButton label="Failing task" onPress={() => task("lab.throw", 5000)} />
        <CoreButton label="Unknown task" onPress={() => task("lab.none", 5000)} />
        <CoreButton label="Make file" onPress={makeFile} />
        <Box style={{ height: 48 }}>{file() !== "" && <Image src={file()} style={{ width: 48, height: 48 }} />}</Box>
        <CoreButton label="Show rtl" onPress={info} />
        <CoreButton label="Open secure screen" onPress={() => nav.push("secureLab")} />
        {!oneShotHidden() && <CoreButton label="Hide me, then answer" onPress={hideThenAsk} />}
        {oneShotHidden() && <CoreButton label="Show it again" onPress={() => oneShotHidden.set(false)} />}
      </Column>
    </Scroll>
  )
}

export function SecureLabScreen() {
  return (
    <Column alignItems="center" justifyContent="center" style={{ flex: 1, backgroundColor: "#FFEEDD" }}>
      <Text fontSize={16}>secure screen</Text>
    </Column>
  )
}
