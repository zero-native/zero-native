// Phone steps for the webview plugin (examples/sample/src/WebViewLab.tsx). The server starts by itself: tools/plugin-phone/webview-server.ts.
import { adb, check, clearLog, expectLog, killInBackground, lines, ok, openFresh, PKG, pid, reopen, see, shell, sleep, tap, texts, type Step } from "./helpers"
import { received, startWebViewServer } from "./webview-server"

let serving = false
const lab = async () => {
  if (!serving) {
    startWebViewServer()
    adb("reverse", "tcp:8790", "tcp:8790")
    serving = true
  }
  await openFresh("dev/webview", "Load inline")
  await expectLog(/webview-lab ready bridge=true refused=2/)
}
const back = () => shell("input", "keyevent", "KEYCODE_BACK")
const focus = () => shell("dumpsys", "window", "displays").match(/mCurrentFocus=.*/)?.[0] ?? ""
const inApp = () => focus().includes(PKG)
/** Waits until another app is on top. */
async function otherApp(ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!inApp()) return focus()
    await sleep(300)
  }
  throw new Error(`no other app opened: ${focus()}`)
}
/** Taps the big blue area at the top of a server page: a real tap, so the page gets a user gesture. */
function tapPage() {
  const label = texts().find((t) => t.text === "page below")
  check(label, "the label over the page is not on screen")
  shell("input", "tap", String(label.x), String(label.y + 110))
}
async function loaded(button: string, ready: RegExp) {
  clearLog()
  await tap(button)
  return await expectLog(ready)
}

export const steps: Step[] = [
  {
    name: "webview load",
    run: async () => {
      await lab()
      await tap("Load page")
      ok("start", await expectLog(/webview-lab load start: http:\/\/localhost:8790\/page/))
      ok("progress", await expectLog(/webview-lab progress: 100/))
      ok("title", await expectLog(/webview-lab title: lab \/page/))
      ok("finish", await expectLog(/webview-lab load finish: ok=true/))
      ok("page's own message", await expectLog(/webview-lab message: ready \/page from http:\/\/localhost:8790 main=true/))
    },
  },
  {
    name: "webview load errors",
    run: async () => {
      await lab()
      ok("no server there", await loaded("Load missing", /webview-lab load error: network/))
      ok("server error", await loaded("Load 500", /webview-lab load error: http 500/))
      ok("host not allowed", await loaded("Load blocked", /webview-lab load error: blocked/))
    },
  },
  {
    name: "webview message both ways",
    run: async () => {
      await lab()
      const first = await loaded("Load inline", /webview-lab message: ready inline/)
      check(first.includes("from https://lab.zero-native.test main=true"), first)
      ok("page to app", first)
      await tap("Send message")
      ok("app to page and back", await expectLog(/webview-lab message: echo hi from app/))
      ok("no base means no bridge", await loaded("Inline no base", /webview-lab title: bridge undefined/))
      clearLog()
      await tap("Send message")
      ok("nothing to send to", await expectLog(/webview-lab sent: false no_page/))
    },
  },
  {
    name: "webview blocked host can't post",
    run: async () => {
      await lab()
      clearLog()
      await tap("Load page")
      ok("iframe from a blocked host has no bridge", await expectLog(/webview-lab message: frame bridge undefined/))
      check(lines(/from http:\/\/127\.0\.0\.1/).length === 0, "a message came from the blocked host")
      ok("link to a blocked host", await loaded("Go blocked", /webview-lab link refused: host/))
      ok("redirect to a blocked host", await loaded("Go redirect", /webview-lab link refused: host/))
      await sleep(1000)
      check(lines(/from http:\/\/127\.0\.0\.1/).length === 0, "a message came after a redirect")
      const before = received.sink
      ok("form post to a blocked host", await loaded("Post form", /webview-lab link refused: host/))
      await sleep(800)
      check(received.sink === before, "the form reached the blocked host")
      ok("the form never left the phone", `${received.sink} requests`)
    },
  },
  {
    name: "webview link inside",
    run: async () => {
      await lab()
      await loaded("Load page", /webview-lab message: ready \/page /)
      clearLog()
      // A real tap on the page's "Inside" link. "Go inside" (a script jump, no tap) stays inside too, but Chromium gives a
      // jump without a user gesture no back step, against history spam: so the history check needs the tap.
      tapPage()
      ok("stays", await expectLog(/webview-lab message: ready \/page2/))
      ok("history", await expectLog(/webview-lab can go back: true/))
    },
  },
  {
    name: "webview link leaves",
    run: async () => {
      await lab()
      await loaded("Tap tel page", /webview-lab message: ready \/page /)
      clearLog()
      tapPage()
      ok("asked the app", await expectLog(/webview-lab link out: tel gesture=true/))
      ok("left", await otherApp())
      // Google's dialer (emulator) takes two Backs: the first only closes its keypad.
      for (let i = 0; i < 3 && !inApp(); i++) {
        back()
        await sleep(700)
      }
      await see("Load inline")
      await sleep(1000) // the gap between two links out
      await tap("Go upi")
      ok("app said no", await expectLog(/webview-lab link out: upi gesture=false/))
      await sleep(1500)
      check(inApp(), `a UPI app opened: ${focus()}`)
    },
  },
  {
    name: "webview intent and local links refused",
    run: async () => {
      await lab()
      await loaded("Load page", /webview-lab message: ready \/page /)
      ok("intent", await loaded("Go intent", /webview-lab link refused: scheme/))
      check(inApp(), `something opened: ${focus()}`)
      // Chromium itself stops a web page from opening file:// or content://, before our client hears of it: so no event,
      // and the page must simply stay. (allowFileAccess and allowContentAccess are off too.)
      for (const kind of ["file", "content"]) {
        clearLog()
        await tap(`Go ${kind}`)
        await sleep(2000)
        check(lines(new RegExp(`load start: ${kind}:`)).length === 0, `a ${kind}:// page started loading`)
        check(inApp(), `something opened: ${focus()}`)
        ok(kind, lines(/link refused: scheme/).length ? "refused by the plugin" : "blocked by Chromium, page stayed")
      }
    },
  },
  {
    name: "webview back inside the page",
    run: async () => {
      await lab()
      await loaded("Load page", /webview-lab message: ready \/page /)
      tapPage() // a real tap: see "webview link inside"
      await expectLog(/webview-lab can go back: true/)
      await sleep(500)
      clearLog()
      back()
      ok("back in the page", await expectLog(/webview-lab message: ready \/page /))
      ok("nothing left to go back to", await expectLog(/webview-lab can go back: false/))
      await see("Load inline")
    },
  },
  {
    name: "webview cookie kept across a kill, then cleared",
    run: async () => {
      await lab()
      ok("set", await loaded("Set cookie", /webview-lab message: cookie: zn_lab=kept/))
      await killInBackground()
      clearLog()
      reopen()
      await see("Load inline", 15000)
      await expectLog(/webview-lab ready bridge=true/)
      await sleep(500)
      ok("kept", await loaded("Show cookie", /webview-lab message: cookie: zn_lab=kept/))
      await tap("Clear cookies")
      ok("cleared", await expectLog(/webview-lab cookies cleared/))
      clearLog()
      await tap("Reload")
      ok("gone", await expectLog(/webview-lab message: cookie: none/))
    },
  },
  {
    name: "webview covered view pauses",
    run: async () => {
      await lab()
      await loaded("Load page", /webview-lab message: ready \/page /)
      clearLog()
      shell("input", "keyevent", "KEYCODE_HOME")
      ok("home", await expectLog(/webview-lab paused/))
      clearLog()
      reopen()
      ok("back", await expectLog(/webview-lab resumed/))
      await see("Load inline")
      clearLog()
      await tap("Open fake screen")
      ok("a screen on top drops the view", await expectLog(/webview: gone/, 6000))
      clearLog()
      await tap("Cancel")
      ok("back makes a new one and loads the page again", await expectLog(/webview-lab message: ready \/page /))
    },
  },
  {
    name: "webview renderer crash",
    run: async () => {
      await lab()
      await loaded("Load page", /webview-lab message: ready \/page /)
      const before = pid()
      clearLog()
      await tap("Crash renderer")
      let gone: string
      try {
        gone = await expectLog(/webview-lab render gone/, 5000)
      } catch {
        clearLog() // chrome://crash is not allowed on every phone
        await tap("Kill renderer")
        gone = await expectLog(/webview-lab render gone/)
      }
      ok("reported", gone)
      await sleep(800)
      check(pid() === before, "the app died with the renderer")
      ok("app lives", `pid ${before}`)
      clearLog()
      await tap("Reload")
      ok("page back", await expectLog(/webview-lab message: ready \/page /))
    },
  },
  {
    name: "webview upload cancel",
    run: async () => {
      await lab()
      await loaded("Tap file page", /webview-lab message: ready \/page /)
      for (const round of ["first", "second"]) {
        clearLog()
        tapPage()
        await otherApp()
        back()
        ok(`${round} cancel answers WebView`, await expectLog(/webview-lab upload answered: 0/))
        await see("Load inline")
        await sleep(500)
      }
    },
  },
  {
    name: "webview kill while the picker is open",
    run: async () => {
      await lab()
      await loaded("Tap file page", /webview-lab message: ready \/page /)
      tapPage()
      const on = await otherApp()
      const before = pid()
      shell("am", "kill", PKG)
      await sleep(800)
      if (pid() === before) {
        // The Lava's picker leaves our app alive, as the photo picker does (see "media no kill while the picker is open").
        ok("kept alive", `am kill refused while the picker is open: ${on}`)
        clearLog()
        back()
        ok("back answers WebView", await expectLog(/webview-lab upload answered: 0/, 10000))
      } else {
        clearLog()
        back() // the picker answers an Activity from a dead process
        ok("the restored screen is fine", await expectLog(/webview-lab ready bridge=true/, 15000))
        await see("Load inline")
      }
      check(lines(/FATAL EXCEPTION/).length === 0, "a crash")
    },
  },
  {
    name: "webview upload a file",
    hands: 'The lab opens. Tap the blue "Choose file" at the top of the page, then pick any small file. You have 60 seconds.',
    run: async () => {
      await lab()
      await loaded("Tap file page", /webview-lab message: ready \/page /)
      const before = received.upload
      clearLog()
      ok("picked", await expectLog(/webview-lab upload answered: 1/, 60000))
      ok("sent", await expectLog(/webview-lab message: file sent: \d+ bytes/, 15000))
      check(received.upload === before + 1, "the server got no file")
    },
  },
]
