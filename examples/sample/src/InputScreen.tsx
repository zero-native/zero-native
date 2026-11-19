// A dev screen for milestone 3 steps 3.2 and 3.3: text fields (controlled and not), the keyboard, children passed to
// a component, a JSX prop, a fragment, and text spans. Open it with zn://sample/dev/input.
import { Column, Pressable, Row, Scroll, Text, TextField } from "@zeronative/ui"
import type { Children } from "@zeronative/ui"
import { computed, Keyboard, nav, signal } from "@zeronative/core"
import { c } from "./tokens"

/** A card with a title row (a JSX prop) and any content (its children). */
function Card(props: { header: Children; children?: Children }) {
  return (
    <Column style={{ backgroundColor: c.white, borderRadius: 12, padding: 14, gap: 10, borderWidth: 1, borderColor: c.border }}>
      {props.header}
      {props.children}
    </Column>
  )
}

/** Two lines with no wrapper of their own: they sit straight in the parent's Column. */
function Hint(props: { text: string }) {
  return (
    <>
      <Text fontSize={12} color={c.muted}>
        {props.text}
      </Text>
      <Text fontSize={12} color={c.muted}>
        Tip: the keyboard never covers the Pay button.
      </Text>
    </>
  )
}

const field = { fontSize: 16, color: c.ink, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.pillBg }

/** "1234567" → "12,34,567" (Indian grouping), digits only. */
function rupees(digits: string): string {
  if (digits.length <= 3) return digits
  const last3 = digits.slice(-3)
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ",")
  return `${rest},${last3}`
}

export function InputScreen() {
  const name = signal("")
  const amount = signal("")
  const phone = signal("")
  const pin = signal("")
  const note = signal("")
  const focused = signal("none")
  const submitted = signal("")
  const amountNumber = computed(() => Number(amount().replace(/,/g, "") || "0"))
  const canPay = computed(() => amountNumber() > 0 && phone().length === 10)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Inputs
        </Text>
      </Row>

      {/* Scrolls when the keyboard leaves too little room; the focused field scrolls itself into view. */}
      <Scroll style={{ flex: 1, paddingHorizontal: 16, paddingBottom: 16, gap: 12 }}>
        <Card header={<Text fontSize={14} fontWeight={600} color={c.ink}>Who</Text>}>
          <TextField
            value={name()}
            onChangeText={(t) => name.set(t)}
            placeholder="Your name"
            autoComplete="name"
            autoCapitalize="words"
            returnKeyType="next"
            onFocus={() => focused.set("name")}
            style={field}
          />
          <TextField
            value={phone()}
            onChangeText={(t) => phone.set(t.replace(/\D/g, ""))}
            placeholder="Phone (10 digits)"
            autoComplete="tel-national"
            textContentType="telephoneNumber"
            autoFocus
            keyboardType="phone-pad"
            maxLength={10}
            onFocus={() => focused.set("phone")}
            style={field}
          />
        </Card>

        <Card header={<Text fontSize={14} fontWeight={600} color={c.ink}>How much</Text>}>
          <TextField
            value={amount()}
            onChangeText={(t) => {
              // Reformat as the user types; reject more than 7 digits (the field goes back to the old value).
              const digits = t.replace(/\D/g, "").replace(/^0+/, "")
              if (digits.length <= 7) amount.set(rupees(digits))
            }}
            placeholder="₹0"
            keyboardType="number-pad"
            onFocus={() => focused.set("amount")}
            style={{ ...field, fontSize: 22, fontWeight: 700 }}
          />
          <TextField
            onChangeText={(t) => pin.set(t)}
            placeholder="UPI PIN (not stored)"
            keyboardType="number-pad"
            secureTextEntry
            maxLength={6}
            onFocus={() => focused.set("pin")}
            style={field}
          />
          {/* A tall single-line box (an OTP box): its text and placeholder sit in the middle, as in React Native. */}
          <TextField
            placeholder="OTP (tall box, centred)"
            autoComplete="sms-otp"
            keyboardType="number-pad"
            maxLength={6}
            style={{ ...field, height: 64, fontSize: 22 }}
          />
          <TextField
            value={note()}
            onChangeText={(t) => note.set(t)}
            placeholder="Add a note"
            multiline
            returnKeyType="done"
            onSubmitEditing={(t) => submitted.set(t)}
            onFocus={() => focused.set("note")}
            onBlur={() => focused.set("none")}
            style={{ ...field, minHeight: 64 }}
          />
          <Hint text="Amount is formatted as you type." />
        </Card>

        <Text fontSize={14} color={c.ink}>
          Paying <Text fontWeight={700} color={c.primary}>₹{amount() || "0"}</Text> to{" "}
          <Text fontStyle="italic">{name() || "someone"}</Text> · focused: <Text fontWeight={600}>{focused()}</Text>
        </Text>
        <Text fontSize={12} color={c.muted}>
          PIN length {pin().length} · last submit "{submitted()}"
        </Text>
      </Scroll>

      <Row style={{ gap: 12, padding: 16 }}>
        <Pressable
          onPress={() => Keyboard.dismiss()}
          alignItems="center"
          style={{ paddingVertical: 14, paddingHorizontal: 16, borderRadius: 12, backgroundColor: c.pillBg }}
        >
          <Text fontSize={15} fontWeight={600} color={c.ink}>
            Hide keyboard
          </Text>
        </Pressable>
        <Pressable
          onPress={() => Keyboard.dismiss()}
          disabled={!canPay()}
          alignItems="center"
          style={{ flex: 1, paddingVertical: 14, borderRadius: 12, backgroundColor: canPay() ? c.primary : c.disabled }}
        >
          <Text fontSize={15} fontWeight={700} color={c.white}>
            Pay
          </Text>
        </Pressable>
      </Row>
    </Column>
  )
}
