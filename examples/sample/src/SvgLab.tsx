// A dev screen for SVG (docs/svg.md, step S.4): .svg files as components, an icon set, an inline <Svg> with gradients
// and a clip, text over an SVG, parts that change at runtime, and SVGs in a long list.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/svg
import {
  Circle, ClipPath, Column, Defs, G, LinearGradient, List, Path, Pressable, RadialGradient, Rect, Row, Scroll, Stack,
  Stop, Svg, Text,
} from "@zero-native/ui"
import { nav, signal } from "@zero-native/core"
import { c } from "./tokens"
import { Bell, Done, Heart, HeartFilled, Home, Offer, Person, Receipt, Scan, Search, Wallet } from "./svg/icons"
import Badge from "./svg/badge.svg"

const like = "#E11D48"
const RING_COLORS = ["#3D26ED", "#15803D", "#E11D48", "#F59E0B"]
// Soft circles on the card, clipped by its rounded corners.
const BUBBLES = [
  { cx: 300, cy: 18, r: 70, o: 0.16 },
  { cx: 250, cy: 170, r: 54, o: 0.1 },
  { cx: 22, cy: 150, r: 30, o: 0.08 },
]

function Section(props: { title: string; note: string; children?: unknown }) {
  return (
    <Column style={{ gap: 10 }}>
      <Column style={{ gap: 2 }}>
        <Text fontSize={16} fontWeight={700} color={c.ink}>
          {props.title}
        </Text>
        <Text fontSize={12} color={c.muted}>
          {props.note}
        </Text>
      </Column>
      {props.children}
    </Column>
  )
}

/** The wallet card: one inline <Svg> (gradient, radial glow, clip) with zn <Text> on top in a <Stack>. */
function WalletCard() {
  return (
    <Stack style={{ height: 168, borderRadius: 20 }}>
      <Svg viewBox="0 0 328 168" preserveAspectRatio="none" style={{ width: "100%", height: 168 }}>
        <Defs>
          <LinearGradient id="card" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#3D26ED" />
            <Stop offset="1" stopColor="#7C3AED" />
          </LinearGradient>
          <RadialGradient id="glow" cx="0.5" cy="0.5" r="0.5">
            <Stop offset="0" stopColor="#FFFFFF" stopOpacity={0.35} />
            <Stop offset="1" stopColor="#FFFFFF" stopOpacity={0} />
          </RadialGradient>
          <ClipPath id="corners">
            <Rect width={328} height={168} rx={20} />
          </ClipPath>
        </Defs>
        <G clipPath="url(#corners)">
          <Rect width={328} height={168} fill="url(#card)" />
          {BUBBLES.map((b) => (
            <Circle cx={b.cx} cy={b.cy} r={b.r} fill="#FFFFFF" opacity={b.o} />
          ))}
          <Circle cx={60} cy={20} r={90} fill="url(#glow)" />
          <Path d="M0 128 C80 100 150 150 230 124 S310 104 328 112 V168 H0Z" fill="#FFFFFF" opacity={0.08} />
        </G>
      </Svg>
      <Column style={{ padding: 20, gap: 4, height: 168 }}>
        <Row style={{ alignItems: "center", gap: 8 }}>
          <Wallet size={20} color={c.white} />
          <Text fontSize={13} fontWeight={600} color="#E0E7FF">
            Wallet balance
          </Text>
        </Row>
        <Text fontSize={32} fontWeight={800} color={c.white}>
          ₹1,25,000
        </Text>
        <Column style={{ flex: 1 }} />
        <Row style={{ alignItems: "center", gap: 6 }}>
          <Done size={16} color="#BBF7D0" />
          <Text fontSize={12} fontWeight={600} color="#E0E7FF">
            You saved ₹1,240 this month
          </Text>
        </Row>
      </Column>
    </Stack>
  )
}

function IconTile(props: { label: string; children?: unknown }) {
  return (
    <Column style={{ alignItems: "center", gap: 6, width: 72 }}>
      <Column
        style={{ width: 52, height: 52, borderRadius: 16, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" }}
      >
        {props.children}
      </Column>
      <Text fontSize={12} color={c.ink}>
        {props.label}
      </Text>
    </Column>
  )
}

/** Clip: a round avatar cut from a striped square, with a status dot outside the clip. */
function Avatar() {
  return (
    <Svg viewBox="0 0 64 64" size={64} accessibilityLabel="Avatar">
      <Defs>
        <ClipPath id="round">
          <Circle cx={30} cy={30} r={28} />
        </ClipPath>
      </Defs>
      <G clipPath="url(#round)">
        <Rect width={64} height={64} fill="#FDE68A" />
        <Path d="M-10 40 L40 -10 L54 -10 L-10 54Z M10 74 L74 10 L74 24 L24 74Z" fill="#F59E0B" />
        <Circle cx={30} cy={24} r={10} fill="#92400E" />
        <Path d="M10 58 C12 42 48 42 50 58Z" fill="#92400E" />
      </G>
      <Circle cx={52} cy={52} r={8} fill="#FFFFFF" />
      <Circle cx={52} cy={52} r={5.5} fill="#15803D" />
    </Svg>
  )
}

const ROWS = Array.from({ length: 60 }, (_, i) => ({
  id: i,
  name: ["Sri Sai Stores", "Fresh Basket", "Bangalore Bakery", "Green Leaf Café"][i % 4]!,
  amount: 120 + ((i * 137) % 900),
  paid: i % 3 !== 0,
}))

export function SvgLabScreen() {
  const liked = signal(false)
  const ring = signal(0)
  const done = signal(true)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 12, paddingVertical: 8 }}>
        <Pressable onPress={() => nav.back()} alignItems="center" justifyContent="center" style={{ width: 40, height: 40, borderRadius: 20 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          SVG lab
        </Text>
      </Row>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 16, paddingBottom: 32, gap: 24 }}>
          <WalletCard />

          <Section title="Icons" note="Material Symbols .svg files, tinted with color">
            <Row style={{ justifyContent: "space-between" }}>
              <IconTile label="Home"><Home size={26} color={c.primary} /></IconTile>
              <IconTile label="Scan"><Scan size={26} color={c.primary} /></IconTile>
              <IconTile label="Offers"><Offer size={26} color={c.primary} /></IconTile>
              <IconTile label="Receipts"><Receipt size={26} color={c.primary} /></IconTile>
            </Row>
            <Row style={{ justifyContent: "space-between" }}>
              <IconTile label="Search"><Search size={26} color={c.ink} /></IconTile>
              <IconTile label="Alerts"><Bell size={26} color={c.ink} /></IconTile>
              <IconTile label="Wallet"><Wallet size={26} color={c.ink} /></IconTile>
              <IconTile label="Profile"><Person size={26} color={c.ink} /></IconTile>
            </Row>
          </Section>

          <Section title="Changes at runtime" note="Tap: color, parts and a swap between two files">
            <Row style={{ gap: 12, alignItems: "center" }}>
              <Pressable
                onPress={() => liked.set(!liked())}
                alignItems="center"
                justifyContent="center"
                accessibilityLabel="Like"
                style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
              >
                {liked() ? <HeartFilled size={30} color={like} /> : <Heart size={30} color={c.muted} />}
              </Pressable>
              <Pressable
                onPress={() => ring.set((ring() + 1) % RING_COLORS.length)}
                alignItems="center"
                justifyContent="center"
                accessibilityLabel="Change ring colour"
                style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
              >
                <Badge size={48} parts={{ ring: { stroke: RING_COLORS[ring()]! }, tick: { stroke: RING_COLORS[ring()]! } }} />
              </Pressable>
              <Pressable
                onPress={() => done.set(!done())}
                alignItems="center"
                justifyContent="center"
                accessibilityLabel="Show or hide the tick"
                style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
              >
                <Badge size={48} parts={{ tick: { opacity: done() ? 1 : 0 } }} />
              </Pressable>
              <Avatar />
            </Row>
          </Section>

          <Section title="In a list" note="60 rows, an SVG in each; scroll fast to check for jank">
            <List
              data={ROWS}
              key={(r) => r.id}
              gap={8}
              style={{ height: 360 }}
              row={(r) => (
                <Row style={{ alignItems: "center", gap: 12, padding: 12, borderRadius: 14, backgroundColor: c.white }}>
                  <Column style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" }}>
                    <Receipt size={22} color={c.primary} />
                  </Column>
                  <Column style={{ flex: 1, gap: 2 }}>
                    <Text fontSize={14} fontWeight={600} color={c.ink}>
                      {r.name}
                    </Text>
                    <Text fontSize={12} color={r.paid ? c.success : c.muted}>
                      {r.paid ? "Paid" : "Pending"}
                    </Text>
                  </Column>
                  <Text fontSize={15} fontWeight={700} color={c.ink}>
                    {`₹${r.amount.toLocaleString("en-IN")}`}
                  </Text>
                </Row>
              )}
            />
          </Section>
        </Column>
      </Scroll>
    </Column>
  )
}
