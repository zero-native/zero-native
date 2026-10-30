// A dev screen for Pressable's press feedback (step 3.6): every option side by side, to try by hand.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/press
import { Box, Column, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { nav, signal } from "@zero-native/core"
import { c } from "./tokens"

function Label(props: { text: string }) {
  return (
    <Text fontSize={12} color={c.muted}>
      {props.text}
    </Text>
  )
}

// Module level: the compiler folds it into the templates at build time.
const card = { padding: 16, borderRadius: 14, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }

export function PressScreen() {
  const last = signal("Tap or hold anything")
  const tapped = (what: string) => () => last.set(`Pressed: ${what}`)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} rippleBorderless rippleRadius={22} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          Press feedback
        </Text>
      </Row>
      <Text fontSize={13} color={c.ink} style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
        {last()}
      </Text>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 20, paddingBottom: 32, gap: 10 }}>
          <Label text="Default: ripple (black 12 %)" />
          <Pressable onPress={tapped("default")} style={card}>
            <Text fontSize={15} color={c.ink}>Default card</Text>
          </Pressable>

          <Label text={'rippleColor="#FFFFFF" on a dark button'} />
          <Pressable onPress={tapped("dark button")} rippleColor="#FFFFFF" alignItems="center" style={{ padding: 14, borderRadius: 12, backgroundColor: c.primary }}>
            <Text fontSize={15} fontWeight={700} color={c.white}>Pay ₹1,250</Text>
          </Pressable>

          <Label text={"rippleColor={c.primary} rippleOpacity={0.3}"} />
          <Pressable onPress={tapped("brand ripple")} rippleColor={c.primary} rippleOpacity={0.3} style={card}>
            <Text fontSize={15} color={c.ink}>Brand-coloured ripple</Text>
          </Pressable>

          <Label text="rippleBorderless rippleRadius={24}: icon buttons" />
          <Row style={{ gap: 28, paddingVertical: 8, paddingHorizontal: 8 }}>
            {["♥", "↗", "⋮"].map((icon) => (
              <Pressable key={icon} onPress={tapped(`icon ${icon}`)} rippleBorderless rippleRadius={24} alignItems="center" style={{ width: 32, height: 32, justifyContent: "center" }}>
                <Text fontSize={20} color={c.ink}>{icon}</Text>
              </Pressable>
            ))}
          </Row>

          <Label text={'pressFeedback="highlight" highlightColor="rgba(61,38,237,0.12)"'} />
          <Pressable onPress={tapped("highlight")} pressFeedback="highlight" highlightColor="rgba(61,38,237,0.12)" style={card}>
            <Text fontSize={15} color={c.ink}>Flat highlight in brand colour</Text>
          </Pressable>

          <Label text={'pressOpacity={0.5} pressFeedback="none" (iOS-style)'} />
          <Pressable onPress={tapped("opacity")} pressOpacity={0.5} pressFeedback="none" style={card}>
            <Text fontSize={15} color={c.ink}>Dims while pressed</Text>
          </Pressable>

          <Label text="pressScale={0.96} with the default ripple" />
          <Pressable onPress={tapped("scale")} pressScale={0.96} style={card}>
            <Text fontSize={15} color={c.ink}>Gives a little when pressed</Text>
          </Pressable>

          <Label text={'pressFeedback="none"'} />
          <Pressable onPress={tapped("none")} pressFeedback="none" style={card}>
            <Text fontSize={15} color={c.ink}>No feedback</Text>
          </Pressable>
          <Box style={{ height: 8 }} />
        </Column>
      </Scroll>
    </Column>
  )
}
