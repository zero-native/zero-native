// Element values lab (useElementMotion, registry 24): what an element gives through `motion={m}`, shown natively (the
// numbers are v.format(...) texts) and logged by JS ("element-lab ..." lines) for checks from a console.
//   box:      a Pressable moved, turned and scaled by its transforms: it takes taps where it is DRAWN (its count goes
//             up), its ripple turns with it; its box (x, y, width, height) live and by measure(); a bar whose width
//             follows the Pressable's `pressed` (0 → 1)
//   scroll:   a vertical Scroll's scrollY and pull (with pull to refresh), follow (scroll to 600, then let go); a rail's
//             scrollX
//   list:     a List's index, offset, scrollY and pull; follow to row 20.5
//   carousel: a Carousel's page; follow to page 3, then back to 0; "hold at 1": a follow that stays set while you swipe
//             (the dots and onPageChange still go with the pages)
// Box also has "slide": its parent moved by a motion value (the box follows with no layout), "drop": its grandparent
// moved by a signal with an `animate` timing (SwiftUI's animation), and "open as modal" (the same lab on a modal route:
// the box is where the screen ends up). Open one part with --params '{"mode":"list"}' (box by default); `followAt` (a
// number) sets a follow as the part mounts, before the native element exists (it must still apply). An example, not
// framework code.
import { Carousel, Column, List, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { effect, nav, signal, useElementMotion, useMotion, type ElementMotion, type MotionSource } from "@zeronative/core"
import { c } from "./tokens"

const ROWS = Array.from({ length: 80 }, (_, i) => ({ id: i, name: `Row ${i}` }))

function say(text: string) {
  console.info(`element-lab ${text}`)
}

/** Logs a value JS hears (at most once a frame), rounded, when it changes. */
function logEach(name: string, v: MotionSource) {
  let last = ""
  effect(() => {
    const t = v().toFixed(1)
    if (t !== last) {
      last = t
      say(`${name} ${t}`)
    }
  })
}

function EvButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={13} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

function EvValue(props: { label: string; v: MotionSource }) {
  return (
    <Row style={{ gap: 6 }}>
      <Text fontSize={13} color={c.muted}>
        {props.label}
      </Text>
      <Text fontSize={13} color={c.ink}>
        {props.v.format({ decimals: 1, grouping: "none" })}
      </Text>
    </Row>
  )
}

function EvBox() {
  const m = useElementMotion()
  const taps = signal(0)
  const box = signal("")
  const slide = useMotion(0)
  const drop = signal(0)
  logEach("pressed", m.pressed)
  logEach("x", m.x)
  logEach("y", m.y)
  return (
    <Column style={{ gap: 12, padding: 16 }}>
      <Text fontSize={13} color={c.muted}>
        The purple card is laid out at the left and drawn 120 pt to the right, turned 12° and 1.2x: tap where you see it.
      </Text>
      <Column animate={{ translateY: { duration: 400 } }} style={{ height: 120, transform: [{ translateY: drop() }] }}>
        <Column style={{ height: 120, transform: [{ translateX: slide }] }}>
          <Pressable
            motion={m}
            testID="moved-card"
            onPress={() => {
              taps.set(taps() + 1)
              say(`tap ${taps()}`)
            }}
            pressScale={0.95}
            style={{ width: 140, height: 80, borderRadius: 16, backgroundColor: c.primary, alignItems: "center", justifyContent: "center", transform: [{ translateX: 120 }, { rotate: 12 }, { scale: 1.2 }] }}
          >
            <Text fontSize={15} color={c.white}>{`Taps: ${taps()}`}</Text>
          </Pressable>
        </Column>
      </Column>
      <EvValue label="x" v={m.x} />
      <EvValue label="y" v={m.y} />
      <EvValue label="width" v={m.width} />
      <EvValue label="height" v={m.height} />
      <EvValue label="pressed" v={m.pressed} />
      <Column style={{ height: 8, borderRadius: 4, backgroundColor: c.border }}>
        <Column style={{ height: 8, borderRadius: 4, backgroundColor: c.success, width: m.pressed.map([0, 1], [0, 300]) }} />
      </Column>
      <EvButton
        label="measure()"
        onPress={() => {
          void m.measure().then((r) => {
            const t = `${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.width.toFixed(1)}x${r.height.toFixed(1)}`
            box.set(t)
            say(`measure ${t}`)
          })
        }}
      />
      <Text fontSize={13} color={c.ink}>{`measured: ${box()}`}</Text>
      <Row style={{ gap: 8, flexWrap: "wrap" }}>
        <EvButton label="slide" onPress={() => void slide.to(slide.peek() < 0 ? 0 : -80, "spring").then(() => say(`slide done ${slide.peek()}`))} />
        <EvButton label="drop" onPress={() => drop.set(drop() > 0 ? 0 : 30)} />
        <EvButton label="open as modal" onPress={() => nav.push("elementValuesModal", { mode: "box" })} />
      </Row>
    </Column>
  )
}

/** A follow set as the part mounts ([at]), before the native element has its scroll view. */
function followAtMount(m: ElementMotion, at: number | undefined) {
  if (at === undefined) return
  const held = useMotion(at)
  m.follow(held)
  say(`follow at mount ${at}`)
}

function EvScroll(props: { followAt?: number }) {
  const m = useElementMotion()
  followAtMount(m, props.followAt)
  const rail = useElementMotion()
  const target = useMotion(0)
  const refreshing = signal(false)
  logEach("scrollY", m.scrollY)
  logEach("pull", m.pull)
  logEach("scrollX", rail.scrollX)
  return (
    <Column style={{ flex: 1 }}>
      <Column style={{ gap: 4, padding: 12, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
        <EvValue label="scrollY" v={m.scrollY} />
        <EvValue label="pull" v={m.pull} />
        <EvValue label="rail scrollX" v={rail.scrollX} />
        <Row style={{ gap: 8 }}>
          <EvButton
            label="follow → 600"
            onPress={() => {
              target.set(m.scrollY.peek())
              m.follow(target)
              void target.to(600, "spring").then(() => {
                m.follow(null)
                say("follow done")
              })
            }}
          />
          <EvButton
            label="follow → 0"
            onPress={() => {
              target.set(m.scrollY.peek())
              m.follow(target)
              void target.to(0, "spring").then(() => m.follow(null))
            }}
          />
        </Row>
      </Column>
      <Scroll horizontal motion={rail} style={{ height: 56, flexGrow: 0 }}>
        <Row style={{ gap: 8, padding: 8 }}>
          {ROWS.slice(0, 20).map((r) => (
            <Column key={r.id} style={{ width: 80, height: 40, borderRadius: 8, backgroundColor: c.pillBg, alignItems: "center", justifyContent: "center" }}>
              <Text fontSize={12}>{r.name}</Text>
            </Column>
          ))}
        </Row>
      </Scroll>
      <Scroll
        motion={m}
        style={{ flex: 1 }}
        refreshing={refreshing()}
        onRefresh={() => {
          say("refresh")
          refreshing.set(true)
          setTimeout(() => refreshing.set(false), 1500)
        }}
      >
        <Column style={{ gap: 8, padding: 16 }}>
          {ROWS.map((r) => (
            <Column key={r.id} style={{ height: 48, borderRadius: 8, backgroundColor: c.white, borderWidth: 1, borderColor: c.border, justifyContent: "center", paddingHorizontal: 12 }}>
              <Text fontSize={14}>{r.name}</Text>
            </Column>
          ))}
        </Column>
      </Scroll>
    </Column>
  )
}

function EvList(props: { followAt?: number }) {
  const m = useElementMotion()
  followAtMount(m, props.followAt)
  const target = useMotion(0)
  const refreshing = signal(false)
  logEach("index", m.index)
  logEach("offset", m.offset)
  logEach("listScrollY", m.scrollY)
  logEach("pull", m.pull)
  return (
    <Column style={{ flex: 1 }}>
      <Column style={{ gap: 4, padding: 12, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
        <EvValue label="index" v={m.index} />
        <EvValue label="offset" v={m.offset} />
        <EvValue label="scrollY" v={m.scrollY} />
        <EvValue label="pull" v={m.pull} />
        <Row style={{ gap: 8 }}>
          <EvButton
            label="follow → row 20.5"
            onPress={() => {
              target.set(m.index.peek())
              m.follow(target)
              void target.to(20.5, "spring").then(() => {
                m.follow(null)
                say("follow done")
              })
            }}
          />
          <EvButton
            label="follow → 0"
            onPress={() => {
              target.set(m.index.peek())
              m.follow(target)
              void target.to(0, "spring").then(() => m.follow(null))
            }}
          />
        </Row>
      </Column>
      <List
        data={ROWS}
        key={(r) => String(r.id)}
        motion={m}
        gap={8}
        style={{ flex: 1, padding: 16 }}
        refreshing={refreshing()}
        onRefresh={() => {
          say("refresh")
          refreshing.set(true)
          setTimeout(() => refreshing.set(false), 1500)
        }}
        ListHeaderComponent={
          <Text fontSize={13} color={c.muted}>
            The header is item 0, as on Android.
          </Text>
        }
        row={(r) => (
          <Column style={{ height: 48, borderRadius: 8, backgroundColor: c.white, borderWidth: 1, borderColor: c.border, justifyContent: "center", paddingHorizontal: 12 }}>
            <Text fontSize={14}>{r.name}</Text>
          </Column>
        )}
      />
    </Column>
  )
}

function EvCarousel(props: { followAt?: number }) {
  const m = useElementMotion()
  const target = useMotion(0)
  const held = useMotion(1)
  followAtMount(m, props.followAt)
  logEach("page", m.page)
  const go = (p: number) => {
    target.set(m.page.peek())
    m.follow(target)
    void target.to(p, "spring").then(() => {
      m.follow(null)
      say(`follow done ${p}`)
    })
  }
  return (
    <Column style={{ gap: 12, paddingVertical: 16 }}>
      <Column style={{ paddingHorizontal: 16, gap: 8 }}>
        <EvValue label="page" v={m.page} />
        <Row style={{ gap: 8 }}>
          <EvButton label="follow → 3" onPress={() => go(3)} />
          <EvButton label="follow → 0" onPress={() => go(0)} />
          <EvButton
            label="hold at 1"
            onPress={() => {
              m.follow(held)
              say("hold at 1")
            }}
          />
          <EvButton
            label="let go"
            onPress={() => {
              m.follow(null)
              say("let go")
            }}
          />
        </Row>
      </Column>
      <Carousel motion={m} itemWidth="80%" dots onPageChange={(i) => say(`onPageChange ${i}`)} style={{ height: 180, gap: 12, paddingHorizontal: 16 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Column key={i} style={{ flex: 1, borderRadius: 16, backgroundColor: i % 2 === 0 ? c.primary : c.success, alignItems: "center", justifyContent: "center" }}>
            <Text fontSize={24} color={c.white}>{`Page ${i}`}</Text>
          </Column>
        ))}
      </Carousel>
      {/* A dot that slides with the page, on the UI thread. */}
      <Column style={{ height: 8, marginHorizontal: 16, borderRadius: 4, backgroundColor: c.border }}>
        <Column style={{ width: 40, height: 8, borderRadius: 4, backgroundColor: c.primary, transform: [{ translateX: m.page.map([0, 4], [0, 280]) }] }} />
      </Column>
    </Column>
  )
}

function EvTab(props: { name: string; mode: () => string; onPick: (name: string) => void }) {
  return (
    <Pressable onPress={() => props.onPick(props.name)} style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: props.mode() === props.name ? c.primary : c.pillBg }}>
      <Text fontSize={13} color={props.mode() === props.name ? c.white : c.ink}>
        {props.name}
      </Text>
    </Pressable>
  )
}

export function ElementValuesLabScreen(props: { mode?: string; followAt?: number }) {
  const mode = signal(props.mode ?? "box")
  say(`open ${mode()}`)
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, backgroundColor: c.white, borderBottomWidth: 1, borderColor: c.border }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 6 }}>
          <Text fontSize={18}>←</Text>
        </Pressable>
        <EvTab name="box" mode={mode} onPick={(n) => mode.set(n)} />
        <EvTab name="scroll" mode={mode} onPick={(n) => mode.set(n)} />
        <EvTab name="list" mode={mode} onPick={(n) => mode.set(n)} />
        <EvTab name="carousel" mode={mode} onPick={(n) => mode.set(n)} />
      </Row>
      {mode() === "box" ? (
        <EvBox />
      ) : mode() === "scroll" ? (
        <EvScroll followAt={props.followAt} />
      ) : mode() === "list" ? (
        <EvList followAt={props.followAt} />
      ) : (
        <EvCarousel followAt={props.followAt} />
      )}
    </Column>
  )
}

export type { ElementMotion }
