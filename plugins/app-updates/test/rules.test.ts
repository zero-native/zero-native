import { expect, test } from "bun:test"
import {
  CHECK_DELAY_MS,
  WAIT_RECHECK_MS,
  createAppUpdateEngine,
  type AppUpdateDeps,
  type Clock,
  type StoreCheck,
  type StoreUpdate,
} from "../src/rules"

/** A clock that runs timers only when told. */
function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    setTimeout(fn, ms) {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(h) {
      timers.delete(h as number)
    },
  }
  async function advance(ms: number) {
    now += ms
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id)
        t.fn()
      }
    }
    await flush()
  }
  return { clock, advance, pending: () => timers.size }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const quiet = { log: () => {}, warn: () => {} }

function setup(over: Partial<AppUpdateDeps> & { answer?: StoreCheck | null; playHas?: boolean } = {}) {
  const calls: string[] = []
  const state = { busy: false, route: "home" as string | undefined, front: true, answer: over.answer ?? null, playHas: over.playHas ?? true }
  const c = fakeClock()
  const deps: AppUpdateDeps = {
    source: {
      get: async () => {
        calls.push("source")
        return state.answer
      },
    },
    play: {
      isAvailable: async () => {
        calls.push("play.isAvailable")
        return { available: state.playHas }
      },
      start: async ({ flexible }) => {
        calls.push(flexible ? "play.flexible" : "play.immediate")
        return { ok: true }
      },
      complete: async () => {
        calls.push("play.complete")
        return { ok: true }
      },
    },
    isBusy: () => state.busy,
    currentRoute: () => state.route,
    isFront: () => state.front,
    holdRoutes: new Set(["login", "verify"]),
    clock: c.clock,
    log: quiet,
    ...over,
  }
  return { engine: createAppUpdateEngine(deps), calls, state, ...c }
}

const forced: StoreUpdate = { version: 170, critical: 2 }
const optional: StoreUpdate = { version: 170, critical: 1 }
const answer = (update: StoreUpdate | null): StoreCheck => ({ update, store: {} })

test("no update: nothing after the source, no Play call", async () => {
  const t = setup({ answer: answer(null) })
  await t.engine.check()
  expect(t.calls).toEqual(["source"])
})

test("no answer (offline): nothing, asked again later", async () => {
  const t = setup({ answer: null })
  await t.engine.check()
  expect(t.calls).toEqual(["source"])
})

test("forced: Play's immediate update, on every check", async () => {
  const t = setup({ answer: answer(forced) })
  await t.engine.check()
  await t.engine.check()
  expect(t.calls).toEqual(["source", "play.isAvailable", "play.immediate", "source", "play.isAvailable", "play.immediate"])
})

test("forced also shows on a hold route (login)", async () => {
  const t = setup({ answer: answer(forced) })
  t.state.route = "login"
  await t.engine.check()
  expect(t.calls).toContain("play.immediate")
})

test("Play has no update for this phone: ignore", async () => {
  const t = setup({ answer: answer(forced), playHas: false })
  await t.engine.check()
  expect(t.calls).toEqual(["source", "play.isAvailable"])
})

test("optional: Play's flexible sheet once per session", async () => {
  const t = setup({ answer: answer(optional) })
  await t.engine.check()
  await t.engine.check()
  expect(t.calls).toEqual(["source", "play.isAvailable", "play.flexible", "source"])
})

test("optional waits on a hold route and asks again once the user leaves it", async () => {
  const t = setup({ answer: answer(optional) })
  t.state.route = "verify"
  await t.engine.check()
  expect(t.calls).toEqual(["source"])
  t.state.route = "home"
  await t.advance(WAIT_RECHECK_MS)
  expect(t.calls).toEqual(["source", "source", "play.isAvailable", "play.flexible"])
})

test("optional waits while there is no screen yet; the recheck only runs in front", async () => {
  const t = setup({ answer: answer(optional) })
  t.state.route = undefined
  await t.engine.check()
  t.state.front = false
  t.state.route = "home"
  await t.advance(WAIT_RECHECK_MS)
  expect(t.calls).toEqual(["source"])
})

test("busy: no check at all, and busy during the check stops before Play", async () => {
  const t = setup({ answer: answer(forced) })
  t.state.busy = true
  await t.engine.check()
  expect(t.calls).toEqual([])

  // The app turns busy while Play answers
  const busyAfterPlay = setup({
    answer: answer(forced),
    play: {
      isAvailable: async () => {
        busyAfterPlay.state.busy = true
        return { available: true }
      },
      start: async () => {
        throw new Error("must not start")
      },
      complete: async () => null,
    },
  })
  await busyAfterPlay.engine.check()
  expect(busyAfterPlay.calls).toEqual(["source"])
})

test("a second check while one runs does nothing", async () => {
  let release: (v: StoreCheck) => void = () => {}
  const t = setup({
    source: {
      get: () =>
        new Promise<StoreCheck>((r) => {
          t.calls.push("source")
          release = r
        }),
    },
  })
  const first = t.engine.check()
  await t.engine.check()
  release(answer(null))
  await first
  expect(t.calls).toEqual(["source"])
})

test("autoCheck false: start and return schedule no check, a return still installs a downloaded update", async () => {
  const t = setup({ answer: answer(null), autoCheck: false })
  t.engine.onStart()
  t.engine.onActive()
  await t.advance(CHECK_DELAY_MS * 5)
  expect(t.calls).toEqual([])
  expect(t.pending()).toBe(0)
  t.engine.onUpdateState({ status: "downloaded", bytesDownloaded: 0, totalBytes: 0, errorCode: 0 })
  t.engine.onActive()
  await flush()
  expect(t.calls).toEqual(["play.complete"])
})

test("start and return schedule a check in 1 s; a return installs a downloaded update unless busy", async () => {
  const t = setup({ answer: answer(null) })
  t.engine.onStart()
  await t.advance(CHECK_DELAY_MS - 1)
  expect(t.calls).toEqual([])
  await t.advance(1)
  expect(t.calls).toEqual(["source"])

  t.engine.onUpdateState({ status: "downloaded", bytesDownloaded: 0, totalBytes: 0, errorCode: 0 })
  t.state.busy = true
  t.engine.onActive()
  expect(t.calls).toEqual(["source"])
  t.state.busy = false
  t.engine.onActive()
  await t.advance(CHECK_DELAY_MS)
  expect(t.calls).toEqual(["source", "play.complete", "source"])
})

test("install state moves the phase", () => {
  const t = setup()
  const s = (status: "accepted" | "downloading" | "downloaded" | "declined" | "failed") =>
    t.engine.onUpdateState({ status, bytesDownloaded: 0, totalBytes: 0, errorCode: 0 })
  s("accepted")
  expect(t.engine.phase()).toBe("downloading")
  s("downloaded")
  s("downloading") // a late progress event keeps "downloaded"
  expect(t.engine.phase()).toBe("downloaded")
  s("failed")
  expect(t.engine.phase()).toBe("idle")
})

test("without Play (iOS): the app's own screens; forced every time, optional once", async () => {
  const shown: string[] = []
  const t = setup({
    answer: { update: forced, store: { appStoreId: "123" } },
    play: undefined,
    prompt: {
      forced: (u, store) => shown.push(`forced ${u.version} ${store.appStoreId}`),
      optional: (u) => shown.push(`optional ${u.version}`),
    },
  })
  await t.engine.check()
  await t.engine.check()
  t.state.answer = answer(optional)
  await t.engine.check()
  await t.engine.check()
  expect(shown).toEqual(["forced 170 123", "forced 170 123", "optional 170"])
  expect(t.calls.filter((c) => c.startsWith("play"))).toEqual([])
})

test("an error in a check is caught and the next check runs", async () => {
  let fail = true
  const t = setup({
    source: {
      get: async () => {
        if (fail) throw new Error("boom")
        return answer(forced)
      },
    },
  })
  await t.engine.check()
  fail = false
  await t.engine.check()
  expect(t.calls).toEqual(["play.isAvailable", "play.immediate"])
})

test("ready is awaited before the store is asked", async () => {
  let open: () => void = () => {}
  const t = setup({ answer: answer(null), ready: new Promise<void>((r) => (open = r)) })
  const p = t.engine.check()
  await flush()
  expect(t.calls).toEqual([])
  open()
  await p
  expect(t.calls).toEqual(["source"])
})
