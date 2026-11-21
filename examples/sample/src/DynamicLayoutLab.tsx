// Dynamic Layout Lab: testing dynamic slot-driven layout properties at runtime.
import { Box, Carousel, Column, Pressable, Row, Scroll, Stack, Text, View } from "@zeronative/ui"
import { nav, signal } from "@zeronative/core"
import { c } from "./tokens"

function DataCard(props: { loading: boolean; error: boolean; data: { items: number[] } | null }) {
  if (props.loading) {
    return (
      <Column style={{ padding: 12, backgroundColor: "#FEF3C7", borderRadius: 8, alignItems: "center" }}>
        <Text fontSize={13} color="#92400E" fontWeight={600}>Loading card data...</Text>
      </Column>
    )
  }
  if (props.error) {
    return (
      <Column style={{ padding: 12, backgroundColor: "#FEE2E2", borderRadius: 8, alignItems: "center" }}>
        <Text fontSize={13} color="#991B1B" fontWeight={600}>Failed to load data!</Text>
      </Column>
    )
  }
  // The tail runs ONLY when !loading && !error - data is non-null here!
  // In a plain ternary, this would evaluate data.items while loading (null) and crash!
  const d = props.data!
  const sum = d.items.reduce((a, b) => a + b, 0)
  return (
    <Column style={{ padding: 12, backgroundColor: "#ECFDF5", borderRadius: 8, gap: 4 }}>
      <Text fontSize={13} color="#065F46" fontWeight={700}>Data Loaded Safely (Tail Component)</Text>
      <Text fontSize={12} color="#047857">Items: {d.items.join(", ")}</Text>
      <Text fontSize={12} color="#047857" fontWeight={600}>Total sum: {sum}</Text>
    </Column>
  )
}

export function DynamicLayoutLabScreen() {
  const expanded = signal(false)
  const animWidth = signal(40)
  const isAnimating = signal(false)
  const isVisible = signal(true)
  const pctIndex = signal(0)
  const pcts: Array<"33%" | "50%" | "75%" | "100%"> = ["33%", "50%", "75%", "100%"]

  const cardLoading = signal(true)
  const cardError = signal(false)
  const cardData = signal<{ items: number[] } | null>(null)

  let animTimer: any = null

  const toggleAnimate = () => {
    if (isAnimating()) {
      isAnimating.set(false)
      if (animTimer) clearInterval(animTimer)
      return
    }
    isAnimating.set(true)
    let forward = true
    let current = animWidth()
    animTimer = setInterval(() => {
      if (!isAnimating()) {
        clearInterval(animTimer)
        return
      }
      if (forward) {
        current += 10
        if (current >= 300) {
          current = 300
          forward = false
        }
      } else {
        current -= 10
        if (current <= 40) {
          current = 40
          forward = true
        }
      }
      animWidth.set(current)
    }, 32)
  }

  // Section 7: one toggle for many values, and a dot moved by a timer.
  const wideAll = signal(false)
  const dotX = signal(0)
  const dotMoving = signal(false)
  let dotTimer: any = null
  const toggleDot = () => {
    if (dotMoving()) {
      dotMoving.set(false)
      if (dotTimer) clearInterval(dotTimer)
      return
    }
    dotMoving.set(true)
    let step = 6
    dotTimer = setInterval(() => {
      if (!dotMoving()) {
        clearInterval(dotTimer)
        return
      }
      let x = dotX() + step
      if (x >= 240 || x <= 0) {
        step = -step
        x = Math.max(0, Math.min(240, x))
      }
      dotX.set(x)
    }, 32)
  }

  const togglePct = () => {
    pctIndex.set((pctIndex() + 1) % pcts.length)
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
          Dynamic Layout Lab
        </Text>
      </Row>

      <Scroll style={{ flex: 1 }}>
        <Column style={{ padding: 16, gap: 16 }}>
          {/* Section 1: Static vs Dynamic comparison */}
          <Column style={{ padding: 14, backgroundColor: c.white, borderRadius: 12, borderWidth: 1, borderColor: c.border, gap: 10 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              1. Static vs Dynamic Dimensions
            </Text>
            <Text fontSize={12} color={c.muted}>
              Compare fixed static box with dynamic reactive box.
            </Text>
            <Row style={{ gap: 12, alignItems: "center" }}>
              <Column style={{ width: 100, height: 60, backgroundColor: "#E0E7FF", borderRadius: 8, padding: 8, justifyContent: "center" }}>
                <Text fontSize={11} fontWeight={600} color="#3730A3">Static 100x60</Text>
              </Column>
              <Column
                style={{
                  width: expanded() ? 160 : 100,
                  height: expanded() ? 80 : 60,
                  backgroundColor: expanded() ? "#DCFCE7" : "#FEF3C7",
                  borderRadius: expanded() ? 16 : 8,
                  padding: expanded() ? 12 : 8,
                  justifyContent: "center",
                }}
              >
                <Text fontSize={expanded() ? 13 : 11} fontWeight={600} color={expanded() ? "#166534" : "#92400E"}>
                  {expanded() ? "Dynamic 160x80" : "Dynamic 100x60"}
                </Text>
              </Column>
            </Row>
            <Pressable
              onPress={() => expanded.set(!expanded())}
              style={{ backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, alignSelf: "flex-start" }}
            >
              <Text fontSize={13} fontWeight={600} color={c.white}>
                {expanded() ? "Shrink Box" : "Expand Box"}
              </Text>
            </Pressable>
          </Column>

          {/* Section 2: Frame-driven animated width */}
          <Column style={{ padding: 14, backgroundColor: c.white, borderRadius: 12, borderWidth: 1, borderColor: c.border, gap: 10 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              2. Animated Width (40 to 300)
            </Text>
            <Text fontSize={12} color={c.muted}>
              Measures in layout pass with zero recompositions of the node.
            </Text>
            <Column style={{ height: 36, backgroundColor: "#F1F5F9", borderRadius: 8, overflow: "hidden" }}>
              <Column
                style={{
                  width: animWidth(),
                  height: 36,
                  backgroundColor: "#6366F1",
                  borderRadius: 8,
                  justifyContent: "center",
                  paddingHorizontal: 8,
                }}
              >
                <Text fontSize={11} fontWeight={700} color={c.white}>
                  {animWidth()} dp
                </Text>
              </Column>
            </Column>
            <Pressable
              onPress={toggleAnimate}
              style={{ backgroundColor: isAnimating() ? "#EF4444" : c.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, alignSelf: "flex-start" }}
            >
              <Text fontSize={13} fontWeight={600} color={c.white}>
                {isAnimating() ? "Stop Animation" : "Start Animation (40–300)"}
              </Text>
            </Pressable>
          </Column>

          {/* Section 3: Percentage widths */}
          <Column style={{ padding: 14, backgroundColor: c.white, borderRadius: 12, borderWidth: 1, borderColor: c.border, gap: 10 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              3. Percentage Widths in Parent
            </Text>
            <Text fontSize={12} color={c.muted}>
              Resolves relative to bounded parent constraint. Current: {pcts[pctIndex()]}
            </Text>
            <Column style={{ width: 280, height: 32, backgroundColor: "#F3F4F6", borderRadius: 6, padding: 2 }}>
              <Column
                style={{
                  width: pcts[pctIndex()],
                  height: 28,
                  backgroundColor: "#059669",
                  borderRadius: 4,
                  justifyContent: "center",
                  paddingHorizontal: 6,
                }}
              >
                <Text fontSize={11} fontWeight={700} color={c.white}>
                  {pcts[pctIndex()]} of 280dp
                </Text>
              </Column>
            </Column>
            <Pressable
              onPress={togglePct}
              style={{ backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, alignSelf: "flex-start" }}
            >
              <Text fontSize={13} fontWeight={600} color={c.white}>
                Cycle Width %
              </Text>
            </Pressable>
          </Column>

          {/* Section 4: Display none vs flex */}
          <Column style={{ padding: 14, backgroundColor: c.white, borderRadius: 12, borderWidth: 1, borderColor: c.border, gap: 10 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              4. Display: "none" vs "flex"
            </Text>
            <Text fontSize={12} color={c.muted}>
              display: "none" collapses element to 0x0 without placing it.
            </Text>
            <Row style={{ gap: 8, alignItems: "center" }}>
              <Column style={{ width: 60, height: 40, backgroundColor: "#CBD5E1", borderRadius: 6, justifyContent: "center", alignItems: "center" }}>
                <Text fontSize={11} color={c.ink}>Before</Text>
              </Column>
              <Column
                style={{
                  width: 80,
                  height: 40,
                  backgroundColor: "#F43F5E",
                  borderRadius: 6,
                  justifyContent: "center",
                  alignItems: "center",
                  display: isVisible() ? "flex" : "none",
                }}
              >
                <Text fontSize={11} fontWeight={700} color={c.white}>Target</Text>
              </Column>
              <Column style={{ width: 60, height: 40, backgroundColor: "#CBD5E1", borderRadius: 6, justifyContent: "center", alignItems: "center" }}>
                <Text fontSize={11} color={c.ink}>After</Text>
              </Column>
            </Row>
            <Pressable
              onPress={() => isVisible.set(!isVisible())}
              style={{ backgroundColor: isVisible() ? "#E11D48" : "#10B981", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, alignSelf: "flex-start" }}
            >
              <Text fontSize={13} fontWeight={600} color={c.white}>
                {isVisible() ? 'Set display: "none"' : 'Set display: "flex"'}
              </Text>
            </Pressable>
          </Column>

          {/* Section 5: Dynamic typography & corner radii */}
          <Column style={{ padding: 14, backgroundColor: c.white, borderRadius: 12, borderWidth: 1, borderColor: c.border, gap: 10 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              5. Dynamic Typography & Corner Radii
            </Text>
            <Column
              style={{
                borderRadius: expanded() ? 24 : 4,
                backgroundColor: "#F8FAFC",
                borderWidth: 1,
                borderColor: "#E2E8F0",
                padding: 12,
              }}
            >
              <Text
                style={{
                  fontSize: expanded() ? 18 : 12,
                  lineHeight: expanded() ? 26 : 16,
                  color: c.ink,
                  fontWeight: 600,
                }}
              >
                {expanded() ? "Large 18sp font with 24dp corners" : "Small 12sp font with 4dp corners"}
              </Text>
            </Column>
          </Column>

          {/* Section 7: every other layout value from a signal (registry 23), one toggle; the dot moves on a timer. */}
          <Column style={{ padding: 14, backgroundColor: c.white, borderRadius: 12, borderWidth: 1, borderColor: c.border, gap: 10 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              7. More Values from a Signal
            </Text>
            <Text fontSize={12} color={c.muted}>
              {wideAll() ? "Now: wide (min 160, ratio 2, gap 24, rowGap 16, flex 1:3, corner 24, spacing 4)" : "Now: narrow (max 90, ratio 1, gap 4, rowGap 4, flex 1:1, corner 0, spacing 0)"}
            </Text>
            {/* minWidth / maxWidth on a pill that hugs its text. */}
            <Row style={{ gap: 8, alignItems: "center" }}>
              <Text
                testID="dl7-pill"
                fontSize={12}
                color={c.white}
                style={{ backgroundColor: "#7C3AED", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, minWidth: wideAll() ? 160 : 0, maxWidth: wideAll() ? 400 : 90 }}
              >
                Pill with a long label that wraps when narrow
              </Text>
            </Row>
            {/* aspectRatio on a box stretched to the card's width: 1 is square, 2 half as tall. */}
            <Column testID="dl7-ratio" style={{ aspectRatio: wideAll() ? 2 : 1, maxHeight: 160, backgroundColor: "#DBEAFE", borderRadius: 8, justifyContent: "center", alignItems: "center" }}>
              <Text fontSize={11} color="#1E3A8A">aspectRatio {wideAll() ? "2" : "1"}</Text>
            </Column>
            {/* aspectRatio with a max on the side that is given: maxWidth caps the stretched width first, so the
                height is half of the cap (120 x 60, then 200 x 100), not half of the card. */}
            <Column testID="dl7-ratio-maxw" style={{ maxWidth: wideAll() ? 200 : 120, aspectRatio: 2, backgroundColor: "#FDE68A", borderRadius: 8, justifyContent: "center", alignItems: "center" }}>
              <Text fontSize={11} color="#78350F">maxWidth {wideAll() ? "200" : "120"}, ratio 2</Text>
            </Column>
            {/* A set width with aspectRatio and maxHeight: the derived height stops at the max (120 x 60, then 120 x 80). */}
            <Column testID="dl7-ratio-w" style={{ width: 120, aspectRatio: wideAll() ? 1 : 2, maxHeight: 80, backgroundColor: "#FBCFE8", borderRadius: 8, justifyContent: "center", alignItems: "center" }}>
              <Text fontSize={11} color="#831843">width 120, ratio {wideAll() ? "1" : "2"}</Text>
            </Column>
            {/* Row gap. */}
            <Row testID="dl7-gap" style={{ gap: wideAll() ? 24 : 4 }}>
              {[1, 2, 3, 4].map((i) => (
                <Box key={i} style={{ width: 32, height: 24, backgroundColor: "#F59E0B", borderRadius: 4 }} />
              ))}
            </Row>
            {/* flexWrap rowGap (the gap between lines). */}
            <Row testID="dl7-wrap" style={{ flexWrap: "wrap", gap: 6, rowGap: wideAll() ? 16 : 4 }}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
                <Box key={i} style={{ width: 48, height: 20, backgroundColor: "#10B981", borderRadius: 4 }} />
              ))}
            </Row>
            {/* Two flex children 1:1 or 1:3. */}
            <Row testID="dl7-flex" style={{ gap: 4, height: 28 }}>
              <Box style={{ flex: 1, height: 28, backgroundColor: "#6366F1", borderRadius: 4 }} />
              <Box style={{ flex: wideAll() ? 3 : 1, height: 28, backgroundColor: "#A5B4FC", borderRadius: 4 }} />
            </Row>
            {/* An absolute dot whose start moves on a timer (the Stack never changes size); top / bottom toggle. */}
            <Stack testID="dl7-track" style={{ height: 48, backgroundColor: "#F1F5F9", borderRadius: 8 }}>
              <Box
                style={{
                  position: "absolute",
                  start: dotX(),
                  top: wideAll() ? undefined : 4,
                  bottom: wideAll() ? 4 : undefined,
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  backgroundColor: "#E11D48",
                }}
              />
            </Stack>
            {/* One corner from a signal (a written corner keeps its own value), and letterSpacing. */}
            <Row style={{ gap: 12, alignItems: "center" }}>
              <Box testID="dl7-corner" style={{ width: 64, height: 48, backgroundColor: "#0EA5E9", borderRadius: 4, borderTopStartRadius: wideAll() ? 24 : 0, borderBottomEndRadius: 12 }} />
              <Text testID="dl7-spacing" fontSize={14} color={c.ink} style={{ letterSpacing: wideAll() ? 4 : 0 }}>
                Spaced letters
              </Text>
            </Row>
            {/* display: "none" written at build time: no room and no gap between A and B. */}
            <Row testID="dl7-none" style={{ gap: 8 }}>
              <Box style={{ width: 40, height: 24, backgroundColor: "#CBD5E1", borderRadius: 4 }} />
              <Box style={{ width: 40, height: 24, backgroundColor: "#F43F5E", display: "none" }} />
              <Box style={{ width: 40, height: 24, backgroundColor: "#CBD5E1", borderRadius: 4 }} />
            </Row>
            <Row style={{ gap: 8 }}>
              <Pressable
                onPress={() => wideAll.set(!wideAll())}
                style={{ backgroundColor: c.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }}
              >
                <Text fontSize={13} fontWeight={600} color={c.white}>
                  {wideAll() ? "Narrow all" : "Widen all"}
                </Text>
              </Pressable>
              <Pressable
                onPress={toggleDot}
                style={{ backgroundColor: dotMoving() ? "#EF4444" : c.primary, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 }}
              >
                <Text fontSize={13} fontWeight={600} color={c.white}>
                  {dotMoving() ? "Stop dot" : "Move dot"}
                </Text>
              </Pressable>
            </Row>
          </Column>

          {/* Section 8: a Carousel of plain pages (a background and a Text, nothing tappable) that moves on its own
              every 2 s. A touch on a page pauses it for 3 s: the page has no Pressable to take the touch. */}
          <Column style={{ padding: 14, backgroundColor: c.white, borderRadius: 12, borderWidth: 1, borderColor: c.border, gap: 10 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              8. Carousel of Plain Pages
            </Text>
            <Text fontSize={12} color={c.muted}>
              Moves every 2 s; touching a page pauses it for 3 s.
            </Text>
            <Carousel testID="dl8-carousel" autoAdvance={2000} dots onPageChange={(i) => console.info(`dl8: page ${i}`)} style={{ gap: 8 }}>
              {["#FEE2E2", "#DCFCE7", "#DBEAFE"].map((bg, i) => (
                <Column key={bg} style={{ height: 80, backgroundColor: bg, borderRadius: 10, justifyContent: "center", alignItems: "center" }}>
                  <Text fontSize={14} color={c.ink}>Page {i + 1}</Text>
                </Column>
              ))}
            </Carousel>
          </Column>

          {/* Section 6: Early Returns Component (H2) */}
          <Column style={{ padding: 14, backgroundColor: c.white, borderRadius: 12, borderWidth: 1, borderColor: c.border, gap: 10 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              6. Early Returns in Components (H2)
            </Text>
            <Text fontSize={12} color={c.muted}>
              Top-level early returns compiled into branch components. Tail statements using data() execute only when branches are resolved, avoiding crashes on null data.
            </Text>
            <DataCard loading={cardLoading()} error={cardError()} data={cardData()} />
            <Row style={{ gap: 8 }}>
              <Pressable
                onPress={() => {
                  const next = !cardLoading()
                  if (!next && !cardData()) {
                    cardData.set({ items: [12, 28, 45, 15] })
                  }
                  cardLoading.set(next)
                }}
                style={{ backgroundColor: c.primary, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}
              >
                <Text fontSize={12} fontWeight={600} color={c.white}>
                  {cardLoading() ? "Resolve Loading" : "Set Loading"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => cardError.set(!cardError())}
                style={{ backgroundColor: cardError() ? "#10B981" : "#EF4444", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 }}
              >
                <Text fontSize={12} fontWeight={600} color={c.white}>
                  {cardError() ? "Clear Error" : "Trigger Error"}
                </Text>
              </Pressable>
            </Row>
          </Column>
        </Column>
      </Scroll>
    </Column>
  )
}
