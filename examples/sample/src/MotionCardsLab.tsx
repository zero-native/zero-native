// Motion lab 3: swipe cards and a story viewer. Built only from the public gestures-and-motion API
// (docs/gestures-and-motion-v1.md, lab 3 / "cards and stories"). It is an example, not framework code.
//   a) swipe cards: a stack of three, the top one is dragged in 2D, tilts, shows LIKE / NOPE, flies out
//   b) a story viewer: progress bars driven by timelines, tap left / right, hold to pause, drag down to close
// The finger, the tilt, the labels, the card under the top one and the bars all run on the UI thread.
import { Column, Pressable, Row, Stack, Text } from "@zero-native/ui"
import { derive, Gesture, interpolate, nav, signal, useElementMotion, useLongPress, usePan, useTap, useTimeline, type GestureEvent } from "@zero-native/core"
import { c } from "./tokens"

const DANGER = "#E23744"

interface McDish {
  emoji: string
  name: string
  place: string
  price: string
  rating: string
  tint: string
}

// The deck repeats: after the last card comes the first one again.
const DECK: McDish[] = [
  { emoji: "🍛", name: "Butter Chicken Thali", place: "Punjabi Dhaba · 1.2 km", price: "₹349", rating: "4.5", tint: "#FFE4D6" },
  { emoji: "🍕", name: "Margherita Pizza", place: "Slice of Italy · 2.0 km", price: "₹299", rating: "4.3", tint: "#FEE2E2" },
  { emoji: "🥘", name: "Hyderabadi Biryani", place: "Paradise Kitchen · 0.8 km", price: "₹279", rating: "4.6", tint: "#DCFCE7" },
  { emoji: "☕", name: "Filter Coffee + Dosa", place: "Udupi Café · 0.5 km", price: "₹149", rating: "4.4", tint: "#E0E7FF" },
  { emoji: "🍜", name: "Schezwan Noodles", place: "Wok Express · 1.6 km", price: "₹219", rating: "4.1", tint: "#FEF3C7" },
]

interface McStory {
  bg: string
  tag: string
  title: string
  amount: string
  line: string
}

const STORIES: McStory[] = [
  { bg: "#3D26ED", tag: "NEW", title: "Cashback on every UPI payment", amount: "₹50", line: "on your first scan today" },
  { bg: "#0F766E", tag: "OFFER", title: "Chai Point: 20% back", amount: "₹120", line: "saved by 4,000 people this week" },
  { bg: "#B45309", tag: "REWARD", title: "You earned a reward", amount: "₹1,250", line: "total cashback this month" },
]
const STORY_MS = 5000

/** Blocks the JS thread for [ms]. The cards and bars must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function McButton(props: { label: string; onPress: () => void; soft?: boolean }) {
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

function McTab(props: { label: string; on: boolean; onPress: () => void }) {
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

/** What is on a dish card. The card itself (size, tilt, labels) is made by the caller. */
function McCardFace(props: { item: McDish }) {
  return (
    <Column
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        start: 0,
        end: 0,
        borderRadius: 24,
        overflow: "hidden",
        backgroundColor: c.white,
        borderWidth: 1,
        borderColor: c.border,
        elevation: 6,
      }}
    >
      <Column style={{ height: 210, alignItems: "center", justifyContent: "center", backgroundColor: props.item.tint }}>
        <Text fontSize={84}>{props.item.emoji}</Text>
      </Column>
      <Column style={{ padding: 18, gap: 6 }}>
        <Text fontSize={20} fontWeight={800} color={c.ink}>
          {props.item.name}
        </Text>
        <Text fontSize={13} color={c.muted}>
          {props.item.place}
        </Text>
        <Row style={{ alignItems: "center", gap: 10, marginTop: 6 }}>
          <Text fontSize={26} fontWeight={800} color={c.primary}>
            {props.item.price}
          </Text>
          <Column style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: c.successBg }}>
            <Text fontSize={12} fontWeight={700} color={c.success}>
              ★ {props.item.rating}
            </Text>
          </Column>
        </Row>
      </Column>
    </Column>
  )
}

// ---- a) Swipe cards ---------------------------------------------------------------------------------------------------

function McSwipeDemo() {
  const index = signal(0)
  const liked = signal(0)
  const skipped = signal(0)

  const pan = usePan({
    axis: "xy",
    // Left, centre, right. The side ones are off the screen. A flick (or a long drag) picks a side one.
    anchors: [
      { id: "left", x: -600, y: 0 },
      { id: "centre", x: 0, y: 0 },
      { id: "right", x: 600, y: 0 },
    ],
    release: { project: true },
    haptic: { snap: "medium" },
    a11yLabel: "Dish card. Swipe right to like, left to skip.",
    onSettle: (e: { anchor: string | null }) => {
      if (e.anchor !== "left" && e.anchor !== "right") return
      if (e.anchor === "right") liked.set(liked() + 1)
      else skipped.set(skipped() + 1)
      // The next card is already under it. Show it on top: new text, card back in the middle.
      index.set(index() + 1)
      pan.x.set(0)
      pan.y.set(0)
    },
  })

  return (
    <Column style={{ gap: 16 }}>
      <Stack style={{ height: 410, marginHorizontal: 20 }}>
        {/* Third card: it comes forward as the top card leaves. */}
        <Stack
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            start: 0,
            end: 0,
            transform: [
              { translateY: derive(() => interpolate(Math.abs(pan.x()), [0, 150], [28, 14])) },
              { scale: derive(() => interpolate(Math.abs(pan.x()), [0, 150], [0.85, 0.92])) },
            ],
          }}
        >
          <McCardFace item={DECK[(index() + 2) % DECK.length]} />
        </Stack>
        {/* Second card: grows from 0.92 to 1 as the top card moves away. */}
        <Stack
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            start: 0,
            end: 0,
            transform: [
              { translateY: derive(() => interpolate(Math.abs(pan.x()), [0, 150], [14, 0])) },
              { scale: derive(() => interpolate(Math.abs(pan.x()), [0, 150], [0.92, 1])) },
            ],
          }}
        >
          <McCardFace item={DECK[(index() + 1) % DECK.length]} />
        </Stack>
        {/* Top card. */}
        <Stack
          gesture={pan}
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            start: 0,
            end: 0,
            transform: [{ translateX: pan.x }, { translateY: pan.y }, { rotate: derive(() => pan.x() / 18) }],
          }}
        >
          <McCardFace item={DECK[index() % DECK.length]} />
          <Column
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 22,
              start: 20,
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 10,
              borderWidth: 3,
              borderColor: c.success,
              opacity: pan.x.map([0, 120], [0, 1]),
              transform: [{ rotate: "-12deg" }],
            }}
          >
            <Text fontSize={22} fontWeight={800} color={c.success}>
              LIKE
            </Text>
          </Column>
          <Column
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 22,
              end: 20,
              paddingHorizontal: 12,
              paddingVertical: 4,
              borderRadius: 10,
              borderWidth: 3,
              borderColor: DANGER,
              opacity: pan.x.map([-120, 0], [1, 0]),
              transform: [{ rotate: "12deg" }],
            }}
          >
            <Text fontSize={22} fontWeight={800} color={DANGER}>
              NOPE
            </Text>
          </Column>
        </Stack>
      </Stack>

      {/* The same moves without a finger (TalkBack, or a mouse in a test). */}
      <Row style={{ gap: 20, justifyContent: "center", alignItems: "center" }}>
        <Pressable
          onPress={() => void pan.snapTo("left")}
          pressScale={0.94}
          style={{ width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", backgroundColor: c.white, borderWidth: 2, borderColor: DANGER }}
          accessibilityLabel="Skip this dish"
        >
          <Text fontSize={26} fontWeight={800} color={DANGER}>
            ✕
          </Text>
        </Pressable>
        <Column style={{ alignItems: "center", gap: 2 }}>
          <Text fontSize={13} color={c.muted}>
            Liked {liked()} · Skipped {skipped()}
          </Text>
        </Column>
        <Pressable
          onPress={() => void pan.snapTo("right")}
          pressScale={0.94}
          style={{ width: 64, height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", backgroundColor: c.success }}
          accessibilityLabel="Like this dish"
        >
          <Text fontSize={26} fontWeight={800} color={c.white}>
            ♥
          </Text>
        </Pressable>
      </Row>
    </Column>
  )
}

// ---- b) Story viewer --------------------------------------------------------------------------------------------------

function McStoryDemo() {
  const current = signal(0)
  const paused = signal(false)
  const closed = signal(false)

  // One timeline per story. A bar that is done is at 1, one that has not started is at 0.
  const t0 = useTimeline({ duration: STORY_MS })
  const t1 = useTimeline({ duration: STORY_MS })
  const t2 = useTimeline({ duration: STORY_MS })
  const bars = [t0, t1, t2]

  // The element's own size (dp) for the tap: left half goes back, right half goes forward.
  const box = useElementMotion()

  // How much of the current story is left (ms). JS keeps it with a clock: no value is read every frame.
  let left = STORY_MS
  let startedAt = 0

  const run = (i: number, ms: number) => {
    left = ms
    startedAt = Date.now()
    // A timeline's play() always takes the full time, so for the rest of a paused story we use to().
    void bars[i].to(1, { duration: ms, easing: "linear" }).then((r) => {
      if (r.finished && current() === i) next()
    })
  }

  const show = (i: number) => {
    bars.forEach((t, k) => {
      t.stop()
      t.seek(k < i ? 1 : 0)
    })
    current.set(i)
    paused.set(false)
    run(i, STORY_MS)
  }

  const next = () => show((current() + 1) % STORIES.length)
  const back = () => show(Math.max(0, current() - 1))

  const hold = () => {
    if (paused()) return
    paused.set(true)
    left = Math.max(50, left - (Date.now() - startedAt))
    bars[current()].pause()
  }
  const letGo = () => {
    if (!paused()) return
    paused.set(false)
    run(current(), left)
  }

  let holding = false
  const press = useLongPress({
    minDuration: 250,
    onStart: () => {
      holding = true
      hold()
    },
    onFinalize: () => {
      // Also called when the finger lifts before 250 ms (a tap): then nothing was paused.
      if (!holding) return
      holding = false
      letGo()
    },
  })

  const tap = useTap({
    a11yLabel: "Next story. Tap the left side for the story before.",
    onEnd: (e: GestureEvent) => {
      void box.measure().then((r) => {
        if ((e.x ?? 0) < r.width / 2) back()
        else next()
      })
    },
  })

  const close = usePan({
    axis: "y",
    bounds: { y: [0, "100%parent"] },
    anchors: [
      { id: "open", y: 0 },
      { id: "closed", y: "100%parent" },
    ],
    release: { threshold: { velocity: 800, distance: 120 } },
    a11yLabel: "Story. Drag down to close.",
    onSettle: (e: { anchor: string | null }) => {
      if (e.anchor !== "closed") return
      bars.forEach((t) => t.stop())
      closed.set(true)
      // Back to the start, ready for the next time it opens.
      close.y.set(0)
    },
  })

  const reopen = () => {
    closed.set(false)
    show(0)
  }

  // Start the first story.
  show(0)

  // Drag down wins when the finger moves; a short touch is a tap; a hold pauses.
  const gesture = Gesture.race(close, Gesture.exclusive(press, tap))

  return (
    <Column style={{ gap: 14 }}>
      <Column style={{ height: 470, marginHorizontal: 20, borderRadius: 28, overflow: "hidden", backgroundColor: c.pillBg }}>
        <Stack
          gesture={gesture}
          motion={box}
          style={{
            height: 470,
            display: closed() ? "none" : "flex",
            backgroundColor: STORIES[current()].bg,
            transform: [{ translateY: close.y }],
            opacity: close.y.map([0, 300], [1, 0.4]),
          }}
        >
          <Column style={{ position: "absolute", top: 120, start: 24, end: 24, gap: 10 }}>
            <Column style={{ alignSelf: "flex-start", paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8, backgroundColor: "#FFFFFF33" }}>
              <Text fontSize={11} fontWeight={800} color={c.white}>
                {STORIES[current()].tag}
              </Text>
            </Column>
            <Text fontSize={30} fontWeight={800} color={c.white}>
              {STORIES[current()].title}
            </Text>
            <Text fontSize={54} fontWeight={800} color={c.white}>
              {STORIES[current()].amount}
            </Text>
            <Text fontSize={15} color="#FFFFFFCC">
              {STORIES[current()].line}
            </Text>
          </Column>

          {/* The bars. */}
          <Row pointerEvents="none" style={{ position: "absolute", top: 16, start: 16, end: 16, gap: 4 }}>
            <Stack style={{ flex: 1, height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: "#FFFFFF55" }}>
              <Column style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: c.white, transformOrigin: "left", transform: [{ scaleX: t0 }] }} />
            </Stack>
            <Stack style={{ flex: 1, height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: "#FFFFFF55" }}>
              <Column style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: c.white, transformOrigin: "left", transform: [{ scaleX: t1 }] }} />
            </Stack>
            <Stack style={{ flex: 1, height: 4, borderRadius: 2, overflow: "hidden", backgroundColor: "#FFFFFF55" }}>
              <Column style={{ position: "absolute", top: 0, bottom: 0, start: 0, end: 0, backgroundColor: c.white, transformOrigin: "left", transform: [{ scaleX: t2 }] }} />
            </Stack>
          </Row>

          <Row pointerEvents="none" style={{ position: "absolute", top: 32, start: 16, end: 16, alignItems: "center", gap: 8 }}>
            <Column style={{ width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center", backgroundColor: c.white }}>
              <Text fontSize={14} fontWeight={800} color={c.primary}>
                Z
              </Text>
            </Column>
            <Text fontSize={13} fontWeight={700} color={c.white} style={{ flex: 1 }}>
              ZeroBill · {paused() ? "Paused" : "Playing"}
            </Text>
          </Row>
        </Stack>
        {closed() ? (
          <Column style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
            <Text fontSize={15} fontWeight={700} color={c.ink}>
              Story closed
            </Text>
            <McButton label="Open story again" onPress={reopen} />
          </Column>
        ) : null}
      </Column>
    </Column>
  )
}

export function MotionCardsLabScreen() {
  const tab = signal(0)
  const note = signal("")
  const busyOnce = () => {
    busyLoop(200)
    note.set("JS was blocked for 200 ms. Cards and bars kept moving.")
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
          Cards and stories
        </Text>
      </Row>

      <Column style={{ padding: 16, gap: 10 }}>
        <Row style={{ gap: 8 }}>
          <McTab label="Swipe cards" on={tab() === 0} onPress={() => tab.set(0)} />
          <McTab label="Stories" on={tab() === 1} onPress={() => tab.set(1)} />
        </Row>
        <Text fontSize={12} color={c.muted}>
          {tab() === 0
            ? "Flick the top card left (skip) or right (like). Let it go in the middle: it comes back. The card under it grows."
            : "Tap the right side: next. Tap the left side: back. Hold to pause. Drag down to close."}
        </Text>
        <Row style={{ gap: 10, alignItems: "center" }}>
          <McButton label="Keep JS busy 200 ms" onPress={busyOnce} />
          <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
            {note()}
          </Text>
        </Row>
      </Column>

      {tab() === 0 ? <McSwipeDemo /> : <McStoryDemo />}
    </Column>
  )
}
