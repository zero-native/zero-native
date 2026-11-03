// Phone steps for the pdf plugin (examples/sample/src/PdfLab.tsx). The server starts by itself: tools/plugin-phone/pdf-server.ts.
// Runs on the emulator too: nothing here needs a camera or a SIM. Pinch can't be done from adb: "pdf pinch by hand" asks you.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { adb, check, clearLog, expectLog, killInBackground, lines, ok, openFresh, OUT, PKG, reopen, see, shell, shot, sleep, tap, texts, type Step } from "./helpers"
import { received, startPdfServer } from "./pdf-server"

let serving = false
const lab = async () => {
  if (!serving) {
    startPdfServer()
    adb("reverse", "tcp:8793", "tcp:8793")
    serving = true
  }
  await openFresh("dev/pdf", "One page")
}
async function press(button: string, ready: RegExp, ms = 10000) {
  clearLog()
  await tap(button)
  return await expectLog(ready, ms)
}
/** The files the plugin keeps (debug builds: run-as). */
const files = () =>
  shell("run-as", PKG, "ls", "-a", "cache/zn-files")
    .split(/\s+/)
    .filter((f) => f.startsWith("pdf-") || f.startsWith(".pdf-"))
/** The middle of the full viewer: under the "status" line and the 120 dp card row. */
function viewer() {
  const s = texts().find((t) => t.text.startsWith("status:"))
  check(s, "no status line")
  const dp = Number(shell("wm", "density").match(/(\d+)\s*$/)?.[1] ?? 420) / 160
  return { x: s.x, y: Math.round(s.y + dp * (10 + 120 + 8 + 150)), dp }
}
const save = (name: string) => writeFileSync(join(OUT, `pdf-${name}.png`), shot())

export const steps: Step[] = [
  {
    name: "pdf download, preview and view",
    run: async () => {
      await lab()
      await tap("Cleanup all")
      ok("download", await press("One page", /pdf-lab \/one\.pdf: ok pages=1 cached=false/))
      ok("view", await expectLog(/pdf-lab view load: pages=1 size=595x842/))
      ok("preview", await expectLog(/preview load: pages=1/))
      check(received.header["/one.pdf"] === "1", `the header didn't reach the server: ${received.header["/one.pdf"]}`)
      ok("headers sent", "x-zn-lab: 1")
      await sleep(800)
      save("one")
      ok("screenshot", join(OUT, "pdf-one.png"))
    },
  },
  {
    name: "pdf cache",
    run: async () => {
      await lab()
      await press("One page", /pdf-lab \/one\.pdf: ok/)
      const hits = received.hits["/one.pdf"] ?? 0
      ok("from the cache", await press("One page", /pdf-lab \/one\.pdf: ok pages=1 cached=true/))
      check((received.hits["/one.pdf"] ?? 0) === hits, "a cached file went to the network")
      ok("no network", `${hits} hits before and after`)
      ok("open a handle", await press("Open handle", /pdf-lab open: ok pages=1 cached=true/))
    },
  },
  {
    name: "pdf many pages scroll",
    run: async () => {
      await lab()
      ok("50 pages", await press("50 pages", /pdf-lab view load: pages=50/))
      await expectLog(/pdf-lab page 1 of 50/)
      const v = viewer()
      clearLog()
      for (let i = 0; i < 6; i++) shell("input", "swipe", String(v.x), String(v.y + 100), String(v.x), String(v.y - 120), "120")
      const page = await expectLog(/pdf-lab page ([2-9]|[1-4]\d) of 50/)
      ok("scrolls by fling", page)
      await sleep(1000)
      save("pages50")
      check(!lines(/FATAL EXCEPTION|OutOfMemory/).length, "a crash")
    },
  },
  {
    name: "pdf zoom",
    run: async () => {
      await lab()
      await press("50 pages", /pdf-lab view load: pages=50/)
      ok("zoom from code", await press("Zoom 3x", /pdf-lab zoom 3\.00/))
      await sleep(600) // the sharp layer
      save("zoom3")
      const v = viewer()
      clearLog()
      shell("input", "tap", String(v.x), String(v.y))
      await sleep(90)
      shell("input", "tap", String(v.x), String(v.y))
      ok("double tap out", await expectLog(/pdf-lab zoom 1\.00/))
      clearLog()
      shell("input", "tap", String(v.x), String(v.y))
      await sleep(90)
      shell("input", "tap", String(v.x), String(v.y))
      ok("double tap in", await expectLog(/pdf-lab zoom 2\.50/))
      await sleep(600)
      save("zoom25")
      clearLog()
      shell("input", "swipe", String(v.x + 200), String(v.y), String(v.x - 200), String(v.y), "200")
      await sleep(500)
      check(!lines(/FATAL EXCEPTION/).length, "a crash")
      ok("pan sideways", "no crash")
    },
  },
  {
    name: "pdf long receipt",
    run: async () => {
      await lab()
      ok("roll", await press("Roll", /pdf-lab view load: pages=1 size=226x2000/))
      await sleep(800)
      save("roll")
    },
  },
  {
    name: "pdf bad files",
    run: async () => {
      await lab()
      ok("password", await press("Password", /pdf-lab \/password\.pdf: failed password/))
      ok("broken", await press("Broken", /pdf-lab \/broken\.pdf: failed broken/))
      ok("html", await press("Html", /pdf-lab \/html\.pdf: failed not_pdf/))
      ok("404", await press("Missing", /pdf-lab \/missing\.pdf: failed http 404/))
      ok("too big", await press("Too big", /pdf-lab \/pages50\.pdf: failed too_big/))
      ok("not https", await press("Not https", /pdf-lab http:\/\/example\.com\/a\.pdf: failed not_allowed/))
      ok("no server", await press("No server", /pdf-lab http:\/\/localhost:8794\/a\.pdf: failed network/, 20000))
      clearLog()
      await tap("Bad handle")
      ok("bad handle, view", await expectLog(/pdf-lab view error: not_found/))
      ok("bad handle, preview", await expectLog(/pdf-lab preview error: not_found/))
      check(!files().some((f) => f.endsWith(".part")), `a part file was left: ${files()}`)
      ok("no half files", files().join(" "))
      check(!lines(/FATAL EXCEPTION/).length, "a crash")
    },
  },
  {
    name: "pdf redirects",
    run: async () => {
      await lab()
      ok("same origin", await press("Redirect", /pdf-lab \/redirect: ok pages=1/))
      check(received.header["/one.pdf"] === "1", "a same-origin redirect lost the header")
      ok("header kept", "x-zn-lab: 1")
      ok("other origin", await press("Redirect other", /pdf-lab \/redirect-other: ok pages=1/))
      check(received.header["/one.pdf"] === null, `the header went to another origin: ${received.header["/one.pdf"]}`)
      ok("header dropped", "none on 127.0.0.1")
    },
  },
  {
    name: "pdf after a kill",
    run: async () => {
      await lab()
      await press("50 pages", /pdf-lab view load: pages=50/)
      await killInBackground()
      clearLog()
      reopen()
      ok("the file opens again", await expectLog(/pdf-lab view load: pages=50/, 15000))
      ok("the preview too", await expectLog(/pdf-lab preview load: pages=50/))
    },
  },
  {
    name: "pdf kill during a download",
    run: async () => {
      await lab()
      await tap("Cleanup all")
      clearLog()
      await tap("Slow")
      await sleep(4000)
      check(files().some((f) => f.endsWith(".part")), `no part file while it downloads: ${files()}`)
      await killInBackground()
      const left = files()
      check(!left.some((f) => f.startsWith("pdf-")), `a half file has a real name: ${left}`)
      ok("only a part file", left.join(" "))
      reopen()
      await see("One page", 15000)
      ok("again, whole", await press("Slow", /pdf-lab \/slow\.pdf: ok pages=50 cached=false/, 40000))
      check(!files().some((f) => f.endsWith(".part")), `the part file stayed: ${files()}`)
      ok("part file gone", files().join(" "))
    },
  },
  {
    name: "pdf cleanup",
    run: async () => {
      await lab()
      await press("One page", /pdf-lab \/one\.pdf: ok/)
      ok("cleanup", await press("Cleanup all", /pdf-lab cleanup: [1-9]/))
      check(files().length === 0, `files left: ${files()}`)
      ok("folder", "no pdf files")
    },
  },
  {
    name: "pdf pinch by hand",
    hands: "Pinch the big PDF view in and out, then scroll with one finger. Press Enter when done.",
    run: async () => {
      await lab()
      await press("50 pages", /pdf-lab view load: pages=50/)
      clearLog()
      console.log("pinch now, then press Enter")
      for await (const _ of console) break
      ok("zoom heard", lines(/pdf-lab zoom /).at(-1) ?? "no zoom line")
    },
  },
]
