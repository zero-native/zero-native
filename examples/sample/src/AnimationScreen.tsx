// A dev screen for animation (milestone 3 step 3.6, ARCHITECTURE §10). Every animation here runs natively: JS only
// changes target values (or mounts / removes elements), never per-frame values.
// Opens with a 6-second demo loop (for frame measurements), then the buttons drive it.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/animation
import { Box, Column, Pressable, Row, Scroll, Stack, Text } from "@zero-native/ui"
import { nav, signal } from "@zero-native/core"
import { c } from "./tokens"

function DemoButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const CHIPS = ["Kirana", "Pharmacy", "Bakery", "Dairy", "Snacks", "Fruits"]

export function AnimationScreen() {
  const open = signal(false)
  const selected = signal(false)
  const toast = signal(false)
  const pay = signal(true) // the swap: "Pay ₹1,250" ↔ "Paid ✓"
  const chips = signal<string[]>(CHIPS.slice(0, 3))
  let next = 3

  // At most 3 chips: with one more fading out they still fit in one row (a full Row squeezes its last child today,
  // and a leaving element keeps its space until its exit ends: docs/guide-notes.md §22).
  const add = () => {
    chips.set((list) => [...list, CHIPS[next % CHIPS.length]! + (next >= CHIPS.length ? ` ${next}` : "")].slice(-3))
    next++
  }
  const removeFirst = () => chips.set((list) => list.slice(1))

  // Demo loop for frame measurements: every 400 ms one thing changes, for 6 s.
  let step = 0
  const demo = setInterval(() => {
    const k = step++ % 5
    if (k === 0) open.set((v) => !v)
    if (k === 1) selected.set((v) => !v)
    if (k === 2) toast.set((v) => !v)
    if (k === 3) pay.set((v) => !v)
    if (k === 4) (step % 2 ? add() : removeFirst())
    if (step >= 15) clearInterval(demo)
  }, 400)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Animation
        </Text>
      </Row>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 20, paddingBottom: 32, gap: 18 }}>
          <Text fontSize={13} color={c.muted}>
            1. Values: opacity (tween), slide (spring), scale (bouncy)
          </Text>
          <Box
            animate={{ opacity: 220, translateY: "spring", scale: "bouncy" }}
            style={{
              opacity: open() ? 1 : 0.35,
              transform: [{ translateY: open() ? 0 : 10 }, { scale: open() ? 1 : 0.94 }],
              padding: 16,
              borderRadius: 14,
              backgroundColor: c.white,
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            <Text fontSize={15} fontWeight={600} color={c.ink}>
              ₹50 cashback unlocked
            </Text>
            <Text fontSize={13} color={c.muted}>
              {open() ? "Applied to your next payment" : "Tap Toggle to bring it in"}
            </Text>
          </Box>
          <DemoButton label="Toggle card" onPress={() => open.set((v) => !v)} />

          <Text fontSize={13} color={c.muted}>
            2. Colour (300 ms) and a rotating arrow
          </Text>
          <Pressable
            onPress={() => selected.set((v) => !v)}
            animate={300}
            style={{
              padding: 14,
              borderRadius: 12,
              backgroundColor: selected() ? c.successBg : c.white,
              borderWidth: 1,
              borderColor: c.border,
            }}
          >
            <Row style={{ alignItems: "center" }}>
              <Text fontSize={15} fontWeight={600} color={c.ink} style={{ flex: 1 }}>
                UPI AutoPay
              </Text>
              <Box animate={{ rotate: "spring" }} style={{ transform: [{ rotate: selected() ? 180 : 0 }] }}>
                <Text fontSize={16} color={c.ink}>
                  ▾
                </Text>
              </Box>
            </Row>
          </Pressable>

          <Text fontSize={13} color={c.muted}>
            3. Enter / exit on `&&` (fade-up in, fade-down out)
          </Text>
          <Box style={{ height: 56 }}>
            {toast() && (
              <Box enter="fade-up" exit="fade-down" style={{ padding: 14, borderRadius: 12, backgroundColor: c.ink }}>
                <Text fontSize={14} color={c.white}>
                  Payment link copied
                </Text>
              </Box>
            )}
          </Box>
          <DemoButton label="Show / hide toast" onPress={() => toast.set((v) => !v)} />

          <Text fontSize={13} color={c.muted}>
            4. Swap with `? :` inside a Stack (children overlap, so they cross-fade in place)
          </Text>
          <Stack style={{ height: 52 }}>
            {pay() ? (
              <Box enter="scale" exit="fade" style={{ width: "100%", height: 52, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: c.primary }}>
                <Text fontSize={15} fontWeight={700} color={c.white}>
                  Pay ₹1,250
                </Text>
              </Box>
            ) : (
              <Box enter="pop" exit="fade" style={{ width: "100%", height: 52, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: c.success }}>
                <Text fontSize={15} fontWeight={700} color={c.white}>
                  Paid ✓
                </Text>
              </Box>
            )}
          </Stack>
          <DemoButton label="Swap" onPress={() => pay.set((v) => !v)} />

          <Text fontSize={13} color={c.muted}>
            5. List rows: scale in, fade out
          </Text>
          <Row style={{ gap: 8 }}>
            {chips().map((name) => (
              <Box key={name} enter="scale" exit="fade" style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: c.pillBg }}>
                <Text fontSize={13} color={c.ink}>
                  {name}
                </Text>
              </Box>
            ))}
          </Row>
          <Row style={{ gap: 8 }}>
            <DemoButton label="Add" onPress={add} />
            <DemoButton label="Remove first" onPress={removeFirst} />
          </Row>
        </Column>
      </Scroll>
    </Column>
  )
}
