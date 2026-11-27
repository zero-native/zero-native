// A dev screen for WebSocket (docs/fetch.md §8): runs every case we promise against the local test server
// (tools/fetch-test-server.ts: ws://localhost:8788/ws, raw :8789) and one public wss echo, and shows pass / fail.
// Open with: bun run tools/ios-sample.ts --route wsLab (iOS), or zn://sample/dev/websocket (Android, after
// adb reverse tcp:8788 tcp:8788 and tcp:8789). Params: { host } where the server is (default localhost; an iPhone
// uses the Mac's LAN address, which the server prints: zn://sample/dev/websocket?host=192.168.1.20; the "20 sockets"
// case then times that host), { port } for a server on another port (raw: port + 1),
// { run: true } to start at once, { only: "text" } for just the cases whose name has that text, { repeat: 10 } to run
// them that many times (each run logged and counted), { hold: "echo" } or
// { hold: "slowpong" } to open that held socket at once. Each result is also logged: ws-check PASS / FAIL.
import { Column, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { nav, Platform, signal, type Signal } from "@zeronative/core"
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

function checksFor(host: string, port: number): Array<[string, Check]> {
  const W = `ws://${host}:${port}/ws`
  const RAW = `ws://${host}:${port + 1}`
  const L = `http://${host}:${port}`
  // The 80-socket case by address (see there): 127.0.0.1 for localhost, else the host given (a LAN address on a phone).
  const many = host === "localhost" ? "127.0.0.1" : host
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
    ["messages right before the server's close all arrive", async () => {
      const t = track(`${W}?burst=50&close=4001`)
      const close = await next(t, "close")
      const got = t.events.filter((e) => e.type === "message").map((e) => e.data)
      must(got.length === 50 && got.every((d, i) => d === String(i)), `got ${got.length}: ${got.slice(0, 5).join(",")}…`)
      must(order(t) === `open → ${Array(50).fill("message").join(" → ")} → close 4001`, order(t).slice(0, 80))
      must(close.wasClean === true, `wasClean ${close.wasClean}`)
      return "open → 50 messages in order → close 4001"
    }],
    // The same, with the 101, the messages, the close and the TCP FIN in one TCP segment, as a phone on Wi-Fi gets
    // them (on this Mac's loopback the FIN of /ws comes a moment later). URLSession lost all of it here (2026-11-27).
    ["101, messages, close and FIN in one packet: all arrive", async () => {
      const t = track(`${RAW}/ws-closenow?burst=50&code=4001`)
      const close = await next(t, "close")
      const got = t.events.filter((e) => e.type === "message").map((e) => e.data)
      must(got.length === 50 && got.every((d, i) => d === String(i)), `got ${got.length}; ${order(t).slice(0, 40)}; close ${close.code} "${close.reason}"`)
      must(order(t) === `open → ${Array(50).fill("message").join(" → ")} → close 4001`, order(t).slice(0, 80))
      must(close.reason === "bye" && close.wasClean === true, `close ${close.code} "${close.reason}" wasClean ${close.wasClean}`)
      return "open → 50 messages in order → close 4001"
    }],
    ["200 quick sends echo in order", async () => {
      const t = track(W)
      await next(t, "open")
      for (let i = 0; i < 200; i++) t.ws.send(`n${i}`)
      await next(t, "message", 8000, 199)
      t.ws.close()
      const got = t.events.filter((e) => e.type === "message").map((e) => e.data)
      must(got.every((d, i) => d === `n${i}`), `out of order near ${got.findIndex((d, i) => d !== `n${i}`)}`)
      return "n0 … n199 in order"
    }],
    // To 127.0.0.1, not localhost: on the iOS simulator 80 sockets to "localhost" at once open slowly (the first upgrade
    // reaches the server after ~0.8 s, the rest over 2-3 s, and in 2 of 3 runs one socket didn't open in 8 s; 2026-11-24).
    // The guess is that each connection resolves the name (or tries ::1 first) by itself; nothing measured the lookup.
    // By address all 80 open in 0.2-0.7 s. Still one host, so it still checks that nothing caps sockets per host. The
    // next case keeps a small localhost burst, with its time; 80 to a real host name is a phone check.
    ["80 sockets to one host", async () => {
      const all = Array.from({ length: 80 }, () => track(`ws://${many}:${port}/ws`))
      await Promise.all(all.map((t) => next(t, "open", 8000)))
      all.forEach((t, i) => t.ws.send(`socket ${i}`))
      const got = await Promise.all(all.map((t) => next(t, "message")))
      all.forEach((t) => t.ws.close())
      await Promise.all(all.map((t) => next(t, "close")))
      must(got.every((m, i) => m.data === `socket ${i}`), "a socket got another's echo")
      return "80 opened at once, echoed, closed"
    }],
    // 20 to the host (localhost on the simulator) at once, with the time the last open took (the slow path above; 8 s
    // each is the limit).
    [`20 sockets to ${host} (timed)`, async () => {
      const t0 = Date.now()
      const all = Array.from({ length: 20 }, () => track(W))
      await Promise.all(all.map((t) => next(t, "open", 8000)))
      const ms = Date.now() - t0
      all.forEach((t) => t.ws.close())
      await Promise.all(all.map((t) => next(t, "close")))
      console.info(`ws-lab: 20 sockets to ${host} opened in ${ms} ms`)
      return `20 opened in ${ms} ms`
    }],
    // Our close waits for the server's answer, up to 60 s, on both (OkHttp; iOS since 2026-11-27, when it left
    // URLSession, which ended the connection at once without the answer).
    ["our close, server answers 3 s late: close after 3 s", async () => {
      const t = track(`${RAW}/ws-slowclose?ms=3000`)
      await next(t, "open")
      const t0 = Date.now()
      t.ws.close(1000, "done")
      const close = await next(t, "close", 8000)
      const ms = Date.now() - t0
      must(order(t) === "open → close 1000" && close.wasClean === true, `${order(t)} wasClean ${close.wasClean}`)
      must(ms >= 2900, `after ${ms} ms`)
      return `${order(t)} after ${ms} ms, clean`
    }],
    ["our close, then the server drops TCP (no close frame): error, close 1006", async () => {
      const t = track(`${RAW}/ws-eof`)
      await next(t, "open")
      t.ws.close(4002, "done")
      return errorThenClose(t, 1006, false)
    }],
    ["our close never answered: error, close 1006 after 60 s", async () => {
      const t = track(`${RAW}/ws-noclose`)
      await next(t, "open")
      const t0 = Date.now()
      t.ws.close(1000, "done")
      const r = await errorThenClose(t, 1006, false, 75_000)
      const s = Math.round((Date.now() - t0) / 1000)
      must(s >= 58, `after ${s} s`)
      return `after ${s} s: ${r}`
    }],
    ["no 101 for 20 s: iOS gives up at 15 s, Android waits", async () => {
      const t = track(`${RAW}/ws-slow101?ms=20000`)
      const t0 = Date.now()
      if (Platform.OS === "ios") {
        const r = await errorThenClose(t, 1006, false, 25_000)
        const s = Math.round((Date.now() - t0) / 1000)
        must(s >= 14 && s <= 17, `after ${s} s`)
        return `after ${s} s: ${r}`
      }
      await next(t, "open", 25_000)
      t.ws.close()
      return `open after ${Math.round((Date.now() - t0) / 1000)} s`
    }],
    ["unknown host: error, close 1006", async () => errorThenClose(track("wss://no-such-host.invalid/"), 1006, false)],
    ["connection refused: error, close 1006", async () => errorThenClose(track("ws://localhost:1/"), 1006, false)],
    ["handshake 404: error, close 1006", async () => errorThenClose(track(`ws://${host}:${port}/nope`), 1006, false)],
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

/** One socket held open to `url`, for the background test (home button, back after a while) and for a JS reload. */
function heldSocket(url: string, label: string) {
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
      console.log(`ws-held ${label} ${line}`)
    }
    ws = new WebSocket(url)
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

export function WebSocketLabScreen(props: { host?: string; port?: number; run?: boolean; only?: string; repeat?: number; hold?: "echo" | "slowpong" }) {
  const host = props.host || "localhost"
  const port = Number(props.port ?? 8788)
  const checks = checksFor(host, port).filter(([name]) => !props.only || name.includes(props.only))
  const cases: Case[] = checks.map(([name]) => ({ name, state: signal("—"), color: signal<string>(c.muted) }))
  const summary = signal(`Start the test server first (tools/fetch-test-server.ts, ${host}:${port}), then Run all.`)
  // The second one waits 3 s for each pong: suspended in that window (home button, or `kill -STOP` on the
  // simulator's app process), the socket must still be fine on return.
  const held = [
    { key: "echo", title: "Hold one socket open (tap to open / close)", ...heldSocket(`ws://${host}:${port}/ws`, "echo") },
    { key: "slowpong", title: "Hold one socket, pongs 3 s late (tap to open / close)", ...heldSocket(`ws://${host}:${port + 1}/ws-slowpong`, "slowpong") },
  ]
  let running = false

  const runAll = async () => {
    if (running) return
    running = true
    let passed = 0
    const rounds = Math.max(1, Number(props.repeat ?? 1))
    const total = checks.length * rounds
    for (let n = 0; n < total; n++) {
      const i = n % checks.length
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
      summary.set(`${passed} / ${n + 1} passed${n + 1 < total ? "…" : ""}`)
    }
    running = false
    console.log(`ws-check done: ${summary()}`)
  }
  if (props.run) setTimeout(() => void runAll(), 300)
  if (props.hold) setTimeout(() => held.find((h) => h.key === props.hold)?.toggle(), 300)

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
          {held.map((h) => (
            <Pressable key={h.title} onPress={h.toggle} style={{ gap: 2, padding: 12, borderRadius: 10, backgroundColor: c.white }}>
              <Text fontSize={14} fontWeight={600} color={c.ink}>
                {h.title}
              </Text>
              <Text fontSize={12} color={c.muted}>
                {h.state()}
              </Text>
            </Pressable>
          ))}
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
