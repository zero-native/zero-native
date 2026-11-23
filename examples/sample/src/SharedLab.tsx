// Navigation lab: shared elements over every kind of route, and a push before the first screens are up. An example
// built from the public API, not framework code (docs/motion.md §7 for sharedTag).
//   sharedLab: three cards. Tap one: its photo and its chip fly to the detail screen ("push", so the edge swipe
//   scrubs the flight with the finger). Other buttons open the same detail as a modal, as a fade, as a secure screen,
//   and a see-through screen over this one: its own tagged photo never flies (a see-through screen shares nothing, as
//   on Android), but a push from it takes this screen's photo along (it is drawn under the see-through one).
//   A photo with a tag only on this screen moves with its screen (no flight).
//   navStartLab: with params {"then": "<route>"} it pushes that route while the first screens are built (before NAV
//   STARTED), so the pushed screen is simply there, with no slide in (Android's openedAtStart).
import { Column, Image, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { nav, signal } from "@zeronative/core"
import { c } from "./tokens"

interface SlCard {
  id: string
  name: string
  back: string
  img: string
}

// One URL per card on both screens: the flight carries a picture that is already loaded.
const CARDS: SlCard[] = [
  { id: "a", name: "Chai Point", back: "20% back", img: "https://picsum.photos/id/1060/600/600" },
  { id: "b", name: "Fresh Basket", back: "₹50 back", img: "https://picsum.photos/id/1080/600/600" },
  { id: "c", name: "Cake Walk", back: "10% back", img: "https://picsum.photos/id/674/600/600" },
]

function card(id: string | undefined): SlCard {
  return CARDS.find((x) => x.id === id) ?? CARDS[0]
}

function ShlButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ paddingHorizontal: 12, paddingVertical: 9, borderRadius: 10, backgroundColor: c.primary }}>
      <Text fontSize={13} fontWeight={700} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function ShlCardView(props: { s: SlCard }) {
  return (
    <Pressable
      onPress={() => nav.push("sharedLabDetail", { id: props.s.id })}
      accessibilityLabel={props.s.name}
      style={{ flex: 1, borderRadius: 16, overflow: "hidden", backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
    >
      <Image sharedTag={"sl-img-" + props.s.id} src={props.s.img} contentScale="cover" style={{ width: "100%", height: 96 }} />
      <Column style={{ padding: 8, gap: 4 }}>
        <Text fontSize={12} fontWeight={800} color={c.ink} numberOfLines={1}>
          {props.s.name}
        </Text>
        <Column sharedTag={"sl-chip-" + props.s.id} style={{ alignSelf: "flex-start", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: c.successBg }}>
          <Text fontSize={10} fontWeight={700} color={c.success}>
            {props.s.back}
          </Text>
        </Column>
      </Column>
    </Pressable>
  )
}

export function SharedLabScreen() {
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, backgroundColor: c.white }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Shared elements
        </Text>
      </Row>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ padding: 16, gap: 12 }}>
          <Text fontSize={12} color={c.muted}>
            Tap a card: its photo and chip fly to the next screen. Swipe back slowly from the left edge: they follow your finger.
          </Text>
          <Row style={{ gap: 10 }}>
            {CARDS.map((s) => (
              <ShlCardView key={s.id} s={s} />
            ))}
          </Row>
          <Row style={{ flexWrap: "wrap", gap: 8 }}>
            <ShlButton label="Modal" onPress={() => nav.push("sharedLabModal", { id: "b" })} />
            <ShlButton label="Fade" onPress={() => nav.push("sharedLabFade", { id: "c" })} />
            <ShlButton label="Secure" onPress={() => nav.push("sharedLabSecure", { id: "a" })} />
            <ShlButton label="See-through" onPress={() => nav.push("sharedLabSeeThrough")} />
            <ShlButton label="None" onPress={() => nav.push("sharedLabNone", { id: "a" })} />
          </Row>
          <Text fontSize={12} color={c.muted}>
            This photo's tag is on this screen only: it moves with its screen.
          </Text>
          <Image sharedTag="sl-only-here" src="https://picsum.photos/id/292/600/300" contentScale="cover" style={{ width: "100%", height: 90, borderRadius: 12 }} />
        </Column>
      </Scroll>
    </Column>
  )
}

/** The detail page: the routes sharedLabDetail (push), sharedLabModal, sharedLabFade, sharedLabSecure, sharedLabNone. */
export function SharedLabDetailScreen(props: { id?: string }) {
  const s = card(props.id)
  const note = signal("")
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Image sharedTag={"sl-img-" + s.id} src={s.img} contentScale="cover" style={{ width: "100%", height: 280, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 }} />
      <Column style={{ padding: 20, gap: 12 }}>
        <Text fontSize={24} fontWeight={800} color={c.ink}>
          {s.name}
        </Text>
        <Column sharedTag={"sl-chip-" + s.id} style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, backgroundColor: c.successBg }}>
          <Text fontSize={16} fontWeight={800} color={c.success}>
            {s.back}
          </Text>
        </Column>
        <Row style={{ flexWrap: "wrap", gap: 8 }}>
          <ShlButton label="Back" onPress={() => nav.back()} />
          <ShlButton label="Secure from here" onPress={() => nav.push("sharedLabSecure", { id: s.id })} />
          <ShlButton label="Replace with next" onPress={() => nav.replace("sharedLabDetail", { id: CARDS[(CARDS.indexOf(s) + 1) % CARDS.length].id })} />
          <ShlButton label="JS busy 300 ms, then back" onPress={() => {
            nav.back()
            const until = Date.now() + 300
            while (Date.now() < until) {
              // the flight keeps moving
            }
            note.set("busy")
          }} />
        </Row>
        <Text fontSize={12} color={c.muted}>
          {note()}
        </Text>
      </Column>
    </Column>
  )
}

/** sharedLabSeeThrough: a card over the lab. Its photo has the lab's tag but never flies; "Push detail" takes the lab's. */
export function SharedLabSeeThroughScreen() {
  const s = CARDS[0]
  return (
    <Column style={{ flex: 1, justifyContent: "flex-end", padding: 16, backgroundColor: "rgba(0,0,0,0.4)" }}>
      <Column style={{ padding: 16, gap: 10, borderRadius: 16, backgroundColor: c.white }}>
        <Image sharedTag={"sl-img-" + s.id} src={s.img} contentScale="cover" style={{ width: 120, height: 80, borderRadius: 10 }} />
        <Text fontSize={13} color={c.ink}>
          A see-through screen: its photo shares nothing. Push detail: the lab's photo of the first card flies.
        </Text>
        <Row style={{ gap: 8 }}>
          <ShlButton label="Push detail" onPress={() => nav.push("sharedLabDetail", { id: s.id })} />
          <ShlButton label="Close" onPress={() => nav.back()} />
        </Row>
      </Column>
    </Column>
  )
}

/** navStartLab: {then: route} pushes that route while the first screens are built (before NAV STARTED). */
export function NavStartLabScreen(props: { then?: string }) {
  if (props.then) {
    console.info(`nav-start-lab: push ${props.then} at start`)
    nav.push(props.then as "sharedLab")
  }
  return (
    <Column style={{ flex: 1, padding: 24, gap: 12, backgroundColor: c.bg }}>
      <Text fontSize={20} fontWeight={700} color={c.ink}>
        Start screen
      </Text>
      <Text fontSize={13} color={c.muted}>
        The screen pushed at start is over this one with no slide. Back slides to here.
      </Text>
      <ShlButton label="Push shared lab" onPress={() => nav.push("sharedLab")} />
    </Column>
  )
}
