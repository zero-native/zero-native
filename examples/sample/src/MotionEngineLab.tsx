// A dev screen for the motion engine itself (docs/motion.md): commands, their promises, values read back in JS,
// derive / map / follow, and useFrame, checked from JS with pass / fail. Nothing here is bound to a view, so it runs
// before the renderer reads motion values. Open with: bun run tools/ios-sample.ts --route motionEngineLab
// --params '{"run":true}' (iOS: start it with SIMCTL_CHILD_ZN_MOTION_ENGINE=1 while the engine is behind that flag),
// or zn://sample/dev/motion/engine (Android). Each result is also logged: motion-check PASS / FAIL.
import { Column, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { derive, follow, nav, signal, useFrame, useMotion, type MotionSource } from "@zeronative/core"
import { c } from "./tokens"

const FAIL = "#B91C1C"
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function near(what: string, got: number, want: number, tol: number): void {
  if (!(Math.abs(got - want) <= tol)) throw new Error(`${what}: ${got}, want ${want} ± ${tol}`)
}

function ok(what: string, cond: boolean): void {
  if (!cond) throw new Error(what)
}

/** Waits until [src] (watched from the first read) reaches [want], or [ms] pass. */
async function settle(src: MotionSource, want: number, tol: number, ms = 1500): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (Math.abs(src() - want) <= tol) return src()
    await sleep(16)
  }
  return src()
}

export function MotionEngineLabScreen(props: { run?: boolean; only?: string }) {
  // Made here (an owner), read by the checks.
  const a = useMotion(2)
  const twice = derive(() => a() * 10 + 1)
  const followed = useMotion(0)
  const chaser = follow(followed, { duration: 300 })

  const checks: [string, () => Promise<string>][] = [
    ["to: a 300 ms tween resolves finished at its end", async () => {
      const v = useMotion(0)
      v()
      const t0 = Date.now()
      const r = await v.to(100, { duration: 300, easing: "linear" })
      const ms = Date.now() - t0
      ok("finished", r.finished)
      ok(`took ${ms} ms`, ms >= 250 && ms < 600)
      near("value", await settle(v, 100, 0), 100, 0)
      return `${ms} ms`
    }],
    ["to: the default spring settles", async () => {
      const v = useMotion(10)
      v()
      const r = await v.to(-50)
      ok("finished", r.finished)
      near("value", await settle(v, -50, 0.01), -50, 0.01)
      return "at -50"
    }],
    ["sequence: repeat 2 + reverse ends where it started", async () => {
      const v = useMotion(7)
      v()
      const r = await v.sequence([{ to: 20, timing: 100 }, { set: 30 }, { to: 0, timing: { duration: 80 } }], { repeat: 2, reverse: true })
      ok("finished", r.finished)
      near("value", await settle(v, 7, 0), 7, 0)
      return "back at 7"
    }],
    ["a new command ends the one before it (finished: false)", async () => {
      const v = useMotion(0)
      const p1 = v.to(500, { duration: 1000 })
      await sleep(120)
      const p2 = v.to(0, { duration: 60 })
      const r1 = await p1
      const r2 = await p2
      ok("first says false", !r1.finished)
      ok("second says true", r2.finished)
      return "false, then true"
    }],
    ["stop() leaves it part way", async () => {
      const v = useMotion(0)
      v()
      const p = v.to(100, { duration: 1000, easing: "linear" })
      await sleep(300)
      v.stop()
      const r = await p
      ok("stopped says false", !r.finished)
      await sleep(80)
      const at = v()
      ok(`part way (${at})`, at > 5 && at < 95)
      await sleep(200)
      near("stays", v(), at, 0)
      return `stopped at ${Math.round(at)}`
    }],
    ["decay stops at its clamp", async () => {
      const v = useMotion(0)
      v()
      const r = await v.decay({ velocity: 3000, clamp: [0, 250] })
      ok("finished", r.finished)
      near("value", await settle(v, 250, 0), 250, 0)
      return "at 250"
    }],
    ["derive: a formula of a value, read in JS", async () => {
      near("first", await settle(twice, 21, 0), 21, 0)
      a.set(3)
      near("after set", await settle(twice, 31, 0), 31, 0)
      return "21, then 31"
    }],
    ["map: piecewise lines", async () => {
      const v = useMotion(0)
      const m = v.map([0, 100], [0, 1])
      m()
      v.set(50)
      near("half way", await settle(m, 0.5, 1e-6), 0.5, 1e-6)
      v.set(150)
      near("clamped", await settle(m, 1, 1e-6), 1, 1e-6)
      return "0.5, 1"
    }],
    ["follow: chases its source, then rests on it", async () => {
      chaser()
      followed.set(100)
      await sleep(90)
      const mid = chaser()
      ok(`moving (${mid})`, mid > 0 && mid < 100)
      near("arrives", await settle(chaser, 100, 0.01, 2000), 100, 0.01)
      return `${Math.round(mid)} after 90 ms, then 100`
    }],
    ["useFrame: a frame event each frame", async () => {
      let n = 0
      let dt = 0
      const stop = useFrame((f) => {
        n++
        dt = f.dt
      })
      await sleep(1000)
      stop()
      ok(`${n} frames in a second`, n >= 30)
      ok(`dt ${dt}`, dt > 0 && dt < 40)
      return `${n} frames, dt ${dt.toFixed(1)} ms`
    }],
  ]

  const list = checks.filter(([name]) => !props.only || name.includes(props.only))
  const cases = list.map(([name]) => ({ name, state: signal("—"), color: signal<string>(c.muted) }))
  const summary = signal("Run all checks the engine's commands, promises and values.")
  let running = false

  const runAll = async () => {
    if (running) return
    running = true
    let passed = 0
    for (let i = 0; i < list.length; i++) {
      const k = cases[i]!
      k.state.set("running…")
      k.color.set(c.muted)
      const t0 = Date.now()
      try {
        const detail = await list[i]![1]()
        k.state.set(`✓ ${detail} (${Date.now() - t0} ms)`)
        k.color.set(c.success)
        passed++
      } catch (e) {
        k.state.set(`✗ ${e instanceof Error ? e.message : String(e)}`)
        k.color.set(FAIL)
      }
      console.log(`motion-check ${k.state().startsWith("✓") ? "PASS" : "FAIL"} ${k.name}: ${k.state()}`)
      summary.set(`${passed} / ${i + 1} passed${i + 1 < list.length ? "…" : ""}`)
    }
    running = false
    console.log(`motion-check done: ${summary()}`)
  }
  if (props.run) setTimeout(() => void runAll(), 300)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          Motion engine checks
        </Text>
        <Pressable onPress={runAll} style={{ paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10, backgroundColor: c.primary }}>
          <Text fontSize={13} fontWeight={600} color={c.white}>
            Run all
          </Text>
        </Pressable>
      </Row>
      <Text fontSize={13} color={c.muted} style={{ paddingHorizontal: 20, paddingBottom: 8 }}>
        {summary()}
      </Text>
      <Scroll style={{ flex: 1 }}>
        <Column style={{ paddingHorizontal: 20, paddingBottom: 24, gap: 10 }}>
          {cases.map((k) => (
            <Column key={k.name} style={{ gap: 2, padding: 12, borderRadius: 10, backgroundColor: c.white }}>
              <Text fontSize={14} fontWeight={600} color={c.ink}>
                {k.name}
              </Text>
              <Text fontSize={12} color={k.color()}>
                {k.state()}
              </Text>
            </Column>
          ))}
        </Column>
      </Scroll>
    </Column>
  )
}
