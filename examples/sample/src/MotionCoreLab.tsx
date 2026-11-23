// Motion lab: the core, end to end, with no gestures (docs/motion.md). Built only from the public API; each card checks
// one part, so the engine can be seen on a simulator before the gesture work:
//   1. Commands: useMotion with to / sequence (repeat, reverse) / decay / set / stop, the promise's answer shown
//   2. Timeline: play / pause / seek, and 30 boxes bound to it (the per-frame budget: ZN_MOTION_PERF=1 on iOS)
//   3. Formulas: derive with Math, map, mapColor, follow (a dot that trails), format as ₹ text
//   4. Window: env.width, insets and the keyboard as text; a card turned with rotateX / rotateY and blurred
//   5. Corners: a box whose corners morph; elements: a Scroll's header that fades with scrollY, a Pressable's pressed
//      scale, measure()
//   6. Plugin: a dot moved each frame by native code (orbit), a curve from the plugin (wobble) next to the spring, the
//      plugin's view drawing a bar from a motion `level`; useTilt's x / y (0 on a simulator: it has no motion)
//   7. animateLayout: a card that grows and the box under it glides, a box whose height is set by style, a pill whose
//      text gets longer, chips that reflow in a wrapping row
//   8. useFrame: a JS frame counter; "Keep JS busy" stalls it while everything above keeps moving
// Open with: bun run tools/ios-sample.ts --route motionCoreLab (iOS: start it with SIMCTL_CHILD_ZN_MOTION_ENGINE=1
// while the engine is behind that flag), or zn://sample/dev/motion/core. With --params '{"run":true}' it presses the
// buttons by itself and logs what JS reads back: motion-core <what>: <value>.
import { Column, NativeView, Pressable, Row, Scroll, Stack, Text } from "@zeronative/ui"
import { derive, env, follow, nav, signal, useElementMotion, useFrame, useMotion, useTilt, useTimeline } from "@zeronative/core"
import { orbit, wobble } from "@zeronative/device-test"
import { c } from "./tokens"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const log = (what: string, v: unknown) => console.log(`motion-core ${what}: ${typeof v === "number" ? Math.round(v * 100) / 100 : JSON.stringify(v)}`)

/** Blocks the JS thread for [ms]. Bindings, the plugin's dot and the bar must keep moving anyway. */
function busyLoop(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // wait
  }
}

function MkCard(props: { title: string; hint: string; children?: unknown }) {
  return (
    <Column style={{ padding: 14, gap: 10, borderRadius: 16, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}>
      <Text fontSize={15} fontWeight={800} color={c.ink}>
        {props.title}
      </Text>
      <Text fontSize={12} color={c.muted}>
        {props.hint}
      </Text>
      {props.children}
    </Column>
  )
}

function MkButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: c.pillBg }}>
      <Text fontSize={12} fontWeight={700} color={c.ink}>
        {props.label}
      </Text>
    </Pressable>
  )
}

// ---- 1. Commands --------------------------------------------------------------------------------------------------------

function MkCommands(props: { run?: boolean }) {
  const v = useMotion(0)
  const said = signal("press a command")
  const show = (what: string) => (r: { finished: boolean }) => {
    said.set(`${what}: finished ${r.finished}`)
    log(`command ${what}`, r.finished)
  }
  const to = () => void v.to(v.peek() > 100 ? 0 : 240).then(show("to (spring)"))
  const seq = () => void v.sequence([{ to: 240, timing: { duration: 400 } }, { to: 120, timing: { duration: 300 } }], { repeat: 2, reverse: true }).then(show("sequence ×2 reverse"))
  const decay = () => {
    v.set(0)
    void v.decay({ velocity: 900, clamp: [0, 240] }).then(show("decay"))
  }
  if (props.run) {
    setTimeout(async () => {
      v()
      await v.to(240, { duration: 300 }).then(show("to 300 ms"))
      log("value after to", v())
      const stopped = v.to(0, { duration: 2000 })
      setTimeout(() => v.stop(), 300)
      show("stop")(await stopped)
      log("value after stop", v())
      v.set(60)
      log("value after set", v())
    }, 600)
  }
  return (
    <MkCard title="1. Commands" hint="The dot moves natively; JS only sends the command and hears the promise.">
      <Stack style={{ height: 36, borderRadius: 18, backgroundColor: c.pillBg }}>
        <Column style={{ position: "absolute", top: 4, start: 4, width: 28, height: 28, borderRadius: 14, backgroundColor: c.primary, transform: [{ translateX: v }] }} />
      </Stack>
      <Row style={{ gap: 8, flexWrap: "wrap" }}>
        <MkButton label="to" onPress={to} />
        <MkButton label="sequence" onPress={seq} />
        <MkButton label="decay" onPress={decay} />
        <MkButton label="set 60" onPress={() => v.set(60)} />
        <MkButton label="stop" onPress={() => v.stop()} />
      </Row>
      <Text fontSize={12} color={c.ink}>
        {said()}
      </Text>
    </MkCard>
  )
}

// ---- 2. Timeline, and the 30-box row ------------------------------------------------------------------------------------

function MkTimeline(props: { run?: boolean }) {
  const t = useTimeline({ duration: 1600, easing: "linear", repeat: "forever", yoyo: true })
  const boxes = Array.from({ length: 30 }, (_, i) => i)
  if (props.run) setTimeout(() => void t.play(), 400)
  return (
    <MkCard title="2. Timeline" hint="play / pause / seek on one timeline; the 30 boxes below are bound to it (the per-frame budget).">
      <Stack style={{ height: 36, borderRadius: 18, backgroundColor: c.pillBg }}>
        <Column style={{ position: "absolute", top: 4, start: 4, width: 28, height: 28, borderRadius: 8, backgroundColor: "#0F766E", transform: [{ translateX: t.map([0, 1], [0, 240]) }, { rotate: t.map([0, 1], [0, 180]) }] }} />
      </Stack>
      <Row style={{ gap: 8, flexWrap: "wrap" }}>
        <MkButton label="play" onPress={() => void t.play()} />
        <MkButton label="pause" onPress={() => t.pause()} />
        <MkButton label="seek 0.5" onPress={() => t.seek(0.5)} />
        <MkButton label="restart" onPress={() => void t.restart()} />
      </Row>
      <Text fontSize={12} color={c.ink}>
        progress {t.format({ decimals: 2 })}
      </Text>
      <Row style={{ flexWrap: "wrap", gap: 6 }}>
        {boxes.map((i) => (
          <Column
            key={i}
            style={{
              width: 20,
              height: 20,
              borderRadius: 4,
              backgroundColor: i % 2 === 0 ? c.primary : "#E23744",
              opacity: t.map([0, 1], [1, 0.4]),
              transform: [{ translateY: t.map([0, 1], [-4, 4]) }, { rotate: t.map([0, 1], [0, 90 + i * 3]) }],
            }}
          />
        ))}
      </Row>
    </MkCard>
  )
}

// ---- 3. Formulas ---------------------------------------------------------------------------------------------------------

function MkFormulas(props: { run?: boolean }) {
  const t = useTimeline({ duration: 2400, easing: "linear", repeat: "forever" })
  setTimeout(() => void t.play(), 300)
  // A circle from Math: derive is compiled to a native formula, never run as JS per frame.
  const cx = derive(() => 110 + Math.cos(t() * Math.PI * 2) * 90)
  const cy = derive(() => 40 + Math.sin(t() * Math.PI * 2) * 28)
  const trailX = follow(cx, { spring: { damping: 12, stiffness: 120 } })
  const trailY = follow(cy, { spring: { damping: 12, stiffness: 120 } })
  const amount = derive(() => Math.round(t() * 125000))
  if (props.run) {
    // JS sees a value only after its first read (that read starts the "watch"), so read both now and log later.
    cx()
    trailX()
    setTimeout(() => {
      log("derive cx", cx())
      log("follow trail x", trailX())
    }, 1500)
  }
  return (
    <MkCard title="3. Formulas" hint="A dot on a circle (derive with Math.cos / sin), a trailing dot (follow), a colour (mapColor) and a ₹ amount (format).">
      <Stack style={{ height: 84, borderRadius: 12, backgroundColor: c.pillBg }}>
        <Column style={{ position: "absolute", top: 0, start: 0, width: 16, height: 16, borderRadius: 8, backgroundColor: "#F59E0B", transform: [{ translateX: trailX }, { translateY: trailY }] }} />
        <Column style={{ position: "absolute", top: 0, start: 0, width: 20, height: 20, borderRadius: 10, backgroundColor: t.mapColor([0, 0.5, 1], ["#5B5BD6", "#E23744", "#5B5BD6"]), transform: [{ translateX: cx }, { translateY: cy }] }} />
      </Stack>
      <Text fontSize={22} fontWeight={800} color={c.ink}>
        {amount.format({ prefix: "₹", decimals: 0 })}
      </Text>
    </MkCard>
  )
}

// ---- 4. Window values, 3D and blur ------------------------------------------------------------------------------------------

function MkWindow() {
  const t = useTimeline({ duration: 2000, easing: "linear", repeat: "forever", yoyo: true })
  setTimeout(() => void t.play(), 300)
  return (
    <MkCard title="4. Window, 3D and blur" hint="env as text (width, insets, keyboard); a card turned with rotateX / rotateY and blurred by the same timeline.">
      {/* One v.format(...) per <Text>, so each value is its own Text in a row. */}
      <Row style={{ gap: 10, flexWrap: "wrap" }}>
        <Text fontSize={12} color={c.ink}>{env.width.format({ prefix: "width ", decimals: 0 })}</Text>
        <Text fontSize={12} color={c.ink}>{env.insets.top.format({ prefix: "top ", decimals: 0 })}</Text>
        <Text fontSize={12} color={c.ink}>{env.insets.bottom.format({ prefix: "bottom ", decimals: 0 })}</Text>
        <Text fontSize={12} color={c.ink}>{env.keyboardHeight.format({ prefix: "keyboard ", decimals: 0 })}</Text>
      </Row>
      <Row style={{ gap: 16, justifyContent: "center" }}>
        <Column style={{ width: 110, height: 70, borderRadius: 14, backgroundColor: c.primary, cameraDistance: 10, transform: [{ rotateX: t.map([0, 1], [-30, 30]) }, { rotateY: t.map([0, 1], [40, -40]) }] }} />
        <Column style={{ width: 110, height: 70, borderRadius: 14, backgroundColor: "#E23744", blurRadius: t.map([0, 1], [0, 10]) }} />
      </Row>
    </MkCard>
  )
}

// ---- 5. Corners and element values ------------------------------------------------------------------------------------------

function MkElements(props: { run?: boolean }) {
  const t = useTimeline({ duration: 1800, easing: "linear", repeat: "forever", yoyo: true })
  setTimeout(() => void t.play(), 300)
  const list = useElementMotion()
  const press = useElementMotion()
  const box = useElementMotion()
  const measured = signal("")
  const measure = () =>
    void box.measure().then((b) => {
      measured.set(`x ${Math.round(b.x)} y ${Math.round(b.y)} · ${Math.round(b.width)} × ${Math.round(b.height)}`)
      log("measure", b)
    })
  if (props.run) setTimeout(measure, 900)
  return (
    <MkCard title="5. Corners and elements" hint="Corners from 0 to 36; a Scroll whose header fades as it scrolls (scrollY); a Pressable that scales while pressed; measure().">
      <Row style={{ gap: 12, alignItems: "center" }}>
        <Column style={{ width: 72, height: 72, backgroundColor: "#0F766E", borderRadius: t.map([0, 1], [0, 36]) }} />
        <Pressable motion={press} onPress={() => {}} style={{ flex: 1, height: 56, borderRadius: 14, backgroundColor: c.primary, alignItems: "center", justifyContent: "center", transform: [{ scale: press.pressed.map([0, 1], [1, 0.9]) }] }}>
          <Text fontSize={13} fontWeight={700} color={c.white}>
            Hold me
          </Text>
        </Pressable>
      </Row>
      <Stack style={{ height: 120, borderRadius: 12, overflow: "hidden", backgroundColor: c.pillBg }}>
        <Scroll motion={list} style={{ flex: 1 }}>
          <Column style={{ paddingTop: 44, paddingHorizontal: 12, gap: 6, paddingBottom: 12 }}>
            {ROWS.map((i) => (
              <Text key={i} fontSize={13} color={c.ink}>
                Row {i + 1}
              </Text>
            ))}
          </Column>
        </Scroll>
        <Column pointerEvents="none" style={{ position: "absolute", top: 0, start: 0, end: 0, height: 36, justifyContent: "center", paddingHorizontal: 12, backgroundColor: c.white, opacity: list.scrollY.map([0, 60], [1, 0]) }}>
          <Text fontSize={13} fontWeight={700} color={c.ink}>
            Header (fades as you scroll)
          </Text>
        </Column>
      </Stack>
      <Row style={{ gap: 10, alignItems: "center" }}>
        <Column motion={box} style={{ width: 40, height: 24, borderRadius: 6, backgroundColor: "#F59E0B" }} />
        <MkButton label="measure()" onPress={measure} />
        <Text fontSize={12} color={c.ink} style={{ flex: 1 }}>
          {measured()}
        </Text>
      </Row>
    </MkCard>
  )
}

// ---- 6. Plugin values, curves and views; tilt --------------------------------------------------------------------------------

function MkPlugin(props: { run?: boolean }) {
  const ox = orbit({ radius: 30, periodMs: 2000, axis: "x" })
  const oy = orbit({ radius: 30, periodMs: 2000, axis: "y" })
  const wob = useMotion(0)
  const spring = useMotion(0)
  const level = useTimeline({ duration: 1500, easing: "linear", repeat: "forever", yoyo: true })
  setTimeout(() => void level.play(), 300)
  const tilt = useTilt()
  const said = signal("")
  const jump = () => {
    const to = wob.peek() > 100 ? 0 : 200
    void wob.to(to, wobble({ rings: 3, ms: 1100 })).then((r) => log("wobble finished", r.finished))
    void spring.to(to)
  }
  if (props.run) {
    // First reads start the watch (JS sees a value only after it), so read each one now and log later.
    wob()
    ox()
    oy()
    tilt.x()
    tilt.y()
    setTimeout(() => {
      log("orbit x", ox())
      log("orbit y", oy())
      jump()
    }, 1200)
    setTimeout(() => {
      log("orbit moved", { x: ox(), y: oy() })
      log("wobble at", wob())
      log("tilt", { x: tilt.x(), y: tilt.y() })
    }, 2600)
  }
  return (
    <MkCard title="6. Plugin" hint="A dot on a circle moved each frame by native code (orbit); a wobble curve from the plugin above the built-in spring; the plugin's view draws its bar from a motion level; tilt (0 on a simulator).">
      <Row style={{ gap: 16, alignItems: "center" }}>
        <Stack style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: c.pillBg }}>
          <Column style={{ position: "absolute", top: 32, start: 32, width: 20, height: 20, borderRadius: 10, backgroundColor: c.primary, transform: [{ translateX: ox }, { translateY: oy }] }} />
        </Stack>
        <Column style={{ flex: 1, gap: 6 }}>
          <Stack style={{ height: 36, borderRadius: 18, backgroundColor: c.pillBg }}>
            <Column style={{ position: "absolute", top: 4, start: 4, width: 28, height: 28, borderRadius: 8, backgroundColor: "#E23744", transform: [{ translateX: wob }] }} />
          </Stack>
          <Stack style={{ height: 36, borderRadius: 18, backgroundColor: c.pillBg }}>
            <Column style={{ position: "absolute", top: 4, start: 4, width: 28, height: 28, borderRadius: 8, backgroundColor: "#0F766E", transform: [{ translateX: spring }] }} />
          </Stack>
          <MkButton label="wobble vs spring" onPress={jump} />
        </Column>
      </Row>
      <NativeView name="device.fake-view" props={{ label: "level bar", level }} onEvent={(e) => said.set("the view sent " + e.name)} style={{ width: "100%", height: 56 }} />
      <Row style={{ gap: 10, flexWrap: "wrap" }}>
        <Text fontSize={12} color={c.ink}>{derive(() => level() * 100).format({ prefix: "level ", decimals: 0, suffix: "%" })}</Text>
        <Text fontSize={12} color={c.ink}>{tilt.x.format({ prefix: "tilt x ", decimals: 2 })}</Text>
        <Text fontSize={12} color={c.ink}>{tilt.y.format({ prefix: "y ", decimals: 2 })}</Text>
        <Text fontSize={12} color={c.ink}>{said()}</Text>
      </Row>
    </MkCard>
  )
}

// ---- 7. animateLayout -------------------------------------------------------------------------------------------------------

const ROWS = Array.from({ length: 12 }, (_, i) => i)
const CHIPS = ["Groceries", "Fuel", "Rent", "Mobile", "Movies", "Dining", "Travel", "Gifts"]

function MkLayout(props: { run?: boolean }) {
  const open = signal(false)
  const tall = signal(false)
  const long = signal(false)
  const chips = signal(CHIPS.slice(0, 5))
  const addChip = () => {
    const have = chips()
    const next = CHIPS.find((x) => !have.includes(x))
    chips.set(next ? [next, ...have] : have.slice(1))
  }
  if (props.run) {
    setTimeout(() => open.set(true), 1400)
    setTimeout(() => tall.set(true), 1400)
    setTimeout(() => long.set(true), 1400)
    setTimeout(addChip, 1400)
  }
  return (
    <MkCard title="7. animateLayout" hint="Tap the card: it grows with a spring and the box below glides. The style height, the pill's text and the chips animate too.">
      <Pressable
        onPress={() => open.set(!open())}
        animateLayout="spring"
        style={{ padding: 14, gap: 8, borderRadius: 14, backgroundColor: "#E0E7FF" }}
      >
        <Text fontSize={14} fontWeight={800} color={c.ink}>
          {open() ? "Plus plan (tap to close)" : "Plus plan (tap to open)"}
        </Text>
        {open() ? (
          <Column style={{ gap: 4 }}>
            <Text fontSize={12} color={c.ink}>✓ 10% cashback up to ₹150</Text>
            <Text fontSize={12} color={c.ink}>✓ Priority support</Text>
            <Text fontSize={12} color={c.ink}>✓ Bill split with friends</Text>
          </Column>
        ) : null}
      </Pressable>
      <Column animateLayout="spring" style={{ padding: 10, borderRadius: 12, backgroundColor: c.pillBg }}>
        <Text fontSize={12} color={c.muted}>
          I glide down when the card above grows.
        </Text>
      </Column>
      <Row style={{ gap: 10, alignItems: "flex-start" }}>
        <Pressable onPress={() => tall.set(!tall())} animateLayout={{ duration: 400 }} style={{ width: 90, height: tall() ? 110 : 50, borderRadius: 12, backgroundColor: "#FFE4D6", alignItems: "center", justifyContent: "center" }}>
          <Text fontSize={12} color={c.ink}>{tall() ? "110 tall" : "50 tall"}</Text>
        </Pressable>
        <Pressable onPress={() => long.set(!long())} animateLayout="spring" style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, backgroundColor: "#DCFCE7" }}>
          <Text fontSize={12} fontWeight={700} color={c.ink}>{long() ? "12 items in your cart" : "3 items"}</Text>
        </Pressable>
      </Row>
      <Row style={{ flexWrap: "wrap", gap: 8 }}>
        {chips().map((x) => (
          <Column key={x} animateLayout="spring" style={{ paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: c.pillBg }}>
            <Text fontSize={12} color={c.ink}>{x}</Text>
          </Column>
        ))}
      </Row>
      <MkButton label="add a chip at the front" onPress={addChip} />
    </MkCard>
  )
}

// ---- 8. useFrame -------------------------------------------------------------------------------------------------------------

function MkFrames(props: { run?: boolean }) {
  const fps = signal(0)
  let frames = 0
  let since = 0
  useFrame((f) => {
    frames++
    if (since === 0) since = f.t
    if (f.t - since >= 1000) {
      fps.set(Math.round((frames * 1000) / (f.t - since)))
      frames = 0
      since = f.t
    }
  })
  if (props.run) setTimeout(() => log("useFrame fps", fps()), 3000)
  return (
    <MkCard title="8. useFrame" hint="Frames per second counted in JS. Keep JS busy: this number drops; the dots above keep moving.">
      <Row style={{ gap: 12, alignItems: "center" }}>
        <Text fontSize={22} fontWeight={800} color={c.ink}>
          {`${fps()} fps`}
        </Text>
        <MkButton label="Keep JS busy 600 ms" onPress={() => busyLoop(600)} />
      </Row>
    </MkCard>
  )
}

export function MotionCoreLabScreen(props: { run?: boolean; only?: string }) {
  const show = (k: string) => !props.only || props.only === k
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          Motion core
        </Text>
      </Row>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 16, paddingBottom: 32, gap: 12 }}>
          {show("layout") ? <MkLayout run={props.run} /> : null}
          {show("plugin") ? <MkPlugin run={props.run} /> : null}
          {show("commands") ? <MkCommands run={props.run} /> : null}
          {show("timeline") ? <MkTimeline run={props.run} /> : null}
          {show("formulas") ? <MkFormulas run={props.run} /> : null}
          {show("window") ? <MkWindow /> : null}
          {show("elements") ? <MkElements run={props.run} /> : null}
          {show("frames") ? <MkFrames run={props.run} /> : null}
        </Column>
      </Scroll>
    </Column>
  )
}
