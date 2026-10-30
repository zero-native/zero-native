// The sample's amount-entry screen, written as plain TSX and compiled by the zero-native compiler.
import { Column, Pressable, Row, Text, Box, Icon, Image, Sheet } from "@zero-native/ui"
import { computed, nav, signal, useBack } from "@zero-native/core"
import { c } from "./tokens"
import { backspace as backspaceIcon } from "./icons"
import { applyKey, backspace, financials, formatIndian, rupees, toPaise, type Session } from "./money"
import { merchantById } from "./merchants"

/** The UPI apps the picker shows. A fixed list for now (from v0's checkout); the real installed apps come from a
 *  native module call once native modules are built (docs/native-modules.md). */
interface UpiAppTile {
  name: string
  pkg: string
  badge: string
  color: string
}
const UPI_APPS: UpiAppTile[] = [
  { name: "PhonePe", pkg: "com.phonepe.app", badge: "Instant", color: "#5F259F" },
  { name: "Google Pay", pkg: "com.google.android.apps.nbu.paisa.user", badge: "Fast", color: "#1A73E8" },
  { name: "Paytm", pkg: "net.one97.paytm", badge: "Fast", color: "#00B9F1" },
  { name: "CRED", pkg: "com.dreamplug.androidapp", badge: "Rewards", color: "#1F2937" },
  { name: "P2P Mock UPI", pkg: "p2pdops.android.p2pupiapp", badge: "Test app", color: "#15803D" },
]

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
    <Pressable onPress={() => props.onKey(props.label)} haptic pressScale={0.94} alignItems="center" justifyContent="center" style={keyStyle}>
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
      pressScale={0.94}
      alignItems="center"
      justifyContent="center"
      style={keyStyle}
    >
      <Icon icon={backspaceIcon} color={c.ink} />
    </Pressable>
  )
}

export function AmountScreen(props: { merchantId: string }) {
  const merchant = merchantById(props.merchantId)
  const amount = signal("0")
  const status = signal("")
  const cursor = signal(true)
  const confirmDiscard = signal(false)

  // Blinking cursor. Owned by this screen: it stops when the screen closes.
  setInterval(() => {
    cursor.set((v) => !v)
  }, 500)

  // Back (system button / gesture, or the ← button) with an amount typed: ask first instead of losing it.
  const leave = (): boolean => {
    if (amount() === "0") return false
    confirmDiscard.set(true)
    return true
  }
  useBack(leave)
  const goBack = () => {
    if (!leave()) nav.back()
  }
  const discard = () => {
    confirmDiscard.set(false)
    nav.back()
  }

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
  // "Pay Now" opens the UPI app picker (a native bottom sheet we control with this signal).
  const pickerOpen = signal(false)
  const pay = () => pickerOpen.set(true)
  // One receipt per payment, even if an app is tapped twice quickly (the second tap arrives before the screen changes).
  // Launching the real UPI app comes with flows (milestone 2 step 2.8); for now the receipt opens directly.
  let paid = false
  const payWith = (app: UpiAppTile) => {
    if (paid) return
    paid = true
    pickerOpen.set(false)
    nav.push("receipt", { ztc: `ZTC${Date.now()}`, amount: rupees(money().toPay), via: app.name })
  }

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
          onPress={goBack}
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
            src={merchant.photo}
            style={{ width: 38, height: 38, borderRadius: 19, borderWidth: 1, borderColor: c.border }}
          />
          <Column style={{ alignItems: "center" }}>
            <Text fontSize={16} fontWeight={700} color={c.ink}>
              {merchant.name}
            </Text>
            <Text fontSize={11} color={c.muted}>
              {merchant.area}
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

      {/* Shown instead of going back when an amount is typed. */}
      {confirmDiscard() && (
        <Row
          style={{
            paddingHorizontal: 16,
            paddingVertical: 10,
            gap: 8,
            alignItems: "center",
            backgroundColor: c.ink,
          }}
        >
          <Column style={{ flex: 1 }}>
            <Text fontSize={14} fontWeight={600} color={c.white}>
              Discard ₹{formatIndian(amount())}?
            </Text>
          </Column>
          <Pressable
            onPress={() => confirmDiscard.set(false)}
            style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: c.white }}
          >
            <Text fontSize={13} fontWeight={600} color={c.ink}>
              Keep
            </Text>
          </Pressable>
          <Pressable
            onPress={discard}
            style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: c.primary }}
          >
            <Text fontSize={13} fontWeight={600} color={c.white}>
              Discard
            </Text>
          </Pressable>
        </Row>
      )}

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

      {/* UPI app picker: a native bottom sheet. Drag it down, tap outside or press back: onDismiss asks us to close. */}
      <Sheet visible={pickerOpen()} onDismiss={() => pickerOpen.set(false)} style={{ paddingHorizontal: 20, paddingBottom: 16, gap: 12 }}>
        <Column style={{ gap: 2 }}>
          <Text fontSize={18} fontWeight={700} color={c.ink}>
            Pay ₹{rupees(money().toPay)} with
          </Text>
          <Text fontSize={13} color={c.muted}>
            Choose a UPI app on this phone
          </Text>
        </Column>
        {UPI_APPS.map((app) => (
          <Pressable
            key={app.pkg}
            onPress={() => payWith(app)}
            style={{ padding: 12, borderRadius: 14, borderWidth: 1, borderColor: c.border, backgroundColor: c.white }}
          >
            <Row style={{ gap: 12, alignItems: "center" }}>
              <Box alignItems="center" justifyContent="center" style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: app.color }}>
                <Text fontSize={16} fontWeight={800} color={c.white}>
                  {app.name.charAt(0)}
                </Text>
              </Box>
              <Column style={{ flex: 1, gap: 2 }}>
                <Text fontSize={15} fontWeight={600} color={c.ink}>
                  {app.name}
                </Text>
                <Text fontSize={11} color={c.muted}>
                  {app.pkg}
                </Text>
              </Column>
              <Box style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: c.pillBg }}>
                <Text fontSize={11} fontWeight={700} color={c.ink}>
                  {app.badge}
                </Text>
              </Box>
            </Row>
          </Pressable>
        ))}
      </Sheet>
    </Column>
  )
}
