// The sample's start screen (route "/"): a short merchant list. Tapping a row opens the Amount screen; the
// 10,000-row virtualized version comes with <List> (step 2.4).
import { Column, Image, Pressable, Row, Text } from "@zero-native/ui"
import { nav } from "@zero-native/core"
import { c } from "./tokens"
import { MERCHANTS } from "./merchants"

export function HomeScreen() {
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Column style={{ paddingHorizontal: 20, paddingTop: 24, paddingBottom: 12, gap: 4 }}>
        <Text fontSize={24} fontWeight="bold" color={c.ink}>
          Pay a merchant
        </Text>
        <Text fontSize={13} color={c.muted}>
          Recent stores near you
        </Text>
      </Column>
      <Column style={{ paddingHorizontal: 12, gap: 8 }}>
        {MERCHANTS.map((m) => (
          <Pressable
            key={m.id}
            onPress={() => nav.push("amount", { merchantId: m.id })}
            style={{ padding: 12, borderRadius: 14, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
          >
            <Row style={{ gap: 12, alignItems: "center" }}>
              <Image src={m.photo} style={{ width: 44, height: 44, borderRadius: 22 }} />
              <Column style={{ gap: 2 }}>
                <Text fontSize={16} fontWeight={600} color={c.ink}>
                  {m.name}
                </Text>
                <Text fontSize={12} color={c.muted}>
                  {m.area}
                </Text>
              </Column>
            </Row>
          </Pressable>
        ))}
      </Column>
    </Column>
  )
}
