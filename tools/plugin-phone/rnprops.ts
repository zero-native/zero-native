// Phone steps for RN props pack 2 (examples/sample/src/RnPropsLab.tsx). Run: bun run tools/plugin-phone.ts "rn props"
import { inflateSync } from "node:zlib"
import { check, clearLog, expectLog, lines, ok, openFresh, see, shell, shot, sleep, tap, texts, type Step } from "./helpers"

const lab = () => openFresh("dev/rn-props", /^status: /)

/** Holds the finger on [text] for [ms] (a swipe that doesn't move). */
async function hold(text: string | RegExp, ms = 1200) {
  for (let i = 0; i < 10; i++) {
    const n = texts().find((t) => (typeof text === "string" ? t.text === text : text.test(t.text)))
    if (n) return void shell("input", "swipe", String(n.x), String(n.y), String(n.x), String(n.y), String(ms))
    await sleep(300)
  }
  throw new Error(`no "${text}" on screen`)
}

/** Every element with a resource id (RN testID) on screen: its bounds in px and its text. */
function ids() {
  shell("rm", "-f", "/sdcard/zn-ui.xml")
  shell("uiautomator", "dump", "/sdcard/zn-ui.xml")
  const xml = shell("cat", "/sdcard/zn-ui.xml")
  const out = new Map<string, { x0: number; y0: number; x1: number; y1: number; text: string }>()
  for (const m of xml.matchAll(/<node [^>]*?text="([^"]*)"[^>]*?resource-id="([^"]+)"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)) {
    out.set(m[2], { text: m[1].replaceAll("&apos;", "'").replaceAll("&amp;", "&"), x0: +m[3], y0: +m[4], x1: +m[5], y1: +m[6] })
  }
  return out
}
async function byId(id: string, ms = 45000) {
  const end = Date.now() + ms
  for (let tries = 0; Date.now() < end; ) {
    const all = ids()
    const hit = all.get(id)
    // Fully on screen and clear of the gesture bar: a clipped box has the wrong centre.
    if (hit && hit.y1 < screenHeight() - 220 && hit.y0 > 20) return hit
    if (hit) {
      const by = hit.y1 >= screenHeight() - 220 ? 500 : -500
      shell("input", "swipe", "360", "1400", "360", String(1400 - by), "1200")
      await sleep(700)
      continue
    }
    // A dump fails (empty) while the screen is still settling: that isn't "not on screen". Look again before
    // scrolling, and let a scroll settle.
    if (all.size > 0) tries++
    if (all.size > 0 && tries % 2 === 0) {
      // A slow drag, so the list doesn't fling on after it (the bounds read next must stay right).
      shell("input", "swipe", "360", "1600", "360", "700", "1500")
      await sleep(700)
    } else await sleep(300)
  }
  throw new Error(`no testID "${id}" on screen: ${[...ids().keys()].join(", ")}`)
}
/** Whether the status bar draws light icons now: the app window's appearance ("apr=") in dumpsys. */
function lightIcons(): boolean {
  const out = shell("dumpsys", "window", "windows")
  const block = out.split(/\n(?=  Window #)/).find((b) => b.includes("dev.zeronative.sample/dev.zeronative.sample.MainActivity}:")) ?? ""
  const apr = /\n\s*apr=([^\n]*)/.exec(block)
  if (!block) throw new Error("no app window in dumpsys window")
  // LIGHT_STATUS_BARS = dark icons for a light bar. No apr= line: no light flags at all.
  return !apr || !apr[1].includes("LIGHT_STATUS_BARS")
}
/** Scrolls the lab back to its top. */
async function toTop() {
  for (let i = 0; i < 6; i++) shell("input", "swipe", "360", "600", "360", "2000", "150")
  await sleep(1200)
}
let height = 0
const screenHeight = () => (height ||= Number(/(\d+)x(\d+)\s*$/.exec(shell("wm", "size").trim())![2]))
const density = () => Number(/(\d+)\s*$/.exec(shell("wm", "density").trim())![1]) / 160
const near = (a: number, b: number) => Math.abs(a - b) <= 2

/** A screenshot as RGBA pixels. Only what `screencap -p` writes: 8-bit RGBA or RGB, not interlaced. */
function readPng(buf: Buffer) {
  let pos = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat: Buffer[] = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString("ascii", pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === "IHDR") {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      channels = body[9] === 6 ? 4 : 3
    } else if (type === "IDAT") idat.push(body)
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const cur = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    raw.copy(cur, 0, y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      const p = a + b - c
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      const add = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0
      cur[x] = (cur[x] + add) & 255
    }
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) out[(y * width + x) * 4 + k] = cur[x * channels + k]
      out[(y * width + x) * 4 + 3] = channels === 4 ? cur[x * channels + 3] : 255
    }
    cur.copy(prev)
  }
  return { width, height, data: out }
}

export const steps: Step[] = [
  {
    name: "rn props long press",
    run: async () => {
      await lab()
      // A wrapper that passes onLongPress through without one: a long hold is still a tap (RN Pressability).
      await hold("Hold: no long press")
      ok("no handler, hold = press", await expectLog(/rn-props tile-a press/))
      clearLog()
      await hold("Hold: long press")
      ok("handler, hold = long press", await expectLog(/rn-props tile-b long/))
      await sleep(400)
      check(lines(/rn-props tile-b press/).length === 0, "a long press also gave onPress")
      // The handler comes and goes at runtime.
      clearLog()
      await hold("Hold: not armed")
      ok("not armed, hold = press", await expectLog(/rn-props tile-c press armed=false/))
      await tap("Arm / disarm")
      await see("Hold: armed")
      clearLog()
      await hold("Hold: armed")
      ok("armed, hold = long press", await expectLog(/rn-props tile-c long/))
      await sleep(400)
      check(lines(/rn-props tile-c press/).length === 0, "armed: a long press also gave onPress")
      await tap("Arm / disarm")
      await see("Hold: not armed")
      clearLog()
      await hold("Hold: not armed")
      ok("disarmed again, hold = press", await expectLog(/rn-props tile-c press armed=false/))
      // A short tap is a press everywhere.
      clearLog()
      await tap("Hold: long press")
      ok("tap = press", await expectLog(/rn-props tile-b press/))
    },
  },
  {
    name: "rn props fill text testid",
    run: async () => {
      await lab()
      const d = density()
      const box = await byId("fill-stack")
      const all = (await byId("fill-all"))!
      check(near(all.x0, box.x0) && near(all.y0, box.y0) && near(all.x1, box.x1) && near(all.y1, box.y1), `absoluteFill ${JSON.stringify(all)} vs stack ${JSON.stringify(box)}`)
      ok("absoluteFill = the Stack", `${all.x1 - all.x0}x${all.y1 - all.y0}`)
      const bar = (await byId("fill-bar"))!
      check(near(bar.x0, box.x0 + 16 * d) && near(bar.x1, box.x1 - 16 * d), `start/end bar ${JSON.stringify(bar)}`)
      check(near(bar.y1, box.y1 - 8 * d) && near(bar.y1 - bar.y0, 24 * d), `bar height / bottom ${JSON.stringify(bar)}`)
      ok("start + end stretch", `${bar.x1 - bar.x0}px wide`)
      const side = (await byId("fill-side"))!
      check(near(side.y0, box.y0 + 8 * d) && near(side.y1, box.y1 - 8 * d) && near(side.x1, box.x1 - 8 * d), `top/bottom side ${JSON.stringify(side)}`)
      ok("top + bottom stretch", `${side.y1 - side.y0}px tall`)
      const upper = (await byId("tt-upper")).text
      const cap = (await byId("tt-cap")).text
      check(upper === "PAY RAVI'S KIRANA STORE" && cap === "Ravi's Kirana Store", `textTransform: "${upper}" / "${cap}"`)
      ok("textTransform", `${upper} | ${cap}`)
      await tap("Rename store")
      await sleep(500)
      const upper2 = (await byId("tt-upper")).text
      const cap2 = (await byId("tt-cap")).text
      check(upper2 === "PAY SHARMA SWEETS AND SNACKS" && cap2 === "Sharma Sweets And Snacks", `after a change: "${upper2}" / "${cap2}"`)
      ok("textTransform on a runtime text", `${upper2} | ${cap2}`)
      await byId("ios-shadow")
      ok("iOS shadow keys build and draw", "ios-shadow on screen")
    },
  },
  {
    name: "rn props corners borders",
    run: async () => {
      await lab()
      const d = density()
      const corners = await byId("corners")
      const png = readPng(shot())
      const at = (x: number, y: number) => {
        const i = (Math.round(y) * png.width + Math.round(x)) * 4
        return [png.data[i], png.data[i + 1], png.data[i + 2]]
      }
      const green = (p: number[]) => p[0] < 60 && p[1] > 140 && p[2] < 110 // #16A34A
      const tl = at(corners.x0 + 2, corners.y0 + 2)
      const tr = at(corners.x1 - 3, corners.y0 + 2)
      const br = at(corners.x1 - 3, corners.y1 - 3)
      const bl = at(corners.x0 + 2, corners.y1 - 3)
      check(!green(tl) && green(tr) && !green(br) && green(bl), `corner pixels tl=${tl} tr=${tr} br=${br} bl=${bl}`)
      ok("per-corner radius", "top-left and bottom-right round, the other two square")

      const borderAt = async () => {
        const box = await byId("otp-box")
        const inner = await byId("otp-inner")
        const img = readPng(shot())
        const i = (Math.round((box.y0 + box.y1) / 2) * img.width + box.x0 + 1) * 4
        return { offset: (inner.x0 - box.x0) / d, color: [img.data[i], img.data[i + 1], img.data[i + 2]] }
      }
      const idle = await borderAt()
      check(Math.abs(idle.offset - 1) < 0.5 && idle.color[0] > 190 && idle.color[2] > 200, `idle border ${JSON.stringify(idle)}`)
      ok("idle: 1 dp grey border", JSON.stringify(idle))
      await tap("OTP: idle")
      await see("OTP: focused")
      await sleep(300)
      const focused = await borderAt()
      check(Math.abs(focused.offset - 6) < 0.5 && focused.color[0] < 110 && focused.color[2] > 200, `focused border ${JSON.stringify(focused)}`)
      ok("focused: 6 dp indigo border, content moved in", JSON.stringify(focused))
      await tap("OTP: focused")
      await see("OTP: idle")
      await sleep(300)
      const back = await borderAt()
      check(Math.abs(back.offset - 1) < 0.5 && back.color[0] > 190, `back to idle ${JSON.stringify(back)}`)
      ok("back to idle", JSON.stringify(back))
    },
  },
  {
    name: "rn props pointer events slop",
    run: async () => {
      await lab()
      const d = density()
      const tapAt = (x: number, y: number) => shell("input", "tap", String(Math.round(x)), String(Math.round(y)))
      const mid = (b: { x0: number; y0: number; x1: number; y1: number }) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] as const
      /** Taps [at], then gives the "rn-props pe..." / "slop" lines it logged. */
      const tapped = async (x: number, y: number) => {
        clearLog()
        tapAt(x, y)
        await sleep(900)
        return lines(/rn-props (pe\d|slop|noslop|slop-free)/).map((l) => l.replace(/^.*rn-props /, "").trim())
      }
      const over = await byId("pe1-over")
      let got = await tapped(...mid(over))
      check(got.join() === "pe1 over", `auto overlay: ${got}`)
      ok("auto: the overlay takes the tap", got.join())
      await tap("Overlay: auto")
      await see("Overlay: none")
      got = await tapped(...mid(await byId("pe1-over")))
      check(got.join() === "pe1 under", `none overlay: ${got}`)
      ok("none (set at runtime): the tap goes under", got.join())
      await tap("Overlay: none")
      await see("Overlay: auto")
      got = await tapped(...mid(await byId("pe1-over")))
      check(got.join() === "pe1 over", `auto again: ${got}`)
      ok("auto again", got.join())

      got = await tapped(...mid(await byId("pe2-inner")))
      check(got.length === 0, `box-only: ${got}`)
      ok("box-only: its child takes no tap, nothing under gets it", "no log")
      const boxNone = await byId("pe3-boxnone")
      got = await tapped(boxNone.x1 - 20, (boxNone.y0 + boxNone.y1) / 2)
      check(got.join() === "pe3 under", `box-none empty area: ${got}`)
      got = await tapped(...mid(await byId("pe3-inner")))
      check(got.join() === "pe3 inner", `box-none child: ${got}`)
      ok("box-none: the box lets taps through, its child takes them", "pe3 under, pe3 inner")
      got = await tapped(...mid(await byId("pe4-plain")))
      check(got.length === 0, `absolute layer, not written: ${got}`)
      ok("not written: an absolute layer stops the tap, as in RN", "no log")
      got = await tapped(...mid(await byId("pe4-flow")))
      check(got.join() === "pe4 under", `plain child, not written: ${got}`)
      ok("not written: a plain child in the Stack lets taps through", got.join())

      // UI tests see a small element's bounds already grown to its touch size (Compose does that), so measure from
      // its centre: these elements are 24 dp wide (12 dp each side of the centre).
      const cx = (b: { x0: number; x1: number }) => (b.x0 + b.x1) / 2
      const cy = (b: { y0: number; y1: number }) => (b.y0 + b.y1) / 2
      const free = await byId("slop-free")
      check(near(free.x1 - free.x0, 64 * d), `hitSlop 20 on 24 dp: touch size ${(free.x1 - free.x0) / d} dp, want 64`)
      got = await tapped(cx(free) + (12 + 15) * d, cy(free))
      check(got.join() === "slop-free hit", `15 dp right of a hitSlop 20 element: ${got} (bounds ${JSON.stringify(free)}, tap ${Math.round(cx(free) + 27 * d)},${Math.round(cy(free))}, now ${JSON.stringify(ids().get("slop-free"))})`)
      got = await tapped(cx(free), cy(free) + (12 + 15) * d)
      check(got.join() === "slop-free hit", `15 dp under it: ${got}`)
      ok("hitSlop 20: a tap 15 dp outside counts", "right and below")
      got = await tapped(cx(free) + (12 + 26) * d, cy(free))
      check(got.length === 0, `26 dp right of it: ${got}`)
      ok("26 dp outside: no tap", "no log")
      // Over another Pressable's own area, that one wins (as with Compose's 48 dp minimum touch size).
      const slop = await byId("slop")
      got = await tapped(cx(slop) + (12 + 15) * d, cy(slop))
      check(got.join() === "pe5 under", `slop over a Pressable: ${got}`)
      const noslop = await byId("noslop")
      got = await tapped(cx(noslop) + (12 + 15) * d, cy(noslop))
      check(got.join() === "pe5 under", `no hitSlop: ${got}`)
      ok("over another Pressable, and without hitSlop: the tap goes under", "pe5 under")
    },
  },
  {
    name: "rn props image layout",
    run: async () => {
      await lab()
      ok("onLoad with the picture's size", await expectLog(/rn-props img load 16x16/))
      ok("onLoadEnd", await expectLog(/rn-props img end/))
      ok("onError for a missing file", await expectLog(/rn-props img error with message/))
      ok("onLayout once laid out", await expectLog(/rn-props layout 40x24/))
      const pixel = async (id: string) => {
        const b = await byId(id)
        const img = readPng(shot())
        const i = (Math.round((b.y0 + b.y1) / 2) * img.width + Math.round((b.x0 + b.x1) / 2)) * 4
        return [img.data[i], img.data[i + 1], img.data[i + 2]]
      }
      const green = await pixel("img-tint")
      check(green[0] < 60 && green[1] > 140 && green[2] < 110, `tint green: ${green}`)
      ok("tintColor", `rgb ${green}`)
      await tap("Tint: green")
      await see("Tint: red")
      await sleep(300)
      const red = await pixel("img-tint")
      check(red[0] > 200 && red[1] < 70 && red[2] < 70, `tint red: ${red}`)
      ok("tintColor at runtime", `rgb ${red}`)
      clearLog()
      await tap("Layout: narrow")
      ok("onLayout after a size change", await expectLog(/rn-props layout 100(\.\d+)?x24/))
      clearLog()
      await tap("Layout: wide")
      ok("and back", await expectLog(/rn-props layout 40x24/))
      // Scrolling the screen moves the element on screen, not in its parent: no new onLayout.
      clearLog()
      shell("input", "swipe", "360", "1300", "360", "900", "300")
      await sleep(1200)
      check(lines(/rn-props layout/).length === 0, `onLayout fired while scrolling: ${lines(/rn-props layout/).join(" | ")}`)
      ok("no onLayout while scrolling", "none")
    },
  },
  {
    name: "rn props bars",
    run: async () => {
      await lab()
      const px = (x: number, y: number) => {
        const img = readPng(shot())
        const i = (Math.round(y) * img.width + Math.round(x)) * 4
        return [img.data[i], img.data[i + 1], img.data[i + 2]]
      }
      const top = () => px(540, 12) // the status bar, away from the clock and the icons
      const bottom = () => px(60, screenHeight() - 6) // the navigation bar, away from its handle
      const before = { top: top(), bottom: bottom(), light: lightIcons() }
      check(before.top[0] > 200 && before.top[1] > 200, `status bar before: ${before.top}`)
      check(before.light === false, "the lab starts with dark status bar icons")
      ok("dark icons, no colour", JSON.stringify(before))
      await tap("Bars: dark, no colour")
      await see("Bars: light on colour")
      await sleep(600)
      const on = { top: top(), bottom: bottom(), light: lightIcons() }
      check(on.top[0] < 60 && on.top[1] > 140, `status strip: ${on.top}`)
      check(on.bottom[0] < 60 && on.bottom[1] < 60 && on.bottom[2] < 70, `navigation strip: ${on.bottom}`)
      check(on.light === true, "barStyle light-content: light icons")
      ok("light icons over a green strip, dark navigation strip", JSON.stringify(on))
      await tap("Bars: light on colour")
      await see("Bars: dark, no colour")
      await sleep(600)
      const off = { top: top(), bottom: bottom(), light: lightIcons() }
      check(off.top[0] > 200 && off.light === false, `back: ${JSON.stringify(off)}`)
      ok("back to the route's look", JSON.stringify(off))
      await toTop()
      const status = (await byId("rn-status")).y0
      await tap("Status bar: shown")
      await see("Status bar: hidden")
      await toTop()
      const hiddenAt = (await byId("rn-status")).y0
      check(hiddenAt < status, `hidden: the screen moves up (${status} -> ${hiddenAt})`)
      ok("hidden: no status bar, the screen moves up", `${status} -> ${hiddenAt}`)
      await tap("Status bar: hidden")
      await sleep(800) // showing the bar pushes the toggle down, maybe off screen: check the position instead
      await toTop()
      check((await byId("rn-status")).y0 === status, "the status bar came back")
      ok("shown again", `${status}`)
    },
  },
  {
    name: "rn props sticky",
    run: async () => {
      await lab()
      const d = density()
      const list = await byId("sticky-list")
      const pinnedY = list.y0 + 20 * d // the centre of a 40 dp header at the list's top, at the start
      const at = (label: string) => texts().find((t) => t.text === label)
      /** Drags inside the list by [dp] (slowly, no fling). */
      const drag = async (dp: number) => {
        const x = String(Math.round((list.x0 + list.x1) / 2))
        const from = Math.round(list.y1 - 30 * d)
        shell("input", "swipe", x, String(from), x, String(Math.round(from - dp * d)), "1500")
        await sleep(900)
      }
      // The list's top now: past its end, a drag scrolls the page around it (nested scroll), so read it again.
      const pinnedIs = (label: string) => {
        const t = at(label)
        const now = ids().get("sticky-list") ?? list
        return !!t && Math.abs(t.y - (now.y0 + 20 * d)) < 6 * d
      }
      check(pinnedIs("Today"), `Today at the top at the start: ${JSON.stringify(at("Today"))} want y ${pinnedY}`)
      await drag(220) // about 5 rows
      check(pinnedIs("Today") && !at("Payment 1"), `Today pinned after a scroll: ${JSON.stringify(at("Today"))}`)
      ok("a sticky row stays at the top", "Today pinned, Payment 1 gone")
      for (let i = 0; i < 3; i++) await drag(260) // past row 20
      check(pinnedIs("Earlier") && !at("Today"), `Earlier pinned: ${JSON.stringify(at("Earlier"))}, Today ${JSON.stringify(at("Today"))}`)
      ok("the next sticky row pushes it up", "Earlier pinned")
      for (let i = 0; i < 8; i++) await drag(260) // to the end: the pinned row is far from the rows JS mounts
      check(pinnedIs("Earlier") && !!at("Payment 59"), `far down: Earlier ${JSON.stringify(at("Earlier"))}, last row ${JSON.stringify(at("Payment 59"))}`)
      ok("far down, the pinned row is still drawn (JS keeps it mounted)", "Earlier + Payment 59")
      await tap("Sticky: 0 and 20")
      await see("Sticky: 0 only")
      await sleep(600)
      await drag(40)
      check(pinnedIs("Today") && !pinnedIs("Earlier"), `indices changed at runtime: Today ${JSON.stringify(at("Today"))}, Earlier ${JSON.stringify(at("Earlier"))}`)
      ok("stickyHeaderIndices changed at runtime", "Today pinned again")
    },
  },
  {
    // ZeroBill payment pass: the first keypad tap after closing the offers sheet was lost on the closing sheet's scrim
    // (and sent onDismiss again). Animations at 5x, so the close is still playing when the page tap comes.
    name: "rn props sheet close",
    run: async () => {
      await lab()
      const scale = shell("settings", "get", "global", "animator_duration_scale").trim()
      shell("settings", "put", "global", "animator_duration_scale", "5")
      // Scrolls the page by its left padding (16 dp): a swipe in the middle lands on the sticky list and scrolls that.
      const onPage = async (label: string) => {
        for (let i = 0; i < 30; i++) {
          const t = texts().find((x) => x.text === label)
          if (t && t.y < 2250) return t
          shell("input", "swipe", "20", "1500", "20", "800", "600")
          await sleep(500)
        }
        throw new Error(`no "${label}" on the page: ${texts().map((x) => x.text).join(" | ")}`)
      }
      try {
        await onPage("Open offers sheet")
        await onPage("Page tap")
        await sleep(1500) // the scroll settles: positions read before it are off
        const page = await onPage("Page tap")
        const tapThenPage = async (button: string) => {
          const b = texts().find((t) => t.text === button)
          check(b, `no "${button}" on screen`)
          clearLog()
          // A person's next tap, ~0.4 s later (the close still plays for ~1.5 s at 5x). Android routes taps by the old
          // window for ~0.25 s after it stops taking them (measured on the emulator), so a faster tap can still be lost.
          shell(`input tap ${b.x} ${b.y}; sleep 0.3; input tap ${page.x} ${page.y}`)
          ok(`page takes the tap right after "${button}"`, await expectLog(/rn-props page tap/, 4000))
          await sleep(2500) // the close ends
          check(lines(/rn-props sheet dismissed/).length === 0, `the closing sheet sent onDismiss: ${lines(/rn-props sheet dismissed/).join(" | ")}`)
        }
        const open = await onPage("Open offers sheet")
        shell("input", "tap", String(open.x), String(open.y))
        await see("2 offers on this store")
        await sleep(2500) // the open ends
        await tapThenPage("Continue to checkout")
        const dialogTile = await onPage("Open dialog modal")
        shell("input", "tap", String(dialogTile.x), String(dialogTile.y))
        await see("Pay ₹120 to Ravi Stores?")
        await sleep(1500)
        await tapThenPage("Close modal")
      } finally {
        if (scale && scale !== "null") shell("settings", "put", "global", "animator_duration_scale", scale)
        else shell("settings", "delete", "global", "animator_duration_scale")
      }
    },
  },
  {
    name: "rn props modal",
    run: async () => {
      await lab()
      const d = density()
      await tap("Open dialog modal")
      ok("onShow", await expectLog(/rn-props modal dialog shown/))
      await see("Pay ₹120 to Ravi Stores?")
      const card = await byId("modal-card")
      // The dim is the app's own Pressable in the Modal's window: a tap there never reaches the screen under it.
      clearLog()
      shell("input", "tap", "200", String(Math.round(card.y0 - 120 * d)))
      ok("a tap on the dim stays in the Modal", await expectLog(/rn-props modal dim tap/))
      await tap("Alert from modal")
      await see("From the modal")
      await tap("OK")
      ok("an Alert shows above the Modal", await expectLog(/rn-props modal alert ok/))
      await see("Pay ₹120 to Ravi Stores?")
      // The keyboard: the content stays above it (the centred card moves up).
      const field = await byId("modal-field")
      shell("input", "tap", String((field.x0 + field.x1) >> 1), String((field.y0 + field.y1) >> 1))
      await sleep(1500)
      const up = await byId("modal-card")
      check(up.y0 < card.y0 - 40 * d, `card with the keyboard: ${up.y0} vs ${card.y0}`)
      ok("the content moves above the keyboard", `card top ${card.y0} -> ${up.y0}`)
      shell("input", "keyevent", "KEYCODE_BACK") // closes the keyboard first
      await sleep(1000)
      clearLog()
      shell("input", "keyevent", "KEYCODE_BACK")
      ok("back asks JS (onRequestClose)", await expectLog(/rn-props modal dialog close asked/))
      await sleep(800)
      check(!texts().some((t) => t.text === "Pay ₹120 to Ravi Stores?"), "the dialog stayed after JS closed it")
      ok("JS closed it: gone after the fade", "no card")

      await tap("Open page modal")
      ok("onShow (slide)", await expectLog(/rn-props modal page shown/))
      const title = await byId("modal-page-title")
      check(title.y0 >= 20 * d, `page content under the status bar: y0 ${title.y0}`)
      ok("not translucent: the content starts below the status bar", `title top ${title.y0}px`)
      clearLog()
      shell("input", "keyevent", "KEYCODE_BACK")
      ok("back asks JS", await expectLog(/rn-props modal page close asked \(kept open\)/))
      await sleep(800)
      await see("Full page modal")
      ok("JS kept it open: still on screen", "Full page modal")
      await tap("Close page")
      await sleep(900)
      check(!texts().some((t) => t.text === "Full page modal"), "the page stayed after Close")
      await see("Open page modal")
      ok("closed by JS", "back on the lab")
    },
  },
]
