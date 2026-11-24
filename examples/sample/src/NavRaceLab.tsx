// Navigation race lab: JS changes the stack again while a slide is still under way, as a tap on a screen sliding in
// (or a push from an effect, a redirect) does. "Run race" runs each case below at delays from 0 to 900 ms after the
// first change, waits for the slides to end, and checks that JS still has the stack it asked for (a FORCED_BACK from
// native would make it one screen shorter, and native showed that screen blank white: iOS, before 2026-11-24).
//   push-push: push, then push again;  back-push: back, then push;  push-back: push, then back;
//   back-back: two screens up, then back twice.
// Each case logs "nav-race <case> <ms> ok" or "... FAIL <why>", and the end "nav-race done <ok>/<all>".
// At 0 ms both changes land in one batch (one setViewControllers: no race), so the quick runs start at 50 ms.
// With params {"stepwise": true} (the UI test NavRaceTests) each case then waits for "Next case", with the screen JS
// expects in the "nav-race-wait" text on whatever screen native shows: the test checks native shows that one (a
// queued push still showing after push-back, or a blank screen, fails it).
// "Push in 2 s" on a target pushes step 9 two seconds later: start a back swipe meanwhile and hold it, so the push
// comes during the swipe (it then finishes: Back from step 9 must show the lab, not the swiped-off screen blank).
// Each target has a sideways rail: a swipe from the left edge over it goes back, from further in it scrolls the rail
// (EdgeSwipeTests). "Push wants Back" opens one with a useBack handler that only counts: the edge swipe there asks JS
// ("back asked N") and the rail under the finger doesn't scroll as well.
// Toast and keyboard (at the top, so the buttons stay above the keyboard): a toast shown before or while the keyboard
// moves rides up and down with it (ToastKeyboardTests).
import { Column, Pressable, Row, Scroll, Text, TextField, View } from "@zeronative/ui"
import { Keyboard, nav, signal, toast, useBack } from "@zeronative/core"
import { c } from "./tokens"

const DELAYS = [0, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900]
/** With params {"quick": true} (the UI test: tools/ios-ui-test.ts stops a test after 2 minutes): 16 cases, about 55 s. */
const QUICK = [50, 200, 400, 700]
/** With params {"stepwise": true}: 12 cases, each checked on screen by the UI test. */
const STEPWISE = [50, 300, 600]
const SETTLE = 1300
const RAIL = Array.from({ length: 12 }, (_, i) => i)

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

/** Stepwise: "case <n> <name> <ms> ok|FAIL expects <the label of the screen JS has on top>", until "Next case". */
const waiting = signal("")
let resume: (() => void) | undefined
/** How often a target with wantsBack was asked to go back (its handler keeps the screen). */
const backAsked = signal(0)

function WantsBack() {
  useBack(() => {
    backAsked.set(backAsked() + 1)
    console.info(`nav-race back asked ${backAsked()}`)
    return true
  })
  return (
    <Text testID="nav-race-back-asked" fontSize={14} color={c.ink}>
      {`back asked ${backAsked()}`}
    </Text>
  )
}

/** The case waiting for "Next case" (stepwise), on every screen of the lab: only the one native shows is there. */
function RaceWait() {
  return (
    <Column style={{ gap: 8 }}>
      {waiting() !== "" && (
        <Text testID="nav-race-wait" fontSize={13} color={c.ink}>
          {waiting()}
        </Text>
      )}
      {waiting() !== "" && (
        <Row>
          <NrButton
            label="Next case"
            onPress={() => {
              waiting.set("")
              resume?.()
            }}
          />
        </Row>
      )}
    </Column>
  )
}

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

export function NavRaceLabScreen(props: { quick?: boolean; stepwise?: boolean }) {
  const result = signal("not run")
  const lines = signal<string[]>([])
  const say = (line: string) => {
    console.info(`nav-race ${line}`)
    lines.set([line, ...lines()].slice(0, 14))
  }

  /** The stack is [lab, ...targets]: the top is the target with step [step] (or the lab when step is 0). */
  let n = 0
  const check = async (name: string, ms: number, base: number, depth: number, step: number) => {
    const top = nav.current()
    const ok = nav.depth() === base + depth && (step === 0 ? top?.name === "navRaceLab" : top?.params.step === step)
    say(`${name} ${ms} ${ok ? "ok" : `FAIL depth ${nav.depth() - base}, top ${top?.name} ${JSON.stringify(top?.params)}`}`)
    if (props.stepwise) {
      const shows = top?.name === "navRaceLab" ? "Navigation race" : `Race target ${top?.params.step}`
      await new Promise<void>((done) => {
        resume = done
        waiting.set(`case ${++n} ${name} ${ms} ${ok ? "ok" : "FAIL"} expects ${shows}`)
      })
    }
    return ok
  }

  const run = async () => {
    result.set("running")
    const base = nav.depth()
    let ok = 0
    let all = 0
    n = 0
    for (const ms of props.stepwise ? STEPWISE : props.quick ? QUICK : DELAYS) {
      // push, then push again
      nav.push("navRaceTarget", { step: 1 })
      await sleep(ms)
      nav.push("navRaceTarget", { step: 2 })
      await sleep(SETTLE)
      all++
      if (await check("push-push", ms, base, 2, 2)) ok++
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
      if (await check("back-push", ms, base, 1, 3)) ok++
      while (nav.depth() > base) nav.back()
      await sleep(SETTLE)

      // push, then back
      nav.push("navRaceTarget", { step: 4 })
      await sleep(ms)
      nav.back()
      await sleep(SETTLE)
      all++
      if (await check("push-back", ms, base, 0, 0)) ok++
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
      if (await check("back-back", ms, base, 0, 0)) ok++
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
        <NrButton label="Push wants Back" onPress={() => nav.push("navRaceTarget", { step: 1, wantsBack: true })} />
      </Row>
      <TextField
        placeholder="A field for the keyboard"
        style={{ height: 44, paddingHorizontal: 12, borderRadius: 8, backgroundColor: c.white, borderWidth: 1, borderColor: c.border }}
      />
      <Row style={{ gap: 8, flexWrap: "wrap" }}>
        <NrButton label="Toast" onPress={() => toast("Saved", { duration: "long" })} />
        <NrButton label="Hide keyboard" onPress={() => void Keyboard.dismiss()} />
      </Row>
      <Text testID="nav-race-result" fontSize={16} fontWeight={700} color={c.ink}>
        {`result: ${result()}`}
      </Text>
      <RaceWait />
      <Column style={{ gap: 2 }}>
        <Text fontSize={12} color={c.muted}>
          {lines().join("\n")}
        </Text>
      </Column>
    </Column>
  )
}

/** The screen the race pushes: its step in large type, so a blank (white) screen is easy to see. */
export function NavRaceTargetScreen(props: { step?: number; wantsBack?: boolean }) {
  return (
    <Column style={{ flex: 1, backgroundColor: "#E0E7FF", padding: 16, gap: 16 }}>
      <Text testID="nav-race-target" fontSize={28} fontWeight={800} color={c.ink}>
        {`Race target ${props.step ?? 0}`}
      </Text>
      <Row style={{ gap: 8, flexWrap: "wrap" }}>
        <NrButton label="Push again" onPress={() => nav.push("navRaceTarget", { step: (props.step ?? 0) + 1 })} />
        <NrButton label="Back" onPress={() => nav.back()} />
        <NrButton
          label="Push in 2 s"
          onPress={() => {
            console.info("nav-race push in 2 s")
            setTimeout(() => {
              console.info("nav-race push step 9 now")
              nav.push("navRaceTarget", { step: 9 })
            }, 2000)
          }}
        />
      </Row>
      <RaceWait />
      {props.wantsBack === true && <WantsBack />}
      <Scroll horizontal style={{ gap: 8, marginHorizontal: -16, paddingHorizontal: 16 }}>
        {RAIL.map((i) => (
          <View key={i} style={{ width: 90, height: 90, borderRadius: 12, backgroundColor: c.white, alignItems: "center", justifyContent: "center" }}>
            <Text fontSize={14} fontWeight={700} color={c.ink}>{`Rail ${i + 1}`}</Text>
          </View>
        ))}
      </Scroll>
    </Column>
  )
}
