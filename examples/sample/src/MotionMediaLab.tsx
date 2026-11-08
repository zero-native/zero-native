// Motion lab 4: media. Built only from the public gestures-and-motion API (docs/gestures-and-motion-v1.md, lab 5 in the
// plan's table: "Media"). It is an example, not framework code.
//   a) zoomable photos in a Carousel (useZoom): pinch around the fingers, drag, fling, double tap; swipe for the next
//   b) a spending chart you can scrub with a finger: a crosshair follows the touch, JS only reads the bar number
//   c) parallax: offer cards in a Carousel whose picture and text move at other speeds than the card, and a stacked deck
//      of cards (the ones behind get smaller and sit lower) that both follow the Carousel's page number
// The pinch, the drag, the zoom springs, the crosshair and the parallax run on the UI thread.
import { Carousel, Column, Image, Pressable, Row, Scroll, Stack, Text } from "@zero-native/ui"
import { clamp, computed, derive, nav, self, signal, useElementMotion, usePan, useZoom } from "@zero-native/core"
import { c } from "./tokens"
import { formatIndian } from "./money"

const PHOTOS = ["https://picsum.photos/id/1060/1200/900", "https://picsum.photos/id/1015/1200/900", "https://picsum.photos/id/1043/1200/900"]
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

function MmZoomPhoto(props: { src: string; onZoomed: (on: boolean) => void; registerReset: (f: () => void) => void }) {
  // One native gesture: pinch around the fingers, drag inside the photo's edges, fling, rubber bands, double tap.
  const zoom = useZoom({
    max: MAX_ZOOM,
    doubleTap: DOUBLE_TAP_ZOOM,
    a11yLabel: "Photo",
    onEnd: (e) => props.onZoomed(e.scale > 1.05),
    onSettle: (e) => props.onZoomed(e.scale > 1.05),
  })
  props.registerReset(() => void zoom.reset())
  return (
    // The gesture on the page box, the transform on the photo inside it: the touch area doesn't move with the zoom.
    <Column gesture={zoom} style={{ flex: 1, overflow: "hidden" }}>
      <Image
        src={props.src}
        loading="shimmer"
        contentScale="cover"
        style={{
          width: "100%",
          height: "100%",
          transform: [{ translateX: zoom.x }, { translateY: zoom.y }, { scale: zoom.scale }],
        }}
      />
    </Column>
  )
}

function MmZoomDemo() {
  const zoomed = signal(false)
  const page = signal(0)
  const resets: (() => void)[] = []
  return (
    <Column style={{ gap: 14, paddingHorizontal: 20 }}>
      <Column style={{ height: 300, borderRadius: 24, overflow: "hidden", backgroundColor: c.pillBg, borderWidth: 1, borderColor: c.border }}>
        {/* Not zoomed, a one-finger swipe turns the page. Zoomed, it drags the photo; at the photo's edge it turns the page. */}
        <Carousel dots onPageChange={(i) => page.set(i)} style={{ flex: 1 }}>
          {PHOTOS.map((src, i) => (
            <MmZoomPhoto key={src} src={src} onZoomed={(on) => zoomed.set(on)} registerReset={(f) => (resets[i] = f)} />
          ))}
        </Carousel>
      </Column>
      <Row style={{ alignItems: "center", gap: 12 }}>
        <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
          {zoomed()
            ? "Drag to look around; at the edge, keep dragging for the next photo. Double-tap to zoom out."
            : "Pinch with two fingers (the spot under your fingers stays put), double-tap to zoom there, or swipe for the next photo."}
        </Text>
        <MmButton label="Reset" soft onPress={() => resets[page()]?.()} />
      </Row>
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

// ---- c) Carousel parallax and a card stack ----------------------------------------------------------------------------

interface MmOffer {
  id: number
  emoji: string
  store: string
  deal: string
  note: string
  tint: string // soft background for the parallax card
  strong: string // bold colour for the deck card
}

const OFFERS: MmOffer[] = [
  { id: 1, emoji: "☕", store: "Chai Point", deal: "20% back", note: "Up to ₹100 on UPI", tint: "#E0E7FF", strong: "#3D26ED" },
  { id: 2, emoji: "🛒", store: "Fresh Basket", deal: "₹50 back", note: "On orders above ₹500", tint: "#DCFCE7", strong: "#0E8A5F" },
  { id: 3, emoji: "🍕", store: "Slice of Italy", deal: "15% back", note: "Dine in or take away", tint: "#FEE2E2", strong: "#E23744" },
  { id: 4, emoji: "🎬", store: "PVR Cinemas", deal: "₹100 back", note: "On two tickets", tint: "#FEF3C7", strong: "#D97706" },
]

const PAR_CARD_H = 190
const DECK_CARD_H = 150
const DECK_H = 210
const DECK_LAST = 3 // the last card's number (OFFERS.length - 1): derive wants a plain number
const DECK_OFFERS = OFFERS.slice().reverse()

function MmParallaxDemo() {
  // The Carousel fills `par.page` (2.5 is half way from card 2 to card 3). Everything below follows it with no JS.
  const par = useElementMotion()
  // The deck has its own invisible Carousel on top: it only gives a swipe, and the cards below follow its page.
  const deck = useElementMotion()

  return (
    <Scroll style={{ flex: 1 }}>
      <Column style={{ gap: 14, paddingBottom: 24 }}>
        <Column style={{ gap: 2, paddingHorizontal: 20 }}>
          <Text fontSize={16} fontWeight={800} color={c.ink}>
            Offers for you
          </Text>
          <Text fontSize={12} color={c.muted}>
            The picture, the text and the card each move at their own speed.
          </Text>
        </Column>

        <Carousel motion={par} itemWidth="82%" style={{ height: PAR_CARD_H, gap: 12, paddingHorizontal: 16 }}>
          {OFFERS.map((o, i) => (
            <Stack key={o.id} style={{ width: "100%", height: PAR_CARD_H, borderRadius: 24, overflow: "hidden", backgroundColor: o.tint }}>
              {/* The picture: it moves slower than the card (it shifts by up to 80 dp the other way). */}
              <Text
                fontSize={112}
                style={{ position: "absolute", top: 18, end: 4, transform: [{ translateX: derive(() => clamp(par.page() - i, -1, 1) * 80) }] }}
              >
                {o.emoji}
              </Text>
              {/* The text: it moves faster than the card (a little the other way). */}
              <Column
                style={{
                  position: "absolute",
                  start: 20,
                  bottom: 18,
                  gap: 2,
                  transform: [{ translateX: derive(() => clamp(par.page() - i, -1, 1) * -36) }],
                }}
              >
                <Text fontSize={13} fontWeight={700} color={c.muted}>
                  {o.store}
                </Text>
                <Text fontSize={30} fontWeight={800} color={c.ink}>
                  {o.deal}
                </Text>
                <Text fontSize={12} color={c.muted}>
                  {o.note}
                </Text>
              </Column>
            </Stack>
          ))}
        </Carousel>

        <Column style={{ gap: 2, paddingHorizontal: 20, paddingTop: 6 }}>
          <Text fontSize={16} fontWeight={800} color={c.ink}>
            Your offer deck
          </Text>
          <Row style={{ alignItems: "center", gap: 6 }}>
            <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
              Swipe the top card away: the next one comes forward.
            </Text>
            <Text fontSize={12} fontWeight={800} color={c.ink}>
              {deck.page.format({ decimals: 2 })}
            </Text>
          </Row>
        </Column>

        <Stack style={{ height: DECK_H }}>
          {/* Drawn from the last card to the first, so card 1 is on top. For a card, `its number - page` says where it is: below 0
              it is going away (it slides left, turns a little and fades), above 0 it waits behind (smaller and lower). */}
          {DECK_OFFERS.map((o, i) => (
            <Column
              key={o.id}
              pointerEvents="none"
              style={{
                position: "absolute",
                top: 0,
                start: 20,
                end: 20,
                height: DECK_CARD_H,
                padding: 20,
                gap: 2,
                borderRadius: 24,
                backgroundColor: o.strong,
                elevation: 6,
                opacity: derive(() => Math.max(0, Math.min(Math.min(1, 1 + (DECK_LAST - i - deck.page())), 4 - (DECK_LAST - i - deck.page())))),
                transform: [
                  { translateX: derive(() => Math.min(DECK_LAST - i - deck.page(), 0) * self.width * 1.15) },
                  { translateY: derive(() => 14 * Math.min(Math.max(DECK_LAST - i - deck.page(), 0), 3)) },
                  { scale: derive(() => 1 - 0.07 * Math.min(Math.max(DECK_LAST - i - deck.page(), 0), 3)) },
                  { rotate: derive(() => Math.min(DECK_LAST - i - deck.page(), 0) * 12) },
                ],
              }}
            >
              <Row style={{ alignItems: "center", gap: 10 }}>
                <Text fontSize={28}>{o.emoji}</Text>
                <Text fontSize={15} fontWeight={700} color={c.white} style={{ flex: 1 }}>
                  {o.store}
                </Text>
              </Row>
              <Text fontSize={32} fontWeight={800} color={c.white} style={{ marginTop: 8 }}>
                {o.deal}
              </Text>
              <Text fontSize={12} color="#E2E8F0">
                {o.note}
              </Text>
            </Column>
          ))}
          {/* The swipe: a see-through Carousel over the cards, one page for each card. It takes the touches. */}
          <Carousel motion={deck} style={{ position: "absolute", top: 0, start: 0, end: 0, height: DECK_H }}>
            {OFFERS.map((o) => (
              <Column key={o.id} accessibilityLabel={"Offer " + o.id + " of " + OFFERS.length + ": " + o.store} style={{ width: "100%", height: DECK_H }} />
            ))}
          </Carousel>
        </Stack>
      </Column>
    </Scroll>
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
          <MmTab label="Parallax" on={tab() === 2} onPress={() => tab.set(2)} />
        </Row>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <MmButton label="Keep JS busy 200 ms" onPress={busyOnce} />
          <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
            {note()}
          </Text>
        </Row>
      </Column>

      {tab() === 0 ? <MmZoomDemo /> : tab() === 1 ? <MmChartDemo /> : <MmParallaxDemo />}
    </Column>
  )
}
