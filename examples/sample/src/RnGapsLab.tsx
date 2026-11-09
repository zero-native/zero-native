// RN gaps pack (2026-11-09, registry 24): custom fonts first. Each case shows its expected look in its label, so a
// screenshot is the check. The fonts are in ../assets/fonts (OFL fonts: Inconsolata Regular / Medium / SemiBold,
// Space Mono, Lato Black; see ../FONTS-LICENSE.md).
import { Column, Pressable, Row, Scroll, Text, TextField, View } from "@zero-native/ui"
import { signal } from "@zero-native/core"
import { c } from "./tokens"

function Title(props: { text: string }) {
  return (
    <Text fontSize={15} fontWeight={700} color={c.ink} style={{ marginTop: 10 }}>
      {props.text}
    </Text>
  )
}

function Note(props: { text: string }) {
  return (
    <Text fontSize={11} color={c.muted}>
      {props.text}
    </Text>
  )
}

/** Parts from data (a server's "**₹400** cashback"), each in its own font: spans that change at runtime. */
const PARTS = [
  { text: "Paid ", font: "Inconsolata" },
  { text: "₹1,299", font: "lato-black" },
  { text: " at ", font: "Inconsolata" },
  { text: "Ravi Stores", font: "SpaceMono-Regular" },
]

const CHIPS = ["Groceries", "Pharmacy", "Restaurants", "Fuel", "Electronics", "Fashion", "Bakery", "Salon", "Mobile recharge", "Books"]

/** A filter chip, as an RN app writes one. */
function Chip(props: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      style={{
        paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, borderWidth: 1,
        borderColor: props.on ? c.primary : c.border, backgroundColor: props.on ? "#EEF2FF" : c.white,
      }}
    >
      <Text fontSize={13} fontWeight={600} color={props.on ? c.primary : c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function RnGapsLabScreen() {
  // A name this APK has no font for, as an OTA bundle could send in data: the system font, never a crash.
  const unknown = signal("NoSuchFont")
  const name = signal("")
  const picked = signal<string[]>(["Groceries", "Fuel"])
  const wide = signal(false)
  return (
    <Scroll style={{ flex: 1, backgroundColor: c.white }}>
      <Column gap={6} style={{ padding: 16 }}>
        <Text testID="gaps-title" fontSize={18} fontWeight={800} color={c.ink}>
          RN gaps lab
        </Text>

        <Title text="1. fontFamily: one family, fontWeight picks the face" />
        <Text style={{ fontFamily: "Inconsolata", fontSize: 18, color: c.ink }}>Inconsolata 400 (Regular)</Text>
        <Text style={{ fontFamily: "Inconsolata", fontWeight: 500, fontSize: 18, color: c.ink }}>Inconsolata 500 (Medium)</Text>
        <Text style={{ fontFamily: "Inconsolata", fontWeight: 600, fontSize: 18, color: c.ink }}>Inconsolata 600 (SemiBold)</Text>
        <Text style={{ fontFamily: "Inconsolata", fontWeight: "bold", fontSize: 18, color: c.ink }}>
          Inconsolata bold: the SemiBold face, not fake bold
        </Text>
        <Text style={{ fontFamily: "Inconsolata", fontStyle: "italic", fontSize: 18, color: c.ink }}>
          Inconsolata italic: slanted by the phone (no italic file)
        </Text>

        <Title text="2. A file name is a font too (RN Android)" />
        <Text style={{ fontFamily: "Inconsolata-SemiBold", fontSize: 18, color: c.ink }}>Inconsolata-SemiBold</Text>
        <Text style={{ fontFamily: "SpaceMono-Regular", fontSize: 18, color: c.ink }}>SpaceMono-Regular 0123456789</Text>
        <Text style={{ fontFamily: "lato-black", fontSize: 30, color: c.primary }}>₹1,299</Text>
        <Note text="Above: Lato Black (₹ may come from the phone's font if Lato has no ₹)" />

        <Title text="3. The phone's own fonts" />
        <Text style={{ fontFamily: "System", fontSize: 16, color: c.ink }}>System (Roboto)</Text>
        <Text style={{ fontFamily: "serif", fontSize: 16, color: c.ink }}>serif</Text>
        <Text style={{ fontFamily: "monospace", fontSize: 16, color: c.ink }}>monospace</Text>
        <Text style={{ fontFamily: "sans-serif-medium", fontSize: 16, color: c.ink }}>sans-serif-medium</Text>
        <Text style={{ fontFamily: "sans-serif-condensed", fontSize: 16, color: c.ink }}>sans-serif-condensed</Text>

        <Title text="4. Spans" />
        <Text fontSize={16} color={c.ink}>
          {"Plain, "}
          <Text style={{ fontFamily: "SpaceMono-Regular" }}>Space Mono span</Text>
          {", "}
          <Text style={{ fontFamily: "Inconsolata", fontWeight: 600 }}>Inconsolata 600 span</Text>
        </Text>
        <Text fontSize={16} color={c.ink}>
          {PARTS.map((p) => (
            <Text style={{ fontFamily: p.font }}>{p.text}</Text>
          ))}
        </Text>
        <Note text="Above: spans from data (runtime spans), each in its own font" />
        <Text fontSize={16} color={c.ink}>
          <Text style={{ fontFamily: unknown() }}>Unknown font name from data: system font, no crash</Text>
        </Text>

        <Title text="6. flexWrap: chips (RN View, gap 8)" />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {CHIPS.map((label) => (
            <Chip
              key={label}
              label={label}
              on={picked().includes(label)}
              onPress={() => picked.set(picked().includes(label) ? picked().filter((x) => x !== label) : [...picked(), label])}
            />
          ))}
        </View>
        <Note text={`Picked: ${picked().join(", ") || "none"} (tap chips: they wrap, the picked ones turn blue)`} />
        <Title text="7. flexWrap: rowGap from a signal, justifyContent center" />
        <Row justifyContent="center" style={{ flexWrap: "wrap", columnGap: 6, rowGap: wide() ? 24 : 6, padding: 8, backgroundColor: c.pillBg, borderRadius: 12 }}>
          {CHIPS.slice(0, 7).map((label) => (
            <Text key={label} style={{ fontSize: 12, color: c.ink, backgroundColor: c.white, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 }}>{label}</Text>
          ))}
        </Row>
        <Pressable onPress={() => wide.set(!wide())} style={{ padding: 10, borderRadius: 8, backgroundColor: c.primary, alignSelf: "flex-start" }}>
          <Text fontSize={13} fontWeight={600} color={c.white}>{wide() ? "rowGap 24 (tap: 6)" : "rowGap 6 (tap: 24)"}</Text>
        </Pressable>

        <Title text="5. TextField" />
        <TextField
          value={name()}
          onChangeText={(t) => name.set(t)}
          placeholder="Type in Space Mono"
          style={{ fontFamily: "SpaceMono-Regular", fontSize: 16, color: c.ink, borderWidth: 1, borderColor: c.border, borderRadius: 8, padding: 10 }}
        />
        <Row gap={8}>
          <Text style={{ fontFamily: "Inconsolata", fontSize: 14, color: c.muted }}>Typed:</Text>
          <Text style={{ fontFamily: "Inconsolata", fontWeight: 600, fontSize: 14, color: c.ink }}>{name() || "-"}</Text>
        </Row>
      </Column>
    </Scroll>
  )
}
