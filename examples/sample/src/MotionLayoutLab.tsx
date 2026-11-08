// Motion lab 6: layout motion. Built only from the public gestures-and-motion API (docs/gestures-and-motion-v1.md, lab
// "Layout motion"; guide: docs/motion.md §7, §8). It is an example, not framework code.
//   a) Expand: a plan card grows (animateLayout) and the cards below glide down
//   b) Rows: a cart where rows are removed, moved to the top or added (List itemAnimation)
//   c) Presets: every enter / exit preset, shown and hidden together
//   d) Counter: an animated ₹ amount (v.to, and a timeline) as native number text (format)
//   e) Coach: a tip placed with measure(), a pulsing ring around the thing it points at
// The sizes, the glides, the presets, the counters and the pulse run natively. JS only says "now it is open".
import { Box, Column, List, Pressable, Row, Scroll, Stack, Text } from "@zero-native/ui"
import type { Children } from "@zero-native/ui"
import { nav, signal, useElementMotion, useMotion, usePan, useTimeline } from "@zero-native/core"
import { c } from "./tokens"
import { formatIndian } from "./money"

/** Blocks the JS thread for [ms]. Everything here must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MlButton(props: { label: string; onPress: () => void; soft?: boolean }) {
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

function MlTab(props: { label: string; on: boolean; onPress: () => void }) {
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

/** Indian grouping for a whole-rupee amount: 12450 → "₹12,450". */
function inr(n: number): string {
  return "₹" + formatIndian(String(Math.round(n)))
}

// ---- a) Expanding card, siblings reflow -------------------------------------------------------------------------------

interface MlPlan {
  id: number
  emoji: string
  name: string
  price: number
  tint: string
  perks: string[]
}

const PLANS: MlPlan[] = [
  { id: 1, emoji: "🌱", name: "Starter", price: 199, tint: "#DCFCE7", perks: ["Pay any shop with UPI", "5% cashback up to ₹50", "Email receipts"] },
  { id: 2, emoji: "⚡", name: "Plus", price: 399, tint: "#E0E7FF", perks: ["Everything in Starter", "10% cashback up to ₹150", "Priority support", "Bill split with friends"] },
  { id: 3, emoji: "👑", name: "Pro", price: 799, tint: "#FEF3C7", perks: ["Everything in Plus", "15% cashback up to ₹400", "Free UPI Lite top-ups", "Monthly spend report", "Dedicated helpline"] },
  { id: 4, emoji: "🏪", name: "Business", price: 1499, tint: "#FFE4D6", perks: ["Everything in Pro", "Collect payments on one QR", "Daily settlement to bank"] },
]

function MlPlanCard(props: { plan: MlPlan; open: boolean; onToggle: () => void }) {
  return (
    <Pressable
      onPress={props.onToggle}
      pressScale={0.99}
      animateLayout="spring"
      accessibilityLabel={props.plan.name + " plan, " + inr(props.plan.price) + " a month"}
      // overflow hidden: while the card's height springs, its new lines are already full size; without the clip they
      // draw over the next card for a few frames (phone, 2026-11-09).
      style={{ padding: 16, borderRadius: 20, overflow: "hidden", backgroundColor: c.white, borderWidth: 1, borderColor: props.open ? c.primary : c.border, gap: 12 }}
    >
      <Row style={{ alignItems: "center", gap: 12 }}>
        <Column style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: props.plan.tint }}>
          <Text fontSize={22}>{props.plan.emoji}</Text>
        </Column>
        <Column style={{ flex: 1, gap: 2 }}>
          <Text fontSize={16} fontWeight={800} color={c.ink}>
            {props.plan.name}
          </Text>
          <Text fontSize={12} color={c.muted}>
            {props.open ? "Tap to close" : "Tap to see what you get"}
          </Text>
        </Column>
        <Text fontSize={18} fontWeight={800} color={c.primary}>
          {inr(props.plan.price)}
        </Text>
      </Row>
      {props.open ? (
        <Column enter="fade-down" exit="fade" style={{ gap: 8 }}>
          {props.plan.perks.map((p) => (
            <Row key={p} style={{ alignItems: "center", gap: 8 }}>
              <Text fontSize={13} fontWeight={800} color={c.success}>
                ✓
              </Text>
              <Text fontSize={13} color={c.ink}>
                {p}
              </Text>
            </Row>
          ))}
        </Column>
      ) : null}
    </Pressable>
  )
}

function MlExpandDemo() {
  const open = signal(2)
  const toggle = (id: number) => open.set(open() === id ? 0 : id)

  return (
    <Scroll style={{ flex: 1 }}>
      <Column style={{ paddingHorizontal: 16, paddingBottom: 28, gap: 12 }}>
        {PLANS.map((p) => (
          <MlPlanCard key={p.id} plan={p} open={open() === p.id} onToggle={() => toggle(p.id)} />
        ))}
        {/* A sibling that is not a card: it glides too. */}
        <Column animateLayout="spring" style={{ padding: 14, borderRadius: 16, backgroundColor: c.pillBg, gap: 2 }}>
          <Text fontSize={12} color={c.muted}>
            All plans renew monthly. Cancel any time.
          </Text>
          <Text fontSize={12} color={c.muted}>
            GST is included in the price.
          </Text>
        </Column>
      </Column>
    </Scroll>
  )
}

// ---- b) List rows removed, moved, added -------------------------------------------------------------------------------

interface MlLine {
  id: number
  emoji: string
  name: string
  price: number
  tint: string
}

const LINES: MlLine[] = [
  { id: 1, emoji: "🍚", name: "Basmati rice 5 kg", price: 649, tint: "#FEF3C7" },
  { id: 2, emoji: "🧈", name: "Amul butter 500 g", price: 285, tint: "#FFE4D6" },
  { id: 3, emoji: "🥛", name: "Toned milk 1 L (4)", price: 276, tint: "#E0E7FF" },
  { id: 4, emoji: "🍅", name: "Tomatoes 2 kg", price: 96, tint: "#FEE2E2" },
  { id: 5, emoji: "🧼", name: "Dish wash 750 ml", price: 169, tint: "#DCFCE7" },
  { id: 6, emoji: "☕", name: "Filter coffee 500 g", price: 420, tint: "#FFE4D6" },
  { id: 7, emoji: "🍪", name: "Marie biscuits (6)", price: 90, tint: "#FEF3C7" },
]
// Items "Add item" brings in, one after another.
const MORE: MlLine[] = [
  { id: 101, emoji: "🥚", name: "Eggs (12)", price: 84, tint: "#FEF3C7" },
  { id: 102, emoji: "🍌", name: "Bananas 1 dozen", price: 60, tint: "#FEF3C7" },
  { id: 103, emoji: "🧅", name: "Onions 2 kg", price: 70, tint: "#FFE4D6" },
  { id: 104, emoji: "🫓", name: "Whole wheat atta 5 kg", price: 245, tint: "#FEF3C7" },
]

function MlLineRow(props: { line: MlLine; onRemove: (id: number) => void; onTop: (id: number) => void }) {
  return (
    <Row style={{ alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
      <Column style={{ width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: props.line.tint }}>
        <Text fontSize={22}>{props.line.emoji}</Text>
      </Column>
      <Column style={{ flex: 1, gap: 2 }}>
        <Text fontSize={15} fontWeight={700} color={c.ink}>
          {props.line.name}
        </Text>
        <Text fontSize={13} fontWeight={800} color={c.primary}>
          {inr(props.line.price)}
        </Text>
      </Column>
      <Pressable
        onPress={() => props.onTop(props.line.id)}
        accessibilityLabel={"Move " + props.line.name + " to the top"}
        style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: c.pillBg }}
      >
        <Text fontSize={15} fontWeight={800} color={c.ink}>
          ↑
        </Text>
      </Pressable>
      <Pressable
        onPress={() => props.onRemove(props.line.id)}
        accessibilityLabel={"Remove " + props.line.name}
        style={{ width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", backgroundColor: "#FEE2E2" }}
      >
        <Text fontSize={14} fontWeight={800} color="#E23744">
          ✕
        </Text>
      </Pressable>
    </Row>
  )
}

function MlRowsDemo() {
  const lines = signal<MlLine[]>(LINES)
  let added = 0

  const remove = (id: number) => lines.set(lines().filter((l) => l.id !== id))
  const toTop = (id: number) => {
    const list = lines()
    const hit = list.find((l) => l.id === id)
    if (!hit) return
    lines.set([hit, ...list.filter((l) => l.id !== id)])
  }
  const add = () => {
    const next = MORE[added % MORE.length]
    // The same item twice would share a key, so every extra one gets its own id.
    lines.set([{ ...next, id: next.id + 1000 * Math.floor(added / MORE.length) }, ...lines()])
    added++
  }
  const total = () => lines().reduce((sum, l) => sum + l.price, 0)

  return (
    <Column style={{ flex: 1 }}>
      <Row style={{ alignItems: "center", gap: 10, paddingHorizontal: 20, paddingBottom: 10 }}>
        <Column style={{ flex: 1 }}>
          <Text fontSize={12} color={c.muted}>
            {lines().length} items
          </Text>
          <Text fontSize={20} fontWeight={800} color={c.ink}>
            {inr(total())}
          </Text>
        </Column>
        <MlButton label="Add item" onPress={add} />
        <MlButton label="All back" soft onPress={() => lines.set(LINES)} />
      </Row>
      <List
        data={lines()}
        key={(l) => l.id}
        itemAnimation="fade"
        style={{ flex: 1 }}
        row={(l) => <MlLineRow line={l} onRemove={remove} onTop={toTop} />}
      />
    </Column>
  )
}

// ---- c) Every enter / exit preset ---------------------------------------------------------------------------------------

/** A cell with a label. What is inside comes and goes with `on`. */
function MlCell(props: { label: string; children?: Children }) {
  return (
    <Column style={{ flex: 1, alignItems: "center", gap: 6, paddingVertical: 10, borderRadius: 16, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      <Stack style={{ width: 64, height: 56, alignItems: "center", justifyContent: "center" }}>{props.children}</Stack>
      <Text fontSize={11} fontWeight={700} color={c.muted}>
        {props.label}
      </Text>
    </Column>
  )
}

function MlPresetsDemo() {
  const on = signal(true)
  const replay = () => {
    on.set(false)
    setTimeout(() => on.set(true), 700)
  }

  return (
    <Scroll style={{ flex: 1 }}>
      <Column style={{ paddingHorizontal: 16, paddingBottom: 28, gap: 10 }}>
        <Row style={{ gap: 10 }}>
          <MlButton label={on() ? "Hide all" : "Show all"} onPress={() => on.set(!on())} />
          <MlButton label="Replay" soft onPress={replay} />
        </Row>
        {/* enter / exit are build-time words, so each preset is written out. */}
        <Row style={{ gap: 10 }}>
          <MlCell label="fade">
            {on() ? (
              <Box enter="fade" exit="fade" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: c.primary, alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="fade-up">
            {on() ? (
              <Box enter="fade-up" exit="fade-up" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: c.primary, alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="fade-down">
            {on() ? (
              <Box enter="fade-down" exit="fade-down" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: c.primary, alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
        </Row>
        <Row style={{ gap: 10 }}>
          <MlCell label="scale">
            {on() ? (
              <Box enter="scale" exit="scale" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#0F766E", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="pop">
            {on() ? (
              <Box enter="pop" exit="pop" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#0F766E", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="zoom">
            {on() ? (
              <Box enter="zoom" exit="zoom" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#0F766E", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
        </Row>
        <Row style={{ gap: 10 }}>
          <MlCell label="slide-left">
            {on() ? (
              <Box enter="slide-left" exit="slide-left" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#B45309", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="slide-right">
            {on() ? (
              <Box enter="slide-right" exit="slide-right" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#B45309", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="bounce">
            {on() ? (
              <Box enter="bounce" exit="bounce" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#B45309", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
        </Row>
        <Row style={{ gap: 10 }}>
          <MlCell label="slide-up">
            {on() ? (
              <Box enter="slide-up" exit="slide-up" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#7C3AED", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="slide-down">
            {on() ? (
              <Box enter="slide-down" exit="slide-down" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#7C3AED", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="flip-x">
            {on() ? (
              <Box enter="flip-x" exit="flip-x" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#7C3AED", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
        </Row>
        <Row style={{ gap: 10 }}>
          <MlCell label="flip-y">
            {on() ? (
              <Box enter="flip-y" exit="flip-y" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#E23744", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="stretch-x">
            {on() ? (
              <Box enter="stretch-x" exit="stretch-x" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#E23744", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
          <MlCell label="stretch-y">
            {on() ? (
              <Box enter="stretch-y" exit="stretch-y" style={{ width: 52, height: 40, borderRadius: 12, backgroundColor: "#E23744", alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  ₹
                </Text>
              </Box>
            ) : null}
          </MlCell>
        </Row>
      </Column>
    </Scroll>
  )
}

// ---- d) Animated ₹ counter ----------------------------------------------------------------------------------------------

const YEAR_SAVINGS = 12450 // what the timeline counts up to

function MlCounterDemo() {
  // Cashback: a motion value moved by to(). The number text is made natively each frame.
  const cashback = useMotion(0)
  // JS keeps its own copy of where the value is going, because peek() only knows what JS has heard.
  // TODO(api): a way to move a value by an amount from where it is now (a `by()`), or to read the live value once
  // without subscribing. Today peek() is stale for a value nobody watches, so JS has to keep its own target.
  let cashbackTarget = 0
  const addCashback = (rupees: number) => {
    cashbackTarget += rupees
    void cashback.to(cashbackTarget, "bouncy")
  }

  // Savings: one timeline 0 → 1; the amount and the bar both read it, so they never get out of step.
  const savings = useTimeline({ duration: 1800, easing: "ease-out" })

  return (
    <Scroll style={{ flex: 1 }}>
      <Column style={{ paddingHorizontal: 16, paddingBottom: 28, gap: 14 }}>
        <Column style={{ padding: 18, gap: 4, borderRadius: 24, backgroundColor: c.primary }}>
          <Text fontSize={13} fontWeight={600} color="#C7D2FE">
            Cashback earned
          </Text>
          <Text fontSize={44} fontWeight={800} color={c.white}>
            {cashback.format({ prefix: "₹", decimals: 0 })}
          </Text>
          <Row style={{ gap: 8, paddingTop: 8 }}>
            <MlButton label="+ ₹50" soft onPress={() => addCashback(50)} />
            <MlButton label="+ ₹1,250" soft onPress={() => addCashback(1250)} />
            <MlButton
              label="Reset"
              soft
              onPress={() => {
                cashbackTarget = 0
                cashback.set(0)
              }}
            />
          </Row>
        </Column>

        <Column style={{ padding: 18, gap: 8, borderRadius: 24, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
          <Text fontSize={13} fontWeight={600} color={c.muted}>
            You saved this year
          </Text>
          <Text fontSize={40} fontWeight={800} color={c.ink}>
            {savings.map([0, 1], [0, YEAR_SAVINGS]).format({ prefix: "₹", decimals: 0 })}
          </Text>
          <Stack style={{ height: 8, borderRadius: 4, overflow: "hidden", backgroundColor: c.pillBg }}>
            <Column
              style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, borderRadius: 4, backgroundColor: c.success, transformOrigin: "left", transform: [{ scaleX: savings }] }}
            />
          </Stack>
          <Row style={{ gap: 8, paddingTop: 6 }}>
            <MlButton label="Play" onPress={() => void savings.play()} />
            <MlButton label="Pause" soft onPress={() => savings.pause()} />
            <MlButton label="Reverse" soft onPress={() => void savings.reverse()} />
            <MlButton label="Restart" soft onPress={() => void savings.restart()} />
          </Row>
        </Column>
      </Column>
    </Scroll>
  )
}

// ---- e) Coach mark placed with measure() ---------------------------------------------------------------------------------

// ---- f) Height from a motion value (registry 24, A4 limited) ------------------------------------------------------------

/** A panel whose height follows a drag. Not a transform: the cards below really move (the layout runs each frame). */
function MlHeightDemo() {
  const drag = usePan({
    axis: "y",
    initial: { y: 140 },
    bounds: { y: [80, 300] },
    anchors: [{ id: "small", y: 80 }, { id: "medium", y: 180 }, { id: "large", y: 300 }],
    a11yLabel: "Panel size",
  })
  return (
    <Column style={{ paddingHorizontal: 16, gap: 10 }}>
      <Column style={{ height: drag.y, borderRadius: 18, backgroundColor: c.primary, padding: 16, overflow: "hidden" }}>
        <Text fontSize={16} fontWeight={800} color={c.white}>
          Spends this month
        </Text>
        <Text fontSize={13} color={c.white}>
          {drag.y.format({ decimals: 0, suffix: " dp tall" })}
        </Text>
      </Column>
      <Row gesture={drag} style={{ height: 28, alignItems: "center", justifyContent: "center" }}>
        <Box style={{ width: 48, height: 6, borderRadius: 3, backgroundColor: c.border }} />
      </Row>
      {["Groceries ₹4,820", "Fuel ₹2,100", "Dining ₹1,640"].map((t) => (
        <Row key={t} style={{ padding: 14, borderRadius: 14, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
          <Text fontSize={14} fontWeight={700} color={c.ink}>
            {t}
          </Text>
        </Row>
      ))}
    </Column>
  )
}

function MlCoachDemo() {
  // The demo area, and the button the tip points at. measure() gives each box in the window, so the tip uses the
  // difference.
  const area = useElementMotion()
  const target = useElementMotion()

  const shown = signal(false)
  const tx = signal(0)
  const ty = signal(0)
  const tw = signal(0)
  const th = signal(0)
  // A spacer before the button: "Move the button" makes it wider, so the button sits somewhere else.
  const gap = signal(0)

  const show = () => {
    void Promise.all([area.measure(), target.measure()]).then(([a, t]) => {
      tx.set(t.x - a.x)
      ty.set(t.y - a.y)
      tw.set(t.width)
      th.set(t.height)
      shown.set(true)
    })
  }
  const move = () => {
    shown.set(false)
    gap.set(gap() === 0 ? 110 : 0)
  }

  return (
    <Stack motion={area} style={{ flex: 1, marginHorizontal: 16, marginBottom: 16, borderRadius: 24, overflow: "hidden", backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      {/* A pretend home screen. */}
      <Column style={{ flex: 1, padding: 16, gap: 16 }}>
        <Row style={{ alignItems: "center", gap: 10 }}>
          <Column style={{ width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: c.pillBg }}>
            <Text fontSize={18}>🙂</Text>
          </Column>
          <Column style={{ flex: 1 }}>
            <Text fontSize={12} color={c.muted}>
              Good evening
            </Text>
            <Text fontSize={16} fontWeight={800} color={c.ink}>
              Pavan
            </Text>
          </Column>
          <Text fontSize={20}>🔔</Text>
        </Row>
        <Column style={{ padding: 16, gap: 2, borderRadius: 20, backgroundColor: c.primary }}>
          <Text fontSize={12} color="#C7D2FE">
            Cashback balance
          </Text>
          <Text fontSize={32} fontWeight={800} color={c.white}>
            ₹1,250
          </Text>
        </Column>
        <Row style={{ alignItems: "center", gap: 10 }}>
          <Box style={{ width: gap(), height: 1 }} />
          <Pressable
            motion={target}
            onPress={() => {}}
            style={{ paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, backgroundColor: c.successBg }}
          >
            <Row style={{ alignItems: "center", gap: 8 }}>
              <Text fontSize={18}>📷</Text>
              <Text fontSize={14} fontWeight={800} color={c.success}>
                Scan & Pay
              </Text>
            </Row>
          </Pressable>
          <Column style={{ flexShrink: 1, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, backgroundColor: c.pillBg }}>
            {/* Moved far right, the button leaves little room: one line, cut with "…", not a letter per line. */}
            <Text fontSize={14} fontWeight={700} color={c.ink} numberOfLines={1}>
              Send
            </Text>
          </Column>
        </Row>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <MlButton label="Show tip" onPress={show} />
          <MlButton label="Move the button" soft onPress={move} />
        </Row>
      </Column>

      {/* The tip layer: a dim sheet, a copy of the button, a pulsing ring and the bubble. A tap anywhere closes it. */}
      {shown() ? (
        <Stack enter="fade" exit="fade" style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0 }}>
          <Pressable
            onPress={() => shown.set(false)}
            pressFeedback="none"
            accessibilityLabel="Close the tip"
            style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: "#0F172AB3" }}
          />
          <Box
            pointerEvents="none"
            style={{ position: "absolute", top: 0, start: 0, width: tw() + 20, height: th() + 20, borderRadius: 20, borderWidth: 3, borderColor: c.white, transform: [{ translateX: tx() - 10 }, { translateY: ty() - 10 }] }}
            animate={{
              scale: { duration: 1100, keyframes: [1, 1.18], repeat: "forever" },
              opacity: { duration: 1100, keyframes: [1, 0], repeat: "forever" },
            }}
          />
          <Row
            pointerEvents="none"
            style={{ position: "absolute", top: 0, start: 0, width: tw(), height: th(), borderRadius: 16, backgroundColor: c.successBg, alignItems: "center", justifyContent: "center", gap: 8, transform: [{ translateX: tx() }, { translateY: ty() }] }}
          >
            <Text fontSize={18}>📷</Text>
            <Text fontSize={14} fontWeight={800} color={c.success}>
              Scan & Pay
            </Text>
          </Row>
          <Column
            pointerEvents="none"
            style={{ position: "absolute", top: 0, start: 16, end: 16, padding: 14, gap: 4, borderRadius: 16, backgroundColor: c.white, transform: [{ translateY: ty() + th() + 22 }] }}
          >
            <Text fontSize={15} fontWeight={800} color={c.ink}>
              Pay any shop in two taps
            </Text>
            <Text fontSize={13} color={c.muted}>
              Scan the shop's QR, enter the amount, and your cashback comes in seconds.
            </Text>
            <Text fontSize={12} fontWeight={700} color={c.primary}>
              Tap to close
            </Text>
          </Column>
        </Stack>
      ) : null}
    </Stack>
  )
}

// ---- The screen ---------------------------------------------------------------------------------------------------------

export function MotionLayoutLabScreen() {
  const tab = signal(0)
  const note = signal("")
  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms. The glides, presets and counters kept moving.")
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
          Layout motion
        </Text>
      </Row>

      <Column style={{ padding: 16, gap: 10 }}>
        <Row style={{ gap: 6 }}>
          <MlTab label="Expand" on={tab() === 0} onPress={() => tab.set(0)} />
          <MlTab label="Rows" on={tab() === 1} onPress={() => tab.set(1)} />
          <MlTab label="Presets" on={tab() === 2} onPress={() => tab.set(2)} />
          <MlTab label="Counter" on={tab() === 3} onPress={() => tab.set(3)} />
          <MlTab label="Coach" on={tab() === 4} onPress={() => tab.set(4)} />
          <MlTab label="Height" on={tab() === 5} onPress={() => tab.set(5)} />
        </Row>
        <Text fontSize={12} color={c.muted}>
          {tab() === 0
            ? "Tap a plan: it grows and the cards below glide down. Tap another: one closes, one opens."
            : tab() === 1
              ? "✕ removes a row and the rows below glide up. ↑ moves a row to the top. Add item brings one in."
              : tab() === 2
                ? "Hide all, then Show all: each cell uses a different enter / exit preset. Replay hides, waits, shows."
                : tab() === 3
                  ? "The ₹ numbers are native text, drawn each frame. Press + ₹1,250 twice quickly: the count goes on from where it is."
                  : tab() === 4
                    ? "Show tip: the tip is placed with measure(). Move the button, then Show tip again: it finds the new place."
                    : "Drag the handle: the panel's real height follows the finger and the cards below move with it (a layout pass per frame)."}
        </Text>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <MlButton label="Keep JS busy 200 ms" onPress={busyOnce} />
          <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
            {note()}
          </Text>
        </Row>
      </Column>

      {tab() === 0 ? <MlExpandDemo /> : null}
      {tab() === 1 ? <MlRowsDemo /> : null}
      {tab() === 2 ? <MlPresetsDemo /> : null}
      {tab() === 3 ? <MlCounterDemo /> : null}
      {tab() === 4 ? <MlCoachDemo /> : null}
      {tab() === 5 ? <MlHeightDemo /> : null}
    </Column>
  )
}
