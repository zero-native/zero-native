// A dev screen for accessibility and testID (registry 15): what TalkBack / VoiceOver read, and the ids UI tests find.
// Each case says what a screen reader should say. On iOS, check with Accessibility Inspector or a UI test's tree dump;
// on Android with TalkBack or `uiautomator dump` (testID is the resource id). Actions log one "a11y-lab ..." line.
import { Box, Canvas, Checkbox, Column, Image, OtpInput, Pressable, Row, Scroll, Switch, Text, TextField } from "@zeronative/ui"
import { draw, signal } from "@zeronative/core"
import { c } from "./tokens"

function A11yCase(props: { title: string; expect: string; children?: unknown }) {
  return (
    <Column style={{ gap: 6, padding: 12, borderRadius: 12, backgroundColor: "#F3F4F6" }}>
      <Text fontSize={14} fontWeight={700} color={c.ink} accessibilityRole="header">
        {props.title}
      </Text>
      <Text fontSize={11} color={c.muted}>
        {props.expect}
      </Text>
      {props.children}
    </Column>
  )
}

export function A11yLabScreen() {
  const log = signal("a11y-lab: ready")
  const say = (s: string) => {
    log.set(`a11y-lab: ${s}`)
    console.log(`a11y-lab ${s}`)
  }
  const disabled = signal(true)
  const armed = signal(false)
  const on = signal(false)
  const checked = signal(true)
  const count = signal(0)
  const text = signal("")

  return (
    <Scroll testID="a11y-scroll" style={{ flex: 1, padding: 16, gap: 12 }}>
      <Text fontSize={20} fontWeight={700} color={c.ink} accessibilityRole="header">
        Accessibility lab
      </Text>
      <Text testID="a11y-status" fontSize={13} color={c.ink}>
        {log()}
      </Text>

      <A11yCase title="1. Pressable label and hint" expect='Reads "Pay 499 rupees, button", then the hint "Opens the payment sheet". Its texts are not read on their own.'>
        <Pressable
          testID="a11y-pay"
          accessibilityLabel="Pay 499 rupees"
          accessibilityHint="Opens the payment sheet"
          onPress={() => say("pay pressed")}
          style={{ padding: 12, borderRadius: 8, backgroundColor: "#E0E7FF" }}
        >
          <Text fontSize={14} color={c.ink}>Pay ₹499</Text>
          <Text fontSize={11} color={c.muted}>UPI · HDFC</Text>
        </Pressable>
      </A11yCase>

      <A11yCase title="2. Label from a signal" expect='Reads "Tapped 0 times, button"; the number follows each tap.'>
        <Pressable
          testID="a11y-count"
          accessibilityLabel={`Tapped ${count()} times`}
          onPress={() => count.set(count() + 1)}
          style={{ padding: 12, borderRadius: 8, backgroundColor: "#E0E7FF" }}
        >
          <Text fontSize={14} color={c.ink}>Tap to count</Text>
        </Pressable>
      </A11yCase>

      <A11yCase title="3. Disabled Pressable" expect='Reads "Place order, button, dimmed"; a double tap does nothing. "Enable" turns it on.'>
        <Row gap={8}>
          <Pressable
            testID="a11y-order"
            disabled={disabled()}
            onPress={() => say("order placed")}
            style={{ padding: 12, borderRadius: 8, backgroundColor: disabled() ? "#E5E7EB" : "#16A34A" }}
          >
            <Text fontSize={14} color={disabled() ? c.muted : "#FFFFFF"}>Place order</Text>
          </Pressable>
          <Pressable testID="a11y-enable" onPress={() => disabled.set(!disabled())} style={{ padding: 12, borderRadius: 8, backgroundColor: "#E0E7FF" }}>
            <Text fontSize={14} color={c.ink}>{disabled() ? "Enable" : "Disable"}</Text>
          </Pressable>
        </Row>
      </A11yCase>

      <A11yCase title="4. Long press action" expect='The actions offer "Long press" on "Hold me" only while armed (Arm / disarm).'>
        <Row gap={8}>
          <Pressable
            testID="a11y-hold"
            onPress={() => say("hold pressed")}
            onLongPress={armed() ? () => say("hold long-pressed") : undefined}
            style={{ padding: 12, borderRadius: 8, backgroundColor: "#E0E7FF" }}
          >
            <Text fontSize={14} color={c.ink}>Hold me</Text>
          </Pressable>
          <Pressable testID="a11y-arm" onPress={() => armed.set(!armed())} style={{ padding: 12, borderRadius: 8, backgroundColor: "#E0E7FF" }}>
            <Text fontSize={14} color={c.ink}>{armed() ? "Disarm" : "Arm"}</Text>
          </Pressable>
        </Row>
      </A11yCase>

      <A11yCase title="5. Roles" expect='"Terms, link"; "Read only, text" (no button); a header Box reads "Wallet, heading".'>
        <Pressable testID="a11y-link" accessibilityRole="link" onPress={() => say("link pressed")}>
          <Text fontSize={14} color={c.primary}>Terms</Text>
        </Pressable>
        <Pressable testID="a11y-text-role" accessibilityRole="text" onPress={() => say("text role pressed")}>
          <Text fontSize={14} color={c.ink}>Read only</Text>
        </Pressable>
        <Box testID="a11y-header-box" accessibilityRole="header" accessibilityLabel="Wallet">
          <Text fontSize={14} color={c.ink}>Wallet balance ₹1,250</Text>
        </Box>
      </A11yCase>

      <A11yCase title="6. A row with a Switch inside" expect="The row's text and the Switch are separate elements: the Switch reads its label and on / off.">
        <Pressable testID="a11y-row" onPress={() => say("row pressed")} style={{ padding: 12, borderRadius: 8, backgroundColor: "#FFFFFF" }}>
          <Row alignItems="center" justifyContent="space-between">
            <Text fontSize={14} color={c.ink}>Notifications</Text>
            <Switch testID="a11y-switch" accessibilityLabel="Notifications" accessibilityHint="Turns offer alerts on or off" value={on()} onValueChange={(v) => on.set(v)} />
          </Row>
        </Pressable>
        <Row alignItems="center" gap={8}>
          <Checkbox testID="a11y-check" accessibilityLabel="Save this card" value={checked()} onValueChange={(v) => checked.set(v)} />
          <Text fontSize={14} color={c.ink}>Save this card</Text>
        </Row>
      </A11yCase>

      <A11yCase title="7. Pictures" expect='The first image reads "Store front, image"; the second (no label) is skipped; the chart reads "Sales, going up, image".'>
        <Row gap={8} alignItems="center">
          <Image testID="a11y-img-label" src="asset:images/offer-placeholder.png" accessibilityLabel="Store front" style={{ width: 48, height: 48 }} />
          <Image src="asset:images/offer-placeholder.png" style={{ width: 48, height: 48 }} />
          <Canvas
            testID="a11y-chart"
            accessibilityLabel="Sales, going up"
            style={{ width: 80, height: 48 }}
            commands={[draw.line(4, 44, 76, 4, { strokeWidth: 3, color: c.primary })]}
          />
        </Row>
      </A11yCase>

      <A11yCase title="8. Hidden and labelled boxes" expect='The yellow card is skipped. The blue card reads as one element: "Cashback 40 rupees on your next bill".'>
        <Box testID="a11y-hidden" accessibilityHidden style={{ padding: 10, borderRadius: 8, backgroundColor: "#FEF3C7" }}>
          <Text fontSize={13} color="#92400E">Hidden from screen readers</Text>
        </Box>
        <Box testID="a11y-card" accessibilityLabel="Cashback 40 rupees on your next bill" style={{ padding: 10, borderRadius: 8, backgroundColor: "#DBEAFE" }}>
          <Text fontSize={13} color={c.ink}>Cashback ₹40</Text>
          <Text fontSize={11} color={c.muted}>on your next bill</Text>
        </Box>
      </A11yCase>

      <A11yCase title="9. Fields" expect='The field reads "Mobile number" with its hint; the code reads "One-time code, 0 of 4 digits".'>
        <TextField
          testID="a11y-phone"
          accessibilityLabel="Mobile number"
          accessibilityHint="10 digits, no country code"
          placeholder="98765 43210"
          keyboardType="phone-pad"
          value={text()}
          onChangeText={(t) => text.set(t)}
          style={{ height: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}
        />
        <OtpInput testID="a11y-otp" accessibilityLabel="One-time code" numberOfDigits={4} autoFocus={false} />
      </A11yCase>

      <A11yCase title="10. pointerEvents none over a field" expect="Tapping the field does nothing (no keyboard); the box over it takes no taps either.">
        <Box pointerEvents="none" style={{ opacity: 0.5 }}>
          <TextField testID="a11y-field-off" placeholder="Can't focus" style={{ height: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }} />
        </Box>
      </A11yCase>
    </Scroll>
  )
}
