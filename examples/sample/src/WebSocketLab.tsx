// A dev screen for WebSocket (docs/fetch.md §8): runs every case we promise against the local test server
// (tools/fetch-test-server.ts: ws://localhost:8788/ws, raw :8789) and one public wss echo, and shows pass / fail.
// Open with: bun run tools/ios-sample.ts --route wsLab (iOS), or zn://sample/dev/websocket (Android, after
// adb reverse tcp:8788 tcp:8788 and tcp:8789). Params: { port } for a server on another port, { run: true } to start
// at once. Each result is also logged: ws-check PASS / FAIL.
import { Column, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { nav, signal, type Signal } from "@zeronative/core"
import { c } from "./tokens"

const FAIL = "#B91C1C"

interface Ev {
  type: string
  data?: string
  code?: number
  reason?: string
  wasClean?: boolean
  message?: string
}

/** A socket and every event it got, in order. */
interface Tracked {
  ws: WebSocket
  events: Ev[]
}

function track(url: string, protocols?: string | string[]): Tracked {
  const ws = new WebSocket(url, protocols)
  const events: Ev[] = []
  ws.onopen = () => events.push({ type: "open" })
  ws.onmessage = (e: any) => events.push({ type: "message", data: e.data })
  ws.onerror = (e: any) => events.push({ type: "error", message: e.message })
  ws.onclose = (e: any) => events.push({ type: "close", code: e.code, reason: e.reason, wasClean: e.wasClean })
  return { ws, events }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** "open → message → close 1000": what a socket got, for messages. */
function order(t: Tracked): string {
  return t.events.map((e) => (e.type === "close" ? `close ${e.code}` : e.type)).join(" → ") || "nothing"
}

/** The first event of this type (and after `skip` of them), within `ms`. */
async function next(t: Tracked, type: string, ms = 5000, skip = 0): Promise<Ev> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    const found = t.events.filter((e) => e.type === type)[skip]
    if (found) return found
    await sleep(20)
  }
  throw new Error(`no ${type} within ${ms} ms; got ${order(t)}`)
}

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(what)
}

/** error, then close with this code (wasClean as given): the browser order for a failed or refused socket. */
async function errorThenClose(t: Tracked, code: number, wasClean: boolean, ms = 8000): Promise<string> {
  const close = await next(t, "close", ms)
  must(order(t).endsWith(`error → close ${code}`), `order ${order(t)}`)
  must(close.wasClean === wasClean, `wasClean ${close.wasClean}`)
  const error = t.events.find((e) => e.type === "error")!
  return `${order(t)}: ${String(error.message).slice(0, 70)}`
}

type Check = () => Promise<string>

function checksFor(port: number): Array<[string, Check]> {
  const W = `ws://localhost:${port}/ws`
  const RAW = `ws://localhost:${port + 1}`
  const L = `http://localhost:${port}`
  return [
    ["open, echo, close 1000", async () => {
      const t = track(W)
      await next(t, "open")
      const sent = "नमस्ते 😀 ☕"
      t.ws.send(sent)
      const m = await next(t, "message")
      must(m.data === sent, `echo came back as ${m.data}`)
      t.ws.close(1000, "done")
      const close = await next(t, "close")
      must(close.code === 1000 && close.wasClean === true, `close ${close.code} wasClean ${close.wasClean}`)
      must(order(t) === "open → message → close 1000", order(t))
      return order(t)
    }],
    ["our close code and reason reach the server", async () => {
      await fetch(`${L}/ws-log-reset`)
      const t = track(W)
      await next(t, "open")
      t.ws.close(4321, "later")
      const close = await next(t, "close")
      const log = (await (await fetch(`${L}/ws-log`)).json()).log as string[]
      must(log.includes("close 4321 later"), `server saw ${JSON.stringify(log)}`)
      must(close.code === 4321 && close.wasClean === true, `close ${close.code} wasClean ${close.wasClean}`)
      return `server saw "close 4321 later"; JS close ${close.code} "${close.reason}"`
    }],
    ["subprotocol chosen by the server", async () => {
      const t = track(`${W}?proto`, ["chat", "superchat"])
      await next(t, "open")
      const p = t.ws.protocol
      t.ws.close()
      must(p === "chat", `protocol "${p}"`)
      return `protocol "${p}"`
    }],
    ["no subprotocol: protocol is empty", async () => {
      const t = track(W)
      await next(t, "open")
      const p = t.ws.protocol
      t.ws.close()
      must(p === "", `protocol "${p}"`)
      return "protocol \"\""
    }],
    ["handshake headers: User-Agent, offered protocols", async () => {
      const t = track(`${W}?headers&proto`, ["chat", "v2.zn"])
      const h = JSON.parse((await next(t, "message")).data!)
      t.ws.close()
      must(String(h["user-agent"]).includes("zero-native/"), `user-agent ${h["user-agent"]}`)
      must(h["sec-websocket-protocol"] === "chat, v2.zn", `sec-websocket-protocol ${h["sec-websocket-protocol"]}`)
      must(h.cookie === undefined, `cookie ${h.cookie}`)
      return h["user-agent"]
    }],
    ["server close 4001: answered, clean", async () => {
      await fetch(`${L}/ws-log-reset`)
      const t = track(`${W}?close=4001`)
      const close = await next(t, "close")
      must(close.code === 4001 && close.reason === "bye" && close.wasClean === true, `close ${close.code} "${close.reason}" wasClean ${close.wasClean}`)
      must(order(t) === "open → close 4001", order(t))
      await sleep(100)
      const log = (await (await fetch(`${L}/ws-log`)).json()).log as string[]
      must(log.length === 1 && log[0]!.startsWith("close 4001"), `server saw ${JSON.stringify(log)}`)
      return `${order(t)} "${close.reason}"; server got our answer (${log[0]})`
    }],
    ["close() while CONNECTING: error, close 1006", async () => {
      const t = track(W)
      t.ws.close()
      return errorThenClose(t, 1006, false)
    }],
    ["binary frame: error, close 1003", async () => {
      const t = track(`${W}?binary`)
      const r = await errorThenClose(t, 1003, true)
      must(order(t) === "open → error → close 1003", order(t))
      return r
    }],
    ["exactly 1 MB arrives", async () => {
      const t = track(`${W}?size=1048576`)
      const m = await next(t, "message")
      t.ws.close()
      must(m.data!.length === 1_048_576, `${m.data!.length} chars`)
      return "1 048 576 bytes"
    }],
    ["1 MB + 1 in: error, close 1009", async () => {
      const t = track(`${W}?size=1048577`)
      return errorThenClose(t, 1009, true)
    }],
    ["UTF-8 bytes counted (524 289 × é = 1 MB + 2)", async () => {
      const t = track(`${W}?size=524289&char=%C3%A9`)
      return errorThenClose(t, 1009, true)
    }],
    ["5 MB in (past native's limit): error, close 1009", async () => {
      const t = track(`${W}?size=5000000`)
      return errorThenClose(t, 1009, true, 10000)
    }],
    ["send of 1 MB + 1 throws RangeError", async () => {
      const t = track(W)
      await next(t, "open")
      let name = "nothing"
      try {
        t.ws.send("x".repeat(1_048_577))
      } catch (e) {
        name = (e as Error).name
      }
      t.ws.send("x".repeat(1_048_576)) // exactly 1 MB is fine
      const m = await next(t, "message", 8000)
      t.ws.close()
      must(name === "RangeError", `threw ${name}`)
      must(m.data!.length === 1_048_576, `echo of 1 MB: ${m.data!.length}`)
      return "RangeError; 1 MB echoed"
    }],
    ["ten sockets at once", async () => {
      const all = Array.from({ length: 10 }, () => track(W))
      await Promise.all(all.map((t) => next(t, "open")))
      all.forEach((t, i) => t.ws.send(`socket ${i}`))
      const got = await Promise.all(all.map((t) => next(t, "message")))
      all.forEach((t) => t.ws.close())
      await Promise.all(all.map((t) => next(t, "close")))
      must(got.every((m, i) => m.data === `socket ${i}`), JSON.stringify(got.map((m) => m.data)))
      return "10 opened, echoed their own message, closed"
    }],
    ["unknown host: error, close 1006", async () => errorThenClose(track("wss://no-such-host.invalid/"), 1006, false)],
    ["connection refused: error, close 1006", async () => errorThenClose(track("ws://localhost:1/"), 1006, false)],
    ["handshake 404: error, close 1006", async () => errorThenClose(track(`ws://localhost:${port}/nope`), 1006, false)],
    ["cleartext ws:// to a public host is blocked", async () => {
      const t = track("ws://example.com/")
      const r = await errorThenClose(t, 1006, false)
      const m = String(t.events.find((e) => e.type === "error")!.message)
      // iOS: our App Transport Security check; Android: the cleartext policy.
      must(/Transport Security|CLEARTEXT/i.test(m), m)
      return r
    }],
    ["real wss:// echo (echo.websocket.org)", async () => {
      const t = track("wss://echo.websocket.org/")
      await next(t, "open", 8000)
      t.ws.send("zn hello")
      const t0 = Date.now()
      while (!t.events.some((e) => e.data === "zn hello") && Date.now() - t0 < 8000) await sleep(20)
      t.ws.close()
      must(t.events.some((e) => e.data === "zn hello"), `got ${order(t)}`)
      return "echoed over TLS"
    }],
    ["pings keep an idle socket (25 s)", async () => {
      const t = track(W)
      await next(t, "open")
      await sleep(25_000)
      t.ws.send("pings?")
      const m = await next(t, "message")
      t.ws.close()
      must(Number(m.data) >= 2, `server got ${m.data} pings`)
      must(order(t) === "open → message", order(t))
      return `server got ${m.data} pings; still open`
    }],
    ["silent server: no pong, error, close 1006", async () => {
      const t = track(`${RAW}/ws-silent`)
      await next(t, "open")
      const t0 = Date.now()
      const r = await errorThenClose(t, 1006, false, 30_000)
      return `after ${Math.round((Date.now() - t0) / 1000)} s: ${r}`
    }],
  ]
}

interface Case {
  name: string
  state: Signal<string>
  color: Signal<string>
}

/** One socket held open, for the background test (home button, back after a while) and for a JS reload. */
function heldSocket(port: number) {
  const state = signal("not open")
  let ws: WebSocket | null = null
  let n = 0
  let timer: any = null
  const toggle = () => {
    if (ws) {
      ws.close()
      return
    }
    const t0 = Date.now()
    const s = (msg: string) => {
      const line = `${Math.round((Date.now() - t0) / 1000)} s: ${msg}`
      state.set(line)
      console.log(`ws-held ${line}`)
    }
    ws = new WebSocket(`ws://localhost:${port}/ws`)
    ws.onopen = () => {
      s("open")
      timer = setInterval(() => ws?.send(`tick ${++n}`), 5000)
    }
    ws.onmessage = (e: any) => s(`echo "${e.data}"`)
    ws.onerror = (e: any) => s(`error ${e.message}`)
    ws.onclose = (e: any) => {
      s(`close ${e.code} ${e.reason} wasClean ${e.wasClean}`)
      clearInterval(timer)
      ws = null
    }
  }
  return { state, toggle }
}

export function WebSocketLabScreen(props: { port?: number; run?: boolean }) {
  const port = Number(props.port ?? 8788)
  const checks = checksFor(port)
  const cases: Case[] = checks.map(([name]) => ({ name, state: signal("—"), color: signal<string>(c.muted) }))
  const summary = signal(`Start the test server first (tools/fetch-test-server.ts, port ${port}), then Run all.`)
  const held = heldSocket(port)
  let running = false

  const runAll = async () => {
    if (running) return
    running = true
    let passed = 0
    for (let i = 0; i < checks.length; i++) {
      const k = cases[i]!
      k.state.set("running…")
      k.color.set(c.muted)
      const t0 = Date.now()
      try {
        const detail = await checks[i]![1]()
        k.state.set(`✓ ${detail} (${Date.now() - t0} ms)`)
        k.color.set(c.success)
        passed++
      } catch (e) {
        k.state.set(`✗ ${e instanceof Error ? e.message : String(e)}`)
        k.color.set(FAIL)
      }
      console.log(`ws-check ${k.state().startsWith("✓") ? "PASS" : "FAIL"} ${k.name}: ${k.state()}`)
      summary.set(`${passed} / ${i + 1} passed${i + 1 < checks.length ? "…" : ""}`)
    }
    running = false
    console.log(`ws-check done: ${summary()}`)
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
          WebSocket checks
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
          <Pressable onPress={held.toggle} style={{ gap: 2, padding: 12, borderRadius: 10, backgroundColor: c.white }}>
            <Text fontSize={14} fontWeight={600} color={c.ink}>
              Hold one socket open (tap to open / close)
            </Text>
            <Text fontSize={12} color={c.muted}>
              {held.state()}
            </Text>
          </Pressable>
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
