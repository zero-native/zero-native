// Paint parity (polish round B, 2026-11-24): what a screenshot on Android and iOS should show the same way.
// 1. A rounded Pressable clips its children to its corners (Android's clipsByDefault: a Pressable whose ripple isn't
//    borderless, an Image, a Shimmer); a rounded Box doesn't (only overflow: "hidden" clips it), nor does a Pressable
//    with a borderless ripple.
// 2. opacity fades a node as one picture: two overlapping squares at opacity 0.5 show no darker overlap, and the
//    container's own background doesn't show through its children.
// 3. elevation casts a shadow from the node's shape whether or not it has a backgroundColor (a picture card). The
//    shadow shows only outside the shape (Android's caster is opaque), so a translucent card and an empty box with
//    only a border stay see-through: the row's stripe shows through them, not a grey slab.
// 4. Under opacity (drawn as one picture) and in a rounded Pressable (clipped), UIKit-backed parts still draw and take
//    touches: a Pressable counts taps, a TextField takes typing.
// 5. An enter / exit fade fades the element as one picture too (round 6, 2026-11-24).
// 6. A picture that isn't in memory fades in over 150 ms, as Coil's crossfade; one in memory shows at once.
// 7. The same in a List's recycled rows: once its two pictures are in memory, rows scrolled in again don't fade.
import { Box, Column, Image, List, Pressable, Row, Scroll, Stack, Text, TextField } from "@zeronative/ui"
import { signal } from "@zeronative/core"
import { c } from "./tokens"

const taps = signal(0)
const typed = signal("")
const entered = signal(false)
const pictureRows = Array.from({ length: 40 }, (_, i) => ({
  id: `p${i}`,
  src: i % 2 === 0 ? "asset:images/canvas-test.png" : "asset:images/offer-placeholder.png",
}))
const picture = signal("asset:images/offer-placeholder.png")

const A = "#EF4444"
const B = "#2563EB"

function PaintTitle(props: { text: string }) {
  return (
    <Text fontSize={13} color={c.muted} style={{ marginTop: 6 }}>
      {props.text}
    </Text>
  )
}

/** A card: a coloured strip at the top that reaches into the rounded corners. */
function PaintStrip() {
  return <Box style={{ height: 36, backgroundColor: B }} />
}

/** Two overlapping squares on a light background, at [opacity] (from a prop, so a slot). */
function PaintOverlap(props: { opacity: number }) {
  return (
    <Stack style={{ width: 70, height: 60, opacity: props.opacity, backgroundColor: "#FDE68A" }}>
      <Box style={{ position: "absolute", top: 6, start: 6, width: 40, height: 40, backgroundColor: A }} />
      <Box style={{ position: "absolute", top: 14, start: 24, width: 40, height: 40, backgroundColor: B }} />
    </Stack>
  )
}

export function PaintLabScreen() {
  return (
    <Scroll style={{ flex: 1, backgroundColor: c.white }}>
      <Column gap={10} style={{ padding: 16 }}>
        <Text testID="paint-title" fontSize={16} fontWeight={700} color={c.ink}>
          Paint parity
        </Text>

        <PaintTitle text="1. Rounded Pressable clips (round corners), rounded Box doesn't (square), borderless ripple doesn't" />
        <Row gap={10}>
          <Pressable testID="clip-press" onPress={() => {}} style={{ width: 100, height: 70, borderRadius: 18, borderWidth: 1, borderColor: c.ink }}>
            <PaintStrip />
          </Pressable>
          <Box testID="clip-box" style={{ width: 100, height: 70, borderRadius: 18, borderWidth: 1, borderColor: c.ink }}>
            <PaintStrip />
          </Box>
          <Pressable testID="clip-borderless" rippleBorderless onPress={() => {}} style={{ width: 100, height: 70, borderRadius: 18, borderWidth: 1, borderColor: c.ink }}>
            <PaintStrip />
          </Pressable>
        </Row>

        <PaintTitle text="2. opacity 0.5 from a slot, written 0.5: one picture (no darker overlap, no yellow under the squares); 1; a pressOpacity 0.4 Pressable" />
        <Row gap={10}>
          <PaintOverlap opacity={0.5} />
          <Stack testID="fade-static" style={{ width: 70, height: 60, opacity: 0.5, backgroundColor: "#FDE68A" }}>
            <Box style={{ position: "absolute", top: 6, start: 6, width: 40, height: 40, backgroundColor: A }} />
            <Box style={{ position: "absolute", top: 14, start: 24, width: 40, height: 40, backgroundColor: B }} />
          </Stack>
          <PaintOverlap opacity={1} />
          <Pressable testID="fade-press" pressOpacity={0.4} onPress={() => {}}>
            <PaintOverlap opacity={1} />
          </Pressable>
        </Row>

        <PaintTitle text="3. elevation 8: white card; picture card; translucent; empty with a border" />
        <Stack style={{ backgroundColor: "#F3F4F6" }}>
          <Box style={{ position: "absolute", left: 0, right: 0, top: 40, height: 14, backgroundColor: "#F59E0B" }} />
          <Row gap={12} style={{ padding: 12 }}>
            <Box testID="lift-white" style={{ width: 72, height: 70, borderRadius: 14, elevation: 8, backgroundColor: c.white }} />
            <Box testID="lift-none" style={{ width: 72, height: 70, borderRadius: 14, elevation: 8, overflow: "hidden" }}>
              <Box style={{ flex: 1, backgroundColor: B }} />
            </Box>
            <Box testID="lift-glass" style={{ width: 72, height: 70, borderRadius: 14, elevation: 8, backgroundColor: "rgba(255, 255, 255, 0.5)" }} />
            <Box testID="lift-empty" style={{ width: 72, height: 70, borderRadius: 14, elevation: 8, borderWidth: 1, borderColor: c.muted }} />
          </Row>
        </Stack>

        <PaintTitle text="4. Under opacity 0.6 and in a rounded Pressable: taps and typing still work" />
        <Column gap={8} style={{ opacity: 0.6, padding: 8, backgroundColor: "#E0E7FF" }}>
          <Pressable testID="paint-tap" onPress={() => { taps.set(taps() + 1); console.info(`paint-lab tap ${taps()}`) }} style={{ padding: 10, borderRadius: 12, backgroundColor: B }}>
            <Text color={c.white}>{`Tap me (${taps()})`}</Text>
          </Pressable>
          <Pressable testID="paint-card" onPress={() => console.info("paint-lab card tap")} style={{ padding: 8, borderRadius: 16, backgroundColor: c.white }}>
            <TextField testID="paint-field" value={typed()} onChangeText={(t: string) => { typed.set(t); console.info(`paint-lab typed ${t}`) }} placeholder="Type here" style={{ height: 40, borderWidth: 1, borderColor: c.ink, paddingHorizontal: 8 }} />
          </Pressable>
        </Column>

        <PaintTitle text="5. An enter / exit fade (3 s) fades the element as one picture: no darker overlap mid-fade" />
        <Row gap={10} alignItems="center">
          <Pressable testID="paint-enter-toggle" onPress={() => { entered.set(!entered()); console.info(`paint-lab entered ${entered()}`) }} style={{ padding: 10, borderRadius: 12, backgroundColor: c.pillBg }}>
            <Text color={c.ink}>{entered() ? "Hide" : "Show"}</Text>
          </Pressable>
          <Box style={{ width: 70, height: 60 }}>
            {entered() && (
              <Stack testID="paint-entered" enter={{ opacity: 0, duration: 3000 }} exit={{ opacity: 0, duration: 3000 }} style={{ width: 70, height: 60, backgroundColor: "#FDE68A" }}>
                <Box style={{ position: "absolute", top: 6, start: 6, width: 40, height: 40, backgroundColor: A }} />
                <Box style={{ position: "absolute", top: 14, start: 24, width: 40, height: 40, backgroundColor: B }} />
              </Stack>
            )}
          </Box>
        </Row>

        <PaintTitle text="6. A picture not in memory fades in over 150 ms (Coil's crossfade); back to one in memory, no fade" />
        <Row gap={10} alignItems="center">
          <Pressable testID="paint-pic-a" onPress={() => { picture.set("asset:images/offer-placeholder.png"); console.info("paint-lab picture a") }} style={{ padding: 10, borderRadius: 12, backgroundColor: c.pillBg }}>
            <Text color={c.ink}>A</Text>
          </Pressable>
          <Pressable testID="paint-pic-b" onPress={() => { picture.set("asset:images/canvas-test.png"); console.info("paint-lab picture b") }} style={{ padding: 10, borderRadius: 12, backgroundColor: c.pillBg }}>
            <Text color={c.ink}>B</Text>
          </Pressable>
          <Image testID="paint-picture" src={picture()} loading="shimmer" style={{ width: 90, height: 60, borderRadius: 8 }} />
        </Row>

        <PaintTitle text="7. A List of 40 rows with two pictures: scrolled down and back, rows fade only the first time a picture loads" />
        <List
          testID="paint-pic-list"
          horizontal
          data={pictureRows}
          key={(r) => r.id}
          style={{ height: 64 }}
          row={(r) => (
            <Column style={{ paddingEnd: 8 }}>
              <Image src={r.src} loading="shimmer" style={{ width: 64, height: 64, borderRadius: 8 }} />
            </Column>
          )}
        />
      </Column>
    </Scroll>
  )
}
