// A dev screen for app storage and SecureStore (milestone 3 step 3.5, docs/storage.md). Runs its checks when it
// opens; results are also logged (adb logcat -s zn-js | findstr storage-check).
// Kill test: open it, note "visits", kill the app (adb shell am kill / swipe away), open it again: visits + 1.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/storage
import { Column, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { createStorage, nav, now, persistedSignal, SecureStore, signal, storage, type Signal } from "@zero-native/core"
import { c } from "./tokens"
import { Device } from "./device"

const FAIL = "#B91C1C"

type Check = () => Promise<string> | string

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(what)
}

const checks: Array<[string, Check]> = [
  ["types come back as saved", () => {
    const s = createStorage("dev.check")
    s.clear()
    s.set("text", "नमस्ते 😀")
    s.set("num", 1250.75)
    s.set("neg0", -0)
    s.set("yes", false)
    s.set("bytes", new Uint8Array([0, 255, 7]))
    must(s.get("text") === "नमस्ते 😀", `text ${String(s.get("text"))}`)
    must(s.getNumber("num") === 1250.75, `num ${s.get("num")}`)
    must(Object.is(s.getNumber("neg0"), -0), "-0 lost its sign")
    must(s.getBoolean("yes") === false, "boolean")
    must(JSON.stringify([...s.getBytes("bytes")!]) === "[0,255,7]", "bytes")
    must(s.keys().length === 5, `keys ${s.keys().join(",")}`)
    return "string, number, boolean, bytes"
  }],
  ["wrong-type read is a TypeError", () => {
    const s = createStorage("dev.check")
    try {
      s.getString("num")
    } catch (e) {
      must(e instanceof TypeError, String(e))
      return (e as Error).message
    }
    throw new Error("no error")
  }],
  ["delete, clear, separate stores", () => {
    const a = createStorage("dev.check")
    const b = createStorage("dev.check2")
    b.set("text", "other")
    a.delete("text")
    must(!a.has("text") && b.getString("text") === "other", "stores mixed up")
    a.clear()
    must(a.keys().length === 0 && b.keys().length === 1, "clear")
    b.clear()
    return "ok"
  }],
  ["speed: 10,000 writes + 10,000 reads, every value checked", () => {
    const s = createStorage("dev.bench")
    s.clear()
    // 10,000 different keys and values (with Hindi, so multi-byte text is timed too).
    const t0 = now()
    for (let i = 0; i < 10_000; i++) s.set(`k${i}`, `मान ${i}`)
    const t1 = now()
    let wrong = 0
    for (let i = 0; i < 10_000; i++) if (s.getString(`k${i}`) !== `मान ${i}`) wrong++
    const t2 = now()
    must(wrong === 0, `${wrong} values came back different`)
    must(s.keys().length === 10_000, `${s.keys().length} keys`)
    const t3 = now()
    s.flush()
    const t4 = now()
    s.clear()
    return (
      `write ${(((t1 - t0) * 1000) / 10_000).toFixed(1)} µs, read ${(((t2 - t1) * 1000) / 10_000).toFixed(1)} µs; ` +
      `all 10,000 equal; flush ${(t4 - t3).toFixed(1)} ms`
    )
  }],
  ["a value written before the last close reads back exactly", () => {
    // Written at the end of the previous open (below); checked here after the app was closed or killed.
    const prev = storage.getString("dev.handoff")
    const expected = storage.getString("dev.handoffCopy")
    must(prev === expected, `got ${prev}, expected ${expected}`)
    return prev ? `"${prev}"` : "first open (nothing to compare yet)"
  }],
  ["JS and Kotlin share stores (ZnStorage)", async () => {
    const text = `नमस्ते 😀 from JS ${Math.random().toString(36).slice(2, 7)}`
    storage.set("dev.fromJs", text)
    const r = await Device.storageEcho()
    must(r.fromJs === text, `Kotlin read ${r.fromJs}`)
    must(storage.getString("dev.fromKotlin") === `${text} ← Kotlin`, `JS read ${storage.getString("dev.fromKotlin")}`)
    must(storage.getNumber("dev.kotlinNumber") === 42.5 && storage.getBoolean("dev.kotlinFlag") === true, "types")
    must(r.typeError.includes("holds a string, not a number"), r.typeError)
    return "both ways, types kept, emoji kept"
  }],
  ["Kotlin thread and JS write at the same time", async () => {
    const N = 20_000
    const whole = (v: string | undefined) => {
      // "<who> <n>:<filler>:<n>": both numbers must match, or the value was torn.
      const m = v ? /^(kotlin|js) (\d+):[kj]*:(\d+)$/.exec(v) : null
      return m !== null && m[2] === m[3]
    }
    const kotlin = Device.storageHammer({ count: N }) // starts on a background thread
    let torn = 0
    let sawKotlin = 0
    for (let i = 1; i <= N; i++) {
      storage.set("dev.hammer.js", i)
      storage.set("dev.hammer.shared", `js ${i}:` + "j".repeat(i % 300) + `:${i}`)
      const shared = storage.getString("dev.hammer.shared")
      if (!whole(shared)) torn++
      if (shared?.startsWith("kotlin")) sawKotlin++
    }
    const r = await kotlin
    must(torn === 0, `${torn} torn values`)
    must(storage.getNumber("dev.hammer.js") === N, `js counter ${storage.get("dev.hammer.js")}`)
    must(storage.getNumber("dev.hammer.kotlin") === N, `kotlin counter ${storage.get("dev.hammer.kotlin")}`)
    must(whole(storage.getString("dev.hammer.shared")), "final shared value torn")
    return `${N} + ${N} writes, 0 torn; JS read Kotlin's value ${sawKotlin} times mid-run; last writer wins`
  }],
  ["SecureStore set → get → delete", async () => {
    const t0 = now()
    await SecureStore.set("dev.token", "tok_नमस्ते_😀_" + "x".repeat(2000))
    const t1 = now()
    const back = await SecureStore.get("dev.token")
    const t2 = now()
    must(back === "tok_नमस्ते_😀_" + "x".repeat(2000), `got ${back?.slice(0, 20)}`)
    await SecureStore.delete("dev.token")
    must((await SecureStore.get("dev.token")) === null, "still there after delete")
    return `set ${(t1 - t0).toFixed(1)} ms, get ${(t2 - t1).toFixed(1)} ms`
  }],
  ["SecureStore missing key is null", async () => {
    must((await SecureStore.get("dev.never-saved")) === null, "not null")
    return "null"
  }],
]

interface Case {
  name: string
  state: Signal<string>
  color: Signal<string>
}

export function StorageScreen() {
  // Kept across app kills: the kill test reads these.
  const visits = persistedSignal("dev.visits", 0)
  visits.set(visits() + 1)
  const lastWrite = storage.getString("dev.lastWrite") ?? "never"
  storage.set("dev.lastWrite", new Date().toISOString())

  const cases: Case[] = checks.map(([name]) => ({ name, state: signal("—"), color: signal<string>(c.muted) }))
  const summary = signal("running…")

  const run = async () => {
    let passed = 0
    for (let i = 0; i < checks.length; i++) {
      const k = cases[i]!
      try {
        const detail = await checks[i]![1]()
        k.state.set(`✓ ${detail}`)
        k.color.set(c.success)
        passed++
      } catch (e) {
        k.state.set(`✗ ${e instanceof Error ? e.message : String(e)}`)
        k.color.set(FAIL)
      }
      console.log(`storage-check ${k.state().startsWith("✓") ? "PASS" : "FAIL"} ${k.name}: ${k.state()}`)
    }
    summary.set(`${passed} / ${checks.length} passed`)
    // For the next open: the same value in two keys, written now; the next open checks they match.
    const token = `${new Date().toISOString()} ✓ नमस्ते ${Math.random().toString(36).slice(2)}`
    storage.set("dev.handoff", token)
    storage.set("dev.handoffCopy", token)
    console.log(`storage-check done: ${summary()} (visits ${visits()}, last write before this open: ${lastWrite})`)
  }
  setTimeout(run, 200)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Storage checks
        </Text>
      </Row>
      <Column style={{ paddingHorizontal: 20, paddingBottom: 8, gap: 2 }}>
        <Text fontSize={14} color={c.ink}>
          Visits: {visits()} (kill the app and reopen: +1)
        </Text>
        <Text fontSize={12} color={c.muted}>
          Last write before this open: {lastWrite}
        </Text>
        <Text fontSize={13} color={c.muted}>
          {summary()}
        </Text>
      </Column>
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
