// Motion lab 8: screens. Built only from the public gestures-and-motion API (docs/gestures-and-motion-v1.md, lab
// "Screens"; guide: docs/motion.md §6, §7, §11). It is an example, not framework code. Two screens live in this file:
// the lab (motionScreensLab) and the store page it opens (motionScreensDetail).
//   a) Shared image: a grid of stores. Tap one: its photo flies to the top of the next screen. Back, and the Android
//      back gesture, play it backwards with your finger.
//   b) Reorder: long press a row, drag it, drop it (the list scrolls at its edges)
//   c) Drop zones: drag a chip onto "Keep" or "Archive"
// The flight, the drag and the zone check run on the UI thread. JS only hears the drop.
import { Column, Image, List, Pressable, Row, Scroll, Stack, Text } from "@zero-native/ui"
import { insets, nav, signal, usePan, useElementMotion, type ElementMotion } from "@zero-native/core"
import { c } from "./tokens"

/** Blocks the JS thread for [ms]. Everything here must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MscButton(props: { label: string; onPress: () => void; soft?: boolean }) {
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

function MscTab(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      style={{ flex: 1, paddingVertical: 10, borderRadius: 12, alignItems: "center", backgroundColor: props.on ? c.primary : c.pillBg }}
    >
      <Text fontSize={12} fontWeight={700} color={props.on ? c.white : c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

// ---- The stores (used by the grid and by the store page) ----------------------------------------------------------------

interface MscStore {
  id: string
  name: string
  kind: string
  far: string
  rating: string
  back: string
  img: string
  offers: string[]
}

// The same photo URL on both screens, so the flight carries a picture that is already loaded.
const MSC_STORES: MscStore[] = [
  { id: "chai", name: "Chai Point", kind: "Cafe · Tea", far: "0.3 km", rating: "4.5", back: "20% back", img: "https://picsum.photos/id/1060/600/600", offers: ["20% cashback up to ₹100", "Free cookie on ₹300"] },
  { id: "basket", name: "Fresh Basket", kind: "Grocery", far: "0.6 km", rating: "4.3", back: "₹50 back on ₹500", img: "https://picsum.photos/id/1080/600/600", offers: ["₹50 back on ₹500", "Free delivery over ₹399"] },
  { id: "dhaba", name: "Punjabi Dhaba", kind: "North Indian", far: "1.2 km", rating: "4.6", back: "10% back", img: "https://picsum.photos/id/292/600/600", offers: ["10% cashback up to ₹80", "Thali combo at ₹249"] },
  { id: "pharma", name: "Apollo Pharmacy", kind: "Health", far: "1.4 km", rating: "4.4", back: "5% back", img: "https://picsum.photos/id/312/600/600", offers: ["5% cashback on all bills", "Free BP check"] },
  { id: "pizza", name: "Slice of Italy", kind: "Pizza · Pasta", far: "2.0 km", rating: "4.2", back: "15% back", img: "https://picsum.photos/id/429/600/600", offers: ["15% cashback up to ₹150", "Garlic bread on ₹499"] },
  { id: "cakes", name: "Cake Walk", kind: "Bakery", far: "5.2 km", rating: "4.7", back: "10% back", img: "https://picsum.photos/id/674/600/600", offers: ["10% cashback up to ₹100", "Eggless cakes on request"] },
]
const MSC_ROWS: MscStore[][] = [MSC_STORES.slice(0, 2), MSC_STORES.slice(2, 4), MSC_STORES.slice(4, 6)]

// ---- a) The grid -------------------------------------------------------------------------------------------------------------

function MscStoreCard(props: { s: MscStore }) {
  return (
    <Pressable
      onPress={() => nav.push("motionScreensDetail", { storeId: props.s.id })}
      pressScale={0.98}
      accessibilityLabel={props.s.name + ", " + props.s.back}
      style={{ flex: 1, borderRadius: 20, overflow: "hidden", backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
    >
      {/* The tag is the same on the store page, so the photo moves between the two. */}
      <Image sharedTag={"store-" + props.s.id} src={props.s.img} loading="shimmer" contentScale="cover" style={{ width: "100%", height: 130 }} />
      <Column style={{ padding: 12, gap: 4 }}>
        <Text fontSize={15} fontWeight={800} color={c.ink} numberOfLines={1}>
          {props.s.name}
        </Text>
        <Text fontSize={12} color={c.muted}>
          {props.s.kind + " · " + props.s.far}
        </Text>
        {/* A box is not an image: it moves its place and cross-fades. */}
        <Column sharedTag={"store-chip-" + props.s.id} style={{ alignSelf: "flex-start", marginTop: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: c.successBg }}>
          <Text fontSize={11} fontWeight={700} color={c.success}>
            {props.s.back}
          </Text>
        </Column>
      </Column>
    </Pressable>
  )
}

function MscGridDemo() {
  return (
    <Scroll style={{ flex: 1 }}>
      <Column style={{ paddingHorizontal: 16, paddingBottom: 28, gap: 12 }}>
        {MSC_ROWS.map((pair, i) => (
          <Row key={i} style={{ gap: 12 }}>
            {pair.map((s) => (
              <MscStoreCard key={s.id} s={s} />
            ))}
          </Row>
        ))}
      </Column>
    </Scroll>
  )
}

// ---- b) Reorder --------------------------------------------------------------------------------------------------------------

interface MscPref {
  id: number
  emoji: string
  name: string
  back: string
}

const PREFS: MscPref[] = [
  { id: 1, emoji: "☕", name: "Chai Point", back: "20% back" },
  { id: 2, emoji: "🛒", name: "Fresh Basket", back: "₹50 back" },
  { id: 3, emoji: "🍛", name: "Punjabi Dhaba", back: "10% back" },
  { id: 4, emoji: "💊", name: "Apollo Pharmacy", back: "5% back" },
  { id: 5, emoji: "🍕", name: "Slice of Italy", back: "15% back" },
  { id: 6, emoji: "🎬", name: "PVR Cinemas", back: "₹100 back" },
  { id: 7, emoji: "⛽", name: "Indian Oil Pump", back: "1% back" },
  { id: 8, emoji: "🥘", name: "Paradise Kitchen", back: "12% back" },
  { id: 9, emoji: "👕", name: "Max Fashion", back: "₹200 back" },
  { id: 10, emoji: "📱", name: "Reliance Digital", back: "3% back" },
  { id: 11, emoji: "🍜", name: "Wok Express", back: "8% back" },
  { id: 12, emoji: "🧁", name: "Cake Walk", back: "10% back" },
  { id: 13, emoji: "🚕", name: "Namma Yatri", back: "₹20 back" },
  { id: 14, emoji: "📚", name: "Bookworm", back: "10% back" },
]

function MscPrefRow(props: { p: MscPref; rank: number }) {
  return (
    <Row style={{ alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
      <Text fontSize={13} fontWeight={800} color={c.muted} style={{ width: 22 }}>
        {props.rank}
      </Text>
      <Column style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: c.pillBg }}>
        <Text fontSize={20}>{props.p.emoji}</Text>
      </Column>
      <Text fontSize={15} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
        {props.p.name}
      </Text>
      <Column style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: c.successBg }}>
        <Text fontSize={11} fontWeight={700} color={c.success}>
          {props.p.back}
        </Text>
      </Column>
      <Text fontSize={18} color={c.disabled}>
        ≡
      </Text>
    </Row>
  )
}

function MscReorderDemo() {
  const items = signal<MscPref[]>(PREFS)
  const last = signal("Long press a row, then drag it.")

  const move = (from: number, to: number) => {
    const list = items().slice()
    const [hit] = list.splice(from, 1)
    if (!hit) return
    list.splice(to, 0, hit)
    items.set(list)
    last.set(hit.name + " moved from " + (from + 1) + " to " + (to + 1) + ".")
  }

  return (
    <Column style={{ flex: 1 }}>
      <Row style={{ alignItems: "center", gap: 10, paddingHorizontal: 20, paddingBottom: 10 }}>
        <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
          {last()}
        </Text>
        <MscButton
          label="Reset"
          soft
          onPress={() => {
            items.set(PREFS)
            last.set("Order reset.")
          }}
        />
      </Row>
      <List data={items()} key={(p) => p.id} reorderable onReorder={move} style={{ flex: 1 }} row={(p, i) => <MscPrefRow p={p} rank={i + 1} />} />
    </Column>
  )
}

// ---- c) Drop zones ------------------------------------------------------------------------------------------------------------

interface MscChipData {
  id: number
  emoji: string
  title: string
}

const CHIPS: MscChipData[] = [
  { id: 0, emoji: "🎟️", title: "Chai Point offer" },
  { id: 1, emoji: "🧾", title: "Bill reminder ₹1,240" },
  { id: 2, emoji: "💸", title: "Cashback ₹50" },
  { id: 3, emoji: "🛒", title: "Fresh Basket receipt" },
]

function MscChip(props: {
  chip: MscChipData
  keep: ElementMotion
  archive: ElementMotion
  home: boolean
  onOver: (zone: number | null) => void
  onDrop: (zone: number) => void
}) {
  // The chip goes where the finger takes it. Let go on a zone: it is taken in. Let go anywhere else: it springs home
  // (the one anchor).
  const pan = usePan({
    axis: "xy",
    anchors: [{ id: "home", x: 0, y: 0 }],
    dropZones: [props.keep, props.archive],
    haptic: { start: "light", snap: "selection" },
    a11yLabel: "Move " + props.chip.title + " to Keep or Archive",
    onZone: (e) => props.onOver(e.zone),
    onEnd: (e) => {
      props.onOver(null)
      if (e.zone !== null && e.zone !== undefined) props.onDrop(e.zone)
    },
  })

  return (
    <Row
      gesture={pan}
      style={{
        display: props.home ? "flex" : "none",
        alignItems: "center",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        borderRadius: 16,
        backgroundColor: c.white,
        borderWidth: 1,
        borderColor: c.border,
        elevation: 4,
        transform: [{ translateX: pan.x }, { translateY: pan.y }],
      }}
    >
      <Text fontSize={18}>{props.chip.emoji}</Text>
      <Text fontSize={13} fontWeight={700} color={c.ink} numberOfLines={1} style={{ flex: 1 }}>
        {props.chip.title}
      </Text>
    </Row>
  )
}

function MscZone(props: { title: string; sub: string; on: boolean; tone: string; toneBg: string; items: string[] }) {
  return (
    <Column
      style={{
        flex: 1,
        minHeight: 170,
        padding: 12,
        gap: 6,
        borderRadius: 20,
        borderWidth: 2,
        borderStyle: "dashed",
        borderColor: props.on ? props.tone : c.disabled,
        backgroundColor: props.on ? props.toneBg : c.white,
      }}
    >
      <Text fontSize={16} fontWeight={800} color={props.tone}>
        {props.title}
      </Text>
      <Text fontSize={11} color={c.muted}>
        {props.sub}
      </Text>
      {props.items.map((t) => (
        <Text key={t} fontSize={12} color={c.ink} numberOfLines={1}>
          {t}
        </Text>
      ))}
    </Column>
  )
}

function MscDropDemo() {
  const keepBox = useElementMotion()
  const archiveBox = useElementMotion()
  // Where each chip is now: -1 in the tray, 0 in Keep, 1 in Archive.
  const where = signal<number[]>([-1, -1, -1, -1])
  const over = signal<number>(-1)

  const put = (id: number, zone: number) => {
    const w = where().slice()
    w[id] = zone
    where.set(w)
  }
  const inZone = (zone: number) => CHIPS.filter((ch) => where()[ch.id] === zone).map((ch) => ch.emoji + " " + ch.title)

  return (
    <Column style={{ flex: 1, marginHorizontal: 16, marginBottom: 16, gap: 14 }}>
      {/* The tray is above the zones in the draw order, so a dragged chip passes over them. */}
      <Column style={{ zIndex: 2, gap: 8 }}>
        {CHIPS.map((ch) => (
          <MscChip key={ch.id} chip={ch} keep={keepBox} archive={archiveBox} home={where()[ch.id] === -1} onOver={(z) => over.set(z === null ? -1 : z)} onDrop={(z) => put(ch.id, z)} />
        ))}
      </Column>
      <Row style={{ gap: 12 }}>
        <Column motion={keepBox} style={{ flex: 1 }}>
          <MscZone title="Keep" sub="Drop here to keep" on={over() === 0} tone={c.success} toneBg={c.successBg} items={inZone(0)} />
        </Column>
        <Column motion={archiveBox} style={{ flex: 1 }}>
          <MscZone title="Archive" sub="Drop here to archive" on={over() === 1} tone={c.primary} toneBg="#E0E7FF" items={inZone(1)} />
        </Column>
      </Row>
      <MscButton label="Bring all back" soft onPress={() => where.set([-1, -1, -1, -1])} />
    </Column>
  )
}

// ---- The lab screen ----------------------------------------------------------------------------------------------------------

export function MotionScreensLabScreen() {
  const tab = signal(0)
  const note = signal("")
  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms. Drags and flights kept moving.")
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
          Screens
        </Text>
      </Row>

      <Column style={{ padding: 16, gap: 10 }}>
        <Row style={{ gap: 6 }}>
          <MscTab label="Shared photo" on={tab() === 0} onPress={() => tab.set(0)} />
          <MscTab label="Reorder" on={tab() === 1} onPress={() => tab.set(1)} />
          <MscTab label="Drop zones" on={tab() === 2} onPress={() => tab.set(2)} />
        </Row>
        <Text fontSize={12} color={c.muted}>
          {tab() === 0
            ? "Tap a store: its photo flies to the next screen. Swipe back slowly from the edge: the photo goes back with your finger."
            : tab() === 1
              ? "Long press a row to pick it up. Drag it up or down; near the top or bottom edge the list scrolls. Let go to drop it."
              : "Drag a chip onto Keep or Archive. The zone lights up when the chip is over it. Let go anywhere else: it springs back."}
        </Text>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <MscButton label="Keep JS busy 200 ms" onPress={busyOnce} />
          <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
            {note()}
          </Text>
        </Row>
      </Column>

      {tab() === 0 ? <MscGridDemo /> : null}
      {tab() === 1 ? <MscReorderDemo /> : null}
      {tab() === 2 ? <MscDropDemo /> : null}
    </Column>
  )
}

// ---- The store page --------------------------------------------------------------------------------------------------------------

export function MotionScreensDetailScreen(props: { storeId: string }) {
  const found = MSC_STORES.find((s) => s.id === props.storeId)
  const s = found ?? MSC_STORES[0]
  const note = signal("")

  return (
    <Stack style={{ flex: 1, backgroundColor: c.bg }}>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingBottom: 110 }}>
          <Image sharedTag={"store-" + s.id} src={s.img} loading="shimmer" contentScale="cover" style={{ width: "100%", height: 320 }} />
          <Column style={{ marginTop: -24, padding: 20, gap: 14, borderTopLeftRadius: 28, borderTopRightRadius: 28, backgroundColor: c.bg }}>
            <Row style={{ alignItems: "center", gap: 10 }}>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text fontSize={24} fontWeight={800} color={c.ink}>
                  {s.name}
                </Text>
                <Text fontSize={13} color={c.muted}>
                  {s.kind + " · " + s.far}
                </Text>
              </Column>
              <Column style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, backgroundColor: c.success }}>
                <Text fontSize={13} fontWeight={800} color={c.white}>
                  {"★ " + s.rating}
                </Text>
              </Column>
            </Row>
            <Column sharedTag={"store-chip-" + s.id} style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: c.successBg }}>
              <Text fontSize={14} fontWeight={800} color={c.success}>
                {s.back}
              </Text>
            </Column>
            <Text fontSize={16} fontWeight={800} color={c.ink}>
              Offers
            </Text>
            {s.offers.map((o) => (
              <Row key={o} style={{ alignItems: "center", gap: 12, padding: 14, borderRadius: 16, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
                <Text fontSize={20}>🎟️</Text>
                <Text fontSize={14} fontWeight={600} color={c.ink} style={{ flex: 1 }}>
                  {o}
                </Text>
              </Row>
            ))}
            <Row style={{ gap: 10, alignItems: "center" }}>
              <MscButton
                label="Keep JS busy 200 ms"
                onPress={() => {
                  busyLoop(200)
                  note.set("JS was blocked for 200 ms.")
                }}
              />
              <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
                {note()}
              </Text>
            </Row>
          </Column>
        </Column>
      </Scroll>

      {/* Over the photo: a back button. It is on the screen, not in the flight. */}
      <Pressable
        onPress={() => nav.back()}
        accessibilityLabel="Back"
        style={{ position: "absolute", top: insets().top + 8, start: 16, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: c.white, elevation: 4 }}
      >
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          ←
        </Text>
      </Pressable>

      <Row style={{ position: "absolute", start: 0, end: 0, bottom: 0, alignItems: "center", gap: 12, padding: 16, backgroundColor: c.white, borderTopWidth: 1, borderColor: c.border }}>
        <Column style={{ flex: 1 }}>
          <Text fontSize={12} color={c.muted}>
            Pay at the store
          </Text>
          <Text fontSize={18} fontWeight={800} color={c.ink}>
            {s.name}
          </Text>
        </Column>
        <Pressable onPress={() => nav.back()} pressScale={0.97} style={{ paddingHorizontal: 22, paddingVertical: 14, borderRadius: 16, backgroundColor: c.primary }}>
          <Text fontSize={15} fontWeight={800} color={c.white}>
            Scan & Pay
          </Text>
        </Pressable>
      </Row>
    </Stack>
  )
}
