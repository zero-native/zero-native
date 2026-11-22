// A dev screen for accessibility and testID (registry 15): what TalkBack / VoiceOver read, and the ids UI tests find.
// Each case says what a screen reader should say. On iOS, check with Accessibility Inspector or a UI test's tree dump;
// on Android with TalkBack or `uiautomator dump` (testID is the resource id). Actions log one "a11y-lab ..." line.
import { Box, Canvas, Checkbox, Column, Icon, Image, OtpInput, Pressable, Row, Scroll, Switch, Text, TextField } from "@zeronative/ui"
import { draw, signal } from "@zeronative/core"
import { c } from "./tokens"
import { chevronRight } from "./icons"

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
  const named = signal(true)
  const rowOn = signal(true)
  // A font name from data (an OTA bundle's): iOS's own family, its face picked by weight and style.
  const phoneFont = signal("Avenir Next")

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
        <Pressable
          testID="a11y-maybe"
          accessibilityLabel={named() ? "Named button" : undefined}
          onPress={() => named.set(!named())}
          style={{ padding: 12, borderRadius: 8, backgroundColor: "#E0E7FF" }}
        >
          <Text fontSize={14} color={c.ink}>Own text (tap: label on / off)</Text>
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
        <Box testID="a11y-role-only" accessibilityRole="header">
          <Text fontSize={14} color={c.ink}>Balance</Text>
          <Text fontSize={14} color={c.ink}>₹980</Text>
        </Box>
      </A11yCase>

      <A11yCase title="6. A row with a Switch inside" expect={'The row is its own button, read first: "Notifications, button" (a double tap sends onPress); its text is not read again. The Switch is separate: its label and on / off. The labelled box reads "Card settings", then its Switch.'}>
        <Pressable testID="a11y-row" onPress={() => say("row pressed")} style={{ padding: 12, borderRadius: 8, backgroundColor: "#FFFFFF" }}>
          <Row alignItems="center" justifyContent="space-between">
            <Text fontSize={14} color={c.ink}>Notifications</Text>
            <Switch testID="a11y-switch" accessibilityLabel="Notifications" accessibilityHint="Turns offer alerts on or off" value={on()} onValueChange={(v) => on.set(v)} />
          </Row>
        </Pressable>
        <Box testID="a11y-box-ctl" accessibilityLabel="Card settings" style={{ padding: 12, borderRadius: 8, backgroundColor: "#FFFFFF" }}>
          <Row alignItems="center" justifyContent="space-between">
            <Text fontSize={14} color={c.ink}>Card</Text>
            <Switch testID="a11y-box-switch" accessibilityLabel="Card on" value={rowOn()} onValueChange={(v) => rowOn.set(v)} />
          </Row>
        </Box>
        <Row alignItems="center" gap={8}>
          <Checkbox testID="a11y-check" accessibilityLabel="Save this card" value={checked()} onValueChange={(v) => checked.set(v)} />
          <Text fontSize={14} color={c.ink}>Save this card</Text>
        </Row>
      </A11yCase>

      <A11yCase title="7. Pictures" expect='The first image reads "Store front, image"; the second (no label, a testID only) is skipped; the icon reads "Next" (not an image); the chart reads "Sales, going up, image".'>
        <Row gap={8} alignItems="center">
          <Image testID="a11y-img-label" src="asset:images/offer-placeholder.png" accessibilityLabel="Store front" style={{ width: 48, height: 48 }} />
          <Image testID="a11y-img-deco" src="asset:images/offer-placeholder.png" style={{ width: 48, height: 48 }} />
          <Icon testID="a11y-icon" accessibilityLabel="Next" icon={chevronRight} color={c.ink} style={{ width: 20, height: 20 }} />
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

      <A11yCase title="9. Fields" expect='The field reads "Mobile number" with its hint; the code reads "One-time code, 0 of 4 digits". The last two fields (no height set) grow and shrink with the text size, at once; the code digits grow inside their fixed 44 by 60 boxes, as on Android.'>
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
        <TextField
          testID="a11y-name"
          accessibilityLabel="Name, no height set"
          placeholder="Name (grows with the text size)"
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}
        />
        <TextField
          testID="a11y-note"
          accessibilityLabel="Note, multiline"
          multiline
          placeholder="A note (multiline)"
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderWidth: 1, borderColor: c.border, borderRadius: 8 }}
        />
      </A11yCase>

      <A11yCase title="10. pointerEvents none over a field" expect="Tapping the field does nothing (no keyboard); the box over it takes no taps either.">
        <Box pointerEvents="none" style={{ opacity: 0.5 }}>
          <TextField testID="a11y-field-off" placeholder="Can't focus" style={{ height: 44, paddingHorizontal: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }} />
        </Box>
      </A11yCase>

      <A11yCase title="11. Tappable Text roles and the phone's fonts" expect={'"Privacy policy, link" (no button); "Skip" reads with no role. The Avenir Next lines draw regular, bold and italic faces.'}>
        <Text testID="a11y-text-link" accessibilityRole="link" fontSize={14} color={c.primary} onPress={() => say("text link pressed")}>
          Privacy policy
        </Text>
        <Text testID="a11y-text-none" accessibilityRole="none" fontSize={14} color={c.ink} onPress={() => say("text none pressed")}>
          Skip
        </Text>
        <Text fontSize={16} color={c.ink}>
          <Text style={{ fontFamily: phoneFont() }}>Avenir Next 400</Text>
        </Text>
        <Text fontSize={16} color={c.ink}>
          <Text style={{ fontFamily: phoneFont(), fontWeight: 700 }}>Avenir Next 700</Text>
        </Text>
        <Text fontSize={16} color={c.ink}>
          <Text style={{ fontFamily: phoneFont(), fontStyle: "italic" }}>Avenir Next italic</Text>
        </Text>
      </A11yCase>
    </Scroll>
  )
}
