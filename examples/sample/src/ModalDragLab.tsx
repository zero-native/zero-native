// Drag down to close a "modal" route (iOS; on Android the system back closes it). The lab opens the same page as a
// modal in five ways; on each, drag down from anywhere (or pull down a list that is at its top) and let go:
//   - past about a third of the screen, or with a quick flick down, it closes (as nav.back(): JS hears FORCED_BACK);
//   - a short, slow drag springs back;
//   - "With a list": the list scrolls first; only a pull down with the list at its top moves the page;
//   - "Wants Back": a useBack handler that only counts; the drag asks JS ("back asked N") and the page stays still;
//   - "Secure" (secure: true) and "See-through" (transparent: true) close the same way;
//   - "With a rail": a sideways swipe on the Carousel pages it and never moves the page, even a bit diagonal;
//   - "Pull to refresh": a pull down on its Scroll refreshes ("refreshed N"), the page stays;
//   - "Inverted list": a chat opens at its bottom; a pull down scrolls back through it first;
//   - "With a pan": a zn pan (usePan, up and down) takes a drag that starts on it; the page stays;
//   - "Light status bar" (statusBar: "light", a dark page): the bar keeps white icons while the page is held down;
//   - "Photo viewer" (the native imageviewer.full screen as a modal route): its own swipe to close moves the photo, not
//     the screen;
//   - on the page, "Back in 2 s" and "Push in 2 s": JS's back or push while a drag is held (NavRace style).
// The lab's photo and the page's header share a tag: the photo flies with the page and follows the finger.
// "stack N" is nav.depth() each time the lab gets focus again, so a test can check JS's stack after a close.
import { Carousel, Column, Image, List, Pressable, Row, Scroll, Stack, Text } from "@zeronative/ui"
import { nav, setTimeout, signal, useBack, useFocus, usePan } from "@zeronative/core"
import { ImageViewer } from "@zeronative/image-viewer"
import { c } from "./tokens"

const PHOTO = "https://picsum.photos/id/1060/600/600"
const ROWS = Array.from({ length: 40 }, (_, i) => i)

/** How often the "Wants Back" page was asked to go back (its handler keeps the page). */
const backAsked = signal(0)

function MdButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: c.primary }}>
      <Text fontSize={14} fontWeight={700} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function ModalDragLabScreen() {
  const depth = signal(0)
  const focused = signal(0)
  useFocus(() => {
    depth.set(nav.depth())
    focused.set(focused() + 1)
  })
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg, padding: 16, gap: 12 }}>
      <Row style={{ gap: 8, alignItems: "center" }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Modal drag lab
        </Text>
      </Row>
      <Text fontSize={13} color={c.muted}>
        Open a page, then drag it down and let go: far or fast closes it, a short drag springs back. With a list, the list scrolls first and hands the pull over at its top.
      </Text>
      <Image sharedTag="md-photo" src={PHOTO} contentScale="cover" style={{ width: 96, height: 64, borderRadius: 10 }} />
      <Row style={{ gap: 8, flexWrap: "wrap" }}>
        <MdButton label="Open modal" onPress={() => nav.push("modalDragPage", {})} />
        <MdButton label="With a list" onPress={() => nav.push("modalDragPage", { list: true })} />
        <MdButton label="Wants Back" onPress={() => nav.push("modalDragPage", { wantsBack: true })} />
        <MdButton label="Secure" onPress={() => nav.push("modalDragSecure", {})} />
        <MdButton label="See-through" onPress={() => nav.push("modalDragSeeThrough")} />
        <MdButton label="With a rail" onPress={() => nav.push("modalDragPage", { rail: true })} />
        <MdButton label="Pull to refresh" onPress={() => nav.push("modalDragPage", { refresh: true })} />
        <MdButton label="Inverted list" onPress={() => nav.push("modalDragPage", { inverted: true })} />
        <MdButton label="With a pan" onPress={() => nav.push("modalDragPage", { pan: true })} />
        <MdButton label="Light status bar" onPress={() => nav.push("modalDragLight", { dark: true })} />
        <MdButton label="Photo viewer" onPress={() => void ImageViewer.open({ route: "modalDragViewer", images: [PHOTO] })} />
      </Row>
      <Text testID="md-stack" fontSize={14} color={c.ink}>
        {`stack ${depth()}`}
      </Text>
      <Text testID="md-focused" fontSize={14} color={c.ink}>
        {`focused ${focused()}`}
      </Text>
    </Column>
  )
}

function MdWantsBack() {
  useBack(() => {
    backAsked.set(backAsked() + 1)
    console.info(`modal-drag back asked ${backAsked()}`)
    return true
  })
  return (
    <Text testID="md-back-asked" fontSize={14} color={c.ink}>
      {`back asked ${backAsked()}`}
    </Text>
  )
}

const refreshed = signal(0)
const refreshing = signal(false)

/** A zn pan that moves its box up and down (it takes a drag that starts on it, not the drag down). */
function MdPan() {
  const pan = usePan({ axis: "y" })
  return (
    <Column style={{ height: 120, borderRadius: 12, backgroundColor: c.pillBg, overflow: "hidden", alignItems: "center", justifyContent: "center" }}>
      <Stack gesture={pan} style={{ paddingHorizontal: 18, paddingVertical: 12, borderRadius: 20, backgroundColor: "#E0E7FF", transform: [{ translateY: pan.y }] }}>
        <Text testID="md-pan" fontSize={14} fontWeight={700} color={c.ink}>
          Pan me
        </Text>
      </Stack>
    </Column>
  )
}

const CHAT = Array.from({ length: 40 }, (_, i) => ({ id: i, text: `Message ${i + 1}` }))

/** The page: routes modalDragPage (params list, wantsBack, rail, refresh, inverted, pan, second), modalDragSecure and
 * modalDragLight (dark). */
export function ModalDragPageScreen(props: {
  list?: boolean
  wantsBack?: boolean
  rail?: boolean
  refresh?: boolean
  inverted?: boolean
  pan?: boolean
  second?: boolean
  dark?: boolean
}) {
  const ink = props.dark === true ? c.white : c.ink
  return (
    <Column style={{ flex: 1, backgroundColor: props.dark === true ? "#111827" : c.white }}>
      {props.dark === true ? <Column style={{ height: 120 }} /> : <Image sharedTag="md-photo" src={PHOTO} contentScale="cover" style={{ width: "100%", height: 200 }} />}
      <Column style={{ padding: 16, gap: 10 }}>
        <Text testID="md-page-title" fontSize={22} fontWeight={800} color={ink}>
          {props.second === true ? "Second page" : "Drag me down"}
        </Text>
        <Row style={{ gap: 8, flexWrap: "wrap" }}>
          <MdButton label="Close" onPress={() => nav.back()} />
          <MdButton label="Back in 2 s" onPress={() => setTimeout(() => nav.back(), 2000)} />
          <MdButton label="Push in 2 s" onPress={() => setTimeout(() => nav.push("modalDragPage", { second: true }), 2000)} />
        </Row>
        {props.wantsBack === true && <MdWantsBack />}
        {props.rail === true && (
          <Carousel testID="md-rail" onPageChange={(i) => console.info(`modal-drag rail page ${i}`)} style={{ height: 120 }}>
            {[1, 2, 3, 4].map((n) => (
              <Column key={n} style={{ flex: 1, marginHorizontal: 4, borderRadius: 12, backgroundColor: c.pillBg, alignItems: "center", justifyContent: "center" }}>
                <Text fontSize={18} fontWeight={700} color={c.ink}>{`Card ${n}`}</Text>
              </Column>
            ))}
          </Carousel>
        )}
        {props.pan === true && <MdPan />}
        {props.refresh === true && (
          <Text testID="md-refreshed" fontSize={14} color={c.ink}>
            {`refreshed ${refreshed()}`}
          </Text>
        )}
      </Column>
      {props.refresh === true && (
        <Scroll
          testID="md-refresh"
          style={{ flex: 1 }}
          refreshing={refreshing()}
          onRefresh={() => {
            refreshing.set(true)
            setTimeout(() => {
              refreshing.set(false)
              refreshed.set(refreshed() + 1)
            }, 600)
          }}
        >
          <Column style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {ROWS.slice(0, 6).map((i) => (
              <Column key={i} style={{ height: 56, borderRadius: 10, backgroundColor: c.pillBg, justifyContent: "center", paddingHorizontal: 12 }}>
                <Text fontSize={15} fontWeight={600} color={c.ink}>{`Item ${i + 1}`}</Text>
              </Column>
            ))}
          </Column>
        </Scroll>
      )}
      {props.inverted === true && (
        <List
          testID="md-chat"
          data={CHAT}
          key={(m) => String(m.id)}
          inverted
          gap={8}
          style={{ flex: 1 }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8 }}
          row={(m) => (
            <Column style={{ height: 48, borderRadius: 10, backgroundColor: c.pillBg, justifyContent: "center", paddingHorizontal: 12 }}>
              <Text fontSize={15} fontWeight={600} color={c.ink}>{m.text}</Text>
            </Column>
          )}
        />
      )}
      {props.list === true && (
        <Scroll testID="md-list" style={{ flex: 1 }}>
          <Column style={{ paddingHorizontal: 16, gap: 8, paddingBottom: 24 }}>
            {ROWS.map((i) => (
              <Column key={i} style={{ height: 56, borderRadius: 10, backgroundColor: c.pillBg, justifyContent: "center", paddingHorizontal: 12 }}>
                <Text fontSize={15} fontWeight={600} color={c.ink}>{`Row ${i + 1}`}</Text>
              </Column>
            ))}
          </Column>
        </Scroll>
      )}
    </Column>
  )
}

/** modalDragSeeThrough: a card over the lab, which stays drawn under it. */
export function ModalDragSeeThroughScreen() {
  return (
    <Column style={{ flex: 1, justifyContent: "flex-end", padding: 16, backgroundColor: "rgba(0,0,0,0.4)" }}>
      <Column style={{ padding: 20, gap: 12, borderRadius: 16, backgroundColor: c.white }}>
        <Text testID="md-card-title" fontSize={20} fontWeight={800} color={c.ink}>
          See-through card
        </Text>
        <Text fontSize={13} color={c.muted}>
          Drag down to close it; the lab under it stays still.
        </Text>
        <Row style={{ gap: 8 }}>
          <MdButton label="Close" onPress={() => nav.back()} />
        </Row>
      </Column>
    </Column>
  )
}
