// A dev screen for fetch (milestone 3 step 3.4, docs/fetch.md): runs every case we promise against the local test
// server (tools/fetch-test-server.ts, through adb reverse) and a few public HTTPS hosts, and shows pass / fail.
// Open with: adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/fetch
// Each result is also logged: adb logcat -s zn-js | findstr fetch-check
// Params: { port } for a server on another port (raw: port + 1); { dir } a folder the app can read with the lab
// files in it (made by the server's --files: a 3 MB and a 200 MB file), for the FormData file cases; { run } runs
// all at once; { only } keeps the cases whose name has that text. On the iOS simulator any Mac folder works (a
// simulator app reads Mac files; not the app's own container, which moves when ios-sample.ts installs again):
//   ZN_TEST_HTTP_PORT=8798 bun run tools/fetch-test-server.ts --files /tmp/zn-lab
//   bun run tools/ios-sample.ts --route fetch --params '{"port":8798,"dir":"/tmp/zn-lab","run":true}'
// On Android, push the files where the app can read them (run-as dev.zeronative.sample, its cache folder).
// The network-change case calls Fetch.debugFreshSession (iOS debug builds only; skipped elsewhere).
import { Column, Pressable, Row, Scroll, Text } from "@zeronative/ui"
import { callNative, FetchError, FormData, nav, Platform, signal, type Signal } from "@zeronative/core"
import { c } from "./tokens"

const FAIL = "#B91C1C"
const MB3 = 3 * 1024 * 1024 + 17 // the lab files' sizes (tools/fetch-test-server.ts --files)
const MB200 = 200_000_000

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

interface Progress {
  loaded: number
  total: number
}

/** The progress events a call gave, and a short summary of them. */
function track() {
  const events: Progress[] = []
  const on = (p: Progress) => void events.push(p)
  const last = () => events[events.length - 1]
  const growing = () => events.every((e, i) => i === 0 || e.loaded >= events[i - 1]!.loaded)
  const text = () => `${events.length} events, last ${last()?.loaded ?? "-"} / ${last()?.total ?? "-"}`
  return { events, on, last, growing, text }
}

interface UploadPart {
  headers: string[]
  size: number
  text?: string
  pattern?: boolean
}

function checksFor(port: number, dir?: string): Array<[string, Check]> {
  const L = `http://localhost:${port}`
  const RAW = `http://localhost:${port + 1}`
  const file = (name: string) => `file://${encodeURI(`${dir}/${name}`)}`
  const needDir = () => must(!!dir, "no { dir } param: start the server with --files <folder> and pass that folder")
  return [
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
    // ---- Progress events (docs/fetch.md "Progress events") ----
    ["upload progress, 5 MB body", async () => {
      const up = track()
      const r = await (await fetch(`${L}/count`, { method: "POST", body: "x".repeat(5_000_000), onUploadProgress: up.on })).json()
      must(r.length === 5_000_000, `server got ${r.length}`)
      must(up.events.length >= 1 && up.last()!.loaded === 5_000_000 && up.last()!.total === 5_000_000, up.text())
      must(up.growing() && up.events.every((e) => e.total === 5_000_000), JSON.stringify(up.events.slice(0, 5)))
      return up.text()
    }],
    ["download progress, 5 MB", async () => {
      const down = track()
      const b = await (await fetch(`${L}/big?mb=5`, { onDownloadProgress: down.on })).arrayBuffer()
      must(b.byteLength === 5_000_000, `${b.byteLength} bytes`)
      must(down.events.length >= 2 && down.last()!.loaded === 5_000_000 && down.last()!.total === 5_000_000, down.text())
      must(down.growing(), "loaded went down")
      return down.text()
    }],
    ["download progress, gzip: total -1", async () => {
      const down = track()
      await (await fetch(`${L}/gzip`, { onDownloadProgress: down.on })).json()
      must(down.events.length >= 1 && down.events.every((e) => e.total === -1), down.text())
      must(down.last()!.loaded > 5000, `last loaded ${down.last()!.loaded} (unzipped bytes)`)
      return down.text()
    }],
    ["empty POST: one upload event 0 / 0", async () => {
      const up = track()
      await (await fetch(`${L}/count`, { method: "POST", onUploadProgress: up.on })).json()
      must(up.events.length === 1 && up.last()!.loaded === 0 && up.last()!.total === 0, up.text())
      return up.text()
    }],
    ["GET: no upload events", async () => {
      const up = track()
      await (await fetch(`${L}/json`, { onUploadProgress: up.on })).json()
      must(up.events.length === 0, up.text())
      return "none"
    }],
    ["no events after an abort", async () => {
      const down = track()
      const ctl = new AbortController()
      const p = fetch(`${L}/big?mb=8`, { signal: ctl.signal, onDownloadProgress: (e) => {
        down.on(e)
        ctl.abort()
      } })
      await rejects(p)
      const n = down.events.length
      await new Promise((r) => setTimeout(r, 300))
      must(down.events.length === n && n <= 1, down.text())
      return `${n} event before the abort, none after`
    }],
    // ---- FormData file parts (streamed from disk) ----
    ["FormData file part, 3 MB, streamed", async () => {
      needDir()
      const up = track()
      const form = new FormData()
      form.append("storeId", "42")
      form.append("receipt", { uri: file("zn-lab-3mb.bin"), name: "receipt 1.jpg", type: "image/jpeg" })
      const r = await (await fetch(`${L}/upload`, { method: "POST", body: form as any, onUploadProgress: up.on })).json()
      const parts = r.parts as UploadPart[]
      must(parts.length === 2 && parts[0]!.text === "42", JSON.stringify(parts))
      const f = parts[1]!
      must(f.size === MB3 && f.pattern === true, `file part ${f.size} bytes, pattern ${f.pattern}`)
      must(f.headers.includes('Content-Disposition: form-data; name="receipt"; filename="receipt 1.jpg"'), f.headers.join(" | "))
      must(f.headers.includes("Content-Type: image/jpeg"), f.headers.join(" | "))
      must(up.last()?.loaded === r.length && up.last()?.total === r.length, `${up.text()}, body ${r.length}`)
      return `${r.length} bytes; ${up.text()}`
    }],
    ["FormData file name can't add headers", async () => {
      needDir()
      const form = new FormData()
      form.append("f", { uri: file("zn-lab-3mb.bin"), name: 'evil".jpg\r\nX-Evil: 1', type: "image/jpeg" })
      const r = await (await fetch(`${L}/upload`, { method: "POST", body: form as any })).json()
      const h = (r.parts as UploadPart[])[0]!.headers
      must(!h.some((l) => l.startsWith("X-Evil")), h.join(" | "))
      must(h[0] === 'Content-Disposition: form-data; name="f"; filename="evil%22.jpg%0D%0AX-Evil: 1"', h[0]!)
      return h[0]!.slice(32)
    }],
    ["FormData 200 MB file (memory stays flat)", async () => {
      needDir()
      const up = track()
      const form = new FormData()
      form.append("video", { uri: file("zn-lab-200mb.bin"), name: "video.mp4", type: "video/mp4" })
      const t0 = Date.now()
      const r = await (await fetch(`${L}/upload`, { method: "POST", body: form as any, timeout: 180_000, onUploadProgress: up.on })).json()
      const f = (r.parts as UploadPart[])[0]!
      must(f.size === MB200 && f.pattern === true, `file part ${f.size} bytes, pattern ${f.pattern}`)
      // At least 2 (one on the way, the last): over localhost 200 MB can go in under 300 ms, so the 100 ms throttle may
      // let only those through.
      must(up.events.length >= 2 && up.growing() && up.last()?.loaded === r.length && up.last()?.total === r.length, up.text())
      return `${Math.round(r.length / 1e6)} MB in ${Date.now() - t0} ms; ${up.text()}`
    }],
    ["FormData 200 MB upload aborted", async () => {
      needDir()
      const up = track()
      const ctl = new AbortController()
      const form = new FormData()
      form.append("video", { uri: file("zn-lab-200mb.bin"), name: "video.mp4", type: "video/mp4" })
      const t0 = Date.now()
      const p = fetch(`${L}/upload`, { method: "POST", body: form as any, signal: ctl.signal, onUploadProgress: (e) => {
        up.on(e)
        ctl.abort()
      } })
      const e = (await rejects(p)) as Error
      must(e.name === "AbortError", `${e.name}: ${e.message}`)
      // iOS: the staged body file (Caches/zn-fetch-upload) is removed when the task ends.
      return `${e.name} after ${Date.now() - t0} ms; ${up.text()}`
    }],
    ["FormData timeout covers writing the body", async () => {
      needDir()
      const form = new FormData()
      form.append("video", { uri: file("zn-lab-200mb.bin"), name: "video.mp4", type: "video/mp4" })
      const t0 = Date.now()
      // iOS writes the body to a file before sending it; the timeout counts that too (Android's callTimeout).
      const e = await rejects(fetch(`${L}/upload`, { method: "POST", body: form as any, timeout: 50 }))
      const ms = Date.now() - t0
      must(ms < 3000, `timed out only after ${ms} ms`)
      return `${expectCode(e, "timeout").slice(0, 7)} after ${ms} ms`
    }],
    ["FormData content:// part", async () => {
      const form = new FormData()
      form.append("f", { uri: "content://media/external/images/media/1", name: "a.jpg", type: "image/jpeg" })
      const e = await rejects(fetch(`${L}/upload`, { method: "POST", body: form as any }))
      // iOS has no ContentResolver: a clear invalid_request. Android reads it (this one doesn't exist).
      if (Platform.OS === "ios") {
        must((e as Error).message.includes("Android content URI"), (e as Error).message)
        return expectCode(e, "invalid_request")
      }
      return `rejected: ${(e as any).code ?? (e as Error).message}`
    }],
    ["FormData missing file", async () => {
      const form = new FormData()
      form.append("f", { uri: "file:///no/such/file.jpg", name: "a.jpg", type: "image/jpeg" })
      const e = await rejects(fetch(`${L}/upload`, { method: "POST", body: form as any }))
      if (Platform.OS === "ios") return expectCode(e, "invalid_request")
      return `rejected: ${(e as any).code ?? (e as Error).message}`
    }],
    // ---- Network change (Android: freshPool from the network callback; iOS: freshSession) ----
    ["network change: new connections, running calls finish", async () => {
      if (Platform.OS !== "ios") return "skipped: Android flushes from its network callback (not callable from JS)"
      const port = async () => (await (await fetch(`${L}/conn`)).json()).port as number
      const a = await port()
      const b = await port()
      must(a === b, `no pooled connection to start from (${a}, ${b})`)
      const slow = [1, 2, 3, 4].map(() => fetch(`${L}/slow?ms=1500`).then((r) => r.json()))
      await new Promise((r) => setTimeout(r, 300))
      try {
        await callNative("Fetch", "debugFreshSession")
      } catch (e) {
        return `skipped: ${(e as Error).message} (debug builds only)`
      }
      const after = await Promise.all([port(), port(), port(), port()])
      const done = await Promise.all(slow)
      must(done.every((j) => j.slept === true), JSON.stringify(done))
      must(!after.includes(a), `a call after the change used the old connection ${a}: ${after}`)
      return `old ${a}; after: ${after.join(", ")}; 4 slow calls finished`
    }],
  ]
}

interface Case {
  name: string
  state: Signal<string>
  color: Signal<string>
}

export function FetchScreen(props: { port?: number; dir?: string; run?: boolean; only?: string }) {
  const port = Number(props.port ?? 8788)
  const checks = checksFor(port, props.dir).filter(([name]) => !props.only || name.includes(props.only))
  const cases: Case[] = checks.map(([name]) => ({ name, state: signal("—"), color: signal<string>(c.muted) }))
  const summary = signal(`Start the test server first (tools/fetch-test-server.ts, port ${port}), then Run all.`)
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
