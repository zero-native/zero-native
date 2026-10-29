// The sample's amount-entry screen, written as plain TSX and compiled by the zero-native compiler.
import { Column, Pressable, Row, Text, Box, Icon, Image } from "@zero-native/ui"
import { computed, signal } from "@zero-native/core"
import { c } from "./tokens"
import { backspace as backspaceIcon } from "./icons"
import { applyKey, backspace, financials, formatIndian, rupees, toPaise, type Session } from "./money"

const session: Session = {
  merchant: "Kalyan Jewellers",
  maxCashbackPaise: 5000,
  minTotalForCashbackPaise: 20000,
  platformFeePaise: 500,
}

const DIGIT_ROWS = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
]

const keyStyle = {
  flex: 1,
  height: 60,
  borderRadius: 12,
  backgroundColor: c.key,
  borderWidth: 1,
  borderColor: c.border,
}

function Key(props: { label: string; onKey: (key: string) => void }) {
  return (
    <Pressable onPress={() => props.onKey(props.label)} haptic alignItems="center" justifyContent="center" style={keyStyle}>
      <Text fontSize={26} fontWeight={700} color={c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

/** Tap deletes one digit; holding repeats natively (no JS timers, so no "zombie timer" bug). */
function BackspaceKey(props: { onDelete: () => void }) {
  return (
    <Pressable
      onPress={() => props.onDelete()}
      onPressRepeat={() => props.onDelete()}
      repeatDelay={400}
      repeatInterval={90}
      haptic
      alignItems="center"
      justifyContent="center"
      style={keyStyle}
    >
      <Icon icon={backspaceIcon} color={c.ink} />
    </Pressable>
  )
}

export function AmountScreen() {
  const amount = signal("0")
  const status = signal("")
  const cursor = signal(true)

  // Blinking cursor
  setInterval(() => {
    cursor.set((v) => !v)
  }, 500)

  const paise = computed(() => toPaise(amount()))
  const money = computed(() => financials(paise(), session))
  const active = computed(() => paise() > 0)

  const onKey = (key: string) => {
    status.set("")
    amount.set((prev) => applyKey(prev, key))
  }
  const onDelete = () => {
    status.set("")
    amount.set((prev) => backspace(prev))
  }
  const pay = () => status.set(`Would pay ₹${rupees(money().toPay)} (UPI arrives in milestone 2)`)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      {/* 1. Top App Bar / Header */}
      <Row
        style={{
          width: "100%",
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderBottomWidth: 1,
          borderColor: c.border,
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: c.white,
        }}
      >
        <Pressable
          onPress={() => {}}
          haptic
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.bg,
          }}
        >
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>

        <Row style={{ alignItems: "center", gap: 10 }}>
          <Image
            src="https://picsum.photos/id/1062/112/112"
            style={{ width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: c.border }}
          />
          <Column style={{ alignItems: "center" }}>
            <Text fontSize={16} fontWeight={700} color={c.ink}>
              {session.merchant}
            </Text>
            <Text fontSize={11} color={c.muted}>
              Counter 1 • Multi-Counter
            </Text>
          </Column>
        </Row>

        <Pressable
          onPress={() => {}}
          haptic
          style={{
            backgroundColor: c.pillBg,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 8,
          }}
        >
          <Text fontSize={12} fontWeight={700} color={c.ink}>
            📜 Passbook
          </Text>
        </Pressable>
      </Row>

      {/* 2. Amount Hero & Cursor */}
      <Column style={{ flex: 1, padding: 24, gap: 10 }} justifyContent="center" alignItems="center">
        <Pressable onLongPress={() => amount.set("0")} style={{ paddingHorizontal: 12, borderRadius: 12 }}>
          <Row style={{ alignItems: "center", justifyContent: "center", gap: 8 }}>
            <Text fontSize={36} fontWeight={500} color={c.muted}>
              ₹
            </Text>
            <Text fontSize={52} fontWeight={700} color={c.ink}>
              {formatIndian(amount())}
            </Text>
            <Box
              style={{
                width: 3,
                height: 44,
                borderRadius: 2,
                backgroundColor: c.primary,
                opacity: cursor() ? 1 : 0,
              }}
            />
          </Row>
        </Pressable>

        {money().cashback > 0 && (
          <Box style={{ backgroundColor: c.successBg, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 6 }}>
            <Text fontSize={13} fontWeight={600} color={c.success}>
              🎉 ₹{rupees(money().cashback)} cashback applied
            </Text>
          </Box>
        )}
        {money().cashback > 0 ? (
          <Text fontSize={13} color={c.muted}>
            You pay ₹{rupees(money().toPay)} (incl. ₹{rupees(money().fee)} platform fee)
          </Text>
        ) : null}
        {status() !== "" && (
          <Text fontSize={13} color={c.primary}>
            {status()}
          </Text>
        )}
        <Text fontSize={12} color={c.muted} fontStyle="italic">
          Hold the amount to clear it · hold ⌫ to delete fast
        </Text>
      </Column>

      {/* 3. Custom Keypad */}
      <Column style={{ padding: 12, gap: 8, backgroundColor: c.keypadBg, borderTopWidth: 1, borderColor: c.border }}>
        {DIGIT_ROWS.map((row) => (
          <Row key={row[0]} style={{ gap: 8 }}>
            {row.map((k) => (
              <Key key={k} label={k} onKey={onKey} />
            ))}
          </Row>
        ))}
        <Row style={{ gap: 8 }}>
          <Key label="." onKey={onKey} />
          <Key label="0" onKey={onKey} />
          <BackspaceKey onDelete={onDelete} />
        </Row>
        <Pressable
          onPress={pay}
          onPressOut={(cancelled) => console.info(`pay: press out (cancelled: ${cancelled})`)}
          disabled={!active()}
          alignItems="center"
          justifyContent="center"
          style={{
            height: 56,
            borderRadius: 14,
            elevation: 2,
            backgroundColor: active() ? c.primary : c.disabled,
          }}
        >
          <Text fontSize={17} fontWeight={600} color={c.white}>
            {active() ? "Pay Now →" : "Enter Amount"}
          </Text>
        </Pressable>
      </Column>
    </Column>
  )
}
