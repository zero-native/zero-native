// The scroll around a gesture wins at its own slop (round 7 review, ZnGestureHub's held pans), and a Sheet whose node
// leaves in the user's close. Each screen has a status line a UI test reads (ios/SamplePackage/ZnSampleUITests/
// ScrollWinsTests.swift). Open with: bun run tools/ios-sample.ts --route scrollWinsLab (or scrollWinsLongLab,
// scrollWinsSheetLab).
//   a) scrollWinsLab: a List of rows that swipe sideways with only activeOffsetX (no failOffsetY, as many RNGH swipe
//      rows): a drag up still scrolls the List (on Android the List consumes at its slop and the row gives up).
//   b) scrollWinsLongLab: rows with a long press that allows 30 dp of movement: a drag up scrolls the List at the
//      List's slop, not at 30.
//   c) scrollWinsSheetLab: {open && <Sheet>} that onDismiss turns false: a flick close slides it down and it goes.
import { Column, List, Pressable, Sheet, Stack, Text } from "@zeronative/ui"
import { signal, useElementMotion, useLongPress, usePan } from "@zeronative/core"
import { c } from "./tokens"

const ROWS = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, name: `Row ${i + 1}` }))

function SwHeader(props: { title: string; note: string; status: string }) {
  return (
    <Column style={{ padding: 16, gap: 6, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
      <Text fontSize={18} fontWeight={700} color={c.ink}>
        {props.title}
      </Text>
      <Text fontSize={12} color={c.muted}>
        {props.note}
      </Text>
      <Text testID="sw-status" fontSize={13} color={c.ink}>
        {props.status}
      </Text>
    </Column>
  )
}

function SwSwipeRow(props: { name: string; onSwipe: () => void }) {
  // Only activeOffsetX: it never fails on an up or down move by itself.
  const pan = usePan({ activeOffsetX: [-12, 12], onStart: () => props.onSwipe() })
  return (
    <Stack
      gesture={pan}
      style={{ paddingHorizontal: 16, paddingVertical: 18, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border, transform: [{ translateX: pan.x }] }}
    >
      <Text fontSize={15} color={c.ink}>
        {props.name} · swipe me sideways
      </Text>
    </Stack>
  )
}

export function ScrollWinsLabScreen() {
  const y = signal(0)
  const swipes = signal(0)
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <SwHeader
        title="a) Swipe rows, activeOffsetX only"
        note="Drag up on a row: the List scrolls. Drag a row sideways: it moves."
        status={`scrolled ${y()} swipes ${swipes()}`}
      />
      <List
        testID="sw-list"
        data={ROWS}
        key={(r) => String(r.id)}
        style={{ flex: 1 }}
        onScroll={(e) => y.set(Math.round(e.nativeEvent.contentOffset.y))}
        row={(r) => <SwSwipeRow name={r.name} onSwipe={() => swipes.set(swipes() + 1)} />}
      />
    </Column>
  )
}

function SwLongRow(props: { name: string; onLong: () => void }) {
  const long = useLongPress({ maxDistance: 30, onStart: () => props.onLong() })
  return (
    <Stack gesture={long} style={{ paddingHorizontal: 16, paddingVertical: 18, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
      <Text fontSize={15} color={c.ink}>
        {props.name} · long press me
      </Text>
    </Stack>
  )
}

export function ScrollWinsLongLabScreen() {
  const y = signal(0)
  const longs = signal(0)
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <SwHeader
        title="b) Long press, maxDistance 30"
        note="Drag up on a row: the List scrolls from its own slop. Hold still: the long press starts."
        status={`scrolled ${y()} long ${longs()}`}
      />
      <List
        testID="sw-list"
        data={ROWS}
        key={(r) => String(r.id)}
        style={{ flex: 1 }}
        onScroll={(e) => y.set(Math.round(e.nativeEvent.contentOffset.y))}
        row={(r) => <SwLongRow name={r.name} onLong={() => longs.set(longs() + 1)} />}
      />
    </Column>
  )
}

export function ScrollWinsSheetLabScreen() {
  const open = signal(false)
  const closes = signal(0)
  const m = useElementMotion()
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <SwHeader
        title="c) {open && <Sheet>}"
        note="Open it, then flick it down: it slides down and goes (its node leaves the tree in onDismiss)."
        status={`${open() ? "open" : "closed"} closes ${closes()}`}
      />
      <Text testID="sw-progress" fontSize={13} color={c.ink} style={{ padding: 16 }}>
        {m.progress.map([0, 1], [0, 100]).format({ decimals: 0, prefix: "progress ", suffix: "%" })}
      </Text>
      <Pressable
        testID="sw-open"
        onPress={() => open.set(true)}
        style={{ margin: 16, padding: 14, borderRadius: 12, alignItems: "center", backgroundColor: c.primary }}
      >
        <Text fontSize={15} fontWeight={700} color={c.white}>
          Open the sheet
        </Text>
      </Pressable>
      {open() && (
        <Sheet
          visible={true}
          motion={m}
          detents="half"
          onDismiss={() => {
            closes.set(closes() + 1)
            open.set(false)
          }}
        >
          <Column testID="sw-sheet" style={{ padding: 20, gap: 12 }}>
            <Text fontSize={18} fontWeight={800} color={c.ink}>
              A sheet that leaves the tree
            </Text>
            {ROWS.slice(0, 6).map((r) => (
              <Text key={String(r.id)} fontSize={15} color={c.ink}>
                {r.name}
              </Text>
            ))}
          </Column>
        </Sheet>
      )}
    </Column>
  )
}
