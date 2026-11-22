// A dev screen for the app's life on a phone: the window as Dimensions and PixelRatio see it (rotation, split view, the
// text size setting), motion's window values (env: size, insets, keyboard frame by frame; motion engine on), and the
// app state. Each change logs one "life-lab ..." line; the phone check reads those lines, so keep their wording.
// iOS: the sample is portrait only; start it with SIMCTL_CHILD_ZN_ROTATE=1 to turn it. Text size:
// `xcrun simctl ui <device> content_size extra-extra-large`.
import { Box, Column, Row, Scroll, Text, TextField } from "@zeronative/ui"
import { AppState, Dimensions, env, onAppState, PixelRatio, signal, useWindowDimensions } from "@zeronative/core"
import { c } from "./tokens"

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
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            window
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {`${useWindowDimensions().width} x ${useWindowDimensions().height}`}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            screen
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {`${Dimensions.get("screen").width} x ${Dimensions.get("screen").height}`}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            scale / font
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {`${PixelRatio.get()} / ${PixelRatio.getFontScale()}`}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            app state
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {AppState.currentState}
          </Text>
        </Row>
      </Column>
      <Column style={{ padding: 12, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
        <Text fontSize={15} fontWeight={700} color={c.ink}>
          Motion env (native, every frame)
        </Text>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            width
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {env.width.format({ decimals: 0 })}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            height
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {env.height.format({ decimals: 0 })}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            insets top
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {env.insets.top.format({ decimals: 0 })}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            insets bottom
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {env.insets.bottom.format({ decimals: 0 })}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            insets start
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {env.insets.start.format({ decimals: 0 })}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            insets end
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {env.insets.end.format({ decimals: 0 })}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            keyboard now
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {env.keyboardHeight.format({ decimals: 1 })}
          </Text>
        </Row>
        <Row style={{ gap: 8, paddingVertical: 4 }}>
          <Text fontSize={13} color={c.muted} style={{ width: 120 }}>
            keyboard target
          </Text>
          <Text fontSize={13} fontWeight={600} color={c.ink}>
            {env.keyboardTarget.format({ decimals: 0 })}
          </Text>
        </Row>
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
