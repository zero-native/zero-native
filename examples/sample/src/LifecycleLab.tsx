// A dev screen for the app's life on a phone: the window as Dimensions and PixelRatio see it (rotation, split view, the
// text size setting), motion's window values (env: size, insets, keyboard frame by frame; motion engine on), and the
// app state. Each change logs one "life-lab ..." line; the phone check reads those lines, so keep their wording.
// iOS: the sample is portrait only; start it with SIMCTL_CHILD_ZN_ROTATE=1 to turn it. Text size:
// `xcrun simctl ui <device> content_size extra-extra-large`.
import { Box, Column, Row, Scroll, Text, TextField } from "@zeronative/ui"
import { AppState, Dimensions, env, onAppState, PixelRatio, signal, useWindowDimensions, type MotionText } from "@zeronative/core"
import { c } from "./tokens"

function Line(props: { label: string; children: string | MotionText }) {
  return (
    <Row style={{ gap: 8, paddingVertical: 4 }}>
      <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
        {props.label}
      </Text>
      <Text fontSize={13} fontWeight={600} color={c.ink}>
        {props.children}
      </Text>
    </Row>
  )
}

export function LifecycleLabScreen() {
  const log = signal<string[]>([])
  const say = (line: string) => {
    console.info(`life-lab ${line}`)
    log.set([line, ...log()].slice(0, 12))
  }
  const dims = () => {
    const w = Dimensions.get("window")
    const s = Dimensions.get("screen")
    return `window ${w.width}x${w.height} screen ${s.width}x${s.height} scale ${w.scale} font ${PixelRatio.getFontScale()}`
  }
  say(`open ${dims()}`)
  Dimensions.addEventListener("change", () => say(`change ${dims()}`))
  onAppState((state) => say(`appState ${state}`))

  return (
    <Scroll style={{ flex: 1, gap: 12, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16 }}>
      <Text fontSize={20} fontWeight={700} color={c.ink}>
        App life lab
      </Text>
      <Column style={{ padding: 12, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
        <Text fontSize={15} fontWeight={700} color={c.ink}>
          Dimensions (JS)
        </Text>
        <Line label="window">{`${useWindowDimensions().width} x ${useWindowDimensions().height}`}</Line>
        <Line label="screen">{`${Dimensions.get("screen").width} x ${Dimensions.get("screen").height}`}</Line>
        <Line label="scale / font">{`${PixelRatio.get()} / ${PixelRatio.getFontScale()}`}</Line>
        <Line label="app state">{AppState.currentState}</Line>
      </Column>
      <Column style={{ padding: 12, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
        <Text fontSize={15} fontWeight={700} color={c.ink}>
          Motion env (native, every frame)
        </Text>
        <Line label="width">{env.width.format({ decimals: 0 })}</Line>
        <Line label="height">{env.height.format({ decimals: 0 })}</Line>
        <Line label="insets top">{env.insets.top.format({ decimals: 0 })}</Line>
        <Line label="insets bottom">{env.insets.bottom.format({ decimals: 0 })}</Line>
        <Line label="insets start">{env.insets.start.format({ decimals: 0 })}</Line>
        <Line label="insets end">{env.insets.end.format({ decimals: 0 })}</Line>
        <Line label="keyboard now">{env.keyboardHeight.format({ decimals: 1 })}</Line>
        <Line label="keyboard target">{env.keyboardTarget.format({ decimals: 0 })}</Line>
        <Box style={{ height: 8 }} />
        <TextField placeholder="Tap to raise the keyboard" style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border }} />
      </Column>
      <Column style={{ padding: 12, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
        <Text fontSize={15} fontWeight={700} color={c.ink}>
          Log
        </Text>
        {log().map((line, i) => (
          <Text key={`${i}:${line}`} fontSize={12} color={c.ink}>
            {line}
          </Text>
        ))}
      </Column>
    </Scroll>
  )
}
