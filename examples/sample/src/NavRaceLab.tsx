// Navigation race lab: JS changes the stack again while a slide is still under way, as a tap on a screen sliding in
// (or a push from an effect, a redirect) does. "Run race" runs each case below at delays from 0 to 900 ms after the
// first change, waits for the slides to end, and checks that JS still has the stack it asked for (a FORCED_BACK from
// native would make it one screen shorter, and native showed that screen blank white: iOS, before 2026-11-24).
//   push-push: push, then push again;  back-push: back, then push;  push-back: push, then back;
//   back-back: two screens up, then back twice.
// Each case logs "nav-race <case> <ms> ok" or "... FAIL <why>", and the end "nav-race done <ok>/<all>" (the UI test
// NavRaceTests reads the "nav-race-result" text).
import { Column, Pressable, Row, Text } from "@zeronative/ui"
import { nav, signal } from "@zeronative/core"
import { c } from "./tokens"

const DELAYS = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900]
const SETTLE = 1300

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** A button; the UI test finds it by its label (accessibilityLabel = the text). */
function NrButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={props.onPress} style={{ paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: c.primary }}>
      <Text fontSize={14} fontWeight={700} color={c.white}>
        {props.label}
      </Text>
    </Pressable>
  )
}

export function NavRaceLabScreen() {
  const result = signal("not run")
  const lines = signal<string[]>([])
  const say = (line: string) => {
    console.info(`nav-race ${line}`)
    lines.set([line, ...lines()].slice(0, 14))
  }

  /** The stack is [lab, ...targets]: the top is the target with step [step] (or the lab when step is 0). */
  const check = (name: string, ms: number, base: number, depth: number, step: number) => {
    const top = nav.current()
    const ok = nav.depth() === base + depth && (step === 0 ? top?.name === "navRaceLab" : top?.params.step === step)
    say(`${name} ${ms} ${ok ? "ok" : `FAIL depth ${nav.depth() - base}, top ${top?.name} ${JSON.stringify(top?.params)}`}`)
    return ok
  }

  const run = async () => {
    result.set("running")
    const base = nav.depth()
    let ok = 0
    let all = 0
    for (const ms of DELAYS) {
      // push, then push again
      nav.push("navRaceTarget", { step: 1 })
      await sleep(ms)
      nav.push("navRaceTarget", { step: 2 })
      await sleep(SETTLE)
      all++
      if (check("push-push", ms, base, 2, 2)) ok++
      while (nav.depth() > base) nav.back()
      await sleep(SETTLE)

      // back, then push
      nav.push("navRaceTarget", { step: 1 })
      await sleep(SETTLE)
      nav.back()
      await sleep(ms)
      nav.push("navRaceTarget", { step: 3 })
      await sleep(SETTLE)
      all++
      if (check("back-push", ms, base, 1, 3)) ok++
      while (nav.depth() > base) nav.back()
      await sleep(SETTLE)

      // push, then back
      nav.push("navRaceTarget", { step: 4 })
      await sleep(ms)
      nav.back()
      await sleep(SETTLE)
      all++
      if (check("push-back", ms, base, 0, 0)) ok++
      while (nav.depth() > base) nav.back()

      // two up, then back twice
      nav.push("navRaceTarget", { step: 5 })
      await sleep(SETTLE)
      nav.push("navRaceTarget", { step: 6 })
      await sleep(SETTLE)
      nav.back()
      await sleep(ms)
      nav.back()
      await sleep(SETTLE)
      all++
      if (check("back-back", ms, base, 0, 0)) ok++
      while (nav.depth() > base) nav.back()
      await sleep(400)
    }
    say(`done ${ok}/${all}`)
    result.set(`${ok}/${all}`)
  }

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg, padding: 16, gap: 12 }}>
      <Row style={{ gap: 8, alignItems: "center" }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Navigation race
        </Text>
      </Row>
      <Text fontSize={13} color={c.muted}>
        Run race: a second push or back while a slide is still under way, at 0 to 900 ms. Push target: then tap "Push again" on the new screen as it slides in.
      </Text>
      <Row style={{ gap: 8, flexWrap: "wrap" }}>
        <NrButton label="Run race" onPress={() => void run()} />
        <NrButton label="Push target" onPress={() => nav.push("navRaceTarget", { step: 1 })} />
      </Row>
      <Text testID="nav-race-result" fontSize={16} fontWeight={700} color={c.ink}>
        {`result: ${result()}`}
      </Text>
      <Column style={{ gap: 2 }}>
        <Text fontSize={12} color={c.muted}>
          {lines().join("\n")}
        </Text>
      </Column>
    </Column>
  )
}

/** The screen the race pushes: its step in large type, so a blank (white) screen is easy to see. */
export function NavRaceTargetScreen(props: { step?: number }) {
  return (
    <Column style={{ flex: 1, backgroundColor: "#E0E7FF", padding: 16, gap: 16 }}>
      <Text testID="nav-race-target" fontSize={28} fontWeight={800} color={c.ink}>
        {`Race target ${props.step ?? 0}`}
      </Text>
      <Row style={{ gap: 8, flexWrap: "wrap" }}>
        <NrButton label="Push again" onPress={() => nav.push("navRaceTarget", { step: (props.step ?? 0) + 1 })} />
        <NrButton label="Back" onPress={() => nav.back()} />
      </Row>
    </Column>
  )
}
