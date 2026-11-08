// Motion lab 5: feed. Built only from the public gestures-and-motion API (docs/gestures-and-motion-v1.md, lab "Feed
// screen"). It is an example, not framework code.
//   a) a list where each row swipes left to show Archive / Delete, and a long swipe deletes the row
//   b) a bottom panel with a list inside: drag the list down at its top and the panel moves
// The swipes, the panel and the shadow line run on the UI thread. JS only hears the start and the end.
//
// TODO (not built yet, so not in this lab): a collapsing header with sticky tabs over the List (<List> has no `motion`
// prop, only Scroll does), a pull-to-refresh distance value, and a Sheet progress value (backdrop and header that follow
// the sheet). The plan has them for this lab.
import { Column, List, Pressable, Row, Scroll, Stack, Text } from "@zero-native/ui"
import { derive, interpolate, nav, self, signal, useElementMotion, usePan } from "@zero-native/core"
import { c } from "./tokens"

const DANGER = "#E23744"
const ARCHIVE = "#3D26ED"

const OPEN_X = -144 // the row rests here with both buttons showing
const DELETE_X = -220 // past this, letting go deletes the row
const MAX_X = -300

interface MfItem {
  id: number
  emoji: string
  title: string
  sub: string
  amount: string
  tint: string
}

const ITEMS: MfItem[] = [
  { id: 1, emoji: "☕", title: "Chai Point", sub: "Today, 9:12 am · UPI", amount: "−₹120", tint: "#FEF3C7" },
  { id: 2, emoji: "🛒", title: "Fresh Basket", sub: "Today, 8:40 am · UPI", amount: "−₹1,240", tint: "#DCFCE7" },
  { id: 3, emoji: "💸", title: "Cashback credited", sub: "Yesterday · ZeroBill", amount: "+₹50", tint: "#E0E7FF" },
  { id: 4, emoji: "⛽", title: "Indian Oil Pump", sub: "Yesterday · UPI", amount: "−₹2,000", tint: "#FEE2E2" },
  { id: 5, emoji: "🍛", title: "Punjabi Dhaba", sub: "Mon, 8:05 pm · UPI", amount: "−₹649", tint: "#FFE4D6" },
  { id: 6, emoji: "💊", title: "Apollo Pharmacy", sub: "Mon, 6:30 pm · UPI", amount: "−₹312", tint: "#DCFCE7" },
  { id: 7, emoji: "💸", title: "Refund from Fresh Basket", sub: "Sun · ZeroBill", amount: "+₹180", tint: "#E0E7FF" },
  { id: 8, emoji: "🎬", title: "PVR Cinemas", sub: "Sun, 4:15 pm · UPI", amount: "−₹760", tint: "#F3E8FF" },
  { id: 9, emoji: "🚕", title: "Namma Yatri", sub: "Sat, 10:20 pm · UPI", amount: "−₹210", tint: "#FEF3C7" },
  { id: 10, emoji: "🍕", title: "Slice of Italy", sub: "Sat, 8:50 pm · UPI", amount: "−₹598", tint: "#FEE2E2" },
]

interface MfStore {
  id: number
  emoji: string
  name: string
  far: string
  back: string
}

const STORES: MfStore[] = [
  { id: 1, emoji: "☕", name: "Chai Point", far: "0.3 km", back: "20% back" },
  { id: 2, emoji: "🛒", name: "Fresh Basket", far: "0.6 km", back: "₹50 back on ₹500" },
  { id: 3, emoji: "🍛", name: "Punjabi Dhaba", far: "1.2 km", back: "10% back" },
  { id: 4, emoji: "💊", name: "Apollo Pharmacy", far: "1.4 km", back: "5% back" },
  { id: 5, emoji: "🍕", name: "Slice of Italy", far: "2.0 km", back: "15% back" },
  { id: 6, emoji: "🎬", name: "PVR Cinemas", far: "2.8 km", back: "₹100 back on tickets" },
  { id: 7, emoji: "⛽", name: "Indian Oil Pump", far: "3.1 km", back: "1% back" },
  { id: 8, emoji: "🥘", name: "Paradise Kitchen", far: "3.4 km", back: "12% back" },
  { id: 9, emoji: "👕", name: "Max Fashion", far: "4.0 km", back: "₹200 back on ₹1,500" },
  { id: 10, emoji: "📱", name: "Reliance Digital", far: "4.6 km", back: "3% back" },
  { id: 11, emoji: "🍜", name: "Wok Express", far: "5.0 km", back: "8% back" },
  { id: 12, emoji: "🧁", name: "Cake Walk", far: "5.2 km", back: "10% back" },
]

/** Blocks the JS thread for [ms]. The swipes and the panel must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MfButton(props: { label: string; onPress: () => void; soft?: boolean }) {
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

function MfTab(props: { label: string; on: boolean; onPress: () => void }) {
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

// ---- a) Swipe actions on list rows -------------------------------------------------------------------------------------

function MfRow(props: { item: MfItem; onRemove: (id: number, how: "archive" | "delete") => void }) {
  // True while the row is pulled past DELETE_X: the Delete button says "Release".
  const armed = signal(false)

  const pan = usePan({
    axis: "x",
    bounds: { x: [MAX_X, 0] },
    anchors: [
      { id: "closed", x: 0 },
      { id: "open", x: OPEN_X },
    ],
    // A short pull goes back. A fast flick goes to the other end. Else it goes to the nearest one.
    release: { threshold: { velocity: 500, distance: 36 } },
    cross: [DELETE_X],
    haptic: { cross: "medium", snap: "selection" },
    // Starts only after a sideways move, so the list keeps scrolling up and down.
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    a11yLabel: "Actions for " + props.item.title,
    onCross: (e) => armed.set(!e.forward),
    onEnd: (e) => {
      if ((e.x ?? 0) <= DELETE_X) props.onRemove(props.item.id, "delete")
    },
  })

  return (
    <Stack style={{ backgroundColor: c.white }}>
      {/* Behind the row: the two buttons. */}
      <Row style={{ position: "absolute", top: 0, bottom: 0, end: 0, width: 144 }}>
        <Pressable
          onPress={() => props.onRemove(props.item.id, "archive")}
          style={{ width: 72, alignSelf: "stretch", alignItems: "center", justifyContent: "center", backgroundColor: ARCHIVE }}
          accessibilityLabel={"Archive " + props.item.title}
        >
          <Text fontSize={12} fontWeight={700} color={c.white}>
            Archive
          </Text>
        </Pressable>
        <Pressable
          onPress={() => props.onRemove(props.item.id, "delete")}
          style={{ width: 72, alignSelf: "stretch", alignItems: "center", justifyContent: "center", backgroundColor: DANGER }}
          accessibilityLabel={"Delete " + props.item.title}
        >
          <Text
            fontSize={12}
            fontWeight={700}
            color={c.white}
            // interpolate wants its numbers written in place (-220 is DELETE_X, -144 is OPEN_X).
            style={{ transform: [{ scale: derive(() => interpolate(pan.x(), [-220, -144], [1.25, 1])) }] }}
          >
            {armed() ? "Release" : "Delete"}
          </Text>
        </Pressable>
      </Row>

      {/* The row itself. It is opaque, so the buttons show only when it moves. */}
      <Row
        gesture={pan}
        style={{
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 16,
          paddingVertical: 14,
          backgroundColor: c.white,
          borderBottomWidth: 1,
          borderColor: c.border,
          transform: [{ translateX: pan.x }],
        }}
      >
        <Column style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: props.item.tint }}>
          <Text fontSize={22}>{props.item.emoji}</Text>
        </Column>
        <Column style={{ flex: 1, gap: 2 }}>
          <Text fontSize={15} fontWeight={700} color={c.ink}>
            {props.item.title}
          </Text>
          <Text fontSize={12} color={c.muted}>
            {props.item.sub}
          </Text>
        </Column>
        <Text fontSize={16} fontWeight={800} color={c.ink}>
          {props.item.amount}
        </Text>
      </Row>
    </Stack>
  )
}

function MfRowsDemo() {
  const rows = signal<MfItem[]>(ITEMS)
  const last = signal<{ item: MfItem; at: number } | null>(null)
  const status = signal("Swipe a row left.")

  const remove = (id: number, how: "archive" | "delete") => {
    const list = rows()
    const at = list.findIndex((r) => r.id === id)
    if (at < 0) return
    last.set({ item: list[at], at })
    rows.set(list.filter((r) => r.id !== id))
    status.set((how === "delete" ? "Deleted " : "Archived ") + list[at].title + ".")
  }

  const undo = () => {
    const l = last()
    if (!l) return
    const list = rows().slice()
    list.splice(Math.min(l.at, list.length), 0, l.item)
    rows.set(list)
    last.set(null)
    status.set("Brought back " + l.item.title + ".")
  }

  const restoreAll = () => {
    rows.set(ITEMS)
    last.set(null)
    status.set("All rows are back.")
  }

  return (
    <Column style={{ flex: 1 }}>
      <Row style={{ alignItems: "center", gap: 10, paddingHorizontal: 20, paddingBottom: 10 }}>
        <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
          {status()}
        </Text>
        {last() ? <MfButton label="Undo" soft onPress={undo} /> : null}
        {rows().length < ITEMS.length ? <MfButton label="All back" soft onPress={restoreAll} /> : null}
      </Row>
      <List
        data={rows()}
        key={(r) => r.id}
        itemAnimation="fade"
        style={{ flex: 1 }}
        row={(r) => <MfRow item={r} onRemove={remove} />}
      />
    </Column>
  )
}

// ---- b) Bottom panel with a list inside --------------------------------------------------------------------------------

const PEEK = 150 // how much of the panel shows when it is down

function MfPanelDemo() {
  const inner = useElementMotion()

  const pan = usePan({
    axis: "y",
    bounds: { y: [0, derive(() => self.height - PEEK)] },
    anchors: [
      { id: "expanded", y: 0 },
      { id: "half", y: derive(() => self.height * 0.5) },
      { id: "collapsed", y: derive(() => self.height - PEEK) },
    ],
    release: { project: true },
    // The list inside scrolls first. When it is at its top, a drag down moves the panel.
    withParent: "after-edge",
    haptic: { snap: "selection" },
    a11yLabel: "Stores near you panel",
  })

  // Starts half way up, after the first layout.
  setTimeout(() => {
    void pan.snapTo("half")
  }, 150)

  return (
    <Stack style={{ flex: 1, overflow: "hidden" }}>
      {/* The "map": a coloured area with a few pins. */}
      <Stack style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: "#DCE7F5" }}>
        <Text fontSize={28} style={{ position: "absolute", top: 40, start: 60 }}>
          📍
        </Text>
        <Text fontSize={28} style={{ position: "absolute", top: 90, start: 220 }}>
          📍
        </Text>
        <Text fontSize={28} style={{ position: "absolute", top: 150, start: 120 }}>
          📍
        </Text>
      </Stack>
      {/* The map gets darker as the panel goes up. */}
      <Column
        pointerEvents="none"
        style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: "#0F172A", opacity: pan.progress.map([0, 1], [0.45, 0]) }}
      />
      <Column style={{ position: "absolute", top: 12, start: 16, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: c.white }}>
        <Text fontSize={12} fontWeight={700} color={c.ink}>
          {derive(() => pan.progress() * 100).format({ suffix: "% down" })}
        </Text>
      </Column>

      <Column
        gesture={pan}
        style={{
          position: "absolute",
          top: 56,
          bottom: 0,
          start: 0,
          end: 0,
          borderTopLeftRadius: 28,
          borderTopRightRadius: 28,
          backgroundColor: c.white,
          elevation: 16,
          transform: [{ translateY: pan.y }],
        }}
      >
        <Column style={{ alignItems: "center", paddingTop: 10, paddingBottom: 8 }}>
          <Column style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: c.disabled }} />
        </Column>
        <Row style={{ alignItems: "center", paddingHorizontal: 20, paddingBottom: 12 }}>
          <Text fontSize={18} fontWeight={800} color={c.ink} style={{ flex: 1 }}>
            Stores near you
          </Text>
          <Text fontSize={12} color={c.muted}>
            {STORES.length} stores
          </Text>
        </Row>
        {/* A thin line that shows when the list is scrolled. */}
        <Column style={{ height: 1, backgroundColor: c.border, opacity: inner.scrollY.map([0, 16], [0, 1]) }} />
        <Scroll motion={inner} style={{ flex: 1 }}>
          <Column style={{ paddingBottom: 24 }}>
            {STORES.map((s) => (
              <Row key={s.id} style={{ alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 12 }}>
                <Column style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: c.pillBg }}>
                  <Text fontSize={22}>{s.emoji}</Text>
                </Column>
                <Column style={{ flex: 1, gap: 2 }}>
                  <Text fontSize={15} fontWeight={700} color={c.ink}>
                    {s.name}
                  </Text>
                  <Text fontSize={12} color={c.muted}>
                    {s.far}
                  </Text>
                </Column>
                <Column style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: c.successBg }}>
                  <Text fontSize={12} fontWeight={700} color={c.success}>
                    {s.back}
                  </Text>
                </Column>
              </Row>
            ))}
          </Column>
        </Scroll>
      </Column>
    </Stack>
  )
}

export function MotionFeedLabScreen() {
  const tab = signal(0)
  const note = signal("")
  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms. Swipes and panel kept moving.")
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
          Feed
        </Text>
      </Row>

      <Column style={{ padding: 16, gap: 10 }}>
        <Row style={{ gap: 8 }}>
          <MfTab label="Swipe rows" on={tab() === 0} onPress={() => tab.set(0)} />
          <MfTab label="Bottom panel" on={tab() === 1} onPress={() => tab.set(1)} />
        </Row>
        <Text fontSize={12} color={c.muted}>
          {tab() === 0
            ? "Swipe a row left: Archive and Delete show. Swipe far left and let go: it is deleted."
            : "Drag the panel up or down. Scroll the list; at its top, drag down and the panel follows."}
        </Text>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <MfButton label="Keep JS busy 200 ms" onPress={busyOnce} />
          <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
            {note()}
          </Text>
        </Row>
      </Column>

      {tab() === 0 ? <MfRowsDemo /> : <MfPanelDemo />}
    </Column>
  )
}
