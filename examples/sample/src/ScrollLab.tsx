// Scroll lab (registry 24): RN's snapping, scroll events and ScrollView ref on <Scroll> and <List>. It is an example,
// not framework code.
//   a) a card rail that snaps each card to the centre (snapToInterval + snapToAlignment="center")
//   b) a pager made of a horizontal List (pagingEnabled), with the page number from onMomentumScrollEnd
//   c) a vertical Scroll that stops on section starts (snapToOffsets) with an event log and scrollTo buttons
// The fling and the snap run natively; JS only hears the events it has handlers for.
import { Column, List, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { Dimensions, nav, signal } from "@zero-native/core"
import type { ScrollEvent, ScrollRef } from "@zero-native/ui"
import { c } from "./tokens"

const CARD_W = 240
const CARD_GAP = 12
const CARDS = ["Paytm Mall", "Swiggy", "Zomato", "BigBasket", "Myntra", "Nykaa", "Croma", "Tata Cliq"]
const PAGES = [
  { id: "p1", title: "Pay any shop", tint: "#EEF2FF" },
  { id: "p2", title: "Earn cashback", tint: "#ECFDF5" },
  { id: "p3", title: "Split the bill", tint: "#FFF7ED" },
  { id: "p4", title: "See your savings", tint: "#FDF2F8" },
]
const SECTION_H = 320
const SECTIONS = ["Today", "Yesterday", "This week", "Last week", "Earlier"]

function SlButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} pressScale={0.97} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.pillBg }}>
      <Text fontSize={12} fontWeight={700} color={c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function ScrollLabScreen() {
  const page = signal(0)
  const log = signal<string[]>([])
  const y = signal(0)
  const add = (line: string) => log.set([line, ...log()].slice(0, 6))
  const ref: { current: ScrollRef | null } = { current: null }
  const onScroll = (e: ScrollEvent) => y.set(Math.round(e.nativeEvent.contentOffset.y))
  // A page is the window's width: "100%" in a horizontal list row is the row's own content width (as in RN).
  const pageW = Dimensions.get("window").width
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ alignItems: "center", gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8 }}>
          <Text fontSize={16} color={c.primary}>
            Back
          </Text>
        </Pressable>
        <Text fontSize={18} fontWeight={800} color={c.ink}>
          Scroll snapping and events
        </Text>
      </Row>

      <Text fontSize={13} fontWeight={700} color={c.ink} style={{ paddingHorizontal: 16 }}>
        a) Cards snap to the centre
      </Text>
      <Scroll
        horizontal
        snapToInterval={CARD_W + CARD_GAP}
        snapToAlignment="center"
        decelerationRate="fast"
        style={{ height: 120, flexGrow: 0, paddingHorizontal: 16, gap: CARD_GAP, marginTop: 8 }}
      >
        {CARDS.map((name) => (
          <Column key={name} style={{ width: CARD_W, height: 110, borderRadius: 18, backgroundColor: c.white, borderWidth: 1, borderColor: c.border, padding: 16, justifyContent: "flex-end" }}>
            <Text fontSize={16} fontWeight={800} color={c.ink}>
              {name}
            </Text>
            <Text fontSize={12} color={c.muted}>
              Up to ₹150 cashback
            </Text>
          </Column>
        ))}
      </Scroll>

      <Row style={{ paddingHorizontal: 16, marginTop: 16, alignItems: "center", gap: 8 }}>
        <Text fontSize={13} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          b) A pager (List, pagingEnabled)
        </Text>
        <Text fontSize={13} fontWeight={800} color={c.primary}>
          {`Page ${page() + 1} of ${PAGES.length}`}
        </Text>
      </Row>
      <List
        horizontal
        pagingEnabled
        data={PAGES}
        key={(p) => p.id}
        onMomentumScrollEnd={(e) => page.set(Math.round(e.nativeEvent.contentOffset.x / Math.max(1, e.nativeEvent.layoutMeasurement.width)))}
        style={{ height: 110, flexGrow: 0, marginTop: 8 }}
        row={(p) => (
          <Column style={{ width: pageW, height: 110, paddingHorizontal: 16 }}>
            <Column style={{ flex: 1, borderRadius: 18, backgroundColor: p.tint, padding: 16, justifyContent: "center" }}>
              <Text fontSize={20} fontWeight={800} color={c.ink}>
                {p.title}
              </Text>
            </Column>
          </Column>
        )}
      />

      <Row style={{ paddingHorizontal: 16, marginTop: 16, gap: 8, alignItems: "center" }}>
        <Text fontSize={13} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          {`c) Sections; y = ${y()} dp`}
        </Text>
        <SlButton label="Top" onPress={() => ref.current?.scrollTo({ y: 0 })} />
        <SlButton label="Section 3" onPress={() => ref.current?.scrollTo({ y: SECTION_H * 2 })} />
        <SlButton label="End" onPress={() => ref.current?.scrollToEnd()} />
      </Row>
      <Column style={{ paddingHorizontal: 16, paddingVertical: 6, gap: 2 }}>
        {log().map((line, i) => (
          <Text key={String(i) + line} fontSize={11} color={i === 0 ? c.ink : c.muted}>
            {line}
          </Text>
        ))}
      </Column>
      <Scroll
        ref={ref}
        snapToOffsets={SECTIONS.map((_, i) => i * SECTION_H)}
        snapToEnd={false}
        scrollEventThrottle={100}
        onScroll={onScroll}
        onScrollBeginDrag={(e) => add(`begin drag at ${Math.round(e.nativeEvent.contentOffset.y)}`)}
        onScrollEndDrag={(e) => add(`end drag at ${Math.round(e.nativeEvent.contentOffset.y)}`)}
        onMomentumScrollBegin={(e) => add(`momentum begin, speed ${Math.round(e.nativeEvent.velocity?.y ?? 0)} dp/s`)}
        onMomentumScrollEnd={(e) => add(`momentum end at ${Math.round(e.nativeEvent.contentOffset.y)} of ${Math.round(e.nativeEvent.contentSize.height)}`)}
        style={{ flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 18, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
      >
        {SECTIONS.map((name, i) => (
          <Column key={name} style={{ height: SECTION_H, padding: 16, gap: 8, borderBottomWidth: 1, borderColor: c.border }}>
            <Text fontSize={18} fontWeight={800} color={c.primary}>
              {`${i + 1}. ${name}`}
            </Text>
            <Text fontSize={13} color={c.muted}>
              A fling stops at the start of a section. After the last section it scrolls freely (snapToEnd false).
            </Text>
          </Column>
        ))}
      </Scroll>
    </Column>
  )
}
