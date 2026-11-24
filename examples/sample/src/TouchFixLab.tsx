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
// 7. A tap-outside dim (a Pressable drawn over the row) over a Switch row and a field: the dim takes the tap, the
//    Switch doesn't turn and the field isn't focused (as Android: the topmost takes it).
// 8. A Switch drawn over a tappable card (its sibling, drawn after it): the Switch takes its tap, the card doesn't fire.
// fx-log keeps the last events in order, so a test sees a second event that came with the one it waited for.
import { Box, Checkbox, Column, Pressable, Row, Scroll, Stack, Switch, Text, TextField } from "@zeronative/ui"
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
  const log = signal<string[]>([])
  const say = (s: string) => {
    status.set(s)
    log.set([...log(), s].slice(-8))
    console.info(`touch-fix ${s}`)
  }
  const underSw = signal(false)
  const overSw = signal(false)
  const note = signal("")
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
      <Text testID="fx-log" fontSize={11} color={c.muted}>
        {`log: ${log().join(", ")}`}
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
      <FixCase title="7. A dim over a Switch row and a field">
        <Stack>
          <Column style={{ gap: 8 }}>
            <Pressable testID="fx-under-row" accessibilityLabel="Row under the dim" onPress={() => say("under row")} style={row}>
              <Row alignItems="center" justifyContent="space-between">
                <Text fontSize={14} color={c.ink}>Under the dim</Text>
                <Switch testID="fx-under-switch" accessibilityLabel="Under the dim" value={underSw()} onValueChange={(v) => { underSw.set(v); say(`under switch ${v ? "on" : "off"}`) }} />
              </Row>
            </Pressable>
            <TextField
              testID="fx-under-field"
              value={note()}
              onChangeText={(t) => note.set(t)}
              onFocus={() => say("under field focus")}
              placeholder="A field under the dim"
              style={{ ...row, height: 44 }}
            />
          </Column>
          <Pressable
            testID="fx-dim"
            accessibilityLabel="Dim"
            onPress={() => say("dim")}
            style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, borderRadius: 8, backgroundColor: "#11182733" }}
          />
        </Stack>
      </FixCase>

      <FixCase title="8. A Switch drawn over a tappable card">
        <Stack>
          <Pressable testID="fx-over-card" accessibilityLabel="Card under a Switch" onPress={() => say("over card")} style={{ ...row, height: 64 }}>
            <Text fontSize={14} color={c.ink}>A card</Text>
          </Pressable>
          <Box style={{ position: "absolute", top: 8, end: 8 }}>
            <Switch testID="fx-over-switch" accessibilityLabel="Over the card" value={overSw()} onValueChange={(v) => { overSw.set(v); say(`over switch ${v ? "on" : "off"}`) }} />
          </Box>
        </Stack>
      </FixCase>
      <Box style={{ height: 400 }} />
    </Scroll>
  )
}
