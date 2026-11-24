// Checks that had no screen (open items 2026-11-24, "built but never run"), each with a status line a UI test reads
// (ios/SamplePackage/ZnSampleUITests/ChecksLabTests.swift). Open with: bun run tools/ios-sample.ts --route checksLab,
// or zn://sample/dev/checks.
//   a) Motion text v.format with en-IN grouping (12,34,567), negative with 2 decimals, standard grouping.
//   b) Taps on a Pressable and a TextField turned in 3D by a motion value (rotateY 40, the depth effect: one like it once
//      broke TextField taps), and on a tilted (rotateX) Pressable.
//   c) A NativeView in a Box with a testID, and one in a Box with pointerEvents="none" over a Pressable: the tap goes
//      to the Pressable. (The compiler takes only name, props, onEvent and style on <NativeView> itself, though its
//      type allows testID and pointerEvents: so a wrapper.)
//   d) Reorder in a sideways List (chips of different widths) and in an inverted List with rows of mixed heights: long
//      press, drag, drop; each onReorder is logged ("checks-lab reorder ...") and shown in the status.
import { Box, Column, List, NativeView, Pressable, Row, Scroll, Stack, Text, TextField } from "@zeronative/ui"
import { signal, useMotion } from "@zeronative/core"
import { c } from "./tokens"

function ChkSection(props: { title: string; note: string; children?: any }) {
  return (
    <Column style={{ gap: 8, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.white }}>
      <Text fontSize={15} fontWeight={700} color={c.ink}>
        {props.title}
      </Text>
      <Text fontSize={12} color={c.muted}>
        {props.note}
      </Text>
      {props.children}
    </Column>
  )
}

export function ChecksLabScreen() {
  const status = signal("status: ready")
  const say = (s: string) => {
    status.set(`status: ${s}`)
    console.log(`checks-lab ${s}`)
  }
  const lakh = useMotion(1234567)
  const minus = useMotion(-123456.5)
  const turn = useMotion(1)
  const turnedTaps = signal(0)
  const tiltTaps = signal(0)
  const underTaps = signal(0)
  const viewEvents = signal(0)
  const chips = signal(["Chai", "Groceries", "Rent", "Fuel and tolls", "Gym", "Books"])
  const rows = signal([
    { id: "r1", h: 44, name: "Row 1 (44)" },
    { id: "r2", h: 100, name: "Row 2 (100)" },
    { id: "r3", h: 60, name: "Row 3 (60)" },
    { id: "r4", h: 120, name: "Row 4 (120)" },
    { id: "r5", h: 44, name: "Row 5 (44)" },
    { id: "r6", h: 80, name: "Row 6 (80)" },
  ])
  function moved<T>(list: T[], from: number, to: number): T[] {
    const next = list.slice()
    const [hit] = next.splice(from, 1)
    if (hit !== undefined) next.splice(to, 0, hit)
    return next
  }
  return (
    <Scroll style={{ flex: 1, gap: 14, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16 }}>
      <Text fontSize={20} fontWeight={700} color={c.ink}>
        Checks lab
      </Text>
      <Text testID="checks-status" fontSize={13} color={c.ink}>
        {status()}
      </Text>

      <ChkSection title="a) Motion text grouping" note="You should see: ₹12,34,567 · -₹1,23,456.50 · 1,234,567 (no JS per frame).">
        <Text testID="lakh-in" fontSize={18} fontWeight={700} color={c.ink}>
          {lakh.format({ prefix: "₹" })}
        </Text>
        <Text testID="lakh-minus" fontSize={18} fontWeight={700} color={c.ink}>
          {minus.format({ prefix: "₹", decimals: 2 })}
        </Text>
        <Text testID="lakh-standard" fontSize={18} fontWeight={700} color={c.ink}>
          {lakh.format({ grouping: "standard" })}
        </Text>
        <Row style={{ gap: 8 }}>
          <Pressable testID="lakh-up" onPress={() => { lakh.to(98765432, { duration: 300 }); say("lakh up") }} style={{ padding: 8, borderRadius: 6, backgroundColor: c.pillBg }}>
            <Text fontSize={12} fontWeight={600} color={c.ink}>To 9,87,65,432</Text>
          </Pressable>
        </Row>
      </ChkSection>

      <ChkSection title="b) Taps on 3D-turned views" note="A blue card turned 40° about Y and a field turned with it (camera 8), a teal card tilted 25° about X: each takes its taps where it is drawn.">
        <Row style={{ gap: 16, justifyContent: "center", paddingVertical: 8 }}>
          <Pressable
            testID="turned-card"
            onPress={() => { turnedTaps.set(turnedTaps() + 1); say(`turned ${turnedTaps()}`) }}
            style={{ width: 130, height: 70, borderRadius: 12, backgroundColor: c.primary, alignItems: "center", justifyContent: "center", transform: [{ rotateY: turn.map([0, 1], [0, 40]) }] }}
          >
            <Text fontSize={14} fontWeight={700} color={c.white}>Turned</Text>
          </Pressable>
          <Pressable
            testID="tilted-card"
            onPress={() => { tiltTaps.set(tiltTaps() + 1); say(`tilted ${tiltTaps()}`) }}
            style={{ width: 130, height: 70, borderRadius: 12, backgroundColor: "#0F766E", alignItems: "center", justifyContent: "center", cameraDistance: 14, transform: [{ rotateX: turn.map([0, 1], [0, 25]) }] }}
          >
            <Text fontSize={14} fontWeight={700} color={c.white}>Tilted</Text>
          </Pressable>
        </Row>
        <TextField
          testID="turned-field"
          placeholder="Turned field"
          onFocus={() => say("turned field focused")}
          style={{ width: 220, height: 44, alignSelf: "center", borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 10, transform: [{ rotateY: turn.map([0, 1], [0, 20]) }] }}
        />
      </ChkSection>

      <ChkSection title="c) NativeView testID and pointerEvents" note="Top: a native view in a box with a testID (tap it: view event). Bottom: a native view in a box with pointerEvents none over a green Pressable: a tap reaches the Pressable.">
        <Box testID="native-with-id" style={{ height: 44 }}>
          <NativeView name="device.fake-view" props={{ label: "with id" }} onEvent={() => { viewEvents.set(viewEvents() + 1); say(`view event ${viewEvents()}`) }} style={{ height: 44 }} />
        </Box>
        <Stack style={{ height: 60 }}>
          <Pressable testID="under-native" onPress={() => { underTaps.set(underTaps() + 1); say(`under ${underTaps()}`) }} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: "#16A34A" }}>
            <Box style={{ flex: 1 }} />
          </Pressable>
          <Box testID="native-none" pointerEvents="none" style={{ position: "absolute", top: 8, bottom: 8, start: 24, end: 24 }}>
            <NativeView name="device.fake-view" props={{ label: "pointerEvents none" }} onEvent={() => say("view none got an event")} style={{ flex: 1 }} />
          </Box>
        </Stack>
      </ChkSection>

      <ChkSection title="d) Reorder: sideways, inverted, mixed heights" note="Long press a chip or a row, drag it, let go: it lands where the gap is, and the order line says so. The inverted list's first row is at the bottom.">
        <Text testID="chips-order" fontSize={12} color={c.ink}>
          {`chips: ${chips().join(", ")}`}
        </Text>
        <List
          testID="chips-list"
          data={chips()}
          key={(t) => t}
          horizontal
          reorderable
          onReorder={(from, to) => { chips.set(moved(chips(), from, to)); say(`reorder chips ${from} → ${to}`) }}
          style={{ height: 52 }}
          row={(t) => (
            <Box style={{ height: 40, marginEnd: 8, paddingHorizontal: 14, borderRadius: 20, backgroundColor: c.pillBg, justifyContent: "center" }}>
              <Text fontSize={13} fontWeight={600} color={c.ink}>{t}</Text>
            </Box>
          )}
        />
        <Text testID="rows-order" fontSize={12} color={c.ink}>
          {`rows: ${rows().map((r) => r.id).join(", ")}`}
        </Text>
        <List
          testID="rows-list"
          data={rows()}
          key={(r) => r.id}
          inverted
          reorderable
          onReorder={(from, to) => { rows.set(moved(rows(), from, to)); say(`reorder rows ${from} → ${to}`) }}
          style={{ height: 320, borderRadius: 10, borderWidth: 1, borderColor: c.border }}
          row={(r) => (
            <Box style={{ height: r.h, marginVertical: 3, marginHorizontal: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: r.h > 70 ? "#DBEAFE" : c.pillBg, justifyContent: "center" }}>
              <Text fontSize={13} fontWeight={600} color={c.ink}>{r.name}</Text>
            </Box>
          )}
        />
      </ChkSection>
    </Scroll>
  )
}
