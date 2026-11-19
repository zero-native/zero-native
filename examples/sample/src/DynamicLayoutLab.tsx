// Dynamic Layout Lab: testing dynamic slot-driven layout properties at runtime.
import { Column, Pressable, Row, Scroll, Stack, Text, View } from "@zeronative/ui"
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
