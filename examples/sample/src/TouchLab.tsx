// Touch lab: who takes a tap where Pressables, scrolls and overlays meet (Compose's hit test is the reference: the
// topmost node under the finger, children first, nothing clipped away). Each action writes "status: ..." into
// touch-status and logs "touch-lab ..." (ios/SamplePackage/ZnSampleUITests/TouchLabTests.swift).
// 1. A fixed Pay button under a Scroll of small chips: the chips scrolled out of view (still laid out under the button,
//    clipped) don't take its taps.
// 2. An absolute Pressable over a row of small buttons (a tap-outside backdrop): it takes the tap, not the button under it.
// 3. A card with a horizontal Scroll, a Carousel and a horizontal List inside: a swipe scrolls them and doesn't press
//    the card (onPressOut(true), no onPress); a tap on them presses the card.
// 4. Feedback: a quick tap on a card inside the chips' Scroll shows its ripple and pressScale; a translucent rippleColor
//    is drawn at the ripple's own alpha (24 %), as Android.
import { Box, Carousel, Column, List, Pressable, Row, Scroll, Stack, StyleSheet, Text } from "@zeronative/ui"
import { signal } from "@zeronative/core"
import { c } from "./tokens"

const CHIPS = Array.from({ length: 40 }, (_, i) => i)
const RAIL = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `chip ${i}` }))

export function TouchLabScreen() {
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`touch-lab ${text}`)
    status.set(text)
  }
  const pressOut = (what: string) => (e?: boolean) => console.info(`touch-lab ${what} out ${e ? "cancelled" : "lifted"}`)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg, paddingTop: 8 }}>
      <Text testID="touch-status" fontSize={13} color={c.ink} style={{ paddingHorizontal: 12, paddingBottom: 6 }}>
        {`status: ${status()}`}
      </Text>

      {/* 1: the chips go on past the Scroll's bottom, under Pay. */}
      <Scroll testID="chips" style={{ height: 110, flexGrow: 0 }}>
        <Row style={{ flexWrap: "wrap", gap: 8, padding: 8 }}>
          <Pressable
            testID="quick-card"
            onPress={() => say("quick card")}
            pressScale={0.9}
            rippleColor="rgba(61,38,237,0.1)"
            style={{ width: 120, height: 40, borderRadius: 8, backgroundColor: "#FFFFFF", justifyContent: "center", alignItems: "center" }}
          >
            <Text fontSize={12} color={c.ink}>
              Quick tap me
            </Text>
          </Pressable>
          {CHIPS.map((i) => (
            <Pressable key={String(i)} onPress={() => say(`chip ${i}`)} style={{ width: 60, height: 40, borderRadius: 8, backgroundColor: "#C7D2FE" }} />
          ))}
        </Row>
      </Scroll>
      <Pressable testID="pay" onPress={() => say("pay")} style={{ height: 52, backgroundColor: c.primary, justifyContent: "center", alignItems: "center" }}>
        <Text fontSize={15} fontWeight={700} color={c.white}>
          Pay
        </Text>
      </Pressable>

      {/* 2: OVER is drawn on top of the row of small buttons. */}
      <Stack style={{ height: 52, marginTop: 8 }}>
        <Row gap={8} style={{ padding: 6 }}>
          <Pressable testID="under-0" onPress={() => say("under 0")} style={{ width: 60, height: 40, borderRadius: 8, backgroundColor: "#FCA5A5" }} />
          {[1, 2, 3].map((i) => (
            <Pressable key={String(i)} onPress={() => say(`under ${i}`)} style={{ width: 60, height: 40, borderRadius: 8, backgroundColor: "#FCA5A5" }} />
          ))}
        </Row>
        <Pressable testID="over" onPress={() => say("over")} style={[StyleSheet.absoluteFill, { backgroundColor: "#4F46E544", justifyContent: "center", alignItems: "flex-end", paddingEnd: 12 }]}>
          <Text fontSize={12} color={c.ink}>
            Over (backdrop)
          </Text>
        </Pressable>
      </Stack>

      {/* 3: a card around a horizontal Scroll of plain chips. */}
      <Pressable testID="rail-card" onPress={() => say("rail card")} onPressOut={pressOut("rail card")} style={{ marginTop: 8, padding: 8, gap: 6, backgroundColor: "#FFFFFF" }}>
        <Text fontSize={12} color={c.ink}>
          Card with a chip rail
        </Text>
        <Scroll testID="rail" horizontal style={{ gap: 8, flexGrow: 0 }}>
          {RAIL.map((it) => (
            <Box key={it.id} style={{ width: 90, height: 36, borderRadius: 18, backgroundColor: "#E0E7FF", justifyContent: "center", alignItems: "center" }}>
              <Text fontSize={12} color={c.ink}>
                {it.name}
              </Text>
            </Box>
          ))}
        </Scroll>
      </Pressable>

      {/* 3: a card around a Carousel. */}
      <Pressable testID="carousel-card" onPress={() => say("carousel card")} onPressOut={pressOut("carousel card")} style={{ marginTop: 8, padding: 8, backgroundColor: "#FFFFFF" }}>
        <Carousel testID="touch-carousel" onPageChange={(i) => say(`page ${i}`)} style={{ height: 64 }}>
          {["Page 0", "Page 1", "Page 2"].map((t) => (
            <Column key={t} style={{ flex: 1, borderRadius: 8, backgroundColor: "#DCFCE7", justifyContent: "center", alignItems: "center" }}>
              <Text fontSize={13} fontWeight={600} color={c.ink}>
                {t}
              </Text>
            </Column>
          ))}
        </Carousel>
      </Pressable>

      {/* 3: a card around a horizontal List. */}
      <Pressable testID="list-card" onPress={() => say("list card")} onPressOut={pressOut("list card")} style={{ marginTop: 8, padding: 8, backgroundColor: "#FFFFFF" }}>
        <List
          data={RAIL}
          key={(it) => it.id}
          horizontal
          gap={8}
          style={{ height: 36, flexGrow: 0 }}
          row={(it) => (
            <Column style={{ width: 90, height: 36, borderRadius: 18, backgroundColor: "#FEF3C7", justifyContent: "center", alignItems: "center" }}>
              <Text fontSize={12} color={c.ink}>
                {`row ${it.id}`}
              </Text>
            </Column>
          )}
        />
      </Pressable>
    </Column>
  )
}
