// Motion lab 7: sheets and tabs. Built only from the public gestures-and-motion API (docs/gestures-and-motion-v1.md, lab
// "Sheets and tabs"; guide: docs/motion.md §3, §8). It is an example, not framework code.
//   a) Tabs: an underline that follows the finger through a Carousel's page; a tap on a tab scrolls the Carousel
//   b) Sheet: the sheet's progress (0 closed → 1 at its tallest) drives a backdrop tint and a header
//   c) Keyboard: an input bar that rides the keyboard frame by frame (the route sets keyboard: "none")
//   d) A–Z: a side bar, a vertical drag whose touchY becomes a letter that a List follows
// The underline, the backdrop, the bar and the list follow run on the UI thread. JS only hears page changes and taps.
import { Box, Carousel, Column, List, Pressable, Row, Sheet, Stack, Text, TextField } from "@zero-native/ui"
import { derive, env, nav, self, signal, useElementMotion, useMotion, usePan } from "@zero-native/core"
import { c } from "./tokens"

/** Blocks the JS thread for [ms]. Everything here must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MsButton(props: { label: string; onPress: () => void; soft?: boolean }) {
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

function MsTab(props: { label: string; on: boolean; onPress: () => void }) {
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

// ---- a) Tab underline that follows the pages ---------------------------------------------------------------------------

interface MsPage {
  emoji: string
  title: string
  line: string
  amount: string
  tint: string
}

const PAGES: MsPage[] = [
  { emoji: "🎟️", title: "Offers", line: "Live offers near you", amount: "₹120 off", tint: "#E0E7FF" },
  { emoji: "🏪", title: "Stores", line: "Shops that pay you back", amount: "48 stores", tint: "#DCFCE7" },
  { emoji: "🎁", title: "Rewards", line: "Cashback ready to use", amount: "₹1,250", tint: "#FEF3C7" },
]

function MsTabsDemo() {
  const pager = useElementMotion()
  // A value the Carousel follows while a tab is tapped. Its start is the page JS last heard about.
  const target = useMotion(0)
  const cur = signal(0)

  const goTo = (i: number) => {
    target.set(cur())
    pager.follow(target)
    cur.set(i)
    void target.to(i, "spring").then(() => pager.follow(null))
  }

  return (
    <Column style={{ flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 24, overflow: "hidden", backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      <Row>
        {PAGES.map((p, i) => (
          <Pressable key={p.title} onPress={() => goTo(i)} accessibilityLabel={p.title + " tab"} style={{ flex: 1, paddingVertical: 14, alignItems: "center" }}>
            <Text
              fontSize={14}
              fontWeight={800}
              color={cur() === i ? c.primary : c.muted}
              style={{ opacity: derive(() => 1 - 0.4 * Math.min(1, Math.abs(pager.page() - i))) }}
            >
              {p.title}
            </Text>
          </Pressable>
        ))}
      </Row>
      {/* The underline is a third of the bar wide; it moves by its own width for each page, and so follows the finger. */}
      <Stack style={{ height: 3, backgroundColor: c.border }}>
        <Column
          style={{
            width: "33.3333%",
            height: 3,
            borderRadius: 2,
            backgroundColor: c.primary,
            transform: [{ translateX: derive(() => pager.page() * self.width) }],
          }}
        />
      </Stack>
      <Carousel motion={pager} onPageChange={(i) => cur.set(i)} style={{ flex: 1 }}>
        {PAGES.map((p) => (
          <Column key={p.title} justifyContent="center" alignItems="center" style={{ flex: 1, width: "100%", gap: 10, padding: 24 }}>
            <Column style={{ width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center", backgroundColor: p.tint }}>
              <Text fontSize={44}>{p.emoji}</Text>
            </Column>
            <Text fontSize={22} fontWeight={800} color={c.ink}>
              {p.title}
            </Text>
            <Text fontSize={13} color={c.muted}>
              {p.line}
            </Text>
            <Text fontSize={28} fontWeight={800} color={c.primary}>
              {p.amount}
            </Text>
          </Column>
        ))}
      </Carousel>
      <Row style={{ alignItems: "center", paddingHorizontal: 16, paddingVertical: 10, gap: 8, borderTopWidth: 1, borderColor: c.border }}>
        <Text fontSize={12} color={c.muted}>
          Page
        </Text>
        <Text fontSize={14} fontWeight={800} color={c.ink}>
          {pager.page.format({ decimals: 2 })}
        </Text>
      </Row>
    </Column>
  )
}

// ---- b) Sheet progress drives a backdrop and a header ----------------------------------------------------------------------

interface MsPayOption {
  emoji: string
  name: string
  sub: string
}

const PAY_OPTIONS: MsPayOption[] = [
  { emoji: "📱", name: "PhonePe", sub: "Instant, 1 tap" },
  { emoji: "🟦", name: "Google Pay", sub: "Fast" },
  { emoji: "💙", name: "Paytm", sub: "Wallet or UPI" },
  { emoji: "🟣", name: "CRED", sub: "Rewards on every pay" },
  { emoji: "🏦", name: "Bank account (UPI ID)", sub: "pavan@okbank" },
  { emoji: "💳", name: "Debit card", sub: "HDFC ending 4521" },
]

function MsSheetDemo() {
  const open = signal(false)
  const picked = signal("")
  const sheet = useElementMotion()

  return (
    <Stack style={{ flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 24, overflow: "hidden", backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      {/* The screen under the sheet. Its header shrinks and fades as the sheet rises. */}
      <Column style={{ flex: 1, padding: 16, gap: 14 }}>
        <Column
          style={{
            padding: 18,
            gap: 4,
            borderRadius: 20,
            backgroundColor: c.primary,
            transformOrigin: "top",
            transform: [{ translateY: sheet.progress.map([0, 1], [0, -10]) }, { scale: sheet.progress.map([0, 1], [1, 0.9]) }],
            opacity: sheet.progress.map([0, 1], [1, 0.55]),
          }}
        >
          <Text fontSize={12} color="#C7D2FE">
            Order #4821 · Fresh Basket
          </Text>
          <Text fontSize={34} fontWeight={800} color={c.white}>
            ₹1,249
          </Text>
          <Text fontSize={12} color="#C7D2FE">
            You will get ₹50 cashback
          </Text>
        </Column>
        <Row style={{ alignItems: "center", gap: 10 }}>
          <Text fontSize={13} color={c.muted}>
            Sheet progress
          </Text>
          <Text fontSize={16} fontWeight={800} color={c.ink}>
            {sheet.progress.map([0, 1], [0, 100]).format({ decimals: 0, suffix: "%" })}
          </Text>
        </Row>
        <MsButton label="Choose how to pay" onPress={() => open.set(true)} />
        <Text fontSize={13} color={c.muted}>
          {picked() === "" ? "Nothing chosen yet." : "Paying with " + picked() + "."}
        </Text>
      </Column>

      {/* The backdrop tint: it grows with the sheet. It takes no touches. */}
      <Column
        pointerEvents="none"
        style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: c.primary, opacity: sheet.progress.map([0, 1], [0, 0.35]) }}
      />

      <Sheet visible={open()} motion={sheet} detents="half,full" onDismiss={() => open.set(false)}>
        <Column style={{ padding: 20, gap: 12 }}>
          <Text fontSize={18} fontWeight={800} color={c.ink}>
            Pay ₹1,249 with
          </Text>
          <Text fontSize={12} color={c.muted}>
            Drag the sheet up to full, or down to close. Back moves it down with your finger.
          </Text>
          {PAY_OPTIONS.map((o) => (
            <Pressable
              key={o.name}
              onPress={() => {
                picked.set(o.name)
                open.set(false)
              }}
              style={{ padding: 12, borderRadius: 16, backgroundColor: c.pillBg }}
            >
              <Row style={{ alignItems: "center", gap: 12 }}>
                <Text fontSize={24}>{o.emoji}</Text>
                <Column style={{ flex: 1, gap: 2 }}>
                  <Text fontSize={15} fontWeight={700} color={c.ink}>
                    {o.name}
                  </Text>
                  <Text fontSize={12} color={c.muted}>
                    {o.sub}
                  </Text>
                </Column>
              </Row>
            </Pressable>
          ))}
        </Column>
      </Sheet>
    </Stack>
  )
}

// ---- c) Input bar that rides the keyboard ---------------------------------------------------------------------------------

function MsKeyboardDemo() {
  const messages = signal<string[]>(["Order placed ✓", "Your cashback of ₹50 is on the way", "Rider is 4 minutes away"])
  const text = signal("")
  const send = () => {
    const t = text().trim()
    if (t === "") return
    messages.set([...messages(), t])
    text.set("")
  }

  // The keyboard's height counts from the bottom of the window. This screen already stops above the navigation bar,
  // so that part is taken off.
  const keyboard = env.keyboardHeight
  const navBar = env.insets.bottom
  const lift = derive(() => Math.max(0, keyboard() - navBar()) * -1)

  return (
    <Stack style={{ flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 24, overflow: "hidden", backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      <Column style={{ padding: 16, gap: 4 }}>
        <Text fontSize={16} fontWeight={800} color={c.ink}>
          Order help
        </Text>
        <Text fontSize={12} color={c.muted}>
          Tap the field. The bar and the messages rise with the keyboard, frame by frame.
        </Text>
      </Column>

      {/* Messages and bar are one block at the bottom; it moves up by the keyboard's height. */}
      <Column style={{ position: "absolute", start: 0, end: 0, bottom: 0, transform: [{ translateY: lift }], backgroundColor: c.white }}>
        <Column style={{ paddingHorizontal: 16, paddingBottom: 10, gap: 6 }}>
          {messages()
            .slice(-4)
            .map((m, i) => (
              <Column key={i + m} style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 14, backgroundColor: c.pillBg }}>
                <Text fontSize={13} color={c.ink}>
                  {m}
                </Text>
              </Column>
            ))}
        </Column>
        <Row style={{ alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderColor: c.border }}>
          <TextField
            value={text()}
            onChangeText={(t) => text.set(t)}
            onSubmitEditing={send}
            placeholder="Write a message"
            returnKeyType="send"
            style={{ flex: 1, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20, backgroundColor: c.pillBg, fontSize: 15, color: c.ink }}
          />
          <Pressable onPress={send} accessibilityLabel="Send" style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: c.primary }}>
            <Text fontSize={18} fontWeight={800} color={c.white}>
              ➤
            </Text>
          </Pressable>
        </Row>
      </Column>
    </Stack>
  )
}

// ---- d) A–Z side bar drives a list ----------------------------------------------------------------------------------------

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("")
const NAMES: string[][] = [
  ["Apollo Pharmacy", "Amul Parlour"],
  ["Bata Showroom", "Biryani Blues"],
  ["Chai Point", "Cake Walk"],
  ["Dhaba Express", "Daily Fresh"],
  ["Eat Fit", "Electro World"],
  ["Fresh Basket", "Filter Kaapi House"],
  ["Gold Gym", "Green Grocer"],
  ["Haldiram's Corner", "Home Needs"],
  ["Idli Express", "Ice Cream Hub"],
  ["Jain Sweets", "Juice Junction"],
  ["Kalyan Jewellers", "Kebab Corner"],
  ["Lakme Salon", "Lassi Wala"],
  ["Max Fashion", "Meghana Foods"],
  ["Namma Tiffins", "Nature's Basket"],
  ["Oye Amritsar", "Organic Mart"],
  ["Punjabi Dhaba", "Paradise Kitchen"],
  ["Quick Bites", "Quilt House"],
  ["Reliance Digital", "Rolls Junction"],
  ["Slice of Italy", "Spice Garden"],
  ["Tea Trails", "Toy Planet"],
  ["Udupi Café", "Urban Ladder"],
  ["Vijay Stores", "Veg Treat"],
  ["Wok Express", "Wellness Forever"],
  ["Xpress Laundry", "Xiaomi Store"],
  ["Yummy Tummy", "Yoga Mart"],
  ["Zen Spa", "Zudio"],
]
// One header row and two store rows for each letter: so letter n starts at row 3n.
const ROWS_PER_LETTER = 3
const LETTER_H = 16

interface MsRowData {
  id: string
  head: boolean
  letter: string
  name: string
  back: string
}

function buildRows(): MsRowData[] {
  const out: MsRowData[] = []
  LETTERS.forEach((letter, i) => {
    out.push({ id: "h-" + letter, head: true, letter, name: "", back: "" })
    NAMES[i].forEach((name, k) => {
      out.push({ id: letter + k, head: false, letter, name, back: ["5% back", "10% back", "₹50 back", "15% back"][(i + k) % 4] })
    })
  })
  return out
}
const AZ_ROWS: MsRowData[] = buildRows()

function MsHeadRow(props: { letter: string }) {
  return (
    <Row style={{ height: 32, alignItems: "center", paddingHorizontal: 20, backgroundColor: c.pillBg }}>
      <Text fontSize={13} fontWeight={800} color={c.primary}>
        {props.letter}
      </Text>
    </Row>
  )
}

function MsStoreRow(props: { name: string; back: string }) {
  return (
    <Row style={{ height: 56, alignItems: "center", gap: 12, paddingHorizontal: 20, paddingEnd: 44, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
      <Column style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: c.pillBg }}>
        <Text fontSize={16}>🏪</Text>
      </Column>
      <Text fontSize={15} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
        {props.name}
      </Text>
      <Column style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: c.successBg }}>
        <Text fontSize={11} fontWeight={700} color={c.success}>
          {props.back}
        </Text>
      </Column>
    </Row>
  )
}

function MsAlphaDemo() {
  const list = useElementMotion()
  const dragging = signal(false)

  // The finger's height in the bar, in whole letters (0 = A), and the list row that letter starts at. A touch on the
  // bar makes the List follow `row` (jumps to the letter under the finger) until the finger lifts.
  const side = usePan({
    axis: "y",
    minDistance: 0,
    a11yLabel: "Alphabet index. Drag to jump to a letter.",
    haptic: { start: "light" },
    onBegin: () => {
      dragging.set(true)
      list.follow(row)
    },
    onFinalize: () => {
      dragging.set(false)
      list.follow(null)
    },
  })
  const letter = derive(() => Math.floor(Math.min(25, Math.max(0, side.touchY() / LETTER_H))))
  const row = derive(() => letter() * ROWS_PER_LETTER)

  return (
    <Stack style={{ flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 24, overflow: "hidden", backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      <List data={AZ_ROWS} key={(r) => r.id} motion={list} style={{ flex: 1 }} row={(r) => (r.head ? <MsHeadRow letter={r.letter} /> : <MsStoreRow name={r.name} back={r.back} />)} />

      {/* The bar. A highlight sits behind the letter of the first visible row. */}
      <Stack style={{ position: "absolute", top: 8, end: 4, width: 28, height: LETTER_H * 26 }}>
        <Column
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            start: 4,
            width: 20,
            height: LETTER_H,
            borderRadius: 8,
            // Light, so the grey letter on it stays readable.
            backgroundColor: "#E0E7FF",
            transform: [{ translateY: derive(() => Math.min(25, Math.floor(list.index() / ROWS_PER_LETTER)) * LETTER_H) }],
          }}
        />
        <Column gesture={side} style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }}>
          {LETTERS.map((l) => (
            <Column key={l} style={{ height: LETTER_H, alignItems: "center", justifyContent: "center" }}>
              <Text fontSize={10} fontWeight={800} color={c.muted}>
                {l}
              </Text>
            </Column>
          ))}
        </Column>
      </Stack>

      {/* The big letter next to the finger: a 56 dp window onto a tall column of letters, moved by the letter number.
          TODO(api): v.format() can only write numbers. A motion value that picks one string from a list (a letter, a
          month name) would remove this tall-column trick. */}
      <Box
        animate={150}
        pointerEvents="none"
        style={{ position: "absolute", top: 8, end: 44, opacity: dragging() ? 1 : 0 }}
      >
        <Column style={{ transform: [{ translateY: derive(() => Math.min(Math.max(side.touchY(), 0), LETTER_H * 26) - 28) }] }}>
          <Stack style={{ width: 56, height: 56, borderRadius: 28, overflow: "hidden", backgroundColor: c.primary, elevation: 6 }}>
            <Column style={{ position: "absolute", top: 0, start: 0, end: 0, transform: [{ translateY: derive(() => letter() * -56) }] }}>
              {LETTERS.map((l) => (
                <Column key={l} style={{ height: 56, alignItems: "center", justifyContent: "center" }}>
                  <Text fontSize={28} fontWeight={800} color={c.white}>
                    {l}
                  </Text>
                </Column>
              ))}
            </Column>
          </Stack>
        </Column>
      </Box>
    </Stack>
  )
}

// ---- The screen ---------------------------------------------------------------------------------------------------------

export function MotionSheetsLabScreen() {
  const tab = signal(0)
  const note = signal("")
  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms. Underline, backdrop, bar and list kept moving.")
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
          Sheets and tabs
        </Text>
      </Row>

      <Column style={{ padding: 16, gap: 10 }}>
        <Row style={{ gap: 6 }}>
          <MsTab label="Tabs" on={tab() === 0} onPress={() => tab.set(0)} />
          <MsTab label="Sheet" on={tab() === 1} onPress={() => tab.set(1)} />
          <MsTab label="Keyboard" on={tab() === 2} onPress={() => tab.set(2)} />
          <MsTab label="A–Z" on={tab() === 3} onPress={() => tab.set(3)} />
        </Row>
        <Text fontSize={12} color={c.muted}>
          {tab() === 0
            ? "Swipe the pages: the underline follows your finger. Tap a tab: the pages glide there."
            : tab() === 1
              ? "Open the sheet and drag it between half and full: the tint and the header follow. Press Back with the sheet open: it goes down with your finger (that is native)."
              : tab() === 2
                ? "Tap the field. The bar rises with the keyboard. Close the keyboard: it comes down with it."
                : "Drag your finger down the letters at the right edge: the list jumps. The big letter shows where you are."}
        </Text>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <MsButton label="Keep JS busy 200 ms" onPress={busyOnce} />
          <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
            {note()}
          </Text>
        </Row>
      </Column>

      {tab() === 0 ? <MsTabsDemo /> : null}
      {tab() === 1 ? <MsSheetDemo /> : null}
      {tab() === 2 ? <MsKeyboardDemo /> : null}
      {tab() === 3 ? <MsAlphaDemo /> : null}
    </Column>
  )
}
