// Motion lab 9: extension. Built only from the public gestures-and-motion API (docs/gestures-and-motion-v1.md, lab
// "Extension"; guide: docs/motion.md §6, §9, §10) and the test plugin plugins/device-test. It is an example, not
// framework code.
//   1. Tilt card: rotateX / rotateY follow how the phone leans (useTilt). Needs a real phone: an emulator has no sensor.
//   2. Orbit: a dot moved each frame by native plugin code (orbit(), a motion value made by a plugin)
//   3. Wobble: a box that jumps with a curve from the plugin (wobble()), next to the built-in spring
//   4. Native view: a view from the plugin draws a bar from a motion value (`level`), no JS per frame
//   5. useFrame: a frame counter in JS. Press "Keep JS busy": the number drops, the dot and the bar do not stop.
//   6. Manual start: a drag that starts only while "Unlock" is on (manualActivation, Gesture.activate / Gesture.fail)
import { Box, Column, NativeView, Pressable, Row, Scroll, Stack, Switch, Text } from "@zero-native/ui"
import { derive, Gesture, nav, signal, useFrame, useMotion, usePan, useTilt, type PanGesture } from "@zero-native/core"
import { orbit, wobble } from "@zero-native/device-test"
import { c } from "./tokens"

/** Blocks the JS thread for [ms]. The plugin's values must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MxButton(props: { label: string; onPress: () => void; soft?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      pressScale={0.97}
      style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, backgroundColor: props.soft ? c.pillBg : c.primary, alignSelf: "flex-start" }}
    >
      <Text fontSize={13} fontWeight={700} color={props.soft ? c.ink : c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

/** A white card with a title and a hint above its demo. */
function MxCard(props: { title: string; hint: string; children?: unknown }) {
  return (
    <Column style={{ padding: 16, gap: 10, borderRadius: 24, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      <Text fontSize={16} fontWeight={800} color={c.ink}>
        {props.title}
      </Text>
      <Text fontSize={12} color={c.muted}>
        {props.hint}
      </Text>
      {props.children}
    </Column>
  )
}

// ---- 1. Tilt card ------------------------------------------------------------------------------------------------------------

function MxTiltDemo() {
  // x: -1 (leaning left) to 1 (right). y: -1 (top away from you) to 1 (top towards you). Smoothed by native.
  const tilt = useTilt()

  return (
    <Column style={{ alignItems: "center", gap: 12, paddingVertical: 6 }}>
      <Stack
        style={{
          width: 280,
          height: 170,
          borderRadius: 24,
          overflow: "hidden",
          backgroundColor: c.primary,
          elevation: 10,
          cameraDistance: 14,
          transform: [{ rotateX: tilt.y.map([-1, 1], [-16, 16]) }, { rotateY: tilt.x.map([-1, 1], [16, -16]) }],
        }}
      >
        <Column style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, padding: 20, justifyContent: "space-between" }}>
          <Row style={{ alignItems: "center" }}>
            <Text fontSize={16} fontWeight={800} color={c.white} style={{ flex: 1 }}>
              ZeroBill
            </Text>
            <Text fontSize={12} fontWeight={700} color="#C7D2FE">
              CASHBACK CARD
            </Text>
          </Row>
          <Column style={{ gap: 2 }}>
            <Text fontSize={12} color="#C7D2FE">
              Balance
            </Text>
            <Text fontSize={32} fontWeight={800} color={c.white}>
              ₹1,250
            </Text>
          </Column>
        </Column>
        {/* A bright patch that grows as the card turns. */}
        <Column
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            start: 0,
            end: 0,
            backgroundColor: c.white,
            opacity: derive(() => Math.min(0.3, Math.hypot(tilt.x(), tilt.y()) * 0.25)),
          }}
        />
      </Stack>
      <Row style={{ gap: 18 }}>
        <Text fontSize={12} color={c.muted}>
          x {tilt.x.format({ decimals: 2 })}
        </Text>
        <Text fontSize={12} color={c.muted}>
          y {tilt.y.format({ decimals: 2 })}
        </Text>
      </Row>
    </Column>
  )
}

// ---- 2. Orbit (a value moved by plugin code) ----------------------------------------------------------------------------------

const ORBIT_R = 44

function MxOrbitDemo() {
  // Two values from the plugin: the x and the y of one circle. Native code sets them each frame; JS is not in the loop.
  const ox = orbit({ radius: ORBIT_R, periodMs: 2400, axis: "x" })
  const oy = orbit({ radius: ORBIT_R, periodMs: 2400, axis: "y" })

  return (
    <Row style={{ alignItems: "center", gap: 16 }}>
      <Stack style={{ width: 120, height: 120 }}>
        <Column style={{ position: "absolute", top: 60 - ORBIT_R, start: 60 - ORBIT_R, width: ORBIT_R * 2, height: ORBIT_R * 2, borderRadius: ORBIT_R, borderWidth: 2, borderColor: c.border }} />
        <Column
          style={{
            position: "absolute",
            top: 50,
            start: 50,
            width: 20,
            height: 20,
            borderRadius: 10,
            // The colour follows the dot's x as well: amber on the left, brand colour on the right.
            backgroundColor: ox.mapColor([-ORBIT_R, ORBIT_R], ["#F59E0B", "#3D26ED"]),
            transform: [{ translateX: ox }, { translateY: oy }],
          }}
        />
      </Stack>
      <Column style={{ gap: 4 }}>
        <Text fontSize={12} color={c.muted}>
          dot x
        </Text>
        <Text fontSize={18} fontWeight={800} color={c.ink}>
          {ox.format({ decimals: 0 })}
        </Text>
        <Text fontSize={12} color={c.muted}>
          dot y
        </Text>
        <Text fontSize={18} fontWeight={800} color={c.ink}>
          {oy.format({ decimals: 0 })}
        </Text>
      </Column>
    </Row>
  )
}

// ---- 3. Wobble (a curve from the plugin) --------------------------------------------------------------------------------------

function MxWobbleDemo() {
  const wob = useMotion(0)
  const spr = useMotion(0)
  let right = false
  const jump = () => {
    right = !right
    const to = right ? 160 : 0
    void wob.to(to, wobble({ rings: 3, ms: 1100 }))
    void spr.to(to, "spring")
  }

  return (
    <Column style={{ gap: 10 }}>
      <Stack style={{ height: 44 }}>
        <Box style={{ position: "absolute", top: 0, start: 0, width: 56, height: 44, borderRadius: 14, backgroundColor: c.primary, alignItems: "center", justifyContent: "center", transform: [{ translateX: wob }] }}>
          <Text fontSize={11} fontWeight={800} color={c.white}>
            wobble
          </Text>
        </Box>
      </Stack>
      <Stack style={{ height: 44 }}>
        <Box style={{ position: "absolute", top: 0, start: 0, width: 56, height: 44, borderRadius: 14, backgroundColor: "#0F766E", alignItems: "center", justifyContent: "center", transform: [{ translateX: spr }] }}>
          <Text fontSize={11} fontWeight={800} color={c.white}>
            spring
          </Text>
        </Box>
      </Stack>
      <MxButton label="Jump" onPress={jump} />
    </Column>
  )
}

// ---- 4. A native view that reads a motion value --------------------------------------------------------------------------------

function MxViewDemo() {
  const said = signal("")
  // A slider: its progress (0 to 1) is the `level` the plugin's view draws.
  const slider = usePan({ axis: "x", bounds: { x: [0, "100%"] }, rubber: false })

  return (
    <Column style={{ gap: 12 }}>
      {/* The view is Kotlin code in the test plugin. `level` is a motion value: it reads it each frame while it draws. */}
      <NativeView
        name="device.fake-view"
        props={{ label: "level bar", level: slider.progress }}
        onEvent={(e) => said.set("The view sent: " + e.name)}
        style={{ width: "100%", height: 64 }}
      />
      <Stack style={{ height: 36, borderRadius: 18, backgroundColor: c.pillBg }}>
        <Column
          gesture={slider}
          accessibilityLabel="Level"
          style={{ position: "absolute", top: 4, start: 4, width: 28, height: 28, borderRadius: 14, backgroundColor: c.primary, elevation: 3, transform: [{ translateX: slider.x }] }}
        />
      </Stack>
      <Row style={{ alignItems: "center", gap: 10 }}>
        <Text fontSize={12} color={c.muted}>
          level
        </Text>
        <Text fontSize={14} fontWeight={800} color={c.ink}>
          {derive(() => slider.progress() * 100).format({ decimals: 0, suffix: "%" })}
        </Text>
        <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
          {said()}
        </Text>
      </Row>
    </Column>
  )
}

// ---- 5. useFrame -------------------------------------------------------------------------------------------------------------

/** Frames per second and run time, counted in JS once per frame. A busy JS thread shows up as a lower number. */
function MxFrameBar() {
  const fps = signal(0)
  const seconds = signal(0)
  let frames = 0
  let since = 0
  let opened = 0 // f.t counts from the phone's clock, not from this screen

  useFrame((f) => {
    frames++
    if (since === 0) since = f.t
    if (opened === 0) opened = f.t
    const span = f.t - since
    if (span >= 500) {
      fps.set(Math.round((frames * 1000) / span))
      seconds.set(Math.round((f.t - opened) / 100) / 10)
      frames = 0
      since = f.t
    }
  })

  return (
    <Row style={{ alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 16, backgroundColor: c.ink }}>
      <Text fontSize={12} fontWeight={700} color="#94A3B8">
        useFrame
      </Text>
      <Text fontSize={20} fontWeight={800} color={c.white}>
        {fps()}
      </Text>
      <Text fontSize={12} color="#94A3B8" style={{ flex: 1 }}>
        frames a second · {seconds()} s
      </Text>
    </Row>
  )
}

// ---- 6. Manual start ------------------------------------------------------------------------------------------------------------

function MxManualDemo() {
  const unlocked = signal(false)
  const touches = signal(0)
  const started = signal(0)
  const refused = signal(0)

  // It does not take the touch by itself. When a finger goes down, JS is asked (onBegin) and answers with
  // Gesture.activate or Gesture.fail. It springs home when you let go.
  const knob: PanGesture = usePan({
    axis: "x",
    bounds: { x: [0, "100%"] },
    rubber: false,
    manualActivation: true,
    anchors: [{ id: "home", x: 0 }],
    a11yLabel: "Slider. It moves only while Unlock is on.",
    onBegin: () => {
      touches.set(touches() + 1)
      if (unlocked()) {
        started.set(started() + 1)
        Gesture.activate(knob)
      } else {
        refused.set(refused() + 1)
        Gesture.fail(knob)
      }
    },
  })

  return (
    <Column style={{ gap: 12 }}>
      <Row style={{ alignItems: "center", gap: 10 }}>
        <Text fontSize={14} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          Unlock
        </Text>
        <Switch value={unlocked()} onValueChange={(v) => unlocked.set(v)} />
      </Row>
      <Stack style={{ height: 52, borderRadius: 26, backgroundColor: unlocked() ? c.successBg : c.pillBg }}>
        <Row
          gesture={knob}
          style={{ position: "absolute", top: 4, start: 4, width: 92, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: unlocked() ? c.success : c.disabled, transform: [{ translateX: knob.x }] }}
        >
          <Text fontSize={13} fontWeight={800} color={c.white}>
            {unlocked() ? "Drag me" : "Locked"}
          </Text>
        </Row>
      </Stack>
      <Text fontSize={12} color={c.muted}>
        {"Touches " + touches() + " · started " + started() + " · refused " + refused()}
      </Text>
    </Column>
  )
}

// ---- The screen -----------------------------------------------------------------------------------------------------------------

export function MotionExtensionLabScreen() {
  const note = signal("")
  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms. The dot, the bar and the tilt kept moving; the frame count dipped.")
  }

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Extension
        </Text>
      </Row>

      <Column style={{ padding: 16, gap: 10 }}>
        <MxFrameBar />
        <Row style={{ gap: 10, alignItems: "center" }}>
          <MxButton label="Keep JS busy 200 ms" onPress={busyOnce} />
          <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
            {note()}
          </Text>
        </Row>
      </Column>

      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 16, paddingBottom: 32, gap: 14 }}>
          <MxCard title="Tilt card" hint="Lean the phone left, right, forward, back: the card turns in 3D. This needs a real phone.">
            <MxTiltDemo />
          </MxCard>
          <MxCard title="Orbit" hint="A native plugin moves this dot each frame. JS only made the value. It keeps going while JS is busy.">
            <MxOrbitDemo />
          </MxCard>
          <MxCard title="Wobble" hint="Two jumps with the same target: one with the plugin's own curve (it rings like a bell), one with the built-in spring.">
            <MxWobbleDemo />
          </MxCard>
          <MxCard title="Native view" hint="The blue bar is drawn by the plugin's own view from a motion value. Drag the knob: JS is not asked.">
            <MxViewDemo />
          </MxCard>
          <MxCard title="Manual start" hint="With Unlock off, a touch on the knob is refused. With Unlock on, the same touch starts the drag.">
            <MxManualDemo />
          </MxCard>
        </Column>
      </Scroll>
    </Column>
  )
}
