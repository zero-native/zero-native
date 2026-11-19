// A dev screen for fetch (milestone 3 step 3.4, docs/fetch.md): runs every case we promise against the local test
// server (tools/fetch-test-server.ts, through adb reverse) and a few public HTTPS hosts, and shows pass / fail.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/fetch
// Each result is also logged: adb logcat -s zn-js | findstr fetch-check
import { Column, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { FetchError, FormData, nav, signal, type Signal } from "@zeronative/core"
import { c } from "./tokens"

const L = "http://localhost:8788"
const RAW = "http://localhost:8789"
const FAIL = "#B91C1C"

/** A case returns a short detail when it passes, and throws when it doesn't. */
type Check = () => Promise<string>

function expectCode(e: unknown, ...codes: string[]): string {
  if (e instanceof FetchError && codes.includes(e.code)) return `${e.code}: ${e.message.slice(0, 70)}`
  throw new Error(`expected ${codes.join(" / ")}, got ${e instanceof Error ? `${e.name} ${(e as any).code ?? ""} ${e.message}` : String(e)}`)
}

function must(ok: boolean, what: string): void {
  if (!ok) throw new Error(what)
}

async function rejects(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (e) {
    return e
  }
  throw new Error("expected an error, but it succeeded")
}

const checks: Array<[string, Check]> = [
  ["JSON with Hindi and emoji", async () => {
    const j = await (await fetch(`${L}/json`)).json()
    must(j.hindi === "नमस्ते" && j.emoji === "😀", `got ${JSON.stringify(j)}`)
    return `${j.hindi} ${j.emoji}`
  }],
  ["POST body, User-Agent, gzip offered", async () => {
    const sent = JSON.stringify({ note: "चाय ☕", amount: 1250 })
    const e = await (await fetch(`${L}/echo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: sent })).json()
    must(e.method === "POST" && e.bodyText === sent, `body came back as ${e.bodyText}`)
    must(String(e.headers["user-agent"]).includes("zero-native/"), `user-agent ${e.headers["user-agent"]}`)
    // OkHttp offers "gzip", URLSession "gzip, deflate" (iOS): either way the network stack unzips it.
    must(String(e.headers["accept-encoding"]).split(/,\s*/).includes("gzip"), `accept-encoding ${e.headers["accept-encoding"]}`)
    return e.headers["user-agent"]
  }],
  ["gzip answer is unzipped", async () => {
    const res = await fetch(`${L}/gzip`)
    const j = await res.json()
    must(j.zipped === true, "not unzipped")
    return `content-encoding header: ${res.headers.get("content-encoding") ?? "removed"}`
  }],
  ["redirect chain followed", async () => {
    const res = await fetch(`${L}/redirect/3`)
    must(res.redirected && res.url.endsWith("/json"), `redirected=${res.redirected} url=${res.url}`)
    return res.url
  }],
  ["Authorization dropped on another host", async () => {
    const j = await (await fetch(`${L}/redirect-other-host`, { headers: { Authorization: "Bearer secret" } })).json()
    must(j.authorization === null, `server got ${j.authorization}`)
    return "not sent to 127.0.0.1"
  }],
  ["redirect: \"error\" rejects", async () => expectCode(await rejects(fetch(`${L}/redirect/1`, { redirect: "error" })), "redirect_not_allowed")],
  ["redirect: \"manual\" returns the 302", async () => {
    const res = await fetch(`${L}/redirect/1`, { redirect: "manual" })
    must(res.status === 302 && res.headers.get("location") === "/json", `status ${res.status}`)
    return "302 → /json"
  }],
  ["timeout limits the whole request", async () => {
    const t0 = Date.now()
    const e = await rejects(fetch(`${L}/slow?ms=4000`, { timeout: 1500 }))
    const ms = Date.now() - t0
    must(ms < 2500, `took ${ms} ms`)
    return `${expectCode(e, "timeout").slice(0, 7)} after ${ms} ms`
  }],
  ["AbortSignal.timeout rejects with its reason", async () => {
    const e = (await rejects(fetch(`${L}/slow?ms=3000`, { signal: AbortSignal.timeout(800) }))) as Error
    must(e.name === "TimeoutError", `got ${e.name}`)
    return e.message
  }],
  ["404 is not an exception", async () => {
    const res = await fetch(`${L}/status/404`)
    must(!res.ok && res.status === 404, `status ${res.status}`)
    return await res.text()
  }],
  ["json() on 204 explains itself", async () => {
    const e = (await rejects((await fetch(`${L}/status/204`, { method: "DELETE" })).json())) as Error
    must(e instanceof SyntaxError && e.message.includes("204"), e.message)
    return e.message.slice(0, 80)
  }],
  ["UTF-8 BOM stripped", async () => {
    const j = await (await fetch(`${L}/bom`)).json()
    must(j.bom === true, JSON.stringify(j))
    return "parsed"
  }],
  ["Latin-1 bytes become U+FFFD", async () => {
    const t = await (await fetch(`${L}/latin1`)).text()
    must(t === "caf�", JSON.stringify(t))
    return t
  }],
  ["HTML instead of JSON: clear error", async () => {
    const e = (await rejects((await fetch(`${L}/html`)).json())) as Error
    must(e.message.includes("text/html") && e.message.includes("Wi-Fi"), e.message)
    return e.message.slice(0, 80)
  }],
  ["Set-Cookie headers kept apart", async () => {
    const res = await fetch(`${L}/cookies`)
    const all = res.headers.getSetCookie()
    must(all.length === 2 && all[0]!.includes("Expires=Wed, 21 Oct"), JSON.stringify(all))
    return `${all.length} cookies`
  }],
  ["FormData text parts", async () => {
    const form = new FormData()
    form.append("storeId", "42")
    form.append("note", "नमस्ते")
    const e = await (await fetch(`${L}/echo`, { method: "POST", body: form as any })).json()
    must(String(e.headers["content-type"]).startsWith("multipart/form-data; boundary="), e.headers["content-type"])
    must(e.bodyText.includes("नमस्ते"), "text part missing")
    return `${e.bodyLength} bytes`
  }],
  ["binary body round trip", async () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255])
    const e = await (await fetch(`${L}/echo`, { method: "PUT", body: bytes })).json()
    must(JSON.stringify(e.bodyFirstBytes) === "[0,1,2,254,255]", JSON.stringify(e.bodyFirstBytes))
    return "5 bytes"
  }],
  ["5 MB body", async () => {
    const t0 = Date.now()
    const b = await (await fetch(`${L}/big?mb=5`)).arrayBuffer()
    must(b.byteLength === 5_000_000, `${b.byteLength} bytes`)
    return `${Date.now() - t0} ms`
  }],
  ["maxBodySize refuses big bodies", async () => expectCode(await rejects(fetch(`${L}/big?mb=2`, { maxBodySize: 1_000_000 })), "too_large")],
  ["body cut short is an error", async () => expectCode(await rejects(fetch(`${RAW}/cut`)), "connection_lost")],
  ["POST is never sent twice", async () => {
    // Each request goes on a pooled connection (made by /warm) that dies after the request arrives: the case where
    // OkHttp normally sends the request again on a new connection.
    await fetch(`${RAW}/reset`)
    await (await fetch(`${RAW}/warm`)).text()
    const e = await rejects(fetch(`${RAW}/drop`, { method: "POST", body: "pay once" }))
    await (await fetch(`${RAW}/warm`)).text()
    await rejects(fetch(`${RAW}/drop`, { method: "PUT", body: "idempotent" }))
    const counts = await (await fetch(`${RAW}/counts`)).json()
    must(counts["POST /drop"] === 1, `server got the POST ${counts["POST /drop"]} times`)
    return `POST ×1 (${(e as FetchError).code}); PUT ×${counts["PUT /drop"]} (OkHttp may resend idempotent ones)`
  }],
  ["cleartext http:// blocked", async () => expectCode(await rejects(fetch("http://example.com/")), "cleartext_blocked")],
  ["unknown host", async () => expectCode(await rejects(fetch("https://no-such-host.invalid/")), "dns", "offline")],
  ["bad certificate", async () => expectCode(await rejects(fetch("https://expired.badssl.com/")), "tls")],
  ["real HTTPS (generate_204)", async () => {
    const t0 = Date.now()
    const res = await fetch("https://www.google.com/generate_204")
    must(res.status === 204, `status ${res.status}`)
    return `${Date.now() - t0} ms`
  }],
  ["HTTPS → HTTP redirect refused", async () =>
    expectCode(await rejects(fetch("https://httpbin.org/redirect-to?url=http%3A%2F%2Fexample.com%2F")), "insecure_redirect")],
  ["TextEncoder / TextDecoder", async () => {
    const b = new TextEncoder().encode("a\uD800😀")
    must(JSON.stringify([...b]) === "[97,239,191,189,240,159,152,128]", JSON.stringify([...b]))
    const s = new TextDecoder().decode(b)
    must(s === "a�😀", s)
    return "lone surrogate → U+FFFD"
  }],
]

interface Case {
  name: string
  state: Signal<string>
  color: Signal<string>
}

export function FetchScreen() {
  const cases: Case[] = checks.map(([name]) => ({ name, state: signal("—"), color: signal<string>(c.muted) }))
  const summary = signal("Start the test server first (tools/fetch-test-server.ts), then Run all.")
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
      console.log(`fetch-check ${k.state().startsWith("✓") ? "PASS" : "FAIL"} ${k.name}: ${k.state()}`)
      summary.set(`${passed} / ${i + 1} passed${i + 1 < checks.length ? "…" : ""}`)
    }
    running = false
    console.log(`fetch-check done: ${summary()}`)
  }

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink} style={{ flex: 1 }}>
          fetch checks
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
