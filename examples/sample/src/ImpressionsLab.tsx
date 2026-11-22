// A dev screen for impressions (useImpressions, impressionKey) with threshold 0.5 and minMs 600: which keys count, and
// which must not. Each batch logs one "imp-lab +keys" line (the phone check reads them, so keep the wording).
//   - tabs: "tab-a" counts; "tab-b" counts only after "Tab B" is pressed (a hidden tab counts nothing), and going back
//     to A counts nothing new.
//   - rows: row-1 and row-2 count at once; row-3 to row-8 only when scrolled to (each 160 high, the screen scrolls).
//   - clipped: "clip-40" is 40 % visible in a box with overflow hidden: never counts (threshold 0.5).
//   - "late": shown by the button; counts 600 ms after it shows, not before.
//   - rail: a horizontal Scroll of 6 cards 200 wide: the ones on screen count, the rest when scrolled to.
import { Box, Column, Pressable, Row, Scroll, Tabs, Text } from "@zeronative/ui"
import { signal, useImpressions } from "@zeronative/core"
import { c } from "./tokens"

function ImpCard(props: { k: string; height?: number; width?: number; color?: string }) {
  return (
    <Box
      impressionKey={props.k}
      alignItems="center"
      justifyContent="center"
      style={{ height: props.height ?? 160, width: props.width, borderRadius: 12, backgroundColor: props.color ?? "#E0E7FF" }}
    >
      <Text fontSize={14} fontWeight={700} color={c.ink}>
        {props.k}
      </Text>
    </Box>
  )
}

function ImpButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: "#1F2937" }}>
      <Text fontSize={13} fontWeight={600} color="#FFFFFF">
        {props.label}
      </Text>
    </Pressable>
  )
}

export function ImpressionsLabScreen() {
  const seen = signal<string[]>([])
  const tab = signal(0)
  const late = signal(false)
  useImpressions(
    (keys) => {
      console.info(`imp-lab +${keys.join(",")}`)
      seen.set([...seen(), ...keys])
    },
    { threshold: 0.5, minMs: 600 },
  )
  return (
    <Scroll style={{ flex: 1, gap: 12, backgroundColor: c.bg }} contentContainerStyle={{ padding: 16 }}>
      <Text fontSize={20} fontWeight={700} color={c.ink}>
        Impressions lab
      </Text>
      <Text testID="imp-seen" fontSize={12} color={c.muted}>
        {`seen: ${seen().join(", ") || "none"}`}
      </Text>
      <Row style={{ gap: 8 }}>
        <ImpButton label="Tab A" onPress={() => tab.set(0)} />
        <ImpButton label="Tab B" onPress={() => tab.set(1)} />
        <ImpButton label="Show late" onPress={() => late.set(true)} />
      </Row>
      <Tabs selected={tab()} style={{ height: 60 }}>
        <ImpCard k="tab-a" height={60} color="#DCFCE7" />
        <ImpCard k="tab-b" height={60} color="#FEF3C7" />
      </Tabs>
      <Box style={{ height: 40, overflow: "hidden", borderRadius: 12 }}>
        <ImpCard k="clip-40" height={100} color="#FEE2E2" />
      </Box>
      {late() && <ImpCard k="late" height={60} color="#E9D5FF" />}
      <Scroll horizontal style={{ gap: 12 }}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <ImpCard key={i} k={`rail-${i}`} width={200} height={100} color="#CFFAFE" />
        ))}
      </Scroll>
      {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
        <ImpCard key={i} k={`row-${i}`} />
      ))}
    </Scroll>
  )
}
