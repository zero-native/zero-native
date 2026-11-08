// Motion lab 2: payment controls. Built only from the public gestures-and-motion API (docs/gestures-and-motion-v1.md,
// lab 2). It is an example, not framework code.
//   a) slide to pay   b) loan amount slider   c) range slider with two thumbs   d) a circular dial
// The thumbs, fills and colours move on the UI thread. JS reads a value only to show a number.
import { Column, Pressable, Row, Scroll, Stack, Text } from "@zero-native/ui"
import { computed, derive, nav, parent, signal, usePan, type GestureEvent } from "@zero-native/core"
import { c } from "./tokens"
import { formatIndian } from "./money"

const DANGER = "#E23744"
const SOFT_BRAND = "#EEF0FF"

// Sliders in (b) and (c): a track 280 dp wide, a 44 dp touch area around a 28 dp knob.
const SLIDER_W = 280
const TOUCH = 44
const TRAVEL = SLIDER_W - TOUCH // 236
const KNOB = 28

const LOAN_MIN = 10000
const LOAN_MAX = 500000
const LOAN_STEP = 1000
// Haptic ticks at these amounts, as places on the slider (dp from the start).
const LOAN_TICKS = [100000, 200000, 300000, 400000]
const LOAN_TICK_POS = LOAN_TICKS.map((a) => ((a - LOAN_MIN) / (LOAN_MAX - LOAN_MIN)) * TRAVEL)

const PRICE_MIN = 100
const PRICE_MAX = 5000
const PRICE_STEP = 50
// The low thumb stays at least this far (dp) before the high thumb.
const GAP = 28

const DIAL = 220

function loanAmount(p: number): number {
  const q = Math.min(1, Math.max(0, p))
  return Math.round((LOAN_MIN + q * (LOAN_MAX - LOAN_MIN)) / LOAN_STEP) * LOAN_STEP
}

function price(x: number): number {
  const q = Math.min(1, Math.max(0, x / TRAVEL))
  return Math.round((PRICE_MIN + q * (PRICE_MAX - PRICE_MIN)) / PRICE_STEP) * PRICE_STEP
}

/** Blocks the JS thread for [ms]. The thumbs must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MpCard(props: { title: string; hint: string; children?: unknown }) {
  return (
    <Column style={{ padding: 16, gap: 12, backgroundColor: c.white, borderRadius: 20, borderWidth: 1, borderColor: c.border }}>
      <Column style={{ gap: 2 }}>
        <Text fontSize={16} fontWeight={700} color={c.ink}>
          {props.title}
        </Text>
        <Text fontSize={12} color={c.muted}>
          {props.hint}
        </Text>
      </Column>
      {props.children}
    </Column>
  )
}

function MpButton(props: { label: string; onPress: () => void; soft?: boolean }) {
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

export function MotionPayLabScreen() {
  // ---- a) Slide to pay -------------------------------------------------------------------------------------------------
  const payState = signal<"idle" | "paying" | "success" | "failed">("idle")
  const attempts = signal(0)

  const slide = usePan({
    axis: "x",
    bounds: { x: [0, "100%"] },
    anchors: [
      { id: "start", x: 0 },
      { id: "paid", x: "100%" },
    ],
    // It pays only when it is dragged far (200 dp). A fast flick alone does not pay: the speed limit is very high.
    release: { threshold: { velocity: 5000, distance: 200 } },
    haptic: { snap: "medium" },
    a11yLabel: "Slide to pay ₹499",
    onEnd: (e: GestureEvent) => {
      if (e.anchor !== "paid") return
      payState.set("paying")
      const n = attempts() + 1
      attempts.set(n)
      // A pretend payment: the 1st works, the 2nd fails, the 3rd works...
      setTimeout(() => {
        if (n % 2 === 1) {
          payState.set("success")
        } else {
          payState.set("failed")
          void slide.snapTo("start")
        }
      }, 1000)
    },
  })
  const slideX = slide.x
  const slideDone = slide.progress

  const tryAgain = () => {
    payState.set("idle")
    void slide.snapTo("start")
  }

  // ---- b) Loan amount --------------------------------------------------------------------------------------------------
  const loan = usePan({
    axis: "x",
    bounds: { x: [0, "100%"] },
    cross: LOAN_TICK_POS,
    haptic: { cross: "selection" },
    a11yLabel: "Loan amount",
  })
  const loanX = loan.x
  const loanText = computed(() => "₹" + formatIndian(String(loanAmount(loan.progress()))))

  // ---- c) Range slider -------------------------------------------------------------------------------------------------
  // Each thumb has fixed limits. The high thumb is DRAWN at least GAP after the low one (it is pushed if needed), so
  // the low thumb always stays below it. (Why not bounds from the other thumb: see the report. Two pans can't each
  // read the other's x when they are made.)
  const low = usePan({ axis: "x", bounds: { x: [0, TRAVEL - GAP] }, haptic: { start: "light" }, a11yLabel: "Lowest price" })
  const high = usePan({ axis: "x", bounds: { x: [0, "100%"] }, haptic: { start: "light" }, a11yLabel: "Highest price" })
  const lowX = low.x
  const highRaw = high.x
  const highX = derive(() => Math.max(highRaw(), lowX() + GAP))
  const highN = highX
  const rangeText = computed(() => "₹" + formatIndian(String(price(low.x()))) + " to ₹" + formatIndian(String(price(highX()))))

  // ---- d) Dial ---------------------------------------------------------------------------------------------------------
  // The dial itself never moves. We use only where the finger is (touchX, touchY) and turn the knob to point at it.
  const dial = usePan({ axis: "xy", a11yLabel: "Daily limit dial" })
  const tx = dial.touchX
  const ty = dial.touchY
  const dialAngle = derive(() => (Math.atan2(ty() - DIAL / 2, tx() - DIAL / 2) * 180) / Math.PI + 90)
  const dialPercent = computed(() => {
    const a = ((dialAngle() % 360) + 360) % 360
    return Math.round((a / 360) * 100)
  })

  // ---- JS busy ---------------------------------------------------------------------------------------------------------
  const note = signal("")
  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms. The thumbs kept moving.")
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
          Payment controls
        </Text>
      </Row>

      <Scroll style={{ flex: 1 }}>
        <Column style={{ padding: 16, gap: 16 }}>
          <Row style={{ gap: 12, alignItems: "center" }}>
            <MpButton label="Keep JS busy 200 ms" onPress={busyOnce} />
            <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
              {note() === "" ? "Press it while you drag with another finger." : note()}
            </Text>
          </Row>

          {/* a) Slide to pay */}
          <MpCard title="Slide to pay" hint="Drag the white button all the way right. Let go early: it comes back. The 2nd try fails on purpose.">
            <Text fontSize={28} fontWeight={800} color={c.ink}>
              ₹499
            </Text>
            <Stack
              style={{
                height: 56,
                borderRadius: 28,
                overflow: "hidden",
                backgroundColor: slideDone.mapColor([0, 1], [SOFT_BRAND, c.successBg]),
              }}
            >
              {/* The fill grows from the left edge to the middle of the button. */}
              <Column
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  start: 0,
                  end: 0,
                  backgroundColor: slideDone.mapColor([0, 0.9, 1], [c.primary, c.primary, c.success]),
                  transformOrigin: "left",
                  transform: [{ scaleX: derive(() => (slideX() + 28) / parent.width) }],
                }}
              />
              <Column pointerEvents="none" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={15} fontWeight={700} color={c.primary} style={{ opacity: slideDone.map([0, 0.5], [1, 0]) }}>
                  Slide to pay ₹499
                </Text>
              </Column>
              <Column
                gesture={slide}
                style={{
                  position: "absolute",
                  top: 0,
                  start: 0,
                  width: 56,
                  height: 56,
                  borderRadius: 28,
                  backgroundColor: c.white,
                  elevation: 4,
                  alignItems: "center",
                  justifyContent: "center",
                  transform: [{ translateX: slide.x }],
                }}
              >
                <Text fontSize={22} fontWeight={800} color={payState() === "success" ? c.success : payState() === "failed" ? DANGER : c.primary}>
                  {payState() === "success" ? "✓" : payState() === "failed" ? "✕" : "›"}
                </Text>
              </Column>
            </Stack>
            <Text fontSize={13} fontWeight={600} color={payState() === "failed" ? DANGER : payState() === "success" ? c.success : c.muted}>
              {payState() === "idle"
                ? "Slide all the way to pay."
                : payState() === "paying"
                  ? "Paying ₹499..."
                  : payState() === "success"
                    ? "Paid ₹499. Receipt sent."
                    : "Payment failed. Nothing was charged. Try again."}
            </Text>
            {payState() === "success" ? <MpButton label="Pay again" soft onPress={tryAgain} /> : null}
          </MpCard>

          {/* b) Loan amount */}
          <MpCard title="Loan amount" hint="Drag the knob. You feel a tick at ₹1L, ₹2L, ₹3L and ₹4L.">
            <Text fontSize={32} fontWeight={800} color={c.primary}>
              {loanText()}
            </Text>
            <Stack style={{ width: SLIDER_W, height: TOUCH }}>
              <Column style={{ position: "absolute", top: 18, start: 0, end: 0, height: 8, borderRadius: 4, backgroundColor: c.pillBg }} />
              <Column
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: 18,
                  start: 0,
                  end: 0,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: c.primary,
                  transformOrigin: "left",
                  transform: [{ scaleX: derive(() => (loanX() + TOUCH / 2) / parent.width) }],
                }}
              />
              <Column
                gesture={loan}
                style={{ position: "absolute", top: 0, start: 0, width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", transform: [{ translateX: loan.x }] }}
              >
                <Column style={{ width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: c.white, borderWidth: 3, borderColor: c.primary, elevation: 4 }} />
              </Column>
            </Stack>
            <Row style={{ width: SLIDER_W, justifyContent: "space-between" }}>
              <Text fontSize={12} color={c.muted}>
                ₹10,000
              </Text>
              <Text fontSize={12} color={c.muted}>
                ₹5,00,000
              </Text>
            </Row>
          </MpCard>

          {/* c) Range slider */}
          <MpCard title="Price range" hint="Two knobs. The low knob can push the high one. They never cross.">
            <Text fontSize={22} fontWeight={800} color={c.ink}>
              {rangeText()}
            </Text>
            <Stack style={{ width: SLIDER_W, height: TOUCH }}>
              <Column style={{ position: "absolute", top: 18, start: 0, end: 0, height: 8, borderRadius: 4, backgroundColor: c.pillBg }} />
              <Column
                pointerEvents="none"
                style={{
                  position: "absolute",
                  top: 18,
                  start: 0,
                  width: SLIDER_W,
                  height: 8,
                  backgroundColor: c.primary,
                  transformOrigin: "left",
                  transform: [{ translateX: derive(() => lowX() + TOUCH / 2) }, { scaleX: derive(() => (highN() - lowX()) / SLIDER_W) }],
                }}
              />
              <Column
                gesture={low}
                style={{ position: "absolute", top: 0, start: 0, width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", transform: [{ translateX: low.x }] }}
              >
                <Column style={{ width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: c.white, borderWidth: 3, borderColor: c.primary, elevation: 4 }} />
              </Column>
              <Column
                gesture={high}
                style={{ position: "absolute", top: 0, start: 0, width: TOUCH, height: TOUCH, alignItems: "center", justifyContent: "center", transform: [{ translateX: highX }] }}
              >
                <Column style={{ width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: c.primary, borderWidth: 3, borderColor: c.white, elevation: 4 }} />
              </Column>
            </Stack>
          </MpCard>

          {/* d) Dial */}
          <MpCard title="Daily limit dial" hint="Put a finger on the ring and move it around. The knob points at your finger.">
            <Text fontSize={32} fontWeight={800} color={c.ink}>
              {dialPercent()}%
            </Text>
            <Column style={{ alignItems: "center" }}>
              <Stack style={{ width: DIAL, height: DIAL }}>
                <Column
                  gesture={dial}
                  style={{ position: "absolute", top: 0, start: 0, width: DIAL, height: DIAL, borderRadius: DIAL / 2, backgroundColor: SOFT_BRAND, borderWidth: 2, borderColor: c.border }}
                />
                <Column
                  pointerEvents="none"
                  style={{ position: "absolute", top: 0, start: 0, width: DIAL, height: DIAL, alignItems: "center", transform: [{ rotate: dialAngle }] }}
                >
                  <Column style={{ marginTop: 8, width: 36, height: 36, borderRadius: 18, backgroundColor: c.primary, elevation: 4 }} />
                </Column>
                <Column pointerEvents="none" style={{ position: "absolute", top: 0, start: 0, width: DIAL, height: DIAL, alignItems: "center", justifyContent: "center" }}>
                  <Text fontSize={13} color={c.muted}>
                    Daily limit
                  </Text>
                </Column>
              </Stack>
            </Column>
          </MpCard>
        </Column>
      </Scroll>
    </Column>
  )
}
