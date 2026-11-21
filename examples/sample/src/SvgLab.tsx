// A dev screen for SVG (docs/svg.md, step S.4): .svg files as components, an icon set, an inline <Svg> with gradients
// and a clip, text over an SVG, parts that change at runtime, motion (S.12: loops, trims, replay), and SVGs in a long list.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/svg
import {
  Box, Circle, ClipPath, Column, Defs, G, LinearGradient, List, Path, Pressable, RadialGradient, Rect, Row, Scroll, Stack,
  Stop, Svg, Text,
} from "@zeronative/ui"
import { nav, signal } from "@zeronative/core"
import { c } from "./tokens"
import { Bell, Done, Heart, HeartFilled, Home, Offer, Person, Receipt, Scan, Search, Wallet } from "./svg/icons"
import Badge from "./svg/badge.svg"
// Downloaded animated SVGs (svg-spinners, MIT): SMIL and CSS, compiled into part animations (S.14).
import Ring from "./svg/loaders/90-ring-with-bg.svg"
import Dots from "./svg/loaders/3-dots-bounce.svg"
import Bars from "./svg/loaders/bars-scale.svg"
import Rings from "./svg/loaders/pulse-rings-multiple.svg"
import Wifi from "./svg/loaders/wifi.svg"
import Ball from "./svg/loaders/bouncing-ball.svg"
import Resize from "./svg/loaders/ring-resize.svg"
import Puff from "./svg/loaders/puff.svg"
import Ripple from "./svg/loaders/rings.svg"
import Triangle from "./svg/loaders/ball-triangle.svg"
import TickMorph from "./svg/tick-morph.svg"
import SparkLine from "./svg/spark-line.svg"
// Registry 13 (docs/svg.md §17): our own small files, one feature each.
import CoinShadow from "./svg/r13/coin-shadow.svg"
import StripesFade from "./svg/r13/stripes-fade.svg"
import Route from "./svg/r13/route.svg"
import Blend from "./svg/r13/blend.svg"
import AlongPath from "./svg/r13/along-path.svg"
import Clock from "./svg/r13/clock.svg"
import Flag from "./svg/r13/flag.svg"
import GlowRing from "./svg/r13/glow-ring.svg"
import StarMorph from "./svg/r13/star-morph.svg"
import TapHeart from "./svg/r13/tap-heart.svg"
import CssBars from "./svg/r13/css-bars.svg"
import TwoShadows from "./svg/r13/two-shadows.svg"
import ShadowSkew from "./svg/r13/shadow-skew.svg"

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

function MotionTile(props: { label: string; onPress?: () => void; children?: unknown }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ gap: 6, width: 76 }} accessibilityLabel={props.label}>
      <Column
        style={{ width: 64, height: 64, borderRadius: 16, backgroundColor: c.white, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center" }}
      >
        {props.children}
      </Column>
      <Text fontSize={12} color={c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const LOOP = { easing: "linear", from: 0, repeat: "forever" } as const
const GAUGE = [20, 55, 90]

/** Motion (docs/svg.md §9): loops, keyframes, trims and replay on SVG parts and plain elements; one pause for all. */
function MotionSection() {
  const paused = signal(false)
  const gauge = signal(0)
  const paid = signal(0)
  const shake = signal(0)
  const hearts = signal(0)

  return (
    <Section title="Motion" note="Loops, keyframes and trims. Tap a tile to change or replay it">
      <Row style={{ justifyContent: "space-between" }}>
        <MotionTile label="Loading">
          <Svg viewBox="0 0 24 24" size={36}>
            <Circle cx={12} cy={12} r={9} fill="none" stroke={c.border} strokeWidth={3} />
            <Circle
              cx={12} cy={12} r={9} fill="none" stroke={c.primary} strokeWidth={3} strokeLinecap="round"
              trimEnd={0.28} rotate={360} animate={{ rotate: { duration: 900, ...LOOP } }} paused={paused()}
            />
          </Svg>
        </MotionTile>
        <MotionTile label="Live">
          <Svg viewBox="0 0 24 24" size={36}>
            <Circle
              cx={12} cy={12} r={11} fill="#C7D2FE" paused={paused()}
              animate={{
                scale: { duration: 1400, keyframes: [0.4, 1], repeat: "forever" },
                opacity: { duration: 1400, keyframes: [0.9, 0], repeat: "forever" },
              }}
            />
            <Circle cx={12} cy={12} r={5} fill={c.primary} />
          </Svg>
        </MotionTile>
        <MotionTile label={`Score ${GAUGE[gauge()]}`} onPress={() => gauge.set((gauge() + 1) % GAUGE.length)}>
          <Svg viewBox="0 0 32 20" size={44}>
            <Path d="M4 18 A12 12 0 0 1 28 18" fill="none" stroke={c.border} strokeWidth={4} strokeLinecap="round" />
            <Path
              d="M4 18 A12 12 0 0 1 28 18" fill="none" stroke={c.success} strokeWidth={4} strokeLinecap="round"
              trimEnd={GAUGE[gauge()]! / 100} animate={{ trimEnd: { duration: 600, easing: "ease-out" } }}
            />
          </Svg>
        </MotionTile>
        <MotionTile label="Pulse">
          <Svg viewBox="0 0 48 24" size={44}>
            <Path
              d="M2 13h11l3-7 5 14 4-11 3 4h18" fill="none" stroke={c.success} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
              trimEnd={1} animate={{ trimEnd: { duration: 1300, ...LOOP, repeatDelay: 400 } }} paused={paused()}
            />
          </Svg>
        </MotionTile>
      </Row>
      <Row style={{ alignItems: "center", gap: 12 }}>
        <MotionTile label="Paid" onPress={() => paid.set(paid() + 1)}>
          <Badge
            size={48}
            parts={{
              ring: { trimEnd: 1, replay: paid(), animate: { trimEnd: { duration: 500, easing: "ease-out", from: 0 } } },
              tick: { trimEnd: 1, replay: paid(), animate: { trimEnd: { duration: 300, easing: "ease-out", from: 0, delay: 450 } } },
            }}
          />
        </MotionTile>
        <MotionTile label="Wrong OTP" onPress={() => shake.set(shake() + 1)}>
          <Box replay={shake()} animate={{ translateX: { duration: 400, keyframes: [0, -8, 8, -6, 6, -3, 0] } }}>
            <Text fontSize={15} fontWeight={700} color="#DC2626">
              4 2 _ _
            </Text>
          </Box>
        </MotionTile>
        <Column style={{ flex: 1, alignItems: "center" }}>
          <Box
            paused={paused()}
            animate={{ scale: { duration: 700, keyframes: [1, 1.06, 1], repeat: "forever", repeatDelay: 1200 } }}
            style={{ paddingHorizontal: 20, paddingVertical: 12, borderRadius: 24, backgroundColor: c.primary }}
          >
            <Text fontSize={15} fontWeight={700} color={c.white}>
              Pay ₹249
            </Text>
          </Box>
        </Column>
      </Row>
      <Column style={{ gap: 2 }}>
        <Text fontSize={14} fontWeight={700} color={c.ink}>
          Downloaded .svg loaders
        </Text>
        <Text fontSize={12} color={c.muted}>
          SMIL and CSS files from svg-spinners and SVG-Loaders, used as they are
        </Text>
      </Column>
      <Row style={{ justifyContent: "space-between" }}>
        <MotionTile label="Ring"><Ring size={32} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Dots"><Dots size={32} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Bars"><Bars size={32} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Rings"><Rings size={32} color={c.primary} paused={paused()} /></MotionTile>
      </Row>
      <Row style={{ justifyContent: "space-between" }}>
        <MotionTile label="Wifi"><Wifi size={32} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Ball"><Ball size={32} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Resize"><Resize size={32} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Puff"><Puff size={36} color={c.primary} paused={paused()} /></MotionTile>
      </Row>
      <Row style={{ justifyContent: "space-between" }}>
        <MotionTile label="Ripple"><Ripple size={36} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Triangle"><Triangle size={36} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Morph"><TickMorph size={32} color={c.success} paused={paused()} /></MotionTile>
        <MotionTile label="Same line"><SparkLine size={52} color={c.primary} /></MotionTile>
      </Row>
      <Column style={{ gap: 2 }}>
        <Text fontSize={14} fontWeight={700} color={c.ink}>
          More motion
        </Text>
        <Text fontSize={12} color={c.muted}>
          Along a path, steps, skew, stop colours, points, CSS. Tap the heart
        </Text>
      </Column>
      <Row style={{ justifyContent: "space-between" }}>
        <MotionTile label="Along"><AlongPath size={40} color={c.primary} paused={paused()} /></MotionTile>
        <MotionTile label="Clock"><Clock size={40} color={c.ink} paused={paused()} /></MotionTile>
        <MotionTile label="Flag"><Flag size={40} paused={paused()} /></MotionTile>
        <MotionTile label="Colours"><GlowRing size={40} paused={paused()} /></MotionTile>
      </Row>
      <Row style={{ justifyContent: "space-between" }}>
        <MotionTile label="Star"><StarMorph size={40} paused={paused()} /></MotionTile>
        {/* The heart's own begin="click" and this tile's onPress both get each tap (docs/svg.md §17). */}
        <MotionTile label={hearts() === 0 ? "Tap me" : `Taps ${hearts()}`} onPress={() => hearts.set(hearts() + 1)}>
          <TapHeart size={40} accessibilityLabel="Heart, tap to pop" />
        </MotionTile>
        <MotionTile label="CSS"><CssBars size={40} paused={paused()} /></MotionTile>
        <Column style={{ width: 76 }} />
      </Row>
      <Row style={{ alignItems: "center", gap: 12 }}>
        <SparkLine size={20} color={c.primary} />
        <SparkLine size={40} color={c.primary} />
        <Text fontSize={12} color={c.muted} style={{ flex: 1 }}>
          The chart line stays 2 dp thick at every size
        </Text>
      </Row>
      <Pressable
        onPress={() => paused.set(!paused())}
        alignItems="center"
        justifyContent="center"
        accessibilityLabel={paused() ? "Play the loops" : "Pause the loops"}
        style={{ height: 48, borderRadius: 24, borderWidth: 1, borderColor: c.border, backgroundColor: c.white }}
      >
        <Text fontSize={14} fontWeight={600} color={c.primary}>
          {paused() ? "Play the loops" : "Pause the loops"}
        </Text>
      </Pressable>
    </Section>
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

          <Section title="Effects" note="Shadow and text, pattern with a fade, route markers, blend, two stacked shadows (straight down, then pushed right)">
            <Row style={{ justifyContent: "space-between" }}>
              <IconTile label="Shadow"><CoinShadow size={40} /></IconTile>
              <IconTile label="Pattern"><StripesFade size={40} /></IconTile>
              <IconTile label="Route"><Route size={40} /></IconTile>
              <IconTile label="Blend"><Blend size={40} /></IconTile>
            </Row>
            {/* Two drop shadows merged (as Figma exports a stack): a tight dark one and a wide indigo one, both under the card. */}
            <Row style={{ justifyContent: "space-between" }}>
              <IconTile label="2 shadows"><TwoShadows size={40} /></IconTile>
              <Column style={{ width: 120, height: 104, borderRadius: 16, backgroundColor: c.white, alignItems: "center", justifyContent: "center" }}>
                <TwoShadows size={96} />
              </Column>
            </Row>
            {/* The same stack pushed right (dx) under an L shape, with a dot whose own shadow falls left: both stacked
                shadows keep the notch and fall right and down; the dot's green shadow is on its left. */}
            <Row style={{ justifyContent: "space-between" }}>
              <IconTile label="Skewed"><ShadowSkew size={40} /></IconTile>
              <Column style={{ width: 120, height: 104, borderRadius: 16, backgroundColor: c.white, alignItems: "center", justifyContent: "center" }}>
                <ShadowSkew size={96} />
              </Column>
            </Row>
          </Section>

          <MotionSection />

          <Section title="In a list" note="60 rows, an SVG with a shadow in each; scroll fast to check for jank">
            <List
              data={ROWS}
              key={(r) => r.id}
              gap={8}
              style={{ height: 360 }}
              row={(r) => (
                <Row style={{ alignItems: "center", gap: 12, padding: 12, borderRadius: 14, backgroundColor: c.white }}>
                  <Column style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: "#EEF2FF", alignItems: "center", justifyContent: "center" }}>
                    <CoinShadow size={32} accessibilityHidden={true} />
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
