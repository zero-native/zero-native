// Touch lab: who takes a tap where Pressables, scrolls and overlays meet (Compose's hit test is the reference: the
// topmost node under the finger, children first, nothing clipped away). Each action writes "status: ..." into
// touch-status and logs "touch-lab ..." (ios/SamplePackage/ZnSampleUITests/TouchLabTests.swift).
// 1. A fixed Pay button under a Scroll of small chips: the chips scrolled out of view (still laid out under the button,
//    clipped) don't take its taps.
// 2. An absolute Pressable over a row of small buttons (a tap-outside backdrop): it takes the tap, not the button under it.
// 3. A card with a horizontal Scroll, a Carousel and a horizontal List inside: a swipe scrolls them and doesn't press
//    the card (onPressOut(true), no onPress); a tap on them presses the card.
// 4. Feedback: a quick tap on a card inside the chips' Scroll shows its ripple and pressScale; a translucent rippleColor
//    is drawn at the ripple's own alpha (24 %), as Android. "pressed look" shows the highest `pressed` (element motion,
//    0 → 1) it reached: the press look's own state, so a quick tap that showed nothing stays at 0.0.
// The press events of the cards go into touch-press ("<card> in", "<card> out cancelled|lifted", "<card> press",
// "long card long"), the last six; an onPress also sets the status to the card's name.
// Open the other part with --params '{"mode":"more"}':
// 5. A card around a rail that long-presses: onLongPress 0.5 s after the finger went down (not 0.15 s later, when its
//    press began).
// 6. pointerEvents: a "box-only" card around a rail, and a card around a rail inside pointerEvents "none": the card
//    takes every tap (the rail takes none), as Android.
// 7. Plugin views: a card around a Lottie animation (it only draws: the card presses) and around a WebView (it takes
//    the touch: the card doesn't press).
import { Box, Carousel, Column, List, Pressable, Row, Scroll, Stack, StyleSheet, Text } from "@zeronative/ui"
import { effect, signal, useElementMotion } from "@zeronative/core"
import LottieView from "@zeronative/lottie"
import { WebView } from "@zeronative/webview"
import { c } from "./tokens"

const CHIPS = Array.from({ length: 40 }, (_, i) => i)
const RAIL = Array.from({ length: 12 }, (_, i) => ({ id: String(i), name: `chip ${i}` }))

/** The lab's labels and logs. */
function touchLog() {
  const status = signal("ready")
  const trail = signal<string[]>([])
  const note = (text: string) => {
    console.info(`touch-lab ${text}`)
    trail.set([...trail.peek(), text].slice(-6))
  }
  const say = (text: string) => {
    note(text)
    status.set(text)
  }
  // A card's onPressOut and onPress.
  const out = (what: string, cancelled?: boolean) => note(`${what} out ${cancelled ? "cancelled" : "lifted"}`)
  const press = (what: string) => {
    note(`${what} press`)
    status.set(what)
  }
  return { status, trail, note, say, out, press }
}

function Labels(props: { log: ReturnType<typeof touchLog> }) {
  return (
    <>
      <Text testID="touch-status" fontSize={13} color={c.ink} style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
        {`status: ${props.log.status()}`}
      </Text>
      <Text testID="touch-press" fontSize={11} color={c.muted} style={{ paddingHorizontal: 12, paddingBottom: 4 }}>
        {`press: ${props.log.trail().join(", ")}`}
      </Text>
    </>
  )
}

/** A horizontal Scroll of plain chips (no Pressables). */
function Rail(props: { onEnd?: (moved: boolean) => void }) {
  return (
    <Scroll
      horizontal
      onScrollEndDrag={(e) => props.onEnd?.(e.nativeEvent.contentOffset.x > 40)}
      style={{ gap: 8, flexGrow: 0 }}>
      {RAIL.map((it) => (
        <Box key={it.id} style={{ width: 90, height: 36, borderRadius: 18, backgroundColor: "#E0E7FF", justifyContent: "center", alignItems: "center" }}>
          <Text fontSize={12} color={c.ink}>
            {it.name}
          </Text>
        </Box>
      ))}
    </Scroll>
  )
}

export function TouchLabScreen(props: { mode?: string }) {
  if (props.mode === "more") return <TouchLabMore />
  const log = touchLog()
  const say = log.say
  // Where the rail and the list ended a drag (their chips are inside the cards' one VoiceOver element, so a UI test
  // can't see them move).
  const scrolled = signal("none")
  // The quick card's press look: the highest `pressed` it reached.
  const quick = useElementMotion()
  const peak = signal(0)
  effect(() => {
    const v = quick.pressed()
    if (v > peak.peek()) peak.set(v)
  })

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg, paddingTop: 8 }}>
      <Labels log={log} />
      <Row style={{ gap: 12, paddingHorizontal: 12, paddingBottom: 4 }}>
        <Text testID="touch-scroll" fontSize={11} color={c.muted}>
          {`scrolled: ${scrolled()}`}
        </Text>
        <Text testID="touch-look" fontSize={11} color={c.muted}>
          {`pressed look: ${peak().toFixed(1)}`}
        </Text>
      </Row>

      {/* 1: the chips go on past the Scroll's bottom, under Pay. */}
      <Scroll testID="chips" style={{ height: 110, flexGrow: 0 }}>
        <Row style={{ flexWrap: "wrap", gap: 8, padding: 8 }}>
          <Pressable
            testID="quick-card"
            motion={quick}
            onPressIn={() => log.note("quick card in")} onPressOut={(e) => log.out("quick card", e)} onPress={() => log.press("quick card")}
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
      <Pressable testID="rail-card" onPressIn={() => log.note("rail card in")} onPressOut={(e) => log.out("rail card", e)} onPress={() => log.press("rail card")} style={{ marginTop: 8, padding: 8, gap: 6, backgroundColor: "#FFFFFF" }}>
        <Text fontSize={12} color={c.ink}>
          Card with a chip rail
        </Text>
        <Rail onEnd={(m) => scrolled.set(`rail ${m ? "moved" : "still"}`)} />
      </Pressable>

      {/* 3: a card around a Carousel. */}
      <Pressable testID="carousel-card" onPressIn={() => log.note("carousel card in")} onPressOut={(e) => log.out("carousel card", e)} onPress={() => log.press("carousel card")} style={{ marginTop: 8, padding: 8, backgroundColor: "#FFFFFF" }}>
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
      <Pressable testID="list-card" onPressIn={() => log.note("list card in")} onPressOut={(e) => log.out("list card", e)} onPress={() => log.press("list card")} style={{ marginTop: 8, padding: 8, backgroundColor: "#FFFFFF" }}>
        <List
          data={RAIL}
          key={(it) => it.id}
          horizontal
          gap={8}
          onScrollEndDrag={(e) => scrolled.set(`list ${e.nativeEvent.contentOffset.x > 40 ? "moved" : "still"}`)}
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

const WEB = `<html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;font:13px -apple-system;background:#FDE68A"><button onclick="this.textContent='clicked'" style="margin:8px">web button</button></body></html>`

function TouchLabMore() {
  const log = touchLog()
  // A rail that takes no touches must never move.
  const scrolled = signal("none")
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg, paddingTop: 8, gap: 8 }}>
      <Labels log={log} />
      <Text testID="touch-scroll" fontSize={11} color={c.muted} style={{ paddingHorizontal: 12 }}>
        {`scrolled: ${scrolled()}`}
      </Text>

      {/* 5: onLongPress on a card, held on its rail. */}
      <Pressable testID="long-card" onPressIn={() => log.note("long card in")} onPressOut={(e) => log.out("long card", e)} onPress={() => log.press("long card")} onLongPress={() => log.say("long card long")} style={{ padding: 8, gap: 6, backgroundColor: "#FFFFFF" }}>
        <Text fontSize={12} color={c.ink}>
          Long-press card with a rail
        </Text>
        <Rail />
      </Pressable>

      {/* 6: the rail takes no touches. */}
      <Pressable testID="boxonly-card" pointerEvents="box-only" onPressIn={() => log.note("box-only card in")} onPressOut={(e) => log.out("box-only card", e)} onPress={() => log.press("box-only card")} style={{ padding: 8, gap: 6, backgroundColor: "#FFFFFF" }}>
        <Text fontSize={12} color={c.ink}>
          pointerEvents box-only card
        </Text>
        <Rail onEnd={(m) => scrolled.set(`box-only ${m ? "moved" : "still"}`)} />
      </Pressable>
      <Pressable testID="none-card" onPressIn={() => log.note("none card in")} onPressOut={(e) => log.out("none card", e)} onPress={() => log.press("none card")} style={{ padding: 8, gap: 6, backgroundColor: "#FFFFFF" }}>
        <Text fontSize={12} color={c.ink}>
          Card, its rail in pointerEvents none
        </Text>
        <Box pointerEvents="none">
          <Rail onEnd={(m) => scrolled.set(`none ${m ? "moved" : "still"}`)} />
        </Box>
      </Pressable>

      {/* 7: plugin views in cards. */}
      <Row style={{ gap: 8, paddingHorizontal: 8 }}>
        <Pressable testID="lottie-card" onPressIn={() => log.note("lottie card in")} onPressOut={(e) => log.out("lottie card", e)} onPress={() => log.press("lottie card")} style={{ flex: 1, height: 90, padding: 8, backgroundColor: "#FFFFFF" }}>
          <Box style={{ flex: 1 }}>
            <LottieView source="asset:lottie/check.json" autoPlay loop />
          </Box>
        </Pressable>
        <Pressable testID="web-card" onPressIn={() => log.note("web card in")} onPressOut={(e) => log.out("web card", e)} onPress={() => log.press("web card")} style={{ flex: 1, height: 90, padding: 8, backgroundColor: "#FFFFFF" }}>
          <Column style={{ flex: 1 }}>
            <WebView html={WEB} allowedHosts={[]} />
          </Column>
        </Pressable>
      </Row>
    </Column>
  )
}
