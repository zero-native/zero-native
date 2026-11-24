// Touch fixes lab (round 6): who takes a tap when a control sits inside a Pressable, and the press feedback's timings.
// Each action writes "status: ..." into fx-status and logs "touch-fix ..." (ios/SamplePackage/ZnSampleUITests/
// TouchFixTests.swift). The whole lab is inside a Scroll, as most rows of an app are.
// 1. A Switch, and a Checkbox, inside a tappable row: a tap on the control turns it and the row doesn't fire (the
//    innermost wins, A53); a tap on the row's text presses the row.
// 2. A Switch inside a horizontal rail inside a tappable card: the Switch turns, the card isn't pressed; a tap on a
//    chip of the rail presses the card.
// 3. A disabled Switch inside a row: the row takes the tap (a disabled control takes none, as Android).
// 4. A disabled button inside a tappable card: the card takes the tap (as Android and RN; iOS ate it before).
// 5. A long press inside the Scroll: onLongPress 0.5 s after the finger went down. The press itself begins after
//    UIKit's content delay (~150 ms), so the status says about 350 ms from onPressIn (it said 500: 0.65 s in all).
// 6. Feedback to look at: a 40 pt round borderless button (its ripple reaches past it: half the diagonal), and the
//    Switch / Checkbox halo (a round 20 pt grey halo while pressed, as Android's ripple). A quick tap's ripple fades in
//    over 75 ms and holds until 225 ms (about 375 ms in all).
import { Box, Checkbox, Column, Pressable, Row, Scroll, Switch, Text } from "@zeronative/ui"
import { signal } from "@zeronative/core"
import { c } from "./tokens"

const CHIPS = Array.from({ length: 10 }, (_, i) => i)

function FixCase(props: { title: string; children?: unknown }) {
  return (
    <Column style={{ gap: 8, padding: 12, borderRadius: 12, backgroundColor: "#F3F4F6" }}>
      <Text fontSize={14} fontWeight={700} color={c.ink}>
        {props.title}
      </Text>
      {props.children}
    </Column>
  )
}

export function TouchFixLabScreen() {
  const status = signal("ready")
  const say = (s: string) => {
    status.set(s)
    console.info(`touch-fix ${s}`)
  }
  const sw = signal(false)
  const check = signal(false)
  const railSw = signal(false)
  let pressedAt = 0

  const row = { padding: 12, borderRadius: 8, backgroundColor: "#FFFFFF" }
  return (
    <Scroll testID="fx-scroll" style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text fontSize={20} fontWeight={700} color={c.ink}>
        Touch fixes
      </Text>
      <Text testID="fx-status" fontSize={13} color={c.ink}>
        {`status: ${status()}`}
      </Text>

      <FixCase title="1. Controls inside a tappable row">
        <Pressable testID="fx-row-switch" accessibilityLabel="Switch row" onPress={() => say("switch row")} style={row}>
          <Row alignItems="center" justifyContent="space-between">
            <Text fontSize={14} color={c.ink}>Alerts</Text>
            <Switch testID="fx-switch" accessibilityLabel="Alerts" value={sw()} onValueChange={(v) => { sw.set(v); say(`switch ${v ? "on" : "off"}`) }} />
          </Row>
        </Pressable>
        <Pressable testID="fx-row-check" accessibilityLabel="Checkbox row" onPress={() => say("check row")} style={row}>
          <Row alignItems="center" justifyContent="space-between">
            <Text fontSize={14} color={c.ink}>Keep the receipt</Text>
            <Checkbox testID="fx-check" accessibilityLabel="Keep the receipt" value={check()} onValueChange={(v) => { check.set(v); say(`check ${v ? "on" : "off"}`) }} />
          </Row>
        </Pressable>
      </FixCase>

      <FixCase title="2. A Switch in a rail inside a tappable card">
        <Pressable testID="fx-rail-card" accessibilityLabel="Rail card" onPress={() => say("rail card")} style={{ ...row, gap: 8 }}>
          <Text fontSize={14} color={c.ink}>Filters</Text>
          <Scroll horizontal style={{ gap: 8, flexGrow: 0 }}>
            <Row alignItems="center" style={{ gap: 4, paddingRight: 8 }}>
              <Text fontSize={12} color={c.ink}>Open now</Text>
              <Switch testID="fx-rail-switch" accessibilityLabel="Open now" value={railSw()} onValueChange={(v) => { railSw.set(v); say(`rail switch ${v ? "on" : "off"}`) }} />
            </Row>
            {CHIPS.map((i) => (
              <Box key={String(i)} style={{ width: 80, height: 36, borderRadius: 18, backgroundColor: "#E0E7FF", justifyContent: "center", alignItems: "center" }}>
                <Text fontSize={12} color={c.ink}>{`chip ${i}`}</Text>
              </Box>
            ))}
          </Scroll>
        </Pressable>
      </FixCase>

      <FixCase title="3. A disabled Switch inside a row">
        <Pressable testID="fx-row-disabled-switch" accessibilityLabel="Disabled switch row" onPress={() => say("disabled switch row")} style={row}>
          <Row alignItems="center" justifyContent="space-between">
            <Text fontSize={14} color={c.ink}>Locked setting</Text>
            <Switch testID="fx-disabled-switch" accessibilityLabel="Locked" value disabled onValueChange={() => say("disabled switch turned")} />
          </Row>
        </Pressable>
      </FixCase>

      <FixCase title="4. A disabled button inside a tappable card">
        <Pressable testID="fx-card" accessibilityLabel="Offer card" onPress={() => say("card")} style={{ ...row, gap: 8 }}>
          <Text fontSize={14} color={c.ink}>Cashback offer</Text>
          <Pressable
            testID="fx-disabled-button"
            accessibilityLabel="Apply"
            disabled
            onPress={() => say("disabled button")}
            style={{ alignSelf: "flex-start", paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: "#D1D5DB" }}>
            <Text fontSize={13} color={c.muted}>Apply</Text>
          </Pressable>
        </Pressable>
      </FixCase>

      <FixCase title="5. A long press inside the Scroll">
        <Pressable
          testID="fx-long"
          accessibilityLabel="Long press card"
          onPressIn={() => { pressedAt = Date.now() }}
          onLongPress={() => say(`long ${Date.now() - pressedAt} ms after press in`)}
          onPress={() => say("long card tap")}
          style={row}>
          <Text fontSize={14} color={c.ink}>Hold me</Text>
        </Pressable>
      </FixCase>

      <FixCase title="6. Feedback">
        <Row alignItems="center" style={{ gap: 24, paddingVertical: 8 }}>
          <Pressable
            testID="fx-borderless"
            accessibilityLabel="Back"
            rippleBorderless
            onPress={() => say("borderless")}
            style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "#E0E7FF", justifyContent: "center", alignItems: "center" }}>
            <Text fontSize={16} color={c.ink}>←</Text>
          </Pressable>
          <Pressable testID="fx-quick" accessibilityLabel="Quick tap" onPress={() => say("quick")} style={{ ...row, width: 140 }}>
            <Text fontSize={14} color={c.ink}>Quick tap</Text>
          </Pressable>
        </Row>
      </FixCase>
      <Box style={{ height: 400 }} />
    </Scroll>
  )
}
