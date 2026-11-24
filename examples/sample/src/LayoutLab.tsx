// Layout conformance (ARCHITECTURE §9.5, docs/styling-and-layout.md §5): small layouts with fixed sizes, one or more
// per zn flex rule, each measured node reporting its frame through onLayout, checked against the frame the rules
// give. The same bundle runs on Android and iOS, so both renderers are checked by one table. No text in the cases:
// text metrics differ by a pixel or two by design (platform-differences.md).
//
// Log lines (a phone or simulator check reads them, keep the wording): "layout-conformance FAIL <id> expected
// x,y,w,h got x,y,w,h" for each miss, then "layout-conformance <passed>/<total> pass". Frames are x, y relative to
// the parent node (RN onLayout: the parent's top-left, its padding included), width, height, in dp; 1 dp tolerance
// (Android lays out in whole pixels).
//
// Where the doc leaves a case open, the expectation follows android/runtime (the reference renderer) and says so.
import { Box, Column, Modal, NavigationBar, Row, Scroll, Sheet, Stack, StatusBar, StyleSheet, Text } from "@zeronative/ui"
import { signal } from "@zeronative/core"
import { c } from "./tokens"

type Frame = [x: number, y: number, w: number, h: number]

const EXPECT: Record<string, Frame> = {
  // 1. Column stretches children without a width (rule 4); a set width stays.
  c1a: [0, 0, 200, 20], c1b: [0, 20, 50, 20],
  // 2. gap with justifyContent flex-end.
  c2a: [0, 50, 200, 20], c2b: [0, 80, 200, 20],
  // 3. alignItems center.
  c3a: [75, 0, 50, 20],
  // 4. A Column that shrinks to its content (inside alignItems center) doesn't stretch its children (rule 4).
  c4in: [70, 0, 60, 20], c4a: [0, 0, 60, 10], c4b: [0, 10, 0, 10],
  // 5. flex shares what fixed children leave, in proportion (rule 3).
  c5a: [0, 0, 50, 40], c5b: [50, 0, 50, 40], c5c: [100, 0, 100, 40],
  // 6. A Row with a fixed height and alignItems stretch stretches children without a height (rule 4).
  c6a: [0, 0, 50, 40],
  // 7–9. justifyContent space-between / space-evenly / space-around.
  c7a: [0, 0, 20, 20], c7b: [90, 0, 20, 20], c7c: [180, 0, 20, 20],
  c8a: [35, 0, 20, 20], c8b: [90, 0, 20, 20], c8c: [145, 0, 20, 20],
  c9a: [23.33, 0, 20, 20], c9b: [90, 0, 20, 20], c9c: [156.67, 0, 20, 20],
  // 10. A percent of the parent's content box (rule 5); x / y include the parent's padding (RN onLayout).
  c10a: [10, 10, 90, 10],
  // 11. Margins: the box inside the margin (rule 1), never collapsed (rule 6).
  c11a: [5, 5, 190, 20], c11b: [0, 30, 200, 20],
  // 12. Borders take space (rule 2).
  c12a: [4, 4, 10, 10],
  // 13. maxWidth over a stretch; minHeight over a set height.
  c13a: [0, 0, 80, 10], c13b: [0, 10, 20, 30],
  // 14. aspectRatio: the height from the width.
  c14a: [0, 0, 100, 50],
  // 15. A Stack stretches a normal child like a Column (rule 4, 2026-11-05).
  c15a: [0, 0, 200, 10],
  // 16. Absolute children by their insets.
  c16a: [20, 10, 30, 30], c16b: [0, 90, 200, 10], c16c: [0, 0, 200, 100],
  // 17. An absolute child takes no room (R29): the Stack is as tall as its normal child.
  c17s: [0, 0, 200, 40],
  // 18. Pinned on four sides: a definite size (R44).
  c18a: [8, 8, 184, 72],
  // 19. alignSelf over alignItems.
  c19a: [150, 0, 50, 10], c19b: [0, 10, 200, 10],
  // 20. flex with gap in a Row.
  c20a: [0, 0, 95, 10], c20b: [105, 0, 95, 10],
  // 21. flex in a Column with a height.
  c21a: [0, 0, 100, 20], c21b: [0, 20, 100, 80],
  // 22. A Row stretched by its Column has a definite width: flex fills it.
  c22r: [0, 0, 200, 20], c22a: [0, 0, 200, 20],
  // 23. A Stack centred both ways.
  c23a: [80, 40, 40, 20],
  // 24. justifyContent center in a Column with a height.
  c24a: [0, 40, 200, 20],
  // 25. alignItems center in a Row with a height.
  c25a: [0, 15, 20, 10],
  // 26. A Row with a height but alignItems unset doesn't stretch (android/runtime: only an explicit stretch does;
  // RN would stretch). Listed in platform-differences.md as a zn rule.
  c26a: [0, 0, 50, 0],
  // 27. alignSelf stretch in a Stack whose alignItems is center (rule 4: a Stack stretches like a Column).
  c27a: [0, 0, 200, 10],
  // 28. alignSelf stretch in a Row with a height and alignItems flex-start.
  c28a: [0, 0, 50, 40],
  // 29. min beats max (RN): a fixed width and a stretched child, each with minWidth above maxWidth.
  c29a: [0, 0, 80, 10], c29b: [0, 10, 120, 10],
  // 30–36. flexWrap: "wrap" on a Row (registry 24; RN's results, Yoga).
  // 30. gap (both ways): three 60s fit in 200 exactly, two go on the next line.
  c30a: [0, 0, 60, 20], c30b: [70, 0, 60, 20], c30c: [140, 0, 60, 20], c30d: [0, 30, 60, 20], c30e: [70, 30, 60, 20],
  // 31. columnGap 10, rowGap 4, justifyContent center: each line centred on its own.
  c31a: [15, 0, 50, 20], c31b: [75, 0, 50, 20], c31c: [135, 0, 50, 20], c31d: [45, 24, 50, 20], c31e: [105, 24, 50, 20],
  // 32. alignContent center in a Row 100 tall: the two lines together in the middle.
  c32a: [0, 30, 80, 20], c32b: [80, 30, 80, 20], c32c: [0, 50, 80, 20],
  // 33. alignContent space-between: the first line at the top, the last at the bottom.
  c33a: [0, 0, 80, 20], c33b: [80, 0, 80, 20], c33c: [0, 80, 80, 20],
  // 34. alignItems center: within each line (the line is as tall as its tallest child).
  c34a: [0, 10, 90, 20], c34b: [90, 0, 90, 40], c34c: [0, 40, 90, 10],
  // 35. flex 1 takes what is left of its line.
  c35a: [0, 0, 120, 20], c35b: [120, 0, 80, 20], c35c: [0, 20, 150, 20],
  // 36. alignItems stretch: a child without a height is as tall as its line.
  c36a: [0, 0, 90, 40], c36b: [90, 0, 90, 40], c36c: [0, 40, 90, 10],
  // 37. Two width "50%" children share one line (in pixels they can add up to one more than the Row: still one line).
  c37a: [0, 0, 100, 20], c37b: [100, 0, 100, 20], c37c: [0, 20, 100, 20],
  // 38. A Row's "%" child is a percent of the whole Row (RN), not of what the children before it left: two "50%".
  c38a: [0, 0, 100, 20], c38b: [100, 0, 100, 20],
  // 39. "25%" after a fixed 50: 50 wide (25% of 200), at x 50.
  c39a: [0, 0, 50, 20], c39b: [50, 0, 50, 20],
  // 40. RN two columns: "48%" + "48%", space-between, padding 10 (content 180): 86.4 wide each, at 10 and 103.6.
  c40a: [10, 10, 86.4, 20], c40b: [103.6, 10, 86.4, 20],
  // 41–44. min / max on a child sized by its content (2026-11-09: iOS grew a maxWidth child to its max).
  // 41. maxWidth only caps: a 60 wide child in a maxWidth 150 box keeps 60; the next one follows at 60.
  c41a: [0, 0, 60, 10], c41b: [60, 0, 40, 10],
  // 42. minWidth only raises: a 30 wide child in a minWidth 80 box makes it 80.
  c42a: [0, 0, 80, 10], c42b: [80, 0, 40, 10],
  // 43. maxWidth caps a box whose content is wider (160 in a maxWidth 120 box, in a Column that doesn't stretch).
  c43a: [0, 0, 120, 10],
  // 44. ZeroBill's Offer Details pills: space-between, a maxWidth 190 box with 60 of content and a 100 wide box.
  c44a: [0, 0, 60, 10], c44b: [100, 0, 100, 10],
  // 45. ZeroBill's scanner window: width "75%" + aspectRatio 1 in a centring Column 200 wide; an absolute child at its
  // bottom end (iOS drew the box 0 tall, 2026-11-09).
  c45a: [25, 0, 150, 150], c45b: [130, 140, 20, 10],
  // 46. ZeroBill's ListTile: a Row raised to minHeight 56 (padding 8) centres its child; a Column raised to minHeight
  // 100 with justifyContent center centres its child (iOS put both at the top, 2026-11-09).
  c46a: [0, 18, 20, 20], c46b: [0, 45, 20, 10],
  // 47. A Scroll with only maxHeight is as tall as its content, up to the max (ZeroBill's checkout offers sheet: iOS
  // took the whole 400, 2026-11-09).
  c47a: [0, 0, 200, 30], c47b: [0, 30, 200, 100],
  // 48. A Column raised by minWidth (its width not definite) stretches its children to the raised width, as Yoga does,
  // and no wider (rule 4). ZeroBill's notification badge: a flexGrow pill in an absolute ring with minWidth 18 and
  // padding 2 (iOS left the pill 0 wide, 2026-11-24); and a plain child with no width in a minWidth 80 Column.
  // RN's results; Android to check (A102).
  c48a: [18, 0, 18, 18], c48b: [2, 2, 14, 14], c48c: [0, 0, 80, 10],
  // 49. A Sheet, Modal, StatusBar or NavigationBar takes no room in its parent: no gap, no justifyContent share, no
  // place in a wrapped line (Android draws them in their own window or as effects; iOS gave each a gap and a slot
  // until 2026-11-24). gap 10 with a StatusBar first and a Sheet between; space-between with a Sheet last;
  // space-between with a Modal and a NavigationBar after; a wrap Row with a StatusBar between two 95 wide boxes.
  c49a: [0, 0, 200, 20], c49b: [0, 30, 200, 20], c49c: [0, 0, 40, 20], c49d: [160, 0, 40, 20],
  c49e: [0, 0, 200, 20], c49f: [0, 40, 200, 20], c49g: [0, 0, 95, 10], c49h: [105, 0, 95, 10],
  // 50. A flex child's min stays inside its share (Android's znSizeInConstraints): flex 1 + minHeight 80 in a 100 tall
  // Column above a 40 tall footer gets 60 and the footer stays at 60; the same in a Row (minWidth 180 next to 50).
  // iOS drew the child at its min, over the footer, until 2026-11-24.
  c50a: [0, 0, 200, 60], c50b: [0, 60, 200, 40], c50c: [0, 0, 150, 20], c50d: [150, 0, 50, 20],
  // The same with children: the flex child lays them out in its share, not in its min (a flex-end Column, Row and
  // Stack put their child at the share's end, not past it under the footer).
  c50e: [0, 0, 200, 60], c50f: [0, 50, 200, 10], c50g: [0, 0, 150, 20], c50h: [140, 0, 10, 20],
  c50i: [0, 0, 200, 60], c50j: [0, 50, 20, 10],
}

// 51. Content bigger than its box with justifyContent center / flex-end (checked apart from EXPECT: the frames differ by
// design). Android squeezes the child into the box (Compose's constraints); iOS keeps its size and, as Yoga, centres
// it over both ends, or ends it at the box's end. Either way its middle (or its end) is the box's, which is what a
// user sees: a 28 icon in a 24 circle. iOS pinned it to the start until 2026-11-24.
// "layout-overflow <passed>/<total> pass", and "layout-overflow FAIL <id> ..." for each miss.
const OVERFLOW: Record<string, { box: [w: number, h: number]; x: "centre" | "end" | "start"; y: "centre" | "end" | "start" }> = {
  c51a: { box: [24, 24], x: "centre", y: "centre" },  // Row, justify center, align center: 28 x 28 in 24 x 24
  c51b: { box: [40, 24], x: "start", y: "end" },  // Column, justify flex-end: 40 x 30 in 40 x 24
  c51c: { box: [24, 40], x: "end", y: "start" },  // Row, justify flex-end: 30 x 40 in 24 x 40
}
const overflowGot = new Map<string, Frame>()
const overflowSummary = signal("measuring…")
let overflowTimer: ReturnType<typeof setTimeout> | null = null

function checkOverflow(): void {
  const ids = Object.keys(OVERFLOW)
  let passed = 0
  const at = (kind: "centre" | "end" | "start", pos: number, size: number) =>
    kind === "centre" ? pos + size / 2 : kind === "end" ? pos + size : pos
  for (const id of ids) {
    const e = OVERFLOW[id]!
    const g = overflowGot.get(id)
    const ok = g !== undefined &&
      Math.abs(at(e.x, g[0], g[2]) - at(e.x, 0, e.box[0])) <= TOLERANCE &&
      Math.abs(at(e.y, g[1], g[3]) - at(e.y, 0, e.box[1])) <= TOLERANCE
    if (ok) passed++
    else console.info(`layout-overflow FAIL ${id} box ${e.box.join("x")} ${e.x}/${e.y} got ${g ? g.map((v) => Math.round(v * 100) / 100).join(",") : "nothing"}`)
  }
  overflowSummary.set(`${passed}/${ids.length} pass`)
  console.info(`layout-overflow ${passed}/${ids.length} pass`)
}

function LO(id: string) {
  return (e: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => {
    const l = e.nativeEvent.layout
    overflowGot.set(id, [l.x, l.y, l.width, l.height])
    if (overflowTimer) clearTimeout(overflowTimer)
    overflowTimer = setTimeout(checkOverflow, 600)
  }
}

const TOLERANCE = 1

const got = new Map<string, Frame>()
const summary = signal("measuring…")
const misses = signal<string[]>([])
let timer: ReturnType<typeof setTimeout> | null = null

function check(): void {
  const ids = Object.keys(EXPECT)
  const fails: string[] = []
  for (const id of ids) {
    const e = EXPECT[id]!
    const g = got.get(id)
    const ok = g !== undefined && e.every((v, k) => Math.abs(v - g[k]!) <= TOLERANCE)
    if (!ok) {
      const line = `${id} expected ${e.join(",")} got ${g ? g.map((v) => Math.round(v * 100) / 100).join(",") : "nothing"}`
      fails.push(line)
      console.info(`layout-conformance FAIL ${line}`)
    }
  }
  summary.set(`${ids.length - fails.length}/${ids.length} pass`)
  misses.set(fails)
  console.info(`layout-conformance ${ids.length - fails.length}/${ids.length} pass`)
}

/** onLayout for node [id]: keeps its frame and checks everything once frames stop arriving. */
function L(id: string) {
  return (e: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => {
    const l = e.nativeEvent.layout
    got.set(id, [l.x, l.y, l.width, l.height])
    if (timer) clearTimeout(timer)
    timer = setTimeout(check, 600)
  }
}

const A = "#C7D2FE"
const B = "#4F46E5"
const BG = "#F3F4F6"

function Case(props: { title: string; children: unknown }) {
  return (
    <Column gap={4} alignItems="flex-start">
      <Text fontSize={12} color={c.muted}>
        {props.title}
      </Text>
      {props.children}
    </Column>
  )
}

export function LayoutLabScreen() {
  return (
    <Scroll style={{ flex: 1, backgroundColor: c.white }}>
      <Column gap={14} style={{ padding: 16 }}>
        <Text testID="layout-summary" fontSize={16} fontWeight={700} color={c.ink}>
          {`Layout conformance: ${summary()}`}
        </Text>
        {misses().length > 0 && (
          <Text fontSize={11} color="#B91C1C">
            {misses().join("\n")}
          </Text>
        )}

        <Case title="1. Column stretch">
          <Column style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c1a" onLayout={L("c1a")} style={{ height: 20, backgroundColor: A }} />
            <Box testID="c1b" onLayout={L("c1b")} style={{ width: 50, height: 20, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="2. gap + flex-end">
          <Column gap={10} justifyContent="flex-end" style={{ width: 200, height: 100, backgroundColor: BG }}>
            <Box testID="c2a" onLayout={L("c2a")} style={{ height: 20, backgroundColor: A }} />
            <Box testID="c2b" onLayout={L("c2b")} style={{ height: 20, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="3. alignItems center">
          <Column alignItems="center" style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c3a" onLayout={L("c3a")} style={{ width: 50, height: 20, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="4. a shrunk Column doesn't stretch">
          <Column alignItems="center" style={{ width: 200, backgroundColor: BG }}>
            <Column testID="c4in" onLayout={L("c4in")} style={{ backgroundColor: A }}>
              <Box testID="c4a" onLayout={L("c4a")} style={{ width: 60, height: 10, backgroundColor: B }} />
              <Box testID="c4b" onLayout={L("c4b")} style={{ height: 10, backgroundColor: "#F59E0B" }} />
            </Column>
          </Column>
        </Case>
        <Case title="5. flex 1 and 2">
          <Row style={{ width: 200, height: 40, backgroundColor: BG }}>
            <Box testID="c5a" onLayout={L("c5a")} style={{ width: 50, height: 40, backgroundColor: A }} />
            <Box testID="c5b" onLayout={L("c5b")} style={{ flex: 1, height: 40, backgroundColor: B }} />
            <Box testID="c5c" onLayout={L("c5c")} style={{ flex: 2, height: 40, backgroundColor: "#F59E0B" }} />
          </Row>
        </Case>
        <Case title="6. Row stretch">
          <Row alignItems="stretch" style={{ width: 200, height: 40, backgroundColor: BG }}>
            <Box testID="c6a" onLayout={L("c6a")} style={{ width: 50, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="7. space-between">
          <Row justifyContent="space-between" style={{ width: 200, height: 20, backgroundColor: BG }}>
            <Box testID="c7a" onLayout={L("c7a")} style={{ width: 20, height: 20, backgroundColor: B }} />
            <Box testID="c7b" onLayout={L("c7b")} style={{ width: 20, height: 20, backgroundColor: B }} />
            <Box testID="c7c" onLayout={L("c7c")} style={{ width: 20, height: 20, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="8. space-evenly">
          <Row justifyContent="space-evenly" style={{ width: 200, height: 20, backgroundColor: BG }}>
            <Box testID="c8a" onLayout={L("c8a")} style={{ width: 20, height: 20, backgroundColor: B }} />
            <Box testID="c8b" onLayout={L("c8b")} style={{ width: 20, height: 20, backgroundColor: B }} />
            <Box testID="c8c" onLayout={L("c8c")} style={{ width: 20, height: 20, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="9. space-around">
          <Row justifyContent="space-around" style={{ width: 200, height: 20, backgroundColor: BG }}>
            <Box testID="c9a" onLayout={L("c9a")} style={{ width: 20, height: 20, backgroundColor: B }} />
            <Box testID="c9b" onLayout={L("c9b")} style={{ width: 20, height: 20, backgroundColor: B }} />
            <Box testID="c9c" onLayout={L("c9c")} style={{ width: 20, height: 20, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="10. percent in a padded parent">
          <Column style={{ width: 200, padding: 10, backgroundColor: BG }}>
            <Box testID="c10a" onLayout={L("c10a")} style={{ width: "50%", height: 10, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="11. margin">
          <Column style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c11a" onLayout={L("c11a")} style={{ height: 20, margin: 5, backgroundColor: A }} />
            <Box testID="c11b" onLayout={L("c11b")} style={{ height: 20, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="12. border takes space">
          <Box style={{ width: 100, height: 60, borderWidth: 4, borderColor: B, backgroundColor: BG }}>
            <Box testID="c12a" onLayout={L("c12a")} style={{ width: 10, height: 10, backgroundColor: B }} />
          </Box>
        </Case>
        <Case title="13. maxWidth, minHeight">
          <Column style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c13a" onLayout={L("c13a")} style={{ height: 10, maxWidth: 80, backgroundColor: A }} />
            <Box testID="c13b" onLayout={L("c13b")} style={{ width: 20, minHeight: 30, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="14. aspectRatio">
          <Column style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c14a" onLayout={L("c14a")} style={{ width: 100, aspectRatio: 2, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="15. Stack stretches a normal child">
          <Stack style={{ width: 200, height: 100, backgroundColor: BG }}>
            <Column testID="c15a" onLayout={L("c15a")} style={{ backgroundColor: A }}>
              <Box style={{ height: 10 }} />
            </Column>
          </Stack>
        </Case>
        <Case title="16. absolute insets">
          <Stack style={{ width: 200, height: 100, backgroundColor: BG }}>
            <Box testID="c16c" onLayout={L("c16c")} style={[StyleSheet.absoluteFill, { backgroundColor: "#E0E7FF" }]} />
            <Box testID="c16a" onLayout={L("c16a")} style={{ position: "absolute", top: 10, start: 20, width: 30, height: 30, backgroundColor: B }} />
            <Box testID="c16b" onLayout={L("c16b")} style={{ position: "absolute", start: 0, end: 0, bottom: 0, height: 10, backgroundColor: "#F59E0B" }} />
          </Stack>
        </Case>
        <Case title="17. absolute takes no room">
          <Column style={{ width: 200 }}>
            <Stack testID="c17s" onLayout={L("c17s")} style={{ backgroundColor: BG }}>
              <Box style={{ height: 40, backgroundColor: A }} />
              <Box style={{ position: "absolute", top: 0, start: 0, width: 10, height: 300, backgroundColor: "#F59E0B33" }} />
            </Stack>
          </Column>
        </Case>
        <Box style={{ height: 40 }} />
        <Case title="18. pinned on four sides">
          <Stack style={{ width: 200, height: 80, backgroundColor: BG }}>
            <Column testID="c18a" onLayout={L("c18a")} style={{ position: "absolute", top: 8, start: 8, end: 8, bottom: 0, backgroundColor: A }} />
          </Stack>
        </Case>
        <Case title="19. alignSelf">
          <Column alignItems="flex-start" style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c19a" onLayout={L("c19a")} style={{ width: 50, height: 10, alignSelf: "flex-end", backgroundColor: B }} />
            <Box testID="c19b" onLayout={L("c19b")} style={{ height: 10, alignSelf: "stretch", backgroundColor: A }} />
          </Column>
        </Case>
        <Case title="20. flex with gap">
          <Row gap={10} style={{ width: 200, height: 10, backgroundColor: BG }}>
            <Box testID="c20a" onLayout={L("c20a")} style={{ flex: 1, height: 10, backgroundColor: A }} />
            <Box testID="c20b" onLayout={L("c20b")} style={{ flex: 1, height: 10, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="21. flex in a Column">
          <Column style={{ width: 100, height: 100, backgroundColor: BG }}>
            <Box testID="c21a" onLayout={L("c21a")} style={{ height: 20, backgroundColor: A }} />
            <Box testID="c21b" onLayout={L("c21b")} style={{ flex: 1, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="22. a stretched Row's flex child">
          <Column style={{ width: 200, backgroundColor: BG }}>
            <Row testID="c22r" onLayout={L("c22r")} style={{ height: 20 }}>
              <Box testID="c22a" onLayout={L("c22a")} style={{ flex: 1, height: 20, backgroundColor: A }} />
            </Row>
          </Column>
        </Case>
        <Case title="23. Stack centred">
          <Stack alignItems="center" justifyContent="center" style={{ width: 200, height: 100, backgroundColor: BG }}>
            <Box testID="c23a" onLayout={L("c23a")} style={{ width: 40, height: 20, backgroundColor: B }} />
          </Stack>
        </Case>
        <Case title="24. justifyContent center">
          <Column justifyContent="center" style={{ width: 200, height: 100, backgroundColor: BG }}>
            <Box testID="c24a" onLayout={L("c24a")} style={{ height: 20, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="25. Row alignItems center">
          <Row alignItems="center" style={{ width: 200, height: 40, backgroundColor: BG }}>
            <Box testID="c25a" onLayout={L("c25a")} style={{ width: 20, height: 10, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="26. Row with a height, alignItems unset">
          <Row style={{ width: 200, height: 40, backgroundColor: BG }}>
            <Box testID="c26a" onLayout={L("c26a")} style={{ width: 50, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="27. Stack: alignSelf stretch">
          <Stack alignItems="center" style={{ width: 200, height: 40, backgroundColor: BG }}>
            <Box testID="c27a" onLayout={L("c27a")} style={{ height: 10, alignSelf: "stretch", backgroundColor: B }} />
          </Stack>
        </Case>
        <Case title="28. Row: alignSelf stretch">
          <Row alignItems="flex-start" style={{ width: 200, height: 40, backgroundColor: BG }}>
            <Box testID="c28a" onLayout={L("c28a")} style={{ width: 50, alignSelf: "stretch", backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="29. min beats max">
          <Column style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c29a" onLayout={L("c29a")} style={{ width: 50, height: 10, minWidth: 80, maxWidth: 60, alignSelf: "flex-start", backgroundColor: A }} />
            <Box testID="c29b" onLayout={L("c29b")} style={{ height: 10, minWidth: 120, maxWidth: 100, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="30. wrap with gap">
          <Row gap={10} style={{ width: 200, flexWrap: "wrap", backgroundColor: BG }}>
            <Box testID="c30a" onLayout={L("c30a")} style={{ width: 60, height: 20, backgroundColor: A }} />
            <Box testID="c30b" onLayout={L("c30b")} style={{ width: 60, height: 20, backgroundColor: B }} />
            <Box testID="c30c" onLayout={L("c30c")} style={{ width: 60, height: 20, backgroundColor: A }} />
            <Box testID="c30d" onLayout={L("c30d")} style={{ width: 60, height: 20, backgroundColor: B }} />
            <Box testID="c30e" onLayout={L("c30e")} style={{ width: 60, height: 20, backgroundColor: A }} />
          </Row>
        </Case>
        <Case title="31. wrap: columnGap, rowGap, center">
          <Row justifyContent="center" style={{ width: 200, flexWrap: "wrap", columnGap: 10, rowGap: 4, backgroundColor: BG }}>
            <Box testID="c31a" onLayout={L("c31a")} style={{ width: 50, height: 20, backgroundColor: A }} />
            <Box testID="c31b" onLayout={L("c31b")} style={{ width: 50, height: 20, backgroundColor: B }} />
            <Box testID="c31c" onLayout={L("c31c")} style={{ width: 50, height: 20, backgroundColor: A }} />
            <Box testID="c31d" onLayout={L("c31d")} style={{ width: 50, height: 20, backgroundColor: B }} />
            <Box testID="c31e" onLayout={L("c31e")} style={{ width: 50, height: 20, backgroundColor: A }} />
          </Row>
        </Case>
        <Case title="32. wrap: alignContent center">
          <Row style={{ width: 200, height: 100, flexWrap: "wrap", alignContent: "center", backgroundColor: BG }}>
            <Box testID="c32a" onLayout={L("c32a")} style={{ width: 80, height: 20, backgroundColor: A }} />
            <Box testID="c32b" onLayout={L("c32b")} style={{ width: 80, height: 20, backgroundColor: B }} />
            <Box testID="c32c" onLayout={L("c32c")} style={{ width: 80, height: 20, backgroundColor: A }} />
          </Row>
        </Case>
        <Case title="33. wrap: alignContent space-between">
          <Row style={{ width: 200, height: 100, flexWrap: "wrap", alignContent: "space-between", backgroundColor: BG }}>
            <Box testID="c33a" onLayout={L("c33a")} style={{ width: 80, height: 20, backgroundColor: A }} />
            <Box testID="c33b" onLayout={L("c33b")} style={{ width: 80, height: 20, backgroundColor: B }} />
            <Box testID="c33c" onLayout={L("c33c")} style={{ width: 80, height: 20, backgroundColor: A }} />
          </Row>
        </Case>
        <Case title="34. wrap: alignItems center">
          <Row alignItems="center" style={{ width: 200, flexWrap: "wrap", backgroundColor: BG }}>
            <Box testID="c34a" onLayout={L("c34a")} style={{ width: 90, height: 20, backgroundColor: A }} />
            <Box testID="c34b" onLayout={L("c34b")} style={{ width: 90, height: 40, backgroundColor: B }} />
            <Box testID="c34c" onLayout={L("c34c")} style={{ width: 90, height: 10, backgroundColor: A }} />
          </Row>
        </Case>
        <Case title="35. wrap: flex fills the line">
          <Row style={{ width: 200, flexWrap: "wrap", backgroundColor: BG }}>
            <Box testID="c35a" onLayout={L("c35a")} style={{ width: 120, height: 20, backgroundColor: A }} />
            <Box testID="c35b" onLayout={L("c35b")} style={{ height: 20, flex: 1, backgroundColor: B }} />
            <Box testID="c35c" onLayout={L("c35c")} style={{ width: 150, height: 20, backgroundColor: A }} />
          </Row>
        </Case>
        <Case title="37. wrap: 50% columns">
          <Row style={{ width: 200, flexWrap: "wrap", backgroundColor: BG }}>
            <Box testID="c37a" onLayout={L("c37a")} style={{ width: "50%", height: 20, backgroundColor: A }} />
            <Box testID="c37b" onLayout={L("c37b")} style={{ width: "50%", height: 20, backgroundColor: B }} />
            <Box testID="c37c" onLayout={L("c37c")} style={{ width: "50%", height: 20, backgroundColor: A }} />
          </Row>
        </Case>
        <Case title="38. Row: two 50%">
          <Row style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c38a" onLayout={L("c38a")} style={{ width: "50%", height: 20, backgroundColor: A }} />
            <Box testID="c38b" onLayout={L("c38b")} style={{ width: "50%", height: 20, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="39. Row: 25% after a fixed 50">
          <Row style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c39a" onLayout={L("c39a")} style={{ width: 50, height: 20, backgroundColor: A }} />
            <Box testID="c39b" onLayout={L("c39b")} style={{ width: "25%", height: 20, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="40. Row: 48% + 48%, space-between, padding">
          <Row justifyContent="space-between" style={{ width: 200, padding: 10, backgroundColor: BG }}>
            <Box testID="c40a" onLayout={L("c40a")} style={{ width: "48%", height: 20, backgroundColor: A }} />
            <Box testID="c40b" onLayout={L("c40b")} style={{ width: "48%", height: 20, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="41. maxWidth only caps">
          <Row style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c41a" onLayout={L("c41a")} style={{ maxWidth: 150, backgroundColor: A }}>
              <Box style={{ width: 60, height: 10 }} />
            </Box>
            <Box testID="c41b" onLayout={L("c41b")} style={{ width: 40, height: 10, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="42. minWidth only raises">
          <Row style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c42a" onLayout={L("c42a")} style={{ minWidth: 80, backgroundColor: A }}>
              <Box style={{ width: 30, height: 10 }} />
            </Box>
            <Box testID="c42b" onLayout={L("c42b")} style={{ width: 40, height: 10, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="43. maxWidth caps wider content">
          <Column alignItems="flex-start" style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c43a" onLayout={L("c43a")} style={{ maxWidth: 120, overflow: "hidden", backgroundColor: A }}>
              <Box style={{ width: 160, height: 10 }} />
            </Box>
          </Column>
        </Case>
        <Case title="44. space-between with a maxWidth pill">
          <Row justifyContent="space-between" style={{ width: 200, backgroundColor: BG }}>
            <Box testID="c44a" onLayout={L("c44a")} style={{ maxWidth: 190, backgroundColor: A }}>
              <Box style={{ width: 60, height: 10 }} />
            </Box>
            <Box testID="c44b" onLayout={L("c44b")} style={{ width: 100, height: 10, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="45. % width + aspectRatio, absolute child">
          <Column alignItems="center" style={{ width: 200, backgroundColor: BG }}>
            <Stack testID="c45a" onLayout={L("c45a")} style={{ width: "75%", aspectRatio: 1, backgroundColor: A }}>
              <Box testID="c45b" onLayout={L("c45b")} style={{ position: "absolute", bottom: 0, end: 0, width: 20, height: 10, backgroundColor: B }} />
            </Stack>
          </Column>
        </Case>
        <Case title="46. minHeight raises a box: children aligned in it">
          <Row alignItems="center" style={{ width: 200, minHeight: 56, paddingTop: 8, paddingBottom: 8, backgroundColor: BG }}>
            <Box testID="c46a" onLayout={L("c46a")} style={{ width: 20, height: 20, backgroundColor: A }} />
          </Row>
          <Column justifyContent="center" alignItems="flex-start" style={{ width: 200, minHeight: 100, backgroundColor: BG }}>
            <Box testID="c46b" onLayout={L("c46b")} style={{ width: 20, height: 10, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="47. Scroll with maxHeight hugs its content">
          <Column style={{ width: 200, backgroundColor: BG }}>
            <Scroll testID="c47a" onLayout={L("c47a")} style={{ maxHeight: 100, backgroundColor: A }}>
              <Box style={{ height: 30 }} />
            </Scroll>
            <Scroll testID="c47b" onLayout={L("c47b")} style={{ maxHeight: 100, backgroundColor: B }}>
              <Box style={{ height: 150 }} />
            </Scroll>
          </Column>
        </Case>
        <Case title="48. minWidth raises a Column: its children stretch to it">
          <Column alignItems="flex-start" style={{ width: 200, backgroundColor: BG }}>
            <Stack style={{ width: 36, height: 36 }}>
              <Box testID="c48a" onLayout={L("c48a")} style={{ position: "absolute", top: 0, end: 0, height: 18, minWidth: 18, padding: 2, backgroundColor: A }}>
                <Box testID="c48b" onLayout={L("c48b")} style={{ flexGrow: 1, height: 14, backgroundColor: B }} />
              </Box>
            </Stack>
            <Column style={{ minWidth: 80, backgroundColor: A }}>
              <Box testID="c48c" onLayout={L("c48c")} style={{ height: 10, backgroundColor: B }} />
            </Column>
          </Column>
        </Case>
        <Case title="36. wrap: alignItems stretch">
          <Row alignItems="stretch" style={{ width: 200, flexWrap: "wrap", backgroundColor: BG }}>
            <Box testID="c36a" onLayout={L("c36a")} style={{ width: 90, backgroundColor: A }} />
            <Box testID="c36b" onLayout={L("c36b")} style={{ width: 90, height: 40, backgroundColor: B }} />
            <Box testID="c36c" onLayout={L("c36c")} style={{ width: 90, height: 10, backgroundColor: A }} />
          </Row>
        </Case>
        <Case title="49. Sheet, Modal and bars take no room">
          <Column gap={10} style={{ width: 200, backgroundColor: BG }}>
            <StatusBar />
            <Box testID="c49a" onLayout={L("c49a")} style={{ height: 20, backgroundColor: A }} />
            <Sheet visible={false}>
              <Box style={{ height: 20 }} />
            </Sheet>
            <Box testID="c49b" onLayout={L("c49b")} style={{ height: 20, backgroundColor: B }} />
          </Column>
          <Row justifyContent="space-between" style={{ width: 200, height: 20, backgroundColor: BG }}>
            <Box testID="c49c" onLayout={L("c49c")} style={{ width: 40, height: 20, backgroundColor: A }} />
            <Box testID="c49d" onLayout={L("c49d")} style={{ width: 40, height: 20, backgroundColor: B }} />
            <Sheet visible={false}>
              <Box style={{ height: 20 }} />
            </Sheet>
          </Row>
          <Column justifyContent="space-between" style={{ width: 200, height: 60, backgroundColor: BG }}>
            <Box testID="c49e" onLayout={L("c49e")} style={{ height: 20, backgroundColor: A }} />
            <Box testID="c49f" onLayout={L("c49f")} style={{ height: 20, backgroundColor: B }} />
            <Modal visible={false}>
              <Box style={{ height: 20 }} />
            </Modal>
            <NavigationBar />
          </Column>
          <Row gap={10} style={{ width: 200, flexWrap: "wrap", backgroundColor: BG }}>
            <Box testID="c49g" onLayout={L("c49g")} style={{ width: 95, height: 10, backgroundColor: A }} />
            <StatusBar />
            <Box testID="c49h" onLayout={L("c49h")} style={{ width: 95, height: 10, backgroundColor: B }} />
          </Row>
        </Case>
        <Case title="50. A flex child's min stays in its share">
          <Column style={{ width: 200, height: 100, backgroundColor: BG }}>
            <Box testID="c50a" onLayout={L("c50a")} style={{ flex: 1, minHeight: 80, backgroundColor: A }} />
            <Box testID="c50b" onLayout={L("c50b")} style={{ height: 40, backgroundColor: B }} />
          </Column>
          <Row style={{ width: 200, height: 20, backgroundColor: BG }}>
            <Box testID="c50c" onLayout={L("c50c")} style={{ flex: 1, minWidth: 180, height: 20, backgroundColor: A }} />
            <Box testID="c50d" onLayout={L("c50d")} style={{ width: 50, height: 20, backgroundColor: B }} />
          </Row>
          <Column style={{ width: 200, height: 100, backgroundColor: BG }}>
            <Column testID="c50e" onLayout={L("c50e")} justifyContent="flex-end" style={{ flex: 1, minHeight: 80, backgroundColor: A }}>
              <Box testID="c50f" onLayout={L("c50f")} style={{ height: 10, backgroundColor: B }} />
            </Column>
            <Box style={{ height: 40, backgroundColor: B }} />
          </Column>
          <Row style={{ width: 200, height: 20, backgroundColor: BG }}>
            <Row testID="c50g" onLayout={L("c50g")} justifyContent="flex-end" style={{ flex: 1, minWidth: 180, height: 20, backgroundColor: A }}>
              <Box testID="c50h" onLayout={L("c50h")} style={{ width: 10, height: 20, backgroundColor: B }} />
            </Row>
            <Box style={{ width: 50, height: 20, backgroundColor: B }} />
          </Row>
          <Column style={{ width: 200, height: 100, backgroundColor: BG }}>
            <Stack testID="c50i" onLayout={L("c50i")} justifyContent="flex-end" style={{ flex: 1, minHeight: 80, backgroundColor: A }}>
              <Box testID="c50j" onLayout={L("c50j")} style={{ width: 20, height: 10, backgroundColor: B }} />
            </Stack>
            <Box style={{ height: 40, backgroundColor: B }} />
          </Column>
        </Case>
        <Case title="51. Content bigger than its box: centred / at the end">
          <Text testID="layout-overflow-summary" fontSize={12} color={c.ink}>
            {`Overflow: ${overflowSummary()}`}
          </Text>
          <Row gap={24} alignItems="center" style={{ padding: 10 }}>
            <Row justifyContent="center" alignItems="center" style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: BG }}>
              <Box testID="c51a" onLayout={LO("c51a")} style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: B }} />
            </Row>
            <Column justifyContent="flex-end" style={{ width: 40, height: 24, backgroundColor: BG }}>
              <Box testID="c51b" onLayout={LO("c51b")} style={{ width: 40, height: 30, borderWidth: 2, borderColor: B }} />
            </Column>
            <Row justifyContent="flex-end" style={{ width: 24, height: 40, backgroundColor: BG }}>
              <Box testID="c51c" onLayout={LO("c51c")} style={{ width: 30, height: 40, borderWidth: 2, borderColor: B }} />
            </Row>
          </Row>
        </Case>
      </Column>
    </Scroll>
  )
}
