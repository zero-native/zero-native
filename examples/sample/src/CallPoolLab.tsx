// A dev screen for the "all HTTP calls stuck" report (ZeroBill, 2026-11-09; docs/http-stall-investigation.md).
//
// /dev/call-pool: native module calls share one pool of 2 threads (ZnModules `io`). Device.slowEcho blocks one pool
// thread for `ms`, like a Play call that waits (ZB's InAppUpdate.isUpdateAvailable). Before 2026-11-09 fetch ran on
// that pool too: with both threads held, every fetch waited (and its `timeout` never started). Now fetch has its own
// thread: the fetch rows answer at once, and only "Device.info (any native call)" still waits. The pool watch logs
// each held call after 5 s (adb logcat -s zn | findstr "native call").
//   adb reverse tcp:8788 tcp:8788   (tools/fetch-test-server.ts)
//   adb shell am start -a android.intent.action.VIEW -d zn://sample/dev/call-pool
//   adb logcat -s zn-js | findstr pool-check
//
// /dev/net-loop: a fetch every 3 s to a public HTTPS host and the local server, each on its own (a stuck one doesn't
// stop the next), logged as "net-loop". For network changes while it runs: mobile data / Wi-Fi off and on, Doze.
// tools/repro/http-stall.ts drives both.
import { Carousel, Column, Image, List, Pressable, Row, Scroll, Text } from "@zero-native/ui"
import { FetchError, nav, signal, type Signal } from "@zero-native/core"
import { Device } from "@zero-native/device-test"
import { c } from "./tokens"

const L = "http://localhost:8788"
const HOLD_MS = 6000

function line(text: string, lines: Signal<string[]>) {
  console.log(text)
  lines.set([...lines(), text])
}

/** Blocks [n] pool threads for [ms] (each slowEcho sleeps on its pool thread). */
function hold(n: number, ms: number): Promise<unknown> {
  return Promise.all(Array.from({ length: n }, () => Device.slowEcho({ text: "hold", ms })))
}

async function timed(p: Promise<unknown>): Promise<string> {
  const t0 = Date.now()
  try {
    const v = await p
    const status = v instanceof Response ? `HTTP ${v.status}` : "answered"
    return `${status} after ${Date.now() - t0} ms`
  } catch (e) {
    const code = e instanceof FetchError ? e.code : e instanceof Error ? e.name : String(e)
    return `failed (${code}) after ${Date.now() - t0} ms`
  }
}

/** Gives the native pool time to start the holds before the measured call goes in after them. */
const settle = () => new Promise((r) => setTimeout(r, 300))

export function CallPoolLab() {
  const lines = signal<string[]>([])
  const log = (t: string) => line(`pool-check ${t}`, lines)

  const run = async () => {
    log(`baseline fetch: ${await timed(fetch(`${L}/json`))}`)

    let h = hold(1, HOLD_MS)
    await settle()
    log(`1 thread held ${HOLD_MS} ms, fetch: ${await timed(fetch(`${L}/json`))}`)
    await h

    h = hold(2, HOLD_MS)
    await settle()
    log(`2 threads held ${HOLD_MS} ms, fetch: ${await timed(fetch(`${L}/json`))}`)
    await h

    h = hold(2, HOLD_MS)
    await settle()
    log(`2 threads held, Device.info (any native call): ${await timed(Device.info())}`)
    await h

    h = hold(2, HOLD_MS)
    await settle()
    log(`2 threads held, fetch with timeout 2000: ${await timed(fetch(`${L}/json`, { timeout: 2000 }))}`)
    await h

    h = hold(2, HOLD_MS)
    await settle()
    log(`2 threads held, fetch with AbortSignal.timeout(2000): ${await timed(fetch(`${L}/json`, { signal: AbortSignal.timeout(2000) }))}`)
    await h
    log("done")
  }
  void run()

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Native call pool
        </Text>
      </Row>
      <Scroll style={{ flex: 1 }}>
        <Text fontSize={12} color={c.ink} style={{ paddingHorizontal: 20, paddingBottom: 24 }}>
          {lines().join("\n")}
        </Text>
      </Scroll>
    </Column>
  )
}

export function NetLoopLab() {
  const lines = signal<string[]>([])
  let n = 0
  let open = 0
  const tick = () => {
    const i = ++n
    for (const [name, url] of [["gstatic", "https://www.gstatic.com/generate_204"], ["local", `${L}/json`]] as const) {
      open++
      const t0 = Date.now()
      fetch(url).then(
        (r) => `HTTP ${r.status}`,
        (e) => `failed (${e instanceof FetchError ? e.code : String(e)})`,
      ).then((what) => {
        open--
        line(`net-loop #${i} ${name} ${what} in ${Date.now() - t0} ms, ${open} still open`, lines)
      })
    }
  }
  tick()
  setInterval(tick, 3000) // ends when this screen closes

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Network loop
        </Text>
      </Row>
      <Scroll style={{ flex: 1 }}>
        <Text fontSize={12} color={c.ink} style={{ paddingHorizontal: 20, paddingBottom: 24 }}>
          {lines().slice(-40).join("\n")}
        </Text>
      </Scroll>
    </Column>
  )
}

// /dev/image-par: are images loaded at the same time, or one after another? Like the offers tab: a column of small
// images (all on screen), a horizontal rail (Scroll horizontal, as MerchantProductSection) and a Carousel (as
// BannerCarousel), all from one host. Each picture answers after 2 s (tools/fetch-test-server.ts /slow-image, which
// counts how many it serves at once: /slow-image-stats). In parallel, the screen is done in about 2 s; one by one, 2 s
// per image. Logged as "image-par".
const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`)
const COLUMN = ids("col", 6)
const RAIL = ids("rail", 10)
const BANNERS = ids("banner", 5)

export function ImageParLab() {
  const lines = signal<string[]>([])
  const t0 = Date.now()
  // A new URL each time the screen opens: no cache hit
  const img = (id: string) => `${L}/slow-image?ms=2000&id=${id}&run=${t0}`
  let loaded = 0
  const total = COLUMN.length + RAIL.length + BANNERS.length
  const done = (id: string, what: string) => {
    loaded++
    line(`image-par ${id} ${what} at ${Date.now() - t0} ms (${loaded} of ${total})`, lines)
  }
  // A fetch to the same host while the first images load: does it wait for a slot the images hold? (Images got a
  // dispatcher of their own on 2026-11-09, so it shouldn't.)
  setTimeout(() => {
    const f0 = Date.now()
    fetch(`${L}/json`).then(
      (r) => line(`image-par fetch to the same host while images load: HTTP ${r.status} in ${Date.now() - f0} ms`, lines),
      (e) => line(`image-par fetch to the same host while images load: failed (${String(e)}) in ${Date.now() - f0} ms`, lines),
    )
  }, 800)
  setTimeout(() => line(`image-par done: ${loaded} of ${total} loaded after 10 s`, lines), 10_000)

  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Images at once?
        </Text>
      </Row>
      <Row style={{ gap: 6, paddingHorizontal: 16 }}>
        {COLUMN.map((id) => (
          <Image key={id} src={img(id)} loading="shimmer" onLoad={() => done(id, "loaded")} onError={() => done(id, "failed")} style={{ width: 44, height: 44 }} />
        ))}
      </Row>
      <Scroll horizontal style={{ gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
        {RAIL.map((id) => (
          <Image key={id} src={img(id)} loading="shimmer" contentScale="contain" onLoad={() => done(id, "loaded")} onError={() => done(id, "failed")} style={{ width: 150, height: 98 }} />
        ))}
      </Scroll>
      <Carousel itemWidth={320} dots style={{ gap: 12, paddingHorizontal: 16 }}>
        {BANNERS.map((id) => (
          <Image key={id} src={img(id)} loading="shimmer" onLoad={() => done(id, "loaded")} onError={() => done(id, "failed")} style={{ width: 320, height: 170 }} />
        ))}
      </Carousel>
      <Scroll style={{ flex: 1 }}>
        <Text fontSize={11} color={c.ink} style={{ paddingHorizontal: 20, paddingVertical: 8 }}>
          {lines().join("\n")}
        </Text>
      </Scroll>
    </Column>
  )
}

// /dev/image-list: do the pictures of the rows below the screen load before the user scrolls there (ZnImagePreload,
// image plan A)? A <List> of 60 rows, each with a picture that answers after 1 s (/slow-image). Rows that were loaded
// ahead show soon after they come on screen (from the disk cache); the others take the 1 s. Logged as "image-list";
// the script (tools/repro/http-stall.ts list) scrolls and reads the server's log: when each picture was asked for, and
// how many were asked for twice.
interface ListRowItem {
  id: string
  n: number
}
const LIST_ROWS: ListRowItem[] = Array.from({ length: 60 }, (_, i) => ({ id: `row${i + 1}`, n: i + 1 }))

export function ImageListLab() {
  const t0 = Date.now()
  const img = (id: string) => `${L}/slow-image?ms=1000&id=${id}&run=${t0}`
  console.log(`image-list open run=${t0}`)
  return (
    <Column style={{ flex: 1, backgroundColor: c.bg }}>
      <Row style={{ gap: 8, alignItems: "center", paddingHorizontal: 20, paddingVertical: 12 }}>
        <Pressable onPress={() => nav.back()} style={{ paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text fontSize={20} fontWeight={700} color={c.ink}>
            ←
          </Text>
        </Pressable>
        <Text fontSize={20} fontWeight={700} color={c.ink}>
          Pictures ahead?
        </Text>
      </Row>
      <List
        data={LIST_ROWS}
        key={(r) => r.id}
        style={{ flex: 1 }}
        row={(r) => (
          <Row style={{ gap: 12, alignItems: "center", paddingHorizontal: 16, height: 72 }}>
            <Image
              src={img(r.id)}
              loading="shimmer"
              onLoad={() => console.log(`image-list ${r.id} loaded at ${Date.now() - t0} ms`)}
              style={{ width: 56, height: 56, borderRadius: 8 }}
            />
            <Text fontSize={15} color={c.ink}>
              Row {r.n}
            </Text>
          </Row>
        )}
      />
    </Column>
  )
}
