// Motion lab 1: a floating video card (like a mini player or a video nudge). It is built only from the public
// gestures-and-motion API (docs/gestures-and-motion-v1.md, lab 1). It is an example, not framework code.
//
// What runs where: the finger, the fling to a corner, the magnet, the pinch and the trailing dots all run on the UI
// thread. JS only hears three events (start, end, finalize). So the card keeps moving while JS is busy.
import { Box, Column, Pressable, Row, Stack, Text, TextField } from "@zeronative/ui"
import { derive, env, follow, Gesture, nav, parent, self, signal, usePan, usePinch, type GestureEvent } from "@zeronative/core"
import { c } from "./tokens"

const CARD_W = 160
const CARD_H = 90
const INSET = 16
// The dismiss circle is 64 dp wide and sits 40 dp above the bottom edge: its centre is 72 dp above the bottom.
const DISMISS_FROM_BOTTOM = 72
const DANGER = "#E23744"

/** Blocks the JS thread for [ms]. The card must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MvButton(props: { label: string; onPress: () => void; soft?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      pressScale={0.97}
      style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: props.soft ? c.pillBg : c.primary }}
    >
      <Text fontSize={13} fontWeight={700} color={props.soft ? c.ink : c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function MotionVideoLabScreen() {
  const hidden = signal(false)
  const dragging = signal(false)
  const lastDrop = signal("none yet")
  const busyRunning = signal(false)
  const note = signal("")

  // Pinch first: the corner anchors read its scale, so a bigger card still keeps 16 dp from the edge.
  const pinch = usePinch({ min: 0.7, max: 1.6 })

  const scale = pinch.scale
  const keyboard = env.keyboardHeight
  // The card grows from its centre, so each side moves out by half of the extra size.
  const growX = derive(() => ((scale() - 1) * self.width) / 2)
  const growY = derive(() => ((scale() - 1) * self.height) / 2)
  const leftX = derive(() => INSET + growX())
  const rightX = derive(() => parent.width - self.width - INSET - growX())
  const topY = derive(() => INSET + growY())
  // The bottom corners rise with the keyboard (env.keyboardHeight moves every frame while it opens).
  const bottomY = derive(() => parent.height - keyboard() - self.height - INSET - growY())

  const pan = usePan({
    axis: "xy",
    bounds: { x: [0, "100%"], y: [0, "100%"] },
    anchors: [
      { id: "tl", x: leftX, y: topY },
      { id: "tr", x: rightX, y: topY },
      { id: "bl", x: leftX, y: bottomY },
      { id: "br", x: rightX, y: bottomY },
    ],
    // The dismiss circle: its centre, as a place for the card's top-left corner.
    magnets: [
      {
        id: "dismiss",
        x: derive(() => parent.width / 2 - self.width / 2),
        y: derive(() => parent.height - DISMISS_FROM_BOTTOM - self.height / 2),
        radius: 96,
        pull: 0.7,
      },
    ],
    release: { project: true },
    haptic: { start: "light", snap: "selection", magnet: "medium" },
    a11yLabel: "Floating video",
    onStart: () => dragging.set(true),
    onFinalize: () => dragging.set(false),
    onEnd: (e: GestureEvent) => {
      lastDrop.set(e.anchor ?? "free")
      if (e.anchor === "dismiss") hidden.set(true)
    },
  })

  // 0 far away, 1 on the dismiss circle.
  const near = pan.magnet("dismiss")
  const nearN = near

  // Chat heads: the first chases the card, the second chases the first. Springs on the UI thread.
  const t1x = follow(pan.x)
  const t2x = follow(t1x)
  const t1y = follow(pan.y)
  const t2y = follow(t1y)
  const x1 = t1x
  const y1 = t1y
  const x2 = t2x
  const y2 = t2y

  const gesture = Gesture.simultaneous(pan, pinch)

  // Starts in the bottom-right corner: it flies in from the top-left once the first layout is done.
  setTimeout(() => {
    void pan.snapTo("br")
  }, 150)

  const showAgain = () => {
    pan.x.set(0)
    pan.y.set(0)
    hidden.set(false)
    // The card needs one layout to get its size back, then it flies to the corner.
    setTimeout(() => {
      void pan.snapTo("br")
    }, 120)
  }

  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms.")
  }

  // Busy for about 5 s: a 200 ms block every 250 ms, so you can drag with one hand.
  const busyFiveSeconds = () => {
    if (busyRunning()) return
    busyRunning.set(true)
    let n = 0
    const timer = setInterval(() => {
      busyLoop(200)
      n++
      if (n >= 20) {
        clearInterval(timer)
        busyRunning.set(false)
        note.set("JS busy test finished.")
      }
    }, 250)
  }

  return (
    <Stack style={{ flex: 1, backgroundColor: c.bg }}>
      <Column style={{ gap: 12 }}>
        <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
          <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}>
            <Text fontSize={20} fontWeight={700} color={c.ink}>
              ←
            </Text>
          </Pressable>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            Floating video
          </Text>
        </Row>

        <Column style={{ marginHorizontal: 16, padding: 14, gap: 6, backgroundColor: c.white, borderRadius: 16, borderWidth: 1, borderColor: c.border }}>
          <Text fontSize={13} color={c.muted}>
            Drag the card anywhere. Flick it: it flies to the nearest corner.
          </Text>
          <Text fontSize={13} color={c.muted}>
            Drag it to the red circle at the bottom and let go: it closes.
          </Text>
          <Text fontSize={13} color={c.muted}>
            Pinch with two fingers to resize it (70% to 160%).
          </Text>
          <Text fontSize={13} color={c.muted}>
            The two dots follow the card. Tap the field: the bottom corners rise above the keyboard.
          </Text>
          <Text fontSize={13} color={c.muted}>
            Press "Busy" and keep dragging. The card does not stop.
          </Text>
        </Column>

        <Column style={{ marginHorizontal: 16, gap: 10 }}>
          <TextField
            placeholder="Tap here to open the keyboard"
            style={{ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border, fontSize: 15, color: c.ink }}
          />
          <Row style={{ gap: 10 }}>
            <MvButton label="Keep JS busy 200 ms" onPress={busyOnce} />
            <MvButton label={busyRunning() ? "Busy for 5 s..." : "Busy for 5 s"} soft onPress={busyFiveSeconds} />
          </Row>
          <Text fontSize={12} color={c.muted}>
            Last drop: {lastDrop()} {note() ? "· " + note() : ""}
          </Text>
          {hidden() ? <MvButton label="Show again" onPress={showAgain} /> : null}
        </Column>
      </Column>

      {/* Dismiss circle: appears while you drag, grows and turns red as the card comes near. */}
      <Column pointerEvents="none" style={{ position: "absolute", start: 0, end: 0, bottom: 40, alignItems: "center" }}>
        <Box animate={180} style={{ opacity: dragging() ? 1 : 0 }}>
          <Column
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: near.mapColor([0, 1], ["#334155", DANGER]),
              transform: [{ scale: near.map([0, 1], [0.85, 1.25]) }],
            }}
          >
            <Text fontSize={22} fontWeight={700} color={c.white}>
              ✕
            </Text>
          </Column>
        </Box>
      </Column>

      {/* Chat heads. They sit under the card, so they show only when the card moves away from them. */}
      <Box
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          start: 0,
          width: 28,
          height: 28,
          borderRadius: 14,
          backgroundColor: "#F59E0B",
          display: hidden() ? "none" : "flex",
          transform: [{ translateX: derive(() => x1() + CARD_W / 2 - 14) }, { translateY: derive(() => y1() + CARD_H / 2 - 14) }],
        }}
      />
      <Box
        pointerEvents="none"
        style={{
          position: "absolute",
          top: 0,
          start: 0,
          width: 20,
          height: 20,
          borderRadius: 10,
          backgroundColor: "#10B981",
          display: hidden() ? "none" : "flex",
          transform: [{ translateX: derive(() => x2() + CARD_W / 2 - 10) }, { translateY: derive(() => y2() + CARD_H / 2 - 10) }],
        }}
      />

      {/* The card. It is a coloured box with a play sign: a stand-in for a video. */}
      <Column
        gesture={gesture}
        style={{
          position: "absolute",
          top: 0,
          start: 0,
          width: CARD_W,
          height: CARD_H,
          borderRadius: 16,
          backgroundColor: c.primary,
          elevation: 10,
          alignItems: "center",
          justifyContent: "center",
          display: hidden() ? "none" : "flex",
          transform: [
            { translateX: pan.x },
            { translateY: pan.y },
            { scale: derive(() => scale() * (1 - 0.35 * nearN())) },
          ],
        }}
      >
        <Text fontSize={30} color={c.white}>
          ▶
        </Text>
        <Text fontSize={11} fontWeight={700} color="#C7D2FE">
          Live · 12:04
        </Text>
      </Column>
    </Stack>
  )
}
