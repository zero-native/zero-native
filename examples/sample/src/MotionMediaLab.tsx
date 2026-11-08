// Motion lab 4: media. Built only from the public gestures-and-motion API (docs/gestures-and-motion-v1.md, lab 5 in the
// plan's table: "Media"). It is an example, not framework code.
//   a) a zoomable photo: pinch + drag + double tap, all at once
//   b) a spending chart you can scrub with a finger: a crosshair follows the touch, JS only reads the bar number
// The pinch, the drag, the zoom springs and the crosshair run on the UI thread.
import { Column, Image, Pressable, Row, Stack, Text } from "@zero-native/ui"
import { clamp, computed, derive, Gesture, nav, self, signal, usePan, usePinch, useTap } from "@zero-native/core"
import { c } from "./tokens"
import { formatIndian } from "./money"

const PHOTO = "https://picsum.photos/id/1060/1200/900"
const MAX_ZOOM = 4
const DOUBLE_TAP_ZOOM = 2.5

const MONTHS = ["Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"]
// Money spent per month with ZeroBill (₹).
const SPENT = [2400, 3100, 1800, 4200, 3600, 5200, 4800, 2900, 3300, 6100, 5400, 4600]
const SLOT = 24 // dp per bar, so the chart is 12 x 24 = 288 dp wide
const CHART_W = SPENT.length * SLOT
const CHART_H = 150
const TIP_H = 56
const BAR_MAX = CHART_H - 10
const SPENT_MAX = Math.max(...SPENT)
const BARS = SPENT.map((v, i) => ({ i, month: MONTHS[i], value: v, h: Math.round((v / SPENT_MAX) * BAR_MAX) }))
const SPENT_TOTAL = SPENT.reduce((a, b) => a + b, 0)

/** Blocks the JS thread for [ms]. The photo and the crosshair must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MmButton(props: { label: string; onPress: () => void; soft?: boolean }) {
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

function MmTab(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      style={{ flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: "center", backgroundColor: props.on ? c.primary : c.pillBg }}
    >
      <Text fontSize={13} fontWeight={700} color={props.on ? c.white : c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

// ---- a) Zoomable photo ------------------------------------------------------------------------------------------------

function MmZoomDemo() {
  const pinch = usePinch({
    min: 1,
    max: MAX_ZOOM,
    // Zoomed out all the way: the photo goes back to the middle.
    onEnd: (e) => {
      if ((e.scale ?? 1) <= 1.05) {
        void pan.x.to(0, "spring")
        void pan.y.to(0, "spring")
      }
    },
  })

  // The photo can be dragged only as far as the extra size it has from zooming (nothing when it is at 1x).
  const pan = usePan({
    axis: "xy",
    bounds: {
      x: [derive(() => (-(pinch.scale() - 1) * self.width) / 2), derive(() => ((pinch.scale() - 1) * self.width) / 2)],
      y: [derive(() => (-(pinch.scale() - 1) * self.height) / 2), derive(() => ((pinch.scale() - 1) * self.height) / 2)],
    },
  })

  // JS reads the zoom only to decide what a double tap does.
  const zoomed = computed(() => pinch.scale() > 1.05)

  const reset = () => {
    void pinch.scale.to(1, "spring")
    void pan.x.to(0, "spring")
    void pan.y.to(0, "spring")
  }

  const doubleTap = useTap({
    taps: 2,
    a11yLabel: "Zoom the photo in or out",
    onEnd: () => {
      if (zoomed()) reset()
      else void pinch.scale.to(DOUBLE_TAP_ZOOM, "spring")
    },
  })

  const gesture = Gesture.simultaneous(pinch, pan, doubleTap)

  return (
    <Column style={{ gap: 14, paddingHorizontal: 20 }}>
      <Column gesture={gesture} style={{ height: 300, borderRadius: 24, overflow: "hidden", backgroundColor: c.pillBg, borderWidth: 1, borderColor: c.border }}>
        <Image
          src={PHOTO}
          loading="shimmer"
          contentScale="cover"
          style={{
            width: "100%",
            height: "100%",
            transform: [{ translateX: pan.x }, { translateY: pan.y }, { scale: pinch.scale }],
          }}
        />
      </Column>
      <Row style={{ alignItems: "center", gap: 12 }}>
        <Column style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
          {/* The number is made by native text: JS is not asked every frame. */}
          <Text fontSize={20} fontWeight={800} color={c.primary}>
            {pinch.scale.format({ decimals: 1, suffix: "×" })}
          </Text>
        </Column>
        <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
          {zoomed() ? "Drag to look around. Double-tap to zoom out." : "Double-tap to zoom in, or pinch with two fingers."}
        </Text>
        <MmButton label="Reset" soft onPress={reset} />
      </Row>
      {/* TODO (needs the focal point): zoom around the fingers, not the middle. pinch.focalX / focalY exist; the photo's
          drag would have to move by (1 - scale) * (focal - middle) while pinching. Not done in this lab. */}
    </Column>
  )
}

// ---- b) Chart with scrubbing ------------------------------------------------------------------------------------------

function MmChartDemo() {
  const touching = signal(false)

  const scrub = usePan({
    axis: "x",
    minDistance: 1,
    onBegin: () => touching.set(true),
    onFinalize: () => touching.set(false),
  })

  // JS reads the finger place only to know which bar it is on.
  const bar = computed(() => Math.min(SPENT.length - 1, Math.max(0, Math.floor(scrub.touchX() / SLOT))))

  return (
    <Column style={{ gap: 14, paddingHorizontal: 20 }}>
      <Column style={{ padding: 16, gap: 12, backgroundColor: c.white, borderRadius: 24, borderWidth: 1, borderColor: c.border }}>
        <Column style={{ gap: 2 }}>
          <Text fontSize={12} color={c.muted}>
            Spent in the last 12 months
          </Text>
          <Text fontSize={28} fontWeight={800} color={c.ink}>
            ₹{formatIndian(String(SPENT_TOTAL))}
          </Text>
        </Column>

        <Stack gesture={scrub} style={{ width: CHART_W, height: TIP_H + CHART_H, alignSelf: "center" }}>
          {/* Bars. */}
          <Row style={{ position: "absolute", top: TIP_H, start: 0, height: CHART_H, alignItems: "flex-end" }}>
            {BARS.map((b) => (
              <Column key={b.month} style={{ width: SLOT, alignItems: "center" }}>
                <Column
                  style={{
                    width: 16,
                    height: b.h,
                    borderTopLeftRadius: 6,
                    borderTopRightRadius: 6,
                    backgroundColor: touching() && bar() === b.i ? c.primary : "#C7D2FE",
                  }}
                />
              </Column>
            ))}
          </Row>

          {/* The crosshair: a thin line that follows the finger. */}
          <Column
            pointerEvents="none"
            animate={120}
            style={{
              position: "absolute",
              top: TIP_H - 6,
              start: 0,
              width: 2,
              height: CHART_H + 6,
              backgroundColor: c.ink,
              opacity: touching() ? 0.7 : 0,
              transform: [{ translateX: derive(() => clamp(scrub.touchX(), 0, CHART_W) - 1) }],
            }}
          />

          {/* The tip above it: JS fills in the text, native moves it. */}
          <Column
            pointerEvents="none"
            animate={120}
            style={{
              position: "absolute",
              top: 0,
              start: 0,
              width: 88,
              height: 46,
              borderRadius: 12,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: c.ink,
              opacity: touching() ? 1 : 0,
              transform: [{ translateX: derive(() => clamp(scrub.touchX() - 44, 0, CHART_W - 88)) }],
            }}
          >
            <Text fontSize={15} fontWeight={800} color={c.white}>
              ₹{formatIndian(String(SPENT[bar()]))}
            </Text>
            <Text fontSize={11} color="#CBD5E1">
              {MONTHS[bar()]}
            </Text>
          </Column>
        </Stack>

        <Row style={{ width: CHART_W, alignSelf: "center" }}>
          {BARS.map((b) => (
            <Column key={b.month} style={{ width: SLOT, alignItems: "center" }}>
              <Text fontSize={9} color={c.muted}>
                {b.month}
              </Text>
            </Column>
          ))}
        </Row>
      </Column>
      <Text fontSize={12} color={c.muted}>
        Touch the chart and slide a finger along it.
      </Text>
    </Column>
  )
}

export function MotionMediaLabScreen() {
  const tab = signal(0)
  const note = signal("")
  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms. Zoom and crosshair kept moving.")
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
          Photo and chart
        </Text>
      </Row>

      <Column style={{ padding: 16, gap: 10 }}>
        <Row style={{ gap: 8 }}>
          <MmTab label="Zoom photo" on={tab() === 0} onPress={() => tab.set(0)} />
          <MmTab label="Scrub chart" on={tab() === 1} onPress={() => tab.set(1)} />
        </Row>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <MmButton label="Keep JS busy 200 ms" onPress={busyOnce} />
          <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
            {note()}
          </Text>
        </Row>
      </Column>

      {tab() === 0 ? <MmZoomDemo /> : <MmChartDemo />}
    </Column>
  )
}
