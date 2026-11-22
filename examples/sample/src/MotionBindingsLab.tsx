// Motion lab: bindings. Elements whose style follows motion values (docs/motion.md §5), with no JS each frame and no
// gesture: one timeline (0 → 1 → 0, forever) drives everything through map, mapColor and derive.
//   a) Slide: translateX from the timeline, opacity from map, backgroundColor from mapColor
//   b) Flip: rotateY 0 → 180 (camera 8), and a tilt with rotateX ± 30 (camera 14)
//   c) Blur: blurRadius 0 → 12
//   d) Corners: borderRadius 0 → 40 (background, border and clip together)
//   e) Fill: a 40 pt bar whose scaleX is derive(() => p * parent.width / self.width), so it fills its track
//   f) Width: a box whose width follows the timeline (it and its neighbours lay out again each frame)
//   g) Text: the timeline as native number text (format), never raw control characters
//   h) Fill in a fragment: the same bar, inside a component that returns a fragment (its parent is the track)
//   i) Parent in a Scroll: a bar whose width is parent.height, in an 80 pt Scroll with 200 pt of content: 200 pt wide
//   j) Taps: a Pressable, a TextField and a native view moved, turned and scaled by motion values at rest: a tap
//      where each one is drawn reaches it
// With n (--params '{"n":30}') it shows only n boxes, each with translateX, rotate and opacity bound, to measure the
// cost per frame (iOS: ZN_MOTION_PERF=1 logs it; "still": true shows them without moving, for the baseline; "mixed":
// true also binds blurRadius, rotateY and borderRadius on each box; "playing": true gives each box a scale that plays by
// itself (animate keyframes) next to its bound values, whose body must not run per frame for them).
// Open with: bun run tools/ios-sample.ts --route motionBindingsLab (iOS: start it with SIMCTL_CHILD_ZN_MOTION_ENGINE=1
// while the engine is behind that flag), or zn://sample/dev/motion/bindings (Android).
import { Column, NativeView, Pressable, Row, Scroll, Stack, Text, TextField } from "@zeronative/ui"
import { derive, nav, parent, self, signal, useMotion, useTimeline } from "@zeronative/core"
import { c } from "./tokens"

function MbSection(props: { title: string; note: string; children?: unknown }) {
  return (
    <Column style={{ gap: 8, padding: 14, borderRadius: 12, backgroundColor: c.white }}>
      <Text fontSize={15} fontWeight={700} color={c.ink}>
        {props.title}
      </Text>
      <Text fontSize={12} color={c.muted}>
        {props.note}
      </Text>
      {props.children}
    </Column>
  )
}

/** h) A component whose root is a fragment: the bar's parent is the node the component is mounted in (the track). */
function MbFragmentFill(props: { ms?: number; still?: boolean }) {
  const t = useTimeline({ duration: props.ms ?? 2000, easing: "linear", repeat: "forever", yoyo: true })
  if (!props.still) setTimeout(() => void t.play(), 300)
  const fill = derive(() => (t() * parent.width) / self.width)
  return (
    <>
      <Column style={{ width: 40, height: 12, borderRadius: 6, backgroundColor: "#0F766E", transformOrigin: "left", transform: [{ scaleX: fill }] }} />
    </>
  )
}

/** j) Elements moved by motion values that stay at rest: each counts the taps that reach it. */
function MbTaps() {
  const at = useMotion(1)
  const presses = signal(0)
  const focused = signal(0)
  const viewTaps = signal(0)
  const x = at.map([0, 1], [0, 100])
  const turn = at.map([0, 1], [0, 12])
  const grow = at.map([0, 1], [1, 1.2])
  return (
    <Column style={{ gap: 18, paddingVertical: 10 }}>
      <Pressable
        onPress={() => presses.set(presses() + 1)}
        style={{ width: 120, height: 44, borderRadius: 10, backgroundColor: c.primary, alignItems: "center", justifyContent: "center", transform: [{ translateX: x }, { rotate: turn }, { scale: grow }] }}
      >
        <Text fontSize={14} fontWeight={700} color={c.white}>
          Tap me
        </Text>
      </Pressable>
      <TextField
        placeholder="Tap to type"
        onFocus={() => focused.set(focused() + 1)}
        style={{ width: 140, height: 44, borderWidth: 1, borderColor: c.border, borderRadius: 10, paddingHorizontal: 10, transform: [{ translateX: x }, { rotate: turn }, { scale: grow }] }}
      />
      <NativeView name="device.fake-view" props={{ label: "tap" }} onEvent={() => viewTaps.set(viewTaps() + 1)} style={{ width: 140, height: 44, transform: [{ translateX: x }, { rotate: turn }, { scale: grow }] }} />
      <Text fontSize={13} color={c.ink}>
        {`pressed ${presses()} · focused ${focused()} · view ${viewTaps()}`}
      </Text>
    </Column>
  )
}

export function MotionBindingsLabScreen(props: { n?: number; ms?: number; still?: boolean; mixed?: boolean; playing?: boolean }) {
  const t = useTimeline({ duration: props.ms ?? 2000, easing: "linear", repeat: "forever", yoyo: true })
  if (!props.still) setTimeout(() => void t.play(), 300)
  const n = props.n ?? 0
  const boxes = Array.from({ length: n }, (_, i) => i)
  const fill = derive(() => (t() * parent.width) / self.width)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          {n > 0 ? `Motion bindings: ${n} boxes` : "Motion bindings"}
        </Text>
      </Row>
      {n > 0 && props.mixed ? (
        <Row style={{ flexWrap: "wrap", gap: 10, paddingHorizontal: 20 }}>
          {boxes.map((i) => (
            <Column
              key={`m${i}`}
              style={{
                width: 44,
                height: 44,
                borderRadius: t.map([0, 1], [0, 22]),
                backgroundColor: i % 2 === 0 ? c.primary : "#E23744",
                opacity: t.map([0, 1], [1, 0.35]),
                blurRadius: t.map([0, 1], [0, 4]),
                transform: [{ translateX: t.map([0, 1], [-6, 6]) }, { rotate: t.map([0, 1], [0, 90 + i * 3]) }, { rotateY: t.map([0, 1], [0, 60]) }],
              }}
            />
          ))}
        </Row>
      ) : n > 0 && props.playing ? (
        <Row style={{ flexWrap: "wrap", gap: 10, paddingHorizontal: 20 }}>
          {boxes.map((i) => (
            <Column
              key={`p${i}`}
              animate={{ scale: { duration: 1100, keyframes: [1, 0.8], repeat: "forever", reverse: true } }}
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                backgroundColor: i % 2 === 0 ? c.primary : "#E23744",
                opacity: t.map([0, 1], [1, 0.35]),
                transform: [{ translateX: t.map([0, 1], [-6, 6]) }, { rotate: t.map([0, 1], [0, 90 + i * 3]) }],
              }}
            />
          ))}
        </Row>
      ) : n > 0 ? (
        <Row style={{ flexWrap: "wrap", gap: 10, paddingHorizontal: 20 }}>
          {boxes.map((i) => (
            <Column
              key={`b${i}`}
              style={{
                width: 44,
                height: 44,
                borderRadius: 8,
                backgroundColor: i % 2 === 0 ? c.primary : "#E23744",
                opacity: t.map([0, 1], [1, 0.35]),
                transform: [{ translateX: t.map([0, 1], [-6, 6]) }, { rotate: t.map([0, 1], [0, 90 + i * 3]) }],
              }}
            />
          ))}
        </Row>
      ) : (
        <Scroll style={{ flex: 1 }}>
          <Column style={{ paddingHorizontal: 20, paddingBottom: 24, gap: 12 }}>
            <MbSection title="a) Slide" note="translateX 0 → 220, opacity 1 → 0.3, colour indigo → red">
              <Column
                style={{
                  width: 56,
                  height: 56,
                  borderRadius: 12,
                  backgroundColor: t.mapColor([0, 1], ["#3D26ED", "#E23744"]),
                  opacity: t.map([0, 1], [1, 0.3]),
                  transform: [{ translateX: t.map([0, 1], [0, 220]) }],
                }}
              />
            </MbSection>
            <MbSection title="b) Flip and tilt" note="left: rotateY 0 → 180 (camera 8); right: rotateX -30 → 30 (camera 14)">
              <Row style={{ gap: 24, justifyContent: "center", paddingVertical: 8 }}>
                <Column
                  style={{
                    width: 110,
                    height: 70,
                    borderRadius: 12,
                    backgroundColor: c.primary,
                    alignItems: "center",
                    justifyContent: "center",
                    transform: [{ rotateY: t.map([0, 1], [0, 180]) }],
                  }}
                >
                  <Text fontSize={16} fontWeight={700} color={c.white}>
                    FRONT
                  </Text>
                </Column>
                <Column
                  style={{
                    width: 110,
                    height: 70,
                    borderRadius: 12,
                    backgroundColor: "#0F766E",
                    alignItems: "center",
                    justifyContent: "center",
                    cameraDistance: 14,
                    transform: [{ rotateX: t.map([0, 1], [-30, 30]) }],
                  }}
                >
                  <Text fontSize={16} fontWeight={700} color={c.white}>
                    TILT
                  </Text>
                </Column>
              </Row>
            </MbSection>
            <MbSection title="c) Blur" note="blurRadius 0 → 12 (Android 12+ only)">
              <Row style={{ gap: 12, alignItems: "center", padding: 10, borderRadius: 10, backgroundColor: "#FEF3C7", blurRadius: t.map([0, 1], [0, 12]) }}>
                <Text fontSize={28}>🍛</Text>
                <Text fontSize={16} fontWeight={700} color={c.ink}>
                  Butter Chicken ₹349
                </Text>
              </Row>
            </MbSection>
            <MbSection title="d) Corners" note="borderRadius 0 → 40: background, border and clip together">
              <Stack style={{ width: 120, height: 80, borderRadius: t.map([0, 1], [0, 40]), borderWidth: 3, borderColor: c.ink, backgroundColor: "#DCFCE7", overflow: "hidden" }}>
                <Column style={{ position: "absolute", top: 0, start: 0, width: 60, height: 40, backgroundColor: "#15803D" }} />
              </Stack>
            </MbSection>
            <MbSection title="e) Fill" note="a 40 pt bar, scaleX = p × parent.width / self.width: it fills its track">
              <Column style={{ height: 12, borderRadius: 6, backgroundColor: c.border }}>
                <Column style={{ width: 40, height: 12, borderRadius: 6, backgroundColor: c.primary, transformOrigin: "left", transform: [{ scaleX: fill }] }} />
              </Column>
            </MbSection>
            <MbSection title="f) Width" note="width 40 → 240; the box after it moves along">
              <Row style={{ gap: 8, alignItems: "center" }}>
                <Column style={{ width: t.map([0, 1], [40, 240]), height: 32, borderRadius: 8, backgroundColor: "#B45309" }} />
                <Column style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: c.ink }} />
              </Row>
            </MbSection>
            <MbSection title="g) Text" note="the timeline × 100000 as ₹ text with Indian grouping">
              <Text fontSize={22} fontWeight={700} color={c.ink}>
                {derive(() => t() * 100000).format({ prefix: "₹" })}
              </Text>
            </MbSection>
            <MbSection title="h) Fill in a fragment" note="the bar of e), inside a component that returns a fragment">
              <Column style={{ height: 12, borderRadius: 6, backgroundColor: c.border }}>
                <MbFragmentFill ms={props.ms} still={props.still} />
              </Column>
            </MbSection>
            <MbSection title="i) Parent in a Scroll" note="width = parent.height: 200 pt (the content), not 80 (the viewport)">
              <Scroll style={{ height: 80, borderWidth: 1, borderColor: c.border }}>
                <Column style={{ width: 1, height: 12, backgroundColor: "#B45309", transformOrigin: "left", transform: [{ scaleX: derive(() => parent.height / self.width) }] }} />
                <Column style={{ height: 188 }} />
              </Scroll>
              <Column style={{ width: 200, height: 3, backgroundColor: c.ink }} />
              <Column style={{ width: 80, height: 3, backgroundColor: "#E23744" }} />
            </MbSection>
            <MbSection title="j) Taps" note="moved 100 pt, turned 12° and scaled 1.2 by motion values at rest: tap each where it is drawn">
              <MbTaps />
            </MbSection>
          </Column>
        </Scroll>
      )}
    </Column>
  )
}
