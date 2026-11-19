// Shown after a payment (route "/receipt/:ztc", opened as a modal). The real result comes with flows (step 2.8).
// Full-bleed: the route has `safeArea: { top: false }`, so the green header runs behind the status bar and pads its
// own content with insets().top.
import { Column, Pressable, Text } from "@zeronative/ui"
import { insets, nav } from "@zeronative/core"
import { c } from "./tokens"

export function ReceiptScreen(props: { ztc: string; amount?: string; via?: string }) {
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Column
        style={{ backgroundColor: c.success, paddingTop: insets().top + 32, paddingBottom: 32, paddingHorizontal: 24, gap: 6 }}
        alignItems="center"
      >
        <Text fontSize={15} fontWeight={600} color={c.white}>
          Payment received
        </Text>
        <Text fontSize={40} fontWeight="bold" color={c.white}>
          ₹{props.amount ?? "—"}
        </Text>
      </Column>
      <Column style={{ flex: 1, padding: 24, gap: 8 }} alignItems="center">
        <Text fontSize={13} color={c.muted}>
          {props.via ? `Paid with ${props.via} · ` : ""}Reference {props.ztc}
        </Text>
        <Pressable
          onPress={() => nav.reset([{ name: "home" }])}
          alignItems="center"
          justifyContent="center"
          style={{ marginTop: 24, height: 52, width: 200, borderRadius: 14, backgroundColor: c.primary }}
        >
          <Text fontSize={16} fontWeight={600} color={c.white}>
            Done
          </Text>
        </Pressable>
      </Column>
    </Column>
  )
}
