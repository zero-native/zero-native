// A dev screen for the core parts plugins stand on: native screens and views, zn://file, background tasks, secure screens,
// dark mode. The phone test reads these lines, and the log lines "core-lab ...", so keep their wording.
import { Box, Column, Image, NativeView, Pressable, Row, Scroll, Sheet, Switch, Text, TextField } from "@zeronative/ui"
import { colorScheme, nav, onLowMemory, Os, scheme, signal, toast } from "@zeronative/core"
import { Device } from "@zeronative/device-test"
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
  // The see-through lab draws over this screen: the tick must keep going under it, and a tap where it draws nothing
  // must reach "Tap under" here.
  const tick = signal(0)
  const tapsUnder = signal(0)
  setInterval(() => tick.set(tick() + 1), 500)

  return (
    <Scroll style={{ flex: 1, backgroundColor: scheme("#FFFFFF", "#202020") }}>
      <Column gap={10} style={{ padding: 16 }}>
        <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
          {`status: ${status()}`}
        </Text>
        <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
          {`scheme: ${colorScheme()}`}
        </Text>
        <Row gap={10} alignItems="center">
          <CoreButton label="Tap under" onPress={() => { tapsUnder.set(tapsUnder() + 1); console.info(`core-lab tap under ${tapsUnder()}`) }} />
          <Text fontSize={13} color={scheme("#111111", "#EEEEEE")}>
            {`tick: ${tick()} taps: ${tapsUnder()}`}
          </Text>
        </Row>
        <CoreButton label="Open see-through screen" onPress={() => nav.push("seeThroughLab", { depth: "1" })} />
        <CoreButton label="Open sliding see-through" onPress={() => nav.push("seeThroughSlide", { depth: "1" })} />
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

// Screenshots, recordings and the app switcher must not show it, nor its Sheet or toast; a normal screen pushed over
// it shows again once the push has ended. The log lines "secure-lab ...".
export function SecureLabScreen() {
  const sheet = signal(false)
  const note = signal("")
  return (
    <Column alignItems="center" justifyContent="center" style={{ flex: 1, gap: 12, backgroundColor: "#FFEEDD" }}>
      <Text fontSize={16}>secure screen</Text>
      {/* A plain field: on iOS its keyboard must not offer passwords here (the screens sit in a password field). */}
      <TextField
        value={note()}
        onChangeText={note.set}
        placeholder="a note"
        style={{ width: 220, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: "#999999", borderRadius: 6 }}
      />
      <CoreButton label="Open sheet" onPress={() => sheet.set(true)} />
      <CoreButton label="Show toast" onPress={() => toast("secure toast")} />
      <CoreButton label="Push normal screen" onPress={() => nav.push("coreLab")} />
      <CoreButton label="Push secure native screen" onPress={() => nav.push("secureNative", { title: "secure" })} />
      {/* A see-through screen over this one: it stays drawn (and secure), and the app switcher cover keeps its colour. */}
      <CoreButton label="Open see-through screen" onPress={() => nav.push("seeThroughLab", { depth: "1" })} />
      <CoreButton label="Back" onPress={() => nav.back()} />
      <Sheet visible={sheet()} onDismiss={() => sheet.set(false)} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
        <Text fontSize={16}>secure sheet</Text>
        <CoreButton label="Close sheet" onPress={() => { console.info("secure-lab sheet closed"); sheet.set(false) }} />
      </Sheet>
    </Column>
  )
}

// Registry 24 (route option transparent: true): the screen below stays drawn and keeps updating; where this screen draws
// nothing (the top half), taps reach it; a screen pushed over it slides over both, and Back brings both back. Routes
// seeThroughLab (transition "none") and seeThroughSlide ("push": it slides in alone, and the edge swipe moves it alone).
// The log lines "see-through-lab ...".
export function SeeThroughLabScreen(props: { depth?: string }) {
  const depth = Number(props.depth ?? "1")
  const taps = signal(0)
  const on = signal(false)
  const note = signal("")
  console.info(`see-through-lab open ${depth}`)
  return (
    <Column style={{ flex: 1 }}>
      {/* Nothing drawn: the screen below shows and takes the taps. */}
      <Box style={{ height: "45%" }} />
      <Column enter="fade" justifyContent="flex-end" style={{ flex: 1, padding: 16, backgroundColor: "rgba(0,0,0,0.45)" }}>
        <Column gap={10} style={{ padding: 16, borderRadius: 16, backgroundColor: "#FFFFFF" }}>
          <Text fontSize={16} fontWeight={600} color="#111111">
            {`see-through screen ${depth}`}
          </Text>
          <Row gap={10} alignItems="center">
            <CoreButton label="Tap here" onPress={() => { taps.set(taps() + 1); console.info(`see-through-lab tap ${depth}: ${taps()}`) }} />
            <Text fontSize={13} color="#111111">{`taps: ${taps()}`}</Text>
            <Switch value={on()} onValueChange={(v) => { on.set(v); console.info(`see-through-lab switch ${v}`) }} />
          </Row>
          <TextField
            value={note()}
            onChangeText={note.set}
            placeholder="a note"
            style={{ paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: "#999999", borderRadius: 6 }}
          />
          <Row gap={10}>
            <CoreButton label="Push opaque" onPress={() => nav.push("secureLab")} />
            <CoreButton label="Another" onPress={() => nav.push("seeThroughLab", { depth: String(depth + 1) })} />
            <CoreButton label="Close" onPress={() => nav.back()} />
          </Row>
        </Column>
      </Column>
    </Column>
  )
}
