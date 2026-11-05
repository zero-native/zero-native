// A dev screen for the lottie plugin, written the way ported React Native code is: the default import, `ref` (a useRef
// object and a callback), RN's prop names. The files are in ../assets/lottie (made by ../make-lottie.ts). A phone test
// reads the lines on screen and the log lines "lottie-lab ...".
import { signal, useRef } from "@zero-native/core"
import LottieView, { Lottie } from "@zero-native/lottie"
import { Column, Pressable, Row, Scroll, Text, View } from "@zero-native/ui"
import { c } from "./tokens"

function LottieLabButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} alignItems="center" style={{ flex: 1, paddingHorizontal: 4, paddingVertical: 10, borderRadius: 8, backgroundColor: c.primary }}>
      <Text fontSize={12} fontWeight={600} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const SPEEDS = [1, 2, -1]
const MODES = ["contain", "cover", "center"] as const

export function LottieLabScreen() {
  const status = signal("ready")
  const say = (text: string) => {
    console.info(`lottie-lab ${text}`)
    status.set(text)
  }
  console.info("lottie-lab open") // not at the top of the file: imports run before installRuntime()

  // 1. The pulse: a useRef object, as in RN.
  const pulse = useRef<LottieView | null>(null)
  const showPulse = signal(true)
  const speed = signal(0)
  const green = signal(false)

  // 2. The check: a callback ref, as ZeroBill's Welcome slides keep theirs.
  let check: LottieView | null = null
  const finished = signal(0)
  const cancelled = signal(0)
  const progress = signal<number | undefined>(undefined)

  // 3. The dots (.lottie).
  const mode = signal(0)

  // 4. Files that fail.
  const failures = signal("")
  const failed = (what: string) => (error: string) => {
    failures.set(`${failures()} ${what}=${error}`.trim())
    say(`failure ${what} ${error}`)
  }

  return (
    <Scroll style={{ flex: 1, backgroundColor: c.bg }}>
      <Column gap={12} style={{ padding: 12 }}>
        <Text fontSize={12} color={c.ink}>
          {`status: ${status()}`}
        </Text>

        {/* 1. JSON, loops, autoPlay. The size is on the View around it. */}
        <Column gap={8} style={{ padding: 12, borderRadius: 16, backgroundColor: c.white }}>
          <Text fontSize={14} fontWeight={700} color={c.ink}>
            {`Pulse (json, loop) speed ${SPEEDS[speed()]}x${green() ? ", green" : ""}`}
          </Text>
          <View style={{ height: 140, alignItems: "center" }}>
            {showPulse() && (
              <View style={{ width: 140, height: 140 }}>
                <LottieView
                  ref={pulse}
                  source="asset:lottie/pulse.json"
                  autoPlay
                  loop
                  speed={SPEEDS[speed()]}
                  colorFilters={green() ? [{ keypath: "Dot", color: c.success }, { keypath: "Ring", color: c.success }] : []}
                  onAnimationLoaded={() => say("pulse loaded")}
                />
              </View>
            )}
          </View>
          <Row gap={6}>
            <LottieLabButton label="Play" onPress={() => pulse.current?.play()} />
            <LottieLabButton label="Pause" onPress={() => pulse.current?.pause()} />
            <LottieLabButton label="Resume" onPress={() => pulse.current?.resume()} />
            <LottieLabButton label="Reset" onPress={() => pulse.current?.reset()} />
          </Row>
          <Row gap={6}>
            <LottieLabButton label="Speed" onPress={() => speed.set((speed() + 1) % SPEEDS.length)} />
            <LottieLabButton label="Colour" onPress={() => green.set(!green())} />
            <LottieLabButton
              label={showPulse() ? "Hide" : "Show"}
              onPress={() => {
                showPulse.set(!showPulse())
                say(`pulse ref after toggle: ${pulse.current === null ? "null" : "set"}`)
              }}
            />
          </Row>
        </Column>

        {/* 2. JSON, once, no autoPlay: onAnimationFinish and the `progress` prop. */}
        <Column gap={8} style={{ padding: 12, borderRadius: 16, backgroundColor: c.white }}>
          <Text fontSize={14} fontWeight={700} color={c.ink}>
            {`Check (json, once): finished ${finished()}, cancelled ${cancelled()}, progress ${progress() ?? "-"}`}
          </Text>
          <View style={{ height: 120, alignItems: "center" }}>
            <View style={{ width: 120, height: 120 }}>
              <LottieView
                ref={(v) => {
                  check = v
                }}
                source="asset:lottie/check.json"
                autoPlay={false}
                loop={false}
                progress={progress()}
                onAnimationFinish={(isCancelled) => {
                  if (isCancelled) cancelled.set(cancelled() + 1)
                  else finished.set(finished() + 1)
                  say(`check finish cancelled=${isCancelled}`)
                }}
              />
            </View>
          </View>
          <Row gap={6}>
            <LottieLabButton label="Play" onPress={() => check?.play()} />
            <LottieLabButton label="Frames 14-34" onPress={() => check?.play(14, 34)} />
            <LottieLabButton label="Back 34-0" onPress={() => check?.play(34, 0)} />
            <LottieLabButton label="Reset" onPress={() => check?.reset()} />
          </Row>
          <Row gap={6}>
            <LottieLabButton label="0" onPress={() => progress.set(0)} />
            <LottieLabButton label="0.5" onPress={() => progress.set(0.5)} />
            <LottieLabButton label="1" onPress={() => progress.set(1)} />
            <LottieLabButton label="Pause" onPress={() => check?.pause()} />
            <LottieLabButton label="Resume" onPress={() => check?.resume()} />
          </Row>
        </Column>

        {/* 3. A .lottie file (a zip), wide box: resizeMode shows. */}
        <Column gap={8} style={{ padding: 12, borderRadius: 16, backgroundColor: c.white }}>
          <Text fontSize={14} fontWeight={700} color={c.ink}>
            {`Dots (.lottie, loop) resizeMode ${MODES[mode()]}`}
          </Text>
          <View style={{ height: 80, borderRadius: 12, backgroundColor: c.pillBg, overflow: "hidden" }}>
            <LottieView source={{ uri: "asset:lottie/dots.lottie" }} autoPlay resizeMode={MODES[mode()]} onAnimationLoaded={() => say("dots loaded")} />
          </View>
          <Row gap={6}>
            <LottieLabButton label="resizeMode" onPress={() => mode.set((mode() + 1) % MODES.length)} />
            <LottieLabButton
              label="Preload"
              onPress={() =>
                void Lottie.preload({ source: "asset:lottie/dots.lottie" }).then((r) =>
                  say(r.ok ? `preload ok ${r.width}x${r.height} ${r.frames} frames ${Math.round(r.durationMs)} ms` : `preload failed ${r.reason}`),
                )
              }
            />
            <LottieLabButton label="Preload bad" onPress={() => void Lottie.preload({ source: "asset:lottie/nope.json" }).then((r) => say(r.ok ? "preload ok?" : `preload failed ${r.reason}`))} />
          </Row>
        </Column>

        {/* 4. Files that fail: each gives onAnimationFailure, and the box stays empty. */}
        <Column gap={8} style={{ padding: 12, borderRadius: 16, backgroundColor: c.white }}>
          <Text fontSize={14} fontWeight={700} color={c.ink}>
            {`Failures: ${failures() || "none yet"}`}
          </Text>
          <Row gap={6} style={{ height: 40 }}>
            <View style={{ flex: 1, height: 40 }}>
              <LottieView source="asset:lottie/missing.json" autoPlay onAnimationFailure={failed("missing")} />
            </View>
            <View style={{ flex: 1, height: 40 }}>
              <LottieView source="https://example.com/a.json" autoPlay onAnimationFailure={failed("url")} />
            </View>
            <View style={{ flex: 1, height: 40 }}>
              <LottieView source="asset:lottie/broken.json" autoPlay onAnimationFailure={failed("broken")} />
            </View>
          </Row>
        </Column>
      </Column>
    </Scroll>
  )
}
