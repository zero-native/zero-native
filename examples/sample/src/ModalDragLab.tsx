// Drag down to close a "modal" route (iOS; on Android the system back closes it). The lab opens the same page as a
// modal in five ways; on each, drag down from anywhere (or pull down a list that is at its top) and let go:
//   - past about a third of the screen, or with a quick flick down, it closes (as nav.back(): JS hears FORCED_BACK);
//   - a short, slow drag springs back;
//   - "With a list": the list scrolls first; only a pull down with the list at its top moves the page;
//   - "Wants Back": a useBack handler that only counts; the drag asks JS ("back asked N") and the page stays still;
//   - "Secure" (secure: true) and "See-through" (transparent: true) close the same way.
// The lab's photo and the page's header share a tag: the photo flies with the page and follows the finger.
// "stack N" is nav.depth() each time the lab gets focus again, so a test can check JS's stack after a close.
import { Column, Image, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { nav, signal, useBack, useFocus } from "@zeronative/core"
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

/** The page: routes modalDragPage (params list, wantsBack) and modalDragSecure. */
export function ModalDragPageScreen(props: { list?: boolean; wantsBack?: boolean }) {
  return (
    <Column style={{ flex: 1, backgroundColor: c.white }}>
      <Image sharedTag="md-photo" src={PHOTO} contentScale="cover" style={{ width: "100%", height: 200 }} />
      <Column style={{ padding: 16, gap: 10 }}>
        <Text testID="md-page-title" fontSize={22} fontWeight={800} color={c.ink}>
          Drag me down
        </Text>
        <Row style={{ gap: 8 }}>
          <MdButton label="Close" onPress={() => nav.back()} />
        </Row>
        {props.wantsBack === true && <MdWantsBack />}
      </Column>
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
