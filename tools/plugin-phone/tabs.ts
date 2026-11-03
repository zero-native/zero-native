// Phone steps for tabs (examples/sample/src/TabsLab.tsx, guide notes §40). The tabs' data server starts by itself on
// port 8788 (or tools/fetch-test-server.ts answers, if it is already running).
import { adb, check, clearLog, expectLog, killInBackground, lines, ok, openFresh, PKG, reopen, see, shell, sleep, tap, texts, type Step } from "./helpers"
import { tabsAnswer } from "./tabs-server"

let serving = false
function startServer() {
  if (!serving) {
    try {
      Bun.serve({ port: 8788, fetch: async (req) => (await tabsAnswer(new URL(req.url))) ?? new Response("not found", { status: 404 }) })
    } catch {
      // Port in use: tools/fetch-test-server.ts runs and answers /tabs/ too.
    }
    serving = true
  }
  adb("reverse", "tcp:8788", "tcp:8788")
}

const lab = async (path = "dev/tabs") => {
  startServer()
  await openFresh(path, "Tabs lab")
}
const back = () => shell("input", "keyevent", "KEYCODE_BACK")
const built = (tab: string) => lines(new RegExp(`tabs-lab built ${tab}$`)).length
/** The number of the highest "Stores item N" on screen. */
const topStore = () => Math.min(...texts().map((t) => /^Stores item (\d+)$/.exec(t.text)).filter((m) => m).map((m) => Number(m![1])))
const inFront = () => /mCurrentFocus=[^\n]*dev\.zeronative\.sample/.test(shell("dumpsys", "window", "displays"))
let density = 0
/** [dp] in this phone's pixels (wm density: the override if there is one). */
const px = (dp: number) => {
  if (!density) density = Number([...shell("wm", "density").matchAll(/density: (\d+)/g)].pop()?.[1] ?? 160)
  return Math.round((dp * density) / 160)
}
/** A finger pull down by [dp], starting on the text [from], slow enough not to fling. */
async function pull(from: string | RegExp, dp: number) {
  const t = texts().find((x) => (typeof from === "string" ? x.text === from : from.test(x.text)))
  check(t, `no "${from}" to pull from`)
  shell("input", "swipe", String(t.x), String(t.y), String(t.x), String(t.y + px(dp)), "800")
  await sleep(300)
}
const refreshes = (tab: string) => lines(new RegExp(`tabs-lab refresh ${tab} start`)).length

export const steps: Step[] = [
  {
    name: "tabs: only the shown tab is built; data loads",
    run: async () => {
      await lab()
      ok("pay data", await expectLog(/tabs-lab data pay 40/))
      await see("Pay item 1")
      check(built("pay") === 1, "pay not built once")
      check(built("stores") + built("offers") + built("rewards") === 0, `other tabs built at start: ${lines(/tabs-lab built/).join(" | ")}`)
      // All four loads started with the screen (fetch=all): the hidden tabs' data arrived too.
      ok("hidden tabs' data", await expectLog(/tabs-lab data offers 40/))
    },
  },
  {
    name: "tabs: a tab is built on first show and keeps its state and scroll",
    run: async () => {
      await tap("Rewards")
      await see("tab: rewards")
      await tap("Taps: 0")
      await tap("Taps: 1")
      await see("Taps: 2")
      await tap("Stores")
      await see("Stores item 1")
      for (let i = 0; i < 3; i++) shell("input", "swipe", "360", "1200", "360", "500", "300")
      await sleep(800)
      const top = topStore()
      check(top > 1, `the stores list didn't scroll (top item ${top})`)
      await tap("Rewards")
      await see("Taps: 2")
      await tap("Stores")
      await see(/^Stores item \d+$/)
      check(topStore() === top, `scroll position lost: was item ${top}, now ${topStore()}`)
      check(built("rewards") === 1 && built("stores") === 1, `a tab was built twice: ${lines(/tabs-lab built/).join(" | ")}`)
      ok("state and scroll kept", `taps 2, top store ${top}`)
    },
  },
  {
    name: "tabs: back goes to the first tab, then leaves the screen",
    run: async () => {
      await tap("Offers")
      await see("tab: offers")
      back()
      await see("tab: pay")
      back()
      await sleep(1200)
      check(!texts().some((t) => t.text === "Tabs lab"), "still on the tabs screen after the second back")
      ok("back", "offers → pay → out")
    },
  },
  {
    name: "tabs: back on the only screen",
    run: async () => {
      await lab()
      clearLog()
      await tap("Only screen")
      await expectLog(/tabs-lab built pay/)
      await tap("Offers")
      await see("tab: offers")
      back()
      await see("tab: pay")
      check(inFront(), "the app left the front on a back that should go to the first tab")
      back()
      await sleep(1500)
      check(!inFront(), "the app stayed in front on the first tab of the only screen")
      ok("only screen", "offers → pay → app in the background")
      reopen()
    },
  },
  {
    name: "tabs: a screen pushed over the tabs; focus comes back",
    run: async () => {
      await lab()
      await expectLog(/tabs-lab data pay 40/)
      await see("Pay item 1")
      clearLog()
      await tap("Pay item 1")
      await see(/Passbook/)
      back()
      await see("tab: pay")
      ok("focus again", await expectLog(/tabs-lab focus pay 2/))
      ok("reload on focus", await expectLog(/tabs-lab data pay 40/))
    },
  },
  {
    name: "tabs: the scanner over the tabs, back",
    run: async () => {
      await tap("Stores")
      await see("tab: stores")
      clearLog()
      await tap("Scan")
      await expectLog(/tabs-lab scan open/)
      await sleep(2500)
      // The camera permission dialog may come first on a fresh phone: back until the tabs show again.
      for (let i = 0; i < 3 && !texts().some((t) => t.text === "Tabs lab"); i++) {
        back()
        await sleep(1200)
      }
      ok("scan answer", await expectLog(/tabs-lab scan answer null/))
      await see("tab: stores")
      ok("tab kept", "stores")
    },
  },
  {
    name: "tabs: the selected tab comes back after a kill",
    run: async () => {
      await lab()
      await tap("Offers")
      await see("tab: offers")
      await killInBackground()
      clearLog()
      reopen()
      await see("tab: offers", 15000)
      await expectLog(/tabs-lab built offers/)
      check(built("pay") === 0, "the first tab was built after the restore too")
      ok("restored", "offers, and only offers built")
    },
  },
  {
    name: "tabs: kill with a screen above the tabs (pay flow), then back",
    run: async () => {
      await lab()
      await tap("Rewards")
      await see("Rewards item 1")
      await tap("Rewards item 1")
      await see(/Passbook/)
      await killInBackground()
      reopen()
      await see(/Passbook/, 15000)
      back()
      await see("tab: rewards")
      ok("back to the tab", "rewards")
    },
  },
  {
    name: "tabs: a cold link opens a tab",
    run: async () => {
      await lab("dev/tabs/offers")
      await see("tab: offers")
      check(built("pay") === 0, "the first tab was built for a link to another tab")
      ok("cold link", "offers")
    },
  },
  {
    name: "tabs: a link while screens are above goes back to the tabs",
    run: async () => {
      await lab()
      await see("Pay item 1")
      await tap("Pay item 1")
      await see(/Passbook/)
      shell("am", "start", "-a", "android.intent.action.VIEW", "-d", "zn://sample/dev/tabs/rewards", PKG)
      await see("tab: rewards")
      check(!texts().some((t) => /Passbook/.test(t.text)), "the amount screen is still there")
      back()
      await see("tab: pay")
      ok("warm link", "amount closed, rewards selected, back → pay")
    },
  },
  // Pull to refresh (guide notes §41). The disc must come down 80 dp, and it moves half as far as the finger.
  {
    name: "pull to refresh: a long pull on a Scroll refreshes once, a short one doesn't",
    run: async () => {
      await lab()
      await see("Pay item 1")
      clearLog()
      await pull("Pay item 1", 70) // the disc comes 35 dp: short of the line
      await sleep(1500)
      check(refreshes("pay") === 0, "a short pull refreshed")
      await pull("Pay item 1", 300)
      ok("refresh started", await expectLog(/tabs-lab refresh pay start/))
      ok("refresh done", await expectLog(/tabs-lab refresh pay done 1/))
      await see("Refreshed 1×")
      check(refreshes("pay") === 1, `one pull refreshed ${refreshes("pay")} times`)
    },
  },
  {
    name: "pull to refresh: RN's RefreshControl on a Scroll and a List, across a tab switch",
    run: async () => {
      await tap("Stores")
      await see("Stores item 1")
      clearLog()
      await pull("Stores item 1", 300)
      ok("list refresh started", await expectLog(/tabs-lab refresh stores start/))
      // Switch tabs while the stores load (1.2 s): the offers tab (a Scroll) refreshes too.
      await tap("Offers")
      await see("Offers item 1")
      await pull("Offers item 1", 300)
      ok("scroll refresh started", await expectLog(/tabs-lab refresh offers start/))
      ok("scroll refresh done", await expectLog(/tabs-lab refresh offers done 1/))
      await see("Refreshed 1×")
      await tap("Stores")
      ok("list refresh done", await expectLog(/tabs-lab refresh stores done 1/))
      await see("Refreshed 1×")
    },
  },
  {
    name: "pull to refresh: on a list scrolled down, a pull scrolls it up and doesn't refresh",
    run: async () => {
      await see("Stores item 1")
      const x = String(texts().find((t) => t.text === "Stores item 1")!.x)
      for (let i = 0; i < 2; i++) shell("input", "swipe", x, String(px(600)), x, String(px(250)), "300")
      await sleep(800)
      const before = topStore()
      check(before > 4, `the stores list didn't scroll (top item ${before})`)
      clearLog()
      await pull(/^Stores item \d+$/, 120)
      await sleep(1500)
      check(refreshes("stores") === 0, "a pull on a scrolled list refreshed")
      check(topStore() < before, `the list didn't scroll up (top item ${before} → ${topStore()})`)
      ok("scrolled, no refresh", `top item ${before} → ${topStore()}`)
    },
  },
]
