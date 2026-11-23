// Gesture lab: the gesture cases no motion lab covers (W3-A, iOS's native gestures). Built only from the public API
// (docs/motion.md). It is an example, not framework code. Each case logs what happened ("gesture-lab ..."), so a run
// on a simulator can be checked from the console.
//   a) a card turned in 3D (rotateY 40) with a tap: taps near its visible edges count, as on its drawn shape
//   b) Gesture.exclusive(double tap, tap): a single tap waits for the double tap to fail
//   c) useRotate: two fingers turn a square
//   d) useFling: a quick swipe left or right
//   e) a Pressable on a draggable card: a drag cancels the press (onPressOut(true)), a still tap presses
//   f) a pan that starts only after a long press (activateAfterLongPress), in the Scroll: a quick drag scrolls
//   g) a slider in a Sheet: a sideways drag moves it, the sheet stays; a drag down elsewhere closes the sheet
//   h) overlapping nodes: of two tap boxes, the one on top takes a tap where they overlap; a button over a box takes
//      its tap and the box gets none (as Compose's hit test)
//   i) VoiceOver / TalkBack, one stop per node: a Pressable row that also swipes open (its pan's anchors are actions on
//      the row's own element), and a box with its own accessibilityLabel and a tap gesture (one element, a button)
import { Column, Pressable, Row, Scroll, Sheet, Stack, Text } from "@zeronative/ui"
import { Gesture, nav, signal, useFling, usePan, useRotate, useTap } from "@zeronative/core"
import { c } from "./tokens"

function log(s: string): void {
  console.log("gesture-lab " + s)
}

function GlCard(props: { title: string; hint: string; children?: unknown }) {
  return (
    <Column style={{ padding: 16, gap: 10, borderRadius: 20, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      <Text fontSize={16} fontWeight={800} color={c.ink}>
        {props.title}
      </Text>
      <Text fontSize={12} color={c.muted}>
        {props.hint}
      </Text>
      {props.children as never}
    </Column>
  )
}

function GlTurned() {
  const taps = signal(0)
  const tap = useTap({ a11yLabel: "Turned card", onEnd: () => { taps.set(taps() + 1); log("turned tap " + taps()) } })
  return (
    <GlCard title="a) Turned card" hint="A tap anywhere on the turned card counts.">
      <Stack
        gesture={tap}
        style={{ height: 120, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: c.primary, transform: [{ rotateY: 40 }] }}
      >
        <Text fontSize={16} fontWeight={800} color={c.white}>
          {"Taps " + taps()}
        </Text>
      </Stack>
    </GlCard>
  )
}

function GlDoubleTap() {
  const singles = signal(0)
  const doubles = signal(0)
  const dbl = useTap({ taps: 2, onEnd: () => { doubles.set(doubles() + 1); log("double " + doubles()) } })
  const one = useTap({ onEnd: () => { singles.set(singles() + 1); log("single " + singles()) } })
  const both = Gesture.exclusive(dbl, one)
  return (
    <GlCard title="b) Double tap or tap" hint="One tap counts after a short wait; two quick taps count as a double tap only.">
      <Stack gesture={both} style={{ height: 70, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: c.pillBg }}>
        <Text fontSize={14} fontWeight={700} color={c.ink}>
          {"Taps " + singles() + " · double taps " + doubles()}
        </Text>
      </Stack>
    </GlCard>
  )
}

function GlRotate() {
  const rot = useRotate({ onEnd: (e) => log("rotate end " + Math.round(e.angle ?? 0)) })
  return (
    <GlCard title="c) Rotate" hint="Turn the square with two fingers.">
      <Row style={{ justifyContent: "center" }}>
        <Stack gesture={rot} style={{ width: 140, height: 140, borderRadius: 12, backgroundColor: "#F59E0B", transform: [{ rotate: rot.angle }] }} />
      </Row>
    </GlCard>
  )
}

function GlFling() {
  const last = signal("none")
  const fling = useFling({ directions: ["left", "right"], onEnd: (e) => { last.set(e.direction ?? "?"); log("fling " + e.direction) } })
  return (
    <GlCard title="d) Fling" hint="Swipe quickly left or right on the box.">
      <Stack gesture={fling} style={{ height: 70, borderRadius: 14, alignItems: "center", justifyContent: "center", backgroundColor: c.successBg }}>
        <Text fontSize={14} fontWeight={700} color={c.success}>
          {"Last fling: " + last()}
        </Text>
      </Stack>
    </GlCard>
  )
}

function GlPressInPan() {
  const note = signal("—")
  const pan = usePan({ axis: "x", anchors: [{ id: "home", x: 0 }], a11yLabel: "Card with a button" })
  return (
    <GlCard title="e) Button on a draggable card" hint="Tap the button: it presses. Drag the card from the button: the press is cancelled.">
      <Row gesture={pan} style={{ height: 80, borderRadius: 16, paddingHorizontal: 16, alignItems: "center", gap: 12, backgroundColor: c.pillBg, transform: [{ translateX: pan.x }] }}>
        <Pressable
          onPressIn={() => log("press in")}
          onPressOut={(cancelled?: boolean) => { log("press out " + (cancelled ? "cancelled" : "lifted")); note.set(cancelled ? "cancelled" : "lifted") }}
          onPress={() => { log("press"); note.set("pressed") }}
          style={{ paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: c.primary }}
        >
          <Text fontSize={13} fontWeight={700} color={c.white}>
            Button
          </Text>
        </Pressable>
        <Text fontSize={13} color={c.ink}>
          {"Last: " + note()}
        </Text>
      </Row>
    </GlCard>
  )
}

function GlHoldThenDrag() {
  const pan = usePan({
    activateAfterLongPress: 400,
    anchors: [{ id: "home", x: 0, y: 0 }],
    a11yLabel: "Chip",
    haptic: { longPress: "medium" },
    onStart: () => log("hold-drag start"),
    onEnd: () => log("hold-drag end"),
  })
  return (
    <GlCard title="f) Hold, then drag" hint="Hold the chip, then drag it anywhere. A quick drag scrolls the page instead.">
      <Row>
        <Stack gesture={pan} style={{ paddingHorizontal: 18, paddingVertical: 12, borderRadius: 20, backgroundColor: "#E0E7FF", transform: [{ translateX: pan.x }, { translateY: pan.y }] }}>
          <Text fontSize={13} fontWeight={700} color={c.primary}>
            Hold me
          </Text>
        </Stack>
      </Row>
    </GlCard>
  )
}

function GlSheetSlider() {
  const open = signal(false)
  const slider = usePan({
    axis: "x",
    bounds: { x: [0, "100%"] },
    rubber: false,
    a11yLabel: "Volume",
    onStart: () => log("sheet slider start"),
    onEnd: (e) => log("sheet slider end " + Math.round(e.x ?? 0)),
  })
  return (
    <GlCard title="g) Slider in a sheet" hint="Open the sheet. Drag the knob sideways: the sheet stays. Drag down on the sheet: it closes.">
      <Pressable onPress={() => open.set(true)} style={{ alignSelf: "flex-start", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12, backgroundColor: c.primary }}>
        <Text fontSize={13} fontWeight={700} color={c.white}>
          Open the sheet
        </Text>
      </Pressable>
      <Sheet visible={open()} detents="half" onDismiss={() => { open.set(false); log("sheet closed") }}>
        <Column style={{ padding: 24, gap: 16 }}>
          <Text fontSize={16} fontWeight={800} color={c.ink}>
            Volume
          </Text>
          <Stack style={{ height: 44, borderRadius: 22, backgroundColor: c.pillBg }}>
            <Stack gesture={slider} style={{ position: "absolute", top: 2, start: 2, width: 40, height: 40, borderRadius: 20, backgroundColor: c.primary, transform: [{ translateX: slider.x }] }} />
          </Stack>
        </Column>
      </Sheet>
    </GlCard>
  )
}

function GlOverlap() {
  const back = signal(0)
  const front = signal(0)
  const pressed = signal(0)
  const backTap = useTap({ a11yLabel: "Back box", onEnd: () => { back.set(back() + 1); log("overlap back " + back()) } })
  const frontTap = useTap({ a11yLabel: "Front box", onEnd: () => { front.set(front() + 1); log("overlap front " + front()) } })
  return (
    <GlCard title="h) Overlapping boxes" hint="Tap where the boxes overlap: only the front one counts. Tap the button: only the button counts.">
      <Stack style={{ height: 120 }}>
        <Stack gesture={backTap} style={{ position: "absolute", top: 0, start: 0, width: 180, height: 120, borderRadius: 14, padding: 10, backgroundColor: c.pillBg }}>
          <Text fontSize={13} fontWeight={700} color={c.ink}>
            {"Back " + back()}
          </Text>
        </Stack>
        <Stack gesture={frontTap} style={{ position: "absolute", top: 20, start: 110, width: 180, height: 100, borderRadius: 14, padding: 10, alignItems: "flex-end", backgroundColor: c.successBg }}>
          <Text fontSize={13} fontWeight={700} color={c.success}>
            {"Front " + front()}
          </Text>
        </Stack>
        <Pressable
          onPress={() => { pressed.set(pressed() + 1); log("overlap button " + pressed()) }}
          style={{ position: "absolute", top: 70, start: 200, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.primary }}
        >
          <Text fontSize={12} fontWeight={700} color={c.white}>
            {"Button " + pressed()}
          </Text>
        </Pressable>
      </Stack>
    </GlCard>
  )
}

function GlOneStop() {
  const opened = signal(0)
  const tiles = signal(0)
  const swipe = usePan({
    axis: "x",
    bounds: { x: [-120, 0] },
    anchors: [{ id: "closed", x: 0 }, { id: "open", x: -120 }],
    a11yLabel: "Mail row",
    onEnd: (e: { anchor?: string; accessibility?: boolean }) => log("row end " + (e.anchor ?? "") + (e.accessibility ? " (accessibility)" : "")),
  })
  const tileTap = useTap({ a11yLabel: "Tile tap", onEnd: (e: { accessibility?: boolean }) => { tiles.set(tiles() + 1); log("tile tap " + tiles() + (e.accessibility ? " (accessibility)" : "")) } })
  return (
    <GlCard title="i) One stop per node" hint="With VoiceOver on: the row is one element with actions closed / open, the tile one button.">
      <Pressable
        gesture={swipe}
        onPress={() => { opened.set(opened() + 1); log("row press " + opened()) }}
        style={{ height: 56, borderRadius: 12, paddingHorizontal: 16, justifyContent: "center", backgroundColor: c.pillBg, transform: [{ translateX: swipe.x }] }}
      >
        <Text fontSize={13} fontWeight={700} color={c.ink}>
          {"Mail row (pressed " + opened() + ")"}
        </Text>
      </Pressable>
      <Stack gesture={tileTap} accessibilityLabel="Labelled tile" style={{ marginTop: 12, height: 56, borderRadius: 12, padding: 12, backgroundColor: c.successBg }}>
        <Text fontSize={13} fontWeight={700} color={c.success}>
          {"Tile " + tiles()}
        </Text>
      </Stack>
    </GlCard>
  )
}

export function GestureLabScreen() {
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Gestures
        </Text>
      </Row>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ padding: 16, gap: 16 }}>
          <GlTurned />
          <GlDoubleTap />
          <GlRotate />
          <GlFling />
          <GlPressInPan />
          <GlHoldThenDrag />
          <GlSheetSlider />
          <GlOverlap />
          <GlOneStop />
        </Column>
      </Scroll>
    </Column>
  )
}
