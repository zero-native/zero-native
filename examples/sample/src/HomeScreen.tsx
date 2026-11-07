// The sample's start screen (route "/"): 10,000 merchants in a virtualized <List> with two row kinds (an area header
// every 100 rows, merchant rows). "New payment arrives" inserts a row at the top: the visible rows must not move.
import { Box, Column, List, Pressable, Row, Text } from "@zero-native/ui"
import { createStorage, nav, signal } from "@zero-native/core"
import { c } from "./tokens"
import { generatedMerchant, type Merchant } from "./merchants"

const COUNT = 10_000
const AVATAR = ["#E0E7FF", "#DCFCE7", "#FEF3C7", "#FCE7F3", "#E0F2FE", "#F3E8FF"]

type Item = { kind: "header"; id: string; title: string } | ({ kind: "merchant"; paid?: boolean } & Merchant)

function buildFeed(): Item[] {
  const out: Item[] = []
  for (let i = 0; i < COUNT; i++) {
    const m = generatedMerchant(i)
    if (i % 100 === 0) out.push({ kind: "header", id: `h${i}`, title: `${m.area} · stores ${i + 1}–${i + 100}` })
    out.push({ kind: "merchant", ...m })
  }
  return out
}

// Dev check (RN props lab, "Open this lab at next start"): a push while START builds Home is one of the first screens,
// with no slide-in, as a payment restored after a kill opens checkout over Home.
const devStart = createStorage("dev.start")

export function HomeScreen() {
  if (devStart.getString("push") === "rnPropsLab") {
    devStart.delete("push")
    nav.push("rnPropsLab")
  }
  const feed = signal(buildFeed())
  let arrivals = 0
  const newPayment = () => {
    arrivals++
    const m = generatedMerchant(COUNT + arrivals)
    feed.set([{ kind: "merchant", ...m, name: `Just paid: ${m.name}`, paid: true }, ...feed()])
  }

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Column style={{ paddingHorizontal: 20, paddingTop: 20, gap: 2 }}>
        <Text fontSize={24} fontWeight="bold" color={c.ink}>
          Pay a merchant
        </Text>
        <Text fontSize={13} color={c.muted}>
          {feed().length} stores near you
        </Text>
      </Column>
      <Row style={{ paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12, gap: 8, alignItems: "center" }}>
        <Pressable
          onPress={() => nav.push("dev")}
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.pillBg }}
        >
          <Text fontSize={12} fontWeight={700} color={c.ink}>
            Dev screens
          </Text>
        </Pressable>
        <Pressable
          onPress={() => nav.push("offers")}
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.successBg }}
        >
          <Text fontSize={12} fontWeight={700} color={c.success}>
            Offers
          </Text>
        </Pressable>
        <Pressable
          onPress={newPayment}
          rippleColor="#FFFFFF"
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.primary }}
        >
          <Text fontSize={12} fontWeight={600} color={c.white}>
            New payment arrives
          </Text>
        </Pressable>
      </Row>
      <List
        data={feed()}
        key={(f) => f.id}
        style={{ flex: 1, paddingHorizontal: 12 }}
        gap={8}
        row={(f) =>
          f.kind === "header" ? (
            <Text fontSize={13} fontWeight={700} color={c.muted} style={{ paddingTop: 12, paddingHorizontal: 4 }}>
              {f.title}
            </Text>
          ) : (
            <Pressable
              onPress={() => nav.push("amount", { merchantId: f.id })}
              style={{ padding: 12, borderRadius: 14, backgroundColor: f.paid ? c.successBg : c.white, borderWidth: 1, borderColor: c.border }}
            >
              <Row style={{ gap: 12, alignItems: "center" }}>
                <Box
                  alignItems="center"
                  justifyContent="center"
                  style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: AVATAR[f.name.length % AVATAR.length] }}
                >
                  <Text fontSize={18} fontWeight={700} color={c.ink}>
                    {f.name.charAt(0)}
                  </Text>
                </Box>
                <Column style={{ gap: 2 }}>
                  <Text fontSize={16} fontWeight={600} color={c.ink}>
                    {f.name}
                  </Text>
                  <Text fontSize={12} color={c.muted}>
                    {f.area}
                  </Text>
                </Column>
              </Row>
            </Pressable>
          )
        }
      />
    </Column>
  )
}
